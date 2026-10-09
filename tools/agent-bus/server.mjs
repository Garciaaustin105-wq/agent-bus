#!/usr/bin/env node
// agent-bus — a coordination bus for the Claude sessions working in this repo.
//
// WHY THIS EXISTS: several agents run at once here, across a shared checkout and
// thirteen worktrees. Two things kept going wrong and neither was fixable by
// talking more:
//
//   1. Two sessions used the same working tree and switched branches under each
//      other mid-edit.
//   2. A lane spec went stale between being WRITTEN and being READ, four times.
//      Nobody was talking at the moment it went stale, so no message could have
//      caught it. The fact has to outlive the conversation.
//
// So this is a LOCK plus a NOTICEBOARD, with messaging as the smaller third
// feature. A tool in the tool list gets used; a convention in a doc gets
// skipped, which is the whole reason this is an MCP server and not a README.
//
// No dependencies, on purpose: raw JSON-RPC over stdio. Adding a package here
// would mean editing package.json, which other agents have open.
//
// STATE LIVES IN THE GIT COMMON DIR. Every worktree has its own working
// directory, so a relative path would give thirteen separate buses — worse than
// none. `git rev-parse --git-common-dir` resolves to the MAIN repo's .git from
// inside any worktree, so all agents agree on one location without configuring
// anything.
//
// THE HUB LIVES IN hub.mjs, BESIDE THIS FILE — the dashboard page, its HTTP
// server, the workers started from the window, and the status.html snapshot.
// It is SPAWNED (`server.mjs dashboard` runs it as a child process), never
// imported, so a render bug in the hub can never take down the MCP tool list —
// the same reasoning as context-cost.cjs. This file exports the surface the hub
// needs and knows nothing else about it.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { cutoffWhy, ollamaOptions } from "./runner-limits.mjs";
import { renderHealth } from "./health.mjs";
import { buildIssueUrl, buildLesson, fetchFeed, renderFeed } from "./lessons.mjs";
import { assertLoopback, buildRunnerDrafts, discoverLocal, renderDiscover } from "./discover.mjs";
import { refuseBusSelfEdit } from "./edits.mjs";
import {
  blockAnnounce,
  blockMessage,
  capableList,
  fixNoteKey,
  matchCapable,
  matchFixes,
  pruneBlocks,
} from "./blockers.mjs";
import {
  extractHistory,
  inferRole,
  isEmptyAnswer,
  pickForRole,
  recommendRunner,
  ROLES,
  routedLine,
  routingVerdicts,
  suggestLine,
} from "./routing.mjs";
import {
  BENCH_PROMPTS,
  JUDGE_INSTRUCTION,
  parseJudgeScore,
  pruneSuggestions,
  qualifiesForSuggestions,
  renderBench,
  scoreBench,
} from "./bench.mjs";
import {
  addProject,
  cleanName,
  cleanRoot,
  readRegistry,
  removeProject,
  statePathForRoot,
  writeRegistry,
} from "./projects.mjs";

// Version from package.json when it sits two levels up (the repo / the
// npm-installed package both have it there); the fallback keeps a bare-clone
// edge working and matches the release this code last shipped. One number,
// one source: a harness pin asserts the two never disagree.
const PKG = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8")
    );
  } catch {
    return null;
  }
})();
const VERSION = (PKG && PKG.version) || "0.1.5";
const PROTOCOL = "2024-11-05";

/* ── where state lives ────────────────────────────────────────────────────── */

// The project root — the repo the bus serves. Precedence, highest first:
//   1. AGENT_BUS_PROJECT, resolved. A configured root IS the repo — this is
//      how the hub (from its own repo) points the bus at a checkout it does
//      not live in.
//   2. The git root nearest process.cwd(). --git-common-dir resolves to the
//      main repo's .git from inside any worktree, so the parent is the main
//      root — the whole reason worktrees share one bus.
//   3. process.cwd() itself. A project that is not a git repo is still a
//      project; its state goes to <cwd>/.agent-bus/ below, not into a .git
//      it does not have.
// import.meta.dirname must never feed into this: it is where the CODE lives,
// which once installed globally is unrelated to the project — and a wrong
// root would not throw, it would silently watch the wrong project (the
// transcript dir is hashed from it), which is the failure to prevent.
function projectRoot() {
  if (process.env.AGENT_BUS_PROJECT) {
    return path.resolve(process.env.AGENT_BUS_PROJECT);
  }
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.dirname(path.resolve(process.cwd(), common));
  } catch {
    return process.cwd();
  }
}

const PROJECT_ROOT = projectRoot();

function stateDir() {
  // Inside .git so it is never tracked or pushed — the same reason worktrees
  // share one bus — but a project with no .git gets a plain dot-directory
  // rather than a .git it does not own.
  const gitDir = path.join(PROJECT_ROOT, ".git");
  const dir = fs.existsSync(gitDir)
    ? path.join(gitDir, "agent-bus")
    : path.join(PROJECT_ROOT, ".agent-bus");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const DIR = stateDir();
const STATE = path.join(DIR, "state.json");
const LOCK = path.join(DIR, ".lock");

// §6 — the registry of apps this bus serves, read-only for rendering and
// write-serialized through withState (the same lock the state file uses).
const REGISTRY = path.join(DIR, "projects.json");

/**
 * Read another project's bus state WITHOUT writing it. The hub renders a
 * registered app's board from this; a missing or mid-write file reads as an
 * empty bus rather than an error, because the next request re-reads it.
 */
function readStateForRoot(root) {
  try {
    const state = JSON.parse(fs.readFileSync(statePathForRoot(root), "utf8"));
    if (!state || typeof state !== "object") return null;
    return state;
  } catch {
    return null;
  }
}

// Docs resolution is TWO things, and one function used to serve both (the
// split is packaging.md item 5):
//   - packageDocsDir() — the hub's own learning: the rulebook, how-we-work,
//     the workflow spine. These ship WITH the code, wherever it is installed,
//     so they resolve from the CODE home — path traversal from this file to
//     <package>/docs. AGENT_BUS_DOCS_DIR still names an alternatives home
//     from outside the code.
//   - projectDocsDir() — the served project's own docs. No consumer needs
//     this yet; it exists so the day one arrives, "whose docs?" is already
//     settled rather than re-fought. PROJECT_ROOT, never the package.
function packageDocsDir() {
  return process.env.AGENT_BUS_DOCS_DIR
    ? path.resolve(process.env.AGENT_BUS_DOCS_DIR)
    : path.resolve(import.meta.dirname, "..", "..", "docs");
}
function projectDocsDir() {
  return path.join(PROJECT_ROOT, "docs");
}

/* ── the workflow spine, as data ──────────────────────────────────────────── */

// The ten stages, from the spine doc's own headings — the doc is the readable
// source (the hub renders it), so the bus validates against the same list the
// person reads, not a second copy that can drift. The fallback exists because
// a moved docs dir must degrade to the fixed list, never break queueing.
const SPINE_STAGES = [
  "idea", "spec", "design", "build", "review",
  "test", "release", "publish", "monitor", "maintain",
];
function readStages() {
  try {
    const raw = fs.readFileSync(path.join(packageDocsDir(), "workflow-spine.md"), "utf8");
    const names = [...raw.matchAll(/^##\s+\d+\.\s+(.+?)\s+—/gm)].map((m) => m[1].trim().toLowerCase());
    return names.length === SPINE_STAGES.length ? names : SPINE_STAGES;
  } catch {
    return SPINE_STAGES;
  }
}
function validateStage(wanted) {
  const s = String(wanted ?? "").trim().toLowerCase();
  if (!readStages().includes(s)) {
    throw new Error(`Unknown stage "${wanted}". The ten, from docs/workflow-spine.md: ${SPINE_STAGES.join(", ")}.`);
  }
  return s;
}

/* ── atomic state access ──────────────────────────────────────────────────── */

// Node has no sleep; Atomics.wait on a throwaway buffer blocks without spinning
// the CPU, which matters because this process is otherwise idle.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_STALE_MS = 10_000;

/** Lock-open errors that mean "someone else is mid-way through the lock file"
 *  on Windows (a pending delete), not a real refusal -- see withState. */
const TRANSIENT_LOCK_OPEN_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Run `fn` against the state file while holding an exclusive lock.
 *
 * `openSync(..., "wx")` is an ATOMIC exclusive create on both Windows and
 * POSIX. Without that atomicity two agents claim the tree in the same
 * millisecond and we are back where we started, except now with a file that
 * says everything is fine.
 *
 * The lock carries an identity token (SESSION_KEY, one per process). Both
 * halves of the stale-lock handling read it before acting: a stale lock is
 * broken only when its holder's pid is actually dead, and the cleanup at the
 * end unlinks the lock only if it still holds OUR token. Without that second
 * check this is a race, not a lock: B judges A's lock stale, unlinks it and
 * takes its own; A's finally then unlinks — deleting B's live lock — and a
 * third process walks straight in while B is mid-write. Two writers, lost
 * update. The failure the lock exists to prevent, reintroduced by its own
 * cleanup path.
 */
function withState(fn) {
  const token = `${process.pid}:${SESSION_KEY}`;
  let fd = null;
  let lastTransient = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      fd = fs.openSync(LOCK, "wx");
      fs.writeFileSync(fd, token);
      break;
    } catch (err) {
      // On Windows, opening a file another process is in the middle of
      // deleting (the previous holder's unlink) fails with EPERM -- sometimes
      // EACCES or EBUSY -- instead of EEXIST. That is contention, not a real
      // permission problem: wait and retry like EEXIST. Rethrowing it killed
      // two idle `work` processes on 2026-09-28 (lock-harness.mjs pins it). A
      // genuine permission problem still surfaces, once the budget is spent.
      if (TRANSIENT_LOCK_OPEN_CODES.has(err.code)) {
        lastTransient = err;
        sleepMs(15);
        continue;
      }
      if (err.code !== "EEXIST") throw err;
      // A session that crashed holding the lock must not deadlock the others.
      // Mtime alone is not proof of death — a legitimately slow critical
      // section looks identical to a crashed holder — and pid liveness alone
      // is not proof of life: a recycled pid keeps a dead holder looking
      // alive forever. So: break when the lock is old AND its holder's pid is
      // dead, or when it is old by 6x regardless (no critical section here
      // runs a minute; the state write is a JSON read-modify-write).
      try {
        const lockText = fs.readFileSync(LOCK, "utf8");
        const sep = lockText.indexOf(":");
        const holderPid = sep >= 0 ? Number.parseInt(lockText.slice(0, sep), 10) : Number.NaN;
        const age = Date.now() - fs.statSync(LOCK).mtimeMs;
        if ((age > LOCK_STALE_MS && !holderAlive({ holderPid })) || age > LOCK_STALE_MS * 6) {
          fs.unlinkSync(LOCK);
          continue;
        }
      } catch {
        /* someone else just removed it; retry */
      }
      sleepMs(15);
    }
  }
  if (fd === null) {
    throw new Error(
      "agent-bus: could not acquire the state lock" +
        (lastTransient ? ` (last open error: ${lastTransient.code} -- ${lastTransient.message})` : ""),
    );
  }

  try {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    } catch (err) {
      // Absent is the first boot — an empty base is correct. Present-but-
      // unreadable (a corrupt file, a permission slip) is NOT: starting from
      // an empty base here would silently overwrite the whole bus — every
      // note, task and lesson gone with the next write. Fail loudly instead;
      // the person recovers the file, the bus does not destroy it. Hardened
      // while building the steward triage loop (2026-09-13): the bus's whole
      // value is that nothing reported to it is ever lost.
      if (err.code === "ENOENT") state = null;
      else throw err;
    }
    if (!state || typeof state !== "object") {
      state = { agents: {}, lock: null, messages: [], board: {}, archive: {}, handoffs: {}, tasks: [], taskSeq: 0, publishes: [] };
    }
    state.agents ||= {};
    state.messages ||= [];
    state.board ||= {};
    state.tasks ||= [];
    state.blocks ||= [];

    const result = fn(state);

    // Write-then-rename, so a reader never sees a half-written file.
    const tmp = `${STATE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE);
    return result;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    // Only remove a lock that is still ours. If it is not, its removal is
    // someone else's business — see the identity comment above.
    try {
      if (fs.readFileSync(LOCK, "utf8") === token) fs.unlinkSync(LOCK);
    } catch { /* already gone */ }
  }
}

/* ── identity ─────────────────────────────────────────────────────────────── */

// One server process is spawned per session, so the process IS the session.
const SESSION_KEY = randomUUID();
let myName = null;
// A CLI invocation exits the instant it finishes, so its pid is dead by the next
// command. Recording it would make every CLI claim look abandoned and stealable
// — which is exactly what the smoke test caught. CLI claims fall back to the
// TTL instead; a shell script cannot be probed for liveness the way a
// long-running server process can.
let IS_CLI = false;

function requireName() {
  if (!myName) {
    throw new Error(
      "Call register(name) first so other agents know who you are."
    );
  }
  return myName;
}

/**
 * Lend this process's identity to a caller for the length of `fn`.
 *
 * The hub's window (hub.mjs) and the CLI both act on behalf of a name without
 * being a registered session — the web UI borrows "desk", a shell passes its
 * name per command. myName and IS_CLI are module state on purpose: callTool()
 * reads them for attribution and for whether a tree claim should carry a pid.
 * Exported so the hub can borrow WITHOUT reaching into this module's internals.
 */
function asActor(actor, fn) {
  const prevName = myName;
  const prevCli = IS_CLI;
  myName = actor;
  IS_CLI = true;
  try {
    return fn();
  } finally {
    myName = prevName;
    IS_CLI = prevCli;
  }
}

const nowIso = () => new Date().toISOString();

// Prototype pollution: JSON.parse returns plain objects whose __proto__ is
// still settable by name. `state.board["__proto__"] = {...}` sets the
// prototype instead of a key — the note silently never persists, stringify
// drops it, and no error says why. The same trap holds for "constructor" and
// "prototype". One regex at the door beats explaining that to whoever hits it.
const UNSAFE_KEY = /^(?:__proto__|constructor|prototype)$/;
const assertKey = (key, what = "key") => {
  if (UNSAFE_KEY.test(key)) throw new Error(`"${key}" is not a usable ${what}.`);
  return key;
};
// An agent name becomes an object key in state and a column header on the
// dashboard — a 4,000-character name is not an identity, it is a state-file
// bloat vector. Sixty-four is generous for "lane-d".
const MAX_NAME_CHARS = 64;
const assertName = (name) => {
  const wanted = String(name ?? "").trim();
  assertKey(wanted, "name");
  if (wanted.length > MAX_NAME_CHARS) {
    throw new Error(`A name is at most ${MAX_NAME_CHARS} characters.`);
  }
  return wanted;
};

// State is a JSON file rewritten on EVERY bus call, so unbounded text is not
// just a memory leak — it is a slowdown on every read, write and dashboard
// render, forever. These caps are generous: a note is a paragraph, a task
// prompt is a spec, and a model draft rarely clears a few kilobytes. Anything
// past the cap truncates with a marker rather than refusing, because a capped
// fact still beats no fact.
const MAX_NOTE_CHARS = 8_000;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TASK_TITLE_CHARS = 200;
const MAX_TASK_PROMPT_CHARS = 32_000;
const MAX_TASK_RESULT_CHARS = 64_000;
const cap = (s, n) => {
  const text = String(s ?? "");
  return text.length > n ? text.slice(0, n) + `\n[truncated at ${n} chars]` : text;
};

// --- the `handoff` verb's rendering + list-shape helpers (module scope so
// --- they are hoisted above the switch that uses them; a const between two
// --- cases would sit in its TDZ when control jumps straight to the case).
const renderHandoff = (entry) => {
  const firstLine = (s) => String(s ?? "").split("\n")[0];
  const lines = [`HANDOFF (set ${entry.setAt} by ${entry.by}, next: ${firstLine(entry.nextStep)})`];
  lines.push("", "STATE OF THE WORLD", entry.summary);
  if (entry.nextStep !== firstLine(entry.nextStep)) {
    lines.push("", "NEXT STEP", entry.nextStep);
  }
  if (entry.open.length) {
    lines.push("", `OPEN (${entry.open.length}; priority order, first is first done)`);
    entry.open.forEach((o, i) => {
      lines.push(`${i + 1}. ${o.title}`);
      if (o.detail) lines.push(`   ${o.detail}`);
      if (o.busKey) lines.push(`   belongs to board key: ${o.busKey}`);
    });
  }
  if (entry.pointers.length) {
    lines.push("", "POINTERS", ...entry.pointers.map((p) => `  - ${p}`));
  }
  if (entry.constraints.length) {
    lines.push("", "CONSTRAINTS (inherited — they outlived the last session too)", ...entry.constraints.map((c) => `  - ${c}`));
  }
  if (entry.taken.length) {
    lines.push("", `TAKEN (${entry.taken.length}) — chain of custody; coordinating on the bus is yours, not the bus's job:`);
    entry.taken.forEach((t) => lines.push(`  ${t.by} at ${t.at}`));
  }
  return lines.join("\n");
};
const handoffKeyOf = (args) => {
  const key = String(args?.key || "handoff").trim() || "handoff";
  return assertKey(key);
};

/* ── the worktree verb ─────────────────────────────────────────────────────
 * docs/worktree-verb.md. The lane's recurring FIRST MOVE — git worktree add,
 * claim_tree, handoff_take — as one call. Each step stays the same tool it
 * composes (callTool("claim_tree"), callTool("handoff_take")); nothing is
 * forked. Every slug and ref is validated here and every git call is a fixed
 * argv through spawnSync, never a shell. Same module-scope rule as the
 * handoff helpers above: no const between two cases. */
const WORKTREE_SLUG = /^[a-z0-9][a-z0-9._-]{0,48}$/i;
const WORKTREE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const worktreeRefOk = (ref) =>
  WORKTREE_REF.test(ref) && !ref.includes("..") && !ref.endsWith(".lock") && !ref.startsWith("refs/");
const gitRun = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
// The trees' home: Claude Code's `.claude/` convention when the project has
// one, a plain sibling directory when it does not (the bus serves non-Claude
// fleets, which should not acquire a .claude dir by side effect).
const worktreeBaseDir = (root) =>
  fs.existsSync(path.join(root, ".claude"))
    ? path.join(root, ".claude", "worktrees")
    : path.join(root, "agent-bus-worktrees");
// Base ref: --from first; then what clones record (origin/HEAD), else the two
// common defaults — each ACTUALLY resolved, never assumed — then HEAD, so a
// repo with no remote still branches. The result is printed in the reply.
const worktreeBaseRef = (root, from) => {
  if (from) return from;
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    if (gitRun(["rev-parse", "--verify", "--quiet", ref], root).status === 0) return ref;
  }
  return "HEAD";
};
// List fields accept the loose shapes a hurried writer actually sends: plain
// strings become {title} items or pointer lines. An absent field is an empty
// list — that is normal (most handoffs have no constraints) — but an unusable
// list is refused rather than silently dropped, because a constraint that
// vanished on write is worse than one that was never written.
const handoffOpenItems = (raw) => {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("`open` must be an array of {title, detail?, busKey?} or strings.");
  return raw
    .map((item) => {
      if (typeof item === "string") return { title: cap(item.trim(), MAX_NOTE_CHARS) };
      const title = cap(String(item?.title ?? "").trim(), MAX_NOTE_CHARS);
      if (!title) return null;
      const out = { title };
      const detail = String(item?.detail ?? "").trim();
      if (detail) out.detail = cap(detail, MAX_NOTE_CHARS);
      const busKey = String(item?.busKey ?? "").trim();
      if (busKey) out.busKey = assertKey(busKey, "busKey");
      return out;
    })
    .filter((item) => item !== null);
};
const handoffLines = (raw, what) => {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(`\`${what}\` must be an array of strings.`);
  return raw
    .map((line) => cap(String(line).trim(), MAX_NOTE_CHARS))
    .filter((line) => line !== "");
};

/**
 * An overwrite is not an erasure. `keepHistory` files the prior entry into
 * `state[store][key]` before it is replaced — the same shape the handoff
 * verb uses (newest first, cap 5, supersededAt/by alongside the clone).
 * Called from note/miss; handoff runs its own identical block because it
 * carries its field set. Store name is a parameter, not a hardcode, so a
 * future kind keeps the same discipline without a third store name.
 */
const keepHistory = (state, store, key, prior, me) => {
  state[store] ||= {}; // states written before history existed have none yet
  const history = state[store][key] || [];
  history.unshift({ ...structuredClone(prior), supersededAt: nowIso(), supersededBy: me });
  state[store][key] = history.slice(0, 5);
};

/**
 * searchBoard — the `search` verb's engine. Deliberately dumb: lowercase
 * substring over active board values (and their keys), then kept handoff
 * history and note history, active hits first because "what is on the board
 * now" is what most queries mean. Deterministic order, no scoring, no
 * model — a match that can be explained is worth more than a clever one
 * nobody can audit (the blocker matcher's rule).
 */
const searchBoard = (state, query, limit) => {
  const needle = query.toLowerCase();
  const hits = [];
  const addHit = (where, text) => {
    for (const rawLine of String(text ?? "").split("\n")) {
      if (hits.length >= limit) return true;
      if (rawLine.toLowerCase().includes(needle)) {
        hits.push({ where, line: cap(rawLine.trim(), 200) });
      }
    }
    return false;
  };
  const board = Object.entries(state.board ?? {}).sort(
    (a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)
  );
  for (const [k, v] of board) {
    // A key hit shows the entry's first line, not a "matched" value line —
    // otherwise a key that contains the query AND a value line that does too
    // would file the same line twice under two labels.
    if (k.toLowerCase().includes(needle)) {
      hits.push({ where: `${k} (active, key)`, line: cap(String(v.value).split("\n")[0].trim(), 200) });
      if (hits.length >= limit) break;
    }
    if (addHit(`${k} (active)`, v.value)) break;
  }
  for (const [k, history] of Object.entries(state.handoffs ?? {})) {
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      if (addHit(`${k} (handoff history #${i + 1}, set ${h.at})`, h.value)) return hits;
    }
  }
  for (const [k, history] of Object.entries(state.archive ?? {})) {
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      if (addHit(`${k} (note history #${i + 1}, set ${h.at})`, h.value)) return hits;
    }
  }
  return hits;
};

/**
 * Task dependencies. A dep "done" unlocks; gone-from-queue also unlocks —
 * the queue's prune only ever drops finished tasks, so a missing dep was a
 * meeting one, not a blocked one. Everything else (queued, running, draft,
 * failed) blocks: a draft is an answer nobody has applied yet, which a
 * dependent must not build on.
 */
const unmetDeps = (state, task) =>
  (task.depends_on ?? []).filter((id) => {
    const dep = (state.tasks ?? []).find((t) => t.id === id);
    return dep != null && dep.status !== "done";
});

/** Can the OS still see this process? `kill(pid, 0)` sends no signal — it only
 *  asks whether that pid exists, and works on Windows and POSIX alike; EPERM
 *  means it exists but belongs to another user — still alive. This is the same
 *  primitive holderAlive uses for locks, applied to agent registrations. */
function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Is this registration's process verifiably running HERE? A registration from
 *  another machine carries a pid this machine cannot vouch for, so a recorded
 *  host that is not this one falls back to the time rule. A CLI one-shot
 *  records the pid of an ephemeral process — the check then reads false and
 *  the card falls back to lastSeen, which is the honest display for it. */
function agentRunning(a) {
  if (!a || !pidAlive(a.pid)) return false;
  if (a.host && a.host !== os.hostname()) return false;
  return true;
}

function pruneAgents(state) {
  // An agent that has not been seen for an hour is gone. Its name frees up so a
  // restarted session can take it back — unless its process is still running.
  // A long-lived agent working locally between bus calls is exactly the one the
  // board must not vanish, and agentRunning is proof, not a guess.
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [name, a] of Object.entries(state.agents)) {
    if (Date.parse(a.lastSeen ?? 0) < cutoff && !agentRunning(a)) delete state.agents[name];
  }
}

function touch(state) {
  if (myName && state.agents[myName]) {
    state.agents[myName].lastSeen = nowIso();
  }
}

/**
 * Is the holding process still alive?
 *
 * One server process is spawned per session, so the process IS the session.
 * `kill(pid, 0)` sends no signal — it just asks the OS whether that pid exists,
 * and works on Windows and POSIX alike. This is EXACT where a heartbeat would
 * only be a guess: a crashed agent and a busy one look identical from outside,
 * so anything time-based either deadlocks on a crash or steals from an agent
 * that is mid-rebase.
 */
function holderAlive(lock) {
  if (!lock || typeof lock.holderPid !== "number") return true; // pre-1.1 lock, trust the TTL
  return pidAlive(lock.holderPid);
}

function lockIsLive(lock) {
  if (!lock) return false;
  if (Date.parse(lock.expiresAt) <= Date.now()) return false;
  // The TTL is a courtesy cap; process liveness is the real check.
  return holderAlive(lock);
}

function describeLock(lock) {
  if (!lockIsLive(lock)) return "The working tree is free.";
  const mins = Math.max(0, Math.round((Date.parse(lock.expiresAt) - Date.now()) / 60000));
  return `HELD by ${lock.holder} — ${lock.reason} (${lock.path}), expires in ~${mins} min.`;
}

/* ── tools ────────────────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: "register",
    description:
      "Claim a name on the bus so other agents can address you. Call this once at the start of a session, before any other bus tool. Say which lane or task you are on — that is what other agents see when they check who is active.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short handle, e.g. 'lane-d' or 'opus-desktop'." },
        lane: { type: "string", description: "What you are working on." },
      },
      required: ["name"],
    },
  },
  {
    name: "agents",
    description:
      "Who else is active, what they are working on, and who currently holds the working tree. Check this before you touch a shared checkout.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "claim_tree",
    description:
      "Take an exclusive claim on a working directory before running git checkout, stash, rebase or commit in it. Refuses and names the current holder if someone else has it. ALWAYS claim before switching branches in a shared checkout — that is the failure this bus exists to stop.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the working tree." },
        reason: { type: "string", description: "What you are about to do, in a few words." },
        minutes: {
          type: "number",
          description: "How long you expect to need it. Default 30, max 240. The claim expires on its own so a crashed session cannot deadlock everyone.",
        },
      },
      required: ["path", "reason"],
    },
  },
  {
    name: "release_tree",
    description: "Give back a working-tree claim as soon as you are done. Do not hold it while idle.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "worktree",
    description:
      "One call for a lane's first move: create a git worktree for <name> (branch bus/<name> by default, --branch for the fleet's own habit), claim it on the bus, and — when the board holds exactly ONE handoff — take it. Two or more handoffs are never guessed between; nothing auto-removes a tree. The reply names the tree, branch, claim and taken handoff together.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Leaf slug (letters, digits, . _ -). The tree lands under the project's .claude/worktrees/, or agent-bus-worktrees/ when there is no .claude." },
        from: { type: "string", description: "Base ref. Default: origin/HEAD, else origin/main, else origin/master, else HEAD." },
        branch: { type: "string", description: "Branch name. Default: bus/<name>." },
        handoff: { type: "string", description: "Pick a specific handoff key when several are on the board." },
        no_handoff: { type: "boolean", description: "Set true to skip the handoff step entirely." },
        minutes: { type: "number", description: "Claim length; default 30, max 240." },
      },
      required: ["name"],
    },
  },
  {
    name: "send",
    description:
      "Send a message to another agent by name, or to 'all'. Use it for things that need a reply. Anything another agent will need LATER — a landed change, a moved pattern — belongs in note() instead, because a message only reaches whoever is listening now.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "A registered agent name, or 'all'." },
        message: { type: "string" },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "inbox",
    description:
      "Read messages addressed to you and mark them read. Call this at the start of a turn and before any git operation — this bus cannot push, so you only see messages when you look.",
    inputSchema: {
      type: "object",
      properties: {
        include_read: { type: "boolean", description: "Also show messages already read. Default false." },
      },
    },
  },
  {
    name: "note",
    description:
      "Post a durable fact to the noticeboard, keyed so it can be overwritten as things change. This is for what the NEXT agent needs to know regardless of whether they were listening: 'the table pattern moved to DataTable', 'Lane C already ships ComponentsPanel'. Four stale-spec incidents in this repo happened because facts like these lived only in a conversation. A problem the PERSON reports goes here FIRST, under a fresh key, before you fix it (rule G3) — then a follow-up note under the same key with the fix. A problem you hit yourself goes here too (rule G2).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Stable key, e.g. 'table-pattern' or 'lane-c-status'." },
        value: { type: "string", description: "The fact. Write it for someone who was not here." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "board",
    description:
      "Read the noticeboard — every durable fact posted by any agent, newest first. Read this BEFORE acting on a spec or handoff doc: the doc may have been written before the fact was posted.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "miss",
    description:
      "Report that you caught YOURSELF being wrong. State what you claimed, what turned out to be true, and what surfaced it. The pairing is the record: a miss tells the next agent this is a question worth checking rather than recalling. The same mistake reported again overwrites its own entry and shows as recurring — three times means it is a rule that has not been written yet.",
    inputSchema: {
      type: "object",
      properties: {
        claimed: { type: "string", description: "What you said or believed." },
        truth: { type: "string", description: "What was actually true." },
        caught: { type: "string", description: "How it surfaced — which check, which failure. Optional." },
      },
      required: ["claimed", "truth"],
    },
  },
  {
    name: "handoff",
    description:
      "Write or supersede this project's ACTIVE handoff: the whole state of a session that is ending — what is true, the ONE thing to do first, the open work in priority order, the pointers the next agent must read, and the standing constraints it inherits. The next agent must be able to resume from the bus alone, without your transcript, without you alive to ask. Writing again under the same key replaces the active one (the old one is kept in history). A handoff is a statement of state — it never enters the task queue.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The state of the world, verified. Written for someone who was not here. No narrative." },
        nextStep: { type: "string", description: "The ONE thing to do first. No single first thing? Prioritize the open list first — do not post a handoff without a next step." },
        open: { type: "array", description: "Open work, priority order (first item = first done). Each item: {title, detail?, busKey?} — detail is enough to start without the old session; busKey is the board note this work belongs to, so priorities and problems stay linked.", items: { type: "object" } },
        pointers: { type: "array", description: "Repo-relative or absolute paths, doc names, commit SHAs — what a claimant must read before touching code.", items: { type: "string" } },
        constraints: { type: "array", description: "Standing rules that outlive the session: 'target is linux', 'do not push without the user'.", items: { type: "string" } },
        key: { type: "string", description: "Default 'handoff'. Use a suffix per scope sharing one bus, e.g. 'handoff-camera'." },
      },
      required: ["summary", "nextStep"],
    },
  },
  {
    name: "handoff_take",
    description:
      "Resume this project's ACTIVE handoff, on the record: returns all of it verbatim and stamps you on its taken chain. A handoff nobody took is a rumor — the chain is the custody. Two agents may both take one; both names show on the chain and each sees the other, so coordinate on the bus before you start. Taking locks nothing.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Default 'handoff'. The same key the writer used." },
      },
    },
  },
  {
    name: "history",
    description:
      "Return the stack under a board key: the ACTIVE entry (note or handoff — verbatim) plus every kept prior one, newest first, each named with its author, set-at and superseded-at/by. A fact that was replaced is not a fact that was erased.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The board key, exactly as written (e.g. handoff-camera)." },
      },
      required: ["key"],
    },
  },
  {
    name: "search",
    description:
      "Full-text search of the board and its kept history: notes, misses, handoffs and their prior entries. Case-insensitive substring — dumb, deterministic, explainable. Returns the key, where the hit sits and the matched line.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The text to look for. Minimum one non-space character." },
        limit: { type: "number", description: "Max matches returned. Default 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "health",
    description:
      "Is this space decaying? Runs the shared contract: runners silent while a task says running, queues nobody is picking up, drafts waiting on a human apply, handoffs with an empty taken chain, blocks standing OPEN. Clean runs name everything they checked.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ping",
    description:
      "One-line liveness: the cheapest mutating call, so an agent doing long local work between bus calls keeps showing on the board. Registers if you have not, refreshes lastSeen if you have.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "status",
    description:
      "Everything at a glance: who is connected and when each was last heard from, who holds the working tree, and the board's keys with their authors. Board VALUES are paragraphs; use board() for the full text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "task_add",
    description:
      "Queue work for a runner (the `work` loop). The answer lands on the queue as a DRAFT — the runner never touches the repo, so local-model output always gets reviewed before it becomes code.",
    inputSchema: {
      type: "object",
      properties: {
        lane: { type: "string", description: "Which lane polls for this. Default 'local'." },
        title: { type: "string", description: "A few words, for the dashboard row." },
        prompt: { type: "string", description: "The WHOLE spec. Runners are prompt-in/text-out with no filesystem — paste anything they would otherwise have to read." },
        runner_id: { type: "string", description: "An id from runners(). Omitted = the bus fills the task's role from its measurements, or the lane's default until it has any." },
        role: { type: "string", description: "quick (an ordinary job, about one file's worth) or deep (a long or tricky one). Omitted = sized from the prompt. The bus picks the runner for the role from its own record; a miss is retried once on the role's next runner." },
        stage: { type: "string", description: "Optional — which workflow-spine stage this work belongs to: idea, spec, design, build, review, test, release, publish, monitor or maintain. Refused if it names none of them." },
        depends_on: { type: "array", items: { type: "string" }, description: "Task ids this one waits on — it stays blocked (and is never claimed) while any dep is not done. Ids must exist; typos are refused, not forgotten." },
      },
      required: ["lane", "title", "prompt"],
    },
  },
  {
    name: "runners",
    description:
      "The runners this bus may invoke, from runners.json — enabled ones first, disabled marked x. Pass an id to task_add's runner_id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tasks",
    description:
      "The task queue, newest first — the last 20, status and the first 400 chars of any result. The dashboard's per-task pages carry the full text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capable",
    description:
      "Declare what you can GRANT other agents — tools, access, skills, e.g. ['ollama', 'stripe', 'tree']. When someone reports a blocker, the bus matches what they need against these words and asks you. Re-registering keeps your declaration.",
    inputSchema: {
      type: "object",
      properties: {
        capabilities: {
          type: "array",
          items: { type: "string" },
          description: "Short grant-words, at most 12 entries, each 40 chars or fewer.",
        },
      },
      required: ["capabilities"],
    },
  },
  {
    name: "block",
    description:
      "You are stuck. Report WHAT you are blocked on and WHAT would unblock it — the bus asks whoever declared they can grant it (they get a message in their inbox) and hands you any fix the fleet already banked under fix-… on the board.",
    inputSchema: {
      type: "object",
      properties: {
        what: { type: "string", description: "What you are blocked on, in plain words." },
        needed: { type: "string", description: "What would unblock it — the capability, tool or access you need." },
      },
      required: ["what", "needed"],
    },
  },
  {
    name: "unblock",
    description:
      "Resolve a blocker you can handle (block reports arrive in your inbox). Your fix is banked on the board under fix-… so the NEXT agent that hits the same block is handed the answer instead of asking again.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The blocker id, e.g. b3." },
        how: { type: "string", description: "What you did that worked — this becomes the banked fix." },
      },
      required: ["id", "how"],
    },
  },
  {
    name: "projects",
    description:
      "The apps this bus serves, registered beside itself. Each gets its own board, lock and queue on the hub (switch with ?p=). Cross-app facts — the rulebook, the runner record, token lessons — stay on the hub's own bus and are never copied per app.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_add",
    description:
      "Register an app the hub builds: it gets its own space (board, lock, agents, queue) and appears in the hub window's Spaces bar. The root must exist on disk; the registry lives inside this bus's .git and is never committed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short slug for links — letters, digits, dots or dashes, e.g. orbitfall." },
        root: { type: "string", description: "The app's project root on disk." },
      },
      required: ["name", "root"],
    },
  },
  {
    name: "project_remove",
    description: "Deregister an app space. Nothing on the app's own bus is touched — only this registry forgets it.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The slug it was registered under." },
      },
      required: ["name"],
    },
  },
  {
    name: "review",
    description:
      "Review a FINISHED task's draft — approve it or request changes, with a reason. The verdict is stamped on the task record, so 'was this reviewed' is data, not whatever the last message said. Fleets are worst at review precisely because nobody can feel blame: the record makes the skipped step visible. You cannot review a task your own name ran.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task id, e.g. t3." },
        verdict: { type: "string", enum: ["approve", "changes"], description: "approve = good enough to use; changes = what has to be different, in notes." },
        notes: { type: "string", description: "Why — especially for changes: what to fix." },
      },
      required: ["task_id", "verdict"],
    },
  },
  {
    name: "apply",
    description:
      "Turn a DRAFT brief into work — the orchestrator's one-word dispatch. A steward-drafted brief sits as a task in status \"draft\", unclaimable until a person (or an agent acting on one) applies it. apply is that act, on the record: the task enters the queue and the apply is stamped on the task's review timeline. Nothing auto-applies — this verb is the hand on the key; refusing everything that is not a draft keeps it from becoming a second claim path.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The draft task id, e.g. t5." },
        notes: { type: "string", description: "Optional — anything the orchestrator wants on the record with the dispatch." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "publish",
    description:
      "Record that a build SHIPPED: which version, what went out. The per-space publish record is the spine's Publish stage made durable — 'it shipped' stops being whatever the last message claimed and becomes a dated entry a person can audit.",
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "string", description: "What to call it — a tag, a build id, a date." },
        what: { type: "string", description: "What went out, in a sentence." },
      },
      required: ["version", "what"],
    },
  },
];

// The cost rules every joining agent is told, whatever it has read. Measured,
// not taste: build-rules.md H16, J5, J6 and K2 carry the numbers. They ride on
// register() rather than on the first-time board, because the agents that
// most need them are the ones that have been here before.
export const COST_RULES = [
  "COST RULES (docs/build-rules.md H16, J5, J6, K2) — every turn re-reads the whole conversation, so:",
  "- Do not force a compaction or set autoCompactWindow: context is summarized automatically and the session continues, so finishing the task beats wrapping up early. Cost is set by what ENTERS context - never re-read a file you have already read, never re-derive a settled fact, and send bulk reading to a subagent that returns the conclusion instead of the file.",
  "- Hand off a whole file's worth of work at once, never one small function. Code under ~30 lines you write yourself; checks first either way.",
  "- Queue a handoff with task_add and a role: quick for one ordinary file, deep for a long or tricky body. The bus fills each role from its own measured record and retries a miss once on the role's next runner; an empty answer is a limit first, so read done_reason.",
  "- Do the bus steps for a commit in one command: claim && commit; release.",
].join("\n");

// The first-time rules, carried by the bus itself (see the board case). An
// agent that arrives on a fresh install reads this on its first board() — no
// human has to paste the README into it first.
const ONBOARDING = [
  "FIRST TIME ON THIS BUS — nobody has registered yet, so read this once:",
  "1. Read the rulebook before writing code: docs/build-rules.md (next to tools/agent-bus/). It outranks your habits; sections I (editing files), J (delegating to a runner) and K (this bus) are the operating rules.",
  "2. register(name, lane) before claiming anything — the name is how everything you do is attributed.",
  "3. claim the working tree before ANY git operation, release when done. The lock only protects anyone because agents obey it.",
  "4. note() is durable — the next agent reads it even if it arrives after you are gone. message() only reaches someone watching inbox() right now. When in doubt, note.",
  "5. task() queues work for a local runner; the answer comes back as a DRAFT — the worker never touches the repo.",
  "6. This bus belongs to the project root it was started from (state lives in <root>/.git/agent-bus). If your tool's cwd is not that root, set AGENT_BUS_PROJECT — a wrong cwd writes to the wrong bus and prints success anyway (K1).",
].join("\n");

function callTool(name, args) {
  switch (name) {
    case "register": {
      const wanted = String(args.name || "").trim();
      if (!wanted) throw new Error("A name is required.");
      assertKey(wanted, "name");
      if (wanted.length > MAX_NAME_CHARS) {
        throw new Error(`A name is at most ${MAX_NAME_CHARS} characters.`);
      }
      return withState((state) => {
        pruneAgents(state);
        const existing = state.agents[wanted];
        // A holder whose recorded process is provably gone on THIS machine is
        // a session that was closed or restarted: its name is free now, not an
        // hour from now. No pid (an older server) or another host's pid proves
        // nothing, so those keep the hour.
        const holderGone = Boolean(existing?.pid) &&
          (!existing.host || existing.host === os.hostname()) && !pidAlive(existing.pid);
        if (existing && existing.sessionKey !== SESSION_KEY && !holderGone) {
          const age = Date.now() - Date.parse(existing.lastSeen ?? 0);
          if (age < 60 * 60 * 1000) {
            throw new Error(
              `"${wanted}" is already registered by another live session (last seen ${Math.round(age / 1000)}s ago). Pick a different name.`
            );
          }
        }
        myName = wanted;
        state.agents[wanted] = {
          sessionKey: SESSION_KEY,
          lane: args.lane ? String(args.lane) : null,
          cwd: process.cwd(),
          // Same rule as registerCli: the pid backs a "running" badge with a
          // live process, and host stops a foreign machine's pid being checked
          // against this one.
          pid: process.pid,
          host: os.hostname(),
          registeredAt: nowIso(),
          lastSeen: nowIso(),
          // A re-registration (session restart, name re-claim after the hour)
          // keeps the capabilities its predecessor declared — the agent is the
          // same fleet member even if the process is not.
          ...(existing?.capable ? { capable: existing.capable } : {}),
        };
        const others = Object.keys(state.agents).filter((n) => n !== wanted);
        const first = others.length === 0;
        // §5's ask-at-startup + the standing problems a joiner can solve
        // unprompted: an open block someone new could clear should not wait
        // for the next block() to be noticed.
        const open = state.blocks.filter((b) => b.status === "open");
        return [
          `Registered as "${wanted}".`,
          others.length ? `Also active: ${others.join(", ")}.` : "No other agents are registered.",
          describeLock(state.lock),
          "Read board() before acting on any spec, and inbox() before touching git.",
          COST_RULES,
          // §5's ask-at-startup: the bus asks every joining agent what it can
          // grant, because a capability nobody declared is a solver nobody can
          // find when someone is blocked.
          `If you can grant anything to other agents (a local model, an API key, the tree, a skill), declare it once: capable(capabilities: ["…"]) — blocked agents are matched to you by it.` + (open.length
            ? `\nOpen blockers right now (${open.length}):\n` +
              open.map((b) => `  ${b.id} — ${b.by}: ${b.what} (needs: ${b.needed}) — unblock("${b.id}", "<what you did>") if you can help`).join("\n")
            : " No open blockers."),
          // The first agent on an install is the one whose human knows least;
          // point it at the taught rules explicitly rather than assuming.
          first
            ? "You are the first agent on this bus — board() is carrying the first-time rules; read them before acting."
            : "",
        ].filter(Boolean).join("\n");
      });
    }

    case "agents":
      return withState((state) => {
        pruneAgents(state);
        touch(state);
        const rows = Object.entries(state.agents).map(([n, a]) => {
          const mine = a.sessionKey === SESSION_KEY ? " (you)" : "";
          return `  ${n}${mine} — ${a.lane || "no lane stated"}\n    ${a.cwd}`;
        });
        return [
          rows.length ? "Active agents:\n" + rows.join("\n") : "No agents registered.",
          "",
          describeLock(state.lock),
        ].join("\n");
      });

    case "claim_tree": {
      const target = String(args.path || "").trim();
      const reason = String(args.reason || "").trim();
      if (!target) throw new Error("A path is required.");
      const minutes = Math.min(240, Math.max(1, Number(args.minutes) || 30));
      return withState((state) => {
        const me = requireName();
        touch(state);
        if (lockIsLive(state.lock) && state.lock.holder !== me) {
          // Refuse rather than steal. The holder may be mid-edit with
          // uncommitted work.
          throw new Error(
            `REFUSED — ${describeLock(state.lock)}\nAsk them with send(), or wait. Do not run checkout, stash or rebase there.`
          );
        }
        state.lock = {
          path: target,
          holder: me,
          holderPid: IS_CLI ? null : process.pid,
          reason,
          claimedAt: nowIso(),
          expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
        };
        return `Claimed ${target} for ${minutes} min — "${reason}". Call release_tree() as soon as you are done.`;
      });
    }

    case "release_tree":
      return withState((state) => {
        const me = requireName();
        touch(state);
        if (!lockIsLive(state.lock)) return "Nothing to release; the tree was already free.";
        if (state.lock.holder !== me) {
          throw new Error(`Not yours to release — ${describeLock(state.lock)}`);
        }
        const was = state.lock.path;
        state.lock = null;
        return `Released ${was}.`;
      });

    case "worktree": {
      // docs/worktree-verb.md. Refusals first — nothing runs until every
      // argument is well-formed.
      const name = String(args.name || "").trim();
      const from = args.from ? String(args.from).trim() : null;
      const branch = String(args.branch || "").trim() || `bus/${name}`;
      const wantKey = args.handoff ? String(args.handoff).trim() : null;
      const skipHandoff = Boolean(args.no_handoff);
      const minutes = Math.min(240, Math.max(1, Number(args.minutes) || 30));
      requireName();
      if (!WORKTREE_SLUG.test(name)) {
        throw new Error(
          `"${name}" is not a leaf slug (letters, digits, . _ -, at most 49 chars) — the name is a leaf; the bus owns the directory above it.`
        );
      }
      if (!worktreeRefOk(branch)) {
        throw new Error(
          `"${branch}" is not a branch name the verb accepts: no spaces, no leading dash, no "..", no ".lock" ending, no refs/ prefix.`
        );
      }
      if (from && !worktreeRefOk(from)) throw new Error(`"${from}" is not a ref the worktree verb accepts (same rule as a branch).`);
      const root = PROJECT_ROOT;
      if (!fs.existsSync(path.join(root, ".git"))) {
        throw new Error("Not a git repository — the worktree verb has nothing to branch. The bus still works here; trees do not.");
      }
      const treePath = path.join(worktreeBaseDir(root), name);
      const guarded = refuseBusSelfEdit(treePath, import.meta.dirname);
      if (guarded) throw new Error(guarded);
      if (fs.existsSync(treePath)) {
        throw new Error(`${treePath} already exists — if it is yours, claim it (claim_tree) and work there; no second tree is made.`);
      }
      const baseRef = worktreeBaseRef(root, from);
      const added = gitRun(["worktree", "add", "-b", branch, treePath, baseRef], root);
      if (added.status !== 0) {
        // git's own stderr, verbatim — the usual case is a name that already
        // exists as a branch, and git's message says so better than ours.
        throw new Error(`git worktree add failed: ${(added.stderr || added.error?.message || "unknown").trim()}`);
      }
      // Claim. A live claim elsewhere on the bus is a refusal, not a take —
      // but the tree is real now, so that outcome is stated, never hidden
      // (docs/worktree-verb.md: the one created-but-unclaimed case). The claim
      // targets the NEW path, so another tree's claim does not collide here;
      // withState's one-lock-per-bus does.
      let claimOut;
      try {
        claimOut = callTool("claim_tree", { path: treePath, reason: `worktree ${name}`, minutes });
      } catch (err) {
        claimOut = `The tree was created but is NOT claimed — ${err.message}`;
      }
      // Handoff. Exactly one on the board is taken deterministically; more
      // than one is never guessed between — the pick is the taker's.
      let handoffOut;
      if (skipHandoff) {
        handoffOut = "No handoff taken (--no-handoff).";
      } else if (wantKey) {
        try {
          handoffOut = callTool("handoff_take", { key: wantKey });
        } catch (err) {
          handoffOut = `Handoff not taken — ${err.message}`;
        }
      } else {
        // Untaken handoffs only, for the deterministic pick — one already
        // taken by a previous taker stays on the board until superseded, and
        // silently appending to its chain would be a guess. An explicit
        // --handoff can still take it (the chain is the audit).
        const keys = withState((state) =>
          Object.values(state.board || {})
            .filter((e) => e && e.kind === "handoff" && (e.taken?.length ?? 0) === 0)
            .map((e) => e.key)
        );
        if (keys.length === 0) {
          handoffOut = "No unclaimed handoff on the board to take.";
        } else if (keys.length > 1) {
          handoffOut = `More than one handoff on the board — none auto-taken. Pick one with --handoff:\n${keys.join("\n")}`;
        } else {
          try {
            handoffOut = callTool("handoff_take", { key: keys[0] });
          } catch (err) {
            handoffOut = `Handoff not taken — ${err.message}`;
          }
        }
      }
      return [
        claimOut,
        "",
        `tree:    ${treePath}`,
        `branch:  ${branch} (from ${baseRef})`,
        "",
        handoffOut,
        "",
        "Removing the tree is a person's `git worktree remove` — the bus never deletes.",
      ].join("\n");
    }

    case "send": {
      const to = String(args.to || "").trim();
      const text = cap(String(args.message || ""), MAX_MESSAGE_CHARS);
      if (!to || !text) throw new Error("Both `to` and `message` are required.");
      return withState((state) => {
        const me = requireName();
        touch(state);
        if (to !== "all" && !state.agents[to]) {
          throw new Error(
            `No agent named "${to}" is registered. Active: ${Object.keys(state.agents).join(", ") || "none"}.`
          );
        }
        state.messages.push({
          id: randomUUID(),
          from: me,
          to,
          text,
          at: nowIso(),
          readBy: [],
        });
        // Keep the log bounded; this is a bus, not an archive.
        if (state.messages.length > 500) state.messages = state.messages.slice(-500);
        return to === "all"
          ? "Broadcast sent. Agents see it when they next call inbox()."
          : `Sent to ${to}. They see it when they next call inbox().`;
      });
    }

    case "inbox":
      return withState((state) => {
        const me = requireName();
        touch(state);
        const includeRead = args.include_read === true;
        // Messages sent before you arrived are not yours. A broadcast is a
        // conversation, not a backlog — if a fact needs to reach whoever comes
        // next, it belongs on the board.
        const since = Date.parse(state.agents[me]?.registeredAt ?? 0);
        const mine = state.messages.filter(
          (m) =>
            (m.to === me || m.to === "all") &&
            m.from !== me &&
            Date.parse(m.at) >= since
        );
        const show = includeRead ? mine : mine.filter((m) => !m.readBy.includes(me));
        for (const m of mine) if (!m.readBy.includes(me)) m.readBy.push(me);
        if (!show.length) return "No new messages.";
        return show
          .map((m) => `[${m.at}] from ${m.from}${m.to === "all" ? " (broadcast)" : ""}:\n${m.text}`)
          .join("\n\n");
      });

    case "note": {
      const key = String(args.key || "").trim();
      const value = String(args.value || "").trim();
      if (!key || !value) throw new Error("Both `key` and `value` are required.");
      assertKey(key);
      return withState((state) => {
        const me = requireName();
        touch(state);
        const prior = state.board[key];
        if (prior) keepHistory(state, "archive", key, prior, me);
        state.board[key] = { value: cap(value, MAX_NOTE_CHARS), by: me, at: nowIso() };
        return prior
          ? `Updated "${key}" (was set by ${prior.by}; the old value is kept in history — history("${key}") reads it back).`
          : `Posted "${key}" to the board.`;
      });
    }

    // An agent reporting that it caught ITSELF being wrong. Separate from
    // `note` because the useful part is the pairing: what was asserted next to
    // what turned out to be true. A note saying "X is actually Y" tells the
    // next agent the answer; a miss tells it that this is a question worth
    // checking rather than recalling, which is the part that generalises.
    //
    // Detail is lost at every compaction while the SHAPE of a memory survives,
    // so a stale fact keeps its confident tone after it stops being true. That
    // is the failure this exists to make visible — see H13.
    case "miss": {
      const claimed = cap(String(args.claimed || "").trim(), MAX_NOTE_CHARS);
      const truth = cap(String(args.truth || "").trim(), MAX_NOTE_CHARS);
      const caught = cap(String(args.caught || "").trim(), MAX_NOTE_CHARS);
      if (!claimed || !truth) {
        throw new Error("Both `claimed` and `truth` are required — the pair is the record.");
      }
      return withState((state) => {
        const me = requireName();
        touch(state);
        // Keyed by subject, not by date: a mistake made twice should overwrite
        // its own entry and be visibly recurring, not scroll away as two notes.
        const slug = claimed
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .split("-")
          .slice(0, 6)
          .join("-") || "unnamed";
        const key = "miss-" + slug;
        const prior = state.board[key];
        const seen = (prior && prior.seen ? prior.seen : 0) + 1;
        // A recurring miss overwrites itself on purpose (the comment below);
        // keep each prior report so the recurrence is readable, not just
        // countable.
        if (prior) keepHistory(state, "archive", key, prior, me);
        const value = [
          "SELF-REPORTED MISS" + (seen > 1 ? " (" + seen + "x — RECURRING)" : "") + ".",
          "CLAIMED: " + claimed,
          "TRUE: " + truth,
          caught ? "CAUGHT BY: " + caught : "CAUGHT BY: not recorded.",
          "Check this rather than recall it.",
        ].join(" ");
        state.board[key] = { value, by: me, at: nowIso(), miss: true, seen };
        return seen > 1
          // "2th" undercuts a message whose whole job is to be taken seriously.
          ? `Filed "${key}" — reported ${seen} times now. This one is a pattern, not a slip.`
          : `Filed "${key}". Thank you for reporting it.`;
      });
    }

    // The bus is problem-shaped, not session-shaped — and that gap shows at
    // the END of a session, not the start. `note` captures facts, `miss`
    // captures corrections, `task_add` queues work, but nothing answered
    // "the conversation that was driving this just ended; here is the whole
    // state and where to resume." That knowledge either died with the session
    // or got re-invented per handoff as an out-of-band markdown file the next
    // agent only found by luck (the camera bench thread, 2026-09-14).
    //
    // The pairing mirrors `miss`: the write and the taking are different acts
    // by different agents, and a handoff nobody took is a rumor — the taken
    // chain is what turns "someone left state" into "someone resumed it".
    // renderHandoff/handoffKeyOf/handoffOpenItems/handoffLines live at module
    // scope (function declarations above the switch are hoisted); a const
    // between two cases would sit in its TDZ whenever control jumps straight
    // to one of these labels.
    case "handoff": {
      const summary = cap(String(args.summary || "").trim(), MAX_NOTE_CHARS);
      const nextStep = cap(String(args.nextStep || "").trim(), MAX_NOTE_CHARS);
      if (!summary || !nextStep) {
        throw new Error(
          "A handoff needs a `summary` (the verified state of the world) and a `nextStep` " +
          "(the ONE thing to do first) — without a next step this is a rumor, not a handoff."
        );
      }
      const key = handoffKeyOf(args);
      const at = nowIso();
      const entry = {
        kind: "handoff",
        key,
        summary,
        nextStep,
        open: handoffOpenItems(args.open),
        pointers: handoffLines(args.pointers, "pointers"),
        constraints: handoffLines(args.constraints, "constraints"),
        // `at` is the board's canonical field (status() sorts on it — a
        // handoff without it sorts as NaN and its skim line reads "unknown
        // ago"); `setAt` is the shape the hub page and the spec render from.
        // Same moment, two names, because the board schema is older.
        setAt: at,
        at,
        by: null,
        taken: [],
        value: null,
      };
      return withState((state) => {
        entry.by = requireName();
        touch(state);
        state.handoffs ||= {}; // states written before the verb have no history yet
        const prior = state.board[key];
        if (prior) {
          const history = state.handoffs[key] || [];
          history.unshift({ ...structuredClone(prior), supersededAt: nowIso(), supersededBy: entry.by });
          state.handoffs[key] = history.slice(0, 5);
        }
        // Cap the whole rendered entry at 4x a note: a handoff that cannot fit
        // that is four notes plus a pointer, not an error.
        entry.value = cap(renderHandoff(entry), MAX_NOTE_CHARS * 4);
        state.board[key] = entry;
        return prior
          ? `Replaced the handoff by ${prior.by} set at ${prior.at} — it is in history (entry 1). An agent overwriting an active handoff is doing something significant; ${entry.by === prior.by ? "yours was the one replaced." : "coordinate on the bus before superseding someone else's."}`
          : `Handoff posted under "${key}". handoff_take resumes it, on the record.`;
      });
    }
    case "handoff_take": {
      const key = handoffKeyOf(args);
      return withState((state) => {
        const me = requireName();
        touch(state);
        const entry = state.board[key];
        if (!entry || entry.kind !== "handoff") {
          const hist = (state.handoffs || {})[key];
          const newest = hist && hist.length ? hist[0] : null;
          throw new Error(
            newest
              ? `Nothing active under "${key}". The last one was set by ${newest.by} at ${newest.at} — that thread exists in history, and resuming it is your act: post a new handoff (or a note) once you know the state.`
              : `Nothing active under "${key}".`
          );
        }
        const at = nowIso();
        entry.taken.push({ by: me, at });
        entry.value = cap(renderHandoff(entry), MAX_NOTE_CHARS * 4);
        // Taking does NOT lock anything — two agents may both take one, and
        // the chain is the audit trail. Each taker sees the others in the
        // response: the feared failure is answered by the chain being
        // impossible to miss, not by a mutex that rots.
        const others = entry.taken.slice(0, -1);
        const lines = [entry.value, "", `Taken by ${me} at ${at}.`];
        for (const o of others) {
          lines.push(`Also taken by ${o.by} at ${o.at} — coordinate on the bus before you start.`);
        }
        return lines.join("\n");
      });
    }

    // §5's second half, in three verbs. capable() is the ask-at-startup — the
    // hub cannot match a blocker to a solver it never heard about. block() is
    // the stuck agent's report; the bus does the matching, the messaging and
    // the handing-back of banked fixes, so the person never relays "agent X
    // needs Y from agent Z". unblock() banks the fix on the board, which is
    // the part that makes the NEXT identical block cheap. The matching itself
    // (and the rules it follows) lives in blockers.mjs — pure, tested there.
    case "capable": {
      const caps = capableList(args.capabilities);
      return withState((state) => {
        const me = requireName();
        touch(state);
        const agent = state.agents[me];
        if (!agent) throw new Error("Register first — capable() attaches to your registration.");
        agent.capable = caps;
        return `Declared capabilities: ${caps.join(", ")}. Blocked agents reporting what they need will be matched against this.`;
      });
    }

    case "block": {
      const what = cap(String(args.what || "").trim(), MAX_NOTE_CHARS);
      const needed = cap(String(args.needed || "").trim(), MAX_NOTE_CHARS);
      if (!what || !needed) {
        throw new Error(
          "Both `what` and `needed` are required — what you are blocked on, and what would unblock it."
        );
      }
      return withState((state) => {
        const me = requireName();
        touch(state);
        state.blockSeq = (state.blockSeq ?? 0) + 1;
        const block = {
          id: `b${state.blockSeq}`,
          by: me,
          what,
          needed,
          status: "open",
          at: nowIso(),
          resolvedBy: null,
          resolution: null,
        };
        state.blocks.push(block);
        state.blocks = pruneBlocks(state.blocks);
        // Match against everyone registered, then step aside — the reporter
        // declaring 'ollama' should not get asked to grant their own ollama.
        const candidates = Object.entries(state.agents).map(([n, a]) => ({
          name: n,
          lane: a.lane,
          capable: a.capable,
        }));
        const matches = matchCapable(needed, candidates).filter((m) => m.name !== me);
        const boardEntries = Object.entries(state.board).map(([key, v]) => ({
          key,
          value: v.value,
          at: v.at,
        }));
        const fixes = matchFixes(what, needed, boardEntries);
        for (const m of matches) {
          state.messages.push({
            id: randomUUID(),
            from: me,
            to: m.name,
            text: cap(blockMessage(block, m), MAX_MESSAGE_CHARS),
            at: nowIso(),
            readBy: [],
          });
        }
        // Same bound as send: a bus, not an archive.
        if (state.messages.length > 500) state.messages = state.messages.slice(-500);
        return blockAnnounce(block, matches, fixes);
      });
    }

    case "unblock": {
      const id = String(args.id || "").trim();
      const how = cap(String(args.how || "").trim(), MAX_NOTE_CHARS);
      if (!id || !how) throw new Error("Both `id` and `how` are required — which blocker, and what worked.");
      return withState((state) => {
        const me = requireName();
        touch(state);
        const block = state.blocks.find((b) => b.id === id);
        if (!block) {
          const open = state.blocks.filter((b) => b.status === "open").map((b) => b.id);
          throw new Error(`No blocker "${id}". Open blockers: ${open.join(", ") || "none"}.`);
        }
        if (block.status !== "open") {
          return `Blocker ${id} was already resolved by ${block.resolvedBy}.`;
        }
        block.status = "resolved";
        block.resolvedBy = me;
        block.resolution = how;
        block.resolvedAt = nowIso();
        // The durable record is the BOARD note, not the log entry — pruneBlocks
        // drops resolved history eventually, and a fix that outlives its own
        // block is the entire point of banking it.
        const key = fixNoteKey(block.what);
        const prior = state.board[key];
        state.board[key] = {
          value: cap(
            `FIX for "${block.what}" — needed: ${block.needed}.\nWHAT WORKED: ${how}\nFirst reported by ${block.by}.`,
            MAX_NOTE_CHARS,
          ),
          by: me,
          at: nowIso(),
        };
        if (state.agents[block.by]) {
          state.messages.push({
            id: randomUUID(),
            from: me,
            to: block.by,
            text: cap(`${id} is unblocked: ${how}\nFull fix on the board under "${key}".`, MAX_MESSAGE_CHARS),
            at: nowIso(),
            readBy: [],
          });
          if (state.messages.length > 500) state.messages = state.messages.slice(-500);
        }
        state.blocks = pruneBlocks(state.blocks);
        const told = state.agents[block.by]
          ? `Reporter ${block.by} has been messaged.`
          : `Reporter ${block.by} is gone from the bus — the fix is on the board for whoever comes next.`;
        return `Unblocked ${id} — fix banked under "${key}"${prior ? " (updated the earlier fix for this shape)" : ""}. ${told}`;
      });
    }

    // The spine's Review stage, on the bus. A draft that was never reviewed
    // reads exactly like a good one in every other surface here — the verdict
    // has to be a stamped record, attributed, or review stays whatever the
    // last message claimed. Two refusals carry the point: there is nothing to
    // review until a task is finished, and the runner who produced a draft is
    // not its reviewer (the same never-self-match rule the blocker matcher has).
    case "review": {
      const taskId = String(args.task_id || "").trim();
      const verdict = String(args.verdict || "").trim().toLowerCase();
      const notes = cap(String(args.notes || "").trim(), MAX_NOTE_CHARS);
      if (!taskId) throw new Error("`task_id` is required — which task is this a verdict on?");
      if (!["approve", "changes"].includes(verdict)) {
        throw new Error('`verdict` is "approve" or "changes" — for changes, say what has to be different in notes.');
      }
      const me = requireName();
      return withState((state) => {
        touch(state);
        const task = (state.tasks ?? []).find((t) => t.id === taskId);
        if (!task) throw new Error(`No task "${taskId}". tasks() lists the queue.`);
        if (task.status === "queued" || task.status === "running") {
          throw new Error(`Task ${taskId} is ${task.status} — there is nothing to review yet.`);
        }
        if (task.runner === me) {
          throw new Error("You ran this task. Review is someone else's read of your work — that is the whole point of the surface.");
        }
        // A DRAFT task (status "draft", the steward's duty-3 brief) is
        // dispatched by approval, pre-dispatch: the orchestrator reads the
        // drafted brief and approves it into the queue. claimNextTask takes
        // "queued" only, so an unapproved draft is work no worker can touch.
        const dispatching = task.status === "draft" && verdict === "approve";
        task.reviews ??= [];
        task.reviews.push({ verdict, by: me, notes: notes || null, at: nowIso() });
        if (task.reviews.length > 10) task.reviews = task.reviews.slice(-10);
        if (dispatching) task.status = "queued";
        return `${verdict === "approve" ? "Approved" : "Changes requested on"} ${taskId}` +
          (dispatching ? " — draft brief approved, DISPATCHED to the queue" : "") +
          (notes ? ` — ${notes.slice(0, 200)}` : "") +
          ". The verdict is stamped on the task record.";
      });
    }

    // The other half of the draft gate, as its own verb. `review` is a VERDICT
    // on a finished draft; `apply` is the act of making a draft WORK — the
    // orchestrator read the brief and takes it into the queue, one word, on the
    // record. Scoped to status "draft" only, on purpose: a queued task already
    // IS work, and apply refusing everything else keeps it from becoming a
    // second claim path or a way to re-queue finished work. The dispatch still
    // lands on the task's review timeline (verdict "approve", via "apply") —
    // one timeline, not two. C4 is untouched: nothing calls this but a person
    // at a keyboard (or an agent they sent); the steward's ticks never do.
    case "apply": {
      const taskId = String(args.task_id || "").trim();
      const notes = cap(String(args.notes || "").trim(), MAX_NOTE_CHARS);
      if (!taskId) throw new Error("`task_id` is required — which draft becomes work?");
      const me = requireName();
      return withState((state) => {
        touch(state);
        const task = (state.tasks ?? []).find((t) => t.id === taskId);
        if (!task) throw new Error(`No task "${taskId}". tasks() lists the queue.`);
        if (task.status !== "draft") {
          throw new Error(
            `Task ${taskId} is ${task.status} — apply takes a DRAFT brief. ` +
              (task.status === "queued" || task.status === "running"
                ? "It is already work; claim hands it out."
                : task.status === "done"
                  ? "It already finished."
                  : "It failed — task it again instead of re-applying it.")
          );
        }
        task.reviews ??= [];
        task.reviews.push({ verdict: "approve", by: me, via: "apply", notes: notes || null, at: nowIso() });
        if (task.reviews.length > 10) task.reviews = task.reviews.slice(-10);
        task.status = "queued";
        return `Dispatched ${taskId} — the brief is work now, in the queue.` +
          (notes ? ` — ${notes.slice(0, 200)}` : "") +
          ` Applied by ${me}, on the record.`;
      });
    }

    // The spine's Publish stage, as a record. One entry per shipped build,
    // newest last, capped — a record you can read in one screen is the one
    // that gets read.
    case "publish": {
      const version = cap(String(args.version || "").trim(), 200);
      const what = cap(String(args.what || "").trim(), MAX_NOTE_CHARS);
      if (!version || !what) throw new Error("Both `version` and `what` are required — what to call it, and what went out.");
      const me = requireName();
      return withState((state) => {
        touch(state);
        state.publishes ??= [];
        state.publishes.push({ version, what, by: me, at: nowIso() });
        if (state.publishes.length > 20) state.publishes = state.publishes.slice(-20);
        return `Publish recorded: ${version} — ${what.slice(0, 120)}. ${state.publishes.length} in this space's record.`;
      });
    }

    // The cheapest way to be seen. An agent doing long local work between bus
    // calls fires this so the board keeps showing it. It mutates lastSeen,
    // which is the point — read verbs stay silent by design. registerCli is
    // the whole implementation: it re-announces (fresh pid) or first-announces
    // through the same door every registration walks.
    case "ping":
      if (!myName) throw new Error("No actor name — call register first.");
      registerCli(myName);
      return "Seen. The board shows you as of now.";

    // Everything at a glance. `agents` answers who is here and `board` answers
    // what they left behind; needing both to know the state of the bus is what
    // made it confusing to look at.
    // §1–3 of docs/recall-and-care.md. Read-only stack read: ACTIVE verbatim
    // (the board's value IS the rendered text for both kinds) plus every kept
    // prior entry, each named by who and when — both its writing and its
    // superseding. Two stores can hold history for one key (a note kept in
    // `archive` later replaced by a handoff, or the reverse); they are
    // rendered per store, never merged — merging would make "how far back
    // does this go" mean two different things in one answer.
    case "history": {
      const key = String(args.key || "").trim();
      if (!key) throw new Error("A `key` is required — the stack you mean is a named one.");
      assertKey(key);
      return withState((state) => {
        const active = state.board[key];
        const noteHist = state.archive?.[key] ?? [];
        const handoffHist = state.handoffs?.[key] ?? [];
        if (!active && !noteHist.length && !handoffHist.length) {
          return `Nothing was ever written under "${key}".`;
        }
        const lines = [];
        if (active) {
          lines.push(`ACTIVE — set ${active.at} by ${active.by}`, active.value);
        } else {
          lines.push("ACTIVE — gone. The newest kept entry names what this key last was.");
        }
        // Numbering matches the pages (handoffPageHtml's convention): #1 is
        // the OLDEST kept entry and the stack reads upward toward the live
        // one — the same data as the store's newest-first order, rendered in
        // the direction a reader moves (past → now).
        if (handoffHist.length) {
          lines.push("", `HANDOFF HISTORY (${handoffHist.length})`);
          const n = handoffHist.length;
          for (let i = n - 1; i >= 0; i--) {
            const h = handoffHist[i];
            lines.push(`#${n - i} — set ${h.at} by ${h.by}, superseded ${h.supersededAt} by ${h.supersededBy}`);
            lines.push(`  ${h.value}`);
          }
        }
        if (noteHist.length) {
          lines.push("", `NOTE HISTORY (${noteHist.length})`);
          const n = noteHist.length;
          for (let i = n - 1; i >= 0; i--) {
            const h = noteHist[i];
            lines.push(`#${n - i} — set ${h.at} by ${h.by}, superseded ${h.supersededAt} by ${h.supersededBy}`);
            lines.push(`  ${h.value}`);
          }
        }
        return lines.join("\n");
      });
    }

    case "search": {
      const query = String(args.query ?? "").trim();
      if (!query) {
        throw new Error("`query` is required — an empty search would read as \"everything is a match\".");
      }
      const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100));
      return withState((state) => {
        touch(state);
        const hits = searchBoard(state, query, limit);
        const scanned =
          Object.keys(state.board ?? {}).length +
          Object.values(state.handoffs ?? {}).reduce((n, h) => n + h.length, 0) +
          Object.values(state.archive ?? {}).reduce((n, h) => n + h.length, 0);
        if (!hits.length) {
          return `No matches for "${cap(query, 80)}" (scanned ${scanned} active and kept entries).`;
        }
        const lines = [`${hits.length} match(es) for "${cap(query, 80)}" (scanned ${scanned} active and kept entries):`];
        for (const h of hits) lines.push(`  ${h.where} — ${h.line}`);
        return lines.join("\n");
      });
    }

    case "health":
      // Same shape as `status`: a read that prunes first, so the answer is
      // about the bus as it is, not the bus as it was an hour ago.
      return withState((state) => {
        pruneAgents(state);
        touch(state);
        return renderHealth(state);
      });

    case "status":
      return withState((state) => {
        pruneAgents(state);
        touch(state);
        const now = Date.now();
        const ago = (iso) => {
          const secs = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
          if (secs < 60) return `${secs}s ago`;
          if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
          return `${Math.round(secs / 3600)}h ago`;
        };
        const agents = Object.entries(state.agents);
        const lines = ["CONNECTED"];
        if (!agents.length) {
          lines.push("  nobody — an agent appears here after its first bus command");
        } else {
          for (const [n, a] of agents) {
            const mine = a.sessionKey === SESSION_KEY ? "  <- you" : "";
            // lastSeen is refreshed by touch() on every bus call, and
            // pruneAgents drops anyone an hour cold (unless their process is
            // still running) — so this is the honest answer to "is that one
            // still there?" rather than a guess. "alive" is what the pid
            // check actually proves: the process exists right now. Only a
            // claimed task means "running" (dogfood report 2026-09-13 — the
            // dashboard badge read "running" over an empty queue).
            const seen = a.lastSeen ? ago(a.lastSeen) : "unknown";
            const heldTask = (state.tasks ?? []).find(
              (t) => t.status === "running" && t.runner === n
            );
            const state_ = heldTask ? ` · running ${heldTask.id}` : agentRunning(a) ? " · alive" : "";
            lines.push(`  ${n}${mine}`);
            lines.push(`     ${a.lane || "no lane stated"}`);
            lines.push(`     last seen ${seen}${state_}`);
          }
        }
        lines.push("", "WORKING TREE", "  " + describeLock(state.lock));
        const board = Object.entries(state.board).sort(
          (a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)
        );
        lines.push("", `BOARD (${board.length})`);
        if (!board.length) lines.push("  empty");
        for (const [k, v] of board) {
          // Keys and authors only. The values are paragraphs; `board` prints
          // those in full and this is meant to fit on one screen. A live
          // handoff is the one thing worth a marker here: a session ending
          // mid-task is invisible in keys-and-authors, and a resume that
          // never happens was what the verb exists to prevent.
          const marker = v.kind === "handoff" ? " · HANDOFF" : "";
          lines.push(`  ${k} — ${v.by}, ${ago(v.at)}${marker}`);
        }
        if (board.length) lines.push("", "  full text: node server.mjs board");
        // Blockers get their own section, not board keys: an OPEN block is not
        // a fact to remember, it is someone standing in a doorway right now.
        const blocks = state.blocks ?? [];
        const open = blocks.filter((b) => b.status === "open");
        const resolved = blocks.filter((b) => b.status !== "open");
        lines.push("", `BLOCKERS (${open.length} open / ${resolved.length} resolved)`);
        if (!blocks.length) lines.push("  none — declare capabilities with capable([...]) so future blocks can find you");
        for (const b of open) {
          lines.push(`  ${b.id} OPEN — ${b.by}: ${b.what}`);
          lines.push(`     needs: ${b.needed}`);
        }
        for (const b of resolved.slice(-3).reverse()) {
          lines.push(`  ${b.id} resolved by ${b.resolvedBy} — fix on board`);
        }
        return lines.join("\n");
      });

    case "task_add":
      if (args.role != null && !Object.hasOwn(ROLES, args.role)) {
        throw new Error(`Unknown role "${args.role}". The roles: ${Object.keys(ROLES).join(", ")}.`);
      }
      return withState((state) => {
        touch(state);
        state.tasks ||= [];
        // §5 recall-and-care — dependencies before anything else: a typo'd
        // dependency is refused NOW, with the known ids listed, not queued to
        // silently block forever.
        let dependsOn = null;
        if (args.depends_on != null) {
          if (!Array.isArray(args.depends_on)) {
            throw new Error("`depends_on` must be an array of task ids.");
          }
          const ids = [...new Set(args.depends_on.map((x) => String(x ?? "").trim()).filter(Boolean))];
          if (ids.length > 10) {
            throw new Error("More than 10 dependencies — that is a list, not a task. Split the work.");
          }
          const unknown = ids.filter((x) => !(state.tasks ?? []).some((t) => t.id === x));
          if (unknown.length) {
            const known = state.tasks.slice(-8).map((t) => t.id);
            throw new Error(
              `Unknown dependency id: ${unknown.join(", ")}. Known recent task ids: ${known.join(", ") || "none"}.` +
              " A dependency that silently never unlocks is a convention pretending to be data.",
            );
          }
          if (ids.length) dependsOn = ids;
        }
        const id = nextTaskId(state);
        state.tasks.push({
          id,
          lane: args.lane || "local",
          title: cap(args.title, MAX_TASK_TITLE_CHARS),
          prompt: cap(args.prompt, MAX_TASK_PROMPT_CHARS),
          status: "queued",
          runner_id: args.runner_id || null,
          role: args.role || null,
          // §0's fourth gap, closed: a stage is DATA, not a convention. An
          // unnamed one is fine — older queues and quick drafts carry none —
          // but a named one that matches no spine stage is refused, because a
          // typo'd tag that silently vanishes is a convention pretending to be data.
          stage: args.stage ? validateStage(args.stage) : null,
          depends_on: dependsOn,
          by: myName || "cli",
          at: nowIso(),
        });
        // Tasks accumulate forever otherwise: every finished one still rides
        // along in every state write. The last 100 finished tasks are history
        // enough — the queue is a queue, not an archive. The extra guard is
        // deliberate: ids come from taskSeq, which only ever climbs, but a
        // hand-edited state could collide — and this prune must never be able
        // to drop a live task no matter what it is handed.
        const finished = state.tasks.filter((t) => t.status !== "queued" && t.status !== "running");
        if (finished.length > 100) {
          const drop = new Set(finished.slice(0, finished.length - 100).map((t) => t.id));
          state.tasks = state.tasks.filter(
            (t) => !(drop.has(t.id) && t.status !== "queued" && t.status !== "running"),
          );
        }
        // §3 — answer "who gets this task" from the fleet's own record, but
        // ADVISE, never reassign: an unrunner_id'd task still goes to the
        // lane's default, and the suggestion is one line the queuer can pin
        // or ignore. Ignoring it is also data — the suggestion has not earned
        // trust yet.
        //
        // Roles are the exception: once a runner has a measured record, the bus
        // fills the task's role itself (routing.mjs pickForRole) and says who
        // and why. Rules then name roles, never anyone's models.
        let suggestion = "";
        if (!args.runner_id) {
          const role = inferRole(args);
          const pick = pickForRole(role, { prompt: args.prompt }, readRunners(), extractHistory(state.tasks));
          if (pick && !pick.cold) {
            Object.assign(state.tasks.find((t) => t.id === id), { runner_id: pick.id, role });
            suggestion = routedLine(pick);
          } else {
            const rec = recommendRunner({ prompt: args.prompt }, readRunners(), extractHistory(state.tasks));
            suggestion = suggestLine(rec);
          }
        }
        const depLine = dependsOn ? `\nBlocked until ${dependsOn.join(", ")} is done — unmet deps are never claimed.` : "";
        return `Queued ${id} on lane "${args.lane || "local"}": ${args.title}` + depLine + (suggestion ? `\n${suggestion}` : "");
      });

    case "runners": {
      // §3's record, attached to the list it is about: which AI suits which
      // task is answered from what actually happened, not the label. A runner
      // with no finished tasks says so — silence would read as a verdict.
      const verdicts = new Map(
        routingVerdicts(extractHistory(withState((state) => state.tasks ?? []))).map((v) => [v.id, v]),
      );
      return readRunners()
        .map((r) => {
          const v = verdicts.get(r.id);
          return `${r.enabled ? "  " : "x "}${r.id} — ${r.label ?? r.type}` +
            (r.note ? `\n     ${r.note}` : "") +
            (v ? `\n     record: ${v.line}` : "\n     record: none yet — no finished tasks");
        })
        .join("\n");
    }

    case "tasks":
      return withState((state) => {
        touch(state);
        const rows = (state.tasks ?? []).slice(-20).reverse();
        if (!rows.length) return "No tasks queued.";
        return rows
          .map((t) => {
            const head = `${t.id} [${t.status}] ${t.lane} — ${t.title}`;
            const deps = (t.depends_on ?? []).length ? ` · deps ${t.depends_on.join(", ")}` : "";
            const unmet = unmetDeps(state, t);
            const wait = unmet.length ? `\n  BLOCKED — waiting on ${unmet.join(", ")}` : "";
            return t.result ? `${head}${deps}${wait}\n  ${t.result.slice(0, 400)}` : `${head}${deps}${wait}`;
          })
          .join("\n");
      });

    case "board":
      return withState((state) => {
        touch(state);
        const entries = Object.entries(state.board).sort(
          (a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)
        );
        const body = entries.length
          ? entries.map(([k, v]) => `${k} — ${v.by}, ${v.at}\n  ${v.value}`).join("\n\n")
          : "The board is empty.";
        // A bus nobody has ever registered on is a fresh install — which means
        // this reader is very possibly an agent whose human just downloaded the
        // repo and knows nothing yet. The bus teaches its own rules here,
        // rather than hoping the person pasted the README into it. Once agents
        // exist the bus is lived-in and this stays out of the way.
        if (Object.keys(state.agents).length === 0) return `${ONBOARDING}\n\n${body}`;
        return body;
      });

    // §6 — the registry of app spaces this bus serves. The write verbs go
    // through withState() even though the registry is a separate file: the
    // state lock is the only serialization two concurrent project_add calls
    // would otherwise lose an entry through (read-modify-write, no lock).
    case "projects": {
      const entries = readRegistry(DIR);
      if (!entries.length) {
        return "No app spaces registered. project_add(name, root) registers one — it then gets its own board and queue on the hub (Spaces bar, ?p=<name>).";
      }
      return entries
        .map((e) => {
          const here = path.resolve(e.root) === PROJECT_ROOT ? " (this bus)" : "";
          const alive = fs.existsSync(e.root) ? "" : " — root missing on disk";
          return `${e.name} → ${e.root}${here}${alive}`;
        })
        .join("\n");
    }

    case "project_add": {
      const name = cleanName(args.name);
      const root = cleanRoot(args.root);
      withState(() => {
        writeRegistry(DIR, addProject(readRegistry(DIR), name, root));
      });
      // A project that vendored the bus keeps launching its own copy from its
      // own MCP config. That copy writes this space's state, so nothing looks
      // broken — until its sessions never show alive on the hub (2026-09-13).
      // Say it at registration, the one moment both paths are in hand.
      const vendored = path.join(root, "tools", "agent-bus", "server.mjs");
      const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
      const ownCopy =
        fs.existsSync(vendored) && fold(path.resolve(vendored)) !== fold(path.resolve(import.meta.filename));
      return (
        `Registered app space "${name}" → ${root}. The hub window lists it under Spaces (?p=${name}); it has its own board, lock, agents and queue.` +
        (ownCopy
          ? `\nHeads-up: ${root} has its own copy of the bus at ${vendored}. Sessions whose MCP config launches that copy can't show as alive here. ` +
            `Point them at ${path.resolve(import.meta.filename)} with AGENT_BUS_PROJECT=${root}, then restart them.`
          : "")
      );
    }

    case "project_remove": {
      const name = cleanName(args.name);
      const before = readRegistry(DIR);
      const next = removeProject(before, name);
      if (next.length === before.length) {
        throw new Error(`No app space named "${name}". ${callTool("projects", {})}`.trim());
      }
      withState(() => {
        writeRegistry(DIR, next);
      });
      return `Removed "${name}" from the registry. Its own bus (board, notes, lock) is untouched — only this registry forgets it.`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ── CLI mode ─────────────────────────────────────────────────────────────── */

// Anything that can run a command can join the bus — a PowerShell session, an
// ollama-driven script, a person at a terminal. Only Claude sessions speak MCP,
// and the whole point of a shared board is that it is shared.
//
//   node server.mjs board
//   node server.mjs agents
//   node server.mjs note <key> <value...>
//   node server.mjs send <to> <message...>
//   node server.mjs inbox <name>
//   node server.mjs claim <name> <path> <reason...>
//   node server.mjs release <name>
//
// A CLI caller is not a long-lived process, so it passes its name per command
// rather than registering once. Its claims carry no pid, which means they fall
// back to the TTL — a shell script cannot be probed for liveness the way a
// server process can.
/* ── the task queue ───────────────────────────────────────────────────────── */

// The board holds facts. This holds WORK — and something actually runs it.
//
// A queue nobody executes is a to-do list, which is what the board already was.
// `work` is the missing half: a loop that takes the next queued task for its
// lane, runs it, and writes the answer back where everyone can see it.
//
// LOCAL OUTPUT IS A DRAFT, NEVER A COMMIT. The runner posts text to the queue.
// It does not touch the repo, run git, or write a file into src/. That is not a
// limitation to be lifted later — an unreviewed model writing to a codebase is
// how you get plausible wrong code merged at 3am, and this project has already
// had one local-model draft with four defects in it.

const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
// A RUNNER id, not a model name — findRunner() matches on id. A model name once
// missed, fell through to "first enabled runner", and `work` silently ran
// whatever that was. No id is built in: the bus ships no one's models, so the
// default is the machine's — AGENT_BUS_RUNNER, else runners.json's "default",
// else its first enabled runner.
const DEFAULT_RUNNER = process.env.AGENT_BUS_RUNNER || null;

function nextTaskId(state) {
  state.taskSeq = (state.taskSeq ?? 0) + 1;
  return `t${state.taskSeq}`;
}

/**
 * The runners the bus may invoke, from runners.json beside this file, or the
 * file AGENT_BUS_RUNNERS names (the harnesses point it at a fixture, so they
 * never depend on this machine's list).
 *
 * runners.json is the machine's own and git ignores it: a tracked list shipped
 * one person's models to everyone who cloned the bus. runners.example.json is
 * the tracked template.
 *
 * Read fresh each time rather than cached: adding a model should take effect
 * on the next task, not on the next restart of a worker that has been up for
 * hours.
 *
 * Returns {runners, preferred, problem}. There is no fallback runner: the bus
 * has no model of its own to fall back to, and a guessed one would run a task
 * somewhere nobody chose. A missing or broken file is named instead.
 */
function loadRunners() {
  const file = process.env.AGENT_BUS_RUNNERS || new URL("./runners.json", import.meta.url);
  const where = process.env.AGENT_BUS_RUNNERS || "runners.json beside server.mjs";
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {
      runners: [],
      preferred: null,
      problem: `No ${where}. Copy runners.example.json to runners.json and fill in your models — \`server.mjs discover\` drafts entries for the servers on this machine.`,
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      runners: (parsed.runners ?? []).filter((r) => r && r.id && r.type),
      preferred: typeof parsed.default === "string" ? parsed.default : null,
      problem: null,
    };
  } catch (e) {
    return { runners: [], preferred: null, problem: `${where} is not valid JSON: ${e.message}` };
  }
}

function readRunners() {
  return loadRunners().runners;
}

function findRunner(id) {
  const { runners, preferred, problem } = loadRunners();
  if (problem) throw new Error(problem);
  const found =
    runners.find((r) => r.id === id) ?? runners.find((r) => r.id === preferred) ?? runners.find((r) => r.enabled);
  if (!found) throw new Error("No enabled runner in runners.json.");
  if (!found.enabled) {
    throw new Error(
      `Runner "${found.id}" is disabled in runners.json. ${found.note ?? ""}`.trim()
    );
  }
  return found;
}

/** Ask an ollama model over HTTP. Budgets and the window come from runner-limits. */
async function askOllama(runner, prompt, onProgress, sink) {
  const options = ollamaOptions(runner);
  // An IDLE watchdog. Streaming saved the headers timeout, but the stream is
  // only proof of life while bytes keep arriving: a body that stalls after the
  // headers — a cloud runner dropped mid-generation, ollama killed under
  // memory pressure — hung the worker lane FOREVER, the task reading
  // "running" on the dashboard while nothing moved. askShell's 10-minute
  // ceiling, applied to silence rather than duration: a thinking model can
  // legitimately stay quiet for minutes, but not ten.
  const IDLE_MS = 600_000;
  const abort = new AbortController();
  let lastByteAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > IDLE_MS) abort.abort();
  }, 5_000);
  let res;
  try {
    // STREAMED, and that is load-bearing. With stream:false ollama sends no
    // response headers until generation ENDS, and undici's 5-minute headers
    // timeout kills any run that thinks longer than that — a GLM call at its
    // full window died to it while the model was still doing exactly the work
    // it was asked for. A stream sends headers immediately and keeps the body
    // moving, so the only limit left is the model's own.
    res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: runner.model, prompt, stream: true, options }),
      signal: abort.signal,
    });
  } catch {
    throw new Error(`Cannot reach ollama at ${OLLAMA}. Is it running? (ollama serve)`);
  }
  if (!res.ok) throw new Error(`ollama returned ${res.status}. Is "${runner.model}" pulled?`);
  // Consumed chunk by chunk, not one res.text(): the same stream that saves the
  // headers timeout is also the only live signal a run gives off, and a caller
  // can watch it (onProgress) while it streams. Reassembled afterwards into one
  // synthetic body, so the empty-response handling below reads exactly like the
  // old non-streamed one.
  let response = "";
  let thinking = "";
  let last = null;
  let buf = "";
  const t0 = Date.now();
  const dec = new TextDecoder();
  const emit = () =>
    onProgress?.({
      thinkingChars: thinking.length,
      responseChars: response.length,
      elapsedMs: Date.now() - t0,
    });
  const takeLine = (line) => {
    if (!line.trim()) return;
    lastByteAt = Date.now();
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      return; // a torn final line means the stream was cut, not that the call failed
    }
    last = chunk;
    response += chunk.response ?? "";
    thinking += chunk.thinking ?? "";
    emit();
  };
  try {
    for await (const piece of res.body) {
      buf += dec.decode(piece, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        takeLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
  } catch (err) {
    // A watchdog abort is a RESULT — the queue gets the reason, the person
    // reading the hub sees why — not a crash of the lane.
    if (abort.signal.aborted) {
      throw new Error(
        `ollama stream stalled: no bytes for ${IDLE_MS / 60000} minutes (model ${runner.model})`
      );
    }
    throw err;
  } finally {
    clearInterval(watchdog);
  }
  buf += dec.decode(); // flush the decoder's held-back tail
  takeLine(buf);
  const body = last ?? {};
  // The model server reports what the run actually consumed. These counts are
  // exact — the only exact token numbers a local run ever produces — so they
  // are recorded when a sink is given (task runs record them on the task; the
  // bench does not, because it measures wall clock and chars, and the two
  // kinds are never added).
  if (sink && (Number(body.eval_count) || Number(body.prompt_eval_count))) {
    sink.usage = { prompt: Number(body.prompt_eval_count) || 0, output: Number(body.eval_count) || 0 };
  }
  const text = String(response ?? "").trim();
  if (text) return text;
  // Empty response means generation ended before the answer — a limit was hit
  // mid-thought. cutoffWhy names WHICH limit from done_reason and the counts,
  // because they look identical without it and three build tasks were "fixed"
  // by raising the wrong one (runner-limits.mjs header). The thinking that did
  // get out came back through the stream; hand it onward rather than dropping
  // it — a partial answer is worth more than "returned nothing".
  const why = cutoffWhy({
    doneReason: body.done_reason,
    evalCount: body.eval_count,
    numPredict: options.num_predict,
    numCtx: options.num_ctx,
    promptTokens: body.prompt_eval_count,
  });
  if (thinking.trim()) {
    return `[no final answer — ${why ?? "the model returned nothing"}. Its thinking so far:]

${thinking.trim()}`;
  }
  throw new Error(why ?? "The model returned nothing.");
}

/**
 * Ask an OpenAI-COMPATIBLE model server — the dialect LM Studio, llama.cpp,
 * vLLM and text-generation-webui all speak, and what `discover` finds. Not
 * the ollama dialect: a different endpoint (/chat/completions, not
 * /api/generate), a different stream format (SSE data: lines, not NDJSON),
 * and reasoning arriving in `reasoning_content` when the model thinks.
 *
 * STREAMED with the same idle watchdog as askOllama, for the same reason: a
 * non-streamed headers timeout kills any run that thinks past five minutes,
 * and the stream is the only live signal a run gives off.
 *
 * The URL is LOOPBACK-ONLY, and that is load-bearing. runners.json is
 * human-edited, but the hub can be told to run a declared runner by anything
 * that can write a task — so a runner entry doubles as the boundary of what
 * a task can reach, and that boundary is this machine. A baseUrl pointing
 * off-box is refused here, not at the network layer, because the error has
 * to name its cause where the person editing the file will read it.
 */
async function askOpenAI(runner, prompt, onProgress, sink) {
  if (!runner.baseUrl) throw new Error(`Runner "${runner.id}" has no baseUrl.`);
  const base = new URL(runner.baseUrl);
  assertLoopback(base.hostname);
  if (base.protocol !== "http:") {
    throw new Error(`Runner "${runner.id}": local model servers are plain http on loopback.`);
  }
  const IDLE_MS = 600_000;
  const abort = new AbortController();
  let lastByteAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastByteAt > IDLE_MS) abort.abort();
  }, 5_000);
  let res;
  try {
    res = await fetch(`${base.origin}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: runner.model,
        stream: true,
        temperature: 0.2,
        max_tokens: runner.predict || 4000,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: abort.signal,
    });
  } catch {
    throw new Error(`Cannot reach "${runner.baseUrl}". Is the server running? (find it with: server.mjs discover)`);
  }
  if (!res.ok) throw new Error(`"${runner.model}" answered ${res.status} on ${base.origin}. Is the model loaded?`);
  let content = "";
  let reasoning = "";
  let lastByteEmitted = 0;
  const t0 = Date.now();
  const dec = new TextDecoder();
  const emit = () =>
    onProgress?.({
      thinkingChars: reasoning.length,
      responseChars: content.length,
      elapsedMs: Date.now() - t0,
    });
  const takeLine = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return; // a torn line means the stream was cut, not that the call failed
    }
    lastByteAt = Date.now();
    const delta = chunk?.choices?.[0]?.delta ?? {};
    content += delta.content ?? "";
    reasoning += delta.reasoning_content ?? "";
    // The final chunk carries the usage block in the openai dialect. Exact
    // counts, same rule as the ollama side: recorded when a sink is given.
    if (sink && chunk?.usage) {
      sink.usage = { prompt: Number(chunk.usage.prompt_tokens) || 0, output: Number(chunk.usage.completion_tokens) || 0 };
    }
    if (content.length !== lastByteEmitted) {
      lastByteEmitted = content.length;
      emit();
    }
  };
  // buf lives OUTSIDE the loop: a data: line can split across network chunks,
  // and restarting the buffer per chunk would drop the seam.
  let buf = "";
  try {
    for await (const piece of res.body) {
      buf += dec.decode(piece, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        takeLine(buf.slice(0, nl).replace(/\r$/, ""));
        buf = buf.slice(nl + 1);
      }
    }
  } catch (err) {
    if (abort.signal.aborted) {
      throw new Error(
        `openai stream stalled: no bytes for ${IDLE_MS / 60000} minutes (model ${runner.model})`
      );
    }
    throw err;
  } finally {
    clearInterval(watchdog);
  }
  buf += dec.decode(); // flush the decoder's held-back tail
  takeLine(buf.replace(/\r$/, ""));
  const text = content.trim();
  if (text) return text;
  if (reasoning.trim()) {
    return `[no final answer — the model's output budget ran out mid-thought (max_tokens ${runner.predict || 4000}). Its reasoning so far:]

${reasoning.trim()}`;
  }
  throw new Error("The model returned nothing.");
}

/**
 * Run a command-line agent, prompt on stdin.
 *
 * spawn with an ARGUMENT LIST, never a joined string and never a shell. Nothing
 * in a prompt can then be read as an extra argument or a second command — and
 * prompts here are written by other agents, so that is not hypothetical.
 */
function askShell(runner, prompt, onProgress) {
  return import("node:child_process").then(
    ({ spawn }) =>
      new Promise((resolve, reject) => {
        const child = spawn(runner.command, runner.args ?? [], {
          cwd: PROJECT_ROOT,
          shell: false,
        });
        let out = "";
        let err = "";
        // A runaway runner can emit gigabytes. One megabyte is far past any
        // answer this protocol expects (edits are JSON arrays of find/replace
        // pairs) and the cap keeps a stuck process from eating the machine —
        // the answer that matters was already in the first megabyte.
        const MAX_SHELL_OUTPUT = 1024 * 1024;
        child.stdout.on("data", (c) => {
          if (out.length < MAX_SHELL_OUTPUT) {
            out += out.length + c.length > MAX_SHELL_OUTPUT
              ? c.slice(0, MAX_SHELL_OUTPUT - out.length)
              : c;
            if (out.length === MAX_SHELL_OUTPUT) out += "\n[truncated at 1MB — the runner kept emitting]";
          }
          onProgress?.({ thinkingChars: 0, responseChars: out.length, elapsedMs: 0 });
        });
        child.stderr.on("data", (c) => {
          if (err.length < 64 * 1024) err += c;
        });
        child.on("error", (e) =>
          reject(new Error(`Could not start "${runner.command}": ${e.message}`))
        );
        // A CLI agent that hangs waiting for input would hold the lane forever.
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Runner timed out after 10 minutes."));
        }, 10 * 60 * 1000);
        child.on("close", (code) => {
          clearTimeout(timer);
          const text = out.trim();
          if (code !== 0 && !text) {
            reject(new Error(`Exited ${code}. ${err.trim().slice(0, 400)}`));
            return;
          }
          if (!text) {
            reject(new Error("The runner produced no output."));
            return;
          }
          resolve(text);
        });
        child.stdin.write(prompt);
        child.stdin.end();
      })
  );
}

function askRunner(runner, prompt, onProgress, sink) {
  if (runner.type === "shell") return askShell(runner, prompt, onProgress);
  if (runner.type === "openai") return askOpenAI(runner, prompt, onProgress, sink);
  return askOllama(runner, prompt, onProgress, sink);
}

/**
 * Take the next queued task for a lane and mark it running, atomically.
 *
 * Claiming inside withState is what stops two runners taking the same task —
 * the same reason the working-tree lock exists. Returns null when the queue is
 * empty, which is the normal case and not an error.
 */
function claimNextTask(lane) {
  return withState((state) => {
    state.tasks ||= [];
    // A blocked task is never claimed — the skip reads in the task's own line
    // (tasks() renders BLOCKED), so it is a visible shape, not silent.
    const task = state.tasks.find(
      (t) => t.lane === lane && t.status === "queued" && !unmetDeps(state, t).length,
    );
    if (!task) {
      // An idle worker is still here — the empty poll is its heartbeat.
      // pruneAgents drops anyone an hour cold, and an idle worker polls
      // without claiming anything, so without this its lastSeen goes stale
      // while it is running: its name frees up, its registration vanishes
      // from the dashboard, and the tasks it finishes read as done by nobody.
      touch(state);
      return null;
    }
    task.status = "running";
    task.startedAt = nowIso();
    task.runner = myName || "worker";
    return { ...task };
  });
}

function finishTask(id, patch) {
  return withState((state) => {
    state.tasks ||= [];
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return null;
    // A model draft lands in the state file, so it rides every subsequent
    // write. A capped draft is still the whole answer the reviewer needs —
    // the full output belongs to the task page, not to every state write.
    if (typeof patch.result === "string") patch.result = cap(patch.result, MAX_TASK_RESULT_CHARS);
    Object.assign(task, patch, { doneAt: nowIso() });
    return { ...task };
  });
}

/**
 * A task that failed, or came back with no final answer, gets ONE more try on
 * the next runner its role would pick, never the one that just missed. Returns
 * {id, runner, why} for the queued retry, or null: not a miss, already a
 * retry, already retried, or no other runner eligible. A retry that misses is
 * left for a person — two runners missing the same prompt is about the prompt.
 */
function queueRetry(id) {
  return withState((state) => {
    state.tasks ||= [];
    const t = state.tasks.find((x) => x.id === id);
    if (!t || t.retryOf) return null;
    if (!(t.status === "failed" || (t.status === "done" && isEmptyAnswer(t.result)))) return null;
    if (state.tasks.some((x) => x.retryOf === id)) return null;
    const role = inferRole(t);
    const pick = pickForRole(role, t, readRunners(), extractHistory(state.tasks), [t.model, t.runner_id].filter(Boolean));
    if (!pick) return null;
    const nid = nextTaskId(state);
    state.tasks.push({
      id: nid,
      lane: t.lane,
      title: cap(`retry: ${t.title}`, MAX_TASK_TITLE_CHARS),
      prompt: t.prompt,
      status: "queued",
      runner_id: pick.id,
      role,
      retryOf: id,
      stage: t.stage ?? null,
      by: "retry",
      at: nowIso(),
    });
    return { id: nid, runner: pick.id, why: pick.why };
  });
}

/**
 * Update a task in place WITHOUT changing its status or stamping doneAt — the
 * progress beat. A running task that only ever reads as "running" is
 * indistinguishable from a hang; the worker streams what it has so far and this
 * lands it in state, where the dashboard can render an elapsed clock and a
 * thinking counter.
 */
function touchTask(id, patch) {
  return withState((state) => {
    state.tasks ||= [];
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return null;
    if (typeof patch.result === "string") patch.result = cap(patch.result, MAX_TASK_RESULT_CHARS);
    Object.assign(task, patch);
    return { ...task };
  });
}

/**
 * The runner. Polls for work in its lane, runs it, writes the answer back.
 *
 * Poll rather than push because the queue is a JSON file on disk — there is no
 * socket to subscribe to, and a five second poll on a local file costs nothing.
 */
async function runWorker(lane, runnerId) {
  const runner = findRunner(runnerId);
  process.stdout.write(`agent-bus worker: lane "${lane}", runner "${runner.id}" (${runner.label ?? runner.type})\n`);
  process.stdout.write(`ollama at ${OLLAMA}. Ctrl+C to stop.\n`);
  let idleLogged = false;
  for (;;) {
    const task = claimNextTask(lane);
    if (!task) {
      if (!idleLogged) {
        process.stdout.write("waiting for work...\n");
        idleLogged = true;
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    idleLogged = false;
    process.stdout.write(`\n[${task.id}] ${task.title}\n  running...\n`);
    // Live progress: generation streams; a 5s beat lands what has streamed so
    // far into state, where the dashboard renders it. Cleared on finish — a
    // done task has nothing in flight to report.
    const started = Date.now();
    const live = { thinkingChars: 0, responseChars: 0, at: 0 };
    const beat = setInterval(() => {
      if (!live.at) return; // nothing streamed yet — leave state alone
      touchTask(task.id, {
        progress: {
          thinkingChars: live.thinkingChars,
          responseChars: live.responseChars,
          elapsedMs: Date.now() - started,
        },
      });
    }, 5000);
    try {
      // A task may name its own runner; the worker's is the fallback.
      const chosen = task.runner_id ? findRunner(task.runner_id) : runner;
      // The usage sink: what this local run consumed, exactly, from the model
      // server's own counts — recorded on the task. A task that ran locally
      // for zero dollars is the token-savings record; the cloud equivalent a
      // session would have burned is what `bus cost` measures on transcripts.
      // The two numbers are different kinds and are never summed (D4).
      const sink = {};
      const answer = await askRunner(chosen, task.prompt, (p) => {
        Object.assign(live, p, { at: Date.now() });
      }, sink);
      clearInterval(beat);
      finishTask(task.id, { status: "done", result: answer, model: chosen.id, progress: null, usage: sink.usage ?? null });
      process.stdout.write(`  done (${answer.length} chars)\n`);
      const retry = isEmptyAnswer(answer) ? queueRetry(task.id) : null;
      if (retry) process.stdout.write(`  no final answer — retry ${retry.id} queued on ${retry.runner}\n`);
    } catch (err) {
      clearInterval(beat);
      // A failure is a RESULT, not a crash. It goes on the queue so the person
      // reading the hub sees why, instead of finding a task stuck on "running"
      // forever with no explanation.
      finishTask(task.id, { status: "failed", result: err.message, model: task.runner_id ?? runner.id, progress: null });
      process.stdout.write(`  failed: ${err.message}\n`);
      const retry = queueRetry(task.id);
      if (retry) process.stdout.write(`  retry ${retry.id} queued on ${retry.runner}\n`);
    }
  }
}

/**
 * §4 — the bench. ONLY runs when the user asks for it, and it runs by hand:
 * `server.mjs bench [runner-id ...] [--judge <id>] [--ask]`. It is CLI-only on
 * purpose, like discover and share — it spends real minutes of every named
 * model and, with --ask, sends a hardware summary to the judge. Neither is
 * something an agent should be able to trigger from a task.
 *
 * Candidates: the enabled runners named, or every enabled runner that is not
 * the judge. The judge (cloud by convention) is the reference baseline —
 * benchmarked too, but never ranked against the local candidates, because a
 * cloud model winning every row says nothing about any local choice.
 */
function benchHardware() {
  const hw = { ramTotal: 0, gpus: null };
  try {
    hw.ramTotal = os.totalmem();
  } catch {}
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 4000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    hw.gpus = out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [name, total] = l.split(",").map((s) => s.trim());
        return { name, total: Number(total) || 0 };
      });
  } catch {
    hw.gpus = null;
  }
  return hw;
}

async function runBench(opts) {
  const runners = readRunners().filter((r) => r.enabled);
  const judgeId = opts.judge ?? runners.find((r) => r.judge)?.id ?? null;
  const judgeRunner = judgeId ? runners.find((r) => r.id === judgeId) ?? findRunner(judgeId) : null;
  let candidates = opts.runners?.length
    ? opts.runners.map((id) => {
        const r = runners.find((x) => x.id === id);
        if (!r) throw new Error(`No enabled runner "${id}" in runners.json.`);
        return r;
      })
    : runners.filter((r) => r.id !== judgeId);
  if (judgeRunner) candidates = candidates.filter((r) => r.id !== judgeId);

  const runs = [];
  const answers = {}; // id -> [answer per prompt]
  for (const r of candidates) {
    answers[r.id] = [];
    for (const bp of BENCH_PROMPTS) {
      const t0 = Date.now();
      try {
        const text = await askRunner(r, bp.prompt, null);
        runs.push({ id: r.id, ok: true, elapsedMs: Date.now() - t0, chars: text.length });
        answers[r.id].push(text);
      } catch (err) {
        runs.push({ id: r.id, ok: false, elapsedMs: Date.now() - t0, chars: 0, error: err.message });
        answers[r.id].push(null);
      }
      process.stdout.write(`  benched ${r.id} / ${bp.id}\n`);
    }
  }

  // The judge scores every answer it was given. A failed candidate run has no
  // answer to score — its row already says why. A judge failure is recorded as
  // no-score, and an unscored candidate ranks last saying "unjudged" — silence
  // would read as a verdict.
  const scores = {};
  if (judgeRunner) {
    for (const [pi, bp] of BENCH_PROMPTS.entries()) {
      for (const r of candidates) {
        const answer = answers[r.id][pi];
        if (!answer) continue;
        try {
          const verdict = await askRunner(
            judgeRunner,
            `${JUDGE_INSTRUCTION}\n\nTHE PROMPT WAS:\n${bp.prompt}\n\nTHE ANSWER TO GRADE:\n${answer.slice(0, 6000)}`,
            null
          );
          const n = parseJudgeScore(verdict);
          (scores[r.id] ??= []).push(n);
          if (n == null)
            process.stdout.write(`  judge did not answer in format for ${r.id} / ${bp.id} — recorded as unjudged\n`);
        } catch (err) {
          // A judge failure leaves the candidate unscored; nulls are dropped by
          // scoreBench's row(), and an all-null candidate ranks last, unjudged.
          (scores[r.id] ??= []).push(null);
          process.stdout.write(`  judge failed on ${r.id} / ${bp.id}: ${err.message}\n`);
        }
      }
    }
  }

  const table = scoreBench({ runs, scores, referenceId: judgeId });
  // The delete advice names the model tag ollama knows, not the runner id —
  // rows carry the model so `ollama rm` deletes what is actually on disk.
  const modelById = new Map(candidates.map((r) => [r.id, r.model]));
  table.ranked.forEach((r) => { r.model = modelById.get(r.id) ?? null; });
  const prunes = pruneSuggestions(table.ranked);
  let qualify = null;
  if (opts.ask) {
    qualify = qualifiesForSuggestions(benchHardware());
    if (qualify.ok && judgeRunner) {
      // The cloud AI suggests what to TRY — never what to install. The bench
      // and the human do the deciding; this is one model's advice, printed.
      const advice = await askRunner(
        judgeRunner,
        "List 3-5 locally-downloadable open-weight models that would suit a machine described as: " +
          `${qualify.reason} Reply as plain lines 'model-name — one line why', nothing else. ` +
          "Only models actually downloadable from Hugging Face or ollama's library.",
        null
      ).catch((err) => `[the judge could not be asked: ${err.message}]`);
      table.advice = String(advice).trim();
    }
  }
  const out = renderBench(table, { prunes, qualify, judgeId });
  if (table.advice) out += `\n\nSUGGESTIONS FROM THE JUDGE (${judgeId}) — one model's advice, a bench is still the decider:\n${table.advice}`;
  return out;
}

function runCli(argv) {
  const [cmd, ...rest] = argv;
  const rest0 = rest;
  const say = (t) => { process.stdout.write(String(t) + "\n"); };
  try {
    switch (cmd) {
      // Spawned rather than imported, so a broken analyser can never stop the
      // bus itself from starting. Synchronous on purpose: the CLI calls
      // process.exit() the moment runCli returns, so anything async here would
      // be torn down before it produced a line.
      case "cost":
        execFileSync(
          process.execPath,
          // .cjs, not .mjs, so DeepSource can parse it. Reason on the file.
          [path.join(import.meta.dirname, "context-cost.cjs"), ...rest0],
          { stdio: "inherit" }
        );
        return;
      case "board":
        return say(callTool("board", {}));
      case "agents":
        return say(callTool("agents", {}));
      case "status":
        return say(callTool("status", {}));
      // A one-line "I am here" for an agent doing long local work: the
      // cheapest mutating call, so the board keeps showing you while you work.
      case "ping":
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("ping", {}));
      case "tasks":
        return say(callTool("tasks", {}));
      case "runners":
        return say(callTool("runners", {}));
      case "task": {
        // --stage consumes its value; everything else is the prompt. A bare
        // word after the prompt used to just join it, so a misspelled stage
        // silently became prompt text — the exact "convention pretending to
        // be data" the stage field exists to stop.
        let lane, title;
        const promptWords = [];
        let stage;
        const restArgs = rest0;
        for (let i = 0; i < restArgs.length; i++) {
          if (restArgs[i] === "--stage") stage = restArgs[++i];
          else if (lane === undefined) lane = restArgs[i];
          else if (title === undefined) title = restArgs[i];
          else promptWords.push(restArgs[i]);
        }
        myName = process.env.AGENT_BUS_NAME || "cli";
        return say(callTool("task_add", { lane, title, prompt: promptWords.join(" "), stage }));
      }
      case "work": {
        // Long-running, like dashboard.
        myName = process.env.AGENT_BUS_NAME || "worker";
        registerCli(myName);
        return runWorker(rest0[0] || "local", rest0[1] || DEFAULT_RUNNER);
      }
      case "dashboard":
        // The hub lives in hub.mjs and runs as a CHILD PROCESS, not here —
        // a render bug in the hub must never take down the bus (see the header).
        // Long-running, like the child: this process waits on it, and the exit
        // skip at the bottom keeps Node alive on the child's handle.
        {
          const child = spawn(
            process.execPath,
            [path.join(import.meta.dirname, "hub.mjs"), ...rest0],
            { stdio: "inherit" }
          );
          child.on("exit", (code) => { process.exitCode = code ?? 0; });
          return;
        }
      case "open": {
        // packaging.md item 2, as a verb. ONE HUB FIRST (the v0.1.2 twin-hub
        // rule): the target port — the argument, else 7777 like hub.mjs — is
        // PROBED before anything is spawned; a hub already answering there
        // (hub.mjs stamps every render with the hub-render marker, which is
        // the identity check) just gets a second window opened at it, and
        // the browser's own error-page case — a window pointed at a hub
        // that has not bound yet, where our 4s watcher is not and never
        // recovers — is avoided by opening the window only AFTER the port
        // answers. The port never comes from a bind-to-0 pick: a fresh free
        // port cannot see the running hub anywhere (a per-port check is the
        // only check), which is exactly the twin this verb could spawn.
        const arg = rest0.length ? Number(rest0[0]) : NaN;
        const port = Number.isInteger(arg) && arg > 0 && arg <= 65535 ? arg : 7777;
        const url = `http://127.0.0.1:${port}`;
        const hubUp = (cb) => {
          const req = http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
            res.setEncoding("utf8");
            let seen = "";
            const done = (yes) => { res.destroy(); cb(yes); };
            res.on("data", (c) => { seen += c; if (seen.includes('name="hub-render"')) done(true); });
            res.on("end", () => cb(seen.includes('name="hub-render"')));
          });
          req.setTimeout(2000, () => req.destroy());
          req.on("error", () => cb(false));
        };
        hubUp((already) => {
          if (already) {
            say(`agent-bus is already running at ${url} — one bus, one steward; pointing a window at it.`);
            openAppWindow(say, url);
            return;
          }
          say(`starting dashboard on ${url}...`);
          const child = spawn(
            process.execPath,
            [path.join(import.meta.dirname, "hub.mjs"), String(port)],
            { stdio: "inherit" }
          );
          child.on("exit", (code) => { process.exitCode = code ?? 0; });
          // The port must actually ANSWER before a window points at it.
          const start = Date.now();
          const tryOnce = () => {
            hubUp((up) => {
              if (up) openAppWindow(say, url);
              else if (Date.now() - start < 15000) setTimeout(tryOnce, 500);
              else say(`hub did not answer on ${url} within 15s — see its output above`);
            });
          };
          tryOnce();
        });
        return;
      }
      case "init": {
        // packaging.md item 5, as a verb. Registers the resolved project in
        // its .mcp.json — creating or MERGING (never clobbering another
        // server's entry, never overwriting an existing agent-bus entry),
        // atomically, printing exactly what it wrote. A filesystem op only:
        // no bus state is touched, so nothing here announces to the board.
        const projIdx = rest0.indexOf("--project");
        const flagRoot = projIdx >= 0 && rest0[projIdx + 1] ? path.resolve(rest0[projIdx + 1]) : null;
        const root = flagRoot ?? projectRoot();
        const file = path.join(root, ".mcp.json");
        let cfg = {};
        try {
          if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          throw new Error(
            `${file} is not valid JSON — refusing to merge; fix or move it first`
          );
        }
        if (!cfg || typeof cfg !== "object") cfg = {};
        cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === "object" ? cfg.mcpServers : {};
        if (cfg.mcpServers["agent-bus"]) {
          say(`${file} already registers agent-bus:`);
          say(JSON.stringify(cfg.mcpServers["agent-bus"], null, 2));
          return;
        }
        cfg.mcpServers["agent-bus"] = { command: "agent-bus", args: ["mcp"] };
        const tmp = file + ".init-tmp";
        if (fs.existsSync(file)) fs.copyFileSync(file, file + ".init-bak");
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
        fs.renameSync(tmp, file);
        say(`wrote ${file}:`);
        say(JSON.stringify({ mcpServers: { "agent-bus": cfg.mcpServers["agent-bus"] } }, null, 2));
        return;
      }
      case "note": {
        const [key, ...v] = rest;
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("note", { key, value: v.join(" ") }));
      }
      // bus miss "what I said" "what was true" "how it surfaced"
      // Three quoted arguments rather than a sentence: the pairing has to
      // survive being typed in a hurry, by an agent that has just discovered
      // it was wrong and would rather move on.
      case "miss": {
        const [claimed, truth, ...c] = rest;
        myName = process.env.AGENT_BUS_NAME || "cli";
        return say(callTool("miss", { claimed, truth, caught: c.join(" ") }));
      }
      // The end of a session, from a shell. The --open/--pointers/--constraints
      // arrays read a JSON array from a file — one flag per read beats a giant
      // inline JSON blob typed on a shell line, and an unknown flag is refused
      // rather than ignored, because a constraint that silently vanished would
      // be the worst possible way for this verb to fail.
      case "handoff": {
        const opt = {};
        for (let i = 0; i < rest0.length; i++) {
          const flag = rest0[i];
          const valueFlag = flag === "--summary" || flag === "--next" || flag === "--key";
          const fileFlag = flag === "--open" || flag === "--pointers" || flag === "--constraints";
          if (!valueFlag && !fileFlag) {
            throw new Error(
              `Unknown flag "${flag}". The flags: --summary, --next, --key (values); ` +
              "--open, --pointers, --constraints (each reads a JSON array from a file)."
            );
          }
          opt[flag.slice(2)] = fileFlag
            ? JSON.parse(fs.readFileSync(rest0[++i], "utf8"))
            : rest0[++i];
        }
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("handoff", {
          summary: opt.summary,
          nextStep: opt.next,
          key: opt.key,
          open: opt.open,
          pointers: opt.pointers,
          constraints: opt.constraints,
        }));
      }
      // The resuming act, from a shell — same refusal as MCP when there is
      // nothing active; the taken chain answers "who has been here".
      case "handoff-take": {
        const idx = rest0.indexOf("--key");
        const key = idx >= 0 ? rest0[idx + 1] : undefined;
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("handoff_take", { key }));
      }
      // Read the stack under a key from a shell — the superseded facts are
      // kept on purpose; this is how a shell-only agent checks instead of
      // recalls.
      case "history": {
        const [key] = rest0;
        if (!key) throw new Error("usage: server.mjs history <key> — the board key to read the stack under");
        return say(callTool("history", { key }));
      }
      // Board search from a shell. Quotes the query; extra words all count.
      case "search": {
        const q = rest.join(" ");
        if (!q.trim()) throw new Error('usage: server.mjs search "<text to find>"');
        return say(callTool("search", { query: q }));
      }
      // The bus checks itself from a shell — the same contract the caretaker
      // runs every poll, on demand.
      case "health":
        return say(callTool("health", {}));
      // The spine's Review stage from a shell — same verdict, same refusals.
      case "review": {
        const [taskId, verdict, ...n] = rest;
        myName = process.env.AGENT_BUS_NAME || "cli";
        return say(callTool("review", { task_id: taskId, verdict, notes: n.join(" ") }));
      }
      // The draft gate from a shell — one word: this brief becomes work.
      case "apply": {
        const [taskId, ...n] = rest;
        myName = process.env.AGENT_BUS_NAME || "cli";
        return say(callTool("apply", { task_id: taskId, notes: n.join(" ") }));
      }
      // The spine's Publish stage from a shell.
      case "publish": {
        const [version, ...w] = rest;
        myName = process.env.AGENT_BUS_NAME || "cli";
        return say(callTool("publish", { version, what: w.join(" ") }));
      }
      // §5's second half from a shell — the same three verbs an MCP session
      // gets, for the agents that only speak CLI (GLM and friends).
      case "capable": {
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        if (!rest.length) throw new Error('usage: server.mjs capable <capability> [more...] — e.g. capable ollama stripe');
        return say(callTool("capable", { capabilities: rest }));
      }
      case "block": {
        const [what, needed, ...extra] = rest;
        if (!what || !needed) throw new Error('usage: server.mjs block "<what blocks you>" "<what you need>"');
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("block", { what, needed: [needed, ...extra].join(" ") }));
      }
      case "unblock": {
        const [id, ...h] = rest;
        if (!id || !h.length) throw new Error('usage: server.mjs unblock <blocker-id> "<what worked>"');
        myName = process.env.AGENT_BUS_NAME || "cli";
        return say(callTool("unblock", { id, how: h.join(" ") }));
      }
      // §6 from a shell — register the app spaces the hub serves. The hub
      // window offers each under its Spaces bar (?p=<name>).
      case "projects":
        return say(callTool("projects", {}));
      case "project_add": {
        const [name, root] = rest0;
        if (!name || !root) throw new Error("usage: server.mjs project_add <name> <root-path>");
        return say(callTool("project_add", { name, root }));
      }
      case "project_remove": {
        const [name] = rest0;
        if (!name) throw new Error("usage: server.mjs project_remove <name>");
        return say(callTool("project_remove", { name }));
      }
      case "send": {
        const [to, ...v] = rest;
        myName = process.env.AGENT_BUS_NAME || "cli";
        return say(callTool("send", { to, message: v.join(" ") }));
      }
      case "inbox": {
        myName = rest[0] || process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        return say(callTool("inbox", {}));
      }
      case "claim": {
        const [name, target, ...v] = rest;
        myName = name;
        registerCli(myName);
        return say(callTool("claim_tree", { path: target, reason: v.join(" ") }));
      }
      case "release": {
        myName = rest[0];
        return say(callTool("release_tree", {}));
      }
      case "worktree": {
        // docs/worktree-verb.md — tree + claim + handoff in one call. Flags
        // consume their values, index-parsed like --stage; filtering them
        // out wholesale leaked a flag's VALUE into the positionals once and
        // ran live (the bench --judge lesson).
        const opts = {};
        const words = [];
        for (let i = 0; i < rest0.length; i++) {
          const f = rest0[i];
          if (f === "--from") opts.from = rest0[++i];
          else if (f === "--branch") opts.branch = rest0[++i];
          else if (f === "--handoff") opts.handoff = rest0[++i];
          else if (f === "--minutes") opts.minutes = Number(rest0[++i]);
          else if (f === "--no-handoff") opts.no_handoff = true;
          else words.push(f);
        }
        myName = process.env.AGENT_BUS_NAME || "cli";
        registerCli(myName);
        opts.name = words[0];
        return say(callTool("worktree", opts));
      }
      // Opt-in sharing with other installs. NOTHING is sent: the note is
      // scrubbed to problem-shape locally, the draft is printed, and the human
      // decides — by opening a prefilled issue URL — whether this machine's
      // facts are fit to travel. Opt-in means a person, not a setting.
      case "share": {
        const key = rest0[0];
        if (!key) throw new Error("usage: server.mjs share <board-key>");
        const note = withState((state) => state.board[key]);
        if (!note) throw new Error(`No board note "${key}". Run "server.mjs board" to list the keys.`);
        const lesson = buildLesson(key, note, path.basename(PROJECT_ROOT));
        say([
          "LESSON DRAFT — scrubbed to problem-shape. READ IT BEFORE SUBMITTING:",
          "the scrub is mechanical and can miss; you are the only gate between",
          "this machine's facts and a public issue. Do not submit if a real name,",
          "path or fact of yours survived it.",
          "",
          JSON.stringify(lesson, null, 2),
          "",
          "Submit by opening this URL (prefilled; nothing was sent):",
          buildIssueUrl(lesson),
        ].join("\n"));
        return;
      }
      // Fetch the published lessons feed. Deliberately NOT an MCP tool: this
      // text is written by strangers, and an agent that pulls it unprompted is
      // ingesting untrusted instructions. A human runs this, reads it, and
      // alone decides whether any lesson becomes a rulebook rule.
      case "lessons":
        fetchFeed()
          .then((feed) => say(renderFeed(feed)))
          .catch((err) => {
            process.stderr.write(String(err.message || err) + "\n");
            process.exitCode = 1;
          })
          // A beat before exit, not exit-in-finally: the fetch's sockets are
          // mid-close at that instant, and process.exit() there trips a libuv
          // assertion on Windows (the same race the hub's harness documents).
          .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));
        return;
      // Probe this machine for local model servers. Human-only like share and
      // lessons — discovery drafts runner entries, and the hub can only run
      // what runners.json declares, so an agent running this could neither add
      // nor enable anything. Still CLI-only: the agents do not need it, and a
      // verb that scans ports belongs to the person who owns the ports.
      case "discover":
        discoverLocal()
          .then((findings) => {
            say(renderDiscover(findings, buildRunnerDrafts(findings)));
          })
          .catch((err) => {
            process.stderr.write(String(err.message || err) + "\n");
            process.exitCode = 1;
          })
          .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));
        return;
      // §4 — the bench. Human-run by hand, never agent-triggerable: it costs
      // real minutes of every named model, and --ask sends a hardware summary
      // to the cloud judge. Only on the user's ask is the roadmap's hard gate.
      case "bench": {
        // Flags parsed positionally, and a flag's VALUE is consumed — a naive
        // "drop everything starting with --" let the judge's id leak
        // into the runner ids, where it was then filtered out as the judge:
        // zero candidates, an empty bench, no error. This bug ran live.
        const ids = [];
        let judge;
        let ask = false;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--judge") judge = rest[++i];
          else if (rest[i] === "--ask") ask = true;
          else ids.push(rest[i]);
        }
        runBench({ runners: ids, judge, ask })
          .then((out) => say(out))
          .catch((err) => {
            process.stderr.write(String(err.message || err) + "\n");
            process.exitCode = 1;
          })
          .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));
        return;
      }
      case "mcp": {
        // packaging.md item 3: the no-argument behavior, named — one
        // implementation, this same function.
        startServerStdio();
        return;
      }
      default:
        printHelp(say);
        process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(String(err.message || err) + "\n");
    process.exitCode = 1;
  }
}

// The verb list, one line each — the single copy (the default case and the
// bare-TTY invocation both render it; the READMEs carry prose, not a second
// table to drift).
function printHelp(say) {
  say("agent-bus — usage:");
  say("  dashboard [port] | work [lane] [runner] | task <lane> <title> <prompt>");
  say("  tasks | runners | status | board | agents | note <key> <value> | send <to> <msg>");
  say("  cost [--full]   where the tokens actually went");
  say("  inbox <name> | claim <name> <path> <reason> | release <name>");
  say("  capable <cap> [more] | block <what> <needed> | unblock <id> <how>");
  say("                      declare grants / report a blocker / bank the fix");
  say("  share <board-key>   draft a lesson from a note, for a human to submit");
  say("  lessons             read lessons published by other installs (untrusted)");
  say("  discover            probe this machine for local model servers (drafts runners.json entries)");
  say("  bench [id ...] [--judge <id>] [--ask]");
  say("                      run the enabled local runners against fixed prompts; only on your ask");
  say("  review <task-id> <approve|changes> [notes]");
  say("                      stamp a review verdict on a finished draft");
  say("  apply <task-id> [notes]");
  say("                      turn a DRAFT brief into queued work (the dispatch)");
  say("  publish <version> <what...>");
  say("                      record that a build shipped");
  say("  projects | project_add <name> <root> | project_remove <name>");
  say("                      the app spaces this bus serves (hub Spaces bar)");
  say("  open [port]         the dashboard, plus its own chromeless window");
  say("  worktree <name> [--from ref] [--branch b] [--handoff key] [--no-handoff]");
  say("                      a lane's first move in one call: tree + claim + the handoff");
  say("  init [--project <root>]");
  say("                      register the project in its .mcp.json (merge, never clobber)");
  say("  mcp                 force the stdio MCP server (the no-argument behavior, named)");
  say("");
  say("Set AGENT_BUS_NAME to avoid passing your name each time.");
}

// The window is sugar, not the product (packaging.md item 2): with no
// chrome-family browser we degrade to printing the URL in whatever the
// default browser opener is, and the dashboard itself is unaffected either
// way. Chrome/Edge because Safari and Firefox have no --app=.
function openAppWindow(say, url) {
  const pf = process.env["ProgramFiles"] || "";
  const pf86 = process.env["ProgramFiles(x86)"] || "";
  const chromeCandidates =
    process.platform === "win32"
      ? [
          path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
          path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
          path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["google-chrome", "chromium", "chromium-browser"];
  const found =
    process.platform === "linux"
      ? // PATH candidates: probing with --version is the portable existence
        // check (fs.existsSync does not resolve bare names on PATH).
        chromeCandidates.find((c) => {
          try {
            return !spawnSync(c, ["--version"], { stdio: "ignore" }).error;
          } catch {
            return false;
          }
        })
      : chromeCandidates.find((p) => p && fs.existsSync(p));
  if (found) {
    say(`opening ${url} in ${process.platform === "linux" ? found : path.basename(found)}`);
    spawn(found, [`--app=${url}`, "--window-size=480,780"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }
  // No chrome family: the platform's default-opener, still detached.
  say(`no app-mode browser found — opening ${url} in the default browser`);
  spawn(
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open",
    process.platform === "win32" ? ["/c", "start", "", url] : [url],
    { detached: true, stdio: "ignore" }
  ).unref();
}

// A CLI invocation is a fresh process every time, so it re-announces itself
// rather than holding a registration.
function registerCli(name) {
  // The dashboard hands an actor name here unchecked, so this is the same
  // door the MCP register walks through: `__proto__` as a name would set the
  // state object's prototype instead of a registration, and a 4,000-char
  // name would bloat every state write. assertName does both.
  name = assertName(name);
  withState((state) => {
    const prior = state.agents[name];
    state.agents[name] = {
      sessionKey: prior?.sessionKey ?? SESSION_KEY,
      lane: prior?.lane ?? "cli",
      cwd: process.cwd(),
      // The pid lets the dashboard show "running" for a long-lived process
      // without any heartbeat; for a one-shot CLI command it dies with the
      // command and the card falls back to lastSeen. host keeps a foreign
      // machine's pid from being checked against this machine's process table.
      pid: process.pid,
      host: os.hostname(),
      registeredAt: prior?.registeredAt ?? nowIso(),
      lastSeen: nowIso(),
      // Same rule as the MCP register: a re-announced CLI actor keeps the
      // capabilities it declared, or every capable() would evaporate on the
      // next one-shot shell command.
      ...(prior?.capable ? { capable: prior.capable } : {}),
    };
  });
}

// The bus's public surface — what hub.mjs imports. The hub is a separate
// process (spawned by the dashboard verb, never imported here); these are the
// pieces it needs to render state, run actions and start workers.
export {
  DIR,
  PROJECT_ROOT,
  packageDocsDir,
  projectDocsDir,
  packageDocsDir as docsDir, // deprecated alias — the hub's learning, not project docs
  agentRunning,
  asActor,
  askRunner,
  callTool,
  claimNextTask,
  describeLock,
  finishTask,
  queueRetry,
  findRunner,
  touchTask,
  lockIsLive,
  pruneAgents,
  readRunners,
  readStateForRoot,
  readStages,
  registerCli,
  withState,
};

// True only when THIS file is the entrypoint. hub.mjs imports this module for
// the surface above, and an import must neither start a CLI nor a stdio server.
const IS_MAIN = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

if (IS_MAIN && process.argv.length > 2) {
  IS_CLI = true;
  runCli(process.argv.slice(2));
  // Every verb here is one-shot and exits — except `dashboard`, which waits on
  // its child process, `open` (same child, plus a window), `mcp` (the stdio
  // server itself), `work`, which loops, and `lessons`, whose fetch settles
  // async and exits itself. Exiting on any of those would tear it down before
  // the first result, so they opt out and Node stays alive.
  if (!["dashboard", "open", "mcp", "work", "lessons", "discover", "bench"].includes(process.argv[2])) {
    process.exit(process.exitCode ?? 0);
  }
}

/* ── JSON-RPC over stdio ──────────────────────────────────────────────────── */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  const { id, method, params } = req;
  // Notifications have no id and must not be answered.
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      return write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "agent-bus", version: VERSION },
        },
      });
    }
    if (method === "notifications/initialized" || method === "initialized") return;
    if (method === "tools/list") {
      return write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }
    if (method === "tools/call") {
      const text = callTool(params?.name, params?.arguments ?? {});
      return write({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(text) }] },
      });
    }
    if (method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
    if (isNotification) return;
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
  } catch (err) {
    if (isNotification) return;
    // Tool failures come back as content with isError, not as protocol errors —
    // a refused lock is a normal outcome the agent should read and act on.
    if (method === "tools/call") {
      return write({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: String(err.message || err) }], isError: true },
      });
    }
    write({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err.message || err) } });
  }
}

// The stdio loop and the exit handlers run only when this file IS the
// entrypoint, via startServerStdio. An import — hub.mjs is the only one —
// must not touch stdin or install process handlers here.
function startServerStdio() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue; // Not our problem to fix; skip the malformed line.
      }
      handle(req);
    }
  });

  // Release the lock on the way out so a clean exit never leaves the tree claimed.
  const releaseOnExit = () => {
    try {
      if (!myName) return;
      withState((state) => {
        if (state.lock && state.lock.holder === myName) state.lock = null;
      });
    } catch {
      /* best effort — the TTL covers us */
    }
  };
  process.on("exit", releaseOnExit);
  process.on("SIGINT", () => { releaseOnExit(); process.exit(0); });
  process.on("SIGTERM", () => { releaseOnExit(); process.exit(0); });
  process.stdin.on("end", () => { releaseOnExit(); process.exit(0); });
}

// BARE INVOCATION RULE (packaging.md item 3): an MCP client spawns this
// binary with piped (non-TTY) stdin — start the stdio server, unchanged. A
// human who types it in a terminal has a TTY, and used to see the binary
// "hang" on a quiet stdin; show them the verb list instead.
if (IS_MAIN && process.argv.length <= 2) {
  if (process.stdin.isTTY) {
    printHelp((t) => process.stdout.write(t + "\n"));
    process.exit(0);
  }
  startServerStdio();
}
