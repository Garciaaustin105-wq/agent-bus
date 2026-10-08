# Spec — the `handoff` verb (and `handoff_take`)

Status: SPEC, not yet built. Written 2026-09-14 from the camera-platform
bench thread, where a session ended mid-task and the handing agent
hand-rolled the transfer as a standalone markdown file + one pointer note.
That duplication is the failure this verb exists to close.

## The failure being fixed

The bus is problem-shaped, not session-shaped. `note` captures individual
facts, `miss` captures corrections, `task_add` queues work — but nothing
answers "the conversation that was driving this just ended; here is the whole
state and where to resume." Today that knowledge either dies with the session
(the exact loss `note`'s description warns about) or gets re-invented per
handoff as an out-of-band document the next agent only finds by luck.

The next agent must be able to resume from the BUS alone, without reading a
transcript, without a second agent alive to ask.

## What a handoff is

One structured, keyed, self-superseding board entry per scope holding:
the state of the world, the open work in priority order, pointers, and the
standing constraints the next agent inherits. Writing a new handoff under the
same key replaces the active one (the old is archived, not destroyed).

A handoff is NOT a task and does NOT feed the task queue. It carries no
brief for a steward and applies nothing — the feared failure borrowed from
`apply`'s design applies here doubled: a handoff is a *statement of state*,
and only a live agent taking it up turns it into work.

## Verbs

### `handoff` — write or supersede the active handoff

    handoff({
      summary: string,        // required. The state of the world, verified.
                              // Written for someone who was not here (rule
                              // inherited from note). No narrative.
      nextStep: string,       // required. The ONE thing to do first. If
                              // there is no single first thing, the open
                              // list is not prioritized yet — fix that, do
                              // not post a handoff without a next step.
      open: [{                // optional. Open work, priority order (first
        title: string,        // = first done). Each item may carry:
        detail?: string,      //   detail — enough to start without the old
        busKey?: string,      //   busKey — the note key this work belongs to,
      }],                    //   so priorities and problems stay linked
      pointers: string[],     // optional. Repo-relative or absolute paths,
                              // doc names, commit SHAs — the ledgers a
                              // claimant must read before touching code.
      constraints: string[], // optional. Standing rules that outlive the
                              // session ("target is linux", "never require
                              // X", "do not push without the user").
      key?: string,          // default "handoff". Use a suffix for scopes
                             // sharing one bus (e.g. "handoff-camera").
    })

Semantics:

- Requires registration (`requireName`) — a handoff is signed work.
- Stored at `state.board[<key>]` with `kind: "handoff"` and the structured
  fields kept on the entry, the rendered text kept in `value` (board values
  are strings; render the same block `handoff_take` returns so `board()`
  readers see it too).
- **Supersede, on the record:** writing over an active handoff moves the old
  one to `state.handoffs` history (last 5, newest first, with `supersededAt`
  and by whom). The response says so: `Replaced the handoff by <name> set at
  <time> — it is in history (entry N).` An agent overwriting another agent's
  ACTIVE handoff is doing something significant and must see it named.
- Size: each string field capped at `MAX_NOTE_CHARS`; the whole rendered
  entry capped at 4x it (a handoff that cannot fit is four notes plus a
  pointer, not an error).
- The rendered block starts with `HANDOFF (set <at> by <by>, next: <one
  line>)` so a `status()` skim shows a live handoff without opening it.

### `handoff_take` — resume it, on the record

    handoff_take({ key?: string })   // default "handoff"

Returns the full handoff (rendered open list, pointers, constraints) and
stamps `takenBy` / `takenAt` on the active entry, appending to a `taken`
chain (`[{by, at}]`) that survives every re-take.

- Taking does NOT lock anything. Two agents may both take one; the chain
  records both and each sees the other in the response (`Also taken by
  <name> at <time> — coordinate on the bus before you start`). The feared
  failure — two agents both believing they solely own the resumed work — is
  answered by the chain being impossible to miss, not by a mutex that rots.
- Taking an already-taken handoff is normal (handoffs get passed along);
  the chain is the audit trail.
- Refuses with a short sentence when there is nothing active under the key
  (history exists? say the newest history entry's author and date, so the
  caller learns the thread existed).

## Non-goals

- No auto-anything: no queue injection, no notify-the-claimant, no expiry.
  A handoff is read when someone chooses to resume.
- No attachment files — pointers only. If it does not fit in the rendered
  entry, it belongs in a doc the pointer names.
- No handoff-of-handoff indirection. The chain in `taken` is the record.

## Harness / e2e cases (must ship with the verb)

1. `handoff` without `summary` or without `nextStep` is refused (exact
   sentence, not a bare error).
2. Posting twice under one key supersedes: response names the replaced
   author; history holds the old one; history is capped at 5.
3. `handoff_take` returns all fields verbatim and stamps `taken`/chain.
4. Second `handoff_take` appends to the chain and BOTH takers appear in the
   response.
5. `handoff_take` on an empty key refuses and names the newest history
   entry if one exists.
6. `board`/`status` show the rendered HANDOFF line (so a non-taking agent
   still sees a handoff exists).
7. Oversized fields are capped, never truncated mid-UTF-8-character (reuse
   `cap`'s behavior).

## Integration

- CLI: `node server.mjs handoff --summary "..." --next "..." [--open <file>]
  [--pointers <file>] [--constraints <file>] [--key handoff-camera]` where
  the `--open/--pointers/--constraints` args read a JSON array from a file
  (one flag per read beats a giant inline JSON blob on a shell line);
  `node server.mjs handoff-take [--key ...]`. CLI verbs join the registry
  like `note`/`claim` do.
- MCP: two entries in TOOLS beside `note`/`miss`, descriptions carrying the
  why (the out-of-band-file failure this replaces).
- Dashboard: the board row shows the rendered line; the handoff page shows
  the chain. Nothing auto-notifies — `handoff_take` is an act, not a wake.
- README: a short "Handing off" subsection after the noticeboard section,
  with the camera-thread story as the motivating example (one sentence).

## Why two verbs and not one

`miss` taught the pattern: the pairing is the record. A handoff nobody took
is a rumor; the `taken` chain is what turns "someone left state" into
"someone resumed this state, here is the chain of custody." The write and
the taking are different acts by different agents and they must not collapse
into one call.