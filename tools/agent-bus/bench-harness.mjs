/**
 * The bench contract, checked. Roadmap §4's only hard gates are pinned here:
 * the bench never deletes anything (it prints commands a person runs), and
 * suggestions are gated on the machine actually qualifying.
 *
 *   node tools/agent-bus/bench-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import {
  BENCH_PROMPTS,
  JUDGE_INSTRUCTION,
  parseJudgeScore,
  pruneSuggestions,
  qualifiesForSuggestions,
  renderBench,
  scoreBench,
} from "./bench.mjs";

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

const GB = 1024 ** 3;

/* ── the judge's score line ──────────────────────────────────────────────── */

check("judge score parses 'SCORE: n — reason'", () => {
  assert.equal(parseJudgeScore("SCORE: 7 — follows the format exactly"), 7);
});

check("judge score is case-insensitive and tolerates x/10", () => {
  assert.equal(parseJudgeScore("score: 10"), 10);
  assert.equal(parseJudgeScore("SCORE: 8/10 — good"), 8);
});

check("a judge reply with no score line is null, not a guess", () => {
  assert.equal(parseJudgeScore("The answer is decent overall."), null);
});

check("an out-of-range score is refused, not clamped", () => {
  assert.equal(parseJudgeScore("SCORE: 11 — beyond the scale"), null);
});

check("the judge rubric demands one line with a score", () => {
  assert.ok(/SCORE/i.test(JUDGE_INSTRUCTION), "the format is named");
  assert.ok(BENCH_PROMPTS.length >= 3, "three prompts, so a tie is breakable");
  for (const bp of BENCH_PROMPTS) {
    assert.ok(bp.id && bp.prompt, `prompt ${bp.id} carries both fields`);
  }
});

/* ── the ranked table ────────────────────────────────────────────────────── */

check("ranking is quality first, speed breaks ties, id breaks stalemates", () => {
  const t = scoreBench({
    runs: [
      { id: "slow-good", ok: true, elapsedMs: 4000, chars: 400 }, // 100 c/s, q 9
      { id: "fast-ok", ok: true, elapsedMs: 1000, chars: 400 }, // 400 c/s, q 9
      { id: "better", ok: true, elapsedMs: 1000, chars: 400 }, // 400 c/s, q 9.5
      { id: "aaa", ok: true, elapsedMs: 1000, chars: 400 }, // 400 c/s, q 9 — tie with fast-ok
    ],
    scores: { "slow-good": [9], "fast-ok": [9], better: [9.5], aaa: [9] },
  });
  assert.deepEqual(
    t.ranked.map((r) => r.id),
    ["better", "aaa", "fast-ok", "slow-good"]
  );
});

check("an unjudged candidate ranks last and says so", () => {
  const t = scoreBench({
    runs: [
      { id: "scored", ok: true, elapsedMs: 1000, chars: 400 },
      { id: "opaque", ok: true, elapsedMs: 100, chars: 4000 },
    ],
    scores: { scored: [6] },
  });
  assert.equal(t.ranked.at(-1).id, "opaque");
  assert.equal(t.ranked.at(-1).quality, null);
  assert.ok(renderBench(t).includes("unjudged"), "the table says unjudged, not silent");
});

check("failed runs are results, listed with their reason", () => {
  const t = scoreBench({
    runs: [
      { id: "good", ok: true, elapsedMs: 1000, chars: 400 },
      { id: "dead", ok: false, elapsedMs: 100, chars: 0, error: "ollama returned 404" },
    ],
    scores: { good: [8] },
  });
  assert.equal(t.ranked.length, 1, "failures never rank");
  assert.equal(t.failed[0].id, "dead");
  assert.ok(t.failed[0].error.includes("404"), "the reason rides along");
  assert.ok(renderBench(t).includes("ollama returned 404"), "and the table prints it");
});

check("the reference is benched but never ranked against the candidates", () => {
  const t = scoreBench({
    runs: [
      { id: "local-a", ok: true, elapsedMs: 1000, chars: 400 },
      { id: "cloud", ok: true, elapsedMs: 500, chars: 800 },
    ],
    scores: { "local-a": [5], cloud: [10] },
    referenceId: "cloud",
  });
  assert.ok(!t.ranked.some((r) => r.id === "cloud"), "a cloud model winning every row says nothing about a local choice");
  assert.equal(t.reference.id, "cloud");
  assert.equal(t.reference.quality, 10);
  assert.ok(renderBench(t).includes("REF"), "the baseline is rendered beside the ranking");
});

check("speed is chars-per-second, and the render says it is not billed tokens", () => {
  const t = scoreBench({ runs: [{ id: "a", ok: true, elapsedMs: 2000, chars: 800 }], scores: { a: [5] } });
  assert.equal(t.ranked[0].speed, 400);
  const out = renderBench(t);
  assert.ok(out.includes("chars/s"), "the unit is named");
  assert.ok(out.includes("never added"), "the exact-vs-approx boundary is restated");
});

/* ── the hardware gate ───────────────────────────────────────────────────── */

check("below 8 GB RAM the gate refuses outright", () => {
  const g = qualifiesForSuggestions({ ramTotal: 6 * GB, gpus: [{ total: 16384 }] });
  assert.equal(g.ok, false);
  assert.ok(/No suggestions/i.test(g.reason), "no shopping list for a machine that cannot run the result");
});

check("no GPU means CPU-only, said as the cost it is", () => {
  const g = qualifiesForSuggestions({ ramTotal: 32 * GB, gpus: null });
  assert.equal(g.ok, true);
  assert.equal(g.tier, "cpu");
  assert.ok(/slow/i.test(g.reason), "minutes per answer, not hidden");
});

check("GPU size sets the honest ceiling", () => {
  assert.equal(qualifiesForSuggestions({ ramTotal: 32 * GB, gpus: [{ total: 4096 }] }).tier, "small");
  assert.equal(qualifiesForSuggestions({ ramTotal: 32 * GB, gpus: [{ total: 8192 }] }).tier, "mid");
  // 16 GB — the measured machine: a 20B MXFP4 model ran fully resident at a
  // 32k window there, so the tier claims 20B and does NOT claim 32B.
  const sixteen = qualifiesForSuggestions({ ramTotal: 32 * GB, gpus: [{ total: 16384 }] });
  assert.equal(sixteen.tier, "large");
  assert.ok(sixteen.maxParams.includes("20B"), "what actually fit, measured");
  assert.ok(!sixteen.maxParams.includes("32B"), "aspiration is not a ceiling");
  assert.equal(qualifiesForSuggestions({ ramTotal: 32 * GB, gpus: [{ total: 24576 }] }).tier, "xlarge");
});

/* ── delete suggestions: advice, never action ────────────────────────────── */

check("a clear loser is suggested, as a command a person runs", () => {
  const ranked = [
    { id: "winner", quality: 9, qualityN: 3, speed: 400, chars: 400 },
    { id: "loser", quality: 6, qualityN: 3, speed: 300, chars: 400 },
  ];
  const p = pruneSuggestions(ranked);
  assert.equal(p.length, 1);
  assert.equal(p[0].id, "loser");
  assert.equal(p[0].cmd, "ollama rm loser", "advice in the reader's own command form, never executed");
});

check("the command names the model tag, not the runner id — this ran live", () => {
  const ranked = [
    { id: "winner", quality: 9, qualityN: 3, speed: 400, chars: 400 },
    { id: "loser", model: "codestral:22b", quality: 6, qualityN: 3, speed: 300, chars: 400 },
  ];
  const p = pruneSuggestions(ranked);
  assert.equal(p[0].cmd, "ollama rm codestral:22b", "ollama knows tags; the runner id is only sometimes the tag");
});

check("the winner is never suggested for deletion, whatever its score", () => {
  const ranked = [
    { id: "winner", quality: 4, qualityN: 3, speed: 100, chars: 400 },
    { id: "other", quality: 3, qualityN: 3, speed: 100, chars: 400 },
  ];
  assert.equal(pruneSuggestions(ranked).length, 0);
});

check("a loser twice as fast as the winner is kept — speed is a real job", () => {
  const ranked = [
    { id: "winner", quality: 9, qualityN: 3, speed: 100, chars: 400 },
    { id: "quick-worse", quality: 6, qualityN: 3, speed: 250, chars: 400 },
  ];
  assert.equal(pruneSuggestions(ranked).length, 0, "2.5× the winner's speed earns its place on a fast lane");
});

check("an unjudged runner is never suggested for deletion", () => {
  const ranked = [
    { id: "winner", quality: 9, qualityN: 3, speed: 400, chars: 400 },
    { id: "opaque", quality: null, qualityN: 0, speed: 10, chars: 400 },
  ];
  assert.equal(pruneSuggestions(ranked).length, 0, "unknown is not a verdict");
});

check("no ranked table means no suggestions", () => {
  assert.deepEqual(pruneSuggestions([]), []);
  assert.deepEqual(pruneSuggestions([{ id: "only", quality: null, qualityN: 0, speed: 1, chars: 1 }]), []);
});

/* ── the rendered table ──────────────────────────────────────────────────── */

check("one runner, three prompts — one row, the aggregate", () => {
  const t = scoreBench({
    runs: [
      { id: "m", ok: true, elapsedMs: 1000, chars: 300 },
      { id: "m", ok: true, elapsedMs: 2000, chars: 500 },
      { id: "m", ok: true, elapsedMs: 3000, chars: 100 },
    ],
    scores: { m: [8, 9, 7] },
  });
  assert.equal(t.ranked.length, 1, "a model ranked against itself three times is three rows of noise");
  const r = t.ranked[0];
  assert.equal(r.quality, 8, "quality averaged over its scores");
  assert.equal(r.qualityN, 3);
  assert.equal(r.chars, 900, "chars summed");
  assert.equal(r.speed, 150, "speed over total chars and total clock");
});

check("a candidate with a partial failure still ranks, carrying the failure", () => {
  const t = scoreBench({
    runs: [
      { id: "m", ok: true, elapsedMs: 1000, chars: 400 },
      { id: "m", ok: false, elapsedMs: 100, chars: 0, error: "stream stalled" },
    ],
    scores: { m: [7] },
  });
  const r = t.ranked[0];
  assert.equal(r.failedN, 1, "the failure is on the row, not hidden");
  assert.equal(r.promptsN, 1);
  assert.ok(renderBench(t).includes("1 of 2 prompts failed: stream stalled"), "the render says what failed");
});

check("the render carries the two hard gates in its own words", () => {
  const t = scoreBench({
    runs: [
      { id: "a", ok: true, elapsedMs: 1000, chars: 400 },
      { id: "b", ok: true, elapsedMs: 1500, chars: 300 },
    ],
    scores: { a: [9], b: [5] },
  });
  const prunes = pruneSuggestions(t.ranked);
  const out = renderBench(t, { prunes, qualify: qualifiesForSuggestions({ ramTotal: 32 * GB, gpus: [{ total: 16384 }] }), judgeId: "glm" });
  assert.ok(out.includes("deletions are yours to run"), "the human gate is in the output");
  assert.ok(out.includes("ollama rm b"), "the command is there to copy");
  assert.ok(out.includes("judge: glm"), "who graded is named");
  assert.ok(out.includes("20B models fit"), "the machine's ceiling is stated");
});

check("an empty bench renders honestly instead of crashing", () => {
  const out = renderBench({ ranked: [], failed: [], reference: null }, { prunes: [] });
  assert.ok(out.includes("nothing to bench"), "the empty case says itself");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);