/**
 * Harness for the edit protocol.
 *
 * Every case here is a failure that actually happened or a refusal that has to
 * keep working. The happy path is one line of this file; the rest is the part
 * that matters (build rule 19).
 *
 *   node tools/agent-bus/edits-harness.mjs
 */
import { extractEdits, applyEdits, detectEol, toEol, EDIT_PROTOCOL_PROMPT, refuseBusSelfEdit } from "./edits.mjs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

let pass = 0;
const fails = [];

function check(label, fn) {
  try {
    fn();
    pass++;
    console.log(`ok  [${label}]`);
  } catch (e) {
    fails.push(`${label}: ${e.message}`);
    console.log(`FAIL [${label}] ${e.message}`);
  }
}
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
};
const ok = (c, what) => {
  if (!c) throw new Error(what);
};

/* ------------------------- line endings: the big one ------------------------ */

check("crlf-file-lf-edit", () => {
  // THE bug. A Windows checkout is CRLF, the model answers LF, and a byte-exact
  // match misses every multi-line edit for a reason unrelated to the edit.
  const src = "function a(){\r\n  return 1;\r\n}\r\n";
  const r = applyEdits(src, [{ id: "E1", find: "function a(){\n  return 1;\n}", replace: "function a(){\n  return 2;\n}" }]);
  ok(r.ok, `refused a correct edit: ${JSON.stringify(r.problems)}`);
  eq(r.eol, "CRLF", "detected eol");
  eq(r.text, "function a(){\r\n  return 2;\r\n}\r\n", "result stayed CRLF");
});

check("lf-file-crlf-edit", () => {
  const src = "function a(){\n  return 1;\n}\n";
  const r = applyEdits(src, [{ id: "E1", find: "function a(){\r\n  return 1;\r\n}", replace: "function a(){\r\n  return 2;\r\n}" }]);
  ok(r.ok, "refused a correct edit in the other direction");
  eq(r.text.includes("\r"), false, "a LF file must not gain CR");
});

check("eol-detect-mixed", () => {
  // A file that is mostly CRLF with a stray LF is still a CRLF file.
  eq(detectEol("a\r\nb\r\nc\r\nd\ne\r\n"), "CRLF", "mostly-CRLF");
  eq(detectEol("a\nb\nc\nd\r\ne\n"), "LF", "mostly-LF");
  eq(detectEol("no newlines at all"), "LF", "no newlines defaults to LF");
});

check("eol-roundtrip-idempotent", () => {
  // toEol must not double up CRs when it is handed text already in the target
  // convention — run twice, same answer.
  const s = "a\r\nb\r\n";
  eq(toEol(toEol(s, "CRLF"), "CRLF"), s, "CRLF twice");
  eq(toEol(s, "LF"), "a\nb\n", "down to LF");
});

/* ------------------------------- refusals --------------------------------- */

check("refuse-missing", () => {
  const src = "const x = 1;\n";
  const r = applyEdits(src, [{ id: "E1", find: "const y = 2;", replace: "const y = 3;" }]);
  ok(!r.ok, "a `find` that is not there must be refused");
  eq(r.text, src, "the file must be handed back untouched");
});

check("refuse-ambiguous", () => {
  const src = "let a=0;\nlet b=0;\nlet c=0;\n";
  const r = applyEdits(src, [{ id: "E1", find: "=0;", replace: "=1;" }]);
  ok(!r.ok, "three matches must be refused, not applied to the first");
  ok(/matches 3 places/.test(r.problems[0].why), `should say how many: ${r.problems[0].why}`);
  eq(r.text, src, "unchanged");
});

check("refuse-noop", () => {
  const r = applyEdits("x\n", [{ id: "E1", find: "x", replace: "x" }]);
  ok(!r.ok, "find===replace is a model padding its answer, not an edit");
});

check("refuse-nonstring", () => {
  const r = applyEdits("x\n", [{ id: "E1", find: 12, replace: "y" }]);
  ok(!r.ok, "a non-string find must be refused, not coerced");
});

check("all-or-nothing", () => {
  // The one that keeps a bad batch from leaving a half-edited file behind.
  const src = "alpha\nbeta\ngamma\n";
  const r = applyEdits(src, [
    { id: "E1", find: "alpha", replace: "ALPHA" },
    { id: "E2", find: "nowhere", replace: "x" },
    { id: "E3", find: "gamma", replace: "GAMMA" },
  ]);
  ok(!r.ok, "one bad edit fails the batch");
  eq(r.applied.length, 2, "the good ones still report, so you can see what would have landed");
  eq(r.text, src, "but NOTHING is written");
});

check("every-problem-reported", () => {
  // Report all of them at once. Fixing a batch one refusal per round-trip is
  // how a two-minute cloud call becomes twenty.
  const r = applyEdits("a\na\n", [
    { id: "E1", find: "zzz", replace: "y" },
    { id: "E2", find: "a", replace: "b" },
  ]);
  eq(r.problems.length, 2, "both problems");
});

/* ---------------------------- near-miss diagnosis -------------------------- */

check("diagnose-indentation", () => {
  const src = "if(x){\n    doThing();\n}\n";
  const r = applyEdits(src, [{ id: "E1", find: "if(x){\ndoThing();\n}", replace: "if(x){\ndoOther();\n}" }]);
  ok(!r.ok, "must refuse");
  ok(/indentation is ignored/.test(r.problems[0].why), `should blame indentation, said: ${r.problems[0].why}`);
});

check("diagnose-interior-spacing", () => {
  const src = "const a = 1;\n";
  const r = applyEdits(src, [{ id: "E1", find: "const a=1;", replace: "const a=2;" }]);
  ok(!r.ok, "must refuse");
  ok(/spacing inside a line/.test(r.problems[0].why), `should blame interior spacing, said: ${r.problems[0].why}`);
});

check("diagnose-says-nothing-when-truly-absent", () => {
  // The failure mode of a diagnostic is confidently naming the wrong cause.
  // When the text simply is not there, say only that.
  const r = applyEdits("const a = 1;\n", [{ id: "E1", find: "completelyUnrelated()", replace: "x" }]);
  eq(r.problems[0].why, "`find` not present", "no speculation when there is no near miss");
});

/* --------------------------- what must survive ----------------------------- */

check("non-ascii-untouched", () => {
  // A whole-file rewrite mangled these once. Edits must not.
  const src = "const s = 'em — dash, ◆ glyph, → arrow, é';\nconst t = 1;\n";
  const r = applyEdits(src, [{ id: "E1", find: "const t = 1;", replace: "const t = 2;" }]);
  ok(r.ok, "should apply");
  ok(r.text.includes("em — dash, ◆ glyph, → arrow, é"), "every glyph survives byte-for-byte");
});

check("sequential-offsets", () => {
  // A later edit whose anchor sits after an earlier, longer replacement must
  // still resolve: positions are resolved on the original and spliced
  // right-to-left, so a widening replacement above never shifts anything.
  const src = "one\ntwo\nthree\n";
  const r = applyEdits(src, [
    { id: "E1", find: "one", replace: "a much longer first line" },
    { id: "E2", find: "three", replace: "3" },
  ]);
  ok(r.ok, `both should apply: ${JSON.stringify(r.problems)}`);
  eq(r.text, "a much longer first line\ntwo\n3\n", "both landed in the right places");
});

check("replacement-containing-find", () => {
  // Wrapping a line in something that still contains it must not re-match.
  const src = "call();\n";
  const r = applyEdits(src, [{ id: "E1", find: "call();", replace: "if(ok) call();" }]);
  ok(r.ok, "should apply");
  eq(r.text, "if(ok) call();\n", "applied exactly once");
});

/* --------------------------- overlap semantics ------------------------------ */
// A batch is one snapshot of the file, not a sequence of rewrites.

check("overlap-refused", () => {
  // Two edits claiming ground that overlaps. Sequentially applied, the first
  // would silently decide what the second could still see; now both are named
  // and nothing is written.
  const src = "abcdef\n";
  const r = applyEdits(src, [
    { id: "E1", find: "abcd", replace: "X" },
    { id: "E2", find: "cdef", replace: "Y" },
  ]);
  ok(!r.ok, "overlapping edits must be refused");
  ok(/overlaps edit E2/.test(r.problems[0].why), `E1 should name its collision: ${r.problems[0].why}`);
  ok(/overlaps edit E1/.test(r.problems[1].why), "E2 should name its collision too");
  eq(r.text, src, "nothing written");
  eq(r.applied.length, 0, "neither half of a collision reads as resolved");
});

check("a-find-an-earlier-edit-would-create-is-refused", () => {
  // The dangerous half of the old semantics: E2's `find` exists NOWHERE in the
  // file, but E1's replacement manufactures it — applied in order, E2 landed.
  // Now it is refused, because finds are judged against the file as it stands.
  const src = "A\nB\n";
  const r = applyEdits(src, [
    { id: "E1", find: "A\nB", replace: "A\nB\nC" },
    { id: "E2", find: "B\nC", replace: "D" },
  ]);
  ok(!r.ok, "a find the earlier edit creates must not become applicable");
  ok(/not present/.test(r.problems[0].why), `E2 should read as absent: ${r.problems[0].why}`);
  eq(r.text, src, "nothing written");
});

check("touching-but-not-overlapping-both-apply", () => {
  const src = "abcd";
  const r = applyEdits(src, [
    { id: "E1", find: "ab", replace: "AB" },
    { id: "E2", find: "cd", replace: "CD" },
  ]);
  ok(r.ok, `adjacent ranges are fine: ${JSON.stringify(r.problems)}`);
  eq(r.text, "ABCD", "both landed");
});

check("same-find-twice-is-a-collision", () => {
  // Two edits with an identical `find` resolve to the same range; the overlap
  // refusal is what catches it, because each is unique on its own.
  const src = "x\n";
  const r = applyEdits(src, [
    { id: "E1", find: "x", replace: "y" },
    { id: "E2", find: "x", replace: "z" },
  ]);
  ok(!r.ok, "two edits on the same ground must be refused");
  ok(/overlaps/.test(r.problems[0].why), `should blame the overlap: ${r.problems[0].why}`);
});

check("batch-order-does-not-change-the-result", () => {
  // The property the whole rework buys: the same two edits in either order
  // produce the same file, because nothing is judged against a shifting text.
  const editsA = [
    { id: "E1", find: "one", replace: "1" },
    { id: "E2", find: "three", replace: "3" },
  ];
  const editsB = [editsA[1], editsA[0]];
  const src = "one\ntwo\nthree\n";
  eq(applyEdits(src, editsA).text, "1\ntwo\n3\n", "forward order");
  eq(applyEdits(src, editsB).text, "1\ntwo\n3\n", "reversed order — same file");
});

/* ------------------------------- extraction -------------------------------- */

check("extract-bare", () => {
  eq(extractEdits('[{"id":"E1","find":"a","replace":"b"}]').length, 1, "bare array");
});

check("extract-fenced", () => {
  const raw = '```json\n[{"id":"E1","find":"a","replace":"b"}]\n```';
  eq(extractEdits(raw)[0].id, "E1", "models fence it however firmly you ask them not to");
});

check("extract-fenced-unlabelled", () => {
  eq(extractEdits('```\n[{"id":"E1","find":"a","replace":"b"}]\n```')[0].id, "E1", "unlabelled fence");
});

check("extract-buried-in-prose", () => {
  const raw = 'Sure! Here are the edits:\n[{"id":"E1","find":"a","replace":"b"}]\nLet me know if you need more.';
  eq(extractEdits(raw)[0].find, "a", "chattier models bury it in a sentence");
});

check("extract-refuses-garbage", () => {
  let threw = false;
  try { extractEdits("I could not do that, sorry."); } catch { threw = true; }
  ok(threw, "prose with no array must throw, not return nothing quietly");
});

check("extract-refuses-empty-array", () => {
  let threw = false;
  try { extractEdits("[]"); } catch { threw = true; }
  ok(threw, "an empty batch means the model did no work — say so");
});

check("extract-refuses-empty-response", () => {
  // What a thinking model returns when num_predict ran out mid-reasoning.
  let threw = false;
  try { extractEdits(""); } catch { threw = true; }
  ok(threw, "empty response must throw");
});

/* -------------------------------- the prompt ------------------------------- */

check("protocol-prompt-states-the-rules", () => {
  for (const must of ["EXACTLY ONCE", "byte-for-byte", "non-ASCII", "no markdown fence"]) {
    ok(EDIT_PROTOCOL_PROMPT.includes(must), `the preamble must still say "${must}" — each line is a failure that happened`);
  }
});

/* ------------------------------ self-edit guard ---------------------------- */

// The bus must never be the mechanism that rewrites the bus. A board note is
// untrusted data, and "update the bus to fix X" is exactly the instruction
// such data would carry at an agent able to drive the edit protocol. The
// person changes the bus by hand, deliberately.
const BUS_DIR = path.join(os.tmpdir(), "agent-bus-guard-example", "tools", "agent-bus");

check("a target inside the bus's own directory is refused", () => {
  ok(refuseBusSelfEdit(path.join(BUS_DIR, "server.mjs"), BUS_DIR), "direct child refused");
  ok(refuseBusSelfEdit(path.join(BUS_DIR, "sub", "deep.mjs"), BUS_DIR), "nested child refused");
  eq(refuseBusSelfEdit(path.join(BUS_DIR, "..", "src", "thing.ts"), BUS_DIR), null, "outside the bus is fine");
});

check("the refusal survives resolution games", () => {
  // ".." traversal back into the bus, and Windows case-folding: a guard beaten
  // by "TOOLS" vs "tools" protects nothing.
  ok(
    refuseBusSelfEdit(path.join(BUS_DIR, "..", path.basename(BUS_DIR), "hub.mjs"), BUS_DIR),
    ".. and back in refused",
  );
  if (process.platform === "win32") {
    ok(
      refuseBusSelfEdit(BUS_DIR.toLowerCase() + path.sep + "hub.mjs", BUS_DIR.toUpperCase()),
      "case-folded comparison",
    );
  }
});

check("the CLI enforces the guard before it reads anything", () => {
  // Wiring, not logic — the pure refusal is checked above; this proves the
  // entry point calls it, and calls it FIRST: --in does not even exist here,
  // yet the answer is the refusal, not a read error. The target is the bus's
  // own edits.mjs — the real thing the guard exists to refuse.
  const out = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "edits.mjs"), "--in", "x", "--file", path.join(import.meta.dirname, "edits.mjs")],
    { encoding: "utf8" },
  );
  ok(out.status === 1, `exit 1, got ${out.status}`);
  ok(String(out.stderr).includes("REFUSED"), "says why");
});

/* ---------------------------------- report --------------------------------- */

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ${f}`);
  process.exit(1);
}
console.log("DONE");
