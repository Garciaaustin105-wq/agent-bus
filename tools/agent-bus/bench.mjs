/**
 * The bench contract — roadmap §4, the only lane gated on the user's ask.
 *
 * What a bench IS here: the enabled local runners answer the same fixed
 * prompts; a designated judge runner (the cloud model, by convention) scores
 * each answer; speed comes from the wall clock. The ranked table, the
 * hardware gate and the delete suggestions are all pure functions of that
 * data — no network, no disk, no model calls in this file. The verb that
 * gathers the data lives in server.mjs; this file stays testable.
 *
 * Two boundaries are load-bearing:
 *
 * - NEVER deletes anything. "The user's disk is not a museum" is the goal, but
 *   a bench that could `rm` a model itself is one bad score away from deleting
 *   something the user wanted. The contract returns COMMANDS for a person to
 *   run — the same human gate `share` puts between this machine and the world.
 * - Suggestions only when the system qualifies. A machine that cannot hold
 *   even a small model resident gets told that, not a shopping list.
 *
 *   node tools/agent-bus/bench-harness.mjs   (exit 0 = all green)
 */

// The fixed bench set. Small on purpose — a bench that costs a minute per
// candidate per prompt never gets run twice. Each prompt has a shape a judge
// can score against the prompt alone (correct format, follows the constraint),
// which is what "quality" means here: instruction-following, not taste.
export const BENCH_PROMPTS = [
  {
    id: "edits",
    prompt:
      "You are editing a file. Reply with ONLY a JSON array of edits, each {\"id\": 1, \"find\": \"exact text to find\", \"replace\": \"new text\"}. Task: in a config module, rename the export `getConf` to `getConfig` everywhere it appears, and add a comment above the export saying 'validated before use'. Keep the array minimal.",
  },
  {
    id: "extract",
    prompt:
      "Summarise in EXACTLY three bullet points, each starting with '- '. Text: The parser grew a second path for handling streaming responses after the headers timeout killed long generations. The stream also became the only live signal a run gives off. A watchdog was added later when a stalled body still hung the lane; a torn final line is tolerated because it means the stream was cut, not that the call failed.",
  },
  {
    id: "reason",
    prompt:
      "A queue holds tasks t1..t5. A worker claims the first queued task whose lane matches. t2 (lane build) and t3 (lane local) are queued; t1 (lane local) is running. A worker on lane 'local' starts. Which task does it claim, and why? Answer in one sentence.",
  },
];

// The judge's rubric is part of the contract — a judge asked "is this good?"
// scores vibes. Score 0-10, exactly one line, so parsing can be dumb.
export const JUDGE_INSTRUCTION =
  "You are grading a model's answer against its prompt. Judge instruction-following and correctness only — style does not score. " +
  'Reply with exactly one line: SCORE: <0-10> — <one short reason>.';

/** Pull `SCORE: n` out of a judge reply; null when the judge did not answer in format. */
export function parseJudgeScore(text) {
  const m = String(text ?? "").match(/SCORE:\s*(\d{1,2})(?:\s*\/\s*10)?\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 10 ? n : null;
}

/**
 * The ranked table.
 *
 * runs   — [{id, ok, elapsedMs, chars, error?}] one entry per RUN — a
 *          candidate answers every bench prompt, and its row is the AGGREGATE
 *          of those runs: quality averaged over its judge scores, speed over
 *          its total chars and total wall clock. A bench that printed one row
 *          per prompt ranked a model against itself three times; that bug
 *          shipped once and the harness now pins the grouping.
 * scores — { [id]: [n, ...] } judge scores per prompt, already parsed
 * referenceId — a runner that is the baseline, not a candidate; it is pulled
 *               out of the ranking and reported beside it. A cloud model
 *               benchmarked against local ones would otherwise win every row
 *               and say nothing about any local choice.
 *
 * A candidate whose every run failed is a FAILED row with the first reason. A
 * candidate with some runs failed still ranks on what it produced, carrying
 * the failure count — a partial result is not hidden, and not fatal.
 *
 * Ranking: quality first, speed breaks ties, id breaks stalemates — the same
 * explainable ordering the routing table uses, and for the same reason: a
 * bench result nobody can re-derive is worse than no bench. A candidate the
 * judge never scored (judge failed, or the answer was unusable) ranks LAST
 * with its quality said as unknown — silence would read as a verdict.
 */
export function scoreBench({ runs, scores = {}, referenceId = null }) {
  const grouped = new Map(); // id -> { ok: [], failed: [] }
  for (const r of (runs ?? []).filter((x) => x && x.id)) {
    const g = grouped.get(r.id) ?? { ok: [], failed: [] };
    (r.ok ? g.ok : g.failed).push(r);
    grouped.set(r.id, g);
  }
  const ranked = [];
  const failed = [];
  let reference = null;
  for (const [id, g] of grouped) {
    const isRef = referenceId != null && id === referenceId;
    if (!g.ok.length) {
      const row = { id, error: g.failed[0]?.error ?? "failed", failedN: g.failed.length };
      if (isRef) { reference = { ...row, quality: null, qualityN: 0, speed: 0, chars: 0 }; continue; }
      failed.push(row);
      continue;
    }
    const row = aggregate(id, g, scores[id]);
    if (isRef) reference = row;
    else ranked.push(row);
  }
  ranked.sort((a, b) => {
    if (a.quality == null && b.quality == null) return cmp(b.speed, a.speed) || cmp(a.id, b.id);
    if (a.quality == null) return 1;
    if (b.quality == null) return -1;
    return cmp(b.quality, a.quality) || cmp(b.speed, a.speed) || cmp(a.id, b.id);
  });
  return { ranked, failed, reference };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function aggregate(id, g, scoreList) {
  const scores = (scoreList ?? []).filter((n) => typeof n === "number");
  const chars = g.ok.reduce((a, r) => a + (r.chars ?? 0), 0);
  const ms = g.ok.reduce((a, r) => a + (r.elapsedMs ?? 0), 0);
  const seconds = ms / 1000;
  return {
    id,
    quality: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    qualityN: scores.length,
    speed: seconds > 0 ? chars / seconds : 0, // chars/sec — approx tokens at 4 chars/token, never billed
    chars,
    promptsN: g.ok.length,
    failedN: g.failed.length,
    failedWhy: g.failed[0]?.error ?? null,
  };
}

/**
 * The hardware gate for §4's second hard rule: suggestions only when the
 * system qualifies. Data in, verdict out — the caller gathers the hardware.
 *
 * Tiers are honest ceilings, not aspirations: model weights plus KV cache
 * must fit, or throughput collapses (the same note the hardware panel makes).
 * No GPU means CPU-only, which is said as the cost it is.
 */
const GB = 1024 ** 3;
export function qualifiesForSuggestions(hw) {
  const ramTotal = hw?.ramTotal ?? 0;
  const gpu = (hw?.gpus ?? [])
    .map((g) => Number(g.total) || 0)
    .sort((a, b) => b - a)[0]; // MB, best GPU only
  if (ramTotal < 8 * GB) {
    return { ok: false, tier: null, reason: "Less than 8 GB of RAM — below what even a small local model needs. No suggestions." };
  }
  if (!gpu) {
    return { ok: true, tier: "cpu", maxParams: "≤ 3B", reason: "No GPU detected: CPU-only. Small models (≤ 3B) only, and slowly — a bench still works, but expect minutes per answer." };
  }
  // Weights PLUS KV cache must fit, so the boundaries are generous: a 4 GB card
  // does not hold a 7B at quality and context at once. The 12–24 GB tier says
  // ≤ 20B because that is measured here, not aspirational — a 20B MXFP4 model
  // ran fully resident at a 32k window on 16 GB; a 32B dense model would not.
  if (gpu < 6 * 1024) return { ok: true, tier: "small", maxParams: "≤ 7B", reason: `GPU with ${gpu} MB — small models (≤ 7B) fit.` };
  if (gpu < 12 * 1024) return { ok: true, tier: "mid", maxParams: "≤ 14B", reason: `GPU with ${gpu} MB — mid models (≤ 14B) fit.` };
  if (gpu < 24 * 1024) return { ok: true, tier: "large", maxParams: "≤ 20B", reason: `GPU with ${gpu} MB — up to 20B models fit (weights plus a real context window).` };
  return { ok: true, tier: "xlarge", maxParams: "≤ 32B", reason: `GPU with ${gpu} MB — large models (≤ 32B) fit.` };
}

/**
 * Delete suggestions — the "test and delete" half, as advice only.
 *
 * A loser is a candidate whose quality is 2+ points under the winner AND that
 * is not even twice as fast. The speed guard is deliberate: a slightly worse
 * model that answers twice as fast has a real job on a fast lane, and a bench
 * that cannot see that would recommend deleting the useful runner. The winner
 * is never suggested for deletion, whatever its score.
 *
 * The command names the RUNNER'S MODEL, not the runner id — ollama knows tags
 * like "codestral:22b", and the runner id is only sometimes the tag. This ran
 * live: the printed `ollama rm codestral` failed with "model not found" while
 * `codestral:22b` sat on disk. Rows carry `model` when the caller knows it;
 * without one the id is the best guess available.
 */
export function pruneSuggestions(ranked) {
  const winner = ranked?.[0];
  if (!winner || winner.quality == null) return [];
  const out = [];
  for (const r of ranked.slice(1)) {
    if (r.quality == null) continue; // unjudged — unknown is not a verdict
    if (winner.quality - r.quality < 2) continue;
    if (r.speed >= winner.speed * 2) continue;
    out.push({
      id: r.id,
      cmd: `ollama rm ${r.model ?? r.id}`,
      reason: `quality ${r.quality.toFixed(1)} vs winner ${winner.quality.toFixed(1)}, and only ${ratio(winner.speed, r.speed)} the winner's speed`,
    });
  }
  return out;
}

const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 10) / 10 : "∞");

/** The printed table. Numbers say what they are; nothing here is exact token accounting. */
export function renderBench({ ranked, failed, reference }, { prunes = [], qualify = null, judgeId = null } = {}) {
  const lines = [];
  const q = (r) =>
    r.quality == null
      ? `unjudged (${r.qualityN} scores)`
      : `${r.quality.toFixed(1)}/10 over ${r.qualityN}`;
  const s = (r) => `${Math.round(r.speed)} chars/s (~${Math.round(r.speed / 4)} tok/s)`;
  lines.push("BENCH — same prompts to every candidate, judge scores the answers");
  if (judgeId) lines.push(`judge: ${judgeId} (cloud as reference — its row is the baseline, not a contestant)`);
  lines.push("");
  if (reference) {
    lines.push(`  REF  ${reference.id}`);
    lines.push(`       quality ${q(reference)} · ${s(reference)}`);
  }
  if (!ranked.length && !failed.length && !reference) {
    lines.push("  nothing to bench — no enabled runners");
  }
  ranked.forEach((r, i) => {
    lines.push(`  ${i === 0 ? "→" : " "}${String(i + 1).padStart(2)}  ${r.id}`);
    const partial = r.failedN ? ` · ${r.failedN} of ${r.failedN + r.promptsN} prompts failed: ${r.failedWhy}` : "";
    lines.push(`       quality ${q(r)} · ${s(r)} · ${r.chars} chars out${partial}`);
  });
  for (const f of failed) {
    lines.push(`  ✗   ${f.id} — failed: ${f.error}`);
  }
  if (prunes.length) {
    lines.push("", "DISK IS NOT A MUSEUM — deletions are yours to run, nothing here deletes:");
    for (const p of prunes) lines.push(`  ${p.cmd}   # ${p.reason}`);
  } else if (ranked.length > 1) {
    lines.push("", "no delete suggestions: no runner is both 2+ points worse AND not twice as fast as the winner");
  }
  if (qualify) {
    lines.push("", qualify.ok ? `This machine qualifies for local-model suggestions: ${qualify.reason}` : qualify.reason);
  }
  lines.push("", "Speed is chars/sec wall clock, not billed tokens (counts from usage are exact; these are not, and the two are never added).");
  return lines.join("\n");
}