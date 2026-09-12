// The hub agent — phase 0: the deterministic body.
//
// The hub is itself an agent — it asks
// agents at startup what tools they have and what unlocks they need, answers
// reported blocks with fixes the fleet already saved, and keeps the workflow
// moving without the person repeating themselves.
//
// PHASE 0 DELIBERATELY HAS NO MODEL. Every behavior here is lookup or
// composition over state the bus already holds — the board, the rulebook, the
// agent list. That is the token rule applied to the hub itself: an answer the
// board already contains should not be paid for a second time. The seam for a
// brain later is the `classify` → "other" path below; phase 1 wires a runner
// there, behind config, per HUB_AGENT_MODEL.
//
// Nothing auto-applies (rulebook C4): the hub replies, points, and files — it
// never edits a file, runs git, or rewrites another agent's board entry.
//
// Live run:      node tools/agent-bus/agent.mjs
// One poll, out: node tools/agent-bus/agent.mjs --once   (the e2e uses this)
// Config:        HUB_AGENT_NAME (default "hub"), HUB_AGENT_POLL_MS (default 5000),
//                HUB_AGENT_WATCH_MS (default 300000, 0 disables the token watch)
//                — the same AGENT_BUS_PROJECT / AGENT_BUS_DOCS_DIR seams the
//                bus itself uses; importing server.mjs inherits them.

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  withState,
  asActor,
  callTool,
  docsDir,
  describeLock,
  pruneAgents,
  registerCli,
} from "./server.mjs";
import { LIVE_MS, readSessions } from "./sessions.mjs";
import { dueForNudge } from "./token-watch.mjs";

const NAME = process.env.HUB_AGENT_NAME || "hub";
const POLL_MS = Math.max(500, Number(process.env.HUB_AGENT_POLL_MS) || 5000);

// What the hub agent can actually grant, declared through §5's capable() —
// the hub eating its own cooking. Keyword words, because that is what
// block() matches on.
const HUB_CAPABLE = [
  "runners", "runner-drafts", "discover", "board", "notes",
  "tasks", "queue", "tree", "lock", "context-cost",
];

// How often the token watch actually looks at the transcripts. The poll runs
// every five seconds and a full scan on this machine is 110 MB; doing that
// every poll would make the hub the most expensive thing in the room, which is
// a poor advertisement for a token watch. Five minutes is far inside the
// ninety-minute liveness window, so nothing live is missed. 0 turns the watch
// off, which is what a deterministic e2e run wants.
const WATCH_MS =
  process.env.HUB_AGENT_WATCH_MS === undefined
    ? 300_000
    : Math.max(0, Number(process.env.HUB_AGENT_WATCH_MS) || 0);

// Say it once per session per half hour. A note that reappears every poll is a
// note nobody reads, and compacting takes a while to actually happen.
const RENUDGE_MS = 30 * 60 * 1000;
let lastWatchAt = 0;

/* ── text matching — pure, no I/O, no state ──────────────────────────────── */

// Small on purpose: every stopword is a word that carries no meaning for
// matching, and each one added is a word that can no longer accidentally
// match a fix. Anything under 3 characters is dropped with them.
const STOPWORDS = new Set(
  ("the a an and or for with that this from was were has have had are is be been being " +
    "you your yours its it i me my we our not but can will would could should may might " +
    "what when where why how who whom which all any out has had get got one two than then " +
    "them they there their about into over under after before again more most just like " +
    "only some such very same per via off too also own did does doing")
  // "down" is deliberately NOT a stopword: "the classifier went down" is
  // block-report vocabulary, and matching it matters.
    .split(" ")
);

export function tokenize(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  );
}

/**
 * The rulebook's learned memory, parsed. Same section/rule shape hub.mjs
 * renders — the rules live in `### G1. Title` blocks with body text that
 * carries the **Why:** and the **Incident:**, and it is the incident text
 * that matches a fresh block report: the rule was written FROM one.
 */
export function parseRulebook(markdown) {
  const rules = [];
  const lines = String(markdown).split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const head = line.match(/^###\s+([A-Z]\d+)\.\s+(.+)$/);
    if (head) {
      if (current) rules.push(current);
      current = { id: head[1], title: head[2].trim(), body: [] };
      continue;
    }
    // A `##` group heading ends the rule we were inside.
    if (current && /^##\s/.test(line)) {
      rules.push(current);
      current = null;
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) rules.push(current);
  return rules.map((r) => ({ ...r, body: r.body.join("\n").trim() }));
}

/**
 * One searchable candidate per fact the hub holds: rulebook rules plus every
 * board note. Built fresh per poll — the board changes under us and a stale
 * index would answer with facts that were corrected meanwhile.
 */
export function buildFixIndex({ board, rules }) {
  const index = [];
  for (const [key, note] of Object.entries(board ?? {})) {
    index.push({
      id: key,
      kind: "board",
      title: key,
      text: `${key} ${note?.value ?? ""}`,
      at: note?.at ?? "",
    });
  }
  for (const rule of rules ?? []) {
    index.push({
      id: rule.id,
      kind: "rule",
      title: rule.title,
      text: `${rule.id} ${rule.title} ${rule.body}`,
      at: "",
    });
  }
  return index;
}

/** Distinct tokens the message and a candidate share — the whole score. */
export function scoreFix(messageTokens, candidateText) {
  let n = 0;
  for (const token of tokenize(candidateText)) {
    if (messageTokens.has(token)) n++;
  }
  return n;
}

/**
 * The fixes earlier agents saved, best first.
 *
 * minScore 2: one shared word is coincidence ("test" matches half the
 * rulebook); two distinct shared words is a real overlap. Sorted by score,
 * then newest first, capped at `limit`.
 */
export function findFixes(message, index, { limit = 3, minScore = 2 } = {}) {
  const messageTokens = tokenize(message);
  const scored = index
    .map((candidate) => ({ ...candidate, score: scoreFix(messageTokens, candidate.text) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score || (b.at > a.at ? 1 : -1));
  return scored.slice(0, limit);
}

/* ── message classification — pure ───────────────────────────────────────── */

// What a block report reads like (G2's input). Deliberately a substring match
// on stems, not a grammar: reports come from different models in different
// voices, and the cost of a false positive is one helpful reply, while the
// cost of a miss is an agent stalled with no answer.
// Word-boundary prefixes, precompiled: a bare substring match put "lock"
// inside "unlocks" and mis-filed a registry answer as a status question.
const BLOCK_RE = /\b(block|stall|denied|refus|stuck|failing|failed|cannot|can't|can´t|unblock|error|outage|down)/;
const STATUS_RE = /\b(status|next|handoff|who|lock|claim|board)/;

export function classify(text) {
  const lower = String(text).toLowerCase();
  // Block first: a status question is mis-answered politely, but a block
  // report mis-routed to a status dump leaves the agent stalled with no
  // fix. "the lock was refused" is a block even though it says "lock".
  if (BLOCK_RE.test(lower)) return "block";
  if (STATUS_RE.test(lower)) return "status";
  return "other";
}

/* ── the three deterministic answers — pure over state ───────────────────── */

/** A block report comes back with the fixes earlier agents saved. */
export function fixReply(message, index) {
  const fixes = findFixes(message, index);
  if (!fixes.length) {
    return (
      "No fix for this is saved yet. Post what happened and why as a board note " +
      "(a key like `block-<topic>`) — that is how the next agent that hits it " +
      "finds your answer instead of re-producing the stall."
    );
  }
  const lines = fixes.map((f) =>
    f.kind === "rule"
      ? `• rule ${f.id} — ${f.title}`
      : `• board note \`${f.id}\` — ${String(f.title).slice(0, 80)}`
  );
  return (
    "Fixes earlier agents saved for this:\n" +
    lines.join("\n") +
    "\n(full text on the board" +
    (fixes.some((f) => f.kind === "rule") ? " and in the rulebook" : "") +
    ")"
  );
}

/**
 * A status question is answered from state as-is — composed here, NOT via
 * callTool("status"): dispatch already runs inside withState, and callTool
 * would try to take the state file lock again and deadlock on itself.
 * Pure over the passed state for the same reason.
 */
export function statusAnswer(state) {
  const ago = (iso) => {
    const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso ?? 0)) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    return `${Math.round(secs / 3600)}h ago`;
  };
  const agents = Object.entries(state.agents ?? {});
  const board = Object.entries(state.board ?? {}).sort(
    (a, b) => Date.parse(b[1]?.at ?? 0) - Date.parse(a[1]?.at ?? 0)
  );
  const queued = (state.tasks ?? []).filter((t) => t.status === "queued").length;
  const lines = [`HUB STATUS — ${agents.length} agent(s), ${board.length} board note(s), ${queued} queued task(s)`];
  for (const [n, a] of agents) lines.push(`  ${n} — ${a.lane || "no lane stated"}, seen ${ago(a.lastSeen)}`);
  if (!agents.length) lines.push("  nobody registered");
  lines.push("", "WORKING TREE", "  " + describeLock(state.lock));
  lines.push("", `BOARD (${board.length})`);
  if (!board.length) lines.push("  empty");
  for (const [k, v] of board) lines.push(`  ${k} — ${v.by}, ${ago(v.at)}`);
  return lines.join("\n");
}

/** The startup question (roadmap §5): every new agent is asked this once. */
export function registryQuestionText(agent) {
  return (
    `${agent} — the hub asks every agent at startup: what tools do you have, ` +
    "and what unlocks do you need? Reply and I will file your answer on the " +
    "board as `registry-<your-name>`, so a blocker can be matched to the " +
    "agent that can grant it instead of stalling."
  );
}

export const REGISTRY_KEY_PREFIX = "registry-";
export function registryKeyFor(agent) {
  return REGISTRY_KEY_PREFIX + agent;
}

/* ── dispatch — pure: given one message and state, what does the hub do? ─── */

/**
 * Returns { reply, note } — `reply` is sent back to the sender (null = stay
 * quiet), `note` is a {key, value} to post on the board (registry answers).
 * The brain seam is the `other` branch: phase 1 decides there whether a model
 * is worth the tokens for this message.
 */
export function dispatch(text, index, state) {
  const kind = classify(text);
  if (kind === "block") return { reply: fixReply(text, index), note: null };
  if (kind === "status") return { reply: statusAnswer(state), note: null };
  return { reply: null, note: null };
}

/* ── the body ────────────────────────────────────────────────────────────── */

// Who has been greeted with the startup question lives on the BUS, not in
// this process's memory: a hub agent that restarts must not lose track, and
// an e2e run drives the agent one poll per process. state.hubGreeted carries
// it; state.board[registry-<name>] carries the answers.

function fixIndex() {
  let rules = [];
  try {
    rules = parseRulebook(fs.readFileSync(docsDir() + "/build-rules.md", "utf8"));
  } catch {
    /* no rulebook where the seam says it lives — the board alone still works */
  }
  return withState((state) => buildFixIndex({ board: state.board, rules }));
}

/**
 * File a board note for every live session that has already passed break-even.
 *
 * IT FILES AND STOPS (C4). The hub does not compact anything and does not tell
 * anyone they must — it puts the measurement where whoever is in that session
 * will see it, and they decide.
 *
 * WHY THE BOARD AND NOT A MESSAGE (F2). The advice is "summarise this
 * conversation", and a message lives inside the conversation being summarised:
 * taking the advice destroys the advice. A board note survives it.
 *
 * WHY IT IS NOT ADDRESSED TO AN AGENT (C1). Nothing joins a bus registration to
 * a transcript file. Guessing which agent owns 1653e46f would put a wrong name
 * on a correct measurement, so the note is keyed by session and unaddressed.
 */
export function noteExpensiveSessions(log) {
  if (!WATCH_MS) return;
  const now = Date.now();
  if (now - lastWatchAt < WATCH_MS) return;
  lastWatchAt = now;

  let rows;
  try {
    rows = readSessions().rows;
  } catch {
    return; // no transcripts on this machine is a fact, not an error (D3)
  }

  // One withState for the whole batch: the cooldown is read and written in the
  // same pass, so two polls racing cannot both decide a note is due.
  withState((state) => {
    state.hubContextSeen ||= {};
    const due = dueForNudge(rows, state.hubContextSeen, {
      now,
      liveMs: LIVE_MS,
      renudgeMs: RENUDGE_MS,
    });
    for (const d of due) {
      state.hubContextSeen[d.key] = new Date().toISOString();
      state.board[d.key] = {
        value: d.line + " (session " + d.id + ", " + d.turns + " turns)",
        by: NAME,
        at: new Date().toISOString(),
      };
      log.push("filed " + d.key + " on the board");
    }
  });
}

/** One poll cycle. Returns a log string; the loop and --once both call it. */
export function pollOnce() {
  const log = [];

  // Greet the newly arrived before anything else — the startup question (§5)
  // goes out the moment an agent appears. "New" is decided on the bus, not in
  // memory: an agent is greeted when it registered after the hub itself did,
  // and not before — agents already here when the hub starts are not new, and
  // registerCli preserves the hub's original registeredAt across restarts, so
  // a restart does not re-greet the whole bus (only anyone who answered
  // nothing yet, which is the registry wanting their answer).
  const index = fixIndex();
  withState((state) => {
    pruneAgents(state);
    state.hubGreeted ||= {};
    const hubRegistered = Date.parse(state.agents[NAME]?.registeredAt ?? 0);
    for (const [agent, a] of Object.entries(state.agents)) {
      if (agent === NAME) continue;
      if (state.hubGreeted[agent]) continue;
      if (state.board[registryKeyFor(agent)]) continue; // already answered
      if (Date.parse(a.registeredAt ?? 0) < hubRegistered) continue;
      state.hubGreeted[agent] = true;
      state.messages.push({
        id: randomUUID(),
        from: NAME,
        to: agent,
        text: registryQuestionText(agent),
        at: new Date().toISOString(),
        readBy: [],
      });
      log.push(`greeted ${agent} with the startup question`);
    }
  });

  // Read the hub's inbox, dispatch each message.
  withState((state) => {
    const since = Date.parse(state.agents[NAME]?.registeredAt ?? 0);
    const mine = state.messages.filter(
      (m) =>
        (m.to === NAME || m.to === "all") &&
        m.from !== NAME &&
        Date.parse(m.at) >= since &&
        !m.readBy.includes(NAME)
    );
    if (!mine.length) return;
    for (const m of mine) m.readBy.push(NAME);

    for (const m of mine) {
      const outcome = dispatch(m.text, index, state);
      if (outcome.reply) {
        state.messages.push({
          id: randomUUID(),
          from: NAME,
          to: m.from === "human" ? "all" : m.from,
          text: outcome.reply,
          at: new Date().toISOString(),
          readBy: [],
        });
        log.push(`replied to ${m.from}`);
      } else {
        // Unanswered and neither a block nor a status question: if this agent
        // was greeted with the startup question, this IS the registry answer.
        // File it — that is the whole point of the registry. (Noise risk is
        // accepted: a chatty message from a greeted agent files one note, and
        // the agent can overwrite its own registry entry.)
        const key = registryKeyFor(m.from);
        if (state.hubGreeted?.[m.from] && classify(m.text) === "other" && !state.board[key]) {
          state.board[key] = { value: m.text, by: NAME, at: new Date().toISOString() };
          log.push(`filed ${key} on the board`);
        }
      }
    }
  });

  // Last, because it is advice about the conversation rather than traffic in
  // it: everything above answers somebody, this only measures.
  noteExpensiveSessions(log);

  return log.length ? log.join("\n") : null;
}

function main() {
  // Re-announce on every start, the CLI's way: registerCli keeps a prior
  // registration's registeredAt, so messages sent while the hub agent was
  // down still land in its inbox on the next poll.
  registerCli(NAME);
  // Eat the hub's own cooking — §5's capable() declared by the hub itself.
  asActor(NAME, () => callTool("capable", { capabilities: HUB_CAPABLE }));
  process.stdout.write(`agent-bus hub agent: registered as "${NAME}". Polling every ${POLL_MS}ms. Ctrl+C to stop.\n`);
  for (;;) {
    try {
      const log = pollOnce();
      if (log) process.stdout.write(log + "\n");
    } catch (err) {
      // A failure is logged, not fatal — the bus outliving a buggy reply is
      // the same principle that spawned hub.mjs as a child process.
      process.stderr.write(`hub agent: ${err.message || err}\n`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
}

const IS_MAIN = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
);

if (IS_MAIN) {
  if (process.argv[2] === "--once") {
    // Same re-announcement the live loop does, so one-shot runs (the e2e)
    // keep the prior registration's registeredAt and inbox semantics — and
    // the same declared capabilities, so a one-shot hub agent is still the
    // solver it always is.
    registerCli(NAME);
    asActor(NAME, () => callTool("capable", { capabilities: HUB_CAPABLE }));
    const log = pollOnce();
    process.stdout.write((log ?? "(quiet)") + "\n");
  } else {
    main();
  }
}