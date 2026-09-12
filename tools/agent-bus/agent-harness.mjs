// The hub agent's harness — pure-function tests, no state files, no bus.
// Run: node tools/agent-bus/agent-harness.mjs   (exit 0 = all green)

import {
  tokenize,
  parseRulebook,
  buildFixIndex,
  findFixes,
  classify,
  fixReply,
  statusAnswer,
  registryQuestionText,
  registryKeyFor,
  dispatch,
} from "./agent.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = typeof want === "function" ? want(got) : got === want;
  if (ok) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${typeof want === "function" ? "(predicate failed)" : JSON.stringify(want)}`);
  }
}

/* ── tokenize ── */

const t = tokenize("The safety classifier is DOWN, so Write calls fail!");
check("tokenize lowercases + strips punctuation", t.has("classifier") && t.has("down"), true);
check("tokenize drops stopwords", t.has("the") || t.has("so"), false);
check("tokenize drops <3 chars", tokenize("be a to ok no").size, 0);

/* ── parseRulebook (against the REAL rulebook — the hub must parse it) ── */

const markdown = readFileSync(
  fileURLToPath(new URL("../../docs/build-rules.md", import.meta.url)),
  "utf8"
);
const rules = parseRulebook(markdown);
check("real rulebook: every rule parsed", rules.length >= 20, true);
check("real rulebook: G1 asking exists", rules.some((r) => r.id === "G1" && /ask/i.test(r.title)), true);
check("real rulebook: H1 context budget exists", rules.some((r) => r.id === "H1" && /context/i.test(r.title)), true);
// In the hub copy the asking rules are G1/G2 — the classifier outage lives in G1.
check("real rulebook: incident text kept in body",
  rules.some((r) => r.id === "G1" && /classifier/.test(r.body)), true);
// The duplicate-G1 bug must never come back: ids are unique.
const ids = rules.map((r) => r.id);
check("real rulebook: rule ids unique", new Set(ids).size, ids.length);

/* ── buildFixIndex + findFixes ── */

const board = {
  "rulebook-duplicate-g-ids": {
    value:
      "MISTAKE FOUND AND FIXED 2026-09-09. WHAT: when G became asking-for-help, the context-budget rule headers kept the old G1-G6 ids — two G1s in one rulebook. FIX: renamed to H1-H6. LESSON: sweep the rule ids and every cross-reference.",
    by: "claude-extract",
    at: "2026-09-09T00:00:00Z",
  },
  "unrelated-plant-note": { value: "pricing estimates look right", by: "x", at: "2026-09-01T00:00:00Z" },
};
const index = buildFixIndex({ board, rules });
check("index: board + rules both present",
  index.length === Object.keys(board).length + rules.length, true);

const blockReport =
  "BLOCKED: my rulebook has two rules both named G1 and G2 and my edits keep " +
  "citing the wrong one — the ids collided after re-lettering a section.";
// Board-only: the property under test is that a MATCHING note outranks a
// non-matching one. Scored against the live rulebook it instead asserts that
// no rule anybody writes later will ever score higher — which section L broke
// within a day, in a docs-only commit.
const rankIndex = buildFixIndex({ board, rules: [] });
const hits = findFixes(blockReport, rankIndex);
check("findFixes: the matching note comes back first", hits[0]?.id, "rulebook-duplicate-g-ids");
check("findFixes: matched >= 2 distinct tokens", hits[0]?.score >= 2, true);
check("findFixes: unrelated note NOT in hits",
  hits.some((h) => h.id === "unrelated-plant-note"), false);

const outageReport =
  "stalled — the safety classifier is unavailable and timed out, shell and " +
  "write calls are denied. I retried six times.";
const outageHits = findFixes(outageReport, index);
check("findFixes: rulebook G1 (classifier incident) matches an outage report",
  outageHits.some((h) => h.kind === "rule" && h.id === "G1"), true);

// These three assert what the MATCHER does with a query that shares too little
// with the corpus. Run against the live index they would instead assert what
// today’s rulebook happens to contain: writing a rule with the words "note"
// and "board" in it made "please note the board" score 2 — correctly — and
// broke this file for the person editing the docs. Fixed corpus, fixed meaning.
const closedIndex = buildFixIndex({
  board: { "unrelated-plant-note": board["unrelated-plant-note"] },
  rules: [],
});
// `index` (live rulebook) is still built above and still used by the parse
// checks and the G1 outage check — the two assertions that are ABOUT the real
// corpus rather than about the matcher.
check("findFixes: near-empty message finds nothing", findFixes("hello", closedIndex).length, 0);
check("findFixes: one weak shared word is not enough",
  findFixes("please note the board", closedIndex, { minScore: 2 }).length, 0);
check("findFixes: nothing in common finds nothing",
  findFixes("what is the meaning of life", closedIndex).length, 0);

/* ── classify ── */

check("classify: block report", classify("we are stuck, the lock was refused"), "block");
check("classify: outage wording", classify("glm timed out, calls are denied"), "block");
check("classify: status question", classify("what's next on the board?"), "status");
check("classify: status by name", classify("hub status"), "status");
check("classify: registry answer is other", classify("I have playwright, need vercel access"), "other");
check("classify: chatter is other", classify("thanks, that worked"), "other");

/* ── fixReply ── */

const withHit = fixReply(blockReport, rankIndex);
check("fixReply: names the saved note", withHit.includes("rulebook-duplicate-g-ids"), true);
check("fixReply: offers the board path when nothing matches",
  fixReply("what is the meaning of life", index).includes("board note"), true);

/* ── statusAnswer — pure over state, no withState ── */

// Lock timestamps are relative to NOW — describeLock honours the TTL, and a
// hard-coded "00:00 today" reads as expired by the time the harness runs.
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const state = {
  agents: { glm: { lane: "desktop-pass", lastSeen: minsAgo(1) }, hub: { lane: null, lastSeen: null } },
  lock: { path: "/repo", holder: "glm", reason: "mid-edit", claimedAt: minsAgo(2), expiresAt: new Date(Date.now() + 30 * 60000).toISOString() },
  board,
  tasks: [{ status: "queued" }, { status: "done" }, { status: "queued" }],
};
const status = statusAnswer(state);
check("statusAnswer: counts + agents + lock + board",
  /HUB STATUS/.test(status) && /glm/.test(status) && /mid-edit/.test(status) && /rulebook-duplicate-g-ids/.test(status), true);
check("statusAnswer: queued tasks counted", (status.match(/2 queued task/) ?? []).length, 1);

/* ── registry ── */

check("registry question names the agent", registryQuestionText("glm").includes("glm"), true);
check("registry key shape", registryKeyFor("glm"), "registry-glm");

/* ── dispatch ── */

check("dispatch: block → reply, no note",
  dispatch(blockReport, rankIndex, state).reply?.includes("rulebook-duplicate-g-ids") ?? false, true);
check("dispatch: status → reply", (dispatch("what's next", index, state).reply ?? "").includes("HUB STATUS"), true);
check("dispatch: chatter → quiet",
  dispatch("thanks, that worked", index, state).reply, null);

/* ── no model, no auto-apply invariants ── */

const agentSource = readFileSync(
  fileURLToPath(new URL("./agent.mjs", import.meta.url)),
  "utf8"
);
check("phase 0: no model call in agent.mjs",
  /askOllama|askRunner|askShell/.test(agentSource), false);
check("phase 0: no git or file-writing beyond bus state",
  /execFileSync\(\s*"git"|writeFileSync\((?!tmp)/.test(agentSource), false);

console.log(`\nagent-harness: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;