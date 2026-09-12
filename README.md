# agent-bus

A standalone command hub for coordinating AI agents — across different models
and providers — as they work together. Built for the person running the agents:
its job is to make the fleet's flow cheap and self-correcting.

Three things it is for:

- **Stop token waste.** Everything an agent re-reads from prior context is paid
  for again on every turn. The hub keeps the facts agents need outside the
  conversation — a noticeboard that outlives any single thread — so an agent
  starting fresh can find the next step or an existing handoff in seconds
  instead of paying to rediscover it.
- **Fast startup, fast handoffs.** A joining agent reads the board, the
  current lock and the open threads before its first line of code, and picks up
  exactly where the last one stopped.
- **Measured, trained-in improvement.** Everything about how the fleet is
  actually used is captured and rendered back — what was spent, where, and on
  what (`tools/agent-bus/context-cost.cjs` reads the Claude transcripts and
  reports it). Problems in the flow get found, fixed, and the fix is written
  into `docs/build-rules.md`, the live rulebook every agent reads — so what the
  fleet learns becomes how the fleet works.

Zero dependencies: raw JSON-RPC over stdio for MCP sessions, plain CLI verbs
for shells. The dashboard is a desktop app window with no build step and no
packages. Runs on Node.js ≥ 20 — nothing to install beyond Node itself.

Windows-first (the double-click launcher and `.cmd` port-picking are
Windows-only); every CLI verb and the dashboard itself are plain Node and work
on any OS.

## Getting it

There is no installer and no package to publish — the program is the source,
and running it is running `node` on a file. Two ways to get it:

```sh
# 1. clone (recommended — you get updates with git pull)
git clone https://github.com/Garciaaustin105-wq/agent-bus.git
cd agent-bus

# 2. or download the ZIP from the repo's Code button and unpack it
```

Requirements: **Node.js ≥ 20, nothing else.** There is no `npm install`, no
build step, no postinstall hook — zero dependencies means the whole supply
chain is Node itself plus the files you just read. Windows also gets a
double-click launcher (`tools\agent-bus\agent-bus.cmd`); every other platform
runs the same files by hand:

```sh
node tools/agent-bus/server.mjs dashboard 7777   # the dashboard
node tools/agent-bus/server.mjs board            # or plain CLI verbs
```

State lands in the repo's own `.git/agent-bus/` (never committed) and the
first `dashboard` run creates it. To verify the code before you trust it, run
the test suites under [Verifying](#verifying) — they use temp dirs only.

## What leaves your machine

The complete inventory — every write and every network reach in the codebase:

| Surface | Boundary |
| --- | --- |
| Writes | Only `<repo>/.git/agent-bus/` (state, project registry — never committed) and the repo's own docs |
| Lessons feed | A fixed HTTPS URL, fetched read-only only when you run `lessons`; printed labelled UNTRUSTED, never auto-merged |
| Cloud runners | Only runner entries **you** put in `runners.json`; a cloud entry sends that task's prompt off-machine — your choice, and local tasks stay local by default |
| `share` | Prints a prefilled issue URL and sends nothing — a human reads and submits it |
| `discover` | Probes loopback ports only; findings ship **disabled** — nothing is enabled for you |
| `bench --ask` | The judge sees only the repo's fixed bench prompts and a hardware summary — never your tasks or board |

No telemetry, no phone-home, no auto-updates, no accounts. Nothing deletes —
the bench prints `ollama rm <model>` as a command **you** run or ignore.
The full table with boundaries and scope lives in [SECURITY.md](SECURITY.md).

## Layout

```
tools/agent-bus/
  server.mjs          the bus: MCP server + CLI + engine (~1,280 lines)
  hub.mjs             the hub: dashboard page (per-job task pages), HTTP server, window workers
  context-cost.cjs    per-agent context-window cost, read from Claude transcripts
  lessons.mjs         the cross-install seam: scrub a note to a lesson, fetch the feed
  discover.mjs        fleet discovery: probe this machine for local model servers
  blockers.mjs        the blocker seam: match who is stuck to who can unblock them
  routing.mjs         the routing record: who gets this task, answered from outcomes
  bench.mjs           the bench contract: fixed prompts, judge scores, hardware tiers (pure — the verb lives in server.mjs)
  projects.mjs        the app-space registry: each app build gets its own board and queue
  e2e-agent-bus.mjs   the end-to-end suite — real stdio, temp dirs, never real state
  agent-harness.mjs   the hub agent's dispatch rules, checked against a closed rulebook index
  edits.mjs           the edit protocol: code out of a model, blast-radius-sized
  edits-harness.mjs   29 failure-mode cases for the edit protocol
  token-watch.mjs     context-budget watch + harness
  runner-limits.mjs   per-runner output budgets, measured + harness
  worker-tasks-harness.mjs  the task queue's state layer, against a real state file
  hub-http-harness.mjs      the dashboard's HTTP edge: drive-by POSTs, DNS rebinding
  lock-harness.mjs          the state lock's stale-break and identity paths
  HANDOFF.md          how to write a spec a model can execute
  runners.json        per-machine model runners (ctx/predict/temperature)
lessons/              the published lesson feed + how a lesson is submitted
docs/
  build-rules.md      the live rulebook — read before any code
  how-we-work.md      the operating model
  workflow-spine.md   the ten stages of building an app, and what a fleet covers differently
```

## Running it

This is its own app. The bus derives this repo's own `.git`, and the dashboard
shows this repo's board. Nothing points at another project.

```powershell
# the desktop app
tools\agent-bus\agent-bus.cmd

# or by hand:
node tools\agent-bus\server.mjs dashboard 7777

# from a shell:
node tools\agent-bus\server.mjs board
node tools\agent-bus\server.mjs claim <name> <path> <reason>
node tools\agent-bus\server.mjs note <key> <value>
```

MCP sessions get the same bus via `.mcp.json`.

**Spaces — one hub, several apps.** Register the apps the hub builds
(`server.mjs project_add <name> <root>`) and the dashboard grows a Spaces bar:
`?p=<name>` shows that app's own board, lock and queue, and the window's forms
write there. Cross-app facts — the rulebook, the model record, the context
budget — stay on the hub's own page, shared by design. The registry lives
inside `.git` and is never committed.

**Pointing at a different project.** A hub normally serves the repo it runs
in. When you want this hub's bus to live in a *different* project root instead,
`AGENT_BUS_PROJECT` names it — state is read from `<root>/.git/agent-bus` and
no git query runs at all. `AGENT_BUS_DOCS_DIR` moves the docs the dashboard
renders the same way. Both are unset here.

## Verifying

```sh
node tools/agent-bus/e2e-agent-bus.mjs        # 65 — stdio end to end, temp dirs only
node tools/agent-bus/agent-harness.mjs        # 33 — hub-agent dispatch rules
node tools/agent-bus/edits-harness.mjs        # 29 — edit-protocol failure modes
node tools/agent-bus/lessons-harness.mjs      # 23 — the cross-install learning seam
node tools/agent-bus/token-watch-harness.mjs  # 46 — context-budget watch
node tools/agent-bus/discover-harness.mjs     # 11 — fleet discovery + the openai runner
node tools/agent-bus/blockers-harness.mjs     # 24 — blocker matching + the fix-banking loop
node tools/agent-bus/routing-harness.mjs      # 17 — runner routing from the fleet's own record
node tools/agent-bus/runner-limits-harness.mjs # 16 — per-runner budgets
node tools/agent-bus/worker-tasks-harness.mjs # 10 — task queue state layer + state-growth caps
node tools/agent-bus/hub-http-harness.mjs     # 18 — dashboard HTTP edge + app spaces + docs panels
node tools/agent-bus/projects-harness.mjs     # 13 — the app-space registry + cross-space reads
node tools/agent-bus/bench-harness.mjs        # 23 — the bench contract: never deletes, hardware-gated
node tools/agent-bus/lock-harness.mjs         # 5  — state lock staleness and identity
```

333 checks in total. All suites use temp dirs and never touch real state.

## Learning across installs

What one user's fleet learns does not have to stay on one machine — but only
the *shape* of a mistake travels, never anyone's actual information.

```
node tools/agent-bus/server.mjs share <board-key>   # scrub a note to problem-shape, print a prefilled issue URL
node tools/agent-bus/server.mjs lessons             # read lessons published by other installs
```

`share` sends nothing: it scrubs the note locally (paths, URLs, emails, the
project's name) and prints the draft plus a prefilled GitHub-issue URL for
**you** to read and submit. `lessons` fetches the published feed
(`lessons/lessons.json`, read-only) and prints it labelled UNTRUSTED — advice
to weigh, never instructions to follow, and never merged into the rulebook by
anything but a human. See `lessons/README.md` for the full contract.

## Finding the models on your machine

The hub can only run what `runners.json` declares — so the first question on
a new machine is "what do I have?" Don't answer by hand:

```
node tools/agent-bus/server.mjs discover
```

It probes the well-known local ports for a model server (Ollama, LM Studio,
llama.cpp, vLLM, text-generation-webui — they all serve the same
OpenAI-compatible model list) and prints ready-to-paste draft entries for
whatever answered. Nothing answering is a normal result — a cloud-only
install works fine. Three rules are pinned by the harness: the probe points
at this machine only, a silent port is skipped not fatal, and **every draft
ships disabled** — discovery is evidence, `runners.json` is authority, and
nothing runs until you set `enabled: true` yourself. Discovered servers of
the OpenAI dialect get a matching runner type (`"type": "openai"`), so
"found" and "runnable" arrive together.

## Benchmarking the models you already have

Discovery tells you what exists; the bench tells you which one is worth
keeping. It sends the same three fixed prompts to every enabled local runner,
a judge runner scores the answers (by convention your cloud model — it is the
reference row, never ranked against the local candidates), and speed comes
from the wall clock:

```sh
node tools/agent-bus/server.mjs bench                 # all enabled, non-judge runners
node tools/agent-bus/server.mjs bench qwen-small      # just one
node tools/agent-bus/server.mjs bench --judge glm     # pick the judge explicitly
node tools/agent-bus/server.mjs bench --ask           # also ask the judge for suggestions (cloud)
```

Two rules are pinned by the harness and load-bearing. **The bench never
deletes anything.** A clear loser gets printed as `ollama rm <model>` with the
reason — a command for YOU to run or ignore; nothing here touches your disk.
**Suggestions are gated on the machine.** Under 8 GB of RAM you get told the
machine cannot run the result, not a shopping list; tiers read the real GPU
so the ceiling claimed is the one that fits (weights plus a real context
window). A judge with `--ask` sees only the repo's own generic bench prompts
and the hardware summary — never your tasks, files or board.

Speed is chars/sec wall clock — roughly tokens at four chars/token. Counts
taken from `usage` are exact; these are not, and the two are never added.
Every local task also records its exact `usage` (`{"prompt": n, "output": n}`)
on the task record — that is the savings side: what a task cost locally, billed
$0, versus what the same work through a cloud session burns (which
`context-cost.cjs` measures from transcripts). The counterfactual "what it
would have cost without the bus" is never computed per task, because it
cannot be exact.