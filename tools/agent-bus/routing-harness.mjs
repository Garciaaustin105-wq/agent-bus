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
// A fixture fleet, so no check depends on which models this machine has.
const FLEET = path.join(HOME, "runners.json");
fs.writeFileSync(FLEET, JSON.stringify({ runners: [
  { id: "local-a", type: "ollama", model: "model-a", enabled: true, ctx: 32768 },
  { id: "local-b", type: "ollama", model: "model-b", enabled: true, ctx: 32768 },
  { id: "off", type: "ollama", model: "model-c", enabled: false },
  { id: "cloud-a", type: "ollama", model: "model-d", enabled: true, ctx: 65536 },
] }));
process.env.AGENT_BUS_RUNNERS = FLEET;

const { extractHistory, routingVerdicts, recommendRunner, suggestLine, ROLES, inferRole, pickForRole } = await import("./routing.mjs");
const { callTool, asActor, finishTask, claimNextTask, queueRetry, COST_RULES, findRunner, readRunners } = await import("./server.mjs");

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

/* ── roles: the bus fills them from its own measurements ─────────────────── */

// A runner's last finishes: n of them, each ms long, done unless told otherwise.
const H = (runner, n, { ms = 30000, status = "done", empty = false, chars = 1000 } = {}) =>
  Array.from({ length: n }, () => ({ runner, status, chars, ms, empty, at: "2026-09-14T00:00:00Z" }));
const R = ["fast", "flaky", "steady"].map((id) => ({ id, enabled: true }));

check("extractHistory-records-how-long-a-run-took-and-whether-it-came-back-empty", () => {
  const h = extractHistory([
    { status: "done", model: "a", result: "the answer", startedAt: "2026-09-14T00:00:00.000Z", doneAt: "2026-09-14T00:00:29.000Z" },
    { status: "done", model: "a", result: "[no final answer — the model returned nothing. Its thinking so far:]", startedAt: "2026-09-14T00:00:00.000Z", doneAt: "2026-09-14T00:01:00.000Z" },
    { status: "failed", model: "a", result: "boom" },
  ]);
  assert.deepEqual(h.map((x) => [x.ms, x.empty]), [[29000, false], [60000, true], [null, false]]);
});

check("inferRole-honours-an-explicit-role-else-sizes-the-prompt", () => {
  assert.deepEqual(Object.keys(ROLES).sort(), ["deep", "quick"]);
  assert.equal(inferRole({ role: "deep", prompt: "x" }), "deep");
  assert.equal(inferRole({ role: "quick", prompt: "x".repeat(20000) }), "quick");
  assert.equal(inferRole({ prompt: "x".repeat(8000) }), "quick", "2,000 tokens is still one ordinary job");
  assert.equal(inferRole({ prompt: "x".repeat(8004) }), "deep", "past 2,000 tokens is a long job");
  assert.equal(inferRole({ role: "toString", prompt: "x" }), "quick", "an inherited key is not a role");
});

check("quick-picks-the-fastest-runner-that-reliably-answers-and-skips-a-fast-flaky-one", () => {
  const h = [...H("fast", 5, { ms: 30000 }), ...H("flaky", 3, { ms: 10000 }), ...H("flaky", 2, { ms: 10000, empty: true }), ...H("steady", 5, { ms: 90000 })];
  const p = pickForRole("quick", { prompt: "p" }, R, h);
  assert.equal(p.id, "fast", JSON.stringify(p));
  assert.equal(p.cold, false);
  assert.match(p.considered.find((c) => c.id === "flaky").why, /miss/);
  assert.ok(p.considered.every((c) => c.why), "every considered runner carries a why");
});

check("failures-count-as-misses-just-like-empty-answers", () => {
  const h = [...H("fast", 5, { ms: 30000 }), ...H("flaky", 3, { ms: 10000 }), ...H("flaky", 2, { ms: 10000, status: "failed" })];
  assert.equal(pickForRole("quick", {}, R, h).id, "fast");
});

check("deep-picks-the-most-reliable-then-the-fullest-answers", () => {
  const h = [...H("fast", 4, { chars: 1200 }), ...H("fast", 1, { empty: true }), ...H("steady", 5, { ms: 90000, chars: 900 })];
  assert.equal(pickForRole("deep", {}, R, h).id, "steady", "fewer misses wins over speed");
  const tie = [...H("fast", 5, { chars: 1200 }), ...H("steady", 5, { ms: 90000, chars: 2000 })];
  assert.equal(pickForRole("deep", {}, R, tie).id, "steady", "same reliability: the fuller answers");
  assert.equal(pickForRole("quick", {}, R, tie).id, "fast", "and quick still takes the faster one");
});

check("fewer-than-three-finishes-is-unmeasured-and-says-so", () => {
  const cold = pickForRole("quick", {}, R, H("fast", 2, { ms: 1 }));
  assert.equal(cold.cold, true, "nothing measured: a cold pick, flagged");
  assert.match(cold.why, /no runner has 3 finishes/);
  const h = [...H("fast", 2, { ms: 1 }), ...H("steady", 3, { ms: 90000 })];
  assert.equal(pickForRole("quick", {}, R, h).id, "steady", "a measured runner beats an unmeasured faster one");
});

check("the-gates-still-hold-disabled-ctx-streak-and-exclude", () => {
  const h = [...H("fast", 5, { ms: 1000 }), ...H("steady", 5, { ms: 90000 }), ...H("flaky", 5, { ms: 5000 })];
  const runners = [{ id: "fast", enabled: false }, { id: "flaky", enabled: true, ctx: 1000 }, { id: "steady", enabled: true }];
  assert.equal(pickForRole("quick", { prompt: "x".repeat(4000) }, runners, h).id, "steady", "disabled and too-small ctx both skipped");
  // fast misses 3 in 10, steady 5 in 10: on record alone deep takes fast. Only
  // the streak (fast's last three all failed) can skip it.
  const streak = [...H("fast", 7), ...H("fast", 3, { status: "failed" }), ...H("steady", 5, { status: "failed" }), ...H("steady", 5)];
  assert.equal(pickForRole("deep", {}, R, streak).id, "steady", "three failures in a row skipped");
  assert.match(pickForRole("deep", {}, R, streak).considered.find((c) => c.id === "fast").why, /failed its last 3/);
  assert.equal(pickForRole("quick", {}, R, h, ["fast"]).id, "flaky", "an excluded runner is skipped");
  assert.match(pickForRole("quick", {}, R, h, ["fast"]).considered.find((c) => c.id === "fast").why, /already tried/);
  assert.equal(pickForRole("quick", {}, [{ id: "off", enabled: false }], h), null, "nothing eligible");
  assert.equal(pickForRole("quick", {}, R, h, ["fast", "flaky", "steady"]), null, "everything excluded");
});

check("the-cost-rules-every-agent-is-told-name-no-runner-or-model", () => {
  // The tracked template, plus this machine's own list when it has one.
  const listed = ["./runners.example.json", "./runners.json"]
    .map((f) => new URL(f, import.meta.url))
    .filter((u) => fs.existsSync(u))
    .flatMap((u) => JSON.parse(fs.readFileSync(u, "utf8")).runners);
  const names = listed.flatMap((r) => [r.id, r.model, String(r.label ?? "").split(/[\s:]/)[0]]).filter(Boolean);
  for (const n of [...names, "gpt", "glm", "qwen", "llama", "claude"]) {
    assert.ok(!COST_RULES.toLowerCase().includes(n.toLowerCase()), `COST_RULES names "${n}"`);
  }
  assert.ok(COST_RULES.includes("role"), "it tells agents to ask for a role instead");
});

check("the-shipped-runner-list-is-a-template-and-the-real-one-stays-local", () => {
  const example = JSON.parse(fs.readFileSync(new URL("./runners.example.json", import.meta.url), "utf8"));
  assert.ok(example.runners.length > 0, "the template shows each type");
  assert.ok(example.runners.every((r) => r.enabled === false), "and runs nothing until someone fills it in");
  const shipped = JSON.stringify(example).toLowerCase();
  for (const n of ["gpt", "glm", "qwen", "llama3", "codestral", "mistral", "gemma", "deepseek", "claude"]) {
    assert.ok(!shipped.includes(n), `runners.example.json names "${n}"`);
  }
  const ignored = fs.readFileSync(new URL("../../.gitignore", import.meta.url), "utf8").split(/\r?\n/);
  assert.ok(ignored.includes("tools/agent-bus/runners.json"), "git ignores the machine's own list");
  const code = ["./server.mjs", "./hub.mjs", "./routing.mjs"].map((f) => fs.readFileSync(new URL(f, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(code, /"(gpt-oss|glm|qwen[\w.:-]*|codestral)[^"]*"/i, "no runner or model is built into the code");
});

check("no-runners-file-is-named-never-guessed", () => {
  const was = process.env.AGENT_BUS_RUNNERS;
  try {
    process.env.AGENT_BUS_RUNNERS = path.join(HOME, "missing.json");
    assert.deepEqual(readRunners(), [], "no fallback runner appears");
    assert.throws(() => findRunner(), /runners\.example\.json/, "the fix is named");
    const broken = path.join(HOME, "broken.json");
    fs.writeFileSync(broken, "{ not json");
    process.env.AGENT_BUS_RUNNERS = broken;
    assert.deepEqual(readRunners(), []);
    assert.throws(() => findRunner(), /not valid JSON/);
    const withDefault = path.join(HOME, "default.json");
    fs.writeFileSync(withDefault, JSON.stringify({ default: "second", runners: [
      { id: "first", type: "ollama", model: "m1", enabled: true },
      { id: "second", type: "ollama", model: "m2", enabled: true },
    ] }));
    process.env.AGENT_BUS_RUNNERS = withDefault;
    assert.equal(findRunner().id, "second", "the file's default wins over first-enabled");
    assert.equal(findRunner("first").id, "first", "an asked-for id wins over the default");
  } finally {
    process.env.AGENT_BUS_RUNNERS = was;
  }
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
  seedTask("local-a", "done");
  seedTask("local-a", "done");
  const out = asActor("queuer", () => callTool("task_add", { lane: "local", title: "real", prompt: "the spec" }));
  assert.ok(out.includes("Queued t"), "the queue confirmation is still first");
  assert.match(out, /Routing suggestion: \S+ — .+ runner_id: "/);
  assert.ok(out.includes("record") || out.includes("history"), `why attached: ${out.split("\n")[1]}`);
});

check("task_add-with-a-runner-id-does-not-second-guess-an-explicit-choice", () => {
  const out = asActor("queuer", () =>
    callTool("task_add", { lane: "seed", title: "pinned", prompt: "p", runner_id: "off" }),
  );
  assert.ok(!out.includes("Routing suggestion"), `got: ${out}`);
});

check("runners-attaches-each-runner-s-measured-record", () => {
  const out = asActor("looker", () => callTool("runners", {}));
  assert.ok(out.includes("record: local-a — 2 done"), `got:\n${out}`);
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

check("task_add-refuses-a-role-that-is-not-one", () => {
  let out;
  try { out = asActor("queuer", () => callTool("task_add", { lane: "seed", title: "r", prompt: "p", role: "fastest" })); } catch (e) { out = e.message; }
  assert.ok(out.includes("Unknown role"), `got: ${out}`);
  assert.ok(!readState().tasks.some((t) => t.title === "r"), "and nothing was queued");
});

check("task_add-with-a-measured-role-routes-it-and-says-why", () => {
  seedTask("local-a", "done"); // the third finish: now measured
  const out = asActor("queuer", () => callTool("task_add", { lane: "local", title: "routed", prompt: "the spec", role: "quick" }));
  assert.match(out, /Routed to local-a for the quick role — .+runner_id/);
  const t = readState().tasks.find((x) => x.title === "routed");
  assert.deepEqual([t.runner_id, t.role], ["local-a", "quick"]);
  const pinned = asActor("queuer", () => callTool("task_add", { lane: "local", title: "pinned2", prompt: "p", role: "deep", runner_id: "cloud-a" }));
  assert.ok(!pinned.includes("Routed to"), "an explicit runner_id is never second-guessed");
  assert.deepEqual(readState().tasks.find((x) => x.title === "pinned2").runner_id, "cloud-a");
});

check("a-miss-is-retried-once-on-a-different-runner-never-twice", () => {
  const miss = (title, patch) => {
    asActor("seeder", () => callTool("task_add", { lane: "retry", title, prompt: "p", role: "quick" }));
    const t = readState().tasks.find((x) => x.title === title);
    claimNextTask("retry");
    finishTask(t.id, patch);
    return t.id;
  };
  const failed = miss("m1", { status: "failed", result: "boom", model: "local-a" });
  const r = queueRetry(failed);
  assert.ok(r && r.runner !== "local-a", `retried elsewhere: ${JSON.stringify(r)}`);
  const retry = readState().tasks.find((x) => x.id === r.id);
  assert.deepEqual([retry.retryOf, retry.runner_id, retry.prompt, retry.status, retry.lane], [failed, r.runner, "p", "queued", "retry"]);
  assert.equal(queueRetry(failed), null, "the same miss is not retried twice");
  claimNextTask("retry");
  finishTask(r.id, { status: "failed", result: "boom again", model: r.runner });
  assert.equal(queueRetry(r.id), null, "a retry that misses is not retried again");
  const empty = miss("m2", { status: "done", result: "[no final answer — the model returned nothing. Its thinking so far:]", model: "local-a" });
  assert.ok(queueRetry(empty), "an empty answer is a miss too");
  const fine = miss("m3", { status: "done", result: "a real answer", model: "local-a" });
  assert.equal(queueRetry(fine), null, "a real answer is never retried");
  assert.equal(queueRetry("t-nope"), null, "an unknown id is nothing");
});

fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);