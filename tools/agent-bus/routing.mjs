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
 * ROLES are the one place the bus DOES choose (the user, 2026-09-14: rules
 * must not name anyone's models — "make the agent bus pick which ai it will
 * need to fill for these roles"). A task that names a role, or is big enough
 * to imply one, is pinned to the runner that role's measurements favour, and
 * the reply says who and why. Nothing measured yet means no pin: the lane's
 * default runs and the advisory line rides along, as before.
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
      // How long the run took, when both ends were stamped. An old task
      // without startedAt is still evidence of an outcome, just not of speed.
      ms: t.startedAt && t.doneAt ? Date.parse(t.doneAt) - Date.parse(t.startedAt) : null,
      empty: t.status === "done" && isEmptyAnswer(t.result),
    }));
}

/**
 * The worker's marker for a run that thought but never answered. It counts as
 * done on the queue (the thinking is still worth reading), but for routing it
 * is a miss, the same as a failure.
 */
export const isEmptyAnswer = (result) => typeof result === "string" && result.startsWith("[no final answer");

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

/**
 * The two jobs a handoff can be. Names only: which runner fills each is
 * measured, per machine, from that machine's own finished tasks.
 */
export const ROLES = {
  quick: "an ordinary job, about one file's worth: the fastest runner that reliably answers",
  deep: "a long or tricky job: the runner that most reliably returns a full answer",
};

/** Past this many prompt tokens (four chars each) a job is long: deep. */
export const DEEP_PROMPT_TOKENS = 2000;

/** A task's role: the one it names, else sized from its prompt. */
export function inferRole(task) {
  if (typeof task?.role === "string" && Object.hasOwn(ROLES, task.role)) return task.role;
  return Math.ceil(String(task?.prompt ?? "").length / 4) > DEEP_PROMPT_TOKENS ? "deep" : "quick";
}

/** A runner needs this many finishes before its record can choose for a role. */
export const MEASURED_FINISHES = 3;
/** quick only considers runners that miss (fail or come back empty) at most this often. */
export const QUICK_MAX_MISS_RATE = 0.25;

/**
 * Fill a role from measurements. Returns null when nothing is eligible, else
 * {id, role, cold, why, considered: [{id, picked, why}]}.
 *
 * Gates, as recommendRunner: enabled, not in `exclude` (already tried on this
 * task), prompt fits ctx, not on a three-failure streak. Then over each
 * survivor's last ten finishes: misses = failed + empty answers.
 *   quick: among measured runners missing at most 25%, the lowest median run
 *          time; if none qualifies, the deep ordering.
 *   deep:  among measured runners, the fewest misses, then the longest
 *          average answer.
 * Ties break alphabetical. With no runner measured (3 finishes), the first
 * eligible one is returned with cold: true — task_add does not pin a cold
 * pick; a retry, which has to go somewhere, does.
 */
export function pickForRole(role, task, runners, history, exclude = []) {
  const prompt = String(task?.prompt ?? "");
  const promptTokens = Math.ceil(prompt.length / 4);
  const by = {};
  for (const h of history ?? []) (by[h.runner] ||= []).push(h);

  const considered = [];
  const survivors = [];
  for (const r of runners ?? []) {
    if (!r || !r.id || !r.enabled) continue;
    if (exclude.includes(r.id)) {
      considered.push({ id: r.id, picked: false, why: "already tried on this task" });
      continue;
    }
    if (r.ctx && promptTokens > Math.floor(r.ctx * 0.9)) {
      considered.push({ id: r.id, picked: false, why: `prompt (~${promptTokens.toLocaleString()} tokens) would not fit its ctx (${r.ctx.toLocaleString()})` });
      continue;
    }
    const rec = (by[r.id] ?? []).slice(-10);
    let streak = 0;
    while (streak < rec.length && rec[rec.length - 1 - streak].status === "failed") streak++;
    if (streak >= 3) {
      considered.push({ id: r.id, picked: false, why: `failed its last ${streak} — needs to prove itself first` });
      continue;
    }
    const n = rec.length;
    const misses = rec.filter((h) => h.status === "failed" || h.empty).length;
    const answers = rec.filter((h) => h.status === "done" && !h.empty);
    const times = answers.map((h) => h.ms).filter((ms) => Number.isFinite(ms) && ms >= 0).sort((a, b) => a - b);
    const medianMs = times.length ? times[Math.floor((times.length - 1) / 2)] : null;
    const avgChars = answers.length ? Math.round(answers.reduce((a, h) => a + h.chars, 0) / answers.length) : 0;
    const s = { id: r.id, n, measured: n >= MEASURED_FINISHES, missRate: n ? misses / n : 0, medianMs, avgChars };
    survivors.push(s);
    considered.push({
      id: r.id,
      picked: false,
      why: s.measured
        ? `${misses} miss${misses === 1 ? "" : "es"} in its last ${n}` +
          (medianMs != null ? `, median ${Math.round(medianMs / 1000)} s` : "") +
          (avgChars ? `, answers ~${avgChars.toLocaleString()} chars` : "")
        : `only ${n} finish${n === 1 ? "" : "es"} — not measured yet`,
    });
  }
  if (!survivors.length) return null;

  const done = (pick, cold, why) => ({
    id: pick.id,
    role,
    cold,
    why,
    considered: considered.map((c) => (c.id === pick.id ? { ...c, picked: true } : c)),
  });
  const measured = survivors.filter((s) => s.measured);
  if (!measured.length) {
    return done(survivors[0], true, `no runner has ${MEASURED_FINISHES} finishes yet — first eligible; outcomes will teach the router`);
  }
  const reliable = (a, b) => a.missRate - b.missRate || b.avgChars - a.avgChars || a.id.localeCompare(b.id);
  const whyOf = (s) => considered.find((c) => c.id === s.id).why;
  if (role === "quick") {
    const fast = measured
      .filter((s) => s.missRate <= QUICK_MAX_MISS_RATE && s.medianMs != null)
      .sort((a, b) => a.medianMs - b.medianMs || a.missRate - b.missRate || a.id.localeCompare(b.id));
    if (fast.length) return done(fast[0], false, `fastest that reliably answers: ${whyOf(fast[0])}`);
    const best = measured.sort(reliable)[0];
    return done(best, false, `none is both fast and reliable, so the most reliable: ${whyOf(best)}`);
  }
  const best = measured.sort(reliable)[0];
  return done(best, false, `most reliable, fullest answers: ${whyOf(best)}`);
}

/** The one-line reply when task_add pins a role's pick. */
export const routedLine = (pick) =>
  `Routed to ${pick.id} for the ${pick.role} role — ${pick.why}. Pass runner_id to choose another.`;

/** The one-line suggestion task_add appends — advisory, with the why attached. */
export const suggestLine = (rec) =>
  rec ? `Routing suggestion: ${rec.id} — ${rec.why}. Pass runner_id: "${rec.id}" to pin it.` : "";