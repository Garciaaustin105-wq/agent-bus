/**
 * Harness for runner-limits.mjs.
 *
 * The failure this file is afraid of is the one that already happened: a
 * context-window cutoff diagnosed as an output-budget cutoff, "fixed" twice
 * by raising the wrong limit while three build tasks kept coming back
 * stranded (J2). So the checks here do not test that a diagnosis exists —
 * they test that the two failures get DIFFERENT answers, and that a runner
 * with no window set gets ollama's default rather than a number nobody
 * measured.
 *
 * Runs on object literals — no ollama, no fetch, no disk.
 *
 *   node tools/agent-bus/runner-limits-harness.mjs
 */
import { cutoffWhy, ollamaOptions } from "./runner-limits.mjs";

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
const ok = (c, what) => {
  if (!c) throw new Error(what);
};

/* ------------------------------- ollamaOptions ----------------------------- */

check("predict-is-per-runner", () => {
  eq(ollamaOptions({ predict: 32000, ctx: 32768 }).num_predict, 32000, "the runner's own budget wins");
});

check("thinking-runner-without-a-budget-gets-the-thinking-fallback", () => {
  eq(ollamaOptions({ thinking: true }).num_predict, 4000, "J2's historical fallback");
});

check("plain-runner-without-a-budget-gets-the-answer-only-fallback", () => {
  eq(ollamaOptions({}).num_predict, 1200, "answer-only models never needed more");
});

check("a-predict-of-zero-is-not-a-budget", () => {
  eq(ollamaOptions({ predict: 0 }).num_predict, 1200, "0 falls through to the fallback, like any falsy value");
});

check("no-window-set-means-ollamas-default-not-a-guess", () => {
  ok(!("num_ctx" in ollamaOptions({ predict: 14000 })), "an unmeasured runner must not carry an invented window");
});

check("a-measured-window-is-passed-through", () => {
  eq(ollamaOptions({ predict: 14000, ctx: 32768 }).num_ctx, 32768, "ctx from runners.json reaches the request");
});

check("temperature-is-stable-no-matter-what-else-changes", () => {
  eq(ollamaOptions({}).temperature, 0.2, "the dispatch temperature never moved");
});

/* ------------------------------- cutoffWhy --------------------------------- */

check("a-stopped-run-is-not-a-cutoff", () => {
  eq(cutoffWhy({ doneReason: "stop", evalCount: 7534, numPredict: 14000, numCtx: 32768, promptTokens: 2715 }), null,
    "done_reason stop means the model finished — diagnosing it would invent a failure");
});

check("the-budget-branch-names-the-budget", () => {
  const why = cutoffWhy({ doneReason: "length", evalCount: 14000, numPredict: 14000, numCtx: 32768, promptTokens: 2715 });
  ok(why.includes("num_predict"), `the budget diagnosis must name its limit, got: ${why}`);
});

check("the-context-branch-names-the-window", () => {
  const why = cutoffWhy({ doneReason: "length", evalCount: 400, numPredict: 14000, numCtx: 32768, promptTokens: 32400 });
  ok(why.includes("num_ctx"), `the context diagnosis must name its limit, got: ${why}`);
});

check("the-context-branch-does-not-fire-while-the-budget-is-the-limit", () => {
  const why = cutoffWhy({ doneReason: "length", evalCount: 14000, numPredict: 14000, numCtx: 32768, promptTokens: 2715 });
  ok(!why.includes("num_ctx"), `budget spent must not be blamed on the window, got: ${why}`);
});

check("the-context-branch-mentions-the-remedy", () => {
  const why = cutoffWhy({ doneReason: "length", evalCount: 400, numPredict: 14000, numCtx: 32768, promptTokens: 32400 });
  ok(why.includes("runners.json"), `a diagnosis an agent cannot act on is not a diagnosis, got: ${why}`);
});

check("an-unexplainable-length-says-what-it-observed-not-a-cause", () => {
  const why = cutoffWhy({ doneReason: "length", evalCount: 5000, numPredict: 14000, numCtx: 32768, promptTokens: 2715 });
  ok(why.includes("no limit reached"), `neither limit reached must say so, got: ${why}`);
  ok(!why.includes("num_predict spent") && !why.includes("filled"), "it must not pick a cause it cannot see");
});

check("a-runner-with-no-settings-still-gets-an-honest-answer", () => {
  const why = cutoffWhy({ doneReason: "length", evalCount: 400, promptTokens: 300 });
  ok(why.includes("done_reason length"), `the observed fact survives missing settings, got: ${why}`);
  ok(why.includes("default"), `the missing limits are named as defaults, got: ${why}`);
});

check("a-budget-spent-reading-beats-a-window-reading-when-both-would-fire", () => {
  // Context full AND budget spent in the same call: num_predict is the smaller,
  // more immediate owner of the stop, and the window note would send someone
  // raising ctx to fix a budget problem.
  const why = cutoffWhy({ doneReason: "length", evalCount: 14000, numPredict: 14000, numCtx: 32768, promptTokens: 32400 });
  ok(why.includes("num_predict"), `budget-first when both fire, got: ${why}`);
});

check("an-unknown-done-reason-is-not-a-cutoff", () => {
  eq(cutoffWhy({ doneReason: "load", evalCount: 0, numPredict: 4000 }), null, "only length ends a generation early");
});

console.log(`\n${pass} passing, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  FAILED: ${f}`);
  process.exit(1);
}