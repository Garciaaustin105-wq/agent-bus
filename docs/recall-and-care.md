# Recall and care — history, search, health, dependencies, and the caretaker

Captured 2026-10-08. Five additions, one theme: the bus remembers what a
session leaves behind (the handoff verb, v0.1.3), but it cannot help a next
agent FIND that knowledge, cannot tell anyone the bus itself is decaying, and
cannot hold multi-step work apart. Each section is a contract; every shape
here is pinned by a harness before it ships.

## 1. Note history — superseded facts are kept, not dropped

`note` (and `miss`) overwrite by key today; the prior value is discarded.
From now on an overwrite keeps the prior entry in `state.archive[key]` —
same shape the handoff verb already uses: newest-first, cap 5, each carrying
`supersededAt` and `supersededBy` alongside the cloned prior entry
(`value`, `by`, `at`, plus any note fields). Fresh installs and old states
get the object lazily (`state.archive ||= {}`), the way `state.handoffs`
already does.

## 2. `history(key)` — read the stack under a key

New MCP verb + CLI verb. Read-only, takes one `key`. Returns the ACTIVE
entry (plain note or handoff — `value` verbatim either way) and every kept
prior entry, newest first, each named with its set-at/author and its
superseded-at/by. Nothing under the key says so, plainly — and does not
invent a prior author the bus has no record of.

## 3. `search(query)` — check instead of recall

New MCP verb + CLI verb. Case-insensitive substring search, deliberately
dumb and deterministic (the blocker matcher's rule: a match that can be
explained is worth more than a clever one nobody can audit). It scans the
ACTIVE board, then kept handoff history and note history, and returns per
match: the key, whether the hit is active or how far back in history, and
the matched line trimmed. Default cap 20 hits (`limit` to change). An empty
query is refused; zero hits is a normal answer, not an error.

## 4. `health` — the bus checks itself, as data

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