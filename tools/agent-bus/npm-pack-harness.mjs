/**
 * The packaging harness — the check that justifies the npm package
 * (npm-package-spec.md item 7). Everything here runs against a TEMP COPY of
 * the repo and temp install prefixes; nothing in the real tree is mutated,
 * and `npm pack` only ever sees the copy.
 *
 *   node tools/agent-bus/npm-pack-harness.mjs   (exit 0 = all green)
 *
 * The failure this exists for (packaging.md, E1): a wrong resolved root does
 * not throw — an installed copy silently reads and writes the wrong
 * project's state. So the E1 check installs the package and asserts state
 * landed in the CALLING directory, never beside the installed source.
 *
 * The npm-gated group is skipped WITH a reason when npm is absent (a skip is
 * visible in the count line and never counts as a pass).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SERVER = path.join(import.meta.dirname, "server.mjs");
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
const acheck = async (label, fn) => {
  try {
    await fn();
    pass++;
    console.log(`ok  [${label}]`);
  } catch (e) {
    fail++;
    console.log(`FAIL [${label}] ${e.message}`);
  }
};

/* ── file-metadata pins (no npm needed) ──────────────────────────────────── */

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
check("package.json: name, engines, and the zero-dependency spine", () => {
  assert.equal(pkg.name, "agent-bus");
  assert.ok(!("dependencies" in pkg), "dependencies key present — the zero-dep property is the product's spine");
  assert.ok(!("devDependencies" in pkg), "devDependencies key present");
  assert.ok(!("type" in pkg), "type key present — every file already declares its own format");
  assert.equal(pkg.engines && pkg.engines.node, ">=20");
  assert.equal(pkg.bin && pkg.bin["agent-bus"], "tools/agent-bus/server.mjs");
});
check("server.mjs bin target: shebang line, no BOM, no CR (the npx shim pin)", () => {
  // npm writes the .bin shim by reading the first line; a BOM or a \r after
  // `node` on line 1 breaks `npx agent-bus` on Windows, and nothing else
  // would ever surface it.
  const head = fs.readFileSync(SERVER).subarray(0, 20).toString("latin1");
  assert.ok(head.startsWith("#!/usr/bin/env node\n"), `first bytes are ${JSON.stringify(head.slice(0, 20))}`);
  assert.ok(!head.startsWith("﻿"), "the file starts with a BOM");
});
check("the bare-invocation rule is ONE isTTY read — no second server fork", () => {
  // A pty cannot be faked from a piped spawn without a dependency, so the
  // TTY branch cannot be behavior-tested here; its READ is pinned instead,
  // and its non-TTY arm is pinned live ("mcp" and bare, below).
  const src = fs.readFileSync(SERVER, "utf8");
  const ttyReads = src.split("\n").filter((l) => l.includes("process.stdin.isTTY"));
  assert.equal(ttyReads.length, 1, `expected exactly one isTTY read, got ${ttyReads.length}`);
});

/* ── live pins (no npm needed): mcp + the bare non-TTY rule ──────────────── */

// One initialize round trip against a child spawned with piped stdin — the
// shape every MCP client produces, and the non-TTY arm of the bare rule.
const initializeReply = (extraArgs, cwd) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("no initialize reply within 8s"));
    }, 8000);
    const p = spawn(process.execPath, [SERVER, ...extraArgs], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        p.kill();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  });

await acheck("`agent-bus mcp` answers initialize, and serverInfo.version IS the package version", async () => {
  const reply = await initializeReply(["mcp"], REPO);
  assert.equal(reply.result?.serverInfo?.name, "agent-bus");
  // One number, one source: the const used to be a second hardcoded copy;
  // this pin keeps the package.json version the only one.
  assert.equal(reply.result?.serverInfo?.version, pkg.version, "VERSION and package.json disagree");
});
await acheck("a BARE invocation with piped stdin is the stdio server (the bare rule's non-TTY arm)", async () => {
  const reply = await initializeReply([], REPO);
  assert.equal(reply.result?.serverInfo?.name, "agent-bus", "a no-argument spawn must still answer initialize — an MCP client spawns it exactly this way");
});

/* ── npm-gated: pack → install → the E1 check ────────────────────────────── */

// `npm` is a .cmd shim on Windows and Node refuses to spawn .cmd shims
// without a shell, so npm runs through the shell with path-bearing
// arguments quoted here — the paths are mkdtemp names, shell-simple.
const q = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg);
const npmRun = (args, opts) => spawnSync("npm", args.map(q), { encoding: "utf8", ...opts, shell: true });

const npmProbe = npmRun(["--version"], { timeout: 15_000 });
const hasNpm = !npmProbe.error && npmProbe.status === 0;

if (hasNpm) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-pack-"));
  const copy = path.join(tempRoot, "repo");
  const prefix = path.join(tempRoot, "prefix");
  const away = path.join(tempRoot, "away"); // an unrelated cwd: not a git repo, not the repo
  const installed = path.join(prefix, "node_modules", "agent-bus", "tools", "agent-bus", "server.mjs");
  let tgz = null;
  try {
    fs.mkdirSync(prefix, { recursive: true });
    fs.mkdirSync(away, { recursive: true });
    // Copy what `files` ships (plus package.json, which npm always packs).
    // Never the real .git or node_modules — and pack runs on the COPY so the
    // real tree stays untouched.
    fs.cpSync(path.join(REPO, "tools"), path.join(copy, "tools"), { recursive: true });
    fs.cpSync(path.join(REPO, "docs"), path.join(copy, "docs"), { recursive: true });
    fs.mkdirSync(path.join(copy, "lessons"), { recursive: true });
    fs.cpSync(path.join(REPO, "lessons", "README.md"), path.join(copy, "lessons", "README.md"));
    for (const f of ["package.json", "README.md", "SECURITY.md", "LICENSE"]) {
      fs.copyFileSync(path.join(REPO, f), path.join(copy, f));
    }

    check("npm pack of a temp copy produces a tarball (and leaves the real tree alone)", () => {
      const r = npmRun(["pack"], { cwd: copy, timeout: 180_000 });
      assert.equal(r.status, 0, `npm pack failed: ${r.stderr}`);
      const name = String(r.stdout || "").trim().split(/\r?\n/).pop();
      assert.ok(/\.tgz$/.test(name || ""), `npm pack printed no tarball name: ${String(r.stdout)}`);
      tgz = path.join(copy, name.trim());
    });
    check("the tarball installs to a temp prefix", () => {
      const r = npmRun(["install", "--prefix", prefix, tgz], { timeout: 180_000 });
      assert.equal(r.status, 0, `npm install failed: ${r.stderr}`);
      assert.ok(fs.existsSync(installed), "the package's server.mjs is not where an installed bin would resolve it");
    });
    check("E1: state from the installed copy lands in the CALLING dir, never beside the package", () => {
      // An `away` cwd has no .git above it, so projectRoot falls to branch 3
      // (<cwd>/.agent-bus) — the exact path the E1 failure used to walk past.
      const r = spawnSync(process.execPath, [installed, "note", "pack-probe-key", "installed"], {
        cwd: away,
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(r.status, 0, `the installed bin failed: ${r.stderr}`);
      const state = path.join(away, ".agent-bus", "state.json");
      assert.ok(fs.existsSync(state), "no state at <calling dir>/.agent-bus/state.json — the wrong-root failure found no new home");
      assert.ok(String(fs.readFileSync(state, "utf8")).includes("pack-probe-key"), "the note did not land in the state file we found");
      assert.ok(!fs.existsSync(path.join(prefix, ".agent-bus")), "state leaked beside the installed source (the E1 failure, alive)");
    });
    check("the installed copy's mcp answers initialize with the SAME version", () => {
      const reply = spawnSync(process.execPath, [installed, "mcp"], {
        cwd: away,
        encoding: "utf8",
        timeout: 15_000,
        input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
      });
      assert.equal(reply.status, 0, `the installed mcp failed: ${reply.stderr}`);
      const line = String(reply.stdout || "")
        .split(/\r?\n/)
        .find((l) => l.trim().startsWith("{"));
      assert.ok(line, `no JSON-RPC reply on stdout: ${String(reply.stdout)}`);
      assert.equal(JSON.parse(line).result?.serverInfo?.version, pkg.version, "the installed copy reports a different version than package.json");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("\nnpm-pack temp files cleaned up.");
} else {
  console.log(
    "SKIP the npm pack → install → E1 group — npm is not available on this machine; it did not run and does NOT count as a pass (npm-package-spec item 7)"
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);