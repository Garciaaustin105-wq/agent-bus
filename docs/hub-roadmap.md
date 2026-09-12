# Hub roadmap — what the hub is becoming

Directives, captured 2026-09-09 during the extraction. Each item is
the hub learning: from mistakes, from measurements, from the fleet's own
history. Order and scope get decided per lane; a lane that has shipped says so
at the top of its section, with the files that carry it.

## 0. The hub is, primarily, an app builder

Everything the hub does serves one job: getting apps built and published by a
fleet of AI agents. That implies a full development lifecycle has to live
somewhere the agents can follow — and that needs RESEARCH first: what it takes
for a full dev team, start to finish, to build and publish an app. The concrete
research lane (decided 2026-09-09): enumerate the steps a real dev team
actually runs — idea, spec, design, build, review, test, release, publish,
monitor, maintain — with, for each step, what it produces and what a
human-only team does that an agent fleet must cover another way. The output
becomes the hub's workflow spine: the stages the board, the lock, the
handoffs and the rulebook hang off of.

**SHIPPED 2026-09-12** as [`docs/workflow-spine.md`](./workflow-spine.md),
rendered live in the hub beside the rulebook. Ten stages, each with what it
produces and the human-only part; the spine's thesis is that the recurring
answer to "what does the fleet cover another way" is the same at every stage —
a human team runs on accountability, a fleet has nobody who can feel blame, so
the hub manufactures attributable artifacts instead (names on the ledger,
reasons attached to decisions, measurements filed by session id). The doc ends
with the honest gap list the spine earns: a review surface on the bus (fleets
are worst at review, and review currently happens off the bus entirely), a
publish record per space, per-app monitoring, and stage tags as data rather
than convention. Those four are the lanes §0's research points at next —
deliberately not started until an incident points harder.

## 1. The rulebook keeps growing — from incidents, not wishes

`docs/build-rules.md` is the hub's learned memory: every rule names the
incident that produced it. As time goes on, every mistake and its fix gets
written back — that is how the fleet speeds up (see G1/G2 in
this repo's rulebook). The bar for a new rule is an incident,
not an idea: rules without incidents are guesses wearing policy's clothes.

## 2. Token-usage watch — BUILT (2026-09-09)

`tools/agent-bus/context-cost.cjs` already reads the Claude transcripts and
reports where tokens went (cache reads, images, long threads). The hub should
render this continuously — what was spent, where, on what — and turn the
findings into rules (§1) instead of one-off audits. Known levers already
measured: images in the main thread (~27× a text file), stale long-running
sessions (~9× price per turn), whole-file model rewrites (see edits.mjs).

**What shipped.** The arithmetic came out of the report and into a contract so
it could be rendered continuously instead of printed once:

| file | what it is |
| --- | --- |
| `token-watch.mjs` | the contract — text and numbers in, numbers out, no disk |
| `token-watch-harness.mjs` | 46 checks, run with `node tools/agent-bus/token-watch-harness.mjs` |
| `sessions.mjs` | the I/O half — finds the transcripts, caches the scans, decides who is still live |
| `context-cost.cjs` | now the printout and nothing else; it calls the contract |
| `hub.mjs` | "The context budget" panel in the hub window |

Two decisions worth keeping. **Counts from `usage` are exact and counts from
character length are approximations, and the two are never added** (D4) — the
report says which is which. **A full scan here is 110 MB and about 400 ms**, so
`sessions.mjs` caches per file on mtime+size behind a 30-second TTL; a watch
that is itself the most expensive thing in the room proves the opposite of its
own point.

### 2a. Teach agents when to auto-compact — BUILT (2026-09-09)

The hub should learn, from the transcripts it already reads, WHEN a session
should compact — and tell the agent to do it. The signal is in the data:
per-turn context cost climbs long before anyone notices (H5's 9,720-turn
session ran at 539k tokens a turn against a 57k fresh-session baseline). The
hub watches each agent's context curve and nudges compaction at the point
where summarizing beats paying — before the expensive turns, not after the
budget is already burned. Facts the session still needs (open claims, next
step, handoff) go to the board first, so the summary lands on a clean
context.

**What shipped.** The nudge is not a threshold somebody chose. A cache read is
the model re-reading the conversation, and it happens every turn, so a
session's marginal price per turn IS its current context size — which makes
compaction arithmetic:

    break-even turns = current / (current - baseline)

At 539k against a 57k baseline that is 1.1 turns: the session pays for the
compaction it did not do before it finishes answering. At 70k it is 5.4 turns.
At 60k it is 20. Nobody picked those numbers.

`noteExpensiveSessions()` in `agent.mjs` runs at the end of each poll (every
five minutes, `HUB_AGENT_WATCH_MS=0` to disable) and files a board note for
every LIVE session past break-even. Three things it deliberately does not do:

- It does not compact anything (C4). It files the measurement and stops.
- It does not send a message. The advice is "summarise this conversation", and
  a message lives inside the conversation being summarised — taking the advice
  would destroy the advice. A board note survives it (F2).
- It does not name an agent. Nothing joins a bus registration to a transcript
  file, so the note is keyed by session id. A wrong name on a correct
  measurement is worse than no name (C1).

"Live" is ninety minutes since the transcript was last written. The first cut
had no liveness rule at all and cheerfully told ten long-dead sessions to
compact; `nudge-says-nothing-about-a-session-nobody-is-in` in the harness
pins that.

## 3. Which AI suits which task

The hub needs to know what each AI is best at, and route accordingly —
`runners.json` (ctx/predict/temperature, measured per machine) and
`HANDOFF.md` (which model gets which job) are the seeds. The target: the hub
answers "who gets this task" from data, not habit, and records when a model
outperformed or failed its assignment so the mapping improves.

**SHIPPED 2026-09-12.** The routing table is the queue's own history: every
finished task stamps which runner ran it and how it ended, and
`routing.mjs` reads that record. Three surfaces: `task_add` without a
`runner_id` carries an ADVISORY suggestion with its reason attached (pin it or
ignore it — an automatic router that silently reassigns work is a failure
nobody can see, and an ignored suggestion is also data); `runners()` shows
each runner's measured record, so "which AI suits which task" is answered by
the list itself; the hub's delegation ledger renders the per-runner verdicts.
The gates are dumb and explainable, same as the blocker matcher: disabled
never recommended, a prompt that would not fit `ctx` is skipped (four
characters to the token, the token-watch convention), three trailing failures
skip a runner until it proves itself, and among survivors the best recent
record wins with failures costing double — a failure costs the reviewer their
time too. Cold start says "no history" out loud. `routing-harness.mjs`, 17
checks.

## 4. Local-AI benchmarking and discovery (only on the user's ask)

When the user asks for a local model:

- The hub can ask a cloud AI to find the best locally-downloadable models for
  THIS machine's requirements.
- Local candidates get run against each other for speed and quality — with
  cloud-run AI as the reference baseline to break down against.
- Test and delete: a model that loses its bench gets deleted, until the best
  one for the system is found. The user's disk is not a museum.

Hard gates (deliberate):

- **Only on the user's ask.** The hub never downloads a model unrequested.
- **Suggestions only when the system qualifies.** The hub may suggest local
  models (Hugging Face and similar) only if system requirements are enough for
  even a small local model; below that it says so instead of suggesting.

**SHIPPED 2026-09-12** as `tools/agent-bus/server.mjs bench` plus the pure
contract in `bench.mjs` (22 harness checks). The enabled local runners answer
the same three fixed prompts — a JSON-edit task, a strict three-bullet
summary, and a queue-claim reasoning question, each scoreable for
instruction-following rather than taste — and the judge runner (the cloud
model, `judge: true` in `runners.json`) scores every answer on one parseable
line. The judge is benched too but pulled out of the ranking: it is the
reference row, because a cloud model beating local ones says nothing about
any local choice. Quality ranks first, wall-clock speed breaks ties, and one
row is the aggregate of a runner's three runs — the first live run printed a
row per prompt and ranked a model against itself three times, which the
harness now pins. Live on the 16 GB machine: gpt-oss took the bench at 8.3/10
(36 chars/s), qwen-small 8.0/10 at 104 chars/s, and the bench itself suggested
`ollama rm codestral` (5.0/10, only 1.5× the winner's speed) — as a command
for a person, never executed. "Test and delete" is advice only: the render
says "deletions are yours to run, nothing here deletes", the winner is never
suggested, and a loser that answers twice as fast as the winner keeps its
place. Suggestions carry a hardware gate (`qualifiesForSuggestions`): under
8 GB of RAM the machine is told so instead of getting a shopping list, and
the tiers read the real GPU so a 16 GB card claims 20B — measured here, a 20B
MXFP4 model ran fully resident at a 32k window — and not 32B. `--ask` sends
the judge only the repo's own generic bench prompts and a hardware summary;
no task content, files or board facts ever leave the machine. Local tasks now
record their exact `usage` from the model server on the task record — the
savings side of the ledger, billed $0, kept separate from the transcript-side
counts `context-cost.cjs` measures, because exact and approximate are never
summed.

## 5. The hub as its own AI agent

The end state: the hub is itself an agent — trained for quick responses,
token/time savings, and a space where workflow happens automatically. It asks
agents at startup what tools they have and what unlocks they need, matches
blockers to whoever can grant them, answers reported blocks with fixes the
fleet already saved, and keeps the workflow moving without the person
repeating themselves.

**Half shipped 2026-09-12 — the "what tools do we have" half.**
`server.mjs discover` probes this machine's well-known local ports for a
model server (Ollama, LM Studio, llama.cpp, vLLM, text-generation-webui —
one OpenAI-compatible probe shape covers them all) and prints ready-to-paste
draft entries for `runners.json`. The three rules pinned by
`discover-harness.mjs`: the probe points at this machine only (loopback
guard, and it fires before the fetch), nothing-answering is a valid answer —
a cloud-only install is a normal shape, not an error — and every draft ships
DISABLED, because discovery is evidence and `runners.json` is authority. The
matching `"openai"` runner type in `server.mjs` makes what discovery finds
actually runnable, with its baseUrl loopback-guarded at run time too.

**The other half shipped 2026-09-12 — blockers to solvers.** Three verbs:
`capable([...])` declares what an agent can GRANT (asked at every register,
kept across restarts); `block(what, needed)` reports being stuck, and the bus
matches the need against declared capabilities and messages the solvers — the
person never relays "agent X needs Y from agent Z"; `unblock(id, how)` banks
the fix on the board under `fix-…`, so the next agent that hits the same
shape is handed the answer at report time instead of asking again. The
matching is deliberately dumb — keyword tokens, deterministic, no model,
because the hub agent is rules rather than judgment and a match that can be
explained is worth more than a clever one nobody can audit. The contract is
pure in `blockers.mjs` (`blockers-harness.mjs`, 24 checks); the loop that
matters — block → unblock → a second block of the same shape gets the banked
fix — is pinned by name. §5 is fully shipped.

## 6. Each app build lives in its own place

One board for everything was a transition shape, not the product. Each app
being built gets its own space — its own board, its own notes, its own lock,
its own handoffs — so agents working on one app never see (or pay to read)
another app's facts. The seams for this already exist in the bus
(`AGENT_BUS_PROJECT` points a bus at a project root; state lives in that
project's `.git`), so the hub's job is the layer above: register the apps it
builds, switch between them, and route every claim/note/message to the right
place. Cross-app facts — the rulebook, the model-task fit, the token lessons —
stay shared, because those are the hub's own learning, not any app's.

**SHIPPED 2026-09-12.** `projects.mjs` is the registry: the apps the bus
serves, named by slug and anchored at a real root that must exist at
registration time. Three verbs (`projects` / `project_add` / `project_remove`)
and a Spaces bar in the hub window — `?p=<name>` renders that app's bus, and
the window's forms write there through a one-shot CLI child with
`AGENT_BUS_PROJECT` aimed at the app's root, which is the same seam every
other cross-project writer uses. The registry lives beside the state inside
`.git` because it holds real paths from this machine — never committed, which
is the privacy directive turned into a file location. What each space does NOT
get is a copy of the hub's learning: the rulebook, the how-we-work model, the
hardware panel and the context budget stay on the hub's own page, and a
project view says so instead of duplicating them. Workers also stay the hub's
own — they run inside the hub's window process, so a project queue is drained
by running `work` against that root directly, and the page says how. Two
degradations are deliberate: an unknown `?p=` and a vanished app root both
fall back to the hub's own page with a note (a stale registry is cosmetic;
an error page is not), and reading another project's bus is strictly
read-only. `projects-harness.mjs` (13 checks) pins the contract and the
registry; the hub-http harness pins the switcher, the cross-space form posts,
and that two spaces with colliding task ids still show different work.

## 7. The hub learns from every user's fleet — problems only, never user data

When the hub ships to other users, each installation keeps learning the way
this one does (§1: incidents into the rulebook). But the learning should not
stop at one user's machine: the hub gathers what happened across ALL users —
which problems occurred, where, and which fixes worked — so a bug one user
hits becomes an answer every other user's hub already holds.

**The boundary, deliberately hard (decided 2026-09-09): problem-wise, not the
actual information.** What travels between installations is the pattern — the
problem, its cause, its fix, the rule it earned. What NEVER travels is the
actual information behind it: user content, customer data, file contents,
credentials, anything about the user's own business. The lesson leaves the
building; the facts that produced it do not. This is the same line the
rulebook already draws between a rule (shipped in the file) and the incident
behind it — and it is a build rule, not a hope: anything crossing
installations gets scrubbed to its problem shape first, and there is no bulk
path for raw facts.

**SHIPPED 2026-09-12** as `tools/agent-bus/lessons.mjs` plus two CLI verbs,
both human-gated on purpose:

- `server.mjs share <board-key>` scrubs a board note to problem-shape
  LOCALLY (paths, URLs, emails, the project's own name) and prints a prefilled
  GitHub-issue URL. Nothing is ever sent — opt-in means a person reads the
  draft and submits it, because a mechanical scrub cannot understand a
  sentence and the human is the only gate between this machine's facts and a
  public issue.
- `server.mjs lessons` fetches `lessons/lessons.json` (one fixed read-only
  URL, https only, size-capped, ten-second timeout) and prints it labelled
  **UNTRUSTED**. It is deliberately NOT an MCP tool: the text is written by
  strangers, and an agent that pulls it unprompted is ingesting untrusted
  instructions. A lesson becomes a rulebook rule only when a human moves it
  there — nothing fetches, merges or writes it automatically, and there is no
  bulk path for raw facts in either direction.

`lessons-harness.mjs` pins the scrub (a real path or name must not survive),
the refusal semantics (a malformed or oversized feed is refused, never
partially rendered) and the injection boundary (untrusted text renders as
labelled data and nothing else).