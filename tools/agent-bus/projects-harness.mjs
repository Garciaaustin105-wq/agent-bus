/**
 * Harness for §6 — each app build lives in its own place. Two layers, like
 * every other harness: the pure contract in projects.mjs (names, the registry,
 * which space a ?p= selection means), then the real wiring through server.mjs
 * (the MCP verbs, the registry file on disk, reading another project's state).
 *
 * The checks that matter most: the registry is validated at the door (a bad
 * slug or a nonexistent root never enters), a vanished app root degrades to
 * "fall back to the hub" rather than an error page, and reading another
 * project's state never writes anything — the hub renders a space it cannot
 * touch.
 *
 *   node tools/agent-bus/projects-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-projects-"));
process.env.AGENT_BUS_PROJECT = HOME;

const {
  addProject,
  cleanName,
  cleanRoot,
  readRegistry,
  registryList,
  removeProject,
  resolveProject,
  statePathForRoot,
  writeRegistry,
} = await import("./projects.mjs");
const { readStateForRoot, callTool, asActor } = await import("./server.mjs");

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
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

/* ── the pure contract ────────────────────────────────────────────────────── */

check("cleanName-takes-slugs-and-lowercases", () => {
  assert.equal(cleanName("  My-App "), "my-app");
  assert.equal(cleanName("v2.build"), "v2.build");
});

check("cleanName-refuses-what-a-URL-could-not-carry", () => {
  assert.ok(throws(() => cleanName("")), "empty refused");
  assert.ok(throws(() => cleanName("my app")), "spaces refused");
  assert.ok(throws(() => cleanName("../escape")), "path shapes refused");
  assert.ok(throws(() => cleanName(".hidden")), "dot-leading refused");
  assert.ok(throws(() => cleanName("-lead")), "dash-leading refused");
  assert.ok(throws(() => cleanName("x".repeat(41))), "over 40 chars refused");
});

check("cleanRoot-demands-a-directory-that-exists", () => {
  assert.equal(cleanRoot(HOME), path.resolve(HOME));
  assert.ok(throws(() => cleanRoot(path.join(HOME, "nope"))), "missing path refused");
  const file = path.join(HOME, "a-file.txt");
  fs.writeFileSync(file, "x");
  assert.ok(throws(() => cleanRoot(file)), "a file is not a project root");
});

check("addProject-upserts-same-name-new-root", () => {
  const one = addProject([], "alpha", HOME);
  assert.equal(one.length, 1);
  const two = addProject(one, "alpha", path.join(HOME, "moved"));
  assert.equal(two.length, 1, "same name replaces, not duplicates");
  assert.equal(two[0].root, path.join(HOME, "moved"));
  const three = addProject(two, "beta", HOME);
  assert.deepEqual(three.map((e) => e.name), ["alpha", "beta"], "sorted by name");
});

check("removeProject-removes-and-leaves-unknown-lists-alone", () => {
  const list = addProject(addProject([], "alpha", HOME), "beta", HOME);
  assert.equal(removeProject(list, "alpha").length, 1);
  assert.equal(removeProject(list, "ghost").length, 2, "unknown name changes nothing");
});

check("registryList-caps-sorts-and-drops-junk-rows", () => {
  const junk = [{ name: "b", root: "x" }, null, { name: "a", root: "y" }, { name: "" }, "nope"];
  assert.deepEqual(registryList(junk).map((e) => e.name), ["a", "b"]);
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `app-${i}`, root: "x" }));
  assert.equal(registryList(many).length, 20, "capped");
});

check("resolveProject-nothing-selected-means-own", () => {
  const entries = [{ name: "other", root: HOME }];
  for (const sel of [undefined, null, "", "  "]) {
    const got = resolveProject(entries, sel, HOME);
    assert.ok(got.own, `selection ${JSON.stringify(sel)} is own`);
  }
  const named = resolveProject(entries, "other", HOME);
  assert.equal(named.own, false);
  assert.equal(named.root, path.resolve(HOME));
  assert.ok(resolveProject(entries, "unknown", HOME) === null, "unknown name → null");
  const dead = resolveProject([{ name: "gone", root: path.join(HOME, "deleted") }], "gone", HOME);
  assert.ok(dead === null, "a vanished root → null, not an error page");
});

check("statePathForRoot-mirrors-the-state-dir-shape", () => {
  const withGit = path.join(HOME, "gitproj");
  fs.mkdirSync(path.join(withGit, ".git"), { recursive: true });
  assert.equal(
    statePathForRoot(withGit),
    path.join(withGit, ".git", "agent-bus", "state.json")
  );
  const noGit = path.join(HOME, "plainproj");
  fs.mkdirSync(noGit, { recursive: true });
  assert.equal(statePathForRoot(noGit), path.join(noGit, ".agent-bus", "state.json"));
});

check("registry-round-trips-and-corrupt-file-reads-as-empty", () => {
  const dir = path.join(HOME, "reg");
  assert.deepEqual(readRegistry(dir), [], "no file yet → empty, not a crash");
  writeRegistry(dir, [{ name: "alpha", root: HOME }, { name: "beta", root: HOME }]);
  const back = readRegistry(dir);
  assert.deepEqual(back.map((e) => e.name), ["alpha", "beta"]);
  fs.writeFileSync(path.join(dir, "projects.json"), "{not json");
  assert.deepEqual(readRegistry(dir), [], "corrupt → empty");
  fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify({ apps: [{ name: "wrapped", root: HOME }] }));
  assert.deepEqual(readRegistry(dir).map((e) => e.name), ["wrapped"], "the {apps:[]} shape also reads");
});

/* ── the real wiring through server.mjs ───────────────────────────────────── */

check("readStateForRoot-reads-and-never-writes", () => {
  assert.ok(!readStateForRoot(HOME), "no bus yet → null/empty, not an error");
  const projA = path.join(HOME, "proj-a");
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(path.join(projA, ".agent-bus"), { recursive: true });
  const statePath = statePathForRoot(projA);
  fs.writeFileSync(statePath, JSON.stringify({ board: { "a-only": { value: "proj a fact" } } }));
  const got = readStateForRoot(projA);
  assert.equal(got.board["a-only"].value, "proj a fact");
  const before = fs.statSync(statePath).mtimeMs;
  readStateForRoot(projA);
  assert.equal(fs.statSync(statePath).mtimeMs, before, "a read must not touch the file");
});

check("project_add-validates-and-writes-the-registry", () => {
  const projA = path.join(HOME, "proj-a");
  const out = asActor("desk", () => callTool("project_add", { name: "proj-a", root: projA }));
  assert.ok(out.includes("?p=proj-a"), `got: ${out}`);
  assert.ok(throws(() => callTool("project_add", { name: "bad name!", root: projA })), "bad slug refused");
  assert.ok(throws(() => callTool("project_add", { name: "ghost", root: path.join(HOME, "nope") })), "missing root refused");
  const reg = JSON.parse(fs.readFileSync(path.join(HOME, ".agent-bus", "projects.json"), "utf8"));
  assert.equal(reg[0].name, "proj-a");
});

check("project_add-warns-when-the-project-vendors-its-own-bus", () => {
  // The invisible-session report (2026-09-13): a project with its own
  // tools/agent-bus/server.mjs keeps launching that copy. Registration is
  // where both paths are known, so it says so there.
  const projV = path.join(HOME, "proj-vendored");
  fs.mkdirSync(path.join(projV, "tools", "agent-bus"), { recursive: true });
  fs.writeFileSync(path.join(projV, "tools", "agent-bus", "server.mjs"), "// an old copy\n");
  const out = asActor("desk", () => callTool("project_add", { name: "proj-vendored", root: projV }));
  assert.ok(out.includes("own copy of the bus"), `warned: ${out}`);
  assert.ok(out.includes(`AGENT_BUS_PROJECT=${projV}`), "names the root to point sessions at");
  const projC = path.join(HOME, "proj-clean");
  fs.mkdirSync(projC, { recursive: true });
  const clean = asActor("desk", () => callTool("project_add", { name: "proj-clean", root: projC }));
  assert.ok(!clean.includes("Heads-up"), `no warning without a copy: ${clean}`);
  asActor("desk", () => callTool("project_remove", { name: "proj-vendored" }));
  asActor("desk", () => callTool("project_remove", { name: "proj-clean" }));
});

check("projects-lists-the-registry-with-this-bus-marked", () => {
  const out = asActor("desk", () => callTool("projects", {}));
  assert.ok(out.includes("proj-a"), `got: ${out}`);
  assert.ok(!out.includes("this bus"), "the hub's own root is not registered");
});

check("project_remove-forges-the-name-and-names-what-exists", () => {
  assert.ok(throws(() => callTool("project_remove", { name: "ghost" })), "unknown refused");
  const out = asActor("desk", () => callTool("project_remove", { name: "proj-a" }));
  assert.ok(out.includes("untouched"), `got: ${out}`);
  assert.deepEqual(readRegistry(HOME), [], "registry back to empty");
});

fs.rmSync(HOME, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);