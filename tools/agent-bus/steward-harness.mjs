/**
 * The steward's triage policy, against an in-memory store and a FAKE
 * classifier — no model, no network. The failure being pinned: a problem
 * reported to the bus must never be silently dropped. Every hard path ends in
 * a FILED note (defect, duplicate, or unclear-with-reason) and exactly one
 * triaged mark; the only path that files nothing is the transport failure,
 * which upserts one `steward/offline` note and leaves signals retryable.
 *
 *   node tools/agent-bus/steward-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import {
  parseTriage,
  runStewardTick,
  signalsFor,
  triagePrompt,
  triageReport,
} from "./steward.mjs";

let pass = 0;
let fail = 0;
const check = async (label, fn) => {
  try {
    await fn();
    pass++;
    console.log(`ok  [${label}]`);
  } catch (err) {
    fail++;
    console.log(`FAIL [${label}] ${err.message}`);
  }
};
const summary = () => {
  console.log(`\nsteward-harness: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
};

const NOTE = (value, by = "someone", at = "2026-09-13T00:00:00Z") => ({
  value,
  by,
  at,
});
const stateWith = (board = {}, tasks = []) => ({
  board: board,
  tasks,
  steward: { triaged: [] },
});

// ── signalsFor ──────────────────────────────────────────────────────────────

await check("signalsFor: picks problem notes and failed tasks, nothing else", () => {
  const state = stateWith(
    {
      "defect/badge": NOTE("x"),
      "audit/gap": NOTE("y"),
      "camera/plan": NOTE("plain work note"),
      "steward/triage-note-defect-badge": NOTE("the steward's own output"),
    },
    [
      { id: "t1", status: "failed", title: "died", result: "boom", doneAt: "2026-09-13T01:00:00Z" },
      { id: "t2", status: "done", title: "fine" },
      { id: "t3", status: "queued", title: "waiting" },
    ]
  );
  const s = signalsFor(state, []);
  assert.deepEqual(
    s.map((x) => x.id),
    ["note:defect/badge", "note:audit/gap", "task:t1"],
    "problem notes first, then the failed task"
  );
});

await check("signalsFor: already-triaged signals are not returned twice", () => {
  const state = stateWith({ "defect/a": NOTE("x"), "defect/b": NOTE("y") });
  const once = signalsFor(state, []);
  const twice = signalsFor(state, once.map((s) => s.id));
  assert.equal(twice.length, 0, "a filed signal never comes back");
});

await check("signalsFor: caps at 10 per tick", () => {
  const board = {};
  for (let i = 0; i < 25; i++) board[`defect/n${i}`] = NOTE("x");
  assert.equal(signalsFor(stateWith(board), []).length, 10);
});

// ── triageReport ────────────────────────────────────────────────────────────

await check("triageReport: malformed and empty reports are refusals, never throws", async () => {
  assert.ok((await triageReport(null, {}, async () => "{}")).error);
  assert.ok((await triageReport({ id: "x", key: "k" }, {}, async () => "{}")).error);
  assert.ok(
    (await triageReport({ id: "x", key: "k", value: "  " }, {}, async () => "{}")).error
  );
});

await check("triageReport: mechanical duplicate never calls the classifier", async () => {
  const existing = {
    noteKeys: [
      { key: "defect/connected-badge", value: "the connected badge said running over an empty queue" },
    ],
  };
  const report = {
    id: "note:defect/badge-again",
    source: "note",
    key: "defect/badge-again",
    title: "defect/badge-again",
    value: "the connected badge said running over an empty queue on the dashboard",
  };
  let called = 0;
  const decision = await triageReport(report, existing, async () => {
    called++;
    return "{}";
  });
  assert.equal(called, 0, "word overlap settles it without model spend");
  assert.equal(decision.kind, "duplicate");
  assert.equal(decision.duplicateOf, "defect/connected-badge");
  assert.equal(decision.action, "link");
});

await check("triageReport: a defect verdict files a steward/triage note", async () => {
  const report = {
    id: "note:defect/new-thing",
    source: "note",
    key: "defect/new-thing",
    title: "defect/new-thing",
    value: "the export button 404s on the settings page",
  };
  const decision = await triageReport(report, { noteKeys: [] }, async () =>
    JSON.stringify({ kind: "defect", duplicateOf: null, reason: "route missing" })
  );
  assert.equal(decision.kind, "defect");
  assert.equal(decision.action, "file");
  assert.equal(decision.proposedKey, "steward-triage-note-defect-new-thing");
  assert.equal(decision.reason, "route missing");
});

await check("triageReport: classifier prose, bad JSON or a throw all file unclear", async () => {
  const report = {
    id: "task:t9",
    source: "failed-task",
    key: "t9",
    title: "t9",
    value: "runner produced garbage",
  };
  for (const bad of [
    "I think this is a defect but let me explain at length",
    '{"kind":"maybe","reason":"x"}',
    '```json\n{"kind":defect}\n```',
  ]) {
    const d = await triageReport(report, { noteKeys: [] }, async () => bad);
    assert.equal(d.kind, "unclear", `garbage in, unclear out: ${bad.slice(0, 30)}`);
    assert.equal(d.action, "file", "still filed, never dropped");
    assert.ok(d.proposedKey.startsWith("steward-unclassified-"));
  }
  const thrown = await triageReport(report, { noteKeys: [] }, async () => {
    throw new Error("ollama down");
  });
  assert.equal(thrown.kind, "unclear");
  assert.match(thrown.reason, /ollama down/);
});

// ── parseTriage / triagePrompt ──────────────────────────────────────────────

await check("parseTriage: fences tolerated, shape enforced", () => {
  assert.deepEqual(parseTriage('```json\n{"kind":"lesson","reason":"r"}\n```'), {
    kind: "lesson",
    duplicateOf: null,
    reason: "r",
  });
  for (const bad of ["no json here", '{"kind":"truth"}', '{"kind":"duplicate"}', '{"kind":"defect"}'])
    assert.ok(parseTriage(bad).error, `enforced: ${bad}`);
});

await check("triagePrompt: carries the report, the instruction and the context", () => {
  const p = triagePrompt(
    { source: "note", key: "defect/x", title: "defect/x", value: "it breaks" },
    { noteKeys: [{ key: "defect/y", value: "" }], taskTitles: ["fix y"] }
  );
  assert.match(p, /defect\/x/);
  assert.match(p, /it breaks/);
  assert.match(p, /ONLY a JSON object/);
  assert.match(p, /defect\/y/);
  assert.match(p, /fix y/);
});

await check("triagePrompt: the report's own note is never listed as prior art", () => {
  const p = triagePrompt(
    { source: "note", key: "defect/x", title: "defect/x", value: "it breaks" },
    { noteKeys: [{ key: "defect/x", value: "it breaks" }, { key: "defect/y", value: "" }] }
  );
  assert.doesNotMatch(p, /- defect\/x/, "listing the report itself is how a model answers 'duplicate of itself'");
  assert.match(p, /- defect\/y/);
});

await check("triageReport: a duplicate verdict naming the report itself files unclear, never a self-link", async () => {
  const report = {
    id: "note:defect/solo",
    source: "note",
    key: "defect/solo",
    title: "defect/solo",
    value: "the export button 404s",
  };
  const d = await triageReport(report, { noteKeys: [] }, async () =>
    JSON.stringify({ kind: "duplicate", duplicateOf: "defect/solo", reason: "same issue already reported" })
  );
  assert.equal(d.kind, "unclear", "a self-duplicate must not hide a fresh problem");
  assert.equal(d.action, "file");
  assert.equal(d.duplicateOf, undefined);
  assert.ok(d.proposedKey.startsWith("steward-unclassified-"));
});

// ── runStewardTick (in-memory store, fake ask) ──────────────────────────────

await check("runStewardTick: files every signal, marks each once, notes carry provenance", async () => {
  const state = stateWith(
    { "defect/one": NOTE("the timeline shows gaps wrong"), "audit/two": NOTE("audit skipped the live pass") },
    [{ id: "t5", status: "failed", title: "crashed", result: "boom", doneAt: "2026-09-13T01:00:00Z" }]
  );
  const written = [];
  const res = await runStewardTick({
    readState: () => state,
    writeState: (fn) => {
      fn(state);
      written.push(true);
    },
    ask: async () => JSON.stringify({ kind: "defect", duplicateOf: null, reason: "real defect" }),
  });
  assert.equal(res.triaged, 3);
  assert.equal(state.steward.triaged.length, 3);
  const triageKeys = Object.keys(state.board).filter((k) => k.startsWith("steward-triage-"));
  assert.equal(triageKeys.length, 3);
  assert.match(state.board[triageKeys[0]].value, /First pass by the steward/);
  assert.equal(state.board[triageKeys[0]].by, "steward");
});

await check("runStewardTick: the second tick is a no-op", async () => {
  const state = stateWith({ "defect/one": NOTE("x") });
  const store = {
    readState: () => state,
    writeState: (fn) => fn(state),
  };
  await runStewardTick({ ...store, ask: async () => '{"kind":"defect","reason":"r"}' });
  const after = Object.keys(state.board).length;
  const res = await runStewardTick({ ...store, ask: async () => '{"kind":"defect","reason":"r"}' });
  assert.equal(res.triaged, 0);
  assert.equal(Object.keys(state.board).length, after, "no refiling, no double notes");
});

await check("runStewardTick: transport failure files ONE offline note, marks nothing, signals retry", async () => {
  const state = stateWith({ "defect/one": NOTE("x"), "defect/two": NOTE("y") });
  let attempts = 0;
  const res = await runStewardTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => {
      attempts++;
      throw new Error("connection refused");
    },
  });
  assert.equal(res.offline, true);
  assert.equal(attempts, 1, "stops at the first failure — no per-signal hammering");
  assert.ok(state.board["steward/offline"], "the one upserted note");
  assert.equal((state.steward.triaged ?? []).length, 0, "nothing marked done");
  assert.equal(signalsFor(state, state.steward.triaged ?? []).length, 2, "signals remain retryable");
});

summary();