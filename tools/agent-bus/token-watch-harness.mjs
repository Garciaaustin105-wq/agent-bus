/**
 * Harness for the token watch.
 *
 * The happy path is three lines of this file. The rest is transcripts that are
 * malformed, half-written, out of order, or shaped in a way that makes the
 * arithmetic quietly wrong — E1, test the failure you are afraid of.
 *
 * The failure I am most afraid of here is not a crash. It is a number that
 * looks right: an off-by-a-cache-field context size, or a mean sneaking in
 * where a median belongs, would produce a plausible nudge at the wrong moment
 * and nobody would ever check it.
 *
 * Runs on string literals — no Claude install, no sessions, no home directory.
 *
 *   node tools/agent-bus/token-watch-harness.mjs
 */
import {
  FRESH_FALLBACK_TOKENS,
  approxTok,
  assess,
  baselineFrom,
  breakEvenTurns,
  contextTokens,
  dueForNudge,
  firstTurnTokens,
  median,
  mergeScans,
  measuredBaseline,
  scanTranscript,
  watch,
} from "./token-watch.mjs";

let pass = 0;
const fails = [];

function check(label, fn) {
  try {
    fn();
    pass++;
    console.log(`ok  [${label}]`);
  } catch (e) {
    fails.push(`${label}: ${e.message}`);
    console.log(`FAIL [${label}] ${e.message}`);
  }
}
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
};
const near = (a, b, tol, what) => {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${what}: got ${a}, wanted ${b} +-${tol}`);
};
const ok = (c, what) => {
  if (!c) throw new Error(what);
};

/* ------------------------------- transcript fixtures ----------------------- */

const turn = (usage, content) =>
  JSON.stringify({ type: "assistant", message: { usage, content: content || [] } });
const userLine = (content) => JSON.stringify({ type: "user", message: { content } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content });

const U = (read, write = 0, input = 0, output = 0) => ({
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  input_tokens: input,
  output_tokens: output,
});

/* ---------------------------------- scanning ------------------------------- */

check("scan-counts-turns-and-usage", () => {
  const t = [turn(U(1000, 200, 30, 500)), turn(U(1500, 100, 10, 400))].join("\n");
  const s = scanTranscript(t);
  eq(s.turns, 2, "turns");
  eq(s.read, 2500, "cache read");
  eq(s.write, 300, "cache write");
  eq(s.input, 40, "uncached input");
  eq(s.output, 900, "output");
});

check("scan-empty-and-garbage-never-throw", () => {
  for (const bad of ["", "   \n\n  ", "not json at all", "{", null, undefined]) {
    const s = scanTranscript(bad);
    eq(s.turns, 0, `turns for ${JSON.stringify(bad)}`);
    eq(contextTokens(s), 0, "context of nothing is zero, not NaN");
  }
});

check("scan-survives-a-half-written-tail", () => {
  // The session is being appended to while we read it. This is normal, and it
  // must not cost us the turns above the broken line.
  const t = [turn(U(1000)), turn(U(2000)), '{"type":"assistant","message":{"usa'].join("\n");
  const s = scanTranscript(t);
  eq(s.turns, 2, "turns before the torn line");
  eq(contextTokens(s), 2000, "context still reads from the last good turn");
});

check("scan-handles-crlf-transcripts", () => {
  // Windows. Splitting on \n leaves a \r that JSON.parse tolerates — but if
  // that ever stops being true, every number on this machine silently zeroes.
  const s = scanTranscript([turn(U(4000, 100)), turn(U(9000, 50))].join("\r\n"));
  eq(s.turns, 2, "turns from a CRLF transcript");
  eq(contextTokens(s), 9050, "context from a CRLF transcript");
});

check("scan-missing-usage-fields-are-zero-not-nan", () => {
  const s = scanTranscript(JSON.stringify({ type: "assistant", message: { usage: {} } }));
  eq(s.turns, 1, "a turn with an empty usage block is still a turn");
  eq(s.read + s.write + s.input + s.output, 0, "absent fields are zero");
  eq(Number.isFinite(contextTokens(s)), true, "context is a number");
});

check("scan-ignores-user-turns-and-usageless-assistants", () => {
  const t = [
    userLine([{ type: "text", text: "hello" }]),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    turn(U(500)),
  ].join("\n");
  eq(scanTranscript(t).turns, 1, "only assistant turns carrying usage count");
});

/* --------------------------- the context curve ----------------------------- */

check("context-is-read-plus-write-plus-input", () => {
  // The one that would be invisible if wrong. Cache reads alone under-report
  // the context by exactly the part that was not cached yet, which is the part
  // that just grew — so the watch would lag precisely when it matters.
  const s = scanTranscript(turn(U(100_000, 12_000, 300, 900)));
  eq(contextTokens(s), 112_300, "current context");
});

check("curve-keeps-order-first-to-last", () => {
  const s = scanTranscript([turn(U(1000)), turn(U(5000)), turn(U(9000))].join("\n"));
  eq(firstTurnTokens(s), 1000, "first turn");
  eq(contextTokens(s), 9000, "last turn");
  eq(s.curve.length, 3, "one sample per turn");
});

/* --------------------------- tool and file attribution ---------------------- */

check("read-results-split-into-images-and-text", () => {
  const t = [
    turn(U(10), [use("t1", "Read", { file_path: "C:\\proj\\preview-map.PNG" })]),
    userLine([result("t1", "x".repeat(4000))]),
    turn(U(20), [use("t2", "Read", { file_path: "/proj/src/thing.ts" })]),
    userLine([result("t2", "y".repeat(400))]),
  ].join("\n");
  const s = scanTranscript(t);
  eq(s.images.n, 1, "image reads");
  eq(s.images.tok, 1000, "image tokens");
  eq(s.texts.n, 1, "text reads");
  eq(s.texts.tok, 100, "text tokens");
  eq(s.files["preview-map.PNG"], 1000, "offender keyed by basename, uppercase extension still an image");
  eq(s.files["thing.ts"], 100, "windows and posix separators both split");
});

check("non-read-tools-are-not-attributed-to-files", () => {
  const t = [
    turn(U(10), [use("t1", "Bash", { command: "ls" })]),
    userLine([result("t1", "z".repeat(800))]),
  ].join("\n");
  const s = scanTranscript(t);
  eq(s.byTool.Bash, 200, "counted against the tool");
  eq(s.images.n + s.texts.n, 0, "but not against any file");
  eq(Object.keys(s.files).length, 0, "no phantom file entry");
});

check("orphan-tool-result-is-counted-as-unknown", () => {
  // Its tool_use sat in a line we could not parse, or above a compaction
  // boundary. It still cost tokens (D3 — say what you could not attribute).
  const s = scanTranscript(userLine([result("gone", "q".repeat(2000))]));
  eq(s.byTool["(unknown)"], 500, "orphan result still counted");
});

check("object-tool-results-are-measured-not-skipped", () => {
  const t = [
    turn(U(10), [use("t1", "Grep", {})]),
    userLine([result("t1", [{ type: "text", text: "hit" }])]),
  ].join("\n");
  ok(scanTranscript(t).byTool.Grep > 0, "a structured result has a size too");
});

/* ---------------------------------- merging -------------------------------- */

check("merge-adds-up-and-keeps-session-count", () => {
  const a = scanTranscript(turn(U(100, 10, 1, 2)));
  const b = scanTranscript([turn(U(200, 20, 2, 4)), turn(U(300))].join("\n"));
  const T = mergeScans([a, b, null]);
  eq(T.sessions, 2, "nulls are not sessions");
  eq(T.turns, 3, "turns");
  eq(T.read, 600, "read");
});

/* --------------------------------- baseline -------------------------------- */

check("median-not-mean", () => {
  // D1. With a mean, one 9,720-turn monster sets the baseline for everyone.
  eq(median([10, 20, 30, 40, 5_000_000]), 30, "median of a skewed sample");
  eq(median([10, 20]), 15, "even-length median");
  eq(median([]), null, "no sample, no median");
});

check("baseline-gates-on-sample-size", () => {
  const two = [scanTranscript(turn(U(50_000))), scanTranscript(turn(U(52_000)))];
  const b = baselineFrom(two);
  eq(b.measured, false, "two sessions is not a sample");
  eq(b.tokens, FRESH_FALLBACK_TOKENS, "falls back to the stated assumption");
  ok(/need 3/.test(b.why), `must say what it could not use, said: ${b.why}`);
});

check("baseline-gates-on-spread", () => {
  const wide = [40_000, 45_000, 900_000].map((n) => scanTranscript(turn(U(n))));
  const b = baselineFrom(wide);
  eq(b.measured, false, "a 22x spread is not one population");
  eq(b.tokens, FRESH_FALLBACK_TOKENS, "falls back rather than guessing");
  ok(/wider than 3x/.test(b.why), `must name the spread, said: ${b.why}`);
});

check("baseline-measures-when-both-gates-pass", () => {
  const good = [50_000, 60_000, 70_000, 65_000].map((n) => scanTranscript(turn(U(n))));
  const b = baselineFrom(good);
  eq(b.measured, true, "four tight sessions is a sample");
  eq(b.tokens, 62_500, "median of the first turns");
  eq(b.n, 4, "sample size reported");
});

check("baseline-uses-the-FIRST-turn-not-the-last", () => {
  // A long session's last turn is the thing we are measuring against. If it
  // fed the baseline, the baseline would chase the problem and the watch would
  // never fire.
  const grown = [
    scanTranscript([turn(U(55_000)), turn(U(600_000))].join("\n")),
    scanTranscript([turn(U(58_000)), turn(U(700_000))].join("\n")),
    scanTranscript([turn(U(57_000)), turn(U(500_000))].join("\n")),
  ];
  const b = baselineFrom(grown);
  eq(b.measured, true, "measured");
  eq(b.tokens, 57_000, "the floor sessions started from, not where they ended");
});

/* ------------------------------- the arithmetic ---------------------------- */

check("break-even-is-h1-arithmetic", () => {
  // The H5 incident: 539k against a 57k fresh session.
  near(breakEvenTurns(539_000, 57_000), 1.118, 0.01, "the expensive session");
  near(breakEvenTurns(70_000, 57_000), 5.38, 0.01, "the middle of the range");
  near(breakEvenTurns(60_000, 57_000), 20, 0.01, "just above the baseline");
});

check("break-even-refuses-rather-than-dividing-by-zero", () => {
  eq(breakEvenTurns(57_000, 57_000), Infinity, "at the baseline there is nothing to reclaim");
  eq(breakEvenTurns(10_000, 57_000), Infinity, "below the baseline either");
  eq(breakEvenTurns(0, 0), Infinity, "an empty session is not a candidate");
});

check("assess-bands-follow-the-break-even", () => {
  const at = (n) => assess(scanTranscript(turn(U(n))), { baseline: 57_000 });
  eq(at(539_000).level, "compact", "1.1 turns to break even");
  eq(at(70_000).level, "watch", "5.4 turns");
  eq(at(58_000).level, "ok", "57 turns to break even is not worth interrupting for");
  eq(at(1_000).level, "ok", "below the baseline");
});

check("assess-reports-the-numbers-not-just-the-band", () => {
  // C2. The band is for colouring a row; the finding is the measurement, and it
  // has to survive being quoted alone in a board note.
  const a = assess(scanTranscript(turn(U(539_000))), { baseline: 57_000 });
  eq(a.contextTokens, 539_000, "context");
  eq(a.baselineTokens, 57_000, "baseline carried through");
  eq(a.excessTokensPerTurn, 482_000, "what compaction would give back per turn");
  ok(a.line.includes("539,000") && a.line.includes("482,000"), `line must carry both numbers: ${a.line}`);
  ok(/1\.1 more turns/.test(a.line), `line must state the break-even: ${a.line}`);
});

check("assess-says-nothing-to-reclaim-below-the-baseline", () => {
  const a = assess(scanTranscript(turn(U(20_000))), { baseline: 57_000 });
  eq(a.level, "ok", "level");
  ok(/nothing to reclaim/.test(a.line), `must not suggest a saving that does not exist: ${a.line}`);
  ok(!/Infinity/.test(a.line), "never print Infinity at a person");
});

check("assess-thresholds-are-caller-visible", () => {
  const s = scanTranscript(turn(U(70_000)));
  eq(assess(s, { baseline: 57_000, watchTurns: 2, compactTurns: 1 }).level, "ok", "a stricter caller");
  eq(assess(s, { baseline: 57_000, watchTurns: 100, compactTurns: 50 }).level, "compact", "a looser caller");
});

/* ----------------------------------- watch --------------------------------- */

check("watch-sorts-worst-first-and-shares-one-baseline", () => {
  // The expensive session STARTED normal and grew — that is what a real one
  // does, and it is why the baseline reads first turns while the sort reads
  // last ones. If both read the same end, the baseline would chase the problem.
  const sessions = [
    { id: "s0", scan: scanTranscript(turn(U(50_000))) },
    { id: "s1", scan: scanTranscript(turn(U(60_000))) },
    { id: "s2", scan: scanTranscript(turn(U(55_000))) },
    { id: "s3", scan: scanTranscript([turn(U(56_000)), turn(U(400_000))].join("\n")) },
  ];
  const w = watch(sessions);
  eq(w.rows[0].id, "s3", "the expensive one is first");
  eq(w.rows[0].assessment.level, "compact", "and it is flagged");
  eq(w.baseline.measured, true, "baseline measured from the sample");
  const one = new Set(w.rows.map((r) => r.assessment.baselineTokens));
  eq(one.size, 1, "every row judged against the same baseline");
});

check("watch-falls-back-when-the-sample-is-not-one-population", () => {
  // Found by getting a fixture wrong, kept because the behaviour is right. A
  // session resumed from a compaction boundary opens at 400k on turn one. That
  // is a real thing that happens, it is not a fresh session, and the honest
  // answer is to stop measuring and say so (D2, D3) rather than to publish a
  // baseline drawn from two different populations.
  const w = watch([50_000, 60_000, 55_000, 400_000].map((n, i) => ({ id: `s${i}`, scan: scanTranscript(turn(U(n))) })));
  eq(w.baseline.measured, false, "mixed populations are not a measurement");
  eq(w.baseline.tokens, FRESH_FALLBACK_TOKENS, "the stated assumption stands in");
  ok(/wider than 3x/.test(w.baseline.why), `and it says why: ${w.baseline.why}`);
});

check("watch-drops-sessions-with-no-turns", () => {
  const w = watch([{ id: "empty", scan: scanTranscript("") }, { id: "real", scan: scanTranscript(turn(U(9000))) }]);
  eq(w.rows.length, 1, "a session with no turns has nothing to say");
  eq(w.rows[0].id, "real", "and the real one survives");
});

check("watch-accepts-bare-scans-too", () => {
  const w = watch([scanTranscript(turn(U(100_000))), scanTranscript(turn(U(50_000)))]);
  eq(w.rows.length, 2, "bare scans");
  eq(w.rows[0].assessment.contextTokens, 100_000, "still sorted");
});

check("watch-on-an-empty-machine-does-not-throw", () => {
  const w = watch([]);
  eq(w.rows.length, 0, "no rows");
  eq(w.baseline.tokens, FRESH_FALLBACK_TOKENS, "and the stated assumption stands in");
  eq(w.totals.turns, 0, "totals are zero, not NaN");
});

/* --------------------------------- the nudge -------------------------------- */

// The rows dueForNudge sees are what sessions.mjs hands it: an id, how long the
// transcript has been idle, and the assessment. Built by hand here so the test
// does not depend on a machine having an expensive session on it right now.
const row = (id, level, idle, turns = 100) => ({
  id,
  idle,
  assessment: { level, turns, line: level + " line for " + id },
});
const MIN = 60_000;

check("nudge-picks-only-the-live-ones-past-break-even", () => {
  const due = dueForNudge(
    [
      row("aaaa", "compact", 2 * MIN),
      row("bbbb", "watch", 2 * MIN), // above the baseline, not past break-even
      row("cccc", "ok", 2 * MIN),
    ],
    {},
    { liveMs: 90 * MIN }
  );
  eq(due.length, 1, "one session worth telling somebody about");
  eq(due[0].id, "aaaa", "and it is the one past break-even");
  eq(due[0].key, "context-aaaa", "keyed by session, not by agent");
});

// The bug this pins is the one that actually shipped in the window before it
// was caught: ten long-dead sessions flagged as "compact now". Nobody is in
// them; the tokens were spent days ago.
check("nudge-says-nothing-about-a-session-nobody-is-in", () => {
  const due = dueForNudge([row("dead", "compact", 3 * 24 * 60 * MIN)], {}, { liveMs: 90 * MIN });
  eq(due.length, 0, "history is not actionable");
});

check("nudge-holds-its-tongue-until-the-cooldown-is-up", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  const seen = { "context-aaaa": new Date(now - 5 * MIN).toISOString() };
  const opts = { now, liveMs: 90 * MIN, renudgeMs: 30 * MIN };
  eq(dueForNudge([row("aaaa", "compact", MIN)], seen, opts).length, 0, "said five minutes ago");
  eq(
    dueForNudge([row("aaaa", "compact", MIN)], { "context-aaaa": new Date(now - 31 * MIN).toISOString() }, opts)
      .length,
    1,
    "and again once it has been half an hour"
  );
});

check("nudge-survives-junk-rows", () => {
  eq(dueForNudge(null).length, 0, "no rows at all");
  eq(dueForNudge([null, {}, { id: "x" }]).length, 0, "rows with no assessment are skipped, not thrown at");
});

/* ------------------------ compaction baseline (t9) ------------------------- */

// Fixtures are string literals: no Claude install, no home directory. An
// assistant turn whose context — read + write + input — is exactly n.
const lines = (...ls) => ls.join("\n");
const turnAt = (n) =>
  `{"type":"assistant","message":{"usage":{"cache_read_input_tokens":${n},"cache_creation_input_tokens":0,"input_tokens":0}}}`;
const sysMarker = `{"type":"system","compactMetadata":{"trigger":"auto","preTokens":167981,"postTokens":12931,"cumulativeDroppedTokens":155050,"durationMs":108905}}`;
const userMarker = `{"type":"user","isCompactSummary":true}`;
const marked = (before, after) => lines(turnAt(before), sysMarker, userMarker, turnAt(after));

check("compaction-counted-twice-for-its-two-marker-lines", () => {
  const s = scanTranscript(marked(150000, 80000));
  eq(s.compactions.length, 1, "the system line and the isCompactSummary line are one compaction; both see the same curve length, so the dedupe records one, not two");
  eq(s.compactions[0], 1, "one turn precedes the markers, so the recorded index is the resumed turn's slot");
  eq(s.curve.length, 2, "the marker lines carry no usage; recording them must not disturb the curve");
});

check("compaction-index-landing-on-the-turn-before-the-marker", () => {
  const s = scanTranscript(lines(turnAt(10000), turnAt(20000), sysMarker, userMarker, turnAt(30000)));
  eq(s.compactions[0], 2, "the marker is read while the curve holds two turns; the index it leaves is the resumed turn's, not the turn before it");
  eq(s.curve[s.compactions[0]], 30000, "curve at the recorded index is the resumed context — the number the baseline is built from");
});

check("tail-marker-read-as-an-event", () => {
  const tail = scanTranscript(lines(turnAt(150000), sysMarker, userMarker));
  eq(tail.compactions.length, 1, "scanTranscript records the marker positionally; at read time it cannot know no turn follows");
  const a = scanTranscript(marked(150000, 80000));
  const b = scanTranscript(marked(160000, 84000));
  const c = scanTranscript(marked(170000, 88000));
  const r = measuredBaseline([a, b, c, tail]);
  eq(r.n, 3, "the tail compaction has no next turn to read; a naive curve[at] would be undefined and surface as a fourth event");
  eq(r.baseline, 84000, "the median of the three real resumed contexts");
});

check("post-compaction-zero-read-as-a-baseline", () => {
  const zeroed = scanTranscript(lines(turnAt(150000), sysMarker, userMarker, turnAt(0)));
  const a = scanTranscript(marked(150000, 80000));
  const b = scanTranscript(marked(160000, 84000));
  const c = scanTranscript(marked(170000, 88000));
  const r = measuredBaseline([a, b, c, zeroed]);
  eq(r.n, 3, "the manual compaction that resumed with no cache read at all is a different event; counting its 0 would make every break-even number infinite");
});

check("a-flat-curve-inventing-events", () => {
  const s = scanTranscript(lines(turnAt(10000), turnAt(11000), turnAt(10500)));
  eq(s.compactions.length, 0, "no markers and no drop that clears both tests, so nothing is recorded");
  eq(measuredBaseline([s, s, s]), null, "nothing measurable, so the gate answers null rather than a number");
});

check("fewer-than-three-events-returning-a-number", () => {
  const a = scanTranscript(marked(150000, 80000));
  const b = scanTranscript(marked(160000, 82000));
  eq(measuredBaseline([a, b]), null, "two events sit under the minSessions gate, the same gate baselineFrom applies");
});

check("spread-of-three-x-passing-the-gate", () => {
  const a = scanTranscript(marked(150000, 40000));
  const b = scanTranscript(marked(150000, 40000));
  const c = scanTranscript(marked(150000, 120000));
  eq(measuredBaseline([a, b, c]), null, "120,000 over 40,000 is exactly 3.0x, and the gate is >=, so it does not pass");
});

check("unmarked-fallback-firing-on-one-test-alone", () => {
  const drop = (before, after) => scanTranscript(lines(turnAt(before), turnAt(after)));
  const r = measuredBaseline([drop(150000, 80000), drop(160000, 84000), drop(170000, 88000)]);
  eq(r.n, 3, "each drop clears 0.75 and 30,000, so the unmarked fallback finds all three");
  eq(r.inferred, 3, "and all three are flagged as inferred, none as labelled");
  eq(measuredBaseline([drop(100000, 74000), drop(160000, 84000), drop(170000, 88000)]), null, "a 0.74 ratio but only a 26,000 drop: the ratio clearing alone must not fire");
  eq(measuredBaseline([drop(200000, 152000), drop(160000, 84000), drop(170000, 88000)]), null, "a 48,000 drop but a 0.76 ratio: the floor clearing alone must not fire");
});

check("median-of-the-events-not-what-comes-back", () => {
  const r = measuredBaseline([
    scanTranscript(marked(200000, 80000)),
    scanTranscript(marked(200000, 161263)),
    scanTranscript(marked(200000, 84000)),
  ]);
  eq(r.baseline, 84000, "the 161,263 outlier is real data; the median absorbs it and nothing is hand-filtered");
  eq(r.n, 3, "three events, none discarded");
  eq(r.inferred, 0, "all three came from labels");
  eq(r.spread, 161263 / 80000, "2.02x, under the gate");
});

check("baselineFrom-ignoring-the-measured-baseline", () => {
  const r = baselineFrom([scanTranscript(marked(150000, 80000)), scanTranscript(marked(160000, 84000)), scanTranscript(marked(170000, 88000))]);
  eq(r.measured, true, "labelled compactions clear the gate, so the first-turn logic never runs");
  eq(r.tokens, 84000, "the compaction-resume median, not the 57,000 constant and not the ~150,000 first turn");
  eq(r.n, 3, "three events");
});

check("baselineFrom-measuring-when-nothing-is-measurable", () => {
  const flat = scanTranscript(lines(turnAt(10000), turnAt(11000)));
  const r = baselineFrom([flat, flat]);
  eq(r.measured, false, "no markers and no qualifying drops leaves measuredBaseline null, so the first-turn gate answers");
  eq(r.tokens, 57_000, "the unmeasured constant is still what the product prints when nothing is measurable");
});

check("why-not-naming-the-inferred-events", () => {
  const unmarked = scanTranscript(lines(turnAt(170000), turnAt(88000)));
  const r = baselineFrom([scanTranscript(marked(150000, 80000)), scanTranscript(marked(160000, 84000)), unmarked]);
  eq(r.measured, true, "two labelled events and one inferred clear the gate together");
  eq(r.n, 3, "the inferred event counts toward n");
  eq(r.tokens, 84000, "median of 80,000, 84,000 and the inferred 88,000");
  eq(r.why.includes("inferred"), true, "the why has to say that one event came from the curve rather than from a label");
});

/* ---------------------------------- units ---------------------------------- */

check("approx-tokens-is-four-chars", () => {
  eq(approxTok(4000), 1000, "four characters to the token");
  eq(approxTok(0), 0, "nothing is nothing");
});

/* ---------------------------------- report --------------------------------- */

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ${f}`);
  process.exit(1);
}
console.log("DONE");
