/**
 * Harness for the blocker seam — §5's second half. Two layers, like
 * worker-tasks-harness: the pure matching contract in blockers.mjs (words in,
 * matches out), then the real-state lifecycle through server.mjs's callTool,
 * against a temp project — because the seam's actual job is state, messages
 * and board notes, not string matching.
 *
 * The lifecycle check that matters most: block → unblock → a SECOND block of
 * the same shape gets the banked fix handed back. That is the whole point of
 * banking fixes; if that loop fails, unblock() is just a status update.
 *
 *   AGENT_BUS_PROJECT is set BEFORE the import — server.mjs resolves its
 *   project root once at import time.
 *
 *   node tools/agent-bus/blockers-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-blockers-"));
process.env.AGENT_BUS_PROJECT = HOME;

const {
  normalizeTerms,
  matchCapable,
  matchFixes,
  fixNoteKey,
  capableList,
  pruneBlocks,
  blockMessage,
  blockAnnounce,
} = await import("./blockers.mjs");
const { callTool, asActor, withState, registerCli } = await import("./server.mjs");

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

/* ── the pure contract ─────────────────────────────────────────────────────── */

check("normalizeTerms-lowercases-splits-and-drops-single-letters", () => {
  assert.deepEqual(normalizeTerms("Needs OLLAMA running!"), ["needs", "ollama", "running"]);
  assert.deepEqual(normalizeTerms("a b cc"), ["cc"], "one-letter tokens are noise");
  assert.deepEqual(normalizeTerms(""), []);
  assert.deepEqual(normalizeTerms(null), []);
  assert.deepEqual(normalizeTerms("ollama ollama"), ["ollama"], "deduped");
});

check("matchCapable-finds-declared-granters-and-ranks-by-overlap", () => {
  const agents = [
    { name: "glm", lane: "local", capable: ["ollama", "shell"] },
    { name: "ops", lane: "infra", capable: ["ollama", "access"] },
  ];
  const got = matchCapable("ollama access for a task", agents);
  assert.equal(got.length, 2);
  assert.equal(got[0].name, "ops", "two shared words outrank one");
  assert.deepEqual(got[0].matched.sort(), ["access", "ollama"]);
  assert.ok(got.some((m) => m.name === "glm"), "glm matches on ollama too");
});

check("matchCapable-says-nothing-about-agents-who-declared-nothing", () => {
  const got = matchCapable("stripe access", [
    { name: "shy", lane: "x" },
    { name: "empty", capable: [] },
    { name: "other", capable: ["ollama"] },
  ]);
  assert.deepEqual(got, []);
});

check("matchCapable-on-an-empty-need-matches-nothing", () => {
  assert.deepEqual(matchCapable("", [{ name: "a", capable: ["ollama"] }]), []);
  assert.deepEqual(matchCapable("!!!", [{ name: "a", capable: ["ollama"] }]), []);
});

check("matchFixes-searches-only-fix-notes-and-ranks-best-first", () => {
  const board = [
    { key: "table-pattern", value: "ollama timeouts need a longer predict", at: "2026-01-01" },
    { key: "fix-ollama-timeout", value: "raise predict so the answer is not stranded in thinking", at: "2026-01-02" },
    { key: "fix-ollama-timeout-2", value: "ollama timeout — predict was too small for the thinking plus the answer", at: "2026-01-03" },
    { key: "fix-unrelated", value: "the tree lock was held by a dead session", at: "2026-01-04" },
  ];
  const got = matchFixes("ollama returns empty response", "predict too small", board);
  assert.ok(got.length >= 2 && got.length <= 3, "only overlapping fixes");
  assert.equal(got[0].key, "fix-ollama-timeout-2", "two shared words outrank one");
  assert.ok(got.every((f) => f.key.startsWith("fix-")), "board notes that are not fixes are never offered");
});

check("matchFixes-caps-at-three-a-report-nobody-reads-is-noise", () => {
  const board = Array.from({ length: 8 }, (_, i) => ({
    key: `fix-ollama-${i}`,
    value: "ollama predict timeout thinking",
    at: "2026-01-01",
  }));
  assert.equal(matchFixes("ollama", "timeout", board).length, 3);
});

check("fixNoteKey-is-stable-and-bounded", () => {
  assert.equal(fixNoteKey("Ollama returns empty responses!"), "fix-ollama-returns-empty-responses");
  assert.equal(fixNoteKey("one two three four five six seven eight"), "fix-one-two-three-four-five-six", "six words");
  assert.equal(fixNoteKey(""), "fix-unnamed");
  assert.equal(fixNoteKey("!!!"), "fix-unnamed");
});

check("capableList-trims-dedupes-and-bounds", () => {
  assert.deepEqual(capableList(["Ollama", "ollama ", " STRIPE "]), ["ollama", "stripe"]);
  assert.throws(() => capableList("ollama"), /list of short strings/, "a bare string is a mistake, not one capability");
  assert.throws(() => capableList([]), /at least one/);
  assert.throws(() => capableList(["", "   "]), /at least one/);
  assert.throws(() => capableList(Array.from({ length: 13 }, (_, i) => `c${i}`)), /at most 12/);
  assert.deepEqual(capableList(["x".repeat(41), "ok"]), ["ok"], "an over-long entry is dropped, not fatal");
});

check("pruneBlocks-keeps-every-open-block-and-the-newest-resolved", () => {
  const open = { id: "b1", status: "open" };
  const resolved = Array.from({ length: 60 }, (_, i) => ({ id: `r${i}`, status: "resolved" }));
  const kept = pruneBlocks([open, ...resolved]);
  assert.ok(kept.some((b) => b.id === "b1"), "an open block is never pruned by age");
  assert.equal(kept.filter((b) => b.status !== "open").length, 50, "resolved history capped at 50");
  assert.ok(kept.some((b) => b.id === "r59") && !kept.some((b) => b.id === "r0"), "newest resolved survive");
});

check("pruneBlocks-hard-cap-100-open-blocks-displace-history", () => {
  const opens = Array.from({ length: 80 }, (_, i) => ({ id: `o${i}`, status: "open" }));
  const resolved = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, status: "resolved" }));
  const kept = pruneBlocks([...opens, ...resolved]);
  assert.ok(kept.length <= 100, `bounded (got ${kept.length})`);
  assert.equal(kept.filter((b) => b.status === "open").length, 80, "opens all survive");
});

check("blockMessage-names-the-matcher-reason-and-the-next-step", () => {
  const msg = blockMessage(
    { id: "b7", by: "lane-a", what: "cannot reach stripe", needed: "stripe keys" },
    { name: "ops", matched: ["stripe"] },
  );
  assert.ok(msg.includes("b7") && msg.includes("lane-a"), "names the blocker and the reporter");
  assert.ok(msg.includes("stripe"), "says why you were named");
  assert.ok(msg.includes('unblock("b7"'), "says what to do when handled");
});

check("blockAnnounce-reports-who-was-asked-and-what-was-already-known", () => {
  const asked = blockAnnounce(
    { id: "b1", what: "x" },
    [{ name: "ops", matched: ["ollama"] }],
    [{ key: "fix-ollama", value: "first line of the fix\nsecond line" }],
  );
  assert.ok(asked.includes("Asked ops"), "names the solvers");
  assert.ok(asked.includes("fix-ollama") && asked.includes("first line of the fix"), "hands back the banked fix");
  const alone = blockAnnounce({ id: "b2", what: "y" }, [], []);
  assert.ok(alone.includes("Nobody registered can grant"), "no solver is a valid answer, stated plainly");
  assert.ok(alone.includes("No saved fix"), "and so is no banked fix");
});

/* ── the real-state lifecycle ──────────────────────────────────────────────── */

check("capable-attaches-to-the-registration", () => {
  asActor("glm", () => callTool("register", { name: "glm", lane: "local" }));
  const out = asActor("glm", () => callTool("capable", { capabilities: ["ollama", "shell"] }));
  assert.ok(out.includes("ollama"), "the reply echoes the declaration");
  assert.deepEqual(readState().agents.glm.capable, ["ollama", "shell"]);
});

check("a-restart-keeps-the-declaration-mcp-and-cli-both", () => {
  // MCP re-register: a new session reclaims its name after the stale hour —
  // but with the same SESSION_KEY here, so the reclaim path runs.
  asActor("glm", () => callTool("register", { name: "glm", lane: "local" }));
  assert.deepEqual(readState().agents.glm.capable, ["ollama", "shell"], "MCP register preserves capable");
  // CLI re-announce: registerCli rebuilds the entry entirely.
  registerCli("glm");
  assert.deepEqual(readState().agents.glm.capable, ["ollama", "shell"], "CLI register preserves capable too");
});

check("register-asks-new-agents-what-they-can-grant", () => {
  const out = asActor("newcomer", () => callTool("register", { name: "newcomer", lane: "ui" }));
  assert.ok(out.includes("capable("), "the ask-at-startup line is in the register reply");
});

check("block-messages-the-declared-solver-and-tells-the-reporter-who-was-asked", () => {
  asActor("lane-a", () => callTool("register", { name: "lane-a", lane: "build" }));
  const out = asActor("lane-a", () =>
    callTool("block", { what: "cannot test payments", needed: "stripe access" })
  );
  assert.ok(out.includes("Nobody registered"), "no capable agents yet — and that is stated, not silent");
  asActor("ops", () => callTool("register", { name: "ops", lane: "infra" }));
  asActor("ops", () => callTool("capable", { capabilities: ["stripe", "ollama"] }));
  const out2 = asActor("lane-a", () =>
    callTool("block", { what: "cannot test payments", needed: "stripe access" })
  );
  assert.ok(out2.includes("Asked ops"), "the solver is named back to the reporter");
  const inbox = asActor("ops", () => callTool("inbox", {}));
  assert.ok(inbox.includes("stripe"), "the solver got a message naming why");
  assert.ok(inbox.includes("unblock("), "and the next step");
  assert.ok(inbox.includes("lane-a"), "and who is blocked");
});

check("the-reporter-does-not-get-asked-to-grant-their-own-block", () => {
  // 'zebra' is a capability nobody else in this run declared, so the ONLY
  // possible match is the reporter — self-matching must be filtered for the
  // reply to say nobody. (Order-independent, unlike matching on a word an
  // earlier check already gave someone.)
  asActor("solo", () => callTool("register", { name: "solo", lane: "x" }));
  asActor("solo", () => callTool("capable", { capabilities: ["zebra"] }));
  const out = asActor("solo", () => callTool("block", { what: "zebra blocked", needed: "zebra" }));
  assert.ok(out.includes("Nobody registered"), "self-matching is filtered out");
});

check("block-hands-back-fixes-the-fleet-already-banked", () => {
  asActor("banker", () =>
    callTool("note", {
      key: "fix-ollama-empty",
      value: "when ollama returns empty, predict was too small for thinking plus answer",
    })
  );
  const out = asActor("lane-a", () =>
    callTool("block", { what: "ollama returns empty responses", needed: "longer predict" })
  );
  assert.ok(out.includes("fix-ollama-empty"), "the saved fix is handed back at report time");
  assert.ok(out.includes("predict"), "with its substance, not just the key");
});

check("unblock-banks-the-fix-and-tells-the-reporter", () => {
  const reported = asActor("lane-a", () =>
    callTool("block", { what: "tree lock held by a dead session", needed: "force release" })
  );
  const id = reported.match(/Reported (b\d+)\./)[1];
  const out = asActor("ops", () => callTool("unblock", { id, how: "kill(pid,0) probe; release_tree on stale" }));
  assert.ok(out.includes("banked"), "confirms the banking");
  const s = readState();
  const block = s.blocks.find((b) => b.id === id);
  assert.equal(block.status, "resolved");
  assert.equal(block.resolvedBy, "ops");
  const key = Object.keys(s.board).find((k) => k.startsWith("fix-tree-lock"));
  assert.ok(key, "a fix-… board note exists");
  assert.ok(s.board[key].value.includes("kill(pid,0)"), "carrying what actually worked");
  const inbox = asActor("lane-a", () => callTool("inbox", {}));
  assert.ok(inbox.includes("unblocked"), "the reporter was told");
});

check("the-full-loop-a-second-block-of-the-same-shape-gets-the-banked-fix", () => {
  // The reason unblock() writes a board note at all.
  const out = asActor("lane-a", () =>
    callTool("block", { what: "tree lock held by a dead session again", needed: "force release" })
  );
  assert.ok(out.includes("The fleet has hit this shape before"), "the fleet remembers");
  assert.ok(out.includes("fix-tree-lock"), "by handing back the fix the last unblock banked");
});

check("unblock-refuses-unknown-ids-and-seconds-are-refused", () => {
  assert.throws(() => asActor("ops", () => callTool("unblock", { id: "b999", how: "x" })), /No blocker/);
  const done = readState().blocks.find((b) => b.status === "resolved");
  const again = asActor("ops", () => callTool("unblock", { id: done.id, how: "again" }));
  assert.ok(again.includes("already resolved"), "an already-resolved block is not re-resolved");
});

check("status-carries-a-blockers-section", () => {
  const out = asActor("lane-a", () => callTool("status", {}));
  assert.ok(out.includes("BLOCKERS ("), "the section exists");
  assert.ok(/\d+ open/.test(out), "with the open count");
});

check("resolved-history-is-pruned-but-open-blocks-never-are", () => {
  const s0 = readState();
  s0.blocks.push(
    ...Array.from({ length: 55 }, (_, i) => ({
      id: `old${i}`, by: "ghost", what: "old", needed: "old",
      status: "resolved", resolvedBy: "ghost", resolution: "x", at: "2026-01-01",
    })),
  );
  fs.writeFileSync(path.join(HOME, ".agent-bus", "state.json"), JSON.stringify(s0));
  asActor("lane-a", () => callTool("block", { what: "fresh block", needed: "stripe" }));
  const s = readState();
  assert.ok(s.blocks.length <= 100, `bounded (got ${s.blocks.length})`);
  assert.ok(s.blocks.some((b) => b.what === "fresh block"), "the new block survived");
  assert.ok(s.blocks.filter((b) => b.what === "old").length <= 50, "old resolved history capped");
});

check("blocks-and-board-fixes-never-share-a-key-collision-path", () => {
  // fixNoteKey derives a board key from attacker-ish text; assertKey on note()
  // would reject some of these shapes — make sure the unblock path cannot
  // smuggle a key with a slash or dots past its own slugger.
  for (const nasty of ["../evil", "..\\evil", "a/b", "proto__..x"]) {
    const key = fixNoteKey(nasty);
    assert.match(key, /^fix-[a-z0-9-]*$/, `key for ${JSON.stringify(nasty)} is board-safe`);
  }
});

fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);