/**
 * health.mjs — the pure contract for "is this space decaying?"
 *
 * State in, findings out, no disk (D4's neighbour: no I/O here makes both
 * callers — the `health` verb and the caretaker in agent.mjs — free to run
 * it inside or outside the state lock). The thresholds are named constants,
 * not magic numbers buried in a line, and NOT tunable knobs: each one is a
 * stance about how long a thing may sit before it stops being patience and
 * starts being decay. If one is wrong, the finding that proves it goes on
 * the board and the number moves then.
 *
 * The tree lock is deliberately absent: lockIsLive() is process-proven
 * (holderAlive), so a dead holder is already invisible and a live one is a
 * claim somebody is using, not decay to report.
 */

export const STALE_RUNNER_MS = 2 * 60 * 60 * 1000; // 2h: running, but silent
export const QUEUED_BACKLOG_MS = 24 * 60 * 60 * 1000; // 1 day queued, unpicked
export const DRAFT_PENDING_MS = 24 * 60 * 60 * 1000; // 1 day waiting on a human apply
export const UNTAKEN_HANDOFF_MS = 48 * 60 * 60 * 1000; // 2 days with no taken chain
export const OPEN_BLOCK_MS = 72 * 60 * 60 * 1000; // 3 days OPEN, unresolved

const ONE = (ms) => (ms >= 2 * 86400000 ? `${Math.round(ms / 86400000)} days` : `${Math.round(ms / 3600000)} hours`);

/**
 * Returns findings[], each { kind, subject, detail }, worst-uncertainty last
 * is not a thing — findings come back grouped by kind in the order of the
 * table above, and every detail stands alone (the caretaker files findings
 * verbatim; a detail that only reads next to a sibling would leave that job
 * broken). Subjects are stable strings — task id, board key, agent name —
 * because the caretaker dedupes on kind+subject.
 */
export function checkHealth(state, { now = Date.now() } = {}) {
  const findings = [];
  const ageOf = (iso) => now - Date.parse(iso);

  // STALE RUNNER — a task wearing "running" over a session nobody is in.
  // The pid check answers "does the process exist"; this asks the question
  // the pid check cannot: is the SESSION still keeping its bus presence
  // fresh. An hour-cold agent prunes itself; a two-hour silence on a
  // claimed task means the claim reads busy while doing nothing.
  const agents = state.agents ?? {};
  for (const t of state.tasks ?? []) {
    if (t.status !== "running") continue;
    const a = agents[t.runner];
    if (a && a.lastSeen) {
      const seen = ageOf(a.lastSeen);
      if (seen > STALE_RUNNER_MS) {
        findings.push({
          kind: "stale-runner",
          subject: t.id,
          detail:
            `task ${t.id} reads running but its runner (${t.runner}) was last seen ` +
            `${Math.round(seen / 3600000)}h ago — the claim is doing nothing.`,
        });
      }
    } else {
      // No session record left: pruned (an hour cold, non-running process) or
      // a worker that never registered. Judge by how long the task has been
      // wearing "running" — the honest thing the record still proves.
      const heldFor = ageOf(t.startedAt ?? t.at);
      if (heldFor > STALE_RUNNER_MS) {
        findings.push({
          kind: "stale-runner",
          subject: t.id,
          detail:
            `task ${t.id} reads running but its runner${t.runner ? ` (${t.runner})` : ""} is no longer on the bus — ` +
            `the task has been claimed for ${Math.round(heldFor / 3600000)}h.`,
        });
      }
    }
  }

  // QUEUED BACKLOG — queued work nobody is picking up. An empty lane is a
  // normal shape; a task that has idled a day is either a dead lane or a
  // typo'd one, and either way the board should say it out loud.
  for (const t of state.tasks ?? []) {
    if (t.status !== "queued") continue;
    if (ageOf(t.at) > QUEUED_BACKLOG_MS) {
      findings.push({
        kind: "queued-backlog",
        subject: t.id,
        detail: `task ${t.id} (${t.lane}) has been queued for over ${ONE(QUEUED_BACKLOG_MS)} — no runner picked it up.`,
      });
    }
  }

  // DRAFT PENDING — the human gate is the gate (C4), but a draft waiting a
  // day is the gate holding everything behind it. Not a prod to apply: the
  // finding just makes the wait visible somewhere its owner looks.
  for (const t of state.tasks ?? []) {
    if (t.status !== "draft") continue;
    if (ageOf(t.doneAt ?? t.at) > DRAFT_PENDING_MS) {
      findings.push({
        kind: "draft-pending",
        subject: t.id,
        detail: `task ${t.id} has sat as a draft awaiting a human apply for over ${ONE(DRAFT_PENDING_MS)}.`,
      });
    }
  }

  // UNTAKEN HANDOFF — a handoff nobody took is a rumor (the verb's own
  // comment). Once it has idled two days the rumor is also quietly rotting.
  for (const [key, v] of Object.entries(state.board ?? {})) {
    if (v.kind !== "handoff") continue;
    if (!(v.taken ?? []).length && ageOf(v.at) > UNTAKEN_HANDOFF_MS) {
      findings.push({
        kind: "untaken-handoff",
        subject: key,
        detail: `handoff "${key}" set ${v.at} by ${v.by} has no taken chain after over ${ONE(UNTAKEN_HANDOFF_MS)}.`,
      });
    }
  }

  // OPEN BLOCK — a block is someone standing in a doorway right now (the
  // status() comment). Three days of standing means the solver match failed
  // silently or nobody came back to unblock; the record should say so.
  for (const b of state.blocks ?? []) {
    if (b.status !== "open") continue;
    if (ageOf(b.at) > OPEN_BLOCK_MS) {
      findings.push({
        kind: "open-block",
        subject: b.id,
        detail: `block ${b.id} (${b.by}: ${b.what}) has been OPEN for over ${ONE(OPEN_BLOCK_MS)} — the match found nobody.`,
      });
    }
  }

  return findings;
}

/**
 * The clean answer names everything it checked, because silence must say
 * what it stayed silent ABOUT (the nudger's lesson: a "nothing" that cannot
 * be audited reads as whether the check ran at all).
 */
export function renderHealth(state, { now = Date.now() } = {}) {
  const findings = checkHealth(state, { now });
  if (!findings.length) {
    const agents = Object.keys(state.agents ?? {}).length;
    const queued = (state.tasks ?? []).filter((t) => t.status === "queued").length;
    const board = Object.keys(state.board ?? {}).length;
    return `No findings. (${agents} agent(s) present, ${queued} queued, ${board} note(s) on the board)`;
  }
  const lines = [`${findings.length} finding(s):`];
  for (const f of findings) lines.push(`  ${f.kind.toUpperCase()} — ${f.detail}`);
  return lines.join("\n");
}