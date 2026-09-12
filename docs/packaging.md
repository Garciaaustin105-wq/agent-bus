# Making the hub a thing you download

Today the hub is a folder inside a git repo. You get it by cloning. That is fine
for the person who wrote it and impossible for anyone else.

## The one line that blocks it

`server.mjs:79`

    const PROJECT_ROOT = path.resolve(DIR, "..", "..");

The hub assumes **the place it is installed IS the project it serves**. That
holds when the source sits at `<repo>/tools/agent-bus/`. It is false the moment
somebody installs it, because then the source sits in npm's global directory or
in Program Files and `../..` is `node_modules` or `C:\Program Files`.

Everything downstream inherits the mistake: `docsDir()` (line 90), the worker's
`cwd` (line 721), and `sessions.mjs:32`, which hashes `PROJECT_ROOT` to find the
Claude transcript directory. A wrong root there does not throw — it silently
watches the wrong project's tokens, which is worse.

`AGENT_BUS_PROJECT` is already the seam. It just has to stop being an
env var you remember and become the normal path.

## What it should be instead

Precedence, highest first:

1. `AGENT_BUS_PROJECT` — explicit, unchanged.
2. The nearest ancestor of `process.cwd()` containing `.git` — via
   `git rev-parse --git-common-dir`, which is already the code at line 55 and
   already resolves correctly from inside a worktree.
3. `process.cwd()` — a project that is not a git repo is still a project. State
   goes to `<cwd>/.agent-bus/` rather than `<cwd>/.git/agent-bus/`.

`import.meta.dirname` stops being an input to the root entirely. It stays what
it is: where the code lives.

## Options considered

| option | what it costs | verdict |
| --- | --- | --- |
| **npm global bin** (`npm i -g agent-bus`, or `npx agent-bus`) | one `package.json`, no build step, no signing, works on all three platforms | **this one** |
| Node SEA / `pkg` single binary | ~80 MB per platform, three build targets, and on Windows an unsigned exe gets a SmartScreen wall — a code-signing cert is ~$200/yr | no |
| Electron / Tauri shell | Electron ends the dependency-free property and adds 150 MB to ship a window we already get from `--app=`; Tauri adds a Rust toolchain | no |
| `.msi` / `.pkg` installer | signing again, plus an uninstaller to maintain | not first |

The audience already has Node — Claude Code requires it. A single binary solves
a problem this product does not have, and pays for it in signing, size and three
CI targets.

`agent-bus` is unclaimed on npm (registry returns 404).

## The work

**1. `PROJECT_ROOT` becomes `projectRoot()`.** Precedence above. Pure function
of cwd + env; a harness can drive it with a temp directory. Pin all three
branches, plus the non-git fallback landing state in `.agent-bus/`.

**2. `package.json` at the repo root.** `name: "agent-bus"`, `bin`, `files`,
`engines: { node: ">=18" }`. No dependencies, and a test that asserts the
dependencies block stays empty — that property is the product's spine, not a
preference. Do **not** set `"type"`: every file is already explicit (`.mjs`,
`.cjs`) and adding it only creates a way to be wrong later.

**3. `agent-bus open` replaces `agent-bus.cmd`.** The .cmd is forty lines of
Windows batch doing three things Node does portably: pick a free port (bind to 0
and read `server.address().port` instead of grepping `netstat`), start the
dashboard, open a chromeless window. Keep the `--app=` trick — it is still the
right call — and add the macOS and Linux browser paths. The .cmd stays in the
repo for the double-click case; it should shell out to the new verb rather than
carry its own copy of the logic.

**4. `agent-bus mcp` names the stdio server explicitly.** Today "no arguments"
means "be an MCP server". That is fine as an internal contract and bad as a
published binary, where a user typing `agent-bus` gets a process that appears to
hang. Bare `agent-bus` should print help. Keep the no-argument stdio behaviour
only when stdin is not a TTY.

**5. `agent-bus init` registers it.** Writes the `agent-bus` entry into the
project's `.mcp.json` (creating it, merging if present, never clobbering other
servers) with `command: "agent-bus"`, `args: ["mcp"]`. Print what it wrote.
Nothing else auto-applies (C4).

**6. Docs follow the code.** `docsDir()` currently defaults to
`<root>/docs`. Installed, the hub's own rulebook ships inside the package while
the served project's docs live in the project. Two different things sharing one
resolver. Package docs resolve from `import.meta.dirname`; project docs from
`projectRoot()`; the hub window shows both and says which is which.

## Verification

The e2e already spawns two real processes. Add one more real check: `npm pack`,
install the tarball into a temp prefix, run `agent-bus board` from an unrelated
directory, and assert the state landed under that directory's root and not next
to the installed source. That is the entire failure this work exists to prevent
(E1), and no unit test can see it.
