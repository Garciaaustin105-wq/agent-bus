/**
 * The edit protocol: how the hub gets code OUT of a model without letting the
 * model rewrite the file.
 *
 * A model is asked for a JSON array of {id, find, replace}. Each `find` must
 * match the target EXACTLY ONCE. Zero matches or two matches is a refusal, not
 * a guess (build rule 10), two edits may not claim overlapping ground, and
 * nothing is written unless every edit resolves — a half-applied batch is
 * worse than none.
 *
 * WHY NOT JUST ASK FOR THE FILE. We did, once. A whole-file rewrite came back
 * with its UTF-8 mangled — em dashes and glyphs
 * silently replaced. Models also quietly reformat, reorder and drop code they
 * were not asked to touch, and nothing in a 5,000-line diff tells you which
 * changes were the ones you asked for. Edits make the blast radius the size of
 * the request.
 *
 * Pure on purpose: applyEdits takes strings and returns strings, so the
 * harness runs it without a repo, a model or a network (build rule 2).
 *
 * SELF-EDIT REFUSAL. The bus never edits its own code: a target inside the
 * directory this file lives in is refused before anything is read, dry run
 * included. The person changes the bus by hand, deliberately — not through an
 * edit batch an agent may have been talked into (a board note is untrusted
 * data, and "update the bus" is exactly the instruction such data would
 * carry). AGENT_BUS_ALLOW_SELF_EDIT=1 is the maintainer's explicit override.
 *
 * CLI:
 *   node tools/agent-bus/edits.mjs --in out.json --file src/thing.ts --dry
 *   node tools/agent-bus/edits.mjs --in out.json --file src/thing.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The preamble that gets a model to answer in this protocol.
 *
 * Deliberately dense. This is machine-to-machine: the model needs the contract
 * and the anchors, not prose framing, and every sentence of politeness is
 * tokens spent on both the send and (for a thinking model) the reasoning that
 * chews on it.
 *
 * Every line here is a failure that actually happened:
 *  - "byte-for-byte"        a model retyped indentation and nothing matched
 *  - "EXACTLY ONCE"         a one-line `find` hit 14 places
 *  - "non-ASCII exactly"    em dashes came back as hyphens, glyphs as '?'
 *  - "do not reformat"      a model reflowed a whole function it was not asked about
 *  - "omit rather than"     models emit find===replace no-ops to look complete
 */
export const EDIT_PROTOCOL_PROMPT = [
  "Output EDITS ONLY. Do NOT output the file.",
  "",
  "Format: one JSON array, nothing before or after it, no markdown fence.",
  'Element: {"id":"E1","find":"<exact text now in the file>","replace":"<exact text to put there>"}',
  "Rules:",
  "- `find` copied byte-for-byte from the CONTEXT below, including indentation.",
  "- `find` must occur EXACTLY ONCE in the file. Not unique? Include surrounding",
  "  lines until it is.",
  "- Keep every non-ASCII character exactly as it appears. Do not normalise",
  "  dashes, arrows or glyphs.",
  "- Do not reformat, re-indent or re-order anything the spec did not ask for.",
  "- One element per edit id in the spec. Already correct in the file? Omit it",
  "  rather than emitting a no-op.",
].join("\n");

/**
 * Pull the JSON array out of whatever the model actually said.
 *
 * Models fence JSON however firmly you ask them not to, and chattier ones bury
 * it in a sentence. Both are recoverable and neither is worth a re-run, so
 * recover them. Anything else throws — a malformed batch must not be guessed at.
 */
export function extractEdits(raw) {
  let text = String(raw ?? "").trim();

  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();

  if (text[0] !== "[") {
    const a = text.indexOf("[");
    const b = text.lastIndexOf("]");
    if (a !== -1 && b > a) text = text.slice(a, b + 1);
  }

  let edits;
  try {
    edits = JSON.parse(text);
  } catch (e) {
    throw new Error(`the model's output is not JSON: ${e.message}`);
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("expected a non-empty JSON array of {id,find,replace}");
  }
  return edits;
}

/**
 * Line endings are their own failure, and they look like a different one.
 *
 * Windows checkouts are CRLF. Models answer in LF no matter what you send
 * them, so a byte-exact `find` misses EVERY multi-line edit for a reason that
 * has nothing to do with the edit being right. The first time this happened I
 * read the near-miss as retyped indentation and said so out loud — the
 * whitespace-squash comparison that produced that diagnosis collapses \r\n and
 * \n identically, so it could not tell the two apart. Hence: normalise to the
 * FILE's convention before matching, and keep the two diagnostics separate.
 */
export function detectEol(src) {
  const crlf = (src.match(/\r\n/g) || []).length;
  const lines = src.split("\n").length - 1;
  return crlf > lines / 2 ? "CRLF" : "LF";
}

export function toEol(s, eol) {
  const lf = s.replace(/\r\n/g, "\n");
  return eol === "CRLF" ? lf.replace(/\n/g, "\r\n") : lf;
}

/**
 * Apply a batch. Returns { ok, text, eol, applied, problems } and never throws
 * on a bad batch — a refusal is a result, not an exception, because the caller
 * wants to report every problem at once rather than the first one.
 *
 * `text` is the original, unchanged, whenever ok is false.
 *
 * ONE SNAPSHOT, NOT A SEQUENCE. Every `find` is resolved against the file AS IT
 * STANDS, never against a string an earlier edit has already shifted. Applied
 * in order against a shifting text, two things could happen that no spec
 * reader could predict: a `find` that never existed in the file became
 * applicable because an earlier edit's replacement manufactured it, and one
 * that DID exist got refused because an earlier edit consumed it. Both outcomes
 * depended on array order. Resolving against the original, refusing any two
 * edits whose ranges overlap, then splicing right-to-left gives every edit the
 * same question and the same answer regardless of where it sits in the batch.
 */
export function applyEdits(src, edits) {
  const eol = detectEol(src);
  const problems = [];
  const resolved = [];

  edits.forEach((e, i) => {
    const id = e?.id || `#${i + 1}`;
    if (typeof e?.find !== "string" || typeof e?.replace !== "string") {
      problems.push({ id, why: "needs string `find` and `replace`" });
      return;
    }
    if (e.find === e.replace) {
      problems.push({ id, why: "find and replace are identical (no-op)" });
      return;
    }

    const find = toEol(e.find, eol);
    const replace = toEol(e.replace, eol);

    let n = 0;
    let at = -1;
    for (let from = 0; ; ) {
      const k = src.indexOf(find, from);
      if (k === -1) break;
      n++;
      if (at === -1) at = k;
      from = k + 1;
    }

    if (n === 0) {
      problems.push({ id, why: `\`find\` not present${nearMiss(src, find)}`, head: firstLine(find) });
      return;
    }
    if (n > 1) {
      problems.push({ id, why: `\`find\` matches ${n} places — not unique, needs more surrounding context`, head: firstLine(find) });
      return;
    }

    resolved.push({
      id,
      at,
      find,
      replace,
      line: src.slice(0, at).split("\n").length,
      delta: replace.length - find.length,
    });
  });

  // Overlap: two edits claiming the same ground. Sorted by position, any edit
  // that starts before the previous one ends is a collision, and BOTH are
  // refused — the batch is all-or-nothing, so keeping one half of a collision
  // would be silently rewriting what the spec asked for.
  const placed = resolved.slice().sort((a, b) => a.at - b.at);
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1];
    const cur = placed[i];
    if (cur.at < prev.at + prev.find.length) {
      const why = (other) =>
        `\`find\` overlaps edit ${other}'s range — edits must not overlap; widen one \`find\` to cover both, or split the batch`;
      // Both halves leave the applied list, whichever side of the sort each
      // sat on.
      prev.overlap = prev.overlap ?? cur.id;
      cur.overlap = cur.overlap ?? prev.id;
      if (!problems.some((p) => p.id === prev.id)) problems.push({ id: prev.id, why: why(cur.id) });
      if (!problems.some((p) => p.id === cur.id)) problems.push({ id: cur.id, why: why(prev.id) });
    }
  }

  const ok = problems.length === 0;
  const applied = resolved
    .filter((r) => !r.overlap)
    .map(({ id, line, delta }) => ({ id, line, delta }));
  let out = src;
  if (ok) {
    // Right to left, so no edit's position ever moves under it. This is the
    // same all-or-nothing batch as before — only the bookkeeping changed.
    for (let i = placed.length - 1; i >= 0; i--) {
      const r = placed[i];
      out = out.slice(0, r.at) + r.replace + out.slice(r.at + r.find.length);
    }
  }
  return { ok, text: ok ? out : src, eol, applied, problems };
}

/**
 * Say WHY a `find` missed, precisely.
 *
 * A near miss on leading whitespace and a near miss on interior spacing need
 * different fixes, and guessing between them sends you to the wrong one. Test
 * them separately and in that order — indentation is both the more common
 * cause and the more specific claim, so it must be checked first or the
 * looser test claims every case.
 */
function nearMiss(src, find) {
  const flat = src.replace(/\r\n/g, "\n");
  const target = find.replace(/\r\n/g, "\n");
  const noIndent = (s) => s.split("\n").map((l) => l.trim()).join("\n");
  // STRIP whitespace, do not squash it. Squashing collapses runs to one space,
  // so `const a=1;` still never matches `const a = 1;` — which is the exact
  // case this test exists to catch. The harness caught that.
  const bare = (s) => s.replace(/\s+/g, "");

  if (noIndent(flat).includes(noIndent(target))) {
    return " — matches once indentation is ignored, so the leading whitespace was retyped";
  }
  if (bare(flat).includes(bare(target))) {
    return " — matches ignoring all whitespace, so spacing inside a line differs";
  }
  return "";
}

const firstLine = (s) => s.split(/\r?\n/)[0].slice(0, 100);

/** Format a result for a human or a log. */
export function formatResult(r, total) {
  const out = [];
  for (const a of r.applied) {
    out.push(`  ok     ${String(a.id).padEnd(5)} line ${String(a.line).padEnd(6)} ${a.delta >= 0 ? "+" : ""}${a.delta} chars`);
  }
  for (const p of r.problems) {
    out.push(`  REFUSE ${p.id}: ${p.why}` + (p.head ? `\n         ${p.head}` : ""));
  }
  if (!r.ok) {
    out.push("");
    out.push(`${r.problems.length} of ${total} edits did not resolve — nothing written.`);
    out.push("Fix the batch or re-run the spec; a partial apply is worse than none.");
  }
  return out.join("\n");
}

/* ----------------------------- self-edit guard ---------------------------- */

/** The bus does not edit itself. A target inside the directory this file lives
 *  in is refused before anything is read — agents coordinate work in the
 *  PROJECT, and the person changes the bus by hand, deliberately, never
 *  through an edit batch an agent may have been talked into. Pure on the same
 *  rule as applyEdits: takes paths, returns a refusal message or null, no
 *  filesystem. The comparison is case-folded on Windows because NT paths are
 *  case-insensitive and "TOOLS" vs "tools" must not slip past a guard. */
export function refuseBusSelfEdit(targetPath, busDir) {
  const target = path.resolve(String(targetPath ?? ""));
  const home = path.resolve(String(busDir ?? ""));
  const fold = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const t = fold(target);
  const h = fold(home);
  if (t === h || t.startsWith(h + path.sep)) {
    return (
      `REFUSED: the bus does not edit its own code — ${target} is inside ` +
      `${home}. The person changes the bus by hand, deliberately, never ` +
      `through an edit batch. (Maintainer override: AGENT_BUS_ALLOW_SELF_EDIT=1.)`
    );
  }
  return null;
}

/* ---------------------------------- CLI ---------------------------------- */

// pathToFileURL, not a pathname regex: URL.pathname keeps percent-escapes, so
// an install path containing a space ("My Projects") carried %20 and this
// comparison silently failed — the CLI then did NOTHING, exit 0. A silent
// no-op on a valid path is worse than a stack trace on a bad one.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? d : argv[i + 1];
  };
  const dry = argv.includes("--dry");
  const inPath = arg("in");
  const filePath = arg("file");

  if (!inPath || !filePath) {
    console.error("usage: node tools/agent-bus/edits.mjs --in <model-output> --file <target> [--dry]");
    process.exit(1);
  }

  // The self-edit guard fires before anything is read — fail fast. A --dry
  // run of a bus-targeted batch is still a refusal: the boundary is the
  // target, not the write.
  if (process.env.AGENT_BUS_ALLOW_SELF_EDIT !== "1") {
    const refusal = refuseBusSelfEdit(filePath, import.meta.dirname);
    if (refusal) {
      console.error(refusal);
      process.exit(1);
    }
  }

  let edits;
  try {
    edits = extractEdits(fs.readFileSync(inPath, "utf8"));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const src = fs.readFileSync(filePath, "utf8");
  const r = applyEdits(src, edits);
  console.log(formatResult(r, edits.length));

  if (!r.ok) process.exit(1);
  if (dry) {
    console.log(`\ndry run: ${r.applied.length} edits all resolve cleanly (${r.eol}). Re-run without --dry to write.`);
    process.exit(0);
  }

  fs.writeFileSync(filePath, r.text);
  console.log(`\n${r.applied.length} edits written to ${path.basename(filePath)} (${src.length} -> ${r.text.length} chars, ${r.eol})`);
}
