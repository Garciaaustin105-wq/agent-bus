/**
 * Where the tokens actually went.
 *
 * Reads the Claude Code session transcripts for this repo and reports what was
 * paid for. It exists because we twice "fixed" token usage by guessing — first
 * by trimming MCP connectors, then by blaming repeated source-file reads — and
 * both guesses were wrong by an order of magnitude. The numbers were sitting in
 * the transcripts the whole time.
 *
 * The one fact that reframes everything: a cache read is the model re-reading
 * the conversation so far, and it happens on EVERY turn. So the cost of putting
 * something into context is not its size. It is its size multiplied by every
 * turn that comes after it.
 *
 *   node tools/agent-bus/context-cost.cjs          summary for this repo
 *   node tools/agent-bus/context-cost.cjs --full   plus per-tool attribution
 *
 * No dependencies, by the same rule as the rest of the bus.
 *
 * THIS FILE IS NOW THE PRINTOUT AND NOTHING ELSE. The arithmetic moved to
 * token-watch.mjs so the hub window can render the same numbers continuously
 * (lane 2) instead of shelling out for a string and scraping it. A second
 * implementation of the scan is the thing most likely to drift, so there is
 * only one, and it is the one with the harness. What is left here is I/O and
 * formatting (A2).
 *
 * WHY THIS IS .cjs AND THE REST OF THE BUS IS .mjs. DeepSource's JavaScript
 * analyser reads a .mjs as a classic script, so a top-level import is a parse
 * error and the check goes red. .deepsource.toml tries to exclude every .mjs
 * and that does NOT suppress it for a file that is new in a pull request:
 * excluding at depth, by exact path, by basename, and moving the file to the
 * repo root were all tried on the grant checker (014a02c, 48cd87b, 68debf8,
 * b4e5b8f) and all failed — b4e5b8f claims the root works and 16dede6, the very
 * next commit, gave up and deleted the script. Do not repeat that sequence.
 *
 * CommonJS parses cleanly, so this file is analysed properly instead of being
 * excluded, and it can live here with the rest of the bus. package.json has no
 * "type" field, so CommonJS is this project's default anyway. The contract it
 * now uses is ESM, reached by a dynamic import inside main(): CommonJS can
 * await an ESM module, it just cannot `require` one, and the top of this file
 * stays a classic script either way.
 */

/* eslint-disable @typescript-eslint/no-require-imports --
   CommonJS is deliberate here and the reason is in the header above: it is what
   lets DeepSource parse this file instead of excluding it. Scoped to this file
   on purpose — an override in eslint.config.mjs would add a `files` pattern,
   and adding one makes eslint walk into the nested agent worktrees (31 problems
   became 36,476 the last time that happened). */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Claude Code stores transcripts under a directory named after the working
// directory with every non-alphanumeric character replaced by a dash. WHICH
// directory that is — the project root the bus serves — is resolved by
// server.mjs itself (AGENT_BUS_PROJECT, else the git root, else cwd), and this
// file imports that answer rather than deriving its own. The old inline guess,
// `__dirname/../..`, was true only while this file lived at
// <repo>/tools/agent-bus/ — a wrong root never throws, it silently reports the
// wrong project's transcripts, which is the packaging failure in miniature.
// The import is dynamic and inside main(): CommonJS cannot top-level-await,
// and this file must stay parseable as a classic script (see the header).
let REPO = null;
let SESSION_DIR = null;

const M = (n) => (n / 1e6).toFixed(2) + "M";
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : "0.0") + "%";

// How recently a transcript was written to before we will call its session
// live. A session that stopped an hour ago cannot act on any advice, and
// telling a person to compact a conversation nobody is in is how a useful
// report turns into noise. Transcripts are appended on every turn, so mtime is
// the liveness signal available here; the hub window has a better one (the bus
// knows who is registered) and uses that instead.
const LIVE_MS = 90 * 60 * 1000;

function readSessions() {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const file = path.join(SESSION_DIR, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        // Vanished between the listing and the stat. It is not live.
      }
      return { id: f.slice(0, 8), file, mtime };
    });
}

/** "4m", "3h", "2d" — how long ago, short enough for a table column. */
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.round(m / 60);
  return h < 48 ? h + "h" : Math.round(h / 24) + "d";
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return ""; // a session that vanished between the listing and the read
  }
}

async function main() {
  const tw = await import("./token-watch.mjs"); // the contract — see the header
  // The root the bus serves, resolved by the bus (see the comment above).
  ({ PROJECT_ROOT: REPO } = await import("./server.mjs"));
  SESSION_DIR = path.join(
    os.homedir(),
    ".claude",
    "projects",
    REPO.replace(/[^a-zA-Z0-9]/g, "-")
  );
  const full = process.argv.includes("--full");
  const sessions = readSessions();
  if (!sessions.length) {
    console.log("No session transcripts found at:\n  " + SESSION_DIR);
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  const scans = sessions
    .map((x) => ({ ...x, s: tw.scanTranscript(readText(x.file)), idle: now - x.mtime }))
    .filter((x) => x.s.turns);
  const T = tw.mergeScans(scans.map((x) => x.s));
  const all = T.read + T.write + T.input + T.output || 1;

  console.log("\nCONTEXT COST — " + path.basename(REPO));
  console.log("=".repeat(66));
  console.log(scans.length + " sessions, " + T.turns.toLocaleString() + " turns\n");
  console.log("  cache READ  (re-reading the conversation) " + M(T.read).padStart(9) + "  " + pct(T.read, all).padStart(6));
  console.log("  cache WRITE (new context added)           " + M(T.write).padStart(9) + "  " + pct(T.write, all).padStart(6));
  console.log("  input       (uncached)                    " + M(T.input).padStart(9) + "  " + pct(T.input, all).padStart(6));
  console.log("  output      (what was actually written)   " + M(T.output).padStart(9) + "  " + pct(T.output, all).padStart(6));

  console.log("\nCOST PER SESSION — context is re-read on every turn");
  console.log("-".repeat(66));
  console.log("  session    turns   mean ctx/turn         total re-read");
  for (const x of scans.slice().sort((a, b) => b.s.read - a.s.read).slice(0, 10)) {
    const avg = Math.round(x.s.read / x.s.turns);
    console.log(
      "  " + x.id,
      String(x.s.turns).padStart(7),
      avg.toLocaleString().padStart(14),
      M(x.s.read).padStart(21)
    );
  }

  // The headline. Images are few in number and enormous in cost.
  const img = T.images.tok;
  const imgN = T.images.n;
  const txt = T.texts.tok;
  const txtN = T.texts.n;
  if (imgN || txtN) {
    console.log("\nWHAT WAS READ INTO CONTEXT");
    console.log("-".repeat(66));
    console.log("  images/PDF  " + String(imgN).padStart(5) + " reads " + String(img).padStart(10) + " tok   avg " + (imgN ? Math.round(img / imgN) : 0));
    console.log("  text files  " + String(txtN).padStart(5) + " reads " + String(txt).padStart(10) + " tok   avg " + (txtN ? Math.round(txt / txtN) : 0));
    if (imgN && txtN && txt) {
      console.log("\n  One image costs about " + Math.round(img / imgN / (txt / txtN)) + " source-file reads.");
    }
  }

  const worst = Object.entries(T.files).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (worst.length) {
    console.log("\nMOST EXPENSIVE FILES EVER READ");
    console.log("-".repeat(66));
    for (const [k, v] of worst) {
      console.log("  " + k.slice(0, 44).padEnd(45) + String(v).padStart(9) + " tok");
    }
  }

  if (full) {
    const byTool = T.byTool;
    const tot = Object.values(byTool).reduce((a, b) => a + b, 0) || 1;
    console.log("\nTOOL RESULTS BY TOOL");
    console.log("-".repeat(66));
    for (const [k, v] of Object.entries(byTool).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log("  " + k.slice(0, 40).padEnd(41) + String(v).padStart(9) + "  " + pct(v, tot).padStart(6));
    }
  }

  // WHAT IS STILL ACTIONABLE, as opposed to where the money went. Everything
  // above is history and already spent. This is the only part a session that is
  // still running can do something about (lane 2a).
  // The baseline is drawn from EVERY session, live or not: what a fresh
  // session costs on this machine does not depend on who is awake. The advice
  // is offered only to the sessions that can still act on it.
  const w = tw.watch(scans.map((x) => ({ id: x.id, idle: x.idle, scan: x.s })));
  const live = w.rows.filter((r) => r.idle < LIVE_MS && r.assessment.level !== "ok");
  console.log("\nSESSIONS WORTH COMPACTING NOW");
  console.log("-".repeat(66));
  console.log(
    "  baseline " +
      w.baseline.tokens.toLocaleString() +
      " tok/turn — " +
      (w.baseline.measured
        ? "measured, median first turn of " + w.baseline.n + " sessions"
        : "assumed: " + w.baseline.why)
  );
  if (!live.length) {
    const over = w.rows.filter((r) => r.assessment.level !== "ok").length;
    console.log(
      "  no session has been written to in the last " +
        Math.round(LIVE_MS / 60000) +
        " minutes" +
        (over ? " — " + over + " ended above the baseline, and that is history now." : ".")
    );
  } else {
    console.log("  session    turns     ctx now    break-even   last turn");
    for (const r of live.slice(0, 10)) {
      const a = r.assessment;
      console.log(
        "  " + r.id,
        String(a.turns).padStart(7),
        a.contextTokens.toLocaleString().padStart(11),
        (a.breakEvenTurns.toFixed(1) + " turns").padStart(13),
        (ago(r.idle) + " ago").padStart(12),
        a.level === "compact" ? "  <-- compact" : ""
      );
    }
    console.log("\n  'ctx now' is the last turn; the table above it is the lifetime mean.");
    console.log("  They diverge once a session has been compacted — the mean still");
    console.log("  carries the peaks that compaction already removed.");
    console.log("\n  Break-even is how many more turns a session has to run before");
    console.log("  compacting now would have paid for itself. Nothing here acts on");
    console.log("  its own (C4) — the agent in that session decides.");
  }

  console.log("\n" + "=".repeat(66));
  console.log("What to do about it: docs/how-we-work.md → 'The context budget'\n");
}

main();
