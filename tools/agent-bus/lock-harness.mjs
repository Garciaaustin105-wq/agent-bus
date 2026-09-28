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

// 2026-09-28: two idle `server.mjs work` processes died with an uncaught
// "EPERM: operation not permitted, open '...\.lock'" at withState. On Windows,
// opening a file that another process is in the middle of deleting fails with
// EPERM (sometimes EACCES or EBUSY) instead of EEXIST, and withState rethrew
// anything that was not EEXIST. It must wait and retry like EEXIST, and only
// surface the real error once its attempt budget is spent.
{
  const { withState } = await import(new URL("./server.mjs", import.meta.url).href);
  fs.rmSync(LOCK, { force: true });
  const realOpen = fs.openSync;
  const failWith = (code, times) => {
    let left = times;
    fs.openSync = (p, ...rest) => {
      if (p === LOCK && left > 0) {
        left--;
        throw Object.assign(new Error(`${code}: operation not permitted, open '${p}'`), { code });
      }
      return realOpen(p, ...rest);
    };
    return () => left;
  };
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    check(`a transient ${code} on the lock open is waited out, not thrown`, () => {
      const left = failWith(code, 3);
      try {
        const out = withState(() => "ran");
        assert.equal(out, "ran", "the critical section ran once the lock opened");
        assert.equal(left(), 0, "all three transient failures were retried through");
      } finally {
        fs.openSync = realOpen;
      }
    });
  }
  check("a PERSISTENT EPERM still surfaces once the attempt budget is spent", () => {
    failWith("EPERM", Infinity);
    try {
      assert.throws(() => withState(() => "never"), /EPERM|state lock/);
    } finally {
      fs.openSync = realOpen;
    }
  });
}

sleeper.kill();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);