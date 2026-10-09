# Recall and care — history, search, health, dependencies, and the caretaker

Captured 2026-10-08. Five additions, one theme: the bus remembers what a
session leaves behind (the handoff verb, v0.1.3), but it cannot help a next
agent FIND that knowledge, cannot tell anyone the bus itself is decaying, and
cannot hold multi-step work apart. Each section is a contract; every shape
here is pinned by a harness before it ships.

## 1. Note history — superseded facts are kept, not dropped

**SHIPPED 2026-10-09** as the `archive` store in `server.mjs` (`keepHistory`, shared with the handoff verb's own history block; 5-check pins in recall-harness).

`note` (and `miss`) overwrite by key today; the prior value is discarded.
From now on an overwrite keeps the prior entry in `state.archive[key]` —
same shape the handoff verb already uses: newest-first, cap 5, each carrying
`supersededAt` and `supersededBy` alongside the cloned prior entry
(`value`, `by`, `at`, plus any note fields). Fresh installs and old states
get the object lazily (`state.archive ||= {}`), the way `state.handoffs`
already does.

## 2. `history(key)` — read the stack under a key

**SHIPPED 2026-10-09** as an MCP verb + `server.mjs history <key>` in `server.mjs` (numbering matched to the pages: #1 is the oldest kept entry). Pinned in recall-harness.

New MCP verb + CLI verb. Read-only, takes one `key`. Returns the ACTIVE
entry (plain note or handoff — `value` verbatim either way) and every kept
prior entry, newest first, each named with its set-at/author and its
superseded-at/by. Nothing under the key says so, plainly — and does not
invent a prior author the bus has no record of.

## 3. `search(query)` — check instead of recall

**SHIPPED 2026-10-09** as an MCP verb + `server.mjs search "<text>"` in `server.mjs` (`searchBoard`, active first, limit-capped). Pinned in recall-harness.

New MCP verb + CLI verb. Case-insensitive substring search, deliberately
dumb and deterministic (the blocker matcher's rule: a match that can be
explained is worth more than a clever one nobody can audit). It scans the
ACTIVE board, then kept handoff history and note history, and returns per
match: the key, whether the hit is active or how far back in history, and
the matched line trimmed. Default cap 20 hits (`limit` to change). An empty
query is refused; zero hits is a normal answer, not an error.

## 4. `health` — the bus checks itself, as data

**SHIPPED 2026-10-09** as `health.mjs` (`checkHealth`/`renderHealth`) + the `health` MCP verb + `server.mjs health`; the dashboard renders the same contract on every space page. Pinned in recall-harness.

New contract `health.mjs` (pure: state in, findings out, no disk) consumed
by TWO callers — the `health` verb and the caretaker (§6). One check, one
finding. Thresholds live in the module as named constants:

| kind | question | threshold |
| --- | --- | --- |
| `stale-runner` | a task says `running` but its runner's session went cold | lastSeen over 2h old |
| `queued-backlog` | work is queued that nobody is picking up | `at` over 24h old |
| `draft-pending` | a model draft waits on a human apply | `doneAt` over 24h old |
| `untaken-handoff` | an active handoff with an empty taken chain | `at` over 48h old |
| `open-block` | an OPEN block nobody resolved | `at` over 72h old |

The tree lock is NOT a check: its liveness is process-proven (`holderAlive`),
so a dead holder is already invisible and a live one is a claim, not decay.
A clean run renders `No findings.` followed by the counts of everything it
actually checked — silence must say what it stayed silent ABOUT.

## 5. `depends_on` on tasks — the queue learns order

**SHIPPED 2026-10-09** in `server.mjs` (validation in `task_add`, `unmetDeps` in `claimNextTask` and `tasks()`). Pinned in recall-harness.

`task_add` accepts `depends_on`: an array of task ids, deduped, capped at
10. Every id must exist in the queue at add time — a typo'd dependency that
silently never unlocks is a convention pretending to be data, so unknown ids
are refused with the known ids listed. Rules:

- A task is **blocked** while any dep is not `done` — `queued`, `running`,
  `draft`, `failed` all block (a draft is an answer nobody has applied yet,
  which dependents must not build on).
- A dep that is gone from the queue (pruned finished history) counts as
  done — the prune only drops finished tasks, so a missing dep was a meeting
  dep, not a blocked one.
- `claimNextTask` never claims a blocked task; the skip is visible in the
  task's own line, not silent. `tasks()` renders each task's unmet deps.

## 6. The caretaker — the bus files its own findings

**SHIPPED 2026-10-09** as `runCaretaker` in `agent.mjs` (dedupe/re-nudge/clear in `state.caretakerSeen`, `HUB_AGENT_CARETAKER_MS=0` to disable) INCLUDING the routing paragraph below it. Pinned in recall-harness incl. a child-process check for the disable.

The hub agent (`agent.mjs`) already watches one thing (expensive sessions).
It gains one more: every poll it runs `checkHealth` on its space and files
NEW findings on the board itself, as notes under `caretaker-<slug>` keys,
by the agent's own registered name. Rules it inherits from the nudger:

- It files and stops (C4). It does not retry the task, close the block, or
  take the handoff — the finding sits where its owner will see it.
- Dedupe by fingerprint (kind + subject), with the detection timestamp in
  the note — the finding is `first seen <at>`, so re-filing every poll is
  needless. A finding that persists is re-filed at most daily so it stays
  near the top of the time-sorted board; one that clears is filed as
  cleared under the same key, because a caretaker that never says "this
  resolved itself " is a board full of stale alarms.
- The state of what it has seen lives beside the state file
  (`state.caretakerSeen`), so a hub restart dedupes too.
- **Routing (decided 2026-10-08): the bus works with the agents, not for the
  person.** A finding with a knowable, currently-registered owner is ALSO
  sent to that owner's inbox (`send`-shaped, delivered on their next bus
  read) at the moment it is filed: a stale task's runner, an untaken
  handoff's author. The board note stays as the durable record; the poke is
  delivery. Ownerless findings — a dead lane, the human's own review gate,
  an unmatchable block — rely on the note alone, and a finding is never
  routed to a pruned or absent name: a message that will never be read is
  worse than an unnoticed note.

## 7. Ask the bus — and the caretaker feeds the same triage

**SHIPPED 2026-10-09** in `hub.mjs` + `steward.mjs` (`busDigest`/`askPrompt`/`askBus` with an injected ask seam; `isTriageFodder` extends the steward's triage paths to caretaker notes). Pinned in hub-http-harness + steward-harness.

Two AI-layer additions decided after §1–6 were committed, recorded here for
completeness of the spec:

- **Ask-the-bus box** (hub + space dashboard pages, interactive only): any
  signed-in viewer may ask a natural-language question about a space's
  current state. The page builds a bounded digest — task prompt and result
  bodies never leave the state file — and asks the configured steward
  runner. Replies are reply-only and write NOTHING: board, queue, handoffs,
  archive all untouched after asking. An empty question is refused at zero
  spend; a transport failure or empty reply is shown as an error, never
  invented around. Reply memory is per-space, so one space's question never
  overwrites another's answer.
- **Caretaker notes go through the same triage.** The steward's proposal
  pipeline treats `caretaker-…` notes as triage input the same way it treats
  defect/problem/audit notes; Cleared records are excluded (a resolution is
  a record, not a proposal), and the triage never supersedes a caretaker
  note — the caretaker owns its own keys.