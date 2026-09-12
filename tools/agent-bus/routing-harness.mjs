/**
 * Harness for §3 — routing from the fleet's own record. Two layers like the
 * other harnesses: the pure contract in routing.mjs (history in, verdicts and
 * a ranked recommendation out), then the real-state wiring through
 * server.mjs's task_add/runners — because the recommendation's actual job is
 * to ride along in a real queue reply with its reason attached.
 *
 * The checks that matter most: a recommendation can always be argued with
 * (every considered runner carries a why, picked or skipped), a runner on a
 * failure streak is skipped rather than trusted, and cold start says "no
 * history" out loud instead of dressing habit up as data.
 *
 *   AGENT_BUS_PROJECT is set BEFORE the import — server.mjs resolves its
 *   project root once at import time.
 *
 *   node tools/agent-bus/routing-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-routing-"));
process.env.AGENT_BUS_PROJECT = HOME;

const { extractHistory, routingVerdicts, recommendRunner, suggestLine } = await import("./routing.mjs");
const { callTool, asActor, finishTask, claimNextTask } = await import("./server.mjs");

let pass = 0;
let fail = 0;
function check(label, fn) {
  try {
    fn();
    pass++;
    console.log(`ok  [${label}]`);
  } catch (e) {
    fail++;
    console.log(`FAIL [${label}] ${e.message}`);
  }
}

/* ── extractHistory ───────────────────────────────────────────────────────── */

check("extractHistory-takes-only-finished-tasks-with-a-runner", () => {
  const got = extractHistory([
    { id: "t1", status: "done", model: "gpt-oss", result: "abcd" }, // 4 chars
    { id: "t2", status: "failed", model: "gpt-oss", result: "" },
    { id: "t3", status: "queued", model: "gpt-oss" },   // never ran
    { id: "t4", status: "running", model: "gpt-oss" },  // in flight
    { id: "t5", status: "done", model: null },          // ran by nobody recorded
  ]);
  assert.equal(got.length, 2);
  assert.equal(got[0].status, "done");
  assert.equal(got[0].chars, 4);
});

/* ── routingVerdicts ──────────────────────────────────────────────────────── */

check("a-failure-streak-earns-a-stop-routing-verdict", () => {
  const rec = [
    { runner: "a", status: "failed", chars: 0, at: "2026-01-01T00:00:0Z" },
    { runner: "a", status: "failed", chars: 0, at: "2026-01-01T00:01:0Z" },
    { runner: "a", status: "failed", chars: 0, at: "2026-01-01T00:02:0Z" },
  ];
  const [v] = routingVerdicts(rec);
  assert.equal(v.done, 0);
  assert.equal(v.failed, 3);
  assert.equal(v.streak, 3);
  assert.ok(v.line.includes("failed its last 3"), `got: ${v.line}`);
  assert.ok(v.line.includes("stop routing"));
});

check("a-clean-streak-earns-a-default-verdict", () => {
  const rec = Array.from({ length: 5 }, (_, i) => ({
    runner: "b", status: "done", chars: 4000, at: `2026-01-01T00:0${i}:0Z`,
  }));
  const [v] = routingVerdicts(rec);
  assert.equal(v.streak, 5);
  assert.ok(v.line.includes("5 clean finishes"), `got: ${v.line}`);
  assert.ok(v.line.includes("avg draft 4,000"), `got: ${v.line}`);
});

check("mixed-and-small-records-say-what-they-are", () => {
  const [v] = routingVerdicts([
    { runner: "c", status: "done", chars: 100, at: "2026-01-01T00:00:0Z" },
    { runner: "c", status: "failed", chars: 0, at: "2026-01-01T00:01:0Z" },
  ]);
  assert.ok(v.line.includes("mixed record"), `got: ${v.line}`);
});

/* ── recommendRunner ──────────────────────────────────────────────────────── */

const RUNNERS = [
  { id: "gpt-oss", enabled: true, ctx: 32768 },
  { id: "qwen-coder", enabled: true, ctx: 32768 },
  { id: "glm", enabled: true, ctx: 65536 },
  { id: "off", enabled: false, ctx: 65536 },
];

check("a-disabled-runner-is-never-recommended", () => {
  const rec = recommendRunner({ prompt: "small task" }, RUNNERS, [
    { runner: "off", status: "done", chars: 10, at: "2026-01-01" },
  ]);
  assert.ok(rec, "something is recommended");
  assert.notEqual(rec.id, "off");
  assert.ok(rec.considered.every((c) => c.id !== "off"), "disabled runners are not even considered");
});

check("nothing-enabled-returns-null", () => {
  assert.equal(recommendRunner({ prompt: "x" }, [{ id: "a", enabled: false }], []), null);
  assert.equal(recommendRunner({ prompt: "x" }, [], []), null);
});

check("a-prompt-that-would-not-fit-ctx-is-skipped-with-the-reason", () => {
  // 4 chars/token: 10,000 chars ≈ 2,500 tokens — fits. 160,000 chars ≈ 40k
  // tokens — over even glm's 64k*0.9? No: over 32768*0.9=29491, fits 64k.
  const bigPrompt = "x".repeat(160_000);
  const rec = recommendRunner({ prompt: bigPrompt }, RUNNERS, [
    { runner: "gpt-oss", status: "done", chars: 10, at: "2026-01-01" },
    { runner: "glm", status: "failed", chars: 0, at: "2026-01-01" },
  ]);
  const skipped = rec.considered.find((c) => c.id === "gpt-oss");
  assert.ok(skipped && !skipped.picked, "gpt-oss skipped on ctx");
  assert.ok(skipped.why.includes("tokens") && skipped.why.includes("fit"), `got: ${skipped.why}`);
  assert.equal(rec.id, "glm", "the runner whose ctx fits is picked");
});

check("a-failure-streak-is-skipped-even-with-a-good-average", () => {
  const rec = recommendRunner({ prompt: "task" }, RUNNERS, [
    { runner: "qwen-coder", status: "failed", chars: 0, at: "2026-01-01T00:00:0Z" },
    { runner: "qwen-coder", status: "failed", chars: 0, at: "2026-01-01T00:01:0Z" },
    { runner: "qwen-coder", status: "failed", chars: 0, at: "2026-01-01T00:02:0Z" },
    { runner: "glm", status: "done", chars: 10, at: "2026-01-01T00:00:0Z" },
  ]);
  assert.equal(rec.id, "glm");
  const skipped = rec.considered.find((c) => c.id === "qwen-coder");
  assert.ok(skipped.why.includes("failed its last 3"), `got: ${skipped.why}`);
});

check("best-recent-record-wins-and-failures-count-double", () => {
  // gpt-oss: 3 done (+3). qwen-coder: 3 done, 2 failed (+1). gpt-oss wins.
  const rec = recommendRunner({ prompt: "task" }, RUNNERS, [
    { runner: "gpt-oss", status: "done", chars: 10, at: "2026-01-01T00:00:0Z" },
    { runner: "gpt-oss", status: "done", chars: 10, at: "2026-01-01T00:01:0Z" },
    { runner: "gpt-oss", status: "done", chars: 10, at: "2026-01-01T00:02:0Z" },
    { runner: "qwen-coder", status: "done", chars: 10, at: "2026-01-01T00:00:0Z" },
    { runner: "qwen-coder", status: "done", chars: 10, at: "2026-01-01T00:01:0Z" },
    { runner: "qwen-coder", status: "failed", chars: 0, at: "2026-01-01T00:02:0Z" },
    { runner: "qwen-coder", status: "done", chars: 10, at: "2026-01-01T00:03:0Z" },
    { runner: "qwen-coder", status: "failed", chars: 0, at: "2026-01-01T00:04:0Z" },
  ]);
  assert.equal(rec.id, "gpt-oss", `got ${rec.id}: ${rec.why}`);
  assert.ok(rec.why.includes("record"), "the why names the record");
});

check("ties-break-alphabetically-same-inputs-same-answer", () => {
  const hist = [
    { runner: "zeta", status: "done", chars: 10, at: "2026-01-01T00:00:0Z" },
    { runner: "alpha", status: "done", chars: 10, at: "2026-01-01T00:00:0Z" },
  ];
  const two = [recommendRunner({ prompt: "t" }, [{ id: "zeta", enabled: true }, { id: "alpha", enabled: true }], hist),
               recommendRunner({ prompt: "t" }, [{ id: "zeta", enabled: true }, { id: "alpha", enabled: true }], hist)];
  assert.equal(two[0].id, "alpha");
  assert.equal(two[1].id, "alpha", "deterministic");
});

check("cold-start-says-no-history-out-loud", () => {
  const rec = recommendRunner({ prompt: "task" }, RUNNERS, []);
  assert.ok(rec, "cold start still recommends");
  assert.ok(rec.why.includes("no history"), `got: ${rec.why}`);
});

check("proven-outranks-unproven-and-every-considered-carries-a-why", () => {
  const rec = recommendRunner({ prompt: "task" }, RUNNERS, [
    { runner: "gpt-oss", status: "failed", chars: 0, at: "2026-01-01T00:00:0Z" },
    { runner: "gpt-oss", status: "done", chars: 10, at: "2026-01-01T00:01:0Z" },
  ]);
  assert.equal(rec.id, "gpt-oss", "has history (-1) outranks no history (0)");
  assert.equal(rec.considered.length, 3, "every enabled runner is considered");
  for (const c of rec.considered) {
    assert.ok(c.why && c.why.length > 5, `${c.id} has a why: ${c.why}`);
  }
  const picked = rec.considered.find((c) => c.picked);
  assert.equal(picked.id, rec.id, "exactly the pick is marked");
});

check("suggestLine-is-one-line-with-the-pin-instruction", () => {
  const rec = recommendRunner({ prompt: "task" }, RUNNERS, [
    { runner: "glm", status: "done", chars: 10, at: "2026-01-01" },
  ]);
  const line = suggestLine(rec);
  assert.ok(line.includes("Routing suggestion: glm"));
  assert.ok(line.includes('runner_id: "glm"'));
  assert.equal(suggestLine(null), "", "null recommendation renders as nothing");
});

/* ── the real-state wiring ────────────────────────────────────────────────── */

const readState = () =>
  JSON.parse(fs.readFileSync(path.join(HOME, ".agent-bus", "state.json"), "utf8"));
const seedTask = (model, status) => {
  // Queue through the real path, claim, finish — the way the worker does.
  asActor("seeder", () => callTool("task_add", { lane: "seed", title: `t-${model}-${status}`, prompt: "p" }));
  const s = readState();
  const t = s.tasks.find((x) => x.status === "queued" && x.lane === "seed");
  claimNextTask("seed");
  finishTask(t.id, { status, result: status === "done" ? "the answer" : "boom", model });
};

check("task_add-without-a-runner-id-rides-a-suggestion-with-its-reason", () => {
  seedTask("gpt-oss", "done");
  seedTask("gpt-oss", "done");
  const out = asActor("queuer", () => callTool("task_add", { lane: "local", title: "real", prompt: "the spec" }));
  assert.ok(out.includes("Queued t"), "the queue confirmation is still first");
  assert.match(out, /Routing suggestion: \S+ — .+ runner_id: "/);
  assert.ok(out.includes("record") || out.includes("history"), `why attached: ${out.split("\n")[1]}`);
});

check("task_add-with-a-runner-id-does-not-second-guess-an-explicit-choice", () => {
  const out = asActor("queuer", () =>
    callTool("task_add", { lane: "seed", title: "pinned", prompt: "p", runner_id: "codestral" }),
  );
  assert.ok(!out.includes("Routing suggestion"), `got: ${out}`);
});

check("runners-attaches-each-runner-s-measured-record", () => {
  const out = asActor("looker", () => callTool("runners", {}));
  assert.ok(out.includes("record: gpt-oss — 2 done"), `got:\n${out}`);
  assert.ok(out.includes("record: none yet"), "runners without history say so");
  assert.ok(out.includes("x "), "disabled entries still marked x");
});

check("register-lists-open-blockers-for-the-joiner", () => {
  asActor("stuck", () => callTool("register", { name: "stuck", lane: "x" }));
  const reported = asActor("stuck", () => callTool("block", { what: "needs ollama up", needed: "ollama" }));
  const id = reported.match(/Reported (b\d+)\./)[1];
  const out = asActor("joiner", () => callTool("register", { name: "joiner", lane: "y" }));
  assert.ok(out.includes("Open blockers right now"), `got: ${out}`);
  assert.ok(out.includes(`unblock("${id}"`), "with the id and the ask");
  // Once resolved, the standing-problem listing clears for the next joiner.
  asActor("solver", () => callTool("register", { name: "solver", lane: "z" }));
  asActor("solver", () => callTool("capable", { capabilities: ["ollama"] }));
  // Another joiner first, to pin that an UNresolved block keeps listing:
  const still = asActor("joiner2", () => callTool("register", { name: "joiner2", lane: "y" }));
  assert.ok(still.includes(`unblock("${id}"`), "unresolved keeps listing");
  asActor("solver", () => callTool("unblock", { id, how: "started ollama" }));
  const after = asActor("joiner3", () => callTool("register", { name: "joiner3", lane: "y" }));
  assert.ok(after.includes("No open blockers"), `got: ${after}`);
});

fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);