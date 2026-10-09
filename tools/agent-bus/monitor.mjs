/**
 * monitor.mjs — the pure contract for "how is this queue actually doing?"
 *
 * The spine's monitor stage, as a sibling of health.mjs: state in,
 * findings and numbers out, no disk. The thresholds are named constants and
 * NOT tunable knobs — each one is a stance about how long a thing may sit
 * before it stops being patience and starts being decay (health.mjs's rule;
 * a wrong number is moved by a finding, not by a config file).
 *
 * Three questions, all over state the bus already holds:
 *  1. What is the failure rate, and is it somebody in particular?
 *  2. Is a task stuck in a way health's static checks cannot see?
 *  3. Has the space been busy without ever shipping?
 *
 * The record is the history: the prune keeps the last 100 finished tasks,
 * so "over time" here means precisely "over the retained record", and every
 * report says its span out loud rather than implying a percentage covers
 * everything ever.
 */

export const RUN_OUTLIER_MULT = 3; // × median finished duration
export const RUN_OUTLIER_FLOOR_MS = 2 * 60 * 60 * 1000; // never flag < 2h elapsed
export const RUN_MEDIAN_MIN_SAMPLES = 5; // fewer finished tasks = no baseline yet
export const UNREVIEWED_MS = 7 * 24 * 60 * 60 * 1000; // done, unreviewed, 7 days
export const NO_SHIP_MS = 14 * 24 * 60 * 60 * 1000; // 14 days with no publish
export const NO_SHIP_MIN_FINISHED = 1; // activity since the last publish

/**
 * The failure rate over the retained record, overall and per runner.
 * The runner field is the claim side's identity — the thing that can fail
 * repeatedly while the average stays healthy. span is the retained window
 * measured from the oldest finished task's own timestamps, so any percentage
 * can be read WITH its window ("42 tasks over 9 days"), not instead of it.
 */
export function taskStats(state, { now = Date.now() } = {}) {
  const finished = (state.tasks ?? []).filter(
    (t) => t.status === "done" || t.status === "failed",
  );
  const total = finished.length;
  const failedRows = finished.filter((t) => t.status === "failed");

  const byRunner = new Map();
  for (const t of finished) {
    const r = t.runner ?? "unknown";
    const row = byRunner.get(r) ?? { runner: r, total: 0, failed: 0 };
    row.total++;
    if (t.status === "failed") row.failed++;
    byRunner.set(r, row);
  }

  let spanMs = 0;
  for (const t of finished) {
    const at = Date.parse(t.doneAt ?? t.startedAt ?? t.at ?? 0);
    if (Number.isFinite(at)) spanMs = Math.max(spanMs, now - at);
  }

  return {
    total,
    failed: failedRows.length,
    rate: total ? failedRows.length / total : null,
    perRunner: [...byRunner.values()],
    spanDays: spanMs ? round1(spanMs / 86400000) : 0,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (rate) => `${Math.round(rate * 100)}%`;

/**
 * Stuck-task findings beyond health's static checks. Returns
 * [{ kind, subject, detail }] in the same shape checkHealth returns, so the
 * caretaker feeds the union through one dedupe/clear/routing table and no
 * kind is rendered twice.
 */
export function monitorFindings(state, { now = Date.now() } = {}) {
  const findings = [];
  const ageOf = (iso) => now - Date.parse(iso);

  // LONG-RUNNING — a task held past any reasonable time under a runner who
  // may be alive and simply silent. health's stale-runner answers "is the
  // runner gone"; this answers "is the task itself stuck", measured against
  // the queue's own record rather than a magic hour count. No baseline
  // (fewer samples) means the check stays silent — a rule invented from no
  // data is a guess wearing a threshold.
  const durations = (state.tasks ?? [])
    .filter((t) => (t.status === "done" || t.status === "failed") && t.startedAt && t.doneAt)
    .map((t) => Date.parse(t.doneAt) - Date.parse(t.startedAt))
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((a, b) => a - b);
  if (durations.length >= RUN_MEDIAN_MIN_SAMPLES) {
    const median = durations[Math.floor(durations.length / 2)];
    const threshold = Math.max(RUN_OUTLIER_MULT * median, RUN_OUTLIER_FLOOR_MS);
    for (const t of state.tasks ?? []) {
      if (t.status !== "running") continue;
      const held = ageOf(t.startedAt ?? t.at);
      if (held > threshold) {
        findings.push({
          kind: "long-running",
          subject: t.id,
          detail:
            `task ${t.id} has been claimed for ${round1(held / 3600000)}h — past ` +
            `3× this lane's median finish (${round1(threshold / 3600000)}h).`,
        });
      }
    }
  }

  // UNREVIEWED-DONE — done is not finished (the hub strip has counted review
  // debt since the review surface shipped); the caretaker says it too, on
  // the board where the human gate actually looks. A task that went through
  // a review already is finished per its own record and never flagged.
  for (const t of state.tasks ?? []) {
    if (t.status !== "done" || (t.reviews ?? []).length) continue;
    if (ageOf(t.doneAt ?? t.at) > UNREVIEWED_MS) {
      findings.push({
        kind: "unreviewed-done",
        subject: t.id,
        detail:
          `task ${t.id} finished ${round1(ageOf(t.doneAt ?? t.at) / 86400000)} days ago and has no review — ` +
          `done is not finished here; review it or close it out.`,
      });
    }
  }

  // NO-SHIP — the observance the brainstorm asked for: a space finishing work
  // while its publish record goes cold. The activity clause is the point —
  // a quiet space is not decay; a busy one that never ships is. Subject is
  // the version the finding dates from (or "none"), so a ship lands, the
  // key changes, and the previous finding clears itself through the
  // caretaker's own machinery. Publishing is user-gated everywhere; this
  // files and stops.
  const publishes = state.publishes ?? [];
  const lastPublish = publishes.at(-1);
  const lastShipAt = lastPublish ? Date.parse(lastPublish.at) : null;
  const finishedSince = (state.tasks ?? []).filter(
    (t) => t.status === "done" && ageOf(t.doneAt ?? t.at) <= NO_SHIP_MS,
  );
  const shipAgeMs = lastShipAt ? now - lastShipAt : null;
  const isCold = lastPublish ? shipAgeMs > NO_SHIP_MS : true;
  if (isCold && finishedSince.length >= NO_SHIP_MIN_FINISHED) {
    const since = lastPublish
      ? `last publish ${lastPublish.version} now ${Math.round(shipAgeMs / 86400000)} days old, `
      : "no publish ever recorded, ";
    findings.push({
      kind: "no-ship",
      subject: lastPublish ? String(lastPublish.version) : "none",
      detail:
        `${since}${finishedSince.length} task(s) finished within the last ` +
        `${Math.round(NO_SHIP_MS / 86400000)} days — busy without shipping. Publish when it ships; nothing here compels it.`,
    });
  }

  return findings;
}

/**
 * The full monitor: the rate over its stated span per runner, then the
 * findings. A space with nothing finished renders quiet, not 0% — dividing
 * by zero is how fake precision starts.
 */
export function renderMonitor(state, { now = Date.now() } = {}) {
  const stats = taskStats(state, { now });
  const findings = monitorFindings(state, { now });

  if (!stats.total && !findings.length) {
    const queued = (state.tasks ?? []).filter((t) => t.status === "queued").length;
    return `Quiet. (No finished tasks in the retained record, ${queued} queued, no findings)`;
  }

  const lines = [];
  if (stats.total) {
    lines.push(
      `${stats.total} finished over the last ${stats.spanDays} days, ` +
        `${stats.failed} failed (${pct(stats.rate)})`,
    );
    for (const r of stats.perRunner) {
      lines.push(`  ${r.runner}  ${r.total} finished · ${r.failed} failed (${pct(r.failed / r.total)})`);
    }
  }
  lines.push(findings.length ? `${findings.length} finding(s):` : "No findings.");
  for (const f of findings) lines.push(`  ${f.kind.toUpperCase()} — ${f.detail}`);
  return lines.join("\n");
}