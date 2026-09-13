// tools/agent-bus/steward.mjs
//
// The steward: a loop that makes sure a problem reported to the bus is
// CLASSIFIED and FILED, not just parked on the board where it can slip past a
// tired human (rule G3, and the user directive behind it: "the agent bus makes
// sure it receives all the problems and not just let them slip away").
//
// Split per A2: everything here is pure or adapter-injected. `signalsFor`,
// `triagePrompt`, `parseTriage` and `triageReport` take no I/O; the hub calls
// `runStewardTick` with its real store and runner. The LLM is injected as
// `classify`/`ask` so the harness proves the policy without a model, and the
// hub proves the model wiring without policy changes.
//
// C4 (nothing auto-applies) shapes the output: the steward FILES a triage
// note — a proposal with provenance — and never edits code, rules or another
// agent's note. Opening a fix task is a flag away (openTasks), off by default.

const PROBLEM_PREFIXES = ["defect/", "problem/", "audit/"];

// Signals are what the steward owes a triage to: a problem-keyed note, or a
// task that FAILED (a failed draft is itself a problem report — the runner
// wrote what went wrong into the result). `triaged` is the set of signal ids
// already filed; a signal is returned only once. Capped so one tick cannot
// run away with the context budget even on a backlog.
export function signalsFor(state, triaged) {
  const done = triaged instanceof Set ? triaged : new Set(triaged ?? []);
  const signals = [];
  for (const [key, entry] of Object.entries(state.board ?? {})) {
    if (!PROBLEM_PREFIXES.some((p) => key.startsWith(p))) continue;
    const id = `note:${key}`;
    if (done.has(id)) continue;
    signals.push({
      id,
      source: "note",
      key,
      title: key,
      value: entry?.value ?? "",
      at: entry?.at ?? null,
    });
  }
  for (const t of state.tasks ?? []) {
    if (t.status !== "failed") continue;
    const id = `task:${t.id}`;
    if (done.has(id)) continue;
    signals.push({
      id,
      source: "failed-task",
      key: t.id,
      title: t.title ?? t.id,
      value: t.result ?? "",
      at: t.doneAt ?? t.at ?? null,
    });
  }
  return signals.slice(0, 10);
}

// Mechanical duplicate detection — the one classification a word-overlap can
// do honestly. Jaccard over word tokens of (key + value); 0.6 is high enough
// that shared vocabulary like "defect" plus one noun cannot false-positive,
// which matters because a false duplicate hides a real problem (the exact
// failure the steward exists to prevent). The signal's OWN note is excluded —
// it is on the board, and without this every problem note classifies as a
// duplicate of itself. Returns the existing key or null.
export function overlapDuplicate(report, existingNotes) {
  const tokens = (s) =>
    String(s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
  const a = new Set([...tokens(report.key), ...tokens(report.value)]);
  if (!a.size) return null;
  for (const n of existingNotes) {
    if (n.key === report.key) continue;
    const b = new Set([...tokens(n.key), ...tokens(n.value)]);
    if (!b.size) continue;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const jac = inter / (a.size + b.size - inter);
    if (jac >= 0.6) return n.key;
  }
  return null;
}

// The strict prompt for the classifier. Strict because local models pad with
// prose and code fences; parseTriage tolerates the fences and NOTHING else.
export function triagePrompt(report, existing) {
  // The report's OWN note never counts as prior art — listing it is how the
  // live model ended up answering "duplicate of defect/smoke-live" for a
  // report that WAS defect/smoke-live. Same exclusion overlapDuplicate makes.
  const notes = (existing.noteKeys ?? []).filter((n) => n.key !== report.key).slice(0, 40);
  const tasks = (existing.taskTitles ?? []).slice(0, 20);
  return [
    "You triage problem reports on an agent-bus board. Reply with ONLY a JSON object, no prose:",
    '{"kind":"defect|lesson|routing-fact|duplicate","duplicateOf":"<existing note key or null>","reason":"<one sentence>"}',
    'kinds: "defect" = something in the product or process is broken and needs a fix task;',
    '"lesson" = a mistake whose fix is knowledge, not code;',
    '"routing-fact" = which runner should or should not get a kind of work;',
    '"duplicate" = the same problem is already filed (set duplicateOf to that note key).',
    "",
    "REPORT:",
    `source: ${report.source}`,
    `key: ${report.key}`,
    `title: ${report.title}`,
    `value: ${report.value.slice(0, 2000)}`,
    "",
    `EXISTING NOTE KEYS (${notes.length}):`,
    notes.map((n) => `- ${n.key}`).join("\n") || "(none)",
    "",
    `OPEN TASK TITLES (${tasks.length}):`,
    tasks.join(" | ") || "(none)",
  ].join("\n");
}

// Parse the classifier's reply to a VALUE or { error }. Tolerates code fences
// (local models add them constantly); validates the shape — an unvalidated
// classification is a guess rendered as a verdict, which C2 forbids.
export function parseTriage(text) {
  if (typeof text !== "string") return { error: "classifier returned no text" };
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last <= first) return { error: "no JSON object in the reply" };
  let obj;
  try {
    obj = JSON.parse(t.slice(first, last + 1));
  } catch {
    return { error: "reply is not valid JSON" };
  }
  const KINDS = ["defect", "lesson", "routing-fact", "duplicate"];
  if (!KINDS.includes(obj.kind)) return { error: `unknown kind ${JSON.stringify(obj.kind)}` };
  if (obj.kind === "duplicate" && (typeof obj.duplicateOf !== "string" || !obj.duplicateOf.trim()))
    return { error: "duplicate verdict without a duplicateOf key" };
  if (typeof obj.reason !== "string" || !obj.reason.trim())
    return { error: "verdict without a reason" };
  return { kind: obj.kind, duplicateOf: obj.duplicateOf ?? null, reason: obj.reason.trim() };
}

// One signal, one filing decision. Refusals and classifier garbage degrade to
// the "unclear" filing — the report is recorded with what happened, marked
// triaged once, and never silently dropped (that drop is the failure this
// loop exists to prevent). `classify` returns the classifier's RAW text (it
// may be async; it may throw) — this contract owns the parsing, so the hub
// cannot wire the model around it.
export async function triageReport(report, existing, classify) {
  if (!report || typeof report !== "object" || !report.id || !report.key)
    return { error: "malformed report" };
  if (typeof report.value !== "string" || !report.value.trim())
    return { error: "report has no content to triage" };

  const dupe = overlapDuplicate(report, existing.noteKeys ?? []);
  if (dupe) {
    return {
      kind: "duplicate",
      duplicateOf: dupe,
      action: "link",
      proposedKey: `steward-triage-${report.id.replace(/[:/]/g, "-")}`,
      reason: `overlaps the already-filed note "${dupe}"`,
    };
  }

  const unclear = (reason) => ({
    kind: "unclear",
    action: "file",
    proposedKey: `steward-unclassified-${report.id.replace(/[:/]/g, "-")}`,
    reason,
  });

  let raw;
  try {
    raw = await classify(report, existing);
  } catch (err) {
    return unclear(`classifier failed: ${err?.message ?? String(err)}`);
  }
  const parsed = parseTriage(raw);
  if (parsed.error) return unclear(`classifier returned an unusable verdict (${parsed.error})`);
  return settle(parsed, report);
}

function settle(parsed, report) {
  if (parsed.kind === "duplicate") {
    // A duplicate verdict that points at the report itself is not a link — it
    // hides a fresh problem behind a phantom (the exact drop this loop
    // prevents). Degraded to unclear, filed, never linked.
    if (parsed.duplicateOf === report.key) {
      return {
        kind: "unclear",
        action: "file",
        proposedKey: `steward-unclassified-${report.id.replace(/[:/]/g, "-")}`,
        reason: `classifier claimed the report duplicates itself (${parsed.reason})`,
      };
    }
    return {
      kind: "duplicate",
      duplicateOf: parsed.duplicateOf,
      action: "link",
      proposedKey: `steward-triage-${report.id.replace(/[:/]/g, "-")}`,
      reason: parsed.reason,
    };
  }
  return {
    kind: parsed.kind,
    duplicateOf: null,
    action: "file",
    proposedKey: `steward-triage-${report.id.replace(/[:/]/g, "-")}`,
    reason: parsed.reason,
  };
}

// ── duty 2: review first-pass ───────────────────────────────────────────────

// The t19/t20/t21 class: a runner reports its task DONE and the draft looks
// done in every surface — same weight as a good one — until someone actually
// reads it and finds it truncated, looping, or off-brief. The first-pass is
// the steward reading every finished result against its brief BEFORE anyone
// trusts it, filing a PROPOSAL on the task: `task.firstPass`. It is never the
// verdict — the orchestrator's stamped review (or the human's) stays the
// verdict, and `task.reviews` stays exactly what the review verb wrote.
//
// Verdict vocabulary is deliberately not approve/changes: a first-pass is a
// weaker claim than a review. "pass" = reads complete and on-brief (advisory
// only); "concerns" = concrete reasons the draft may not be usable;
// "unreviewable" = the result is so empty or degenerate that even reading it
// found nothing to judge — which is itself the finding. Marked done by
// `firstPass` existing on the task; no separate ledger can drift from it.

const FIRST_PASS_MAX = 10;

export function reviewSignalsFor(state) {
  return (state.tasks ?? [])
    .filter((t) => t.status === "done")
    .filter((t) => !t.firstPass)
    .filter((t) => !(t.reviews ?? []).length) // an orchestrator verdict makes a first-pass pointless
    .map((t) => ({
      id: `review:${t.id}`,
      taskId: t.id,
      title: t.title ?? t.id,
      prompt: t.prompt ?? "",
      result: t.result ?? "",
    }))
    .slice(0, FIRST_PASS_MAX);
}

// The two failure shapes the loop found in its own fleet, caught mechanically
// — no model spend, no model excuses. A finished task whose result is empty is
// not a pass; a result with a line stamped eight or more times is the
// repetition loop t21 died in (socket.onmessage × 25). Either is a concern
// with a mechanical reason; the model still runs after them only if neither
// fired. Returns null when the mechanical gate is silent.
export function mechanicalConcern(task) {
  if (!String(task.result ?? "").trim()) {
    return "finished with an empty result — nothing was produced to review";
  }
  const counts = new Map();
  for (const line of String(task.result).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length < 30) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  for (const [line, n] of counts) {
    if (n >= 8) {
      return `repetition loop: the same line appears ${n} times ("${line.slice(0, 60)}…")`;
    }
  }
  return null;
}

// The strict prompt for the first-pass reader. The TAIL of the result rides
// with the head: a truncated draft looks fine from the front and dies
// mid-line at the back, which is exactly how t21 shipped.
export function reviewPrompt(signal) {
  const result = String(signal.result ?? "");
  const head = result.slice(0, 3000);
  const tail = result.length > 4500 ? result.slice(-1500) : "";
  const middle = result.length > 4500
    ? `\n… (${result.length - head.length - tail.length} middle characters cut) …\n`
    : "";
  return [
    "You are the first-pass reviewer of a finished agent task. Read the draft against its brief and reply with ONLY a JSON object, no prose:",
    '{"verdict":"pass|concerns","reason":"<one sentence>"}',
    '"pass" = the draft reads complete and on-brief (a first-pass, not a verdict).',
    '"concerns" = something is missing, off-brief, truncated or broken — name it in reason.',
    "",
    "BRIEF:",
    String(signal.prompt ?? "").slice(0, 2000),
    "",
    "DRAFT:",
    head + middle + tail,
  ].join("\n");
}

// Parse the reader's reply to a VALUE or { error }. Same discipline as
// parseTriage: fences tolerated, shape enforced.
export function parseReview(text) {
  if (typeof text !== "string") return { error: "reader returned no text" };
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last <= first) return { error: "no JSON object in the reply" };
  let obj;
  try {
    obj = JSON.parse(t.slice(first, last + 1));
  } catch {
    return { error: "reply is not valid JSON" };
  }
  const VERDICTS = ["pass", "concerns"];
  if (!VERDICTS.includes(obj.verdict)) {
    return { error: `unknown verdict ${JSON.stringify(obj.verdict)}` };
  }
  if (typeof obj.reason !== "string" || !obj.reason.trim()) {
    return { error: "verdict without a reason" };
  }
  return { verdict: obj.verdict, reason: obj.reason.trim() };
}

// One finished task, one first-pass decision. Mechanical gate first; then the
// reader; then parse. Garbage degrades to "unreviewable" — recorded with what
// happened, marked once, never silently skipped.
export async function reviewTask(signal, classify) {
  const unreviewable = (reason) => ({ verdict: "unreviewable", reason });
  const mechanical = mechanicalConcern(signal);
  if (mechanical) return { verdict: "concerns", reason: mechanical };
  // Transport failure is NOT caught here — it is the TICK's path (one offline
  // note, nothing stamped, retry); a verdict of "unreviewable" is for garbage
  // the runner actually produced.
  const raw = await classify(signal);
  const parsed = parseReview(raw);
  if (parsed.error) return unreviewable(`reader returned an unusable answer (${parsed.error})`);
  return parsed;
}

// The review tick: read the state, first-pass every finished task that has no
// first-pass and no orchestrator verdict yet, stamp `task.firstPass`.
// Transport failure = the same ONE offline note, nothing stamped, retry later.
export async function runStewardReviewTick({ readState, writeState, ask, maxSignals = FIRST_PASS_MAX }) {
  const state = readState();
  const signals = reviewSignalsFor(state).slice(0, maxSignals);
  if (!signals.length) return { reviewed: 0 };

  let reviewed = 0;
  for (const signal of signals) {
    // The mechanical gate runs BEFORE the ask — an empty or looping draft is
    // settled without a single model token. reviewTask re-checks it (same
    // pure function) for callers that arrive here some other way.
    const mechanical = mechanicalConcern(signal);
    let answer = mechanical ? null : undefined;
    if (!mechanical) {
      try {
        answer = await ask(reviewPrompt(signal));
      } catch (err) {
        writeState((s) => {
          s.board ??= {};
          s.board["steward/offline"] = {
            value: `Steward could not reach the local runner for review first-pass (${err?.message ?? String(err)}). Finished tasks stay un-first-passed and will retry — nothing was lost.`,
            by: "steward",
            at: new Date().toISOString(),
          };
        });
        return { reviewed, offline: true };
      }
    }
    const decision = mechanical
      ? { verdict: "concerns", reason: mechanical }
      : await reviewTask(signal, async () => answer);
    writeState((s) => {
      s.tasks ??= [];
      const task = s.tasks.find((t) => t.id === signal.taskId);
      if (!task || task.firstPass) return; // claimed between read and write
      task.firstPass = {
        verdict: decision.verdict,
        reason: decision.reason,
        by: "steward",
        at: new Date().toISOString(),
      };
      s.steward ??= {};
      s.steward.lastReviewTick = new Date().toISOString();
    });
    reviewed++;
  }
  return { reviewed };
}

// ── duty 3: brief drafting ──────────────────────────────────────────────────

// A triaged defect needs a fix task — but the loop's own history is the proof
// of what a rushed brief costs: t19/t20/t21 were dispatched on one-paragraph
// briefs and the drafts came back truncated, looping, off-brief. So the
// steward's third duty: for every defect triage, DRAFT a full brief — problem,
// what a good fix must produce, guardrails — and file it as a task in status
// "draft". A draft task is claimed by nobody (claimNextTask takes "queued"
// only): dispatch is the orchestrator's approve, pre-dispatch, per the design.
// The steward proposes the brief; it never dispatches.
//
// Marks live in `state.steward.briefed` (signal ids, capped) — a triaged
// defect gets ONE draft, and an unusable draft is recorded under
// `steward-brief-unusable-<slug>` with the reason rather than retried forever.

const BRIEF_MAX = 5;
const BRIEF_CHARS = 6000;

export function briefSignalsFor(state) {
  const defects = state.steward?.defects ?? [];
  const briefed = new Set(state.steward?.briefed ?? []);
  const drafted = new Set(
    (state.tasks ?? []).map((t) => t.briefDraftFor).filter(Boolean)
  );
  const reports = new Map();
  for (const [key, entry] of Object.entries(state.board ?? {})) {
    if (PROBLEM_PREFIXES.some((p) => key.startsWith(p))) {
      reports.set(`note:${key}`, {
        key,
        title: key,
        value: entry?.value ?? "",
      });
    }
  }
  for (const t of state.tasks ?? []) {
    if (t.status === "failed") {
      reports.set(`task:${t.id}`, {
        key: t.id,
        title: t.title ?? t.id,
        value: t.result ?? "",
      });
    }
  }
  return [...new Set(defects)]
    .filter((id) => !briefed.has(id) && !drafted.has(id))
    .filter((id) => reports.has(id))
    .map((id) => ({ id, ...reports.get(id) }))
    .slice(0, BRIEF_MAX);
}

// The strict prompt for the brief drafter. Free text IS the deliverable here —
// the orchestrator reads and approves it — but the structure is demanded,
// because the failure mode is a vague one-paragraph wish that a runner then
// guesses at.
export function briefPrompt(signal) {
  return [
    "You draft a task brief for a runner who will fix this defect. Reply with ONLY the brief text — no JSON, no preamble, no code fences.",
    "The brief MUST have these four sections, each starting with its heading:",
    "PROBLEM: the defect in one or two sentences, from the report.",
    "MUST PRODUCE: what a good fix delivers — concrete, checkable statements (a runner's work is judged against these).",
    "DO NOT: the guardrails — what the fix must not touch or change.",
    "CONTEXT: anything the report names (files, pages, commands); if the report names none, say so.",
    "",
    "DEFECT REPORT:",
    `key: ${signal.key}`,
    `title: ${signal.title}`,
    `value: ${String(signal.value ?? "").slice(0, 2000)}`,
  ].join("\n");
}

// Parse the drafter's reply to a brief STRING or { error }. Not JSON — a
// brief is prose — but not anything-goes either: fences stripped, a real
// length demanded (a one-liner is a wish, not a brief), hard cap so a runaway
// cannot ride into every state write.
export function parseBrief(text) {
  if (typeof text !== "string") return { error: "drafter returned no text" };
  const t = text
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  if (t.length < 200) return { error: `brief is too short to be a brief (${t.length} chars)` };
  if (!/PROBLEM/i.test(t) || !/MUST PRODUCE/i.test(t)) {
    return { error: "brief is missing its PROBLEM / MUST PRODUCE sections" };
  }
  return { brief: t.slice(0, BRIEF_CHARS) };
}

// The brief tick: read the state, draft a brief for every triaged defect
// without one, file it as a DRAFT task. Transport failure = the same ONE
// offline note, nothing marked, retry later. An unusable draft = ONE board
// note with the reason, marked once — a bad brief is reported, not retried
// into a token furnace.
export async function runStewardBriefTick({ readState, writeState, ask, maxSignals = BRIEF_MAX }) {
  const state = readState();
  const signals = briefSignalsFor(state).slice(0, maxSignals);
  if (!signals.length) return { drafted: 0 };

  let drafted = 0;
  for (const signal of signals) {
    let answer;
    try {
      answer = await ask(briefPrompt(signal));
    } catch (err) {
      writeState((s) => {
        s.board ??= {};
        s.board["steward/offline"] = {
          value: `Steward could not reach the local runner for brief drafting (${err?.message ?? String(err)}). Defects stay brief-less and will retry — nothing was lost.`,
          by: "steward",
          at: new Date().toISOString(),
        };
      });
      return { drafted, offline: true };
    }
    const parsed = parseBrief(answer);
    const slug = signal.id.replace(/[:/]/g, "-");
    writeState((s) => {
      s.steward ??= {};
      s.steward.briefed ??= [];
      if (parsed.brief) {
        s.tasks ??= [];
        // Same claim-check discipline as the review tick: a draft for this
        // signal may exist by now; never a second one.
        if (!s.tasks.some((t) => t.briefDraftFor === signal.id)) {
          s.taskSeq = (s.taskSeq ?? 0) + 1;
          s.tasks.push({
            id: `t${s.taskSeq}`,
            lane: "fixes",
            title: `Brief draft: ${String(signal.title).slice(0, 160)}`,
            prompt: parsed.brief,
            status: "draft",
            briefDraftFor: signal.id,
            runner_id: null,
            stage: null,
            by: "steward",
            at: new Date().toISOString(),
          });
          s.steward.lastBriefTick = new Date().toISOString();
        }
      } else {
        s.board ??= {};
        s.board[`steward-brief-unusable-${slug}`] = {
          value: `Steward could not draft a usable brief for ${signal.id}: ${parsed.error}. The defect stays on the board, un-briefed — a human (or a re-triage) can still dispatch it.`,
          by: "steward",
          at: new Date().toISOString(),
        };
      }
      s.steward.briefed.push(signal.id);
      if (s.steward.briefed.length > 500) s.steward.briefed = s.steward.briefed.slice(-500);
    });
    drafted++;
  }
  return { drafted };
}

// The tick: read the state, triage every un-filed signal, write the triage
// notes, mark them triaged. Adapters are injected so the harness runs this
// against an in-memory store; the hub passes withState-backed ones.
//
// Transport failure (Ollama down) is handled separately from a bad verdict:
// one upserted `steward/offline` note says so, NOTHING is marked triaged, and
// the tick stops — signals stay un-triaged and a later tick retries them. An
// upserted note cannot spam; a re-triaged signal cannot be lost.
export async function runStewardTick({ readState, writeState, ask, maxSignals = 10 }) {
  const state = readState();
  const steward = state.steward ?? {};
  const done = new Set(steward.triaged ?? []);
  const signals = signalsFor(state, done).slice(0, maxSignals);
  if (!signals.length) return { triaged: 0 };

  const existing = {
    noteKeys: Object.entries(state.board ?? {}).map(([key, v]) => ({
      key,
      value: v?.value ?? "",
    })),
    taskTitles: (state.tasks ?? [])
      .filter((t) => t.status === "queued" || t.status === "running")
      .map((t) => t.title ?? t.id),
  };

  let filed = 0;
  for (const report of signals) {
    let answer;
    try {
      answer = await ask(triagePrompt(report, existing));
    } catch (err) {
      writeState((s) => {
        s.board ??= {};
        s.board["steward/offline"] = {
          value: `Steward could not reach the local runner (${err?.message ?? String(err)}). Signals stay un-triaged and will retry — nothing was lost, nothing was marked done.`,
          by: "steward",
          at: new Date().toISOString(),
        };
      });
      return { triaged: filed, offline: true };
    }
    const decision = await triageReport(report, existing, async () => answer);
    const key = decision.proposedKey ?? `steward-unclassified-${report.id.replace(/[:/]/g, "-")}`;
    const dupLine = decision.duplicateOf ? ` duplicate of "${decision.duplicateOf}".` : "";
    writeState((s) => {
      s.board ??= {};
      s.board[key] = {
        value: `STEWARD TRIAGE (${decision.kind}) of ${report.id}: ${decision.reason}.${dupLine} First pass by the steward — a human verdict is still owed.`,
        by: "steward",
        at: new Date().toISOString(),
      };
      s.steward ??= {};
      s.steward.triaged ??= [];
      s.steward.triaged.push(report.id);
      if (s.steward.triaged.length > 500) s.steward.triaged = s.steward.triaged.slice(-500);
      // Duty 3's input, recorded as data at triage time — the brief tick reads
      // this list rather than parsing verdicts back out of triage-note prose.
      if (decision.kind === "defect") {
        s.steward.defects ??= [];
        if (!s.steward.defects.includes(report.id)) s.steward.defects.push(report.id);
        if (s.steward.defects.length > 500) s.steward.defects = s.steward.defects.slice(-500);
      }
      s.steward.lastTick = new Date().toISOString();
    });
    filed++;
  }
  return { triaged: filed };
}

// ── duty 4: lesson promotion ────────────────────────────────────────────────
// L3 on the board: "a miss reported three times is a rule that has not been
// written yet." The miss verb counts the reports; this duty is what counts
// THEM. A miss whose `seen` has reached 3 is a signal the steward owes a
// PROPOSAL to — a rulebook patch shaped exactly like the rulebook's own rules
// (### <id>. <title> + body, from parseRulebook's grammar in agent.mjs), filed
// as a board note the maintainer can copy-paste into docs/build-rules.md.
//
// The boundary is C4 in its plainest form: the steward NEVER writes to the
// rulebook. The proposal note carries the provenance and the human gate in its
// own text — applying it is the maintainer's edit, and only the maintainer's.
// Marked once in state.steward.promoted; garbage is reported once and never
// retried (same no-token-furnace rule as the other duties).

const PROMOTION_MAX = 5;
const PROMOTION_SEEN = 3; // L3's threshold, on the board's own words
const PROMOTION_RULE_MIN = 80;
const PROMOTION_RULE_MAX = 4000;

export function promotionSignalsFor(state) {
  const promoted = new Set(state.steward?.promoted ?? []);
  const signals = [];
  for (const [key, entry] of Object.entries(state.board ?? {})) {
    if (!entry || !entry.miss) continue;
    if ((entry.seen ?? 1) < PROMOTION_SEEN) continue;
    const id = `promotion:${key}`;
    if (promoted.has(id)) continue;
    signals.push({
      id,
      key,
      seen: Number(entry.seen ?? 1),
      value: entry?.value ?? "",
    });
    if (signals.length >= PROMOTION_MAX) break;
  }
  return signals;
}

// The prompt carries the miss's own pairing (CLAIMED/TRUE/CAUGHT BY, the miss
// verb's shape) plus the rulebook's existing rule ids, so the model proposes
// into the rulebook's actual numbering instead of colliding with it. It is
// told what the rulebook's rule shape IS — a `### <id>. <title>` heading and a
// body — because the deliverable is a block the maintainer can paste as-is.
export function promotionPrompt(signal, existingRuleIds) {
  return [
    "You propose a new rule for a rulebook of engineering rules (docs/build-rules.md). Reply with ONLY a JSON object — no preamble, no code fences.",
    'The object MUST have exactly these fields: {"rule": "<the rule block>", "reason": "<why this rule, from the recurring miss>", "source": "' + signal.key + '"}',
    "The rule block is the rulebook's own shape: a first line `### <id>. <title>` where <id> is a letter+number like B7 or H2, followed by 2-6 lines of body. Write it as a rule, not a report.",
    "Use a NEW id: " + (existingRuleIds.length ? `these ids already exist — ${existingRuleIds.join(", ")}.` : "the rulebook currently has none.") + " Keep the letter matching the group a maintainer would place it in (A shape, B data, C refusing, D numbers, E verification, F other agents, G asking people) — they will renumber if needed.",
    "The rule must generalise past this one incident: it is a rule BECAUSE the same miss recurred.",
    "",
    `RECURRING MISS (${signal.seen} reports — the L3 threshold):`,
    String(signal.value ?? "").slice(0, 2000),
  ].join("\n");
}

// Parse the proposal to a rule STRING or { error }. JSON in, the block
// validated against the rulebook's own heading grammar — a proposal that does
// not parse as a rule would not parse into the rulebook either.
export function parsePromotion(text) {
  if (typeof text !== "string") return { error: "model returned no text" };
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return { error: "reply is not a JSON object" };
  }
  if (!obj || typeof obj !== "object") return { error: "reply is not a JSON object" };
  const rule = typeof obj.rule === "string" ? obj.rule.trim() : "";
  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
  if (!rule) return { error: "missing `rule`" };
  if (!reason) return { error: "missing `reason` — a proposal without its why is not reviewable" };
  const head = rule.match(/^###\s+([A-Z]\d+)\.\s+(.+)$/m);
  if (!head) return { error: "rule does not start with a `### <id>. <title>` heading" };
  const body = rule.split(/\r?\n/).slice(1).join("\n").trim();
  if (!body) return { error: "rule has a heading but no body" };
  const t = rule.slice(0, PROMOTION_RULE_MAX);
  if (t.length < PROMOTION_RULE_MIN) {
    return { error: `rule is too short to be a rule (${t.length} chars)` };
  }
  return { rule: t, reason: reason.slice(0, 2000), id: head[1] };
}

// The promotion tick: read the state, propose a rule for every miss reported
// PROMOTION_SEEN times without one, file the proposal as a board note. Same
// transport rule as every other duty — one upserted `steward/offline` note,
// nothing marked, retry later; same unusable rule — ONE note with the reason,
// marked once, never retried into a token furnace. `rulebook` is the raw
// markdown (or null); its existing ids are extracted mechanically so a
// proposal cannot collide with a rule that is already written.
export async function runStewardPromotionTick({
  readState,
  writeState,
  ask,
  rulebook = null,
  maxSignals = PROMOTION_MAX,
}) {
  const state = readState();
  const signals = promotionSignalsFor(state).slice(0, maxSignals);
  if (!signals.length) return { promoted: 0 };

  const existingRuleIds = String(rulebook ?? "").match(/^###\s+([A-Z]\d+)\./gm)?.map(
    (m) => m.replace(/^###\s+/, "").replace(/\.$/, "")
  ) ?? [];

  let promoted = 0;
  for (const signal of signals) {
    let answer;
    try {
      answer = await ask(promotionPrompt(signal, existingRuleIds));
    } catch (err) {
      writeState((s) => {
        s.board ??= {};
        s.board["steward/offline"] = {
          value: `Steward could not reach the local runner for rule promotion (${err?.message ?? String(err)}). The recurring miss stays proposal-less and will retry — nothing was lost.`,
          by: "steward",
          at: new Date().toISOString(),
        };
      });
      return { promoted, offline: true };
    }
    const parsed = parsePromotion(answer);
    const slug = signal.key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unnamed";
    writeState((s) => {
      s.steward ??= {};
      s.steward.promoted ??= [];
      s.board ??= {};
      const dup =
        parsed.rule && existingRuleIds.includes(parsed.id)
          ? { error: `proposed id ${parsed.id} already exists in the rulebook` }
          : null;
      if (parsed.rule && !dup) {
        s.board[`steward-rule-proposal-${slug}`] = {
          value: [
            `STEWARD RULE PROPOSAL (duty 4). Source: ${signal.key} — reported ${signal.seen} times; L3 says a miss reported three times is a rule that has not been written yet.`,
            "Applying it is the MAINTAINER'S edit — the steward never writes rules (C4). Ready to paste into docs/build-rules.md:",
            "",
            parsed.rule,
            "",
            `WHY: ${parsed.reason}`,
          ].join("\n"),
          by: "steward",
          at: new Date().toISOString(),
        };
        s.steward.lastPromotionTick = new Date().toISOString();
      } else {
        s.board[`steward-rule-unusable-${slug}`] = {
          value: `Steward could not draft a usable rule proposal for ${signal.id}: ${(dup ?? parsed).error}. The miss stays on the board — a human can still write the rule from it.`,
          by: "steward",
          at: new Date().toISOString(),
        };
      }
      s.steward.promoted.push(signal.id);
      if (s.steward.promoted.length > 500) s.steward.promoted = s.steward.promoted.slice(-500);
    });
    promoted++;
  }
  return { promoted };
}