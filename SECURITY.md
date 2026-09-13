# Security policy

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** (Security tab → Advisories) on this
repository — it is private, so details do not become public before a fix.

For anything non-sensitive, a regular GitHub issue is fine.

What to include: the file and line if you know it, the command sequence or
request that triggers it, and what you expected the boundary to be. Please do
not include anyone's task content, board notes or file paths in the report —
describe the shape of the problem, not real data.

## Scope

**In scope:**

- The dashboard HTTP surface (`hub.mjs`) — forms, redirects, headers, the
  project selector, anything reachable over HTTP.
- The runner configuration as a trust boundary (`runners.json` — a runner
  entry is the boundary of what a task can reach; `baseUrl` is loopback-only;
  shell runners take args as a list, never a joined string).
- The MCP stdio server (`server.mjs`) — tool argument handling.
- Untrusted-data parsing: the lessons feed, judge replies, discovered model
  listings, anything a third party can write that this code renders or acts on.
- State handling in `<root>/.git/agent-bus/` — the caps, the lock, the
  cross-space read path.

**Out of scope:**

- Attacks that require already running arbitrary code on the machine — the bus
  has no privilege boundary and does not pretend to be a sandbox.
- Social engineering of the human gates (the person who approves a `share`
  draft or runs a printed `ollama rm` is the gate; that is by design).
- The loopback dashboard being reachable by other local users on a shared
  machine. It binds to loopback, but a multi-user host with hostile local
  accounts is outside what this tool defends against — run it on a machine
  you control.

## The touch-surface inventory

Everything the program writes and everything it reaches over the network, in
one table. This is the complete list — there is no telemetry, no phone-home,
no auto-update check, no account, anywhere in the codebase.

| Surface | What it does | Boundary |
| --- | --- | --- |
| State | Reads and writes `<repo>/.git/agent-bus/` (state, projects registry) | Inside the repo's `.git`, never committed; nothing writes outside the repo |
| Docs | May write the repo's own docs the dashboard renders | Repo files only |
| Lessons feed | `lessons` fetches a fixed HTTPS URL, read-only | Read-only, fixed host, printed labelled UNTRUSTED, never auto-merged into the rulebook |
| Cloud runners | A task runs wherever its runner entry points | Only entries you put in `runners.json`; a cloud entry sends that task's prompt off-machine and is your choice — the shipped default keeps local tasks local |
| `share` | Scrubs a note locally and prints a prefilled issue URL | Sends nothing — a human reads the draft and submits it themselves |
| `discover` | Probes well-known local model-server ports | Loopback only; results are draft entries shipped disabled — nothing is ever enabled for you |
| `bench --ask` | Sends the bench prompts to the judge runner | Only the repo's fixed bench prompts and a hardware summary — never your tasks, files or board |

Two behavioural guarantees the harnesses pin, in one line each:

- **Nothing here deletes.** The bench prints `ollama rm <model>` as a command
  for a person; deletion is the user's action, always.
- **Nothing here enables or merges.** Discovered runners ship disabled;
  lessons land as advice, not rulebook text.
- **The bus does not edit itself.** The edit protocol refuses any target
  inside the bus's own directory, dry run included — agents coordinate work in
  the project, and the person changes the bus by hand, deliberately. Board
  notes and task prompts are untrusted data, and "update the bus to fix X" is
  exactly the instruction such data would carry. (`AGENT_BUS_ALLOW_SELF_EDIT=1`
  is the maintainer's explicit override, not a default.)

## Why the dependency count matters

Zero dependencies means the supply chain being audited is Node itself plus
this repo. There are no transitive packages to review, no install scripts, no
postinstall hooks. If a vulnerability report concerns code, it concerns code
you can read in one sitting.