/**
 * The handoff / handoff_take verbs, against a fresh temp bus. The failure
 * being pinned: the bus is problem-shaped, not session-shaped — `note`
 * captures facts, `miss` corrections, `task_add` work, but nothing held "the
 * session that was driving this just ended; here is the whole state and where
 * to resume", so every handoff got re-invented as an out-of-band markdown file
 * the next agent only found by luck. The contract:
 *
 *   - `handoff` stores a structured, keyed, SELF-SUPERSEDING entry on the
 *     board (history capped at 5, newest first), refuses a handoff with no
 *     summary or no next step, and renders the block into `value` so board()
 *     readers see a live handoff without taking it.
 *   - `handoff_take` returns it and stamps the `taken` chain — which records
 *     every taker instead of locking, so two takers see each other by
 *     construction. Taking an already-taken handoff is normal.
 *
 *   node tools/agent-bus/handoff-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-handoff-"));
process.env.AGENT_BUS_PROJECT = HOME;

const { callTool, asActor } = await import("./server.mjs");

// The bus's state dir for a project with no .git (module top-level resolved
// PROJECT_ROOT = HOME). Read back to inspect the STRUCTURED entry — the take
// response is rendered text, the history cap and the taken chain are state.
const STATE = path.join(HOME, ".agent-bus", "state.json");
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error("no state file yet — the verb under test never wrote state (server.mjs side not landed?)");
    }
    throw err;
  }
};
const writeState = (state) => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

// server.mjs' cap unit (MAX_NOTE_CHARS) and its truncation marker. Not
// exported, so pinned here from its own source; if the server's cap changes,
// this changes with it on purpose — a silent drift would make case 7 lie.
const MAX_NOTE_CHARS = 8_000;
const MARKER = `\n[truncated at ${MAX_NOTE_CHARS} chars]`;

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
const say = (actor, verb, args) => asActor(actor, () => callTool(verb, args));

// A refusal must be a SENTENCE a reader can act on, never a bare error. The
// caller-facing needles are given as regexes so the wording can evolve while
// staying a readable sentence.
const refused = (fn, pattern) => {
  let msg;
  try {
    fn();
  } catch (e) {
    msg = String(e.message || e);
  }
  assert.ok(msg, "expected a refusal, got success");
  assert.match(msg, pattern, `the refusal must be a sentence, got: ${msg}`);
  return msg;
};

const decodesCleanly = (s) => {
  assert.equal(Buffer.from(s, "utf8").toString("utf8"), s, "UTF-8 round-trip must be identical");
  assert.ok(!s.includes("�"), "must not carry a replacement character");
};

/* ── case 1: the required parts are required, with a sentence ─────────────── */

check("missing-summary-is-refused-with-a-sentence-naming-the-field", () => {
  const msg = refused(
    () => say("driver-a", "handoff", { nextStep: "run the E2E harness" }),
    /summary/i
  );
  assert.ok(/next\s*step/i.test(msg) || msg.includes("nextStep"), `names the other field too: ${msg}`);
});

check("missing-nextstep-is-refused-with-a-sentence-naming-the-field", () => {
  const msg = refused(
    () => say("driver-a", "handoff", { summary: "Stage A is unblocked and green." }),
    /next\s*step|nextStep/i
  );
  assert.ok(/summary/i.test(msg) || msg.includes("summary"), `names the other field too: ${msg}`);
});

/* ── the stored shape ─────────────────────────────────────────────────────── */

check("a-handoff-stores-its-structured-entry-under-the-default-key", () => {
  const out = say("driver-a", "handoff", {
    summary: "the NVR cloud pass spec is written and Stage A is unblocked.",
    nextStep: "run node tools/agent-bus/handoff-harness.mjs in the camera worktree.",
  });
  assert.ok(out.length > 0, `a set response is a sentence: ${out}`);
  const entry = readState().board["handoff"];
  assert.ok(entry, "the default key is `handoff`");
  assert.equal(entry.kind, "handoff");
  assert.equal(entry.by, "driver-a", "a handoff is signed work");
  assert.equal(entry.summary, "the NVR cloud pass spec is written and Stage A is unblocked.");
  assert.equal(entry.nextStep, "run node tools/agent-bus/handoff-harness.mjs in the camera worktree.");
  assert.deepEqual(entry.open, [], "unset lists default to empty, not undefined");
  assert.deepEqual(entry.pointers, []);
  assert.deepEqual(entry.constraints, []);
  assert.deepEqual(entry.taken, [], "an untaken handoff carries an empty chain");
  assert.ok(!Number.isNaN(Date.parse(entry.setAt)), "setAt is an ISO stamp");
  assert.ok(entry.value.startsWith("HANDOFF (set "), `the rendered block is the value: ${entry.value}`);
});

check("open-pointers-and-constraints-are-stored-verbatim", () => {
  say("driver-a", "handoff", {
    key: "handoff-camera",
    summary: "detector shipped; cloud pass pending Austin's OK.",
    nextStep: "run the bench E2E on the Debian box.",
    open: [
      { title: "build NVR-CLOUD-PASS spec", detail: "stage A is unblocked", busKey: "camera-plan" },
    ],
    pointers: ["docs/handoff-verb.md", "src/lib/handoff.ts"],
    constraints: ["target is linux", "do not push without the user"],
  });
  const entry = readState().board["handoff-camera"];
  assert.deepEqual(entry.open, [
    { title: "build NVR-CLOUD-PASS spec", detail: "stage A is unblocked", busKey: "camera-plan" },
  ], "the open list keeps its item shape (title, detail, busKey)");
  assert.deepEqual(entry.pointers, ["docs/handoff-verb.md", "src/lib/handoff.ts"]);
  assert.deepEqual(entry.constraints, ["target is linux", "do not push without the user"]);
});

/* ── case 2: supersede, on the record ────────────────────────────────────── */

check("rewriting-under-a-key-names-the-replaced-author-and-archives", () => {
  const out = say("next-b", "handoff", {
    key: "handoff-camera",
    summary: "detector shipped AND the bench E2E is green.",
    nextStep: "write the cloud-pass spec.",
  });
  assert.ok(
    out.includes("Replaced the handoff by driver-a set at "),
    `names whom it replaced: ${out}`
  );
  assert.match(out, /history \(entry 1\)/, `names the history index: ${out}`);
  const state = readState();
  assert.equal(state.board["handoff-camera"].by, "next-b", "the active entry is the new one");
  const history = state.handoffs["handoff-camera"];
  assert.ok(Array.isArray(history) && history.length === 1, "the old one moved to history");
  assert.equal(history[0].summary, "detector shipped; cloud pass pending Austin's OK.");
  assert.equal(history[0].supersededBy, "next-b");
  assert.ok(!Number.isNaN(Date.parse(history[0].supersededAt)), "supersede is stamped");
});

check("history-is-capped-at-five-newest-first", () => {
  // Two writes under the key already happened above; five more makes seven,
  // so the oldest handoff must fall out of the cap.
  for (let n = 3; n <= 7; n++) {
    asActor(`writer-${n}`, () =>
      callTool("handoff", { key: "handoff-camera", summary: `state ${n}`, nextStep: `step ${n}` })
    );
  }
  const history = readState().handoffs["handoff-camera"];
  assert.equal(history.length, 5, "the last-5 cap holds after six supersessions");
  assert.equal(history[0].summary, "state 6", "newest first — the entry the 7th write replaced");
  // The seven writes under this key: the two above (driver-a's cloud-pass
  // note, writer-2's bench-green note) then state 3..7. history[4] is the
  // OLDEST SURVIVOR — the bench-green entry, i.e. write 2; write 1 (the
  // cloud-pass note) is what fell out of the cap. There is no summary
  // literally reading "state 2" — the loop starts at n = 3.
  assert.equal(
    history[4].summary,
    "detector shipped AND the bench E2E is green.",
    "the oldest survivor — the cloud-pass note fell out of the cap"
  );
});

/* ── cases 3 + 4: the taken chain ────────────────────────────────────────── */

check("handoff_take-returns-every-field-verbatim", () => {
  say("driver-a", "handoff", {
    key: "handoff-resume",
    summary: "the wiring pass is green; the harness is the only red left.",
    nextStep: "run the full harness suite.",
    open: [{ title: "audit the task queue", detail: "unclaimed drafts pile up", busKey: "queue-growth" }],
    pointers: ["docs/build-rules.md", "commit 69a21bb"],
    constraints: ["the runner never touches the repo"],
  });
  const out = say("next-b", "handoff_take", { key: "handoff-resume" });
  for (const fragment of [
    "the wiring pass is green; the harness is the only red left.",
    "run the full harness suite.",
    "audit the task queue",
    "unclaimed drafts pile up",
    "queue-growth",
    "docs/build-rules.md",
    "commit 69a21bb",
    "the runner never touches the repo",
  ]) {
    assert.ok(out.includes(fragment), `verbatim resume includes ${JSON.stringify(fragment)}: ${out}`);
  }
  assert.match(out, /taken/i, "a take says so in its own response");
});

check("a-take-stamps-the-taken-chain-on-the-active-entry", () => {
  const entry = readState().board["handoff-resume"];
  assert.equal(entry.taken.length, 1, "one taker, one chain stamp");
  assert.equal(entry.taken[0].by, "next-b");
  assert.ok(!Number.isNaN(Date.parse(entry.taken[0].at)), "the stamp is an ISO stamp");
});

check("a-second-take-appends-and-NAMES-the-other-taker", () => {
  const out = say("next-c", "handoff_take", { key: "handoff-resume" });
  assert.ok(
    out.includes("Also taken by next-b at "),
    `the chain is impossible to miss: ${out}`
  );
  assert.match(out, /coordinate on the bus/i, `the coordination line: ${out}`);
  const entry = readState().board["handoff-resume"];
  assert.equal(entry.taken.length, 2, "the chain appends, it does not overwrite");
  assert.deepEqual(entry.taken.map((t) => t.by), ["next-b", "next-c"], "oldest taker first");
});

check("taking-does-not-lock-anything", () => {
  // Two takers already happened above; a third still succeeds — the chain is
  // the audit trail, never a mutex.
  const out = say("driver-a", "handoff_take", { key: "handoff-resume" });
  assert.ok(out.length > 0, "a re-take is normal, not refused");
  assert.equal(readState().board["handoff-resume"].taken.length, 3);
});

/* ── case 5: refusing a take that has nothing to give ────────────────────── */

check("take-on-an-empty-key-refuses-with-a-sentence", () => {
  refused(
    () => say("next-c", "handoff_take", { key: "handoff-nothing" }),
    /no (active )?handoff|nothing active|there is no handoff/i
  );
});

check("a-refused-take-names-the-newest-history-entry", () => {
  // Build a key with history but no active entry: two writes, then lift the
  // active one off the board directly — supersede always leaves an active
  // handoff behind, so this state is only reachable by hand (or by a bug).
  say("driver-a", "handoff", {
    key: "handoff-ghost",
    summary: "the ghost state, first writer.",
    nextStep: "first step.",
  });
  say("writer-2", "handoff", {
    key: "handoff-ghost",
    summary: "the ghost state, second writer.",
    nextStep: "second step.",
  });
  const state = readState();
  delete state.board["handoff-ghost"];
  writeState(state);
  const msg = refused(
    () => say("next-b", "handoff_take", { key: "handoff-ghost" }),
    /no (active )?handoff|nothing active|there is no handoff/i
  );
  // The bus names the newest HISTORY entry's author. writer-2's entry is not
  // in history — it was the active one, lifted off the board by hand above —
  // so the only honest answer the bus has is driver-a (spec: "say the newest
  // history entry's author and date"). Naming a writer the bus has no record
  // of would be inventing provenance.
  assert.ok(msg.includes("driver-a"), `names the newest history author: ${msg}`);
  assert.match(
    msg,
    /\d{4}-\d{2}-\d{2}|\d+[smh] ago/,
    `names the date so the caller learns the thread existed: ${msg}`
  );
});

/* ── case 6: a non-taking agent still sees the handoff ───────────────────── */

check("board-shows-the-rendered-handoff-line", () => {
  const out = say("next-c", "board", {});
  assert.ok(out.includes("HANDOFF (set "), `board carries the rendered block: ${out}`);
  assert.match(out, /, next: /, `the one-line next step is in the skim: ${out}`);
});

check("status-skim-shows-a-handoff-under-its-key-and-author", () => {
  // status() prints keys and authors only — that is its one-screen contract —
  // so a live handoff must at least present by its key, not hide.
  const out = say("next-c", "status", {});
  assert.ok(out.includes("handoff-resume"), `the key is visible: ${out}`);
  assert.ok(out.includes("driver-a"), `the author is visible: ${out}`);
});

/* ── case 7: caps, never split mid-character ─────────────────────────────── */

check("a-field-exactly-at-the-cap-passes-verbatim", () => {
  const exact = "é".repeat(MAX_NOTE_CHARS); // 2 UTF-8 bytes per char, 1 code unit
  say("driver-a", "handoff", { key: "handoff-cap-a", summary: exact, nextStep: "step" });
  const entry = readState().board["handoff-cap-a"];
  decodesCleanly(entry.summary);
  assert.equal(entry.summary.length, MAX_NOTE_CHARS, "at the cap, nothing is cut");
});

check("an-oversized-field-is-capped-without-splitting-a-character", () => {
  say("driver-a", "handoff", {
    key: "handoff-cap-b",
    summary: "é".repeat(MAX_NOTE_CHARS + 100),
    nextStep: "é".repeat(MAX_NOTE_CHARS + 500),
    constraints: ["é".repeat(MAX_NOTE_CHARS + 50)],
  });
  const entry = readState().board["handoff-cap-b"];
  const room = MARKER.length; // cap() appends the marker after the cut
  for (const field of ["summary", "nextStep", "constraints[0]"]) {
    const value = field === "constraints[0]" ? entry.constraints[0] : entry[field];
    decodesCleanly(value);
    assert.ok(
      value.length === MAX_NOTE_CHARS || value.length === MAX_NOTE_CHARS + room,
      `${field} capped (at the cap, or the cap plus the truncation marker): ${value.length}`
    );
    assert.ok(value.length <= MAX_NOTE_CHARS + room, `${field} never blows past the cap`);
    // The cut kept the PREFIX, so the multi-byte run stays intact from byte 0.
    assert.ok(
      value.startsWith("é".repeat(MAX_NOTE_CHARS).slice(0, Math.min(MAX_NOTE_CHARS, value.length))),
      `${field} kept its prefix`
    );
  }
});

check("the-rendered-entry-stays-under-4x-the-cap", () => {
  say("driver-a", "handoff", {
    key: "handoff-cap-c",
    summary: "é".repeat(MAX_NOTE_CHARS + 100),
    nextStep: "é".repeat(MAX_NOTE_CHARS + 200),
    pointers: ["é".repeat(MAX_NOTE_CHARS + 200), "é".repeat(MAX_NOTE_CHARS + 300), "é".repeat(MAX_NOTE_CHARS + 400)],
    constraints: ["é".repeat(MAX_NOTE_CHARS + 100)],
  });
  const entry = readState().board["handoff-cap-c"];
  const totalRoom = `\n[truncated at ${4 * MAX_NOTE_CHARS} chars]`.length;
  decodesCleanly(entry.value);
  assert.ok(entry.value.startsWith("HANDOFF (set "), "even a capped handoff still renders its header");
  assert.ok(
    entry.value.length <= 4 * MAX_NOTE_CHARS + totalRoom,
    `whole rendered entry capped at 4x: ${entry.value.length}`
  );
});

fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);