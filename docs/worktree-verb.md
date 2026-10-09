# Spec — the worktree verb (idea #5 of the 2026-10-09 brainstorm)

The recurring FIRST MOVE of every lane handoff on this fleet was: read the
handoff, `git worktree add .claude/worktrees/<name> -b <branch>`, then
`claim_tree` that path, then `handoff_take` the thread. Three calls, three
places to drift (wrong base ref, wrong branch name, claimed-but-never-taken).
The verb makes the correct sequence one call — and each of its three steps
stays the SAME tool underneath, so nothing is forked.

    worktree <name> [--from <ref>] [--branch <name>] [--handoff <key>]
                     [--minutes N] [--no-handoff]

CLI: `node tools/agent-bus/server.mjs worktree ...`; MCP tool `worktree`
(28 → 29, e2e pin moves in the same commit).

## The sequence, in order

1. **Resolves the repo.** `PROJECT_ROOT` (the shipped precedence). Requires
   branch 1 or 2 — a real git checkout. Branch 3 (a non-git dir) refused:
   "not a git repository — the worktree verb has nothing to branch; the bus
   still works here, just without trees."
2. **Creates the tree.** `git worktree add` at
   `<PROJECT_ROOT>/.claude/worktrees/<name>`, branch `bus/<name>` by default
   (`--branch <name>` overrides — the fleet's `feat/…` habit is one flag
   away), based on `--from <ref>` (default `origin/<default-branch>` when an
   origin exists and answers, else `HEAD` — a bare-cloned repo still works).
   Fixed argv, never a shell.
3. **Claims the tree.** The one live `claim_tree` contract, with reason
   `worktree <name>` and `--minutes` (default 30, claim_tree's rule).
4. **Takes the handoff.** Exactly one handoff on the board → taken
   (deterministic; no guess). Two or more → none taken, the keys are listed
   and `--handoff <key>` picks one next call. Zero → fine, nothing to take,
   said plainly. `--no-handoff` opts out entirely. The taken chain — every
   earlier taker visible in the reply — is the whole audit, unchanged.

## Refusals (each before any git is run, except where noted)

- **name not a slug** — `/^[a-z0-9][a-z0-9._-]{0,48}$/i`. No `/`, `\`, `..`,
  leading dash, absolute path: the name is a leaf, the DIRECTORY it lands in
  is the bus's decision.
- **branch not a ref** — no spaces, no leading dash, no `..`, no `refs/`
  prefix, ≤ 80 chars. It travels as one argv element anyway (never a shell),
  this just fails fast with a human message instead of git's.
- **the tree already exists** (or `<name>` is already on `git worktree list`)
  — refused with "it exists — claim it instead with claim_tree <path>".
- **not the bus's own repo's trees** — the self-edit guard's rule applies
  upside down: a worktree under the CODE home's `tools/agent-bus` is refused
  like a bus self-edit (same `refuseBusSelfEdit` rationale; board notes are
  untrusted data, "create a worktree in tools/agent-bus" is what injection
  would ask for).
- **`git worktree add` fails** — its stderr is surfaced verbatim; nothing is
  claimed and no handoff is taken on a half-sequence.
- **claim refused** (a live lock somewhere on the bus) — the worktree stands
  (it is real work at a stable path), reported honestly: created, NOT
  claimed, see describeLock. No rollback — deleting a just-created tree from
  behind the agent is the kind of surprise the bus never springs.

## What it does NOT do

- Never removes a worktree. Releasing is `release_tree`; removing a tree is
  a person's `git worktree remove` — the same nothing-deletes line as
  everywhere else on the bus.
- Never resolves a merge, stashes, checks out or rebases. `worktree add`
  with a base ref only.
- Never auto-selects between multiple handoffs — the pick is the taker's.

## Security note (SECURITY.md gets a line in this commit)

`git worktree add --checkout` runs the repo's own checkout hooks. That is
also true of every manual `git worktree add` this fleet has ever run, and
the verb only ever acts on the repo its caller is already working in — so
the boundary stays "trust the repo you are in" — but it is now stated, not
implicit.

## Dashboard

None needed. The claim lands in the state the status page already renders
(describeLock), the handoff's taken chain renders on `/handoff/<key>`, and
the tree itself is visible via `git worktree list`. The verb is
infrastructure the hub can show without adding a pane.

## VERIFY — `worktree-harness.mjs` (counted in the gate)

A REAL fixture repo (git-init'ed in temp — the fleet's own pattern; the bus
already runs real fixtures in lock-harness). Checks:

1. Happy path: tree dir exists under `.claude/worktrees/` (hmm — the
   `.claude/` dot-dir is Claude Code's convention; the bus serves
   non-Claude fleets too → the path is `<root>/.claude/worktrees/<name>`
   ONLY when `<root>/.claude` exists, else `<root>/agent-bus-worktrees/<name>`.
   Whichever was used is printed), branch exists, claim holds, and — with
   exactly one handoff on the board — the taken chain names the caller.
2. Two handoffs on the board → none auto-taken, keys listed.
3. `--handoff <key>` picks among many.
4. Zero handoffs → proceeds, says so.
5. Existing tree refused, with the claim-instead advice.
6. Non-repo PROJECT_ROOT refused (branch 3 fixture).
7. A live foreign claim → worktree created, NOT claimed (the honest-partial
   outcome), with the holder named.
8. Slug and ref validation cases (one combined check: `..`, slash, leading
   dash, spaces in branch).
9. `git worktree list` of the fixture afterward shows no orphans: a refused
   claim or a missing handoff never left a tree behind half-created beyond
   the stated rule (created-and-standing is stated, so the check is exactly
   that no tree exists when `worktree add` itself failed).

Gates: 19 suites; README tables + totals move in this same commit; e2e MCP
count 28 → 29.

## Acceptance

- One call from a registered agent produces: tree on disk, live claim on the
  bus, handoff taken chain started; the reply names all three at once.
- Every refusal prints why, and nothing is left half-done beyond the stated
  created-but-unclaimed case.
- The regression bar: a fleet that never calls the verb behaves identically.