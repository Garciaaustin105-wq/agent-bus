/**
 * The worktree verb's harness — a REAL git fixture repo, real child processes
 * (worktree-harness.mjs per docs/worktree-verb.md §VERIFY). The verb composes
 * worktree add + claim_tree + handoff_take; the failure being pinned is the
 * half-sequence: a tree created with nothing claimed, a handoff guessed
 * between several, a refusal that leaves an orphan. Every check uses spawn
 * children — the verb does its work the same way a caller would see it.
 *
 *   node tools/agent-bus/worktree-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-wt-"));
process.env.AGENT_BUS_PROJECT = HOME;
const SERVER = path.join(import.meta.dirname, "server.mjs");
const git = (args, cwd = HOME) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `fixture git ${args[0]} failed: ${r.stderr}`);
  return r;
};

// A real repo with one commit — enough for `git worktree add -b <branch> <path> HEAD`.
git(["init", "-q"]);
fs.writeFileSync(path.join(HOME, "a.txt"), "fixture\n");
git(["add", "-A"]);
git(["commit", "-q", "-m", "fixture"]);

const {
  withState,
} = await import(new URL("./server.mjs", import.meta.url).href);
const now = () => new Date().toISOString();

// Handoff seeds carry the FULL board shape — handoff_take re-renders with
// renderHandoff, which reads .open/.pointers/.constraints arrays directly.
const seedHandoff = (key, by = "lane-b") =>
  withState((state) => {
    state.board[key] = {
      kind: "handoff",
      key,
      summary: "fixture state of the world",
      nextStep: "run the first thing",
      open: [],
      pointers: [],
      constraints: [],
      setAt: now(),
      at: now(),
      by,
      taken: [],
      value: "HANDOFF (fixture)",
    };
  });

const run = (args, cwd = HOME) => {
  return spawnSync(process.execPath, [SERVER, ...args], {
    cwd,
    env: { ...process.env, AGENT_BUS_NAME: "lane-a", AGENT_BUS_PROJECT: HOME },
    encoding: "utf8",
    timeout: 60_000,
  });
};

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

/* 1 — the happy path, exactly one handoff on the board */
seedHandoff("handoff-lane-a");
check("worktree: the tree exists under agent-bus-worktrees/ (no .claude in the fixture)", () => {
  const r = run(["worktree", "lane-a"]);
  assert.equal(r.status, 0, `verb failed: ${r.stderr}`);
  assert.ok(fs.existsSync(path.join(HOME, "agent-bus-worktrees", "lane-a")), "tree dir missing");
});
check("worktree: the default branch is bus/<name>", () => {
  assert.equal(git(["rev-parse", "--verify", "--quiet", "bus/lane-a"]).status, 0, "branch bus/lane-a missing");
});
check("worktree: the tree is claimed on the bus", () => {
  const state = JSON.parse(fs.readFileSync(path.join(HOME, ".git", "agent-bus", "state.json"), "utf8"));
  assert.equal(state.lock.path.toLowerCase(), path.join(HOME, "agent-bus-worktrees", "lane-a").toLowerCase());
  assert.equal(state.lock.holder, "lane-a");
});
check("worktree: the one handoff was taken, its chain names the taker", () => {
  const state = JSON.parse(fs.readFileSync(path.join(HOME, ".git", "agent-bus", "state.json"), "utf8"));
  const entry = state.board["handoff-lane-a"];
  assert.ok(entry.taken.some((t) => t.by === "lane-a"), "taken chain lacks the caller");
});

/* 2 — two handoffs: never guessed between */
check("two handoffs on the board are listed, none auto-taken", () => {
  seedHandoff("handoff-two-a");
  seedHandoff("handoff-two-b");
  const r = run(["worktree", "two-hands"]);
  assert.equal(r.status, 0, `verb failed: ${r.stderr}`);
  assert.ok(r.stdout.includes("handoff-two-a") && r.stdout.includes("handoff-two-b"), "the keys were not listed");
  const state = JSON.parse(fs.readFileSync(path.join(HOME, ".git", "agent-bus", "state.json"), "utf8"));
  assert.equal(state.board["handoff-two-a"].taken.length, 0, "a handoff WAS auto-taken");
  assert.equal(state.board["handoff-two-b"].taken.length, 0, "a handoff WAS auto-taken");
});

/* 3 — --handoff picks among many */
check("--handoff picks a specific key", () => {
  const r = run(["worktree", "pick-one", "--handoff", "handoff-two-a"]);
  assert.equal(r.status, 0, `verb failed: ${r.stderr}`);
  const state = JSON.parse(fs.readFileSync(path.join(HOME, ".git", "agent-bus", "state.json"), "utf8"));
  assert.equal(state.board["handoff-two-a"].taken.length, 1, "the picked handoff was not taken");
});

/* 4 — zero UNTAKEN handoffs: fine, plainly said. (handoff-lane-a remains on
   the board taken from check 1 — an already-taken entry must not be picked.) */
check("zero handoffs on the board: the sequence still completes and says so", () => {
  withState((state) => { // handoff-two-b is still untaken from check 2; remove both picks
    delete state.board["handoff-two-a"];
    delete state.board["handoff-two-b"];
  });
  const r = run(["worktree", "bare"]);
  assert.equal(r.status, 0, `verb failed: ${r.stderr}`);
  assert.ok(/no (?:unclaimed )?handoff/i.test(r.stdout), "the no-handoff outcome was not stated");
  const state = JSON.parse(fs.readFileSync(path.join(HOME, ".git", "agent-bus", "state.json"), "utf8"));
  assert.equal(state.board["handoff-lane-a"].taken.length, 1, "an already-taken handoff was taken again");
  assert.ok(fs.existsSync(path.join(HOME, "agent-bus-worktrees", "bare")), "tree dir missing");
});

/* 5 — an existing tree is refused, with the claim-instead advice */
check("an existing tree is refused, advised to claim instead", () => {
  const r = run(["worktree", "lane-a"]);
  assert.notEqual(r.status, 0, "a second tree was attempted");
  assert.ok(/claim_tree|claim it/i.test(r.stdout + r.stderr), "the refusal lacks the claim-instead advice");
});

/* 6 — a non-repo project root is refused */
check("a non-git project root is refused", () => {
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-nogit-"));
  fs.writeFileSync(path.join(nogit, "x.txt"), "x");
  const r = spawnSync(process.execPath, [SERVER, "worktree", "never"], {
    env: { ...process.env, AGENT_BUS_NAME: "lane-a", AGENT_BUS_PROJECT: nogit },
    encoding: "utf8",
    timeout: 60_000,
  });
  fs.rmSync(nogit, { recursive: true, force: true });
  assert.notEqual(r.status, 0, "a non-repo accepted a tree");
  assert.ok(/not a git repository/i.test(r.stderr), `the refusal does not say why: ${r.stderr}`);
});

/* 7 — a live foreign claim: created but NOT claimed, the holder named */
check("a live foreign claim: tree created, NOT claimed, holder named", () => {
  withState((state) => {
    state.lock = {
      path: "somewhere-else",
      holder: "the-other",
      holderPid: process.pid,
      reason: "fixture claim",
      claimedAt: now(),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  });
  const r = run(["worktree", "contended"]);
  assert.equal(r.status, 0, `the honest-partial outcome must not be an error: ${r.stderr} / ${r.stdout}`);
  assert.ok(fs.existsSync(path.join(HOME, "agent-bus-worktrees", "contended")), "tree dir missing");
  assert.ok(/NOT claimed/i.test(r.stdout), "the unclaimed outcome was not stated");
  assert.ok(/the-other/i.test(r.stdout), "the holder was not named");
  withState((state) => { state.lock = null; }); // next checks start free
});

/* 8 — slug and ref validation (no tree anywhere for any rejection;
   path.join normalizes "..", so the assertion is against the actual
   worktrees dir's contents, not a normalized path) */
check("slug/ref validation: dotdot, slash in the leaf, .lock branch, spaces in branch", () => {
  const before = fs.existsSync(path.join(HOME, "agent-bus-worktrees"))
    ? fs.readdirSync(path.join(HOME, "agent-bus-worktrees")).sort()
    : [];
  for (const [name, extra] of [
    ["../escape", []],
    ["a/b", []],
    ["ok-name", ["--branch", ".."]],
    ["ok-name", ["--branch", "has space"]],
    ["ok-name", ["--branch", "bus/lane-a.lock"]],
  ]) {
    // Array args — a space-bearing branch must arrive as ONE argv element,
    // the way a real shell quoting would deliver it.
    const r = run(["worktree", name, ...extra]);
    assert.notEqual(r.status, 0, `"${name} ${extra.join(" ")}" was accepted`);
  }
  const after = fs.readdirSync(path.join(HOME, "agent-bus-worktrees")).sort();
  assert.deepEqual(after, before, "a rejected call still created a tree");
});
/* 9 — a failed git worktree add (branch collision) leaves no tree or orphan */
check("a failed git worktree add (branch collision) leaves no tree or orphan", () => {
  const r = run(["worktree", "collide", "--branch", "bus/lane-a"]); // branch already exists
  assert.notEqual(r.status, 0, "a duplicate branch was accepted");
  assert.ok(!fs.existsSync(path.join(HOME, "agent-bus-worktrees", "collide")), "a partial tree was left");
  const listed = git(["worktree", "list", "--porcelain"]).stdout;
  assert.ok(!listed.includes(path.join(HOME, "agent-bus-worktrees", "collide")), "git still lists the half-created tree");
});

/* 13 — the .claude variant: where .claude exists, that is where trees go */
check("a project WITH .claude puts trees under .claude/worktrees/", () => {
  fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
  const r = run(["worktree", "lane-b"]);
  assert.equal(r.status, 0, `verb failed: ${r.stderr}`);
  assert.ok(fs.existsSync(path.join(HOME, ".claude", "worktrees", "lane-b")), "tree dir missing under .claude");
});

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);