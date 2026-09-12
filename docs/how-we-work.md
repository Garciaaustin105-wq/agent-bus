# How we work

The operating model for this repo. Not aspiration — this is what actually
happens, written down so it survives a session ending.

The short version: **the expensive model plans and verifies, cheaper agents
implement, and the bus is how they stay out of each other's way.** Every part of
that is a cost decision as much as a quality one.

---

## Why it is shaped this way

A frontier model typing boilerplate is the most expensive way to produce
boilerplate. It is also not where it earns its keep. What it is uniquely good at
is deciding *what* to build, spotting the failure nobody has thought of yet, and
telling the difference between "the check passed" and "the check ran".

So the split is by what only the orchestrator can do, not by task size.

- **Plan and spec** — decide what to build and write it down precisely enough
  that another agent cannot misread it.
- **Orchestrate** — hand work out, track it, notice when a lane is stuck.
- **Verify** — read the result against the spec and the rules before it lands.
- **Decide** — anything with a judgement call: schema shape, a refusal, a
  privacy boundary, what a number means.

Implementation is the part that delegates. Verification never is.

---

## The lanes

**Claude — plan, spec, verify, orchestrate.** Writes the brief, reviews the
output, runs the checks, opens or approves the PR. Does not implement when
another lane can. Reads the target files before writing any handoff, because a
spec written blind produces work that has to be redone.

**GLM — implementation.** Takes a written brief and builds it. Owns a worktree,
never the shared checkout. Verifies with tsc, eslint, build and the harnesses,
reports on the bus, and does not merge. Good at: a specified change across
several files, a migration of a known pattern, following a worked example.

**Local models (ollama) — bounded research and audit.** Takes tasks where a
wrong answer is cheap and obvious in one command: find these numbers with
sources, does this harness still run, what is unimported. Never touches auth,
RLS, migrations, money, or the snapshot rule — being subtly wrong there is
invisible until it costs a customer.

**The human — decisions, merges, credentials.** Merges every PR. Rotates
passwords. Answers the questions an agent should not answer for itself: whether
a feature ships everywhere at once, whether a screen deserves its own
navigation section.

---

## The loop

- **Plan.** Read the code as it is now, not as a doc describes it. Four failures
  here came from that gap.
- **Spec.** Write the brief to a file, not a message. A message reaches whoever
  is listening; a file reaches whoever arrives.
- **Hand off.** Post a note on the bus pointing at the brief. State what is out
  of scope as clearly as what is in it.
- **Implement.** The agent takes its own worktree, works, and reports back.
- **Verify.** The orchestrator checks the claim, not the summary. Run the
  command yourself. A green check on a PR that changed nothing relevant proves
  nothing.
- **Land.** PR opened by whoever did the work, merged by the human.

---

## What the bus is for

- **note()** for anything the next agent needs regardless of whether they were
  listening. Specs, decisions, status, constraints. This is the default.
- **send()** only when you need a reply from someone who is here now.
- **claim_tree()** before any git operation in a shared checkout.
- **The hub window** shows all of it — who is connected, what they are doing,
  what is on the board, and the rules everyone is working to.

Four stale-spec incidents happened because a fact lived only in a conversation.
That is the whole reason the board exists.

---

## Rules of delegation

- **Verify before you trust, always.** Including your own work, and especially a
  check that passed. Two "clean" eslint runs in one session were eslint failing
  to start.
- **A brief states what is out of scope.** An agent that does not know what not
  to touch will touch it.
- **Never hand over a judgement call.** If the answer depends on what a number
  means, or on a privacy boundary, or on which of two correct designs fits the
  business — that is the orchestrator's, or the human's.
- **A wrong answer must be cheap.** Match the task to the lane by what happens
  when it goes wrong, not by how hard it looks.
- **Report what actually happened.** If a step was skipped, say so. If a claim
  was wrong, correct it and move on.

---

## The context budget

Measured, not assumed. Run `node tools/agent-bus/context-cost.cjs` to reproduce
every number here against the current transcripts.

- **Everything in context is paid for on every turn, not once.** 98.6% of this
  project's entire token spend is cache reads — the model re-reading the
  conversation before answering. Putting something in context costs its size
  multiplied by every turn that follows it.
- **Pixels never enter the main working thread.** 51 image reads cost 1.79M
  tokens; 414 text-file reads cost 537k. One image is worth about 27 source
  files. Nine logo drafts, checked inline, cost roughly 700k tokens.
- **Never downgrade the look — bound its lifetime instead.** A blurry render or
  a small vision model returns a confident wrong answer, which rule C1 exists to
  prevent. Look at full resolution in a subagent, carry back the sentence, and
  let the pixels die with that context.
- **Read structure before pixels, and a range before a whole file.**
  `read_page` gives real text and clickable refs for a fraction of a screenshot.
  A named range beats a whole file.
- **End the session when the work changes.** One session reached 9,720 turns at
  539k of context per turn — 5.2 billion tokens, 64% of everything this project
  has ever spent. A fresh session runs at about 57k a turn.
- **Measure before optimising.** Two confident "fixes" here — trimming MCP
  connectors, then blaming repeated source-file reads — were both wrong by an
  order of magnitude, and the transcripts had the answer the whole time.
