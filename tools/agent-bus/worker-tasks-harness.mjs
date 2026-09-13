/**
 * Harness for the worker's task-state layer — claimNextTask, touchTask,
 * finishTask — exercised against a REAL state file in a temp project, not a
 * mock of withState. The failure being pinned: progress writes that leak into
 * status or doneAt, and a beat that lands after finish.
 *
 *   AGENT_BUS_PROJECT is set BEFORE the import — server.mjs resolves its
 *   project root once at import time.
 *
 *   node tools/agent-bus/worker-tasks-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-touch-"));
process.env.AGENT_BUS_PROJECT = HOME;
fs.mkdirSync(path.join(HOME, ".agent-bus"), { recursive: true });
fs.writeFileSync(
  path.join(HOME, ".agent-bus", "state.json"),
  JSON.stringify({ agents: {}, lock: null, messages: [], board: {}, tasks: [], taskSeq: 0 })
);

const { claimNextTask, finishTask, touchTask, asActor, registerCli, callTool } = await import("./server.mjs");

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
const readState = () =>
  JSON.parse(fs.readFileSync(path.join(HOME, ".agent-bus", "state.json"), "utf8"));

// Seed one queued task, the way the task verb does.
const queue = (title) =>
  fs.writeFileSync(
    path.join(HOME, ".agent-bus", "state.json"),
    JSON.stringify(
      {
        agents: {},
        lock: null,
        messages: [],
        board: {},
        taskSeq: 1,
        tasks: [
          {
            id: "t1",
            lane: "build",
            title,
            prompt: "the whole task",
            status: "queued",
            by: "cli",
            at: new Date().toISOString(),
            runner: null,
          },
        ],
      },
      null,
      2
    )
  );

queue("seeded");

check("claim-marks-running-and-stamps-the-runner", () => {
  const t = claimNextTask("build");
  assert.ok(t, "a queued task is claimed");
  const s = readState();
  assert.equal(s.tasks[0].status, "running");
  assert.ok(s.tasks[0].startedAt, "claiming stamps startedAt — the dashboard's elapsed clock reads it");
  assert.equal(s.tasks[0].runner, "worker");
});

check("touchTask-writes-progress-without-touching-status-or-result", () => {
  const before = readState().tasks[0];
  const t = touchTask("t1", {
    progress: { thinkingChars: 42315, responseChars: 0, elapsedMs: 152000 },
  });
  assert.ok(t, "the task exists");
  const after = readState().tasks[0];
  assert.deepEqual(after.progress, { thinkingChars: 42315, responseChars: 0, elapsedMs: 152000 });
  assert.equal(after.status, "running", "a progress beat is not a status change");
  assert.equal(after.result, before.result, "progress never writes the result");
  assert.equal(after.doneAt, before.doneAt, "and never stamps doneAt");
});

check("touchTask-on-an-unknown-id-returns-null-not-a-crash", () => {
  assert.equal(touchTask("t999", { progress: { thinkingChars: 1 } }), null);
  assert.equal(readState().tasks.length, 1, "and no task was invented");
});

check("progress-is-cleared-on-done", () => {
  finishTask("t1", { status: "done", result: "the answer", model: "glm", progress: null });
  const s = readState().tasks[0];
  assert.equal(s.status, "done");
  assert.equal(s.progress, null, "a finished task has nothing in flight to report");
  assert.ok(s.doneAt, "finish stamps doneAt");
});

check("progress-is-cleared-on-failed-too", () => {
  queue("again");
  claimNextTask("build");
  touchTask("t1", { progress: { thinkingChars: 100, responseChars: 0, elapsedMs: 4000 } });
  finishTask("t1", { status: "failed", result: "ollama returned 500", model: "glm", progress: null });
  const s = readState().tasks[0];
  assert.equal(s.status, "failed");
  assert.equal(s.progress, null, "a failed task must not render a stale thinking counter");
});

check("an IDLE poll keeps the worker registered — an hour of empty queue is not death", () => {
  // C7: an idle worker's only bus activity is an empty poll, and a poll that
  // wrote nothing left lastSeen stale — pruneAgents then dropped a worker that
  // was alive and waiting, an hour into every idle stretch.
  const s = readState();
  const stale = new Date(Date.now() - 61 * 60 * 1000).toISOString();
  s.agents["idle-worker"] = {
    sessionKey: "k", lane: "cli", cwd: HOME, registeredAt: stale, lastSeen: stale,
  };
  fs.writeFileSync(path.join(HOME, ".agent-bus", "state.json"), JSON.stringify(s));
  // The queue holds only failed tasks, so the claim comes back null — and the
  // poll must still have breathed.
  assert.equal(asActor("idle-worker", () => claimNextTask("build")), null);
  const seen = readState().agents["idle-worker"].lastSeen;
  assert.notEqual(seen, stale, "the empty-queue poll refreshed lastSeen");
});

check("a live process is not pruned however cold its lastSeen — the pid is proof, not a guess", () => {
  // The 1-hour rule exists so a DEAD agent's name frees up. An agent whose
  // process the OS can still see is not dead, and a long local stretch between
  // bus calls must not vanish it from the board. The dead-pid twin frees its
  // name the way the rule always intended.
  const stale = new Date(Date.now() - 61 * 60 * 1000).toISOString();
  const s = readState();
  s.agents["long-runner"] = {
    sessionKey: "k", lane: "cli", cwd: HOME, host: os.hostname(),
    pid: process.pid, // THIS harness's process — verifiably alive
    registeredAt: stale, lastSeen: stale,
  };
  s.agents["gone-runner"] = {
    sessionKey: "k", lane: "cli", cwd: HOME, host: os.hostname(),
    pid: 4000000000, // no such process
    registeredAt: stale, lastSeen: stale,
  };
  fs.writeFileSync(path.join(HOME, ".agent-bus", "state.json"), JSON.stringify(s));
  asActor("long-runner", () => callTool("status")); // status runs pruneAgents
  const after = readState().agents;
  assert.ok(after["long-runner"], "the live-process agent survives the prune");
  assert.equal(after["gone-runner"], undefined, "the dead-process agent's name frees up");
});

check("ping breathes — the cheapest mutating call keeps a working agent on the board", () => {
  registerCli("pinger");
  const before = readState().agents["pinger"].lastSeen;
  asActor("pinger", () => callTool("ping"));
  const after = readState().agents["pinger"].lastSeen;
  assert.notEqual(after, before, "ping refreshed lastSeen");
  assert.ok(
    readState().agents["pinger"].pid === process.pid,
    "the registration carries the pid the running badge is built from",
  );
});

check("a finished task's result is capped — the state file is rewritten on every bus call", () => {
  queue("big result");
  claimNextTask("build");
  finishTask("t1", { status: "done", result: "x".repeat(100_000) });
  const s = readState().tasks[0];
  assert.ok(s.result.length < 100_000, `capped (got ${s.result.length})`);
  assert.ok(s.result.includes("[truncated"), "and says so");
});

check("note values are capped too", () => {
  asActor("capper", () => callTool("note", { key: "big", value: "y".repeat(20_000) }));
  const v = readState().board.big.value;
  assert.ok(v.length < 20_000, `capped (got ${v.length})`);
  assert.ok(v.includes("[truncated"), "and says so");
});

check("finished tasks are pruned past 100 — the queue is a queue, not an archive", () => {
  const many = Array.from({ length: 105 }, (_, i) => ({
    id: `t${i}`, lane: "build", title: `old ${i}`, prompt: "", status: "done",
    by: "cli", at: new Date(Date.now() - (200 - i) * 1000).toISOString(),
  }));
  const s0 = readState();
  s0.tasks = many;
  fs.writeFileSync(path.join(HOME, ".agent-bus", "state.json"), JSON.stringify(s0));
  asActor("adder", () => callTool("task_add", { lane: "build", title: "new", prompt: "p" }));
  const s = readState();
  assert.ok(s.tasks.length <= 120, `bounded (got ${s.tasks.length})`);
  assert.equal(s.tasks.filter((t) => t.status === "done").length, 100, "exactly 100 finished tasks kept — the oldest 5 dropped");
  assert.ok(s.tasks.some((t) => t.title === "new"), "the newly queued task survives the prune");
});

check("registerCli refuses __proto__ — the dashboard's actor field is untrusted input", () => {
  // state.agents["__proto__"] = {...} sets the prototype instead of a
  // registration: the note never persists, stringify drops it, and no error
  // says why. One assert at the door.
  assert.throws(() => registerCli("__proto__"), /not a usable name/);
  assert.throws(() => registerCli("constructor"), /not a usable name/);
  assert.throws(() => registerCli("x".repeat(200)), /at most 64/);
  registerCli("legit-worker");
  const seen = readState().agents["legit-worker"];
  assert.ok(seen?.lastSeen, "and a good name still registers");
});

fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);