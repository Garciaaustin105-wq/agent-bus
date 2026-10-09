# Spec — the review surface (idea #2 of the 2026-10-09 brainstorm)

> Brainstorm line, verbatim: "review surface on the bus — reviewable artifacts
> on the queue; reviewer sees the diff in the dashboard task page, one-click
> approve, verdict stamped on the record."

The queue's worker never touches the repo — its result is a DRAFT, and for
code the draft is a batch of JSON edits (`edits.mjs`'s protocol) sitting as
plain text in `task.result`. The reviewer can't SEE what they are approving:
they must read raw JSON and imagine the find/replace against a file. This
spec makes the draft reviewable and the approval a record — the same verdict
machinery (`review`, `apply`), now aimed at something the reviewer can see.

Two entry points, one artifact shape:

1. **The task page renders the draft** — parse the result for the edits batch
   (pure `extractEdits` already recovers fenced/buried JSON), render each edit
   as BEFORE (red) / AFTER (green) at its line, and count any that fail to
   resolve against the file AS IT STANDS. Parse is per render — existing state
   gains nothing.
2. **One click applies it** — a form action runs the batch server-side
   (`applyEdits` + write, all-or-nothing), stamps the task's review timeline
   `{verdict: "approve", via: "task-page", by: <hub viewer's name — see
   below>}`, and records the applied batch on the task as an ARTIFACT.
   Refusals print the edit protocol's REFUSE list; nothing is written,
   nothing is stamped.

## The artifact

`task.artifacts[]` — appended, capped at 5 (the bus's cap pattern: history
cap 5, finished 100; the cap drops the OLDEST and the drop is the accepted
cost):

```
{ kind: "edits", file: <path as applied>, eol, by, at,
  applied: [{ id, line, delta }],                  // what resolved, no text
  edits:   [{ id, find, replace }] }               // capped per edit
```

The `edits` array is the RENDERED diff and the audit together — find/replace
are the reviewable text. Per-edit cap: 4,000 chars each field, a field over
the cap truncated with an explicit `…truncated` marker rendered (never a
silent join). A rejected batch records NOTHING — an artifact exists only when
the file changed (or a dry run happened — and a dry run records nothing
either, the page already shows what --dry would say live).

Recording happens ONLY at apply time. The page parse is a view; the artifact
is what the ACT of approval left behind.

## The `edit` verb (MCP + CLI) — the agent-driven path

The person in the browser is one reviewer; a lane is the other. A new verb
(29 → 30 tools, e2e pin moves):

    edit <task> <file> [--in <model-output.json>] [--dry]

- MCP tool `edit`: `{ task_id, file, edits?, in? }` — `edits` as a literal
  JSON array on the call, or `in` naming a file of model output (the
  orchestrator's usual shape). Exactly one must be present.
- CLI: `edit <task> <file> --in out.json [--dry]` — index-parsed flags, the
  runner-limits lesson; file path relative to `PROJECT_ROOT`.
- Behavior: same `extractEdits` → `applyEdits` → write path, the same
  all-or-nothing rule, self-edit guard BEFORE any read, and the artifact
  appended on success. A refused batch (zero matches, non-unique, overlap,
  no-op) returns the REFUSE list and records nothing.
- Unknown task refused with `tasks()`'s pointer; ANY task status accepts the
  artifact (a lane finishes the task, then edits — the task is the work item,
  not a status gate).
- The dry run answers with the resolution so a lane can pre-check — and
  records nothing, same as the page.

## Security

- **A file is a leaf in the project.** Resolved against `PROJECT_ROOT`;
  `..` traversal or an absolute path outside the root is refused before
  anything is read. The verbs write code in the repo they serve — nowhere
  else.
- **Model output is untrusted text rendered in HTML.** Every find/replace,
  file path and REFUSE line goes through escaping BEFORE any slice — the
  hub's slice-before-escape lesson made a stored `<script>` render as a tag
  once already. Per-edit truncation slices AFTER escaping too.
- **The act of approval stays a human-gated act.** The page's apply action is
  a form POST by a person at the hub — same `back`-field, same-site pattern
  as the existing review form; the hub adds no API a random page can call.
  The steward's ticks never edit code, never apply (C4 unchanged).
- **The self-edit guard keeps its meaning.** Target inside the bus's own
  `tools/agent-bus` refused before any read — dry run included — unchanged
  from the edits protocol.
- **No lock coupling.** `applyEdits` writes the standing file whether or not
  a tree claim covers it, exactly as `edits.mjs` always has; the claim lock
  is an agreement between agents about CHECKOUTS, not a gate on the protocol.
  Stated here because now it is stated, not implicit.

## What it does NOT do

- Never intercepts a session's own Edit tool. Direct in-session edits are
  not the bus's records — adoption of this path is the caller's choice; the
  queue-driven lane flow is where it earns its place.
- Never marks a task `done` or changes its status. Applying edits is a
  REVIEW act; the queue's lifecycle is untouched.
- Never resolves a batch partially, silently truncates content without a
  rendered marker, or re-renders a parse that failed as if it succeeded —
  an unparseable draft renders as the raw result, unchanged, with a quiet
  line saying no batch was found.
- The `review` verb's refusal of self-review (task.runner === me) is
  unchanged. The page's apply stamps `via: "task-page"` on the SAME timeline
  review and apply share — one timeline, not two (the apply verb's precedent).

## Dashboard

The task page gains, under the result panel:

```
┌─ draft batch ────────────────────────────────────────────────┐
│ E1  line 412   +37 chars          from <file>                │
│   ─ BEFORE  find ──────────────── (red)                      │
│   + AFTER   replace ───────────── (green)                    │
│ ... per edit, refusal lines in the protocol's own format ... │
│         [ apply batch ]   [ changes needed ]                 │
└──────────────────────────────────────────────────────────────┘
```

The batch parse is best-effort per render: no `edits` in `task.result` → the
panel is absent, the page stands exactly as it does today. Existing tasks
whose results are prose show prose — the regression bar.

## VERIFY

- **hub-http-harness** gets the page group: batch panel renders for a
  seeded edits result; ABSENT for a prose result; a `<script>` planted in a
  `find` renders escaped (the harness feeds the hostile string and asserts
  the page contains no unescaped tag); truncation marker present on an
  over-cap field; refusal list rendered for a batch that cannot resolve.
- **e2e-agent-bus** gets the verb group (stdio, real child): 30 tools;
  `edit` happy path records the artifact and writes the file in a REAL
  fixture repo (the worktree-harness pattern); refused batch (non-unique
  find) — nothing written, nothing recorded; unknown task refused with the
  queue pointer; dry runs record nothing; cap 5 drops the oldest; traversal
  refused; `review` after `edit` still refuses self-review.
- Gate stays 19 suites; totals move (509 → 509 + additions as landed).
  README suite tables update in the same commit.

## Acceptance

- A reviewer opens a DONE task with an edits draft and reads the diff — not
  JSON — then acts with one click, and the verdict lands on the same review
  timeline the verbs stamp.
- A lane applies another's draft with one MCP call and the artifact records
  what changed, at which lines, by whom.
- A fleet that never opens a task page and never calls `edit` behaves
  identically — no new state, no new verbs in its path.