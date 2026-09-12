/**
 * The two ways an ollama call can die early, and who owns each limit.
 *
 * `num_predict` is the OUTPUT budget — tokens the model may write, thinking
 * and answer combined (J2). `num_ctx` is the CONTEXT window — prompt and
 * generation share it, and ollama defaults it to a number far below what a
 * build task needs (a spec plus its protocol preamble is ~2,700 tokens before
 * the model thinks a word). Generation stops at whichever limit is hit first,
 * and BOTH come back looking the same: `response` empty, reasoning stranded
 * in `thinking`. Three build tasks were read as "ran out of output budget"
 * and fixed by raising `num_predict` twice before anyone measured the other
 * limit — this module exists so the diagnosis stops being a guess.
 *
 * Pure contract: numbers in, strings out, no disk, no fetch. `askOllama`
 * (server.mjs) is the I/O half and reads nothing from a runner itself.
 */

/**
 * Options object for one /api/generate call.
 *
 * Both budgets are per-runner properties in runners.json, because how much a
 * model thinks and how big its window is are properties of the model (J2).
 * `predict` falls back to the historical pair so an old runner entry keeps
 * working; `ctx` falls back to NOTHING — ollama's default applies — because a
 * made-up window on a VRAM-bound local model can silently evict weights
 * (HANDOFF section 4). A runner that needs a real window gets one measured,
 * in runners.json, not here.
 */
export function ollamaOptions(runner) {
  const opts = {
    temperature: 0.2,
    num_predict: runner.predict || (runner.thinking ? 4000 : 1200),
  };
  if (runner.ctx) opts.num_ctx = runner.ctx;
  return opts;
}

/**
 * Why a response came back empty, or null when it did not.
 *
 * ollama reports which limit ended generation in `done_reason`:
 *   "stop"   — finished on its own; nothing to diagnose.
 *   "length" — a limit was hit. WHICH one is readable from the counts:
 *              `eval_count` is tokens generated; if it reached `num_predict`
 *              the output budget was spent; if it stopped well under that,
 *              the context window filled first (prompt + generation share
 *              num_ctx — HANDOFF section 4). A number nobody picked cannot
 *              diagnose itself, so an unexplainable "length" says what it
 *              observed instead of picking a cause.
 */
export function cutoffWhy({ doneReason, evalCount, numPredict, numCtx, promptTokens }) {
  if (doneReason !== "length") return null;
  const saw = (a, b, what) =>
    `stopped early (done_reason length): ${what} — measured ${a}, limit ${b}`;
  if (numPredict && evalCount >= numPredict) return saw(evalCount, numPredict, "output budget (num_predict) spent");
  if (numCtx && promptTokens + evalCount >= numCtx) {
    return `stopped early (done_reason length): context window (num_ctx ${numCtx}) filled before the output budget (${numPredict ?? "default"}) could be spent — prompt alone was ${promptTokens} tokens. Raise ctx for this runner in runners.json`;
  }
  return `stopped early (done_reason length) with no limit reached: wrote ${evalCount} tokens of a ${numPredict ?? "default"}-token budget against a ${numCtx ?? "default"}-token window — the runner settings and what ollama reports disagree, check both`;
}