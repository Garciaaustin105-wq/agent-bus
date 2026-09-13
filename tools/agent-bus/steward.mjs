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
      s.steward.lastTick = new Date().toISOString();
    });
    filed++;
  }
  return { triaged: filed };
}