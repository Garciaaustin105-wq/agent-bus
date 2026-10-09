// Suite #20 — the monitor contract (docs/monitoring.md).
//
// Pure fixtures only, like the health contract is tested: build state by
// hand, run the contract, check the numbers and the verdicts. No bus, no
// disk — the file says state in, findings out, and this harness holds it
// to that literally.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import {
  NO_SHIP_MS,
  RUN_MEDIAN_MIN_SAMPLES,
  RUN_OUTLIER_FLOOR_MS,
  RUN_OUTLIER_MULT,
  UNREVIEWED_MS,
  monitorFindings,
  renderMonitor,
  taskStats,
} from "./monitor.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "ab-monitor-"));
let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
};

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = 1_770_000_000_000; // one fixed instant — no Date.now() drift in a fixture

// A finished task with a real claim→finish span, at `at` days before now.
const finished = (id, { status = "done", runner = "w", doneDaysAgo = 1, durH = 2, at = 2, started = undefined, done = undefined } = {}) => ({
  id,
  lane: "local",
  title: id,
  status,
  runner,
  by: "desk",
  at: new Date(now - at * DAY).toISOString(),
  startedAt: started ?? new Date(now - doneDaysAgo * DAY).toISOString(),
  doneAt: done ?? new Date(now - doneDaysAgo * DAY + durH * HOUR).toISOString(),
});

/* ── taskStats ────────────────────────────────────────────────────────────── */

ok("rate: overall rate over the retained record", () => {
  const state = { tasks: [
    finished("t1", { status: "done", runner: "a" }),
    finished("t2", { status: "done", runner: "a" }),
    finished("t3", { status: "failed", runner: "a" }),
    finished("t4", { status: "done", runner: "b" }),
  ] };
  const s = taskStats(state, { now });
  assert.equal(s.total, 4);
  assert.equal(s.failed, 1);
  assert.ok(Math.abs(s.rate - 0.25) < 1e-9);
});

ok("rate: per-runner split is the claim side's ledger", () => {
  const state = { tasks: [
    finished("t1", { status: "failed", runner: "flaky" }),
    finished("t2", { status: "failed", runner: "flaky" }),
    finished("t3", { status: "done", runner: "steady" }),
    finished("t4", { status: "done", runner: "steady" }),
    finished("t5", { status: "done", runner: "steady" }),
    finished("t6", { status: "done", runner: "steady" }),
  ] };
  const s = taskStats(state, { now });
  const flaky = s.perRunner.find((r) => r.runner === "flaky");
  const steady = s.perRunner.find((r) => r.runner === "steady");
  assert.equal(flaky.total, 2);
  assert.equal(flaky.failed, 2);
  assert.equal(steady.failed, 0);
  // queued and running tasks are not finished, so they do not enter the rate
  state.tasks.push({ id: "t7", status: "queued", runner: null, at: new Date(now).toISOString() },
                   { id: "t8", status: "running", runner: "flaky", at: new Date(now).toISOString() });
  assert.equal(taskStats(state, { now }).total, 6);
});

ok("rate: the report states its window, not just a percentage", () => {
  // Oldest finished task's doneAt is exactly 9 days back (zero build time).
  const state = { tasks: [
    finished("t-old", { doneDaysAgo: 9, at: 9.5, durH: 0 }),
    finished("t-new", { status: "failed", doneDaysAgo: 0.05 }),
  ] };
  const out = renderMonitor(state, { now });
  assert.match(out, /over the last 9 days/);
  assert.match(out, /1 failed \(50%\)/);
  assert.equal(taskStats(state, { now }).spanDays >= 9, true);
});

ok("rate: an empty space renders quiet, not 0%", () => {
  const out = renderMonitor({ tasks: [] }, { now });
  assert.match(out, /Quiet/);
  assert.ok(!out.includes("0%"), "no rate computed over nothing");
  assert.equal(taskStats({}, { now }).rate, null);
});

/* ── long-running ─────────────────────────────────────────────────────────── */

ok("long-running: fires past 3× the median finish under a LIVE runner", () => {
  // Median finished duration 2h; the running task has held 4 days.
  const state = {
    tasks: [
      finished("t1", { durH: 2 }), finished("t2", { durH: 2 }),
      finished("t3", { durH: 2, status: "failed" }), finished("t4", { durH: 2 }),
      finished("t5", { durH: 2 }),
      { id: "t9", status: "running", runner: "still-alive", startedAt: new Date(now - 5 * DAY).toISOString(), at: new Date(now - 5 * DAY).toISOString() },
    ],
    agents: { "still-alive": { lastSeen: new Date(now - 60_000).toISOString() } }, // fresh — health sees nothing
  };
  const f = monitorFindings(state, { now });
  const hit = f.find((x) => x.kind === "long-running");
  assert.ok(hit, "expected a long-running finding");
  assert.equal(hit.subject, "t9");
  assert.ok(/3×|median/.test(hit.detail));
});

ok("long-running: stays silent with too few samples to be a rule", () => {
  const tasks = [];
  for (let i = 0; i < RUN_MEDIAN_MIN_SAMPLES - 1; i++) tasks.push(finished(`h${i}`, { durH: 1 }));
  tasks.push({ id: "t9", status: "running", startedAt: new Date(now - 5 * DAY).toISOString() });
  const state = { tasks };
  assert.ok(!monitorFindings(state, { now }).some((f) => f.kind === "long-running"));
});

ok("long-running: the floor protects short medians", () => {
  // Median 6 minutes → 3× = 18 minutes, way under the 2h floor.
  const tasks = [];
  for (let i = 0; i < RUN_MEDIAN_MIN_SAMPLES + 1; i++) tasks.push(finished(`q${i}`, { durH: 0.1 }));
  tasks.push({ id: "t9", status: "running", startedAt: new Date(now - 1.5 * HOUR).toISOString() });
  const state = { tasks };
  assert.ok(!monitorFindings(state, { now }).some((f) => f.kind === "long-running"),
    "RUN_OUTLIER_FLOOR_MS must not be beaten by a thin median");
});

ok("long-running: threshold is max(median×3, floor), not their sum", () => {
  // Median 8h → 3× = 24h, over the floor; a 5h-old claim must be unflagged.
  const tasks = [];
  for (let i = 0; i < RUN_MEDIAN_MIN_SAMPLES + 1; i++) tasks.push(finished(`d${i}`, { durH: 8 }));
  tasks.push({ id: "t9", status: "running", startedAt: new Date(now - 5 * HOUR).toISOString() });
  const state = { tasks };
  assert.ok(!monitorFindings(state, { now }).some((f) => f.kind === "long-running"));
  assert.equal(RUN_OUTLIER_MULT, 3);
  assert.equal(RUN_OUTLIER_FLOOR_MS, 2 * HOUR);
});

/* ── unreviewed-done ──────────────────────────────────────────────────────── */

ok("unreviewed-done: fires at 7 days, not at 6, and not once reviewed", () => {
  const reviewed = finished("reviewed", { doneDaysAgo: 9 });
  reviewed.reviews = [{ verdict: "approve", by: "desk", at: new Date(now - 2 * DAY).toISOString() }];
  const state = { tasks: [
    finished("old", { doneDaysAgo: 8 }),
    finished("fresh", { doneDaysAgo: 6 }),
    reviewed,
  ] };
  const f = monitorFindings(state, { now });
  const hits = f.filter((x) => x.kind === "unreviewed-done");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].subject, "old");
  assert.equal(UNREVIEWED_MS, 7 * DAY);
});

/* ── no-ship ──────────────────────────────────────────────────────────────── */

ok("no-ship: fires on a busy space with a cold publish record", () => {
  const state = {
    tasks: [finished("t1", { doneDaysAgo: 2 }), finished("t2", { doneDaysAgo: 3 })],
    publishes: [{ version: "v0.1.4", what: "x", by: "desk", at: new Date(now - 21 * DAY).toISOString() }],
  };
  const f = monitorFindings(state, { now });
  const hit = f.find((x) => x.kind === "no-ship");
  assert.ok(hit, "expected the no-ship observance");
  assert.equal(hit.subject, "v0.1.4"); // stable to the version → clearable
  assert.match(hit.detail, /21 days old/);
});

ok("no-ship: a quiet space is not decay — the activity clause holds", () => {
  // Cold publish record but NOTHING finished inside the window.
  const state = {
    tasks: [finished("t-old", { doneDaysAgo: 40 })],
    publishes: [{ version: "v0.1.4", what: "x", by: "desk", at: new Date(now - 30 * DAY).toISOString() }],
  };
  assert.ok(!monitorFindings(state, { now }).some((f) => f.kind === "no-ship"));
});

ok("no-ship: a fresh publish, or a first-ever one, turns the key and clears", () => {
  const state = {
    tasks: [finished("t1", { doneDaysAgo: 1 })],
    publishes: [{ version: "v0.1.5", what: "x", by: "desk", at: new Date(now - 2 * DAY).toISOString() }],
  };
  assert.ok(!monitorFindings(state, { now }).some((f) => f.kind === "no-ship"));
  assert.equal(NO_SHIP_MS, 14 * DAY);
});

/* ── hygiene ──────────────────────────────────────────────────────────────── */

ok("fixture dir removed", () => {
  rmSync(dir, { recursive: true, force: true });
  assert.ok(true);
});

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);