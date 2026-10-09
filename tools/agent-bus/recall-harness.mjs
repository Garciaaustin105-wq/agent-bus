/**
 * The recall-and-care suite — note history, history(), search(), the health
 * verb, task dependencies and the caretaker, against a fresh temp bus (same
 * conventions as handoff-harness.mjs: mkdtemp HOME + AGENT_BUS_PROJECT before
 * the dynamic import; a real state file, never a mock; refusal strings read
 * back verbatim where they are contracts).
 *
 * The failure being pinned (docs/recall-and-care.md §1-6): the bus remembers
 * what a session leaves behind, but it could not help a next agent FIND that
 * knowledge (an overwrite erased the prior value outright and nothing searched
 * what was kept), could not tell anyone the bus itself was decaying (a cold
 * runner, a day-old queue, an untaken handoff sat invisible until a person
 * remembered to go look), and could not hold multi-step work apart (a task
 * whose dependency had not finished was claimable out of order). The
 * caretaker is the closing piece: the bus files its own findings, so a finding
 * nobody asked about still gets said.
 *
 *   node tools/agent-bus/recall-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Env the caretaker reads at import time must NOT be inherited from wherever
// this harness runs — the §6 checks need the caretaker on, keyed "hub".
delete process.env.HUB_AGENT_CARETAKER_MS;
delete process.env.HUB_AGENT_NAME;
delete process.env.HUB_AGENT_WATCH_MS;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-recall-"));
process.env.AGENT_BUS_PROJECT = HOME;

const { callTool, asActor, withState, claimNextTask } = await import("./server.mjs");
const {
  checkHealth,
  renderHealth,
  STALE_RUNNER_MS,
  QUEUED_BACKLOG_MS,
  DRAFT_PENDING_MS,
  UNTAKEN_HANDOFF_MS,
  OPEN_BLOCK_MS,
} = await import("./health.mjs");
const { runCaretaker } = await import("./agent.mjs");

// The bus's state dir for a project with no .git (module top-level resolved
// PROJECT_ROOT = HOME). Read back to inspect the STRUCTURED history — the
// verb responses are rendered text; the cap and the supersede stamps are state.
const STATE = path.join(HOME, ".agent-bus", "state.json");
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("no state file yet - the verb under test never wrote state (server.mjs side not landed?)");
    }
    throw err;
  }
};

// agent.mjs is imported in a child process for the env-at-import-time check.
const AGENT_PATH = fileURLToPath(new URL("./agent.mjs", import.meta.url));

/**
 * Replace the bus's working set wholesale. The history/health/caretaker tests
 * need DECAY — records whose timestamps say hours or days ago — and crafting
 * by hand is the only exact way to get it (no verb backdates; sleeping real
 * hours is not a test). Deleting untouched fields keeps one section's decay
 * from leaking into the next section's.
 */
const craftState = (fields) =>
  withState((state) => {
    for (const f of ["agents", "board", "handoffs", "archive", "blocks", "tasks", "messages", "caretakerSeen", "lock"]) {
      if (f in fields) state[f] = fields[f];
      else delete state[f];
    }
    state.agents = fields.agents ?? {};
    state.board = fields.board ?? {};
    state.tasks = fields.tasks ?? [];
    state.blocks = fields.blocks ?? [];
  });

/**
 * Ages are written as constants-plus-one-hour or constants-minus-one-minute
 * from health.mjs's OWN exported thresholds — never hardcoded numbers — so if
 * a threshold moves, the harness moves with it instead of silently pinning the
 * old one. The +1h keeps ages clearly past the line; -1min keeps them clearly
 * inside it.
 */
const DAYS_MS = 86_400_000;
const aged = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const beyond = (c) => c + 3_600_000;
const within = (c) => c - 60_000;

let pass = 0;
let fail = 0;
const check = (label, fn) => {
  try {
    fn();
    pass++;
    console.log(`ok  [${label}]`);
  } catch (e) {
    fail++;
    console.log(`FAIL [${label}] ${e.message}`);
  }
};
const say = (actor, verb, args) => asActor(actor, () => callTool(verb, args));

const refused = (fn, pattern) => {
  let msg;
  try {
    fn();
  } catch (e) {
    msg = String(e.message || e);
  }
  assert.ok(msg, "expected a refusal, got success");
  assert.match(msg, pattern, `the refusal must be a sentence, got: ${msg}`);
  return msg;
};

/* ══ §1 — note history: superseded facts are kept, not dropped ══════════════ */

check("two-notes-under-one-key-keep-the-prior-in-note-history", () => {
  say("note-w-1", "note", { key: "note-stack", value: "history value 1" });
  say("note-w-2", "note", { key: "note-stack", value: "history value 2" });
  const archive = readState().archive["note-stack"];
  assert.ok(Array.isArray(archive) && archive.length === 1, "one prior entry after one overwrite");
  assert.equal(archive[0].value, "history value 1", "the prior VALUE is kept verbatim");
  assert.equal(archive[0].by, "note-w-1", "the prior author is kept");
  assert.ok(!Number.isNaN(Date.parse(archive[0].at)), "the prior set-at is kept");
  assert.equal(archive[0].supersededBy, "note-w-2", "names who replaced it");
  assert.ok(!Number.isNaN(Date.parse(archive[0].supersededAt)), "the supersede is stamped");
});

check("the-note-overwrite-points-at-history-in-its-own-reply", () => {
  const out = say("note-w-3", "note", { key: "note-stack", value: "history value 3" });
  assert.ok(out.includes("kept in history"), `names where the old value went: ${out}`);
  assert.ok(out.includes('history("note-stack")'), `names the verb that reads it back: ${out}`);
});

check("seven-overwrites-cap-note-history-at-five-newest-first", () => {
  // A fresh key: one initial write, then SEVEN overwrites (writes 2..8). Every
  // overwrite keeps the prior entry; the 8 writes produce 7 kept entries,
  // capped to 5 — so the oldest kept is the PRIOR OF WRITE 4… no: the cap
  // keeps the five NEWEST kept entries, which are the priors of writes 4..8 —
  // values 3..7. Entries for values 1 and 2 (the first two writes) have
  // dropped out of the cap: the oldest survivor is the 3rd write.
  say("cap-w-1", "note", { key: "cap-stack", value: "cap value 1" });
  for (let n = 2; n <= 8; n++) {
    say(`cap-w-${n}`, "note", { key: "cap-stack", value: `cap value ${n}` });
  }
  const archive = readState().archive["cap-stack"];
  assert.equal(archive.length, 5, "the last-5 cap holds after seven overwrites");
  assert.equal(archive[0].value, "cap value 7", `newest first — the entry the last overwrite replaced: ${archive[0].value}`);
  assert.equal(
    archive[4].value,
    "cap value 3",
    `the oldest kept is the 3rd write — writes 1-2 fell out of the cap: ${archive[4].value}`
  );
  for (let i = 0; i < archive.length; i++) {
    assert.ok(archive[i].supersededAt, `kept entry ${i} stamps its supersede`);
    assert.ok(archive[i].supersededBy, `kept entry ${i} names its superseder`);
  }
});

// The slug algorithm is pinned on purpose: the archive key is derived from the
// reported claim, and a harness that computed it differently pins nothing.
const missSlug = (claimed) =>
  claimed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-") || "unnamed";

const MISS_CLAIMED = "the recall harness claimed the archive cap did not exist";
const MISS_KEY = "miss-" + missSlug(MISS_CLAIMED);

check("a-miss-filed-twice-keeps-the-prior-report-in-note-history", () => {
  const first = say("miss-m", "miss", { claimed: MISS_CLAIMED, truth: "it did exist; the harness had read no state at that point." });
  assert.ok(first.includes(`Filed "${MISS_KEY}"`), "the first miss is filed under its subject key");
  say("miss-m", "miss", { claimed: MISS_CLAIMED, truth: "it exists; the second filing proves the recurrence path." });
  const state = readState();
  const archive = state.archive[MISS_KEY];
  assert.ok(archive && archive.length === 1, "the PRIOR report is kept in the archive under miss-<slug>");
  assert.ok(archive[0].value.includes("CLAIMED: " + MISS_CLAIMED), "the prior report's pairing is readable, not just countable");
  assert.equal(state.board[MISS_KEY].seen, 2, "the active entry counts the filings");
  assert.equal(state.board[MISS_KEY].miss, true, "the active entry stays a miss");
});

check("a-recurring-miss-says-so-in-its-own-value", () => {
  assert.ok(readState().board[MISS_KEY].value.includes("2x — RECURRING"), "recurrence is visible in the rendered value");
});

/* ══ §2 — history(): read the stack under a key ═════════════════════════════ */

check("history-without-a-key-is-refused-verbatim", () => {
  const msg = refused(() => say("stack-reader", "history", {}), /key/i);
  assert.equal(msg, "A `key` is required — the stack you mean is a named one.");
});

check("history-of-an-unknown-key-says-so-exactly", () => {
  // A read-only empty answer, not an error — zero history is a normal state.
  const out = say("stack-reader", "history", { key: "never-written" });
  assert.equal(out, 'Nothing was ever written under "never-written".');
});

check("history-renders-the-active-note-verbatim", () => {
  const out = say("stack-reader", "history", { key: "note-stack" });
  const board = readState().board["note-stack"];
  assert.ok(out.startsWith(`ACTIVE — set ${board.at} by ${board.by}`), `the active entry is named first: ${out.slice(0, 90)}`);
  assert.ok(out.includes("history value 3"), "the ACTIVE value is in the answer verbatim");
  assert.ok(out.includes("NOTE HISTORY (2)"), "the kept note stack is in the answer");
});

check("a-handoff-key-renders-handoff-history-with-its-supersede-lines", () => {
  say("stack-hw-1", "handoff", { key: "stack-handoff", summary: "world one", nextStep: "step one" });
  say("stack-hw-2", "handoff", { key: "stack-handoff", summary: "world two", nextStep: "step two" });
  const out = say("stack-reader", "history", { key: "stack-handoff" });
  assert.ok(out.startsWith("ACTIVE — set "), `the active entry is named first: ${out.slice(0, 40)}`);
  assert.ok(out.includes("by stack-hw-2"), "the active entry names its writer");
  assert.ok(out.includes("HANDOFF HISTORY (1)"), `the handoff stack lives in its own section: ${out}`);
  assert.ok(
    /#1 — set .* by stack-hw-1, superseded .* by stack-hw-2/.test(out),
    "each kept entry names its writing AND its superseding"
  );
});

check("a-note-stack-under-a-handoff-key-stays-in-note-history", () => {
  // Two stores can hold history for one key — note overwrites went to
  // `archive`, then a handoff inherited the key — and history() renders each
  // stack under its own heading, never merged into one list.
  say("mix-w-1", "note", { key: "mixed-stack", value: "mixed note one" });
  say("mix-w-2", "note", { key: "mixed-stack", value: "mixed note two" });
  say("mix-w-3", "handoff", { key: "mixed-stack", summary: "mixed world", nextStep: "mixed step" });
  const out = say("stack-reader", "history", { key: "mixed-stack" });
  assert.ok(out.includes("NOTE HISTORY (1)"), `the kept note stack is NOT lost or merged: ${out}`);
  assert.ok(out.includes("mixed note one"), "the note stack's value is readable");
  assert.match(out, /#1 — set .* by mix-w-1, superseded .* by mix-w-2/, "the kept note names who wrote it and who superseded it");
  assert.ok(out.includes("HANDOFF HISTORY (1)"), "the handoff that inherited the key has its own stack");
  assert.ok(
    out.indexOf("HANDOFF HISTORY") < out.indexOf("NOTE HISTORY"),
    "the two stores remain two sections in the answer"
  );
});

/* ══ §3 — search(): check instead of recall ═════════════════════════════════ */

check("an-empty-query-is-refused-verbatim", () => {
  const msg = refused(() => say("searcher", "search", { query: "   " }), /query/i);
  assert.equal(msg, '`query` is required — an empty search would read as "everything is a match".');
});

check("an-active-value-hit-is-labelled-active-and-shown", () => {
  say("search-a", "note", { key: "vein-report", value: "zircon crystals date the vein at 40 million years" });
  const out = say("searcher", "search", { query: "zircon" });
  assert.ok(
    out.includes("vein-report (active) — zircon crystals date the vein at 40 million years"),
    `the matched line is shown: ${out}`
  );
});

check("an-active-key-hit-labels-itself-and-shows-the-value-s-first-line", () => {
  // The needle must live in the KEY only — the value's later lines are
  // needle-free on purpose, so the entry can only be filed once, via its key.
  say("search-b", "note", { key: "wulfenite-index", value: "first line for a key hit\nsecond line is filler" });
  const out = say("searcher", "search", { query: "wulfenite" });
  assert.ok(out.includes("wulfenite-index (active, key)"), `the key hit says it matched the KEY: ${out}`);
  assert.ok(out.includes("first line for a key hit"), "a key hit shows the value's first line, not a matched value line");
  assert.ok(!out.includes("second line is filler"), "and does not file the same entry twice");
});

check("a-handoff-history-hit-is-labelled-with-its-depth", () => {
  say("search-h-1", "handoff", { key: "sift-handoff", summary: "the pyromorphite seam was mapped, next the smelter audit", nextStep: "audit the smelter" });
  say("search-h-2", "handoff", { key: "sift-handoff", summary: "second state; the seam needle moved on", nextStep: "step 2" });
  const hist = readState().handoffs["sift-handoff"];
  const out = say("searcher", "search", { query: "pyromorphite" });
  assert.ok(
    out.includes(`sift-handoff (handoff history #1, set ${hist[0].at})`),
    `the hit names which kept entry and when it was set: ${out}`
  );
});

check("a-note-history-hit-is-labelled-with-its-depth", () => {
  say("search-n-1", "note", { key: "sift-notes", value: "a malachite cache sat at the north adit" });
  say("search-n-2", "note", { key: "sift-notes", value: "the cache was reclassified as goethite" });
  const hist = readState().archive["sift-notes"];
  const out = say("searcher", "search", { query: "malachite" });
  assert.ok(
    out.includes(`sift-notes (note history #1, set ${hist[0].at})`),
    `a superseded note is searchable at its depth: ${out}`
  );
});

// Five notes that each match one needle — only the count is pinned here, so no
// key or other section can pollute it.
for (let n = 1; n <= 5; n++) {
  say(`search-l-${n}`, "note", { key: `cache-row-${n}`, value: `limonite seam ${n} of five` });
}

check("the-limit-cuts-the-matches-exactly", () => {
  const out = say("searcher", "search", { query: "limonite", limit: 3 });
  assert.ok(out.startsWith("3 match(es) for"), `the count line leads: ${out}`);
  assert.equal(out.split("\n").filter((l) => l.startsWith("  ")).length, 3, "exactly LIMIT result lines");
});

check("the-default-cap-returns-every-match-when-under-it", () => {
  const out = say("searcher", "search", { query: "limonite" });
  assert.ok(out.startsWith("5 match(es) for"), `five matches under the default cap all come back: ${out}`);
});

check("zero-hits-is-a-named-count-not-an-error", () => {
  const s = readState();
  const scanned =
    Object.keys(s.board ?? {}).length +
    Object.values(s.handoffs ?? {}).reduce((n, h) => n + h.length, 0) +
    Object.values(s.archive ?? {}).reduce((n, h) => n + h.length, 0);
  const out = say("searcher", "search", { query: "howlite needle that matches nothing" });
  assert.ok(out.startsWith("No matches for"), `zero hits is a normal answer: ${out}`);
  assert.ok(
    out.includes(`(scanned ${scanned} active and kept entries)`),
    `the answer says what it scanned, exactly: ${out}`
  );
});

/* ══ §5 — depends_on: the queue learns order ════════════════════════════════ */

const findTask = (id) => readState().tasks.find((t) => t.id === id);

check("a-task-queues-bare-first-so-dependencies-have-a-known-id-to-name", () => {
  const out = say("dep-a", "task_add", { lane: "dep", title: "first dep work", prompt: "the whole spec" });
  assert.ok(out.includes("Queued t1 on lane"), `the id is in the reply: ${out}`);
  assert.ok(findTask("t1"), "the task exists");
});

check("an-unknown-dependency-id-is-refused-with-the-known-ids-listed", () => {
  const msg = refused(
    () => say("dep-b", "task_add", { lane: "dep", title: "typo'd dep", prompt: "p", depends_on: ["t999"] }),
    /Unknown dependency id/
  );
  assert.ok(msg.includes("t999"), `names the offending id: ${msg}`);
  assert.ok(msg.includes("Known recent task ids") && msg.includes("t1"), `lists what WAS known: ${msg}`);
});

check("a-non-array-dependency-is-refused-verbatim", () => {
  const msg = refused(
    () => say("dep-b", "task_add", { lane: "dep", title: "one string", prompt: "p", depends_on: "t1" }),
    /depends_on/
  );
  assert.equal(msg, "`depends_on` must be an array of task ids.");
});

check("more-than-ten-dependencies-is-refused", () => {
  // Eleven UNIQUE ids: the set is deduped BEFORE the cap, so one id repeated
  // eleven times would slip past the cap and hit the unknown-id refusal
  // instead — the cap is about the shape of the request.
  const ids = ["t1"];
  for (let n = 2; n <= 11; n++) ids.push(`t-nonexistent-${n}`);
  const msg = refused(
    () => say("dep-b", "task_add", { lane: "dep", title: "a list", prompt: "p", depends_on: ids }),
    /More than 10 dependencies/
  );
  assert.ok(msg.includes("not a task"), `the refusal says why: ${msg}`);
});

check("duplicate-dependency-ids-are-deduped-in-the-stored-task", () => {
  const out = say("dep-c", "task_add", { lane: "dep", title: "dependent work", prompt: "the dependent spec", depends_on: ["t1", "t1"] });
  assert.ok(out.includes("Blocked until t1 is done"), `the reply names the wait: ${out}`);
  assert.deepEqual(findTask("t2").depends_on, ["t1"], "no duplicates ride along in state");
});

check("tasks-renders-the-unmet-dependency-in-the-task-s-own-line", () => {
  const out = say("dep-reader", "tasks", {});
  assert.match(out, /BLOCKED — waiting on t1/, `the skip is visible, not silent: ${out}`);
  assert.ok(out.includes("· deps t1"), "and the dep list is there to read too");
});

check("claim-skips-the-blocked-task-and-claims-the-unblocked-one", () => {
  const claimed = claimNextTask("dep");
  assert.ok(claimed, "the queue has claimable work");
  assert.equal(claimed.id, "t1", "the UNBLOCKED task is claimed");
  assert.equal(findTask("t2").status, "queued", "the blocked dependent sits still");
});

check("a-queue-of-only-blocked-work-polls-empty", () => {
  // t1 is running now, so t2's only dep remains unmet: the claim must return
  // null rather than hand out the dependent.
  const claimed = claimNextTask("dep");
  assert.equal(claimed, null, "a blocked task is never claimed");
  assert.equal(findTask("t2").status, "queued", "and it never moved to running by the side door");
});

check("a-done-dependency-unlocks-its-dependent", () => {
  withState((state) => {
    state.tasks.find((t) => t.id === "t1").status = "done";
  });
  const out = say("dep-reader", "tasks", {});
  const t2line = out.split("\n").find((l) => l.startsWith("t2 ["));
  assert.ok(t2line, `the dependent is rendered: ${out}`);
  assert.ok(!t2line.includes("BLOCKED"), `a done dep unblocks: ${t2line}`);
  const claimed = claimNextTask("dep");
  assert.ok(claimed && claimed.id === "t2", "now the dependent is claimable");
});

/* ══ §4 — health: the bus checks itself, as data ════════════════════════════ */

/* ── the pure contract (unit): craft plain state, call checkHealth ── */

check("a-clean-state-yields-no-findings-and-names-what-was-checked", () => {
  const NOW = Date.now();
  const now = () => new Date(NOW).toISOString();
  const clean = {
    agents: { "on-the-bus": { lastSeen: now() } },
    tasks: [{ id: "s1", lane: "local", status: "queued", by: "cli", at: now() }],
    // Counted as board notes even when one is a TAKEN handoff — a taken
    // handoff is not decay; the untaken one is (checked separately below).
    board: {
      "note-one": { value: "v", by: "x", at: now() },
      "note-two": { value: "v", by: "x", at: now() },
      "a-handoff": { kind: "handoff", value: "v", by: "x", at: now(), taken: [{ by: "someone", at: now() }] },
    },
    blocks: [],
    // The deliberate absence: a LIVE tree lock produces NO finding — its
    // liveness is process-proven, so a live claim is a claim, not decay.
    lock: { path: "/repo", holder: "on-the-bus", holderPid: null, reason: "mid-edit", claimedAt: now(), expiresAt: new Date(NOW + 600_000).toISOString() },
  };
  const findings = checkHealth(clean, { now: NOW });
  assert.deepEqual(findings, [], `nothing aged becomes nothing found: ${JSON.stringify(findings)}`);
  const text = renderHealth(clean, { now: NOW });
  assert.ok(text.startsWith("No findings. "), `clean runs open with the no-findings line: ${text}`);
  assert.equal(
    text,
    "No findings. (1 agent(s) present, 1 queued, 3 note(s) on the board)",
    "the quiet names what it stayed silent ABOUT"
  );
});

check("a-cold-runner-behind-a-running-task-is-a-stale-runner-finding", () => {
  const NOW = Date.now();
  const state = {
    agents: { "silent-runner": { lastSeen: new Date(NOW - beyond(STALE_RUNNER_MS)).toISOString() } },
    tasks: [{ id: "tr1", lane: "local", status: "running", runner: "silent-runner", startedAt: new Date(NOW).toISOString(), at: new Date(NOW).toISOString() }],
  };
  const findings = checkHealth(state, { now: NOW });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "stale-runner");
  assert.equal(findings[0].subject, "tr1", "the subject is a stable task id — the caretaker dedupes on it");
  assert.ok(findings[0].detail.includes("silent-runner"), `the finding names the runner: ${findings[0].detail}`);
});

check("a-running-task-with-no-session-record-judges-by-its-held-duration", () => {
  const NOW = Date.now();
  const state = {
    agents: {},
    tasks: [{ id: "tr2", lane: "local", status: "running", runner: "vanished", startedAt: new Date(NOW - beyond(STALE_RUNNER_MS)).toISOString(), at: new Date(NOW).toISOString() }],
  };
  const findings = checkHealth(state, { now: NOW });
  assert.equal(findings[0].kind, "stale-runner");
  assert.ok(
    findings[0].detail.includes("no longer on the bus"),
    `a pruned runner gets the honest branch, not a guess: ${findings[0].detail}`
  );
});

check("an-aged-queued-task-is-a-queued-backlog-finding", () => {
  const NOW = Date.now();
  const state = {
    tasks: [{ id: "tq1", lane: "local", status: "queued", at: new Date(NOW - beyond(QUEUED_BACKLOG_MS)).toISOString() }],
  };
  const findings = checkHealth(state, { now: NOW });
  assert.equal(findings[0].kind, "queued-backlog");
  assert.equal(findings[0].subject, "tq1");
  assert.ok(findings[0].detail.includes("tq1") && findings[0].detail.includes("local"), `the lane is named: ${findings[0].detail}`);
});

check("an-aged-draft-is-a-draft-pending-finding", () => {
  const NOW = Date.now();
  const state = {
    tasks: [{ id: "td1", lane: "local", status: "draft", at: new Date(NOW - beyond(DRAFT_PENDING_MS)).toISOString(), doneAt: new Date(NOW - beyond(DRAFT_PENDING_MS)).toISOString() }],
  };
  const findings = checkHealth(state, { now: NOW });
  assert.equal(findings[0].kind, "draft-pending");
  assert.equal(findings[0].subject, "td1");
});

check("an-untaken-handoff-is-an-untaken-handoff-finding", () => {
  const NOW = Date.now();
  const state = {
    board: {
      "idle-handoff": {
        kind: "handoff", value: "HANDOFF", by: "gone", setAt: new Date(NOW - beyond(UNTAKEN_HANDOFF_MS)).toISOString(), at: new Date(NOW - beyond(UNTAKEN_HANDOFF_MS)).toISOString(), taken: [],
      },
    },
  };
  const findings = checkHealth(state, { now: NOW });
  assert.equal(findings[0].kind, "untaken-handoff");
  assert.equal(findings[0].subject, "idle-handoff", "the subject is the BOARD KEY");
  assert.ok(findings[0].detail.includes("gone"), `the finding names who left it: ${findings[0].detail}`);
});

check("an-open-block-is-an-open-block-finding", () => {
  const NOW = Date.now();
  const state = { blocks: [{ id: "b7", by: "stuck-one", what: "no stripe access", needed: "keys", status: "open", at: new Date(NOW - beyond(OPEN_BLOCK_MS)).toISOString() }] };
  const findings = checkHealth(state, { now: NOW });
  assert.equal(findings[0].kind, "open-block");
  assert.equal(findings[0].subject, "b7", "the subject is the block id");
});

check("everything-inside-its-threshold-is-silent—thresholds-come-from-health-mjs", () => {
  const NOW = Date.now();
  const state = {
    agents: { "quiet-runner": { lastSeen: new Date(NOW - within(STALE_RUNNER_MS)).toISOString() } },
    tasks: [
      { id: "ok-running", lane: "local", status: "running", runner: "quiet-runner", startedAt: new Date(NOW).toISOString(), at: new Date(NOW).toISOString() },
      { id: "ok-queued", lane: "local", status: "queued", at: new Date(NOW - within(QUEUED_BACKLOG_MS)).toISOString() },
      { id: "ok-draft", lane: "local", status: "draft", at: new Date(NOW - within(DRAFT_PENDING_MS)).toISOString(), doneAt: new Date(NOW - within(DRAFT_PENDING_MS)).toISOString() },
    ],
    board: { "young-handoff": { kind: "handoff", value: "v", by: "x", at: new Date(NOW - within(UNTAKEN_HANDOFF_MS)).toISOString(), taken: [] } },
    blocks: [{ id: "b2", by: "x", what: "w", needed: "n", status: "open", at: new Date(NOW - within(OPEN_BLOCK_MS)).toISOString() }],
  };
  // Every record sits one minute INSIDE its own constant, so nothing fires —
  // the five aged variants above pin where the lines actually are.
  const findings = checkHealth(state, { now: NOW });
  assert.deepEqual(findings, [], `nothing crossed its threshold: ${JSON.stringify(findings)}`);
});

check("findings-come-back-grouped-in-the-contract-s-table-order", () => {
  const NOW = Date.now();
  const state = {
    agents: { "cold-runner": { lastSeen: new Date(NOW - beyond(STALE_RUNNER_MS)).toISOString() } },
    tasks: [
      { id: "tr1", lane: "local", status: "running", runner: "cold-runner", startedAt: new Date(NOW).toISOString(), at: new Date(NOW).toISOString() },
      { id: "tq1", lane: "local", status: "queued", at: new Date(NOW - beyond(QUEUED_BACKLOG_MS)).toISOString() },
      { id: "td1", lane: "local", status: "draft", at: new Date(NOW - beyond(DRAFT_PENDING_MS)).toISOString(), doneAt: new Date(NOW - beyond(DRAFT_PENDING_MS)).toISOString() },
    ],
    board: { "idle-handoff": { kind: "handoff", value: "v", by: "gone", at: new Date(NOW - beyond(UNTAKEN_HANDOFF_MS)).toISOString(), taken: [] } },
    blocks: [{ id: "b7", by: "x", what: "w", needed: "n", status: "open", at: new Date(NOW - beyond(OPEN_BLOCK_MS)).toISOString() }],
  };
  assert.deepEqual(
    checkHealth(state, { now: NOW }).map((f) => f.kind),
    ["stale-runner", "queued-backlog", "draft-pending", "untaken-handoff", "open-block"],
    "one check, one finding, in the table's order"
  );
});

/* ── the rendered contract — the same findings through the `health` verb ── */

check("the-health-verb-renders-every-decayed-kind", () => {
  const NOW = Date.now();
  craftState({
    // The stale runner's agent record must survive the verb's pruneAgents: a
    // pid the OS can still see (this harness process) plus this host — the
    // same proof a live session carries.
    agents: { "silent-runner": { sessionKey: "k", lane: "cli", pid: process.pid, host: os.hostname(), lastSeen: new Date(NOW - beyond(STALE_RUNNER_MS)).toISOString() } },
    tasks: [
      { id: "tr1", lane: "local", title: "cold claim", prompt: "p", status: "running", runner: "silent-runner", by: "cli", startedAt: new Date(NOW).toISOString(), at: new Date(NOW).toISOString() },
      { id: "tq1", lane: "local", title: "old queue", prompt: "p", status: "queued", by: "cli", at: new Date(NOW - beyond(QUEUED_BACKLOG_MS)).toISOString() },
      { id: "td1", lane: "local", title: "old draft", prompt: "p", status: "draft", by: "cli", at: new Date(NOW - beyond(DRAFT_PENDING_MS)).toISOString(), doneAt: new Date(NOW - beyond(DRAFT_PENDING_MS)).toISOString() },
    ],
    board: { "idle-handoff": { kind: "handoff", value: "HANDOFF (set ...)", setAt: new Date(NOW - beyond(UNTAKEN_HANDOFF_MS)).toISOString(), at: new Date(NOW - beyond(UNTAKEN_HANDOFF_MS)).toISOString(), by: "gone", taken: [] } },
    blocks: [{ id: "b7", by: "someone", what: "no stripe access", needed: "keys", status: "open", at: new Date(NOW - beyond(OPEN_BLOCK_MS)).toISOString() }],
  });
  const out = say("watcher", "health", {});
  assert.ok(out.startsWith("5 finding(s):"), `the count leads: ${out}`);
  for (const [kind, subject] of [
    ["STALE-RUNNER", "tr1"],
    ["QUEUED-BACKLOG", "tq1"],
    ["DRAFT-PENDING", "td1"],
    ["UNTAKEN-HANDOFF", "idle-handoff"],
    ["OPEN-BLOCK", "b7"],
  ]) {
    const line = out.split("\n").find((l) => l.includes(` ${kind} — `));
    assert.ok(line, `the ${kind} finding is rendered: ${out}`);
    assert.ok(line.includes(subject), `${kind} names its subject: ${line}`);
  }
});

check("the-health-verb-through-a-clean-state-renders-the-counted-quiet", () => {
  const NOW = Date.now();
  craftState({
    agents: { "on-the-bus": { lastSeen: new Date(NOW).toISOString() } },
    tasks: [{ id: "s1", lane: "local", title: "fresh", prompt: "p", status: "queued", by: "cli", at: new Date(NOW).toISOString() }],
    board: {
      "note-one": { value: "v", by: "x", at: new Date(NOW).toISOString() },
      "note-two": { value: "v", by: "x", at: new Date(NOW).toISOString() },
    },
    lock: { path: "/repo", holder: "on-the-bus", holderPid: null, reason: "mid-edit", claimedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 600_000).toISOString() },
  });
  const out = say("watcher", "health", {});
  assert.equal(out, "No findings. (1 agent(s) present, 1 queued, 2 note(s) on the board)");
});

/* ══ §6 — the caretaker: the bus files its own findings ═════════════════════ */

// The finding detail the caretaker files verbatim, rebuilt from health.mjs's
// exported constant — if the threshold moves, this string moves with it.
const QUEUED_HOURS = QUEUED_BACKLOG_MS / 3_600_000;
const queuedDetail = `task t9 (local) has been queued for over ${QUEUED_HOURS} hours — no runner picked it up.`;

check("the-caretaker-files-a-new-finding-under-caretaker-kind-subject", () => {
  craftState({
    tasks: [{ id: "t9", lane: "local", title: "three days queued", prompt: "the spec", status: "queued", by: "steward", at: aged(3 * DAYS_MS) }],
  });
  const log = [];
  runCaretaker(log);
  const state = readState();
  const key = "caretaker-queued-backlog-t9";
  const note = state.board[key];
  assert.ok(note, `the board gained the caretaker note: ${JSON.stringify(log)}`);
  assert.equal(note.by, "hub", "filed by the hub agent's own registered name");
  assert.ok(note.value.startsWith(queuedDetail), `the finding detail is filed verbatim, first: ${note.value}`);
  assert.ok(note.value.includes("first seen "), `the detection timestamp is preserved in the note: ${note.value}`);
  assert.ok(note.value.includes("nothing here auto-applies"), "the note says it files and stops");
  assert.ok(log.some((l) => l.includes(key)), `the run's log says what it filed: ${JSON.stringify(log)}`);
  const seen = state.caretakerSeen[key];
  assert.ok(seen && seen.detectedAt && seen.filedAt, "what the caretaker has seen lives beside the state file");
});

check("a-repeat-run-over-a-standing-finding-is-silent", () => {
  const log = [];
  runCaretaker(log);
  assert.deepEqual(log, [], `nothing new is filed while the finding holds and is fresh: ${JSON.stringify(log)}`);
});

check("a-finding-still-standing-a-day-later-refiles-with-still", () => {
  const key = "caretaker-queued-backlog-t9";
  const firstSeen = readState().caretakerSeen[key].detectedAt;
  withState((state) => {
    state.caretakerSeen[key].filedAt = aged(25 * 3_600_000); // filed once; a day old now
  });
  const log = [];
  runCaretaker(log);
  const note = readState().board[key];
  assert.ok(note.value.startsWith(`STILL ${queuedDetail}`), `the re-file is marked still-standing: ${note.value}`);
  assert.ok(note.value.includes(`first seen ${firstSeen}`), `the ORIGINAL detection survives the re-file: ${note.value}`);
  assert.ok(log.some((l) => l.includes("(re-nudge)")), `the log names the re-nudge: ${JSON.stringify(log)}`);
});

check("a-finding-that-clears-is-filed-as-cleared-under-the-same-key", () => {
  const key = "caretaker-queued-backlog-t9";
  const firstSeen = readState().caretakerSeen[key].detectedAt;
  withState((state) => {
    state.tasks = []; // the task is gone — the finding no longer holds
    state.caretakerSeen[key].filedAt = new Date().toISOString(); // still re-filed daily; now it clears immediately
  });
  const log = [];
  runCaretaker(log);
  const state = readState();
  assert.ok(state.board[key].value.startsWith("Cleared — the finding first seen "), `the resolution record: ${state.board[key].value}`);
  assert.ok(state.board[key].value.includes(firstSeen), "the cleared note carries when the finding was first seen");
  assert.ok(log.some((l) => l.includes("(cleared)")), `the log says it: ${JSON.stringify(log)}`);
  assert.equal(state.caretakerSeen[key], undefined, "the seen-tracking entry is dropped with it");
});

/* ── §6 routing — the poke goes to the owner, not the person ═══════════════ */

check("a-stale-runner-finding-routes-to-the-runners-inbox", () => {
  craftState({
    agents: { lane_c: { lane: "fixing", lastSeen: aged(beyond(STALE_RUNNER_MS)), registeredAt: aged(3 * DAYS_MS) } },
    tasks: [{ id: "t2", lane: "local", title: "stuck mid-run", prompt: "the spec", status: "running", startedAt: aged(3 * 3_600_000), runner: "lane_c", by: "steward", at: aged(4 * 3_600_000) }],
  });
  const log = [];
  runCaretaker(log);
  const state = readState();
  const routed = (state.messages ?? []).filter((m) => m.to === "lane_c" && m.from === "hub");
  assert.equal(routed.length, 1, `exactly one message to the owner: ${JSON.stringify(state.messages)}`);
  assert.ok(routed[0].text.startsWith("CARETAKER — "), `a caretaker message, labelled: ${routed[0].text}`);
  assert.ok(routed[0].text.includes("t2"), `it names the thing: ${routed[0].text}`);
  assert.ok(routed[0].readBy.length === 0, "unread — it arrives on the owner's next bus read");
  assert.ok(state.board["caretaker-stale-runner-t2"], "the note is still the durable record");
  assert.ok(log.some((l) => l.includes("routed")), `the log says the routing: ${JSON.stringify(log)}`);
});

check("a-finding-whose-owner-is-not-on-the-bus-stays-note-only", () => {
  // Same decayed task, but the runner never registered (or was pruned): a
  // message to a dead name would sit unread forever. Note alone is the fall.
  craftState({
    agents: {},
    tasks: [{ id: "t2", lane: "local", title: "stuck mid-run", prompt: "the spec", status: "running", startedAt: aged(3 * 3_600_000), runner: "lane_c", by: "steward", at: aged(4 * 3_600_000) }],
  });
  const log = [];
  runCaretaker(log);
  const state = readState();
  assert.ok(state.board["caretaker-stale-runner-t2"], "the record exists");
  assert.deepEqual(state.messages ?? [], [], `and nothing was sent to a pruned name: ${JSON.stringify(state.messages)}`);
  assert.ok(!log.some((l) => l.includes("routed")), `no routing claimed in the log: ${JSON.stringify(log)}`);
});

check("an-untaken-handoff-routes-to-its-author-when-the-author-is-here", () => {
  craftState({
    agents: { driver_a: { lane: "camera bench", lastSeen: aged(60_000), registeredAt: aged(3 * DAYS_MS) } },
    board: { "handoff-cam": { kind: "handoff", key: "handoff-cam", summary: "the detector works", nextStep: "ship it", by: "driver_a", at: aged(3 * DAYS_MS), taken: [], value: "HANDOFF (set long ago by driver_a)" } },
  });
  const log = [];
  runCaretaker(log);
  const state = readState();
  const routed = (state.messages ?? []).filter((m) => m.to === "driver_a");
  assert.equal(routed.length, 1, `the author was poked: ${JSON.stringify(state.messages)}`);
  assert.ok(routed[0].text.includes("handoff-cam"), `it names the handoff: ${routed[0].text}`);
});

check("HUB_AGENT_CARETAKER_MS-0-disables-the-caretaker", () => {
  // CARETAKER_ON is read at import time, so the disable is pinned in a child
  // process: spawn a tiny script that dynamic-imports agent.mjs with the env
  // set and runs the caretaker against the same decayed task. The checks
  // above prove that very state files when the caretaker is on.
  craftState({
    tasks: [{ id: "t9", lane: "local", title: "three days queued", prompt: "the spec", status: "queued", by: "steward", at: aged(3 * DAYS_MS) }],
  });
  const probe = path.join(HOME, "caretaker-off-probe.mjs");
  fs.writeFileSync(
    probe,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'const HOME = process.env.AGENT_BUS_PROJECT;',
      'const { runCaretaker } = await import(pathToFileURL(process.env.PROBE_AGENT_PATH));',
      'const log = [];',
      'runCaretaker(log);',
      'const state = JSON.parse(fs.readFileSync(path.join(HOME, ".agent-bus", "state.json"), "utf8"));',
      'const keys = Object.keys(state.board ?? {}).filter((k) => k.startsWith("caretaker-"));',
      'console.log(JSON.stringify({ filed: log.length, keys }));',
      'process.exit(keys.length || log.length ? 1 : 0);',
    ].join("\n")
  );
  const env = { ...process.env };
  delete env.HUB_AGENT_CARETAKER_MS;
  delete env.HUB_AGENT_NAME;
  delete env.HUB_AGENT_WATCH_MS;
  const r = spawnSync(process.execPath, [probe], {
    cwd: HOME,
    env: { ...env, AGENT_BUS_PROJECT: HOME, HUB_AGENT_CARETAKER_MS: "0", PROBE_AGENT_PATH: AGENT_PATH },
    encoding: "utf8",
  });
  const out = JSON.parse(String(r.stdout || "{}"));
  assert.deepEqual(out, { filed: 0, keys: [] }, `the disabled caretaker files nothing: ${JSON.stringify(out)} ${r.stderr}`);
  assert.equal(r.status, 0, "and the probe exits green");
  assert.equal(readState().tasks.length, 1, "the decaying task is untouched — it files and stops");
});

fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);