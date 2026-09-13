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
  briefSignalsFor,
  briefPrompt,
  mechanicalConcern,
  parseBrief,
  parseReview,
  reviewPrompt,
  reviewSignalsFor,
  reviewTask,
  runStewardReviewTick,
  runStewardBriefTick,
  parseTriage,
  parsePromotion,
  promotionPrompt,
  promotionSignalsFor,
  runStewardPromotionTick,
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

// ── duty 2: review first-pass ───────────────────────────────────────────────

const loopLines = Array.from({ length: 25 }, () => "socket.onmessage = function (event) { handleFrame(event.data); };").join("\n");

await check("reviewSignalsFor: picks finished tasks without a first-pass or a verdict", () => {
  const state = stateWith({}, [
    { id: "t1", status: "done", title: "draft a", prompt: "p", result: "r" },
    { id: "t2", status: "done", title: "draft b", prompt: "p", result: "r", firstPass: { verdict: "pass" } },
    { id: "t3", status: "done", title: "draft c", prompt: "p", result: "r", reviews: [{ verdict: "approve", by: "orchestrator" }] },
    { id: "t4", status: "running", title: "in flight" },
    { id: "t5", status: "failed", title: "triage's signal, not review's" },
  ]);
  const s = reviewSignalsFor(state);
  assert.deepEqual(s.map((x) => x.taskId), ["t1"],
    "done + no firstPass + no orchestrator verdict — exactly that set");
});

await check("reviewSignalsFor: caps at 10", () => {
  const state = stateWith({}, Array.from({ length: 25 }, (_, i) => ({
    id: `t${i}`, status: "done", title: `d${i}`, prompt: "p", result: "r",
  })));
  assert.equal(reviewSignalsFor(state).length, 10);
});

await check("mechanicalConcern: empty result and repetition loops need no model", () => {
  assert.match(mechanicalConcern({ result: "  " }), /empty result/);
  const looped = `header line\n${loopLines}`;
  assert.match(mechanicalConcern({ result: looped }), /repetition loop/);
  assert.equal(mechanicalConcern({ result: "const a = 1;\nconst b = 2;\n".repeat(10) }), null,
    "repeated SHORT lines are normal code, not a loop");
  assert.equal(mechanicalConcern({ result: "one fine line of code\n".repeat(8) }), null,
    "a repeated 22-char line is under the loop threshold");
});

await check("reviewTask: the model's pass and concerns land verbatim", async () => {
  const pass = await reviewTask({ prompt: "p", result: "good code" }, async () =>
    '{"verdict":"pass","reason":"complete and on-brief"}');
  assert.deepEqual(pass, { verdict: "pass", reason: "complete and on-brief" });
  const concern = await reviewTask({ prompt: "p", result: "partial" }, async () =>
    '{"verdict":"concerns","reason":"missing the export handler the brief names"}');
  assert.equal(concern.verdict, "concerns");
});

await check("reviewTask: garbage reader answers degrade to unreviewable", async () => {
  for (const bad of ["Let me explain at length why this draft is fine", '{"verdict":"perfect"}', "```json\n{broken\n```"]) {
    const d = await reviewTask({ prompt: "p", result: "r" }, async () => bad);
    assert.equal(d.verdict, "unreviewable", bad.slice(0, 30));
    assert.match(d.reason, /unusable answer/);
  }
});

await check("parseReview: fences tolerated, shape enforced", () => {
  assert.deepEqual(parseReview('```json\n{"verdict":"concerns","reason":"r"}\n```'), {
    verdict: "concerns",
    reason: "r",
  });
  for (const bad of ["no json", '{"verdict":"approve"}', '{"verdict":"pass"}'])
    assert.ok(parseReview(bad).error, `enforced: ${bad}`);
});

await check("reviewPrompt: brief rides whole, draft rides head AND tail", () => {
  const p = reviewPrompt({
    prompt: "write the index page per spec section 2",
    result: "a".repeat(5000) + "truncated-mid-line here",
  });
  assert.match(p, /index page per spec section 2/);
  assert.match(p, /truncated-mid-line here/, "the TAIL is where truncation shows");
  assert.match(p, /middle characters cut/);
  assert.match(p, /ONLY a JSON object/);
});

await check("runStewardReviewTick: first-passes every signal, stamps provenance, second tick is a no-op", async () => {
  const state = stateWith({}, [
    { id: "t1", status: "done", title: "d1", prompt: "p1", result: "result one" },
    { id: "t2", status: "done", title: "d2", prompt: "p2", result: "result two" },
  ]);
  const res = await runStewardReviewTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => '{"verdict":"pass","reason":"reads complete"}',
  });
  assert.equal(res.reviewed, 2);
  assert.equal(state.tasks[0].firstPass.by, "steward");
  assert.match(state.tasks[0].firstPass.reason, /reads complete/);
  const again = await runStewardReviewTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { throw new Error("should not be asked again"); },
  });
  assert.equal(again.reviewed, 0, "firstPass on the task is the done-marker");
});

await check("runStewardReviewTick: transport failure files ONE offline note, stamps nothing, retries", async () => {
  const state = stateWith({}, [
    { id: "t1", status: "done", title: "d1", prompt: "p", result: "r" },
    { id: "t2", status: "done", title: "d2", prompt: "p", result: "r" },
  ]);
  let attempts = 0;
  const res = await runStewardReviewTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { attempts++; throw new Error("connection refused"); },
  });
  assert.equal(res.offline, true);
  assert.equal(attempts, 1);
  assert.ok(state.board["steward/offline"]);
  assert.equal(state.tasks.filter((t) => t.firstPass).length, 0);
  assert.equal(reviewSignalsFor(state).length, 2, "signals remain retryable");
});

await check("runStewardReviewTick: the mechanical gate runs without model spend", async () => {
  const state = stateWith({}, [
    { id: "t1", status: "done", title: "d1", prompt: "p", result: "" },
    { id: "t2", status: "done", title: "d2", prompt: "p", result: loopLines },
  ]);
  let called = 0;
  const res = await runStewardReviewTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { called++; return '{"verdict":"pass","reason":"r"}'; },
  });
  assert.equal(called, 0, "both failures are mechanical — the model is never asked");
  assert.match(state.tasks[0].firstPass.reason, /empty result/);
  assert.match(state.tasks[1].firstPass.reason, /repetition loop/);
});

// ── duty 3: brief drafting ──────────────────────────────────────────────────

const GOOD_BRIEF = [
  "PROBLEM: The export button on the settings page returns a 404 because the route is missing.",
  "MUST PRODUCE: The route exists and returns the export; the dashboard shows the export button working; a suite pins the route.",
  "DO NOT: Do not touch the auth layer or any other route handler.",
  "CONTEXT: The report names agent/ui/index.html; no other files named.",
].join(" ");

await check("briefSignalsFor: triaged defects without a draft, one each, capped", () => {
  const state = stateWith({ "defect/export-404": NOTE("export 404s") }, [
    { id: "t1", status: "failed", title: "boom", result: "crash" },
    { id: "t2", status: "draft", briefDraftFor: "note:defect/export-404", title: "Brief draft" },
  ]);
  state.steward = { defects: ["note:defect/export-404", "task:t1", "note:defect/export-404"] };
  const s = briefSignalsFor(state);
  assert.deepEqual(s.map((x) => x.id), ["task:t1"],
    "the already-drafted defect is out, the failed task triaged as defect is in");
  const big = stateWith({ "defect/a": NOTE("x") }, []);
  big.steward = { defects: Array.from({ length: 20 }, () => "note:defect/a") };
  assert.equal(briefSignalsFor(big).length, 1, "duplicate ids collapse");
});

await check("briefSignalsFor: defects unknown to the board or tasks are skipped, not guessed", () => {
  const state = stateWith({}, []);
  state.steward = { defects: ["note:defect/vanished"] };
  assert.equal(briefSignalsFor(state).length, 0,
    "a defect id with no report behind it never becomes a signal");
});

await check("briefPrompt: carries the report and demands the four sections", () => {
  const p = briefPrompt({ id: "note:defect/x", key: "defect/x", title: "defect/x", value: "export 404" });
  assert.match(p, /defect\/x/);
  assert.match(p, /export 404/);
  assert.match(p, /PROBLEM/);
  assert.match(p, /MUST PRODUCE/);
  assert.match(p, /DO NOT/);
  assert.match(p, /CONTEXT/);
});

await check("parseBrief: real briefs pass, wishes and fences do not", () => {
  assert.deepEqual(parseBrief(`\`\`\`\n${GOOD_BRIEF}\n\`\`\``), { brief: GOOD_BRIEF });
  assert.ok(parseBrief("PROBLEM: it 404s. fix it.").error, "a one-liner is a wish, not a brief");
  assert.ok(parseBrief("x".repeat(300)).error, "length without the sections is still not a brief");
  assert.ok(parseBrief("").error);
});

await check("runStewardBriefTick: files a DRAFT task, marks once, second tick is a no-op", async () => {
  const state = stateWith({ "defect/export-404": NOTE("export 404s") }, []);
  state.steward = { defects: ["note:defect/export-404"] };
  const res = await runStewardBriefTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => GOOD_BRIEF,
  });
  assert.equal(res.drafted, 1);
  const task = state.tasks[0];
  assert.equal(task.status, "draft", "a draft is claimed by nobody — dispatch is the orchestrator's approve");
  assert.equal(task.briefDraftFor, "note:defect/export-404");
  assert.equal(task.by, "steward");
  assert.match(task.prompt, /MUST PRODUCE/);
  assert.equal(state.steward.briefed.length, 1);
  const again = await runStewardBriefTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { throw new Error("should not be asked again"); },
  });
  assert.equal(again.drafted, 0);
  assert.equal(state.tasks.length, 1, "one defect, one draft, never a second");
});

await check("runStewardBriefTick: an unusable draft is reported once, not retried", async () => {
  const state = stateWith({ "defect/x": NOTE("x") }, []);
  state.steward = { defects: ["note:defect/x"] };
  let attempts = 0;
  const res = await runStewardBriefTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { attempts++; return "PROBLEM: it 404s."; },
  });
  assert.equal(res.drafted, 1, "the signal is settled — filed as unusable");
  assert.equal(attempts, 1, "never a token furnace");
  assert.equal(state.tasks.length, 0, "no half-brief became a task");
  assert.match(state.board["steward-brief-unusable-note-defect-x"].value, /could not draft a usable brief/);
  assert.equal(state.steward.briefed.length, 1);
});

await check("runStewardBriefTick: transport failure files ONE offline note, marks nothing", async () => {
  const state = stateWith({ "defect/x": NOTE("x") }, []);
  state.steward = { defects: ["note:defect/x"] };
  const res = await runStewardBriefTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { throw new Error("connection refused"); },
  });
  assert.equal(res.offline, true);
  assert.ok(state.board["steward/offline"]);
  assert.equal(state.steward.briefed?.length ?? 0, 0, "signals remain retryable");
});

await check("duty 1 -> duty 3: a defect triage becomes a brief signal, a lesson does not", async () => {
  const state = stateWith(
    { "defect/new": NOTE("the export button 404s on the settings page") },
    []
  );
  await runStewardTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => JSON.stringify({ kind: "defect", duplicateOf: null, reason: "route missing" }),
  });
  assert.deepEqual(state.steward.defects, ["note:defect/new"], "defect verdict recorded as data");

  const state2 = stateWith({ "problem/x": NOTE("we forgot to save problems to the bus") }, []);
  await runStewardTick({
    readState: () => state2,
    writeState: (fn) => fn(state2),
    ask: async () => JSON.stringify({ kind: "lesson", duplicateOf: null, reason: "process, not code" }),
  });
  assert.deepEqual(state2.steward.defects ?? [], [], "a lesson is not a fix task");
});

// ── duty 4: lesson promotion ────────────────────────────────────────────────

const GOOD_PROPOSAL = JSON.stringify({
  rule: "### B7. A counter the board shows must come from the data the board stores.\n\nA count rendered from a value nobody wrote is a guess wearing a number. Derive it, or say it is unknown.",
  reason: "The same wrong-count miss has recurred three times from different callers.",
  source: "miss-count-from-thin-air",
});
const RULEBOOK_MD = [
  "## B. Being honest about data",
  "### B1. A blank is not a zero.",
  "body",
].join("\n");

const missBoard = (seen) => ({
  "miss-count-from-thin-air": {
    value: "SELF-REPORTED MISS. CLAIMED: the count. TRUE: it was a guess.",
    by: "someone",
    at: "2026-09-13T00:00:00Z",
    miss: true,
    seen,
  },
});

await check("promotionSignalsFor: picks misses at the L3 threshold, skips the rest, capped", () => {
  const hot = promotionSignalsFor(
    stateWith(missBoard(3), [])
  );
  assert.equal(hot.length, 1);
  assert.equal(hot[0].id, "promotion:miss-count-from-thin-air");
  assert.equal(hot[0].seen, 3, "the seen count rides the signal — the proposal cites it");
  assert.equal(promotionSignalsFor(stateWith(missBoard(2), [])).length, 0, "below L3, the steward is quiet");
  assert.equal(promotionSignalsFor(stateWith(missBoard(1), [])).length, 0);
  const many = stateWith({}, []);
  for (let i = 0; i < 7; i++) {
    many.board[`miss-pattern-${i}`] = { value: "v", by: "s", at: "t", miss: true, seen: 4 };
  }
  assert.equal(promotionSignalsFor(many).length, 5, "capped like every other signal source");
});

await check("promotionSignalsFor: already-promoted misses are not returned twice", () => {
  const state = stateWith(missBoard(3), []);
  state.steward.promoted = ["promotion:miss-count-from-thin-air"];
  assert.equal(promotionSignalsFor(state).length, 0);
});

await check("promotionPrompt: carries the miss, the existing ids and the demanded shape", () => {
  const prompt = promotionPrompt(
    { id: "promotion:miss-x", key: "miss-x", seen: 3, value: "CLAIMED: A. TRUE: B." },
    ["B1", "C4", "G3"]
  );
  assert.match(prompt, /CLAIMED: A\. TRUE: B\./);
  assert.match(prompt, /B1, C4, G3/, "the model proposes into the rulebook's actual numbering");
  assert.match(prompt, /### <id>\. <title>/, "the rulebook's own heading grammar is demanded");
  assert.match(prompt, /3 reports/);
  const empty = promotionPrompt({ id: "x", key: "x", seen: 3, value: "v" }, []);
  assert.match(empty, /currently has none/);
});

await check("parsePromotion: a good proposal parses to a rule + reason + id; garbage does not", () => {
  const good = parsePromotion(`\`\`\`json\n${GOOD_PROPOSAL}\n\`\`\``);
  assert.equal(good.rule.startsWith("### B7. "), true, "fences stripped, heading intact");
  assert.equal(good.id, "B7");
  assert.match(good.reason, /recurred/);
  assert.ok(parsePromotion("not json at all").error);
  assert.ok(parsePromotion(JSON.stringify({ rule: "### B7. Title", reason: "" })).error, "a proposal without its why is not reviewable");
  assert.ok(parsePromotion(JSON.stringify({ rule: "just words", reason: "why" })).error, "no heading = not the rulebook's shape");
  assert.ok(parsePromotion(JSON.stringify({ rule: "### B7. Title", reason: "why" })).error, "a heading with no body is not a rule");
  assert.ok(parsePromotion(JSON.stringify({ rule: "### B7. Title\nbody", reason: "why" })).error, "too short to be a rule");
});

await check("runStewardPromotionTick: files a PROPOSAL note with provenance, marks once, second tick is a no-op", async () => {
  const state = stateWith(missBoard(3), []);
  const res = await runStewardPromotionTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => GOOD_PROPOSAL,
    rulebook: RULEBOOK_MD,
  });
  assert.equal(res.promoted, 1);
  const note = state.board["steward-rule-proposal-miss-count-from-thin-air"];
  assert.ok(note, "the proposal lands on the board, not in the rulebook");
  assert.equal(note.by, "steward");
  assert.match(note.value, /STEWARD RULE PROPOSAL/);
  assert.match(note.value, /MAINTAINER'S edit — the steward never writes rules \(C4\)/, "the human gate is in the proposal's own text");
  assert.match(note.value, /### B7\./, "ready to paste into build-rules.md as-is");
  assert.match(note.value, /reported 3 times/);
  assert.equal(state.steward.promoted.length, 1);
  const again = await runStewardPromotionTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { throw new Error("should not be asked again"); },
    rulebook: RULEBOOK_MD,
  });
  assert.equal(again.promoted, 0);
  assert.equal(Object.keys(state.board).length, 2, "one miss, one proposal, never a second (the miss itself stays on the board)");
});

await check("runStewardPromotionTick: a proposed id that already exists in the rulebook is unusable, reported once", async () => {
  const collision = JSON.parse(GOOD_PROPOSAL);
  collision.rule = collision.rule.replace("B7", "B1");
  const state = stateWith(missBoard(3), []);
  let attempts = 0;
  const res = await runStewardPromotionTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { attempts++; return JSON.stringify(collision); },
    rulebook: RULEBOOK_MD,
  });
  assert.equal(res.promoted, 1, "the signal is settled — filed as unusable");
  assert.equal(attempts, 1, "never a token furnace");
  assert.ok(state.board["steward-rule-unusable-miss-count-from-thin-air"]);
  assert.match(state.board["steward-rule-unusable-miss-count-from-thin-air"].value, /B1 already exists/);
  assert.ok(!state.board["steward-rule-proposal-miss-count-from-thin-air"], "a colliding rule never files as a proposal");
  assert.equal(state.steward.promoted.length, 1);
});

await check("runStewardPromotionTick: garbage answers are unusable once, not retried", async () => {
  const state = stateWith(missBoard(4), []);
  let attempts = 0;
  const res = await runStewardPromotionTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { attempts++; return "I think we should write a rule about counters maybe"; },
    rulebook: RULEBOOK_MD,
  });
  assert.equal(res.promoted, 1);
  assert.equal(attempts, 1);
  assert.ok(state.board["steward-rule-unusable-miss-count-from-thin-air"]);
  assert.equal(state.steward.promoted.length, 1);
});

await check("runStewardPromotionTick: transport failure files ONE offline note, marks nothing", async () => {
  const state = stateWith(missBoard(3), []);
  const res = await runStewardPromotionTick({
    readState: () => state,
    writeState: (fn) => fn(state),
    ask: async () => { throw new Error("connection refused"); },
    rulebook: RULEBOOK_MD,
  });
  assert.equal(res.offline, true);
  assert.ok(state.board["steward/offline"]);
  assert.equal(state.steward.promoted?.length ?? 0, 0, "signals remain retryable");
});

summary();