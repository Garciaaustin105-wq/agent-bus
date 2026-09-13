/**
 * Harness for the cross-install learning seam — the scrub, the lesson build,
 * the feed parse. All pure: no network, no disk, no model (build rule 2).
 *
 * The failures being pinned are the ones this seam must never have: a real
 * path or name surviving the scrub, a URL mangled into <path>://<path>, a
 * malformed or oversized feed being partially rendered, and — the one that
 * matters most — untrusted lesson text being rendered as anything but labelled
 * data.
 *
 *   node tools/agent-bus/lessons-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import {
  buildIssueUrl,
  buildLesson,
  fetchFeed,
  parseFeed,
  renderFeed,
  scrubToProblemShape,
  stripControlChars,
} from "./lessons.mjs";

let pass = 0;
const fails = [];
// Async-friendly: a check that returns a promise is awaited, so a rejection
// is a FAIL and not an unhandled one the exit code never sees.
const checks = [];
function check(label, fn) {
  checks.push(
    Promise.resolve()
      .then(fn)
      .then(() => {
        pass++;
        console.log(`ok  [${label}]`);
      })
      .catch((e) => {
        fails.push(`${label}: ${e.message}`);
        console.log(`FAIL [${label}] ${e.message}`);
      })
  );
}
const rejects = async (fn, why) => {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`expected a refusal: ${why}`);
};

/* ------------------------------ the scrub -------------------------------- */

check("scrub-windows-paths", () => {
  const out = scrubToProblemShape("claim C:\\Users\\me\\Projects\\secret-repo first");
  assert.ok(!out.includes("secret-repo"), "the path is gone");
  assert.ok(out.includes("<path>"), `replaced: ${out}`);
});

check("scrub-posix-paths", () => {
  const out = scrubToProblemShape("read /home/dev/secret/notes.md first");
  assert.ok(!out.includes("secret"), "the path is gone");
  assert.ok(out.includes("<path>"), `replaced: ${out}`);
});

check("scrub-unc-paths", () => {
  // A UNC path names an internal share — neither the drive rule nor the POSIX
  // rule used to match it, so \\host\share\secrets survived the scrub whole.
  const win = scrubToProblemShape("the build ran from \\\\fileserver.internal\\eng\\secrets");
  assert.ok(!win.includes("fileserver"), "the host is gone");
  assert.ok(!win.includes("secrets"), "the share is gone");
  assert.ok(win.includes("<path>"), `replaced: ${win}`);
  const posix = scrubToProblemShape("mount //nas.local/private/staging first");
  assert.ok(!posix.includes("nas.local"), "the forward-slash UNC host is gone");
  assert.ok(posix.includes("<path>"), `replaced: ${posix}`);
});

check("scrub-urls-before-paths-or-they-mangle", () => {
  // URL rule first: otherwise the path rule eats the URL's slashes and every
  // scrubbed lesson reads as <path>://<path>.
  const out = scrubToProblemShape("see https://example.com/private/policy?id=7");
  assert.equal(out, "see <url>", `no path-inside-a-url mangling: ${out}`);
  assert.doesNotMatch(out, /example\.com/, "the host is gone too");
});

check("scrub-emails", () => {
  assert.equal(scrubToProblemShape("ping a@b.co"), "ping <email>");
});

check("scrub-project-basename", () => {
  const out = scrubToProblemShape("the lowvoltage-app bus carries this", "lowvoltage-app");
  assert.ok(!out.includes("lowvoltage-app"), "the project's name is gone");
  assert.ok(out.includes("<project>"), `replaced: ${out}`);
});

check("scrub-leaves-problem-shape-alone", () => {
  // The whole point: the LESSON survives. Only what names a place, a host or
  // a person is removed.
  const out = scrubToProblemShape("a `find` matching 3 places must be refused, not applied to the first");
  assert.equal(out, "a `find` matching 3 places must be refused, not applied to the first", "a clean rule needs no scrubbing");
});

/* --------------------------- building the lesson -------------------------- */

check("lesson-key-is-scrubbed-too", () => {
  // The key travels with the lesson and a key is free text someone typed, so
  // it goes through the same scrub as the body: paths, emails, the project
  // name. A bare business word is the human gate's job — the scrub cannot
  // understand a sentence.
  const l = buildLesson("miss C:\\Users\\me\\clients bob@corp.example", { value: "a shape worth sharing" }, "proj");
  assert.ok(!l.key.includes("clients"), "the path is gone from the key");
  assert.ok(!l.key.includes("@corp"), "the email is gone");
  assert.ok(l.key.includes("<path>"), "scrubbed to the same shape as the body");
  const plain = buildLesson("table-pattern", { value: "x" }, "someproj");
  assert.equal(plain.key, "table-pattern", "a clean key passes through untouched");
});

check("lesson-from-a-miss-keeps-the-pairing", () => {
  const note = {
    value: "SELF-REPORTED MISS. CLAIMED: the agent harness index is independent. TRUE: It was built from the live rulebook. CAUGHT BY: the harness failed after a docs-only edit",
    by: "someone",
  };
  const l = buildLesson("miss-agent-harness", note, "somewhere");
  assert.ok(l.problem.startsWith("the agent harness index is independent"), "CLAIMED becomes problem");
  assert.ok(l.fix.includes("It was built from the live rulebook"), "TRUE becomes fix");
  assert.ok(l.fix.includes("docs-only edit"), "CAUGHT BY travels inside fix");
  assert.ok(!JSON.stringify(l).includes("someone"), "the author's name does NOT travel");
});

check("lesson-from-a-plain-note-splits-problem-from-fix", () => {
  const note = { value: "the table pattern moved to DataTable\nand the catalogue screen is the reference" };
  const l = buildLesson("table-pattern", note, "proj");
  assert.ok(l.problem.length > 0 && l.fix.length > 0, "both halves exist");
  assert.ok(!l.problem.includes("catalogue"), "the split is at the midpoint, not arbitrary");
});

check("lesson-fields-are-capped", () => {
  const note = { value: "x".repeat(5000) };
  const l = buildLesson("big", note, "p");
  for (const v of [l.problem, l.cause, l.fix]) {
    assert.ok(v.length <= 1200, `field under the cap (got ${v.length})`);
  }
});

check("issue-url-is-prefilled-and-encoded", () => {
  const url = buildIssueUrl({ key: "k", problem: "a claim with spaces & specials", cause: "c", fix: "f" });
  assert.ok(url.startsWith("https://github.com/"), "the project's own tracker");
  assert.ok(url.includes("title=Lesson%3A"), "the title is prefilled");
  assert.ok(url.includes(encodeURIComponent("& specials")), "the body is encoded, not raw");
});

/* ------------------------------ the feed --------------------------------- */

const goodFeed = JSON.stringify({
  lessons: [
    { key: "miss-eol", problem: "a CRLF file got LF edits and nothing matched", cause: "models answer LF", fix: "normalise to the file's convention before matching" },
  ],
});

check("feed-parses-when-it-is-exactly-the-shape", () => {
  const { lessons } = parseFeed(goodFeed);
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].fix, "normalise to the file's convention before matching");
});

check("feed-that-is-not-json-is-refused", async () => {
  await rejects(() => parseFeed("sure, here are some lessons"), "prose is not a feed");
});

check("feed-without-a-lessons-array-is-refused", async () => {
  await rejects(() => parseFeed('{"notes":[]}'), "wrong shape");
});

check("feed-field-over-the-cap-is-refused-not-truncated", async () => {
  // Truncation is not a defence here — a half lesson can read as a different
  // lesson. Over the cap is over the line.
  const big = JSON.stringify({ lessons: [{ key: "k", problem: "x".repeat(1201), cause: "c", fix: "f" }] });
  await rejects(() => parseFeed(big), "a 1201-char field must refuse");
});

check("feed-with-too-many-lessons-is-refused", async () => {
  const many = JSON.stringify({
    lessons: Array.from({ length: 51 }, (_, i) => ({ key: String(i), problem: "p", cause: "c", fix: "f" })),
  });
  await rejects(() => parseFeed(many), "51 lessons must refuse");
});

check("feed-fields-must-be-text", async () => {
  const bad = JSON.stringify({ lessons: [{ key: "k", problem: { html: "<img>" }, cause: "c", fix: "f" }] });
  await rejects(() => parseFeed(bad), "an object where text belongs must refuse");
});

check("the-fetch-refuses-non-https-before-touching-the-network", async () => {
  await rejects(() => fetchFeed("http://127.0.0.1:9/lessons.json"), "http must refuse");
  await rejects(() => fetchFeed("file:///etc/passwd"), "file must refuse");
});

/* --------------------------- rendering as data ----------------------------- */

check("the-render-labels-every-line-untrusted", () => {
  const out = renderFeed(parseFeed(goodFeed));
  assert.ok(out.includes("UNTRUSTED"), "the banner says what this text is");
  assert.ok(out.includes("NOT in the rulebook"), "and that adoption is a human decision");
});

check("an-empty-feed-invites-the-first-lesson", () => {
  assert.ok(renderFeed({ lessons: [] }).includes("No lessons published yet"));
});

check("rendered-lessons-carry-no-executable-shape", () => {
  // The renderer is string concatenation for a terminal — there is no HTML
  // and no template. If it ever grows one, this assertion fails first.
  const out = renderFeed(parseFeed(goodFeed));
  assert.ok(!out.includes("<script"), "no markup is emitted");
});

check("rendered-lessons-carry-no-control-characters", () => {
  // A terminal is a command surface: an OSC 52 payload pasted into a lesson
  // rewrites the reader's clipboard, and a screen clear redraws the terminal
  // over the UNTRUSTED banner. Every C0/C1 byte and ESC is stripped before it
  // prints — the text may only display.
  const evil = JSON.stringify({
    lessons: [{
      key: "k",
      problem: "\x1b]52;c;aGVsbG8=\x07click me\x1b[2J clean slate",
      cause: "\x9bhidden C1",
      fix: "still readable\nacross lines",
    }],
  });
  const out = renderFeed(parseFeed(evil));
  assert.ok(!out.includes("\x1b"), "no ESC reaches the terminal");
  assert.ok(!out.includes("\x07"), "the OSC terminator is gone");
  assert.ok(!out.includes("\x9b"), "no bare C1 byte survives either");
  // With ESC and BEL gone the sequence is broken: what remains is inert
  // visible text, not a clipboard write.
  assert.ok(out.includes("click me"), "the visible text still renders");
  assert.ok(out.includes("clean slate"), "the visible text still renders");
  assert.ok(out.includes("still readable\nacross lines"), "newlines are kept — text, not commands");
  // ESC gone means the sequence is broken — the bracket residue is inert
  // visible text, not a colour command.
  assert.equal(stripControlChars("\x1b[31mred\x1b[0m"), "[31mred[0m", "and it works standalone");
});

await Promise.all(checks);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ${f}`);
  process.exit(1);
}
console.log("DONE");