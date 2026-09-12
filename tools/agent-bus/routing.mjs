/**
 * §3 — "which AI suits which task," answered from data. Every finished task
 * records which runner ran it and how it ended, so the fleet's own history is
 * the routing table; this module reads it and answers "who gets this one."
 *
 * The recommendation is ADVISORY, deliberately. task_add without a runner_id
 * still goes to the lane's default runner — the recommendation rides along in
 * the reply, and whoever queues the task pins it with runner_id if they agree.
 * An automatic router that silently reassigns work is a failure nobody can
 * see; a suggestion with its reason attached can be argued with, and a
 * recommendation that is ignored is also data (it did not earn trust yet).
 *
 * Same philosophy as blockers.mjs: dumb, deterministic, explainable. A match
 * nobody can audit is worth less than a rule everybody can check, so every
 * considered runner carries the why — picked or skipped, both.
 *
 * Pure contract: tasks, runners and words in, recommendations out, no disk,
 * no network (build rule 2). The state layer lives in server.mjs.
 */

/**
 * Pull the routing history out of the task queue. `model` is what the worker
 * stamps on both outcomes (the chosen runner id on done; the intended one on
 * failed), so a task with no model never ran and is not evidence of anything.
 */
export function extractHistory(tasks) {
  return (tasks ?? [])
    .filter((t) => (t.status === "done" || t.status === "failed") && t.model)
    .map((t) => ({
      runner: t.model,
      status: t.status,
      chars: typeof t.result === "string" ? t.result.length : 0,
      at: t.doneAt ?? t.at ?? "",
    }));
}

/**
 * Per-runner record and verdict — the "records when a model outperformed or
 * failed its assignment" half of §3. A runner's STREAK (its trailing run of
 * same-status finishes) is what earns a verdict: three failures in a row is a
 * pattern no average can hide, and a clean record with real volume is a
 * default worth keeping. Returns {id, done, failed, avgChars, streak, line}.
 */
export function routingVerdicts(history) {
  const by = {};
  for (const h of history ?? []) {
    (by[h.runner] ||= { rec: [] }).rec.push(h);
  }
  const out = [];
  for (const [id, { rec }] of Object.entries(by)) {
    rec.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const done = rec.filter((r) => r.status === "done").length;
    const failed = rec.length - done;
    const chars = rec.filter((r) => r.status === "done").map((r) => r.chars);
    const avgChars = chars.length ? Math.round(chars.reduce((a, c) => a + c, 0) / chars.length) : 0;
    // The trailing streak: walk backwards while the outcome repeats.
    let streak = 1;
    while (streak < rec.length && rec[rec.length - 1 - streak].status === rec[rec.length - 1].status) streak++;
    const lastStatus = rec[rec.length - 1].status;
    let verdict;
    if (lastStatus === "failed" && streak >= 3) {
      verdict = `failed its last ${streak} — stop routing here until it proves itself`;
    } else if (lastStatus === "done" && streak >= 5) {
      verdict = `${streak} clean finishes in a row — a default worth keeping`;
    } else if (done >= 3 && failed === 0) {
      verdict = "clean record so far — keep in rotation";
    } else {
      verdict = "mixed record — watch it";
    }
    out.push({
      id,
      done,
      failed,
      avgChars,
      streak,
      lastStatus,
      line: `${id} — ${done} done, ${failed} failed` +
        (avgChars ? `, avg draft ${avgChars.toLocaleString()} chars` : "") +
        ` — ${verdict}`,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Recommend a runner for a task. `runners` is the runners.json list
 * (enabled flag, optional ctx in tokens); `history` is extractHistory's
 * output. Returns null when nothing can run this, or
 * {id, why, considered: [{id, picked, why}]}.
 *
 * The gates, in order — a runner has to clear all of them to be picked:
 *   1. enabled. A disabled entry is a note, not an offer.
 *   2. context. A prompt that would not fit the runner's ctx is a waste of a
 *      run (approximation: four characters to the token — the same convention
 *      token-watch.mjs uses, good enough to rank and never to bill).
 *   3. streak. Three failures in a row with no success behind them is not
 *      variance; skip the runner and say so.
 * Among survivors, the best recent record wins — done minus twice failed over
 * the runner's last ten finishes, a failed task costing double because a
 * failure costs the reviewer their time too. Ties break alphabetical, so the
 * same inputs always name the same runner.
 */
export function recommendRunner(task, runners, history) {
  const enabled = (runners ?? []).filter((r) => r && r.enabled && r.id);
  if (!enabled.length) return null;
  const prompt = String(task?.prompt ?? "");
  const promptTokens = Math.ceil(prompt.length / 4);

  // Recent record per runner — the runner's own last ten finishes.
  const by = {};
  for (const h of history ?? []) (by[h.runner] ||= []).push(h);
  const score = (id) => {
    const rec = (by[id] ?? []).slice(-10);
    return rec.reduce((s, r) => s + (r.status === "done" ? 1 : -2), 0);
  };
  const streakOf = (id) => {
    const rec = (by[id] ?? []).slice(-10);
    if (!rec.length) return { n: 0, status: null };
    let n = 1;
    while (n < rec.length && rec[rec.length - 1 - n].status === rec[rec.length - 1].status) n++;
    return { n, status: rec[rec.length - 1].status };
  };

  const considered = [];
  const survivors = [];
  for (const r of enabled) {
    if (r.ctx && promptTokens > Math.floor(r.ctx * 0.9)) {
      considered.push({ id: r.id, picked: false, why: `prompt (~${promptTokens.toLocaleString()} tokens) would not fit its ctx (${r.ctx.toLocaleString()})` });
      continue;
    }
    const s = streakOf(r.id);
    if (s.status === "failed" && s.n >= 3) {
      considered.push({ id: r.id, picked: false, why: `failed its last ${s.n} — needs to prove itself first` });
      continue;
    }
    const sc = score(r.id);
    const hasHistory = (by[r.id] ?? []).length > 0;
    considered.push({
      id: r.id,
      picked: false,
      why: hasHistory
        ? `recent record ${sc >= 0 ? "+" : ""}${sc} over its last ${(by[r.id].slice(-10)).length} finishes`
        : "no record yet — eligible on cold start",
    });
    survivors.push({ id: r.id, sc, hasHistory });
  }
  if (!survivors.length) return null;

  // Cold start: nobody has any record. Say so instead of pretending data chose.
  if (!survivors.some((s) => s.hasHistory)) {
    const first = survivors[0];
    return {
      id: first.id,
      why: "no history for any enabled runner yet — first eligible one; outcomes will teach the router",
      considered: considered.map((c) => (c.id === first.id ? { ...c, picked: true } : c)),
    };
  }

  survivors.sort(
    (a, b) =>
      // A runner WITH history outranks one without — "unknown" is not a score.
      (b.hasHistory ? 1 : 0) - (a.hasHistory ? 1 : 0) ||
      b.sc - a.sc ||
      a.id.localeCompare(b.id),
  );
  const pick = survivors[0];
  const pickedWhy = considered.find((c) => c.id === pick.id)?.why ?? "";
  return {
    id: pick.id,
    why: pickedWhy.replace(/^no record yet/, "unproven but eligible") || "best recent record among eligible runners",
    considered: considered.map((c) => (c.id === pick.id ? { ...c, picked: true } : c)),
  };
}

/** The one-line suggestion task_add appends — advisory, with the why attached. */
export const suggestLine = (rec) =>
  rec ? `Routing suggestion: ${rec.id} — ${rec.why}. Pass runner_id: "${rec.id}" to pin it.` : "";