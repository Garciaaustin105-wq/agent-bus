# Docs: per-app monitoring (`monitor.mjs`, the `monitor` verb)

Brainstorm #3: *the spine's `monitor` stage has no verbs yet — per-space runner
failure-rate over time, a stuck-task detector beyond `health`'s static checks,
and a "hasn't shipped in N days" observance the caretaker files rather than
nags about.*

The shape of the work is the shape health.mjs already set (docs/recall-and-care):
**one pure contract, no I/O**, consumed by three surfaces —
- a read verb (`monitor`) that answers on demand, in the caller's own space,
- the caretaker (agent.mjs), which files NEW kinds of findings the same way it
  files health's, under the same dedupe/routing/cleared rules,
- the hub's per-space strip (hub.mjs), so "is anything stuck over there?"
  includes the rate and the ship age without opening the space.

Nothing new is invented where state already answers: finished tasks carry
`at`, `startedAt`, `doneAt`, `status`, `runner`, `retryOf`; the review surface
gave done tasks a `reviews[]` timeline; `state.publishes[]` is the ship record
the `publish` verb keeps.

## The contract — `tools/agent-bus/monitor.mjs`

Pure like health.mjs: state in, findings and numbers out, no disk. Thresholds
are named constants, each a stance, none tunable knobs — a wrong number is
moved by a finding, not a config file.

```js
export const RUN_OUTLIER_MULT = 3;        // × median finished duration
export const RUN_OUTLIER_FLOOR_MS = 2 * 3600_000;  // never flag shorter than 2h elapsed
export const RUN_MEDIAN_MIN_SAMPLES = 5;  // fewer finished tasks = no baseline yet
export const UNREVIEWED_MS = 7 * 86400_000;        // done, unreviewed, 7 days
export const NO_SHIP_MS = 14 * 86400_000;          // 14 days with no publish
export const NO_SHIP_MIN_FINISHED = 1;    // activity since the last publish
```

### 1. Failure rate, over the retained record

`taskStats(state)` reads the tasks the prune still holds (last 100 finished,
plus everything live), splits finished (`done` + `failed`), and returns:

- `total`, `failed`, `rate` — the overall rate over the retained window,
- `perRunner` — the SAME numbers grouped by `t.runner` (the runner field is
  the claim side's identity, which is the thing that can fail repeatedly),
- `span` — how far back the retained record reaches
  (oldest finished `doneAt ?? startedAt ?? at` → now), so the report says
  "42 tasks over 9 days", never an unqualified percentage.

It is honest about its window by construction: the prune caps kept history at
100 finished tasks, so anything older is not claimed as counted. If the
retained window someday proves too short, a rolling counter beside
`state.publishes` is the v2 move — not taken now, because the state a
monitoring layer invents that nothing reads is decay of its own kind.

### 2. Stuck-task detector, beyond the static checks

`monitorFindings(state, { now })` extends — never replaces — checkHealth's
kinds, because caretaker dedupe is on kind+subject and cleared-filing shares
one table:

- `long-running` — a task wearing `running` whose elapsed hold is more than
  RUN_OUTLIER_MULT × the median finished duration (computed over retained
  finished tasks that carry both `startedAt` and `doneAt`, floor of
  RUN_OUTLIER_FLOOR_MS so a two-hour task is never flagged; at least
  RUN_MEDIAN_MIN_SAMPLES samples or there is no baseline and the check stays
  silent). health's stale-runner already answers "is the runner gone"; this
  answers "is the task itself past any reasonable time" — a task can be
  stuck under a runner who is alive and silent.
- `unreviewed-done` — a task `done` for more than UNREVIEWED_MS with no
  `reviews[]`. Done is not finished (the hub's own strip has said so since
  review debt appeared); the caretaker should say it too, because the human
  review gate is exactly the kind of ownerless wait that only the board sees.
- `no-ship` — the last entry in `state.publishes[]` is older than NO_SHIP_MS
  **and** at least NO_SHIP_MIN_FINISHED task has finished since it. The
  activity clause is the whole point: a quiet space is not decay, a space
  that keeps finishing tasks while nothing ever ships is. Publishing stays
  user-gated everywhere (npm, deploys, releases) — the finding is an
  observance, never a nudge, exactly as brainstormed: it files and stops,
  and its subject is stable (`no-ship:<last publish version>` or
  `no-ship:none` where the space has never published) so clearing works when
  the publish lands.

Every finding is `{ kind, subject, detail }` — same shape as health's, same
render, same caretaker machinery. `long-running` routes to the task's runner
under the §6 rule (only when the runner is currently registered);
`unreviewed-done` and `no-ship` are ownerless (the human review gate, the
human publish gate) and rely on the note alone.

### 3. The report — `renderMonitor(state, { now })`

One screen, audit-complete like health's:

    MONITOR — 42 finished over the last 9 days, 6 failed (14%)
      some-worker   23 finished · 4 failed (17%)
      other-worker  19 finished · 2 failed (11%)
    2 finding(s):
      LONG-RUNNING — task t7 …
      NO-SHIP — last publish v0.1.4 now 21 days old, 12 tasks finished since.

An empty space renders `quiet` rather than 0%, because dividing by zero is
how fake precision starts.

## The verb — `monitor` (read)

- MCP tool `monitor` (tools 30 → 31): no required args, optional `space`
  (a name from the registry) to READ another place's numbers — read-only via
  `readStateForRoot`, cross-space reads are read-only reads everywhere else
  the hub does them too. No args answers the caller's own space through
  withState, pruneAgents + touch first (health's precedent: the answer is
  about the bus as it is).
- CLI `monitor` — no args, own space (`AGENT_BUS_PROJECT` picks the space,
  the same seam everything else uses). A cross-space read from the CLI is
  the same verb with the environment pointed at the app root.

## Caretaker wiring (agent.mjs)

`runCaretaker` computes `monitorFindings(state, { now })` in the SAME
withState pass it already runs checkHealth in, and feeds the union through
the existing loop — dedupe on kind+subject, daily re-file while it holds,
CLEARED under the same key when it stops holding, §6 owner routing. The
caretaker therefore monitors its own space's queue decay, review debt, and
ship age with zero new infrastructure: the monitor contract is the third
source of findings, not a second caretaker.

## Hub strip (hub.mjs)

`healthOf(state)` gains `failRate` (from the finished/failed split its task
list already reads) and `lastShip` (newest `state.publishes[]` entry's
version + at) so the spaces strip renders, per app:

    lowvoltage (2 agents · 3 queued · 1 running · 8% fail · ship 4d)

Only present when there is data — a space in silence shows exactly what it
always did, and never a 0% computed over nothing.

## Security / boundary

Read-only. The monitor writes nothing, routes nothing itself, and exists
inside the caretaker's existing write discipline (file, dedupe, clear). The
cross-space `space`-arg read is a read of another space's state file via the
registry — the same trust boundary the hub's Spaces bar already exercises;
no cross-space write is added anywhere here.

## Non-goals

- No auto-remediation, ever (C4 standing rule: file and stop).
- No metric history file. The retained task record is the history.
- No notification for a no-ship finding — ownerless by design; the human
  publish gate is not the caretaker's inbox.
- Does not touch the token watch (separate contract, separate file).

## Verify

- `tools/agent-bus/monitor-harness.mjs` — pure fixtures: failure-rate split
  per runner; span honesty (a one-old-task window does not read "7d" from a
  two-hour-old first task); `long-running` fires past 3× median and does NOT
  fire with < 5 samples or < 2h elapsed; `unreviewed-done` fires at 7d and
  not at 6d, and not when `reviews[]` exists; `no-ship` fires at 14d with
  activity since, does NOT fire on a quiet space or a fresh publish; empty
  state renders `quiet`.
- agent-harness additions: the caretaker files a monitor finding with the
  same key/dedupe machinery, routes `long-running` to a registered runner,
  and files CLEARED when the condition resolves.
- hub-http additions: the spaces strip carries the fail-rate and ship age;
  a hostile runner name in the numbers renders ESCAPED.
- e2e: tools/list pin 30 → 31 ("including the … monitor surface"); a `monitor`
  read over a seeded state returns the rate and the verdicts; cross-space
  read via `space` names a registered app.
- README totals move (gate 19 → 20 suites); a skip stays visible.

## Acceptance

1. The verb answers "how is this queue actually doing" with numbers AND the
   findings, and says what its window is.
2. The caretaker catches a stuck task under a live runner, a done task the
   review gate forgot, and a busy-but-never-shipping space — and goes quiet
   when each resolves.
3. The hub strip carries per-app the two numbers the brainstorm asked for:
   the failure rate and the ship age.
4. Gate stays "N passed, N failed" green: 20 suites.