# The workflow spine

The hub is, primarily, an app builder (roadmap §0). Its tools were built
incident by incident — the lock because two sessions switched branches under
each other, the board because a spec went stale four times, the edit protocol
because a whole-file rewrite mangled UTF-8. That is how the parts stay honest.
What they never had is the question they all answer. This file is that
question: **what does it take, start to finish, for a team to build and
publish an app — and which parts of it does an agent fleet have to cover
differently than a human team does?**

The stages below are what a real development team runs, in order, on any app
of any size. The names are ordinary on purpose. What matters for the hub is
the third bullet of each — the thing a human-only team does that an agent
fleet must cover another way — because that is where the hub's tools come
from, and where the missing ones will come from too.

The one-line answer, so it can be read before the detail: **in a human team,
every stage has a named person who is answerable for it, and accountability is
what makes each stage work. A fleet has nobody who can feel blame — so the
hub's job at every stage is to manufacture attributable artifacts instead:
a name on the ledger, a reason attached to a decision, a measurement filed by
session id rather than a guess.** That is the spine's thesis. Everything the
hub already does — the ledger, the advisory-only routing, the untrusted label,
the board note that outlives the conversation — is that same answer, arrived
at incident by incident before it was written down here.

---

## 1. Idea — is this worth building

A real team does not start with code. It starts with a pain someone actually
has, and a decision to spend the team's scarcest resource — attention — on it.
The stage produces a problem statement and a go/no-go, and both are cheap
because the expensive part is refusing the other nine ideas.

- **Produces:** a problem statement and a decision. Usually one paragraph:
  who hurts, how often, and what "better" would look like.
- **Human-only:** choosing what to build. It is the only stage where the
  decision is not about quality but about priority, and priority is owned by
  the person whose money and attention it spends.
- **The fleet's way:** the fleet proposes, the person disposes. Evidence
  accumulates on the board — voice-of-customer notes, measured token costs,
  the misses that keep recurring — but nothing auto-builds. The hub's job here
  is to make the evidence cheap to see, not to have an opinion.

## 2. Spec — write it for someone with no context

The spec is the whole contract between the decider and the builder. In a
human team it can lean on hallway conversation to fill gaps; in a fleet the
reader may be a worker that cannot ask a clarifying question at all, so the
spec must carry everything: the shape of the answer, the out-of-scope list,
the failure modes already known.

- **Produces:** a written spec a stranger can execute. In this repo that is
  the HANDOFF.md protocol, and its hardest-won rule is "ask for edits, never
  for the file."
- **Human-only:** deciding what "done" means and what is explicitly NOT being
  built. A spec with no boundaries is not a spec.
- **The fleet's way:** the spec travels in the task itself — a queued task
  carries the whole prompt, its task page shows the full text, and the routing
  record learns which runner finishes specs cleanly. Hub status: built — the
  queue, task pages, HANDOFF.md.

## 3. Design — the seams before the code

Human teams design before building because rework is expensive. The artifact
that matters is not a diagram; it is the set of contracts other work will be
written against — data shapes, file boundaries, the interfaces two lanes will
meet at.

- **Produces:** contracts. Small, written, agreed before either side of the
  seam is implemented.
- **Human-only:** architecture judgment — which seams will still be right
  three lanes from now. Models are better at filling a shape than choosing
  one.
- **The fleet's way:** contract-first, because parallel agents do not collide
  on code if they collide on contracts instead — each lane writes against the
  same written shape. The durable facts go to the board (`note()` is
  deliberate: messages die with the conversation, notes outlive it). Hub
  status: the lock keeps one writer per tree; spaces keep one app's seams
  separate from another's.

## 4. Build — the smallest safe blast radius

Human teams write code in small pieces because review is human-scale. A fleet
has the same constraint for a different reason: the cheaper the writer, the
smaller the unit a person is willing to audit.

- **Produces:** changes as small diffs, each one individually checkable.
- **Human-only:** in a human team, the builder's own discomfort — "this feels
  wrong" — is an unplanned safety net. A worker has none, which is why the
  guardrails have to be mechanical rather than felt.
- **The fleet's way:** the edit protocol — a model returns `{id, find,
  replace}` edits and nothing is written unless every edit resolves; drafts
  never touch the repo; a failed run is a result, not a crash. Hub status:
  edits.mjs, the worker queue, per-runner output budgets. The build stage is
  the one the hub was originally built for.

## 5. Review — someone else reads it first

Review is the stage human teams do best and fleets do worst, because the
review's power comes from the reviewer being answerable to someone other than
the author. An agent reviewing its own output has nobody to answer to.

- **Produces:** accept/reject with reasons — reasons because a bare "no"
  teaches nothing.
- **Human-only:** accountability, and the judgment of what matters — a
  reviewer who has shipped wrong things before reviews differently.
- **The fleet's way:** split review in two. The mechanical half needs no
  judgment — harnesses, gates, "every check green or it does not land." The
  judgment half stays with a named reviewer, and today that means the person
  or the orchestrating session. Hub status: the gate exists (a lane ships with
  its harness); what the bus itself does not yet have is a review surface —
  review currently happens off the bus, in the sessions doing the work. That
  is the spine's first gap (below).

## 6. Test — prove the behavior, not the intention

A human team tests what it has learned to fear. A fleet has to make that
explicit, because a worker's confidence is not evidence of anything.

- **Produces:** a green gate someone trusts — which means the gate itself has
  a reputation, earned by catching real defects.
- **Human-only:** deciding what is worth testing. The test list is curation:
  the failures this repo actually had are the tests it actually has.
- **The fleet's way:** every lane ships a harness as part of "done" —
  contract, then harness, then UI, in that order — and the failure modes in
  the harness are the ones that happened. Hub status: the 13-suite gate;
  worker drafts are reviewed against the J-rules, never merged raw.

## 7. Release — finished work becomes deployable, with a way back

Between "the lane is done" and "users have it" sits the release: a versioned,
revertible increment. Human teams ritualize this because the cost of a bad
release is borne by users, not the team.

- **Produces:** a tagged increment and a known way to undo it.
- **Human-only:** the go/no-go. A fleet that can ship on its own authority is
  not a faster team, it is an unattended one.
- **The fleet's way:** the fleet prepares; the person pushes. The lock exists
  for exactly this neighborhood — release-adjacent git operations are where
  two agents destroy each other's work. Hub status: the lock, and the rule
  that the tree is claimed before any git operation. No release record lives
  on the bus yet — second gap.

## 8. Publish — users have it

The moment money and real users start. Human teams make this a ceremony
because the ceremony is where "almost ready" gets caught; a fleet must not
weaken the ceremony, only remove the toil around it.

- **Produces:** a public version change, visible to users.
- **Human-only:** all of it. Publish is the accountability stage in its
  purest form — the person whose name is on the product decides when it goes.
- **The fleet's way:** everything before the button is agent work — the
  checklist, the notes, the changelog draft — and the button is human. Hub
  status: the bus does not yet carry "app X is live at version Y." Spaces
  (roadmap §6) gave every app a home; a publish record is the natural next
  thing to hang there. Third gap.

## 9. Monitor — know it broke before a user says so

A human team finds out from a customer; a fleet can find out first — watching
more things than a person can, without getting tired of it.

- **Produces:** incidents, each with a shape (what broke, where, when) but —
  by the cross-install boundary (roadmap §7) — never the user data behind it.
- **Human-only:** severity. Deciding that this is an incident and that is a
  known wart is product judgment, and it cannot be delegated to the thing
  being judged.
- **The fleet's way:** the hub already monitors its own fleet — the context
  budget, failure streaks, misses reported three times — and files board notes
  rather than acting on them (C4: it files and stops). What it does not yet
  monitor is the apps it builds. Fourth gap.

## 10. Maintain — the app outlives the sprint

Most of an app's life is after its first release. Human teams lose knowledge
here fastest — the person who knew why leaves, and the code keeps the why only
if someone wrote it down.

- **Produces:** rules earned from incidents, regressions fixed, debt paid down
  — and the explicit decision of what never gets fixed.
- **Human-only:** the deferral decision. "Not worth fixing" is a product
  decision wearing an engineer's clothes.
- **The fleet's way:** this is the hub's strongest stage, and the reason the
  other stages exist: notes outlive sessions, blockers bank their fixes so the
  second hit of the same problem is cheap, misses become rules (L3), and the
  routing record makes the next routing decision better. The rulebook is this
  stage's artifact.

---

## The shape of the loop

The stages are a loop, not a line: monitor feeds maintain, maintain feeds
idea, and the loop runs per app — which is why the spaces exist (roadmap §6).
The hub sits inside the loop as an orchestrator and a memory, not as a
decision-maker: every stage above names a human-only part, and the hub's
consistent answer is to carry the evidence and stop before the decision.

## What already hangs off the spine

| stage | hub piece that serves it |
| --- | --- |
| idea | the board, the context budget, the miss ledger |
| spec | HANDOFF.md, the task queue, per-task pages |
| design | the lock, the spaces, board notes as contract records |
| build | the queue, the workers, edits.mjs, the routing record |
| review | the J-rules, the harness gate — surface itself is a gap |
| test | the 13-suite gate, per-lane harnesses |
| release | the lock around release-adjacent git work |
| publish | nothing yet — gap |
| monitor | the context budget, blockers, failure streaks — per-app only as a gap |
| maintain | the rulebook, banked fixes, the learning loop |

## Gaps, in the order they bite

All four SHIPPED 2026-09-12 (the originals are kept below as the reasoning
each fix grew from):

1. **No review surface on the bus.** Review — the stage fleets are worst at —
   currently happens in the sessions doing the work, invisible to everyone
   else and unbilled by the ledger. A review record per task (who read it,
   against what, verdict) is the first lane this spine earns.
2. **No publish record.** A space has a board, a lock and a queue, but
   nothing says what version of the app is live. The record is small; the
   confusion it prevents is not.
3. **No per-app monitor.** The hub watches itself — the fleet, not the
   fleets' products. Per-app monitoring is a later lane and deliberately not
   started from the hub's own watch code, because monitoring an app and
   monitoring a fleet share nothing but the name.
4. **Stage tags are convention, not data.** Board notes and tasks are not
   marked with which stage they belong to, so the spine is legible to a person
   reading this file and not yet to the bus itself. That is fine until a lane
   needs "everything in stage 5 for app X" — at which point the tag becomes
   data.

How each closed, and where its guardrail lives:

1. **SHIPPED** — `review(task_id, verdict, notes?)` records a verdict as data
   on the DONE task (capped at 10, rendered on the task page with a form).
   The refusal IS the design: the runner who did the task cannot review it —
   "Review is someone else's read of your work — that is the whole point of
   the surface." A task still queued or running has nothing to review and is
   told so. Pinned in `worker-tasks`/`hub-http-harness`.
2. **SHIPPED** — `publish(version, what)` appends to the space's own publish
   record (capped at 20), rendered as a hub panel per space. A ship the next
   agent can read instead of re-derive.
3. **SHIPPED as the strip, not the watch** — a per-app health strip
   (`healthOf`) computed from each space's own state: queue depth, running,
   done-but-unreviewed (review debt), open blockers, last activity — shown in
   the Spaces bar and as the current space's Pulse line. Read-only and
   computed per render; deliberately NOT the fleet-watch code, per the
   original note.
4. **SHIPPED** — `task.stage` is a column validated against the ten headings
   of this doc at `task_add` (`readStages()` parses them live; a made-up
   stage is refused by name, and a misspelled CLI stage is refused rather
   than silently joined into the prompt). It rides the task rows and task
   pages as a tag, and the queue form offers the ten as a dropdown.

Deliberately out of scope for the spine: prescribing tools per stage, or
turning any stage into hub code before an incident demands it. The spine's
job is to name the stages and the human-only line; lanes hang off it when
incidents point at one.