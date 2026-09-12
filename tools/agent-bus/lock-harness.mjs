/**
 * The state lock's stale-break and cleanup paths, against a REAL lock file and
 * REAL pids. The failure being pinned (audit S8): withState's cleanup used to
 * unlink the lock unconditionally — B judges A's lock stale, unlinks it and
 * takes its own; A's finally then deletes B's LIVE lock and a third process
 * walks in mid-write. The lock now carries pid:token; a stale break needs a
 * dead holder, and cleanup removes only a lock that still holds our token.
 *
 *   node tools/agent-bus/lock-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-lock-"));
process.env.AGENT_BUS_PROJECT = HOME;
const stateDir = path.join(HOME, ".git", "agent-bus");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, "state.json"),
  JSON.stringify({ agents: {}, lock: null, messages: [], board: {}, tasks: [], taskSeq: 0 })
);
const LOCK = path.join(stateDir, ".lock");
const SERVER = path.join(import.meta.dirname, "server.mjs");
const board = () =>
  spawnSync(process.execPath, [SERVER, "board"], {
    env: { ...process.env, AGENT_BUS_PROJECT: HOME },
    encoding: "utf8",
    timeout: 30_000,
  });

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

// A live pid that is not ours: a sleeping child.
const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"]);
const sleeperPid = sleeper.pid;
// A dead pid: run something that has already exited.
const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;

check("a lock whose holder pid is dead is broken after the stale window", () => {
  fs.writeFileSync(LOCK, `${deadPid}:someother`);
  const past = Date.now() - 11_000;
  fs.utimesSync(LOCK, past / 1000, past / 1000); // older than LOCK_STALE_MS
  const r = board();
  assert.equal(r.status, 0, `board failed: ${r.stderr}`);
  assert.ok(!fs.existsSync(LOCK), "the dead holder's lock was broken and cleaned up");
});

check("a lock whose holder pid is ALIVE is never broken", () => {
  fs.writeFileSync(LOCK, `${sleeperPid}:someother`);
  const past = Date.now() - 11_000;
  fs.utimesSync(LOCK, past / 1000, past / 1000);
  const r = board();
  assert.ok(r.status !== 0, "a live holder's lock must not be stolen");
  assert.ok(
    /could not acquire the state lock/.test(String(r.stderr)),
    `the refusal names the lock: ${r.stderr}`
  );
  assert.ok(fs.existsSync(LOCK), "the live holder's lock still stands");
  assert.equal(fs.readFileSync(LOCK, "utf8"), `${sleeperPid}:someother`, "contents untouched");
});

check("a FRESH lock from a dead holder is still waited on, not stolen", () => {
  fs.writeFileSync(LOCK, `${deadPid}:someother`); // fresh mtime
  const r = board();
  assert.ok(r.status !== 0, "a fresh lock is waited on even with a dead pid");
  assert.ok(fs.existsSync(LOCK), "the fresh lock was left alone");
  fs.rmSync(LOCK); // the harness cleans up after itself — the next check starts clean
});

check("a successful run cleans up its own lock, and only its own", () => {
  const r = board();
  assert.equal(r.status, 0, `board failed: ${r.stderr}`);
  assert.ok(!fs.existsSync(LOCK), "the lock is gone after a clean run");
});

check("an unparseable lock is treated as dead only when stale", () => {
  fs.writeFileSync(LOCK, "not-a-pid-token");
  const past = Date.now() - 11_000;
  fs.utimesSync(LOCK, past / 1000, past / 1000);
  const r = board();
  assert.equal(r.status, 0, `garbage lock older than the stale window is broken: ${r.stderr}`);
});

sleeper.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);