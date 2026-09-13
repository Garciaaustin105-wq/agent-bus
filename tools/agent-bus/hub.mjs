#!/usr/bin/env node
// The hub — the command centre window for the agent bus.
//
// SPLIT OUT OF server.mjs (stage 0, spec-hub-projects-and-routing.md). server.mjs
// keeps the bus: state, lock, MCP and the worker engine. This file owns
// everything a PERSON looks at: the dashboard page, its HTTP server, the
// workers started from the window, and the written-to-disk page snapshot.
//
// SPAWNED, NOT IMPORTED — same reasoning as context-cost.cjs. server.mjs is run
// once per Claude session as an MCP server, and a render bug in this file used
// to throw inside that process: every session in the repo loses its tool list
// at once. `server.mjs dashboard` now spawns this file as a child process, so
// the hub can die alone and the bus keeps answering.
//
// One dependency direction: this file imports the bus's exported surface from
// server.mjs. server.mjs never imports this file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { LIVE_MS, readSessions } from "./sessions.mjs";
import { extractHistory, routingVerdicts } from "./routing.mjs";
import { pathToFileURL } from "node:url";
import {
  DIR,
  PROJECT_ROOT,
  docsDir,
  agentRunning,
  askRunner,
  asActor,
  callTool,
  claimNextTask,
  describeLock,
  finishTask,
  findRunner,
  lockIsLive,
  pruneAgents,
  readRunners,
  readStateForRoot,
  readStages,
  registerCli,
  withState,
} from "./server.mjs";
import { readRegistry, resolveProject } from "./projects.mjs";

const STATE = path.join(DIR, "state.json");
// Lives beside the state, not in the repo tree: it is generated, per-machine,
// and nobody should be tempted to commit it.
const STATUS_PAGE = path.join(DIR, "status.html");

/* ── spaces: the app projects this hub serves (roadmap §6) ────────────────── */

// One board for everything was a transition shape. The registry (projects.json
// beside the state, inside .git — real paths, so never committed) names the app
// roots this hub builds; ?p=<name> switches the window to that app's bus. The
// hub's OWN space stays the home of the cross-app facts — the rulebook, the
// how-we-work model, the context budget — which is why those panels below
// render from the hub even when the window is looking at another app.
function currentProject(sel) {
  const proj = resolveProject(readRegistry(DIR), sel, PROJECT_ROOT);
  if (proj) return proj;
  return { name: null, root: PROJECT_ROOT, own: true, unknown: sel || null };
}

// The state a view renders. Own → through withState(), exactly as before.
// Another space → a read-only read of THAT project's bus; a root with no bus
// yet (or a file mid-write) reads as an empty one, and the next refresh — the
// page is re-rendered per request — picks the project's bus up the moment it
// exists.
function stateFor(proj) {
  if (proj.own) return withState((s) => s);
  return readStateForRoot(proj.root) ?? { ...EMPTY_STATE };
}

// THE PER-APP HEALTH STRIP — the workflow spine's gap 3. A hub serving several
// app spaces has to answer "is anything stuck over there?" without opening each
// one. The numbers are computed from the space's own state: queue depth, what is
// running, tasks done but never reviewed (review debt — done is not finished),
// open blockers, and how long since anything happened. Read-only, computed per
// render; a space with no bus yet reads as quiet, not broken.
function healthOf(state) {
  const tasks = state.tasks ?? [];
  const last = [
    ...tasks.map((t) => t.doneAt || t.startedAt || t.at),
    ...(state.messages ?? []).map((m) => m.at),
    ...Object.values(state.board ?? {}).map((v) => v?.at),
  ]
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  return {
    queued: tasks.filter((t) => t.status === "queued").length,
    running: tasks.filter((t) => t.status === "running").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    reviewDebt: tasks.filter((t) => t.status === "done" && !(t.reviews ?? []).length).length,
    blocked: (state.blocks ?? []).filter((b) => b.status === "open").length,
    last,
  };
}

const agoStr = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const healthStr = (h) =>
  !h.last && !h.queued && !h.running
    ? "quiet"
    : [
        `${h.queued} queued`,
        `${h.running} running`,
        `${h.reviewDebt} awaiting review`,
        h.failed ? `${h.failed} failed` : null,
        h.blocked ? `${h.blocked} blocked` : null,
        h.last ? `last ${agoStr(h.last)}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

function spacesHtml(proj) {
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  const links = readRegistry(DIR)
    .map((e) => {
      const here = !proj.own && proj.name === e.name;
      const strip = healthStr(healthOf(readStateForRoot(e.root) ?? {}));
      return `<a href="/?p=${encodeURIComponent(e.name)}"${here ? ' style="font-weight:700"' : ""}>${esc(e.name)}</a> <span class="mut">(${esc(strip)})</span>`;
    })
    .join(" · ");
  const own = proj.own
    ? "<b>this hub</b>"
    : `<a href="/">this hub</a>`;
  return `<div class="mut" style="padding:0 0 8px 0">Spaces: ${own}${links ? " · " + links : ""}${
    proj.own && proj.unknown
      ? ` — no space named "${esc(proj.unknown)}"; showing this hub`
      : ""
  }</div>`;
}

/* ── the page snapshot ────────────────────────────────────────────────────── */

// THE PAGE, as a file rather than a server.
//
// Written beside the state so a browser tab left open on
// .git/agent-bus/status.html stays current with no command to run. Read-only:
// a file:// page has nothing to POST to, so the action forms are omitted rather
// than rendered dead.
//
// This file owns the snapshot's freshness: a watcher on the state file re-renders
// it whenever any process — MCP session, CLI call, this window — changes the bus.
// (Before the split this write happened inside withState() in server.mjs, which
// put render code in the MCP server; that is the failure mode this split removes.)
function writeStatusPage(state) {
  try {
    const tmp = `${STATUS_PAGE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, renderStatusHtml(state, { interactive: false }));
    fs.renameSync(tmp, STATUS_PAGE);
  } catch {
    // Never let the page break the bus. A failed write here is cosmetic; the
    // tools agents depend on must still return.
  }
}

let lastSeenMtimeMs = 0;

function refreshPage(force = false) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(STATE).mtimeMs;
  } catch {
    return; // no state yet — nothing to render
  }
  if (!force && mtimeMs === lastSeenMtimeMs) return;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return; // mid-rename or corrupt — the next tick re-renders
  }
  if (!state || typeof state !== "object") return;
  lastSeenMtimeMs = mtimeMs;
  writeStatusPage(state);
}

/* ── docs, read live ──────────────────────────────────────────────────────── */

/**
 * The build rules, read from docs/build-rules.md at render time.
 *
 * NOT copied into this file. The rules change as incidents happen — they are up
 * to 26 and were 12 — and a hub showing a stale copy of the rules would be
 * exactly the failure the rules exist to prevent. Where they live is
 * docsDir()'s answer (the project root's docs/ unless AGENT_BUS_DOCS_DIR
 * says otherwise).
 */
function readBuildRules() {
  try {
    const md = fs.readFileSync(path.join(docsDir(), "build-rules.md"), "utf8");
    const groups = [];
    let current = null;
    for (const raw of md.split("\n")) {
      const line = raw.trim();
      // "## A. The shape of the work" — a group.
      const head = line.match(/^##\s+[A-Z]\.\s+(.+)$/);
      if (head) {
        current = { title: head[1], rules: [] };
        groups.push(current);
        continue;
      }
      // "### A1. Contract, then harness, then UI. In that order."
      const rule = line.match(/^###\s+([A-Z]\d+)\.\s+(.+)$/);
      if (rule && current) current.rules.push({ n: rule[1], text: rule[2] });
    }
    return groups.filter((g) => g.rules.length);
  } catch {
    return [];
  }
}

/**
 * The operating model, read from docs/how-we-work.md at render time.
 *
 * Live for the same reason the rules are: this describes how work is actually
 * split between the orchestrator, the implementing agents and the person, and a
 * hub showing last month's version of that is worse than showing none.
 * Sections are "## Heading" with "- " bullets under them.
 */
function readWorkflow() {
  try {
    const md = fs.readFileSync(path.join(docsDir(), "how-we-work.md"), "utf8");
    const groups = [];
    let current = null;
    for (const raw of md.split("\n")) {
      const line = raw.trim();
      const head = line.match(/^##\s+(.+)$/);
      if (head) {
        current = { title: head[1], items: [] };
        groups.push(current);
        continue;
      }
      const item = line.match(/^-\s+(.+)$/);
      if (item && current) current.items.push(item[1]);
    }
    return groups.filter((g) => g.items.length);
  } catch {
    return [];
  }
}

/**
 * The workflow spine (roadmap §0's research output), read live from
 * docs/workflow-spine.md — the ten stages every app passes through, with, for
 * each, what it produces and the part a human-only team does that a fleet
 * must cover another way. Live for the same reason the rules are: the spine
 * is where later lanes hang, and a stale copy of it in the hub would be the
 * exact failure the hub exists to prevent. Only "## N. Stage" sections with
 * `- **key:**` bullets parse — the essay and the gap list below them render
 * in the file, not here.
 */
function readSpine() {
  try {
    const md = fs.readFileSync(path.join(docsDir(), "workflow-spine.md"), "utf8");
    const stages = [];
    let current = null;
    for (const raw of md.split("\n")) {
      const line = raw.trim();
      const head = line.match(/^##\s+\d+\.\s+(.+)$/);
      if (head) {
        const dash = head[1].indexOf(" — ");
        current = {
          name: dash >= 0 ? head[1].slice(0, dash) : head[1],
          why: dash >= 0 ? head[1].slice(dash + 3) : "",
          items: [],
        };
        stages.push(current);
        continue;
      }
      const item = line.match(/^- \*\*(.+?):\*\* (.+)$/);
      if (item && current) current.items.push({ k: item[1], v: item[2] });
    }
    return stages.filter((g) => g.items.length);
  } catch {
    return [];
  }
}

/* ── workers you can start from the window ────────────────────────────────── */

// Workers run INSIDE the hub process rather than as spawned children.
//
// Two reasons. Spawning would mean tracking pids across a Windows/POSIX split
// and inheriting orphans when the hub dies — the same class of problem the
// working-tree lock already had to solve with kill(pid,0). And it matches what
// the window means to a person: the hub is open, so the agents are working; you
// close it, they stop. Nothing keeps running invisibly after the window is gone.
//
// The engine underneath (claimNextTask, askRunner, finishTask) is the bus's —
// imported from server.mjs. What lives HERE is the loop and its lifetime, which
// is bound to this window.
//
// Keyed by lane, because two workers on one lane would race for the same task.
// claimNextTask is atomic so it would be *safe*, but it would also be pointless.
const liveWorkers = new Map();

async function workerLoop(lane) {
  const entry = liveWorkers.get(lane);
  if (!entry) return;
  while (!entry.stop) {
    let task = null;
    try {
      task = claimNextTask(lane);
    } catch {
      // A locked state file is transient. Wait rather than killing the worker.
    }
    if (!task) {
      entry.status = "waiting";
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    entry.status = `running ${task.id}`;
    entry.lastTask = task.id;
    try {
      const runner = findRunner(task.runner_id || entry.runnerId);
      const answer = await askRunner(runner, task.prompt);
      finishTask(task.id, { status: "done", result: answer, model: runner.id });
      entry.done = (entry.done ?? 0) + 1;
    } catch (err) {
      finishTask(task.id, {
        status: "failed",
        result: err.message,
        model: task.runner_id || entry.runnerId,
      });
      entry.failed = (entry.failed ?? 0) + 1;
    }
  }
  liveWorkers.delete(lane);
}

function startLiveWorker(lane, runnerId) {
  if (liveWorkers.has(lane)) {
    return `A worker is already running on lane "${lane}". Stop it first.`;
  }
  // Resolve now, so a disabled or misspelled runner fails HERE with a message
  // on screen instead of silently on the first task.
  const runner = findRunner(runnerId);
  liveWorkers.set(lane, {
    lane,
    runnerId: runner.id,
    label: runner.label ?? runner.id,
    status: "waiting",
    startedAt: new Date().toISOString(),
    stop: false,
  });
  void workerLoop(lane);
  return `Worker started on "${lane}" using ${runner.label ?? runner.id}.`;
}

function stopLiveWorker(lane) {
  const entry = liveWorkers.get(lane);
  if (!entry) return `No worker running on "${lane}".`;
  entry.stop = true;
  entry.status = "stopping";
  // It finishes the task in hand rather than abandoning it half-done, so a
  // model call already in flight still gets its answer written back.
  return `Worker on "${lane}" will stop after its current task.`;
}

/* ── rendering ────────────────────────────────────────────────────────────── */

// Everything rendered here is text other processes wrote. All of it is escaped.
// (renderStatusHtml keeps its own local one; new renderers use this one.)
const escAll = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

// One stylesheet shared by the board page and the per-task pages, so a style
// tweak cannot silently apply to one and not the other.
// tweak cannot silently apply to one and not the other.
const PAGE_CSS = `<style>
  :root { color-scheme: light dark; --bg:#f6f7f5; --fg:#16201a; --mut:#5d6b5f;
    --card:#fff; --line:#dfe4dc; --ok:#2f6b3f; --warn:#b4530a; --code:#eef1ec; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#11150f; --fg:#e4ebe2; --mut:#93a094; --card:#181e16; --line:#2a3329;
    --code:#1e2620; } }
  * { box-sizing:border-box; }
  body { margin:0; padding:26px 30px 60px; background:var(--bg); color:var(--fg);
    font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  h1 { font-size:16px; margin:0; letter-spacing:.02em; }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.09em;
    color:var(--mut); margin:30px 0 9px; font-weight:600; }
  h3 { font-size:12px; margin:0 0 6px; }
  .mut { color:var(--mut); font-size:12px; margin:4px 0 0; }
  .grid { display:grid; gap:8px; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); }
  .grid2 { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .card.quiet { opacity:.5; }
  .row { display:flex; align-items:center; gap:7px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--ok); flex:0 0 auto; }
  .quiet .dot { background:var(--mut); }
  .run { color:var(--ok); font-size:11px; font-weight:600; border:1px solid var(--ok);
    border-radius:4px; padding:0 5px; margin-left:2px; flex:0 0 auto; }
  .row .mut { margin-left:auto; }
  .lane { margin:6px 0 0; }
  .path { margin:3px 0 0; color:var(--mut); font-size:11px;
    overflow-wrap:anywhere; font-family:ui-monospace,monospace; }
  .lock { background:var(--card); border:1px solid var(--line);
    border-left:3px solid var(--ok); border-radius:10px; padding:12px 14px; }
  .lock.held { border-left-color:var(--warn); }
  details { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:10px 14px; margin-bottom:6px; }
  summary { cursor:pointer; display:flex; gap:8px; align-items:center; }
  details p { margin:9px 0 2px; color:var(--mut); overflow-wrap:anywhere; }
  input, textarea, select { width:100%; margin-top:7px; padding:7px 9px; border-radius:7px;
    border:1px solid var(--line); background:var(--bg); color:var(--fg); font:inherit; font-size:13px; }
  textarea { resize:vertical; }
  button { margin-top:9px; padding:7px 14px; border-radius:7px; border:0;
    background:var(--ok); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  pre { background:var(--code); border:1px solid var(--line); border-radius:8px;
    padding:9px 11px; overflow-x:auto; font-size:12px; margin:6px 0 0; }
  .flash { background:var(--card); border:1px solid var(--ok); border-left:3px solid var(--ok);
    border-radius:9px; padding:10px 13px; margin:14px 0 0; white-space:pre-wrap; font-size:13px; }
  .rulegroup { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:12px 14px; }
  .msg { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:8px 12px; margin-bottom:6px; }
  .msg .mut { margin:0 6px 0 0; font-size:11px; }
  .msgtext { margin:5px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--fg); }
  .thread { max-height:420px; overflow-y:auto; }
  .rulegroup ul { margin:0; padding-left:0; list-style:none; }
  .rulegroup li { margin:3px 0; color:var(--mut); }
  .head { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  table.tw { width:100%; border-collapse:collapse; margin-top:8px; font-size:12px; }
  table.tw td, table.tw th { padding:3px 6px 3px 0; text-align:left; border-bottom:1px solid var(--line); }
  table.tw th { color:var(--mut); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
  table.tw tr:last-child td { border-bottom:0; }
  table.tw .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  table.tw .mutcell { color:var(--mut); font-weight:400; }
  table.tw tr.compact td:first-child { border-left:3px solid var(--warn); padding-left:6px; }
  table.tw tr.watch td:first-child { border-left:3px solid var(--mut); padding-left:6px; }
  .problem { background:var(--card); border:1px solid var(--line);
    border-left:3px solid var(--warn); border-radius:10px; padding:10px 14px; margin-bottom:6px; }
  a { color:var(--ok); }
</style>`;

// Self-refresh for the live pages. The desktop launcher opens the dashboard
// in a Chrome/Edge --app window, which has no address bar and does not even
// reload on F5 — a page like this would otherwise be frozen at whatever it
// showed when the window opened. Instead of a blind meta refresh (which
// discards scroll position and would yank a half-written form away), the
// page watches itself: every few seconds it re-fetches its own URL and
// compares the server's render marker. A new marker means new state worth
// showing — but never while someone is typing or a form holds unsaved text;
// being one render stale beats stealing the user's keystrokes.
const REFRESH_META = (stamp) => `<meta name="hub-render" content="${stamp}">`;
const REFRESH_JS = `<script>
setInterval(async () => {
  try {
    const text = await (await fetch(location.href, { cache: "no-store" })).text();
    const fresh = text.match(/hub-render" content="(\\d+)"/);
    const shown = document.querySelector('meta[name="hub-render"]')?.content;
    if (!fresh || !shown || fresh[1] === shown) return;
    const el = document.activeElement;
    const typing = el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    const dirty = [...document.querySelectorAll("input,textarea")]
      .some((i) => i.value !== i.defaultValue);
    if (!typing && !dirty) location.reload();
  } catch {}
}, 4000);
</script>`;

function renderStatusHtml(state, opts = {}) {
  const { flash = null, interactive = false } = opts;
  // §6 — which space this render belongs to. own (or unset) is the hub's own
  // bus, exactly as before. A project space renders its own bus state but
  // keeps the hub-anchored panels (hardware, context budget, workers) off the
  // page — they are the hub's learning and live on the hub's own page.
  const own = opts.proj?.own !== false;
  const projQ = opts.proj && !opts.proj.own ? `?p=${encodeURIComponent(opts.proj.name)}` : "";
  pruneAgents(state);
  const now = Date.now();
  const ago = (iso) => {
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  };
  // How long something has BEEN running — a forward clock, not a back-dated
  // one: "3m 17s", not "3m ago". Running tasks render with it.
  const elapsed = (iso) => {
    if (!iso) return "";
    const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  };
  // Everything below is text other processes wrote. All of it is escaped.
  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );

  const agents = Object.entries(state.agents).sort(
    (a, b) => Date.parse(b[1].lastSeen ?? 0) - Date.parse(a[1].lastSeen ?? 0)
  );
  const lock = state.lock;
  const held = lockIsLive(lock);
  const board = Object.entries(state.board).sort(
    (a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)
  );
  // LEARNING DEBT — self-reported misses (L2), the raw material the rulebook is
  // made from. Nothing else surfaces them: they sit on the board as ordinary
  // notes and scroll away, which is exactly how "a miss reported three times
  // is a rule that has not been written yet" (L3) stays true forever. Recurring
  // ones render hot, because those are the patterns, not the slips.
  const misses = board.filter(([, v]) => v && v.miss);
  const missHtml = misses.length
    ? misses
        .map(([k, v]) => {
          const hot = (v.seen ?? 1) >= 2;
          return `<details class="lock${hot ? " held" : ""}"><summary><b>${esc(k)}</b>
            <span class="mut">${esc(v.by)} · ${esc(ago(v.at))}${
              (v.seen ?? 1) > 1 ? ` · reported ${Number(v.seen)}x` : ""
            }</span></summary>
            <p>${esc(v.value)}</p></details>`;
        })
        .join("")
    : "<p class=\"mut\">No self-reported misses. Either nothing was wrong, or nobody has reported it — L2 asks for the report even when nothing broke.</p>";

  // BLOCKERS — §5's second half rendered for the person. The bus does the
  // matching and the messaging; what only a human can see here is whether an
  // open block has NOBODY who could have answered it, which is the signal to
  // either declare a capability or step in yourself. Open blocks render hot,
  // like a held lock: someone is standing in a doorway right now.
  const openBlocks = (state.blocks ?? []).filter((b) => b.status === "open");
  // THE PUBLISH RECORD — the spine's gap 2. Every space keeps its own record of
  // what actually went out the door (version, what, who, when), because a board
  // note scrolls away and a git tag lives in one repo while the hub serves
  // several. Newest first.
  const publishes = (state.publishes ?? []).slice().reverse();
  const publishHtml = publishes.length
    ? publishes
        .map(
          (p) => `<div class="msg"><b>${esc(p.version)}</b>
      <span class="mut">${esc(p.by)} · ${esc(ago(p.at))}</span>
      <p class="msgtext">${esc(p.what)}</p></div>`
        )
        .join("")
    : "<p class=\"mut\">Nothing published yet. <code>publish</code> records a version the moment it goes out — the board remembers, so the next agent does not re-derive what shipped.</p>";
  // Stage options for the queue form: the ten spine stages, read live from the
  // spine doc. A task's stage is DATA, validated at task_add — not a free-text note.
  const stageOptions = readStages()
    .map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)
    .join("");
  const resolvedBlocks = (state.blocks ?? []).filter((b) => b.status !== "open").slice(-5).reverse();
  const blocksHtml = openBlocks.length
    ? openBlocks
        .map(
          (b) => `<details class="lock held"><summary><b>${esc(b.id)}</b>
      <span class="mut">${esc(b.by)} · ${esc(ago(b.at))}</span></summary>
      <p>${esc(b.what)}</p>
      <p class="mut">needs: ${esc(b.needed)}</p></details>`
        )
        .join("")
    : "";
  const resolvedBlockLine = resolvedBlocks.length
    ? `<p class="mut">Recently resolved: ${resolvedBlocks
        .map((b) => `${esc(b.id)} — fixed by ${esc(b.resolvedBy ?? "?")}`)
        .join(" · ")}</p>`
    : "";

  // WHO DID WHAT — the delegation ledger (roadmap §3's data half). Every task
  // records the model that ran it and how it ended; aggregated, that is the
  // measured start of "who gets this task" from data instead of habit. Without
  // this panel the numbers exist but nobody looks, so routing never improves.
  const byModel = {};
  for (const t of state.tasks ?? []) {
    if (!t.model) continue;
    const m = (byModel[t.model] ||= { done: 0, failed: 0, chars: 0 });
    if (t.status === "done") {
      m.done++;
      m.chars += (t.result || "").length;
    } else if (t.status === "failed") {
      m.failed++;
    }
  }
  const modelRows = Object.entries(byModel)
    .sort((a, b) => b[1].done + b[1].failed - (a[1].done + a[1].failed))
    .map(
      ([id, m]) =>
        `<tr><td>${esc(id)}</td><td class="num">${m.done}</td>
      <td class="num">${m.failed ? `<b style="color:var(--warn)">${m.failed}</b>` : "0"}</td>
      <td class="num">${m.done ? Math.round(m.chars / m.done).toLocaleString() + " chars" : "—"}</td></tr>`
    )
    .join("");
  const ledgerHtml = modelRows
    ? `<div class="card"><table class="tw">
    <tr><th>runner</th><th class="num">done</th><th class="num">failed</th><th class="num">avg draft</th></tr>
    ${modelRows}</table>
    ${(() => {
      // §3's write-back, rendered: the verdict each runner's record has earned.
      // Outcome counts above are the table; these lines are what routing is
      // meant to learn from — who proved itself, who needs benching.
      const verdicts = routingVerdicts(extractHistory(state.tasks ?? []));
      return verdicts.length
        ? `<p class="mut">Routing record: ${verdicts.map((v) => esc(v.line)).join(" · ")}</p>`
        : "";
    })()}
    <p class="mut">Outcome counts, not quality scores — the harness that runs after a
      draft is what judges quality (J-rules). This is the record routing is meant to learn from.</p>
  </div>`
    : "<p class=\"mut\">No finished tasks yet. Every finished task lands here with its model and outcome — that is the ledger \"who gets this task\" is meant to be answered from.</p>";
  // The checkout this page's claim form and shell examples point at: the hub's
  // own root, or the project space being viewed.
  const repo = own ? PROJECT_ROOT : opts.proj.root;

  const agentCards = agents.length
    ? agents
        .map(([name, a]) => {
          // Three states, in honesty order. "running" is the strongest: the OS
          // confirms this agent's process exists right now, so the card stays
          // bright however long the agent has gone between bus calls. "quiet"
          // means two minutes without a bus call and no process to vouch for
          // the agent (a CLI one-shot, or a machine this one cannot check) —
          // called "quiet", not "offline": the bus cannot tell the difference
          // and must not pretend.
          const running = agentRunning(a);
          const quiet = !running && now - Date.parse(a.lastSeen ?? 0) > 120_000;
          return `<div class="card${quiet ? " quiet" : ""}">
      <div class="row"><span class="dot"></span><b>${esc(name)}</b>${running ? '<span class="run">running</span>' : ""}
        <span class="mut">${esc(ago(a.lastSeen ?? new Date(0).toISOString()))}</span></div>
      <p class="lane">${esc(a.lane || "no lane stated")}</p>
      ${a.capable?.length ? `<p class="mut">can grant: ${esc(a.capable.join(", "))}</p>` : ""}
      <p class="path">${esc(a.cwd || "")}</p>
    </div>`;
        })
        .join("")
    : "<p class=\"mut\">Nobody on the bus yet. An agent appears here after its first command.</p>";

  const boardRows = board.length
    ? board
        .map(
          ([k, v]) => `<details><summary><b>${esc(k)}</b>
      <span class="mut">${esc(v.by)} · ${esc(ago(v.at))}</span></summary>
      <p>${esc(v.value)}</p></details>`
        )
        .join("")
    : "<p class=\"mut\">The board is empty.</p>";

  const tasks = (state.tasks ?? []).slice(-12).reverse();
  const taskHtml = tasks.length
    ? tasks
        .map((t) => {
          const cls = t.status === "failed" ? " held" : "";
          const body = t.result
            ? `<p class="mut" style="white-space:pre-wrap">${esc(t.result.slice(0, 1200))}</p>`
            : `<p class="mut">${esc((t.prompt || "").slice(0, 200))}</p>`;
          // A running task that renders as a bare "running" cannot be told
          // apart from a hang. Elapsed since it started, plus what the worker
          // has streamed so far, if it has said anything yet.
          let status = esc(t.status);
          if (t.status === "running") {
            status = "running · " + (elapsed(t.startedAt || t.at) || "just started");
            if (t.progress) {
              const parts = [];
              if (t.progress.thinkingChars) parts.push(`thinking ${Number(t.progress.thinkingChars).toLocaleString()} chars`);
              if (t.progress.responseChars) parts.push(`answering ${Number(t.progress.responseChars).toLocaleString()} chars`);
              if (parts.length) status += " · " + parts.join(" · ");
            }
          }
          return `<details class="lock${cls}"><summary><b><a href="/task/${encodeURIComponent(t.id)}${projQ}" style="color:inherit;text-decoration:none">${esc(t.id)}</a></b>
            <span>${esc(t.title || "")}</span>
            <span class="mut">${esc(t.lane)}${t.stage ? ` · ${esc(t.stage)}` : ""} · ${status}${t.model ? " · " + esc(t.model) : ""}</span>
          </summary>${body}</details>`;
        })
        .join("")
    : "<p class=\"mut\">Nothing queued. Work added here is picked up by a running worker.</p>";

  const runnerOptions = readRunners()
    .map(
      (r) =>
        `<option value="${esc(r.id)}"${r.enabled ? "" : " disabled"}>${esc(
          r.label ?? r.id
        )}${r.enabled ? "" : " (not configured)"}</option>`
    )
    .join("");

  const workers = [...liveWorkers.values()];
  const workerHtml = workers.length
    ? workers
        .map(
          (w) => `<div class="card"><div class="row"><span class="dot"></span>
            <b>${esc(w.lane)}</b><span class="mut">${esc(w.status)}</span></div>
            <p class="lane">${esc(w.label)}</p>
            <p class="mut">${w.done ?? 0} done${w.failed ? `, ${w.failed} failed` : ""}</p>
            ${
              interactive
                ? `<form method="post"><input type="hidden" name="action" value="worker_stop">
                   <input type="hidden" name="lane" value="${esc(w.lane)}">
                   <button>Stop</button></form>`
                : ""
            }</div>`
        )
        .join("")
    : "<p class=\"mut\">No worker running. Start one below and queued work begins moving.</p>";

  // The message thread (Stage 1) — the last 30, newest LAST, so reading order
  // matches how it was written. Local time on the machine rendering the page;
  // the day is shown for anything not from today.
  const fmtWhen = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString()
      : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.toLocaleTimeString()}`;
  };
  const thread = (state.messages ?? []).slice(-30);
  const threadHtml = thread.length
    ? thread
        .map(
          (m) => `<div class="msg"><span class="mut">${esc(fmtWhen(m.at))}</span>
      <b>${esc(m.from)}</b> → <b>${esc(m.to)}</b>
      <p class="msgtext">${esc(m.text)}</p></div>`
        )
        .join("")
    : "<p class=\"mut\">No messages yet.</p>";
  // Recipients: all, plus every name the bus can currently address. The list is
  // re-rendered per request, so a freshly pruned name drops off on its own.
  const recipientOptions = agents.length
    ? agents.map(([name]) => `<option value="${esc(name)}">${esc(name)}</option>`).join("")
    : "";

  const workGroups = readWorkflow();
  const workHtml = workGroups.length
    ? workGroups
        .map(
          (g) => `<div class="rulegroup"><h3>${esc(g.title)}</h3><ul>${g.items
            .map((i) => `<li>${esc(i.replace(/[`*]/g, ""))}</li>`)
            .join("")}</ul></div>`
        )
        .join("")
    : "<p class=\"mut\">docs/how-we-work.md not found from here.</p>";

  // THE WORKFLOW SPINE — §0's research output, rendered like the rules: the
  // stages every app passes through and, at each, the human-only part a fleet
  // covers another way. Shared across every space by design — it is the hub's
  // map, not any one app's.
  const spineGroups = readSpine();
  const spineHtml = spineGroups.length
    ? spineGroups
        .map(
          (g) => `<div class="rulegroup"><h3>${esc(g.name)}${
            g.why ? ` <span class="mut">— ${esc(g.why)}</span>` : ""
          }</h3><ul>${g.items
            .map((i) => `<li><b>${esc(i.k)}.</b> ${esc(i.v.replace(/[`*]/g, ""))}</li>`)
            .join("")}</ul></div>`
        )
        .join("")
    : "<p class=\"mut\">docs/workflow-spine.md not found from here.</p>";

  const ruleGroups = readBuildRules();
  const ruleHtml = ruleGroups.length
    ? ruleGroups
        .map(
          (g) => `<div class="rulegroup"><h3>${esc(g.title)}</h3><ul>${g.rules
            .map((r) => `<li><b>${esc(r.n)}</b> ${esc(r.text.replace(/[`*]/g, ""))}</li>`)
            .join("")}</ul></div>`
        )
        .join("")
    : "<p class=\"mut\">docs/build-rules.md not found from here.</p>";

  // THE CONTEXT BUDGET, rendered rather than audited (lane 2). Two questions,
  // and they are different questions: where has the money gone (history, and
  // every row of it already spent), and which live session should compact right
  // now (the only part anyone can still act on).
  const tokens = readSessions();
  const M = (n) => (n / 1e6).toFixed(1) + "M";
  const K = (n) => Math.round(n / 1000).toLocaleString() + "k";
  const shortAgo = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 60) return m + "m";
    const hr = Math.round(m / 60);
    return hr < 48 ? hr + "h" : Math.round(hr / 24) + "d";
  };

  let costHtml;
  if (tokens.missing || !tokens.totals || !tokens.totals.turns) {
    costHtml = `<p class="mut">No Claude Code transcripts for this project yet, so
      there is nothing measured to show. This panel fills in on its own.</p>`;
  } else {
    const T = tokens.totals;
    const all = T.read + T.write + T.input + T.output || 1;
    const live = tokens.rows.filter((r) => r.idle < LIVE_MS);
    const flagged = live.filter((r) => r.assessment.level !== "ok");
    const bl = tokens.baseline;

    const costRows = flagged.length
      ? flagged
          .slice(0, 8)
          .map((r) => {
            const a = r.assessment;
            return `<tr class="${a.level}"><td>${esc(r.id)}</td>
        <td class="num">${a.turns.toLocaleString()}</td>
        <td class="num">${K(a.contextTokens)}</td>
        <td class="num">${K(a.excessTokensPerTurn)}</td>
        <td class="num"><b>${a.breakEvenTurns.toFixed(1)}</b></td>
        <td class="num mutcell">${esc(shortAgo(r.idle))}</td></tr>`;
          })
          .join("")
      : "";

    const offenders = Object.entries(T.files)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${K(v)}</td></tr>`)
      .join("");

    costHtml = `
<div class="grid2">
  <div class="card">
    <b>Where it went — ${T.sessions} sessions, ${T.turns.toLocaleString()} turns</b>
    <table class="tw">
      <tr><td>cache read <span class="mutcell">re-reading the conversation</span></td>
        <td class="num">${M(T.read)}</td><td class="num">${((100 * T.read) / all).toFixed(1)}%</td></tr>
      <tr><td>cache write <span class="mutcell">new context added</span></td>
        <td class="num">${M(T.write)}</td><td class="num">${((100 * T.write) / all).toFixed(1)}%</td></tr>
      <tr><td>input <span class="mutcell">uncached</span></td>
        <td class="num">${M(T.input)}</td><td class="num">${((100 * T.input) / all).toFixed(1)}%</td></tr>
      <tr><td>output <span class="mutcell">what was actually written</span></td>
        <td class="num">${M(T.output)}</td><td class="num">${((100 * T.output) / all).toFixed(1)}%</td></tr>
    </table>
    <p class="mut">Everything in context is paid for on every turn, not once (H1).
      That is why the top row is the whole story and the bottom row is a rounding error.</p>
  </div>

  <div class="card">
    <b>Read into context</b>
    <table class="tw">
      <tr><td>images / PDF</td><td class="num">${T.images.n}</td>
        <td class="num">${K(T.images.tok)}</td>
        <td class="num mutcell">${T.images.n ? K(Math.round(T.images.tok / T.images.n)) : "—"} each</td></tr>
      <tr><td>text files</td><td class="num">${T.texts.n}</td>
        <td class="num">${K(T.texts.tok)}</td>
        <td class="num mutcell">${T.texts.n ? K(Math.round(T.texts.tok / T.texts.n)) : "—"} each</td></tr>
    </table>
    ${
      T.images.n && T.texts.n && T.texts.tok
        ? `<p class="mut">One image costs about
      <b>${Math.round(T.images.tok / T.images.n / (T.texts.tok / T.texts.n))}</b>
      source-file reads (H2). Look at it in a subagent; keep the sentence, not the pixels.</p>`
        : ""
    }
    ${offenders ? `<table class="tw">${offenders}</table>` : ""}
  </div>
</div>

<div class="card" style="margin-top:10px">
  <b>Worth compacting now — ${flagged.length} of ${live.length} live ${live.length === 1 ? "session" : "sessions"}</b>
  <p class="mut">Break-even is how many more turns a session has to run before compacting
    now would have paid for itself: <code>context / (context − baseline)</code>, which is
    H1 and nothing else. Baseline ${bl ? bl.tokens.toLocaleString() : "—"} tok/turn —
    ${
      bl && bl.measured
        ? "measured, median first turn of " + bl.n + " sessions"
        : "assumed, because " + esc(bl ? bl.why : "there is nothing to measure")
    }.</p>
  ${
    costRows
      ? `<table class="tw wide">
    <tr><th>session</th><th class="num">turns</th><th class="num">ctx/turn</th>
      <th class="num">above baseline</th><th class="num">break-even</th><th class="num">last turn</th></tr>
    ${costRows}</table>
  <p class="mut">Nothing here acts on its own (C4). The agent in that session decides —
    and posts what it still needs to the board first, so the summary lands on a clean context.</p>`
      : `<p class="mut">${
          live.length
            ? "Every live session is close enough to a fresh one that summarising it would cost more than it saves."
            : "No session has been written to in the last " + Math.round(LIVE_MS / 60000) + " minutes."
        }</p>`
  }
</div>`;
  }

  // Forms only exist in the served app. The written-to-disk copy is a file://
  // page with nothing to POST to, and a dead button is worse than no button.
  const actions = interactive
    ? `
<h2>Do something</h2>
<div class="grid2">
  <form method="post" class="card">
    <b>Post a note to the board</b>
    <p class="mut">Durable. Reaches agents who were not listening when you wrote it.</p>
    <input type="hidden" name="action" value="note">
    <input name="actor" placeholder="from (default: desk)" value="desk">
    <input name="key" placeholder="key, e.g. table-pattern" required>
    <textarea name="value" rows="3" placeholder="the fact, written for someone who was not here" required></textarea>
    <button>Post note</button>
  </form>

  <form method="post" class="card">
    <b>Send a message</b>
    <p class="mut">Only reaches an agent that is listening now. Use a note for anything that must outlive the moment.</p>
    <input type="hidden" name="action" value="send">
    <input name="actor" placeholder="from (default: desk)" value="desk">
    <input name="to" placeholder="to — an agent name, or all" required>
    <textarea name="message" rows="3" placeholder="message" required></textarea>
    <button>Send</button>
  </form>

  <form method="post" class="card">
    <b>${held ? "Release the working tree" : "Claim the working tree"}</b>
    <p class="mut">${
      held
        ? "Only the holder can release it."
        : "Claim before any git operation in a shared checkout."
    }</p>
    <input type="hidden" name="action" value="${held ? "release" : "claim"}">
    <input name="actor" placeholder="your name" value="${esc(held && lock ? lock.holder : "desk")}">
    ${
      held
        ? ""
        : `<input name="path" placeholder="path" value="${esc(repo)}" required>
    <input name="reason" placeholder="what you are doing" required>
    <input name="minutes" placeholder="minutes (default 30)" value="30">`
    }
    <button>${held ? "Release" : "Claim"}</button>
  </form>
</div>`
    : `<h2>Do something</h2>
<p class="mut">This is the saved copy of the page — read-only. Launch <b>Agent Bus</b>
from the desktop to run commands.</p>`;

  return `<!doctype html>
<meta charset="utf-8"><title>Agent Bus — command hub</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${interactive ? REFRESH_META(Date.now()) + REFRESH_JS : '<meta http-equiv="refresh" content="5">'}
${PAGE_CSS}

<div class="head">
  <h1>Agent Bus${opts.proj && !own ? ` — ${esc(opts.proj.name)}` : ""}</h1>
  <span class="mut">${opts.proj && !own ? "app space · " : "command hub · "}${esc(new Date().toLocaleTimeString())}</span>
</div>
${opts.proj ? spacesHtml(opts.proj) : ""}
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}
<div class="mut" style="padding:0 0 8px 0">Pulse: ${esc(healthStr(healthOf(state)))}</div>

<h2>Connected (${agents.length})</h2>
<div class="grid">${agentCards}</div>

${
  own
    ? `<h2>This machine</h2>
${hardwareHtml()}

<h2>The context budget</h2>
${costHtml}`
    : `<div class="card">
  <b>Shared with every space — not copied here</b>
  <p class="mut">The rulebook and the how-we-work model below are the hub's
    learning and stay shared. So are this machine's hardware panel and
    <a href="/">the context budget</a> — those read the hub's own bus and its
    own transcripts, so they live on
    <a href="/">the hub's own page</a> and are never duplicated per app.</p>
</div>`
}

<h2>Working tree</h2>
<div class="lock${held ? " held" : ""}">${esc(describeLock(lock))}</div>
${actions}

${
  own
    ? `<h2>Workers (${workers.length})</h2>
<div class="grid">${workerHtml}</div>

<h2>Who did what — the delegation ledger</h2>
${ledgerHtml}
${
  interactive
    ? `<form method="post" class="card" style="margin-top:10px">
    <b>Start a worker</b>
    <p class="mut">It runs while this window is open and takes queued work in its lane.</p>
    <input type="hidden" name="action" value="worker_start">
    <input name="lane" placeholder="lane" value="local">
    <select name="runner_id">${runnerOptions}</select>
    <button>Start</button>
  </form>`
    : ""
}`
    : `<h2>Who did what — the delegation ledger</h2>
${ledgerHtml}
<p class="mut">No workers from this window: workers run inside the hub's own
  process, so they only serve the hub's own space. To drain the queue here, run
  a worker against this project directly — <code>AGENT_BUS_PROJECT=${esc(repo)}
  node tools/agent-bus/server.mjs work local</code> — and its results land in
  this space's queue.</p>`
}

<h2>Talk to the agents</h2>
<p class="mut">A noticeboard, not chat — an agent reads your message at its next
  <code>inbox()</code> call. A session already running will not notice until it looks.
  For a fact the NEXT agent needs even if nobody is listening, post a note to the board instead.</p>
<div class="thread">${threadHtml}</div>
${
  interactive
    ? `<form method="post" class="card" style="margin-top:10px">
    <b>Write to the agents</b>
    <input type="hidden" name="action" value="message">
    <select name="to"><option value="all">all</option>${recipientOptions}</select>
    <textarea name="text" rows="3" placeholder="the message" required></textarea>
    <button>Post it</button>
  </form>`
    : ""
}

<h2>Work queue (${tasks.length})</h2>
<p class="mut">Queued work is executed by a worker, not by a person reading this.
  Start one above and pick which agent runs it — it takes the
  next queued task in its lane, runs it against the local model, and writes the answer
  back here. Output is a DRAFT: the worker never touches the repo.</p>
${taskHtml}
${
  interactive
    ? `<form method="post" class="card" style="margin-top:10px">
    <b>Queue work</b>
    <input type="hidden" name="action" value="task">
    <input name="actor" placeholder="from (default: desk)" value="desk">
    <input name="lane" placeholder="lane" value="local">
    <select name="runner_id">${runnerOptions}</select>
    <select name="stage"><option value="">stage (optional)</option>${stageOptions}</select>
    <input name="title" placeholder="short title" required>
    <textarea name="prompt" rows="3" placeholder="the whole task, written for someone with no context" required></textarea>
    <button>Queue it</button>
  </form>`
    : ""
}

<h2>Board (${board.length})</h2>
${boardRows}

<h2>Publish record (${publishes.length})</h2>
<p class="mut">What actually went out the door, per space — version, what, who, when.
  A ship that is only a memory is a ship the next agent re-derives badly.</p>
${publishHtml}
${
  interactive
    ? `<form method="post" class="card" style="margin-top:10px">
    <b>Record a publish</b>
    <input type="hidden" name="action" value="publish">
    <input name="version" placeholder="version (e.g. v0.2.0)" required maxlength="200">
    <input name="what" placeholder="what shipped" required maxlength="2000">
    <button>Record it</button>
  </form>`
    : ""
}

<h2>Learning debt (${misses.length})</h2>
<p class="mut">Self-reported misses — the raw material the rulebook is made from.
  A miss reported three times is a rule that has not been written yet (L3): the recurring
  ones below belong in <code>docs/build-rules.md</code>, and then the note comes off the board.</p>
${missHtml}

<h2>Blockers (${openBlocks.length} open)</h2>
<p class="mut">Agents report what they are blocked on (<code>block(what, needed)</code>) and the bus
  asks whoever declared they can grant it (<code>capable([...])</code>). When a block is resolved
  the fix is banked on the board under <code>fix-…</code>, so the next agent that hits the same
  shape is handed the answer instead of the wall.</p>
${blocksHtml}
${resolvedBlockLine}
${openBlocks.length ? "" : "<p class=\"mut\">Nobody is blocked right now.</p>"}

<h2>Connect another AI</h2>
<div class="grid2">
  <div class="card">
    <b>Anything that can run a command</b>
    <p class="mut">A PowerShell session, an ollama-driven script, a person at a terminal.
      No install, no MCP. Run it from the repo.</p>
    <pre>cd ${esc(repo)}
node tools/agent-bus/server.mjs board
node tools/agent-bus/server.mjs note my-status "what I am doing"</pre>
    <p class="mut">The bus is keyed to the project root it is started from — run these
      from that repo. From anywhere else, set <code>AGENT_BUS_PROJECT</code> to the repo's
      path first, or the commands write to a different, empty bus and print success
      anyway.</p>
    <p class="mut">Set a name once so you do not pass it every time:</p>
    <pre>$env:AGENT_BUS_NAME = "your-agent-name"</pre>
  </div>
  <div class="card">
    <b>A Claude session</b>
    <p class="mut">Already wired — <code>.mcp.json</code> in the repo root starts the bus
      as an MCP server, so the tools appear on their own. Nothing to do.</p>
    <pre>{ "mcpServers": { "agent-bus": {
    "command": "node",
    "args": ["tools/agent-bus/server.mjs"] } } }</pre>
    <p class="mut">First call should be <code>register(name, lane)</code>, then
      <code>board()</code>.</p>
  </div>
</div>
<p class="mut">Running <code>server.mjs</code> with no arguments starts the stdio MCP
  server and blocks — that is for editors, not for you. Any verb prints usage.</p>

<h2>How we work</h2>
<p class="mut">The operating model, read live from <code>docs/how-we-work.md</code>.
  The expensive model plans and verifies, cheaper agents implement, and this board is
  how they stay out of each other's way.</p>
<div class="grid2">${workHtml}</div>

<h2>The workflow spine — ${spineGroups.length} stages, idea to maintain</h2>
<p class="mut">What it takes, start to finish, to build and publish an app — read live
  from <code>docs/workflow-spine.md</code>. Every stage names the part a
  human-only team does that a fleet must cover another way; the hub's tools
  came from those parts one incident at a time, and the next ones will too.
  Shared by every space — it is the hub's map, not one app's.</p>
<div class="grid2">${spineHtml}</div>

<h2>How to build here — ${ruleGroups.reduce((n, g) => n + g.rules.length, 0)} rules</h2>
<p class="mut">Read live from <code>docs/build-rules.md</code>. Every one was written after
  something went wrong; the reasoning and the incident behind each is in that file.</p>
<div class="grid2">${ruleHtml}</div>
`;
}

function dashboardHtml(flash, proj) {
  return renderStatusHtml(stateFor(proj), { flash, interactive: true, proj });
}

function taskPageHtml(id, flash, proj) {
  return (() => {
    const state = stateFor(proj);
    const projQ = proj && !proj.own ? `?p=${encodeURIComponent(proj.name)}` : "";
    const esc = (v) =>
      String(v ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
      );
    pruneAgents(state);
    const task = (state.tasks ?? []).find((t) => t.id === id);
    if (!task) return null;

    const ago = (iso) => {
      if (!iso) return "";
      const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.round(s / 60)}m ago`;
      return `${Math.round(s / 3600)}h ago`;
    };
    const elapsed = (iso) => {
      if (!iso) return "";
      const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
      return `${Math.floor(s / 3600)}h ${Math.round(s % 3600 / 60)}m`;
    };

    let status = esc(task.status);
    if (task.status === "running") {
      status = `running · ${elapsed(task.startedAt || task.at) || "just started"}`;
      if (task.progress) {
        const parts = [];
        if (task.progress.thinkingChars) parts.push(`thinking ${Number(task.progress.thinkingChars).toLocaleString()} chars`);
        if (task.progress.responseChars) parts.push(`answering ${Number(task.progress.responseChars).toLocaleString()} chars`);
        if (parts.length) status += " · " + parts.join(" · ");
      }
    }

    // The worktree the job ran in: the runner's registered cwd is the only
    // place the bus knows a tree from. Unknown is said as unknown.
    const runner = task.runner && state.agents[task.runner];
    const tree = runner?.cwd;

    // Everything on the bus that names this job. A failed run is a problem by
    // definition; notes and messages are shown because they are how problems
    // get reported — an agent files a note or a message rather than a
    // structured "issue", so text mentioning the id is the ledger.
    const mentions = Object.entries(state.board ?? {})
      .filter(([k, v]) => k.includes(task.id) || String(v.value ?? "").includes(task.id))
      .map(([k, v]) => `<div class="msg"><b>${esc(k)}</b> <span class="mut">${esc(v.by)} · ${esc(ago(v.at))}</span>
        <p class="msgtext">${esc(v.value)}</p></div>`);
    const messages = (state.messages ?? [])
      .filter((m) => String(m.text ?? "").includes(task.id))
      .slice(-20)
      .map((m) => `<div class="msg"><span class="mut">${esc(m.at)}</span>
        <b>${esc(m.from)}</b> → <b>${esc(m.to)}</b>
        <p class="msgtext">${esc(m.text)}</p></div>`);

    const CAP = 200_000;
    const result = task.result
      ? `<pre>${esc(task.result.length > CAP ? task.result.slice(0, CAP) + `\n\n… (${task.result.length - CAP} more characters)` : task.result)}</pre>`
      : task.status === "failed"
        ? `<p class="mut">No output — the run failed. What the worker reported is under Problems.</p>`
        : `<p class="mut">Nothing yet — ${task.status === "queued" ? "no worker has taken it" : "the worker is still on it"}.</p>`;

    // The review surface: verdicts are data on the task, and the form posts to
    // THIS page with a `back` field so the redirect lands here again, not on
    // the board. Where the task sits on the spine is a chip, not prose.
    const postUrl = `/task/${encodeURIComponent(task.id)}${projQ ? "?" + projQ.slice(1) : ""}`;
    const reviews = (task.reviews ?? [])
      .map(
        (r) => `<div class="msg">
      <b>${r.verdict === "approve" ? '<span class="ok">approve</span>' : '<span class="warn">changes</span>'}</b>
      <span class="mut">by ${esc(r.by)} · ${esc(ago(r.at))}</span>
      ${r.notes ? `<p class="msgtext">${esc(r.notes)}</p>` : ""}
    </div>`
      )
      .join("");
    const reviewForm =
      task.status === "done"
        ? `<form method="post" action="${esc(postUrl)}" class="card">
      <input type="hidden" name="action" value="review">
      <input type="hidden" name="task_id" value="${esc(task.id)}">
      <input type="hidden" name="back" value="${esc(postUrl)}">
      <label class="mut">Your review — the worker cannot review its own task</label>
      <div class="row">
        <select name="verdict"><option value="approve">approve</option><option value="changes">changes</option></select>
        <input type="text" name="notes" placeholder="notes (optional)" maxlength="2000">
        <button type="submit">Record review</button>
      </div>
    </form>`
        : "";

    return `<!doctype html>
<meta charset="utf-8"><title>Agent Bus — ${esc(task.id)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
${REFRESH_META(Date.now())}${REFRESH_JS}
${PAGE_CSS}

<div class="head">
  <h1>${esc(task.title || task.id)}</h1>
  <span class="mut">${esc(task.id)} · ${esc(task.lane)}${task.stage ? ` · ${esc(task.stage)}` : ""} · ${status}${task.model ? " · " + esc(task.model) : ""}</span>
</div>
<p class="mut"><a href="/${projQ}">← back to the board</a></p>
${flash ? `<div class="flash">${esc(flash)}</div>` : ""}

<h2>The job as it was written</h2>
<div class="card"><pre>${esc(task.prompt || "")}</pre></div>

<h2>What came back</h2>
${result}

<h2>Reviews (${(task.reviews ?? []).length})</h2>
${reviews || `<p class="mut">No reviews yet. Review is someone else's read of the work — the runner who did it cannot record one.</p>`}
${reviewForm}

<h2>Timeline</h2>
<div class="card">
  <table class="tw">
    <tr><td>queued</td><td class="num">${esc(task.at ?? "")}</td></tr>
    <tr><td>started</td><td class="num">${esc(task.startedAt ?? "—")}${task.startedAt ? ` <span class="mutcell">(${esc(ago(task.startedAt))})</span>` : ""}</td></tr>
    <tr><td>finished</td><td class="num">${esc(task.doneAt ?? "—")}${task.doneAt ? ` <span class="mutcell">(${esc(ago(task.doneAt))})</span>` : ""}</td></tr>
    <tr><td>runner</td><td class="num">${esc(task.runner ?? "—")}${task.model ? ` <span class="mutcell">(${esc(task.model)})</span>` : ""}</td></tr>
    ${
      task.usage
        ? `<tr><td>tokens this local run consumed</td><td class="num">${Number(task.usage.prompt).toLocaleString()} in · ${Number(task.usage.output).toLocaleString()} out — exact counts from the model server, billed $0 here</td></tr>`
        : ""
    }
  </table>
</div>

<h2>Its worktree</h2>
${
  tree
    ? `<div class="card"><p class="path">${esc(tree)}</p>
       <p class="mut">Registered by <b>${esc(task.runner)}</b> — the checkout this job ran in.</p></div>`
    : `<p class="mut">Unknown. ${
        task.runner
          ? `The runner "${esc(task.runner)}" never registered a cwd, so the bus will not guess.`
          : "No worker has taken this job yet."
      }</p>`
}

<h2>Problems (${(task.status === "failed" ? 1 : 0) + mentions.length + messages.length})</h2>
${
  task.status === "failed"
    ? `<div class="problem"><b>the run failed</b>
        <p class="msgtext">${esc(task.result ?? "no reason recorded")}</p></div>`
    : ""
}
${task.status === "failed" ? "" : ""}
${mentions.join("")}
${messages.join("")}
${
  task.status !== "failed" && !mentions.length && !messages.length
    ? `<p class="mut">Nothing recorded against this job.</p>`
    : ""
}`;
  })();
}

/* ── this machine ─────────────────────────────────────────────────────────── */

// What the hub is running on, read from the system rather than assumed. CPU
// and RAM come from the OS; the GPU needs nvidia-smi, which exists on the
// machines that care about VRAM budgets and nowhere it would crash anything —
// its absence renders as "not detected", never an error page.
let HW = null;
let HW_AT = 0;
function hardwareInfo() {
  if (HW && Date.now() - HW_AT < 60_000) return HW;
  const info = {
    platform: `${os.platform()} ${os.arch()} (${os.release()})`,
    cpu: os.cpus().length ? `${os.cpus()[0].model.trim()} — ${os.cpus().length} threads` : "unknown",
    ramTotal: os.totalmem(),
    ramFree: os.freemem(),
    gpus: null,
  };
  try {
    const out = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { timeout: 4000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    info.gpus = out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [name, total, free] = l.split(",").map((s) => s.trim());
        return { name, total, free };
      });
  } catch {
    info.gpus = null;
  }
  HW = info;
  HW_AT = Date.now();
  return info;
}

const GB = (n) => (n / 1024 ** 3).toFixed(1) + " GB";

function hardwareHtml() {
  const hw = hardwareInfo();
  const gpuRows = hw.gpus?.length
    ? hw.gpus
        .map(
          (g) =>
            `<tr><td>${escAll(g.name)}</td><td class="num">${escAll(g.total)} MB total</td><td class="num">${escAll(g.free)} MB free</td></tr>`
        )
        .join("")
    : "";
  return `<div class="card">
  <table class="tw">
    <tr><td>system</td><td class="num">${escAll(hw.platform)}</td></tr>
    <tr><td>cpu</td><td class="num">${escAll(hw.cpu)}</td></tr>
    <tr><td>ram</td><td class="num">${GB(hw.ramTotal)} total · ${GB(hw.ramFree)} free</td></tr>
    ${
      hw.gpus
        ? `<tr><td colspan="3"><b>gpu</b></td></tr>${gpuRows}`
        : `<tr><td>gpu</td><td class="num mutcell">not detected (no nvidia-smi on PATH)</td></tr>`
    }
  </table>
  <p class="mut">Read from this machine, not configured by hand. What a runner can
    hold resident decides its <code>ctx</code> in <code>runners.json</code> — model
    weights plus KV cache must fit, or throughput collapses.</p>
</div>`;
}

/**
 * Run one action on behalf of the person at the window.
 *
 * The web UI has no session of its own, so it borrows an identity for the
 * length of the call the same way the CLI does. `actor` defaults to "desk" so
 * anything done from the app is attributable to the desk rather than appearing
 * to come from whichever agent happened to be listed first.
 *
 * The borrow itself (myName / IS_CLI) is the bus's module state, so it goes
 * through asActor() rather than reaching into server.mjs internals.
 *
 * §6: an action aimed at a project space cannot go through this process's
 * callTool — that is bound to the hub's own PROJECT_ROOT. It runs the CLI in a
 * child with AGENT_BUS_PROJECT pointed at the app's root, which is the same
 * seam every other cross-project writer uses. The child registers the actor on
 * THAT bus first, so the desk is attributed there too.
 */
function runAction(action, form, proj = { own: true, root: PROJECT_ROOT }) {
  const actor = (form.get("actor") || "desk").trim() || "desk";
  // A browser POST is as short-lived as a CLI call: no pid to trust.
  return asActor(actor, () => {
    if (!proj.own) return runProjectAction(action, form, proj, actor);
    registerCli(actor);
    switch (action) {
      case "note":
        return callTool("note", { key: form.get("key"), value: form.get("value") });
      case "send":
        return callTool("send", { to: form.get("to"), message: form.get("message") });
      case "message":
        // Stage 1 — the person writes as "human", bypassing send's requireName.
        return postFromWindow(form.get("to"), form.get("text"));
      case "claim":
        return callTool("claim_tree", {
          path: form.get("path"),
          reason: form.get("reason"),
          minutes: Number(form.get("minutes")) || 30,
        });
      case "release":
        return callTool("release_tree", {});
      case "worker_start":
        return startLiveWorker(form.get("lane") || "local", form.get("runner_id"));
      case "worker_stop":
        return stopLiveWorker(form.get("lane"));
      case "task":
        return callTool("task_add", {
          lane: form.get("lane") || "local",
          runner_id: form.get("runner_id") || null,
          title: form.get("title"),
          prompt: form.get("prompt"),
          stage: form.get("stage") || null,
        });
      case "review":
        return callTool("review", {
          task_id: form.get("task_id"),
          verdict: form.get("verdict"),
          notes: form.get("notes") || "",
        });
      case "publish":
        return callTool("publish", {
          version: form.get("version"),
          what: form.get("what"),
        });
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  });
}

/**
 * One-shot CLI child aimed at another space. Only the write verbs the desk
 * form actually offers are routed here; workers are deliberately not — they
 * live in this process, bound to the hub's own bus, and pretending otherwise
 * would start a worker that works on the wrong project.
 */
function runProjectAction(action, form, proj, actor) {
  const env = { ...process.env, AGENT_BUS_PROJECT: proj.root, AGENT_BUS_NAME: actor };
  let args;
  switch (action) {
    case "note":
      args = ["note", form.get("key"), form.get("value")];
      break;
    case "send":
      args = ["send", form.get("to"), form.get("message")];
      break;
    case "message":
      // The desk speaks as itself here too — the child registers the actor and
      // send() requires a name, so the message goes out under the actor name.
      args = ["send", form.get("to"), form.get("text")];
      break;
    case "claim":
      args = ["claim", actor, form.get("path"), form.get("reason")];
      break;
    case "release":
      args = ["release", actor];
      break;
    case "task":
      args = ["task", form.get("lane") || "local", form.get("title"), form.get("prompt")];
      if (form.get("stage")) args.push("--stage", form.get("stage"));
      break;
    case "review":
      args = ["review", form.get("task_id"), form.get("verdict"), form.get("notes") || ""].filter(
        (a, i) => i < 3 || a !== ""
      );
      break;
    case "publish":
      args = ["publish", form.get("version"), form.get("what")];
      break;
    case "worker_start":
    case "worker_stop":
      throw new Error(
        "Workers run inside the hub's own window and serve the hub's own space. " +
          `To drain "${proj.name}'s" queue, run a worker against it directly: ` +
          `AGENT_BUS_PROJECT=${proj.root} node tools/agent-bus/server.mjs work local`
      );
    default:
      throw new Error(`Unknown action: ${action}`);
  }
  try {
    const out = execFileSync(
      process.execPath,
      [path.join(import.meta.dirname, "server.mjs"), ...args],
      { env, encoding: "utf8", timeout: 30_000, windowsHide: true }
    );
    return (out || "").trim() || "Done.";
  } catch (err) {
    const detail = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`
      .trim()
      .split("\n")
      .slice(-2)
      .join(" ");
    throw new Error(detail.slice(0, 400) || "the project-space command failed");
  }
}

/**
 * Post a message on behalf of the person at the window (Stage 1).
 *
 * Deliberately NOT routed through the send tool: send() calls requireName(),
 * and the hub is not a registered agent — the person at the desk is nobody the
 * bus has a session for. The write happens inside withState() directly, with
 * the same 500-entry cap. `from` is "human": the desk speaks as itself, not by
 * borrowing another agent's identity.
 *
 * A broadcast to `all` works when nobody is registered — the normal case when
 * the window is opened first. A NAMED recipient must still exist: the dropdown
 * only offers live names, but an agent an hour cold is pruned between
 * rendering the form and posting, and a message addressed to nobody would
 * silently never be read.
 */
function postFromWindow(to, text) {
  const toName = String(to || "").trim();
  const body = String(text || "").trim();
  if (!toName) throw new Error("A recipient is required.");
  if (!body) throw new Error("The message needs text.");
  return withState((state) => {
    if (toName !== "all" && !state.agents[toName]) {
      throw new Error(
        `No agent named "${toName}" is registered. Active: ${Object.keys(state.agents).join(", ") || "none"}.`
      );
    }
    state.messages.push({
      id: randomUUID(),
      from: "human",
      to: toName,
      text: body,
      at: new Date().toISOString(),
      readBy: [],
    });
    // Keep the log bounded; this is a bus, not an archive.
    if (state.messages.length > 500) state.messages = state.messages.slice(-500);
    return toName === "all"
      ? "Posted to all. Agents see it at their next inbox() call."
      : `Posted to ${toName}. They see it at their next inbox() call.`;
  });
}

/* ── the HTTP server ──────────────────────────────────────────────────────── */

// A page, because a status line you have to remember to run is not the same as
// a window you leave open on a second monitor.
//
// SERVED LOCALLY, and it has to be: the bus state is a JSON file in this repo's
// .git directory. Nothing hosted could read it, so this renders on each request
// from the same withState() the tools use — no cache, no sync, no way for the
// page to disagree with the bus.
//
// Server-rendered with a meta refresh rather than client-side polling. It is a
// status board on a local socket; five lines of HTML beat a fetch loop, and it
// keeps the no-dependencies rule the bus has kept from the start.
function runDashboard(port) {
  // Imported here, not at the top: the page snapshot watcher below is the only
  // thing that needs it before a request arrives.
  return import("node:http").then(({ default: http }) => {
    const server = http.createServer((req, res) => {
      try {
        // Drive-by protection. Loopback binds the port to this machine, but it
        // does not bind the page: a form POST from ANY website open in ANY
        // browser is a simple request (no CORS preflight), so without a check,
        // http://evil.example could release a claim, post as "human" or start
        // workers against 127.0.0.1. The dashboard's own posts carry an Origin
        // of this server; a non-browser client (curl, a script) sends none and
        // is allowed — nothing coerced it. The Host check on every request
        // closes DNS rebinding, where a remote page resolves its own domain to
        // 127.0.0.1 and reads the page that way.
        const origin = req.headers.origin;
        const host = req.headers.host ?? "";
        const hostOk = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
        const originOk =
          origin == null ||
          origin === `http://127.0.0.1:${port}` ||
          origin === `http://localhost:${port}`;
        if (!hostOk || !originOk) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("forbidden: the dashboard answers only to this machine's browser");
          return;
        }
        // The space this request is aimed at — ?p=<name> from either the URL
        // or the form post back to the same URL (a form with no action
        // attribute posts to the current path AND query, which is how a
        // project view's forms keep their selection with zero hidden fields).
        const url = new URL(req.url, "http://127.0.0.1");
        const proj = currentProject(url.searchParams.get("p"));
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => {
            body += c;
            // A form post is a few hundred bytes. Anything much larger is not
            // this UI, and an unbounded read on a local socket is how a tiny
            // server becomes a memory bug.
            if (body.length > 64_000) req.destroy();
          });
          req.on("end", () => {
            const form = new URLSearchParams(body);
            let flash;
            try {
              flash = runAction(form.get("action"), form, proj);
            } catch (err) {
              flash = `FAILED: ${err.message}`;
            }
            // POST-then-redirect, so a refresh does not repeat the action —
            // and back to the SAME space the action ran in. A form that posts
            // from a task page carries `back`, so the verdict returns to the
            // draft it is about rather than to the board.
            const sel = proj.own ? "" : `p=${encodeURIComponent(proj.name)}&`;
            const back = form.get("back");
            const flashQ = `flash=${encodeURIComponent(String(flash).slice(0, 400))}`;
            const loc =
              back && back.startsWith("/") && !back.startsWith("//")
                ? `${back}${back.includes("?") ? "&" : "?"}${flashQ}`
                : `/?${sel}${flashQ}`;
            res.writeHead(303, { location: loc });
            res.end();
          });
          return;
        }
        // A dedicated page per job: /task/t5 is everything the bus knows about
        // t5 — full spec, full result, timeline, its worktree, its problems.
        const taskMatch = url.pathname.match(/^\/task\/([^/]+)$/);
        if (taskMatch) {
          const html = taskPageHtml(
            decodeURIComponent(taskMatch[1]),
            url.searchParams.get("flash"),
            proj
          );
          if (html === null) {
            res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
            res.end(
              `${PAGE_CSS}<p class="mut" style="padding:26px 30px">No task by that id on this bus. <a href="/${proj.own ? "" : `?p=${encodeURIComponent(proj.name)}`}">← back to the board</a></p>`
            );
          } else {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(html);
          }
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardHtml(url.searchParams.get("flash"), proj));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(String(err.message));
      }
    });
    // Loopback only. This exposes who is working on what and where their
    // worktrees are; it is for the machine it runs on.
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(`agent-bus dashboard: http://127.0.0.1:${port}\n`);
      process.stdout.write("Ctrl+C to stop.\n");
    });
    server.on("error", (err) => {
      process.stdout.write(
        err.code === "EADDRINUSE"
          ? `Port ${port} is busy — try: node server.mjs dashboard ${port + 1}\n`
          : `dashboard failed: ${err.message}\n`
      );
      process.exitCode = 1;
    });

    // Keep the written-to-disk page current while this window is open. Every
    // process that changes the bus rewrites state.json; this picks the change
    // up within a second, whichever process made it.
    refreshPage(true);
    fs.watchFile(STATE, { interval: 1000 }, () => refreshPage());
  });
}

/* ── entrypoint ───────────────────────────────────────────────────────────── */

// A module, not a running hub, when imported — though nothing imports this
// file: server.mjs spawns it precisely so it cannot.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runDashboard(Number(process.argv[2]) || 7777);
}