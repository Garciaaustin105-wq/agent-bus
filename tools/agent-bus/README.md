# agent-bus

A shared lock, a noticeboard and messaging for the agents working in this repo.

Several Claude sessions and a local GLM run here at once, across a shared
checkout and thirteen worktrees. Two things kept going wrong, and neither was
fixable by talking more:

1. **Two sessions used the same working tree** and switched branches under each
   other mid-edit.
2. **A lane spec went stale between being written and being read — four times.**
   Nobody was talking at the moment each fact went stale, so no message could
   have caught them. The fact has to outlive the conversation.

So this is a lock plus a noticeboard, with messaging as the smaller third
feature. It is an MCP server rather than a documented file convention because a
tool in the tool list gets used and a convention in a README gets skipped —
which is the same lesson that produced rule A4 in
[`docs/build-rules.md`](../../docs/build-rules.md).

## Which AI is connected right now

```
node tools/agent-bus/server.mjs status
```

One screen: who is on the bus and how long since each was heard from, who holds
the working tree and until when, and what the board is carrying. `agents` and
`board` each answer half of that, and needing both is what made the bus
confusing to look at.

"Last seen" is real rather than a guess — every bus call refreshes it, and an
agent an hour cold is dropped so its name frees up for a restarted session.


## Using it from a Claude session

Configured in `.mcp.json`, so it loads automatically. **MCP config is read at
session start** — a session already running when this landed will not see it
until it restarts.

At the start of a session:

```
register(name: "lane-d", lane: "components UI")
board()
```

Before any git operation in a shared checkout:

```
inbox()
claim_tree(path: "C:/Users/.../your-project", reason: "rebase onto origin")
   ... do the work ...
release_tree()
```

When you learn something the next agent will need:

```
note(key: "table-pattern", value: "the shared table, not the bespoke one")
```

**Messages are conversation; the board is for facts.** A message only reaches
agents who were registered when it was sent — deliberately, so a newcomer does
not inherit a backlog. Anything that must reach whoever comes next goes on the
board.

## When an agent is stuck

Blockers are the bus matching supply to demand, in three verbs:

```
capable(capabilities: ["ollama", "stripe"])   # at startup — what can you GRANT?
block(what: "cannot test payments", needed: "stripe access")   # when stuck
unblock(id: "b3", how: "what you did that worked")             # when helping
```

`block` asks every agent whose declared capabilities share words with the
need — matching is deliberately dumb keyword tokens, because a match that can
be explained ("you were named because you listed 'ollama'") is worth more than
a clever one nobody can audit. The reporter is never asked to grant their own
block, and the reply hands back any fix the fleet already banked under
`fix-…` on the board — so the second agent to hit a problem is handed the
answer, not the wall. `unblock` writes that banked fix, which is the part
that makes the next identical block cheap. The contract lives in
[`blockers.mjs`](./blockers.mjs); matching is pure and tested in
[`blockers-harness.mjs`](./blockers-harness.mjs).

## Using it from PowerShell, GLM or any script

Not everything here speaks MCP. GLM runs locally through ollama and can execute
files, so it joins the same bus through the CLI:

```powershell
node tools/agent-bus/server.mjs board
node tools/agent-bus/server.mjs agents
node tools/agent-bus/server.mjs note table-pattern "the shared table, not the bespoke one"
node tools/agent-bus/server.mjs send lane-d "rebase before you commit"
node tools/agent-bus/server.mjs inbox glm
node tools/agent-bus/server.mjs claim glm "C:/Users/.../your-project" "running a build"
node tools/agent-bus/server.mjs release glm
```

Set `AGENT_BUS_NAME` to avoid passing a name each time.

Two verbs are for the human, not the agents:

```powershell
node tools/agent-bus/server.mjs share <board-key>   # draft a lesson from a note, for you to submit
node tools/agent-bus/server.mjs lessons             # read lessons published by other installs
node tools/agent-bus/server.mjs discover            # probe this machine for local model servers
node tools/agent-bus/server.mjs bench               # bench the enabled runners against fixed prompts
```

`share` scrubs the note to problem-shape locally and prints a prefilled issue
URL — nothing is ever sent automatically, and you are the gate. `lessons`
fetches the published feed and prints it labelled UNTRUSTED; a lesson becomes
a rulebook rule only when a person moves it there. The contract lives in
[`lessons/README.md`](../../lessons/README.md). `discover` probes the
well-known local ports for model servers (see
[`discover.mjs`](./discover.mjs)) and prints disabled draft entries for
`runners.json` — discovery never enables anything, and the probe never
leaves this machine. `bench` costs real model minutes (it asks every enabled
runner the same three prompts and has the judge runner grade the answers), so
it runs on your ask, not on any agent's. It never deletes anything: a clear
loser is printed as an `ollama rm` command for you to run or ignore, and
delete suggestions only appear when the machine itself qualifies. The
contract lives in [`bench.mjs`](./bench.mjs).

## Spaces — each app build lives in its own place

One board for everything was a transition shape. Register the apps the hub
builds and each gets its own board, lock, agents, messages, blockers and queue:

```powershell
node tools/agent-bus/server.mjs project_add orbitfall "C:/Users/.../orbitfall"
node tools/agent-bus/server.mjs projects
node tools/agent-bus/server.mjs project_remove orbitfall
```

The hub window grows a Spaces bar — `?p=orbitfall` shows that app's bus and its
forms write there (as a one-shot CLI child with `AGENT_BUS_PROJECT` pointed at
the app's root). The rulebook, the how-we-work model, the hardware panel and
the context budget stay on the hub's own page on purpose: they are the hub's
learning, not any app's, and an agent on one app never pays to read another
app's facts. The registry lives beside the state inside `.git` — it holds real
paths from this machine, so it is never committed. Workers remain the hub's
own (they run in the hub's window process); the page says to point
`AGENT_BUS_PROJECT` at the app and run `work` there instead. The contract
lives in [`projects.mjs`](./projects.mjs); a vanished app root degrades to the
hub's own page with a note, never an error.

## The tools

| Tool | Purpose |
|---|---|
| `register(name, lane)` | Claim a name. Do this first. |
| `agents()` | Who is active, and who holds the tree. |
| `claim_tree(path, reason, minutes)` | Exclusive claim. Refuses and names the holder. |
| `release_tree()` | Give it back. Do not hold it while idle. |
| `send(to, message)` | To a name, or `"all"`. |
| `inbox(include_read?)` | Your messages; marks them read. |
| `note(key, value)` | Post a durable fact, overwritable by key. |
| `board()` | Every fact, newest first. |
| `capable(capabilities)` | Declare what you can GRANT — `['ollama', 'stripe', 'tree']`. Blocked agents get matched to you by these words. |
| `block(what, needed)` | You are stuck. The bus asks whoever can grant it and hands you any fix the fleet already banked. |
| `unblock(id, how)` | Resolve a blocker; your fix is banked on the board under `fix-…`. |
| `projects()` | The app spaces this bus serves — each gets its own board and queue on the hub. |
| `project_add(name, root)` | Register an app the hub builds. Root must exist on disk. |
| `project_remove(name)` | Deregister an app space; its own bus is untouched. |
| `review(task_id, verdict, notes?)` | Record someone else's read of a DONE task — `approve` or `changes`. The runner who did the task cannot review it. |
| `publish(version, what)` | Record a ship in the space's publish record — what went out the door, and who says so. |

## How it works, and the two decisions that matter

**State lives in the git common dir.** Every worktree has its own working
directory, so a relative path would give thirteen separate buses — worse than
none. `git rev-parse --git-common-dir` resolves to the *main* repo's `.git` from
inside any worktree, so all agents agree on one location without configuring
anything. State is at `<git-common-dir>/agent-bus/state.json`, which is inside
`.git` and therefore never committed.

**A claim is released by process death, not by a timer.** `kill(pid, 0)` sends
no signal — it asks the OS whether the holding process still exists. One server
process is spawned per session, so the process *is* the session. This is exact
where a heartbeat would be a guess: a crashed agent and a busy one look
identical from outside, so anything purely time-based either deadlocks on a
crash or steals the tree from an agent that is mid-rebase. The TTL remains as a
courtesy cap.

CLI claims are the exception and carry no pid — a shell process exits the
instant it finishes, so recording its pid would make every CLI claim look
abandoned. Those fall back to the TTL.

No dependencies: raw JSON-RPC over stdio, so installing it never touches
`package.json`.

## The context budget

A cache read is the model re-reading the conversation, and it happens on every
turn. So a session's marginal price per turn IS its current context size, and
that makes compaction arithmetic rather than taste:

    break-even turns = current / (current - baseline)

```
node tools/agent-bus/context-cost.cjs          where the tokens went
node tools/agent-bus/context-cost.cjs --full   plus per-tool attribution
```

The same numbers render continuously under **The context budget** in the hub
window, and the hub agent files a board note (`context-<session>`) for any LIVE
session already past break-even. It files and stops — nothing compacts itself
(C4).

| file | what it is |
|---|---|
| `token-watch.mjs` | the arithmetic. Text and numbers in, numbers out, no disk. |
| `sessions.mjs` | the disk half: where transcripts live, the scan cache, who is still live. |
| `context-cost.cjs` | the printout, and only the printout. |

Counts taken from the API's `usage` are exact. Counts derived from text length
are approximations at four characters to the token, good enough to rank
offenders and not good enough to bill against. The two are never added.

`HUB_AGENT_WATCH_MS=0` turns the nudge off; `AGENT_BUS_PROJECT` points the whole
watch at another repo's transcripts.

## Tests

```
node tools/agent-bus/e2e-agent-bus.mjs          65 assertions, two real processes
node tools/agent-bus/agent-harness.mjs          33 — the hub agent's matching and dispatch
node tools/agent-bus/token-watch-harness.mjs    46 — the context arithmetic
node tools/agent-bus/edits-harness.mjs          29 — the edit protocol
node tools/agent-bus/lessons-harness.mjs        23 — the cross-install learning seam
node tools/agent-bus/discover-harness.mjs       11 — fleet discovery + the openai runner
node tools/agent-bus/blockers-harness.mjs       24 — blocker matching + the fix-banking loop
node tools/agent-bus/routing-harness.mjs        17 — runner routing from the fleet's own record
node tools/agent-bus/runner-limits-harness.mjs  16 — per-runner output budgets
node tools/agent-bus/worker-tasks-harness.mjs   10 — the task queue's state layer + state-growth caps
node tools/agent-bus/hub-http-harness.mjs       18 — the dashboard's HTTP edge + app spaces + docs panels
node tools/agent-bus/projects-harness.mjs       13 — the app-space registry + cross-space reads
node tools/agent-bus/bench-harness.mjs          22 — the bench contract: never deletes, hardware-gated
node tools/agent-bus/lock-harness.mjs           5  — the state lock's staleness and identity
```

The e2e spawns **two real server processes** and races them for the
same lock, because the failure being prevented is a race and a single-process
test cannot see one. That test immediately found a crashed session deadlocking
every other agent, and the CLI smoke test found shell claims being stolen — both
defects in the first draft.

State is isolated to a temp directory per run; it never touches the real bus.

## The worker

`node tools/agent-bus/server.mjs work local` runs a loop: it takes the next
queued task in its lane, runs it on a runner (`AGENT_BUS_RUNNER`, else
`runners.json`'s `"default"`, else its first enabled one), and writes the
answer back to the queue. Queue work from the hub
window or with `server.mjs task local "title" "the whole prompt"`.

The worker never touches the repo. Local output is a DRAFT that a person or the
orchestrator reviews — an unreviewed model writing into a codebase is how
plausible wrong code gets merged at 3am, and one local draft here already
arrived with four defects in it.

A failure is a RESULT, not a crash: it lands on the queue with the reason, so a
task is never left stuck on "running" with no explanation.

## Picking which agent runs the work

`tools/agent-bus/runners.json` declares every agent the bus may invoke, and the
hub picker offers exactly that list. It is this machine's file and git ignores
it: copy `runners.example.json` and fill in your models. With no file, or a
broken one, nothing runs and the error says which. Three kinds:

- `ollama` — POSTed to `/api/generate`. Nothing to install beyond the model.
- `openai` — POSTed to `<baseUrl>/chat/completions`, the OpenAI-compatible
  dialect LM Studio, llama.cpp, vLLM and text-generation-webui all speak.
  Streamed like the ollama runner, with the same idle watchdog. **The baseUrl
  is loopback-only** — a runner entry is the boundary of what a queued task
  can reach, and that boundary is this machine. `server.mjs discover` finds
  these servers and prints matching draft entries.
- `shell` — spawned with the prompt on **stdin**, for a command-line agent.

**The hub can only run what the file declares.** The form sends an `id`, never a
command. A text box that could hand a shell string to a worker on your machine
is a remote-execution hole with a form in front of it, loopback or not. `shell`
runners are spawned with an argument LIST and no shell, so nothing in a prompt
can be read as an extra argument — and prompts here are written by other agents.

GLM needed no shell runner in the end. `ollama launch claude` presents a model
menu, and GLM 5.3 Flash in it is an ollama **cloud** model — so it answers
`/api/generate` like a local one, under `glm-5.3-flash:cloud`. It is not in
`ollama list` because nothing was pulled, which is why it was once recorded as
unreachable. It is enabled. **Know what that means before leaving it on:** a
cloud runner sends every task prompt to the provider — the prompt is the
outgoing data. Local models never leave the machine; if that matters for a
task, queue it on a local lane instead.

Each runner carries `ctx`, `predict` and `temperature` **measured on this
machine**, and `ollamaOptions()` in `runner-limits.mjs` (imported by `server.mjs`) feeds them to every call. A
runner that declares none gets the previous defaults, so leaving them out stays
safe. The numbers matter most on reasoning models: `predict` has to cover the
thinking **plus** the answer, or `response` comes back empty with the work
stranded in `thinking`.

**Who gets this task is answered from the record, not the label.** Every
finished task stamps which runner ran it and how it ended, so the queue's own
history is the routing table ([`routing.mjs`](./routing.mjs)). Queue a task
without `runner_id` and the reply carries an advisory suggestion with its
reason — pin it with `runner_id` if you agree, ignore it if not, and ignoring
it is also data. A runner on a failure streak is skipped with the reason; a
prompt that would not fit a runner's `ctx` is skipped too; and a cold start
says "no history" out loud instead of dressing habit up as data. `runners()`
shows each runner's measured record, and the hub's delegation ledger renders
the verdicts.

## Handing work to a model

`HANDOFF.md` is the protocol — how to write a spec a model can execute, which
model gets which job, and the failures that shaped both. Read it before
dispatching anything non-trivial.

The short version: **ask for edits, never for the file.** A model returns a JSON
array of `{id, find, replace}`; each `find` must match exactly once, and nothing
is written unless every edit resolves.

```
node tools/agent-bus/edits.mjs --in <model-output> --file <target> --dry
node tools/agent-bus/edits.mjs --in <model-output> --file <target>
node tools/agent-bus/edits-harness.mjs        # 29 cases, all failure modes
```

`edits.mjs` also exports `EDIT_PROTOCOL_PROMPT`, the preamble that gets a model
to answer in this format. Every line of it is a failure that actually happened.

Asking for a whole file back is what mangled a file's UTF-8 once — em dashes and
glyphs silently replaced. Edits keep the blast radius the size of the request,
and a refusal that names its cause is worth more than a rewrite you have to
audit line by line.
