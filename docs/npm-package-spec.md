# Spec — the npm package (packaging.md items 2–7, the installable bus)

Written 2026-10-08. Item 1 of `packaging.md` (projectRoot precedence) is
ALREADY SHIPPED — `projectRoot()` in `server.mjs:102` implements all three
branches with the right comment. **This spec covers the remaining six.**

The goal: `npx agent-bus dashboard` works from any directory, and nothing
about the installed copy writes state next to the installed source. The
failure to prevent (packaging.md, E1): a wrong root does not throw — it
silently watches/writes the wrong project.

## Constraints inherited

- Zero dependencies, forever; a harness test asserts `dependencies` stays
  empty (that property is the product's spine, not a preference — packaging.md).
- `"type"` stays UNSET (every file is already explicit).
- Anything that would need npm to exist at RUNTIME is forbidden — the bus must
  keep working from a bare clone too. `npm` presence is only assumed where
  packaging.md says: in the VERIFY step (a machine with Node ≥ 20 has npm).

## 1. `package.json` at the repo root

```json
{
  "name": "agent-bus",
  "version": "0.1.5",
  "description": "<the README's first sentence, one line>",
  "bin": { "agent-bus": "tools/agent-bus/server.mjs" },
  "files": ["tools/agent-bus", "docs", "lessons/README.md", "README.md", "SECURITY.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node tools/agent-bus/e2e-agent-bus.mjs && node tools/agent-bus/*.mjs harness run"  // see below
  }
}
```

- No `dependencies`, no `devDependencies`, no `type`. A harness check parses
  the file and fails on any dependency key being present (including on
  `npm pack`-shaped changes: `files` must not depend on it).
- `bin` target needs the shebang (already present at `server.mjs:1`).
- **CRLF hazard on `bin` entry**: `server.mjs` must keep LF line endings —
  when npm writes the shim on Windows it still reads the shebang line; a BOM
  or `\r` after `node` on line 1 breaks `npx agent-bus`. Pin in the harness:
  the first bytes of `server.mjs` are exactly `#!/usr/bin/env node\n` (no BOM,
  no `\r`). Add a `.gitattributes`-style guard only if the harness catches a
  real one.
- `scripts.test`: a plain shell list of all 17 harness entries, ordered, so
  `npm test` = the gate. The gate count (487) is pinned in the READMEs and a
  harness check; keep the single source being the READMEs and add no second
  counting mechanism.
- `"version"` starts at `0.1.5` (next release; last published is v0.1.4). From
  then on the npm version and the git tag move together — never a lone bump.
- `VERSION` const in `server.mjs:83` is currently `"1.0.0"` and lands in MCP
  `serverInfo`. It should read from `package.json` when packable (`tools/`
  sibling lookup, absolute) and fall back to the const; the const itself moves
  to `"0.1.5"`. The MCP pin in the e2e (`serverInfo.version`) must not
  hardcode a number twice — assert it equals the `package.json` version.

## 2. `agent-bus open` — the portable .cmd

Replaces the ~40 lines of `agent-bus.cmd` with a `dashboard_open` CLI verb
(`node tools/agent-bus/server.mjs open [port]`), and `.cmd` shells out to it
(one line) instead of carrying its own copy.

- **Port**: the argument, else 7777 like hub.mjs — probed over HTTP with the
  hub-render identity check, `netstat` never. One hub first (the v0.1.2 rule):
  a hub already answering on the target just gets a second window; nothing is
  spawned. (Not a bind-to-0 pick — a fresh free port cannot see the running
  hub anywhere, since "already running" is necessarily a per-port check; the
  first dogfooded run spawned exactly that twin. Miss `miss-claim-open-s-bind-to-0`.)
- **Window**: pick a chrome-family binary in this order (first found wins):
  Windows `%ProgramFiles%/Google/Chrome/Application/chrome.exe` then
  `%ProgramFiles(x86)%` then Edge (`msedge.exe`);
  macOS `/Applications/Google Chrome.app/.../MacOS/Google Chrome` (Safari
  cannot `--app=`; if no chrome family, fall back to `open <url>`);
  Linux `google-chrome` / `chromium` / `chromium-browser` from PATH.
  Launch detached (`child_process.spawn` with `detached: true` +
  `.unref()`), flag `--app=http://127.0.0.1:<port>` (Windows/Chrome/Edge),
  plus `--window-size=480,780`.
- **No browser found**: degrade by printing the URL (dashboard still works —
  the window is sugar, not the product).
- Existing behavior preserved: `dashboard <port>` (fixed port) is unchanged;
  the one-hub rule must still prevent a second hub when `open` runs.
- `agent-bus.cmd` becomes a delegation shim (keeps double-click working).

## 3. `agent-bus mcp` — explicit stdio

- `runCli(["mcp"])` starts the stdio JSON-RPC loop (same code as the
  no-argument path — no second implementation).
- BARE INVOCATION RULE: `IS_MAIN && argv.length <= 2` changes to —
  - stdin is a TTY → print help (one screen: the verbs, one line each, from
    the same table the README carries; no duplication, hardcode here and let
    the README stay prose) and exit 0.
  - stdin is NOT a TTY (an MCP client spawning it) → stdio loop, unchanged.
  This keeps every existing harness and MCP client working (they spawn with
  attached pipes) and fixes the published-binary "appears to hang" case.
- The `IS_MAIN && argv.length > 2` CLI branch is untouched.

## 4. `agent-bus init` — register the project, on the record

`node tools/agent-bus/server.mjs init [--project <root>]`

- Resolves `projectRoot(--project || process.cwd())` — the shipped precedence.
- Writes `<root>/.mcp.json`: creates it if absent; if present, MERGES — reads
  existing JSON, sets `mcpServers["agent-bus"] = { command: "agent-bus",
  args": ["mcp"] }` ONLY when no existing entry named `agent-bus`, else
  prints the existing entry and asks nothing (a local-scope override of the
  same name wins above .mcp.json — see README — so a present-but-different
  entry is the user's choice to keep or change; we do not auto-clobber).
- Never touches any other key in the file. Written atomically
  (`.tmp` + rename, the state-file convention).
- Prints exactly what it wrote (path + the resulting `agent-bus` entry).
- Refuses with a message, cleanly, when `<root>` has no Node ≥ 20 (nothing to
  check cheaply — just the version readout of the running node) — out of
  scope; the check lives in `npm audit-meta`-style docs, not code.

## 5. Docs resolution split

Today one `docsDir()` serves both "the hub's own learning" (rulebook,
how-we-work, workflow spine — rendered live) and "where the project's docs
live". Installed, those separate:

- `packageDocsDir()`: `AGENT_BUS_DOCS_DIR` env, else
  `path.resolve(import.meta.dirname, "..", "..", "docs")` — the package's own
  shipped docs, wherever the package is installed.
- `projectDocsDir()`: `AGENT_BUS_DOCS_DIR` NOT consumed here;
  `path.join(PROJECT_ROOT, "docs")` unconditionally.
- Consumers: `readStages()` + the hub's docs panels (rulebook/how-we-work,
  the hub's learning) → `packageDocsDir()`. Any current consumer of
  `docsDir()` that names project documentation (audit the call sites — there
  are few) → `projectDocsDir()`.
- `AGENT_BUS_DOCS_DIR` keeps its meaning for the package docs (it names the
  docs' new home from outside — the same seam, unchanged).
- The hub page renders both and labels which is which if a project has a
  `docs/` of its own; a project without one says so instead of an empty pane.

## 6. Files / packaging hygiene

- `docs` must not include `adoption/` secrets-like content? It is all public
  draft copy — fine to ship. `runners.json` is git-ignored and therefore not
  in `files`. State lives in `.git/agent-bus` (or `.agent-bus/`) of the
  PROJECT, never of the package — the `projectRoot()` work already guarantees
  this for git projects; the non-git fallback (`<cwd>/.agent-bus/`) is branch
  3 and the e2e asserts it.
- `.npmignore` is unnecessary — `files` is the allowlist. `LICENSE` file must
  exist (MIT; if the repo has none, this item adds it).

## 7. VERIFY — the check that justifies the whole spec

An e2e check in a new `npm-pack-harness.mjs` (counted in the gate; READMEs
updated in the same commit):

1. `npm pack` in a temp copy of the repo (never in the real tree — pack must
   not mutate anything).
2. `npm install --prefix <tmp-prefix>` the produced tarball.
3. From an UNRELATED temp cwd (no git, not the repo): run
   `node <tmp-prefix>/node_modules/.bin/agent-bus note probe-key "v"` — wait,
   bin shims via `.bin` resolve to the real file; invoke through the shim or
   direct path either way.
4. Assert: `state.json` appeared at `<cwd>/.agent-bus/state.json` (branch 3),
   NOT under `<tmp-prefix>` (E1 — the exact failure).
5. Assert `npx` shim parity: with the tmp prefix on PATH, `agent-bus mcp`
   answers an `initialize` request on stdio (a pinned minimal
   JSON-RPC round trip).
6. Skip-with-reason if `npm --version` fails (a machine without npm cannot
   run it; the suite prints SKIP and the gate count treats a skip as visible,
   not silent — assert it does not count as a pass).

## Implementation lanes

| lane | files | who |
| --- | --- | --- |
| A. dispatch + verbs | `server.mjs` (bare rule, `mcp`, `open`, `init`, `VERSION`), `agent-bus.cmd` shim | Claude-direct (dispatch is the security-relevant spine; bin/TTY semantics are the parts a wrong hand gets wrong) |
| B. package metadata | `package.json`, `docsDir` split consumers, `LICENSE`, README tables | Claude-direct (small) — local-AI handoff unnecessary, this is ~80 lines |
| C. the e2e check | `npm-pack-harness.mjs` + gate count pins in both READMEs | Claude-direct |

Out of scope, explicitly: the actual `npm publish` (the user's word, like a
release), the Smithery `.mcpb` follow-up, any HTTP/OAuth shim, and changing
release flow.

## Acceptance

- All 18 suites green (17 existing + the new one), gate count updated in
  README(s), harness asserts the zero-deps property and the shebang/LF rule.
- From a bare clone (the repo as-is, no npm anything): every existing verb,
  every suite, the MCP session and the dashboard behave exactly as before
  (regression bar).
- From an installed copy: `agent-bus open` opens a window; `agent-bus init`
  merges the right `.mcp.json`; state never lands beside the installed source
  (the E1 check proves it).