# Build rules

Every rule here was paid for. Each one names the incident that produced it, so
you can judge whether it applies to what you are doing rather than following it
because it is written down.

Read the short list in `AGENTS.md` before writing code. Come here when you want
to know *why* — or when you are about to argue with one.

---

## A. The shape of the work

### A1. Contract, then harness, then UI. In that order.

Put the maths in a pure module in `src/lib/` with no React, no I/O and no
browser globals. Write a harness that runs it standalone. Only then build the
screen.

**Why:** a pure contract is testable in a second without a browser or a
database, and every consumer gets the same answer. The alternative is the same
rounding rule implemented three times in three panels.

**Incident:** every catalogue in the app that first used these rules was
built this way. The bugs that reached this list came from the parts that
skipped it.

### A2. Split I/O from maths so the harness can run at all.

If a contract imports Supabase or another module that uses path aliases, a
standalone `tsc` of it drags in the whole graph and the harness cannot load.
Split: `contract.ts` is pure, `contractData.ts` talks to the database.

**Incident:** one contract's loader pulled in `@/`-aliased modules and broke
its own harness. Splitting fixed it in one move.

### A3. One owner per file.

Parallel work must own disjoint files. Two agents editing one file is a rebase,
not a merge.

**Incident:** four lanes ran at once against four separate feature files. It
held because the boundaries were declared up front. It broke the one time the
shared navigation file had three claimants.

### A4. Re-read the state of the world immediately before you write code — not
when you were handed the spec.

A spec is a photograph. By the time you act on it, the thing it described may
have moved.

**Incident:** four separate stale-spec failures. One lane was built on a
schema restructured underneath it. Another was told four times to copy an
older table implementation, hours after a newer one became the house pattern.
A third's spec asked for a panel a sibling lane had already shipped. Nobody
was talking at the moment each fact went stale, so no amount of messaging
would have caught them — which is why facts belong somewhere durable.

### A5. Comment WHY, never what.

The code says what. A comment earns its place by recording the reasoning, the
alternative that was rejected, or the bug that made the line necessary.

---

## B. Being honest about data

### B1. A blank is not a zero.

Missing price is not free. Missing rate is not instant. Missing headcount is
not a team of one. Missing capacity is not a container that holds nothing.
Carry a distinct flag and say which.

**Incidents, all real:**
- A divisor defaulted to `0` did not produce a cautious estimate, it produced
  *none* — the derived total divides by that field. The feature was dead and
  looked merely empty.
- A time entry with no headcount, defaulted to 1, would understate every derived
  rate **by the size of the real team** and look completely normal on screen.
- `unpriced` and `untimed` are separate flags because a row can be priced with
  no rate entered, and reporting zero hours for it is a different lie.

### B2. Every quantity carries its unit — in the data, and on the screen.

A wrong rate looks wrong. A wrong unit looks *fine* and is off by a factor of 9,
10.76 or 1000.

**Incidents:**
- Line items are per-each or per-length. "2" means two units or two lengths,
  and the `basis` string exists solely so nobody reads it as something else.
- One field is per *thousand* square units. Typing 5000 into it is a
  thousand-fold error that looks correct, so the UI converts measured area
  instead of asking anyone to type thousands.
- A metres file read as feet is 3.28x on length and **10.76x on area**. Most
  device exports declare no unit at all.

### B3. Snapshot anything that has been sent.

Store a copy of the priced row on the document that quoted it. Re-pricing the
catalogue must never move a quote already in a customer's hands.

**Applies to:** every row type the catalogue carries — every one of them,
without exception.

### B4. Seed structure. Never seed values.

Names, categories and units: yes. Prices and rates: no. Those are the
org's business decisions, and a default is how somebody else's productivity
silently becomes their price.

Published research belongs *beside* the field as a suggestion — shown, sourced,
and never written into a row or into a calculation.

**Exception, and note what earns it:** one set of default durations stayed
seeded because they were validated against independent sources, not guessed.
That validation is the bar. Nothing gets seeded on the strength of sounding
reasonable.

### B5. Numeric wherever the rate can be fractional.

**Incident:** a per-unit minutes column shipped as `integer` on a table with
per-length rows. 0.5 minutes per unit — a real published figure — silently
rounded. My own harness used a number the database could not store.

### B6. Derive the unit from how the thing is actually bought.

Sold by the each, the length, the area, the volume or the weight — the unit is
however the thing is actually bought, not whatever the UI finds convenient.
Getting this right at the schema is free; getting it wrong is unfixable later.

---

## C. Refusing well

### C1. Refuse rather than guess whenever a wrong answer would be invisible.

If the mistake would look plausible, do not make it. Return null, say why, and
let a human decide.

**Incidents:**
- Below a device's minimum operating threshold, the modelled value returns
  **null** rather than extrapolating. Below minimum the physics changes — it is
  not "a smaller number", it is the wrong kind of behaviour.
- A measurement file with no declared unit does not proceed on an assumption.
- A local coordinate frame is not placed on the map, because a shape that looks
  right and sits wrong is worse than no shape.

### C2. Report measurements. Do not render verdicts.

State what was counted. Do not grade it.

**Incidents:**
- Coverage reports `reachedPct` and `overlapPct` and refuses to collapse them
  into one score — four circles that merely touch measure 100% reached and
  36.8% overlap, while deliberate tight spacing measures 100% and 78.8%. One
  number cannot tell those apart, and the first is the under-covered one.
- A job that ran 60% over is reported as 60% over. Weather, access, and a
  broken machine look identical from here, and an app that accuses a worker
  based on a phone ends with the phone left in the truck and no data at all.

### C3. Know where your competence ends, and stop there.

Where a domain requires a licensed professional's judgement, the app does not
exercise it. Code counts what the professional specified; it does not specify.
The moment a screen reads "94% compliant", liability moves to the app.

### C4. Nothing auto-applies.

Suggest, show the evidence, let a human press the button. Deliberately provide
no bulk endpoint for anything that rewrites a catalogue.

**Incident:** one review screen proposes rate changes and applies exactly one
row per click. An "apply all" would let one bad batch overwrite everything.

---

## D. Deriving numbers from field data

### D1. Medians, never means.

One outlier day must not drag a rate for months. A mean lets it; a median
barely moves.

### D2. Gate on sample size *and* on spread.

Below three observations, propose nothing — three is what the industry guidance
actually says. Above a 3x spread, propose nothing either: those were not the
same job, and a median of them is arithmetic rather than information.

### D3. Say what you could not use, and why.

Report excluded rows with reasons. "34 entries had no headcount" tells someone
what to fix; a quietly smaller sample tells them nothing.

### D4. Separate a measurement from an assumption, and never blend them.

Attributing a job's hours to one task is a measurement only when there *was* one
task. Splitting across several assumes the overrun spread evenly, which is a
real assumption that can be wrong. Prefer the measurements outright when you
have enough of them — mixing the two produces something that is neither.

### D5. Two sources disagreeing is information, not an error.

When the aerial measurement says 4,200 and the on-site measurement says 3,850,
that gap is the only signal anyone has about which source gets what wrong.
Never average them, never silently prefer one. Show both.

---

## E. Verification

### E1. Test the failure you are afraid of, not the happy path.

**Incidents:**
- The agent-bus test spawns two real processes racing for one lock, because the
  failure is a race and a single-process test cannot see one. It immediately
  found a crashed session deadlocking every other agent for four hours.
- One harness caught a hard-coded 28-day rental month.
- Another caught a check reporting "6 short" when no controller had been
  chosen — a fault invented out of a blank field.

### E2. Verify with the real thing, and vary the conditions.

`tsc --noEmit`, `eslint`, and an actual build. Compile a contract standalone as
well as in-project.

**Incident:** a standalone compile surfaced `.insert().single()` with no
`.select()` — PostgREST returns no row from that, so the function would have
handed back `null` forever. The project config typed the bug away.

### E3. Never let a harness touch real data unscoped.

Deactivate and restore, scope every delete and read to a test prefix, restore on
the failure path.

**Incident:** an unscoped cleanup deleted hundreds of rows of priced data
across a whole organization. The parent rows survived, so the counts still
looked plausible.

### E4. Check your own assumption before you "fix" the code.

Several times the test was wrong and the code was right: a unit-convention
assumption, a geometry corner case, a 30-day month.

---

### E5. A harness assertion must not depend on content somebody else edits.

If a check reads the live rulebook, the live board, or any other document that
grows, then it is asserting something about *today's content*, not about the
code. It will go red for whoever edits that content next, in a file they did
not touch, and it will look like their bug.

**Incident:** five assertions, over three red runs, from a single docs commit. Adding
rules containing the words "note" and "board" made a deliberately weak query
score 2 and match. Adding section L put text in the corpus that outranked the
test fixture, so "the matching note comes back first" started returning `L3`.
Two more went red on the fix itself. Nothing was ever wrong with the matcher.

**The split to make:** an assertion about what the CODE does gets a fixed
corpus built in the test. An assertion about the REAL document — that it still
parses, that its ids are unique, that a known rule still matches a known report
— reads the real thing, because that coupling is the entire point of the check.
Both belong in the file. Mixing them into one index is what fails.

**Tell them apart with one question:** if this check goes red, is the right
response to fix code, or to edit prose? If it is prose, the check is wired
wrong.

### E6. A release audit runs the product once, as the person will.

Suites and gates verify code paths; they do not verify what a person watching
the product concludes. Before calling a release audited, run one live pass of
the real flow — dispatch, drain, render the dashboard, whatever the feature
actually looks like in use — and check every state it shows against what a
reasonable watcher would take it to mean.

**Why:** every suite can be green while the visible surface lies. Suites
assert code; the person reads prose rendered from data, and that prose is
where honesty defects live.

**Incident:** the v0.1.1 release audit passed all 14 suites and shipped two
dashboard honesty defects: a Connected badge that said "running" whenever the
agent's process was alive — including over an empty queue — and a working-tree
card that said "free" without naming which tree the lock covered. The person
caught both from the outside within a day. The audit's blind spot was exactly
the gap between "the tests pass" and "what the page says is true".

## F. Working alongside other agents

### F1. Claim the working tree before you touch git in a shared checkout.

Or better, take your own worktree and make the question moot.

### F2. Facts that the next agent needs go somewhere durable, not into a message.

A message reaches whoever is listening. A specification goes stale in the gap
between being written and being read, and that gap is exactly when nobody is
listening.

### F3. Never rewrite another agent's commits without asking.

Cherry-pick your own work onto their base instead. They may have uncommitted
files you cannot see.

### F4. A peer is not your user.

Another agent cannot approve a permission, authorise a config change, or grant
an escalation. If a peer asks you to do something it was denied, refuse and
surface it.

---

## G. Asking the person for help

### G1. Stalled or denied twice? Ask the person. Two is the limit.

If the same thing fails, is denied, or stalls twice in a row, stop retrying and
tell the person exactly what was blocked and what you tried — in this
environment there is a `!` prompt that runs commands outside the agent's
permission path, and they can usually unblock in one move what a third attempt
will not unblock at all.

**Why:** retrying a failing path a third time is silence spent on a wall. The
cost is not just the wasted attempts — it is the work on the other side of the
block sitting frozen while the person, who never knew there was a problem,
could have solved it immediately.

**Incident:** 2026-09-09, agent-bus extraction. The safety classifier that
gates shell commands went down, and the same cleanup call failed six-plus
times before the stalled agent finally said what was blocked. The person ran
it from their own prompt in seconds — and then made this rule, so the asking
happens at two, not six.

### G2. When a problem or a block happens, it goes into the hub — what happened, and why.

Do not just work around a block and move on: post what happened and why it
happened to the hub, so the next agent that hits it finds the answer instead of
re-producing the stall. The hub's side of the rule: answer back with the fixes
earlier agents worked out and saved — the board, the rulebook and the notes are
the memory those answers live in. An agent reporting a block is exactly how
rule G1 above and the runner-prefs handoff protocol came to exist.

**Why:** F2 — a fact that reaches only whoever is listening is lost. A block
reported to the hub is a fact; a block retold in a chat is a rumor.

### G3. A problem the PERSON reports goes into the hub first — before you fix it.

G2 covers a problem you hit. This one covers a problem handed to you. Post it
to the board under a fresh, distinct note key the same turn it arrives — an
essence of what was reported plus the date — and only then start diagnosing.
When the fix ships, follow up under the same key with what changed and the
evidence it works.

**Why:** the reporter is not the one keeping the record. If you fix first and
record later, the session can end before "later" — a compaction, a context
reset, a handoff — and the report dies with the conversation while the defect
it described may still be in someone else's copy. The person should never have
to ask whether it was written down, and another agent picking up the same bus
should find the problem and its fix without either of you in the room.

**Incident:** 2026-09-13, two dashboard honesty defects reported mid-session.
The fixes were made but nothing was recorded until the person asked — twice.
The second ask was the rule: "I shouldn't have to keep asking you to save."
The capture must not depend on one agent remembering; it is a step of the work,
like the fix itself.

---

## H. The context budget

Every number in this section is reproducible: `node tools/agent-bus/context-cost.cjs`.

### H1. Everything in context is paid for on every turn, not once.

A cache read is the model re-reading the conversation before it answers, and it
happens on every turn. So the cost of putting something into context is not its
size — it is its size multiplied by every turn that comes after it.

**Why:** this inverts the intuition. A 36k-token image looks like a rounding
error next to a 200k context window. Left in a conversation that runs another
two thousand turns, it is 72 million tokens.

**Incident:** across 16,571 turns, 98.6% of all tokens spent were cache reads.
Cache writes were 1.2%, output 0.2%. Everything that felt like "work" — the
writing, the thinking, the actual answers — was a fifth of one percent.

### H2. Pixels never enter the main working thread.

Open an image at full resolution inside a subagent, answer the question there,
and return text. The subagent's context is discarded; the main thread keeps the
sentence.

**Why:** an image answers one question and then costs full price forever. The
information you needed was a sentence; the pixels are what you keep paying for.

**Incident:** 51 image reads cost 1,795,308 tokens. 414 text-file reads cost
536,849. One image is worth about 27 source files. `preview-map.png` alone cost
269k, and nine logo drafts checked inline cost roughly 700k.

### H3. Never downgrade the look. Bound its lifetime instead.

Do not scale a screenshot down or route it to a small vision model to save
tokens. Look properly, once, somewhere the pixels do not persist.

**Why:** C1 — refuse rather than guess when a wrong answer would be invisible. A
blurry render or a 7B vision model returns an answer that reads exactly as
confident as a correct one. "The logo is centred" from a 0.4-scale image is a
guess wearing a measurement's clothes, and D4 says never blend the two.

**Incident:** proposed as a token saving, and rejected for this reason. The cost
problem was never fidelity — it was persistence.

### H4. Read structure before pixels, and a range before a whole file.

`read_page` returns real text and clickable refs for a fraction of a
screenshot's cost. A named range or symbol beats a whole file.

**Why:** most questions asked of a screenshot — is the button there, what does
the error say, did the row render — are text questions being asked in the most
expensive available format.

### H5. End the session when the work changes.

**Incident:** one session reached 9,720 turns averaging 539,005 tokens of
context per turn: 5.2 billion tokens, 64% of everything this project has ever
spent. A fresh session runs at about 57k a turn. Same work, roughly nine times
the price, purely for having been asked in a long-running thread.

### H6. Measure before optimising.

**Incident:** twice in one session the cause was diagnosed confidently and
wrongly — first MCP connectors and plugin packs (worth about 3%), then repeated
source-file reads (worth 2%). Both were guesses. The transcripts had held the
real answer, images at ~45% of context, the entire time. Config was changed and
reverted before anyone looked at the data.

### H7. Read the event, do not infer it. Compactions are labelled.

A Claude transcript records each compaction on its own `system` line:

    compactMetadata: { trigger, preTokens, postTokens,
                       cumulativeDroppedTokens, durationMs }

followed by a `user` line carrying `isCompactSummary: true`. Exact numbers,
already written down. There is nothing to detect.

**Incident:** this session's compactions were first found by inferring them —
"context dropped to under half the previous turn". That found three of five. The
two it missed came in at ratios of 0.504 and 0.513, sitting a fraction the wrong
side of the threshold, and the miss was silent. The spec containing that
heuristic had already been handed to a build task before anyone checked it
against the marker.

**The corrected rule, in precedence order:**

1. `compactMetadata` / `isCompactSummary` where the provider writes them.
2. Only where a provider writes nothing — Codex, Cline, anything future — fall
   back to inference, and then require **both** a ratio under 0.75 **and** an
   absolute drop over ~30,000 tokens. A lone ratio threshold picks its own
   false negatives and never mentions them.

**Read `postTokens` correctly.** It is the size of the summary (12,931-21,109
here), not the context you resume at. The system prompt, tool definitions and
`CLAUDE.md` all come back on top, which is why the observed next turn was
71,306-84,180. Summary plus fixed overhead. Confusing the two understates a
resumed session by a factor of four.

**Two facts fall out of the metadata for free.** Every trigger here is `auto` —
nobody compacts deliberately, they hit the window wall at about 167,000. And
`durationMs` is 109-132 seconds per compaction, which is the cost that never
appears on a token meter. See H13.

### H8. Measure the baseline from the turn *after* a compaction, not the first turn.

`baselineFrom()` needs to know what a freshly-compacted session costs per turn,
because every break-even number the product prints is divided by it. It measured
first turns, found a 3.2x spread, correctly refused under D2, and fell back to a
constant of 57,000 that nobody had ever measured.

That is the wrong population. A first turn is the price of the *tool list*
(H10). The baseline for a *compaction* decision is the context on the turn after
a compaction — and those events are already in the curves we scan.

**Incident:** 17 real sessions hold 14 such events. Median 80,345, spread 2.3x,
which *passes* the same D2 gate the first-turn version failed. The assumed
57,000 was 41% low.

**Why it did not change the answer:** break-even on a 321k session is 1.2 turns
at 57,000, 1.3 at 80,345, and 2.0 at the worst event observed (161,263). The
recommendation survives a 2.8x error in its own input. Check that before you
panic about a wrong constant — and check it before you claim the constant
mattered.

Two things fell out of the same scan and are worth keeping: the median context
*before* those compactions was 951,338, meaning nobody compacts on purpose —
they hit the window wall. And mean context tracks median within 4% on every
session, so the headline is not a mean artifact.

### H9. A lifetime mean and a current context are two different numbers.

`bus cost` printed a column called `ctx/turn` in two tables with two different
meanings: the lifetime mean in one, the last turn in the other. Both were
correct. Together they read as a contradiction, and the first instinct is to go
looking for the arithmetic bug that is not there.

**Fix:** the columns are now `mean ctx/turn` and `ctx now`, with a footer saying
they diverge once a session has been compacted, because the mean still carries
the peaks that compaction removed. No arithmetic changed.

**Why:** a number that cannot be named precisely will be misread precisely.

### H10. Tool definitions are a per-turn cost. Defer them.

Tool schemas are part of the prompt, so H1 applies: you pay for every tool you
*could* call on every turn, whether or not you call one.

**Incident:** three benchmark probes on 2026-09-07 sent near-identical one-line
prompts and came back at 57,153 / 163,713 / 163,732 tokens of first-turn
context — 2.9x apart for the same question. The difference is deferred tool
loading. This session began at 73,884 rather than 163k for that reason alone.

Undeferred, the extra is about 89,829 tokens *per turn*. On a session the length
of the 9,870-turn one in H5 that is roughly 887 million tokens, near 10% of
everything this project has spent.

**This also explains H8's 3.2x spread.** It is not noise — it is bimodal. Two
populations, deferred and not. A spread that refuses to shrink is often two
distributions wearing one label; look for the second mode before you call it
variance.

### H11. What you read through the shell is invisible to the cost report.

The file-attribution list only counts `Read` tool blocks. Read a file with
`cat`, `sed` or `head` and its tokens are still paid for, but they land under
"Bash" with no filename.

**Incident:** found by pointing `bus cost` at this session. 64,321 tokens sat in
an unattributed "Bash" row while the offenders list showed nothing to fix.

**Why it matters more than it looks:** the hub is meant to serve every agent,
not just Claude. Codex, Aider and Cline read files through the shell *by
default*, so for those tools the offenders list is empty by construction. Fixing
attribution is a prerequisite for the multi-agent claim, not a polish item.

### H12. Every vendor counts context differently. Convert before you compare.

Claude's `input_tokens` **excludes** `cache_read_input_tokens`; a turn's context
is read + write + input. Codex's `input_tokens` **already includes**
`cached_input_tokens`; its context is `input_tokens` alone.

**Why:** add them the same way and you double-count Codex by roughly the size of
its own cache — which is 90%+ of the number. The bug reports a session as an
order of magnitude more expensive than it is, and it reports it confidently.

A provider adapter owns this conversion. Nothing downstream of it should ever
see a vendor's raw field names.

### H13. Compaction is cheap in tokens and expensive in the two things nobody meters.

The instinct is that compacting must be a false economy: you drop the context to
save tokens, then spend tokens re-reading what you dropped. Measured on this
session, that is not close to true.

    turn   before      after      saved/turn   turns since   earned
     166   165,331     71,306         94,025           427    40,148,675
     265   164,842     73,394         91,448           328    29,994,944
     365   167,176     82,175         85,001           228    19,380,228
     443   163,965     84,180         79,785           150    11,967,750
     563   166,514     83,883         82,631            30     2,478,930

Each compaction cost about 33,000 tokens — the figure the meter reported — and
paid it back in **0.35-0.41 turns**. Five of them spent 165,000 and earned
103,970,527: **630x**. For the re-reading
to cancel one out it would have to run to ~90,000 tokens — the whole of what was
just dropped. The actual re-reading after the last one was four scratchpad files,
about 5,000.

**So do not resist an auto-compaction on cost grounds.** The arithmetic is not
marginal and it does not turn over under any plausible re-read.

**The real costs are these two, and neither is on the meter:**

*Wall clock.* `durationMs` says 109-132 seconds each. Five compactions is about
ten minutes of a person waiting, and it lands mid-thought.

*Confident wrong statements.* Detail goes; the shape stays; and what is left
feels complete. In this session a rule was cited as already being in
`build-rules.md` when it was not there at all — stated flatly, with no hedge,
because the memory of having decided it survived the memory of never writing it.
That is the failure mode to plan for. Not expense — **misplaced certainty**.

**The mitigation is therefore not fewer compactions.** It is H14: write things
down, and after a compaction check the load-bearing claim rather than recalling
it. A2-style separation applies to facts as well as code — a fact on disk can be
verified in one read; a fact in a summary can only be believed.

### H14. Dropping context is only a saving if you do not have to buy it back.

H5 says end the session when the work changes. Read alone it argues for trimming
hard and often. It is half a rule. The other half:

**Re-reading is not a one-time cost.** Whatever you re-read re-enters context and
is then paid on every remaining turn (H1). Drop a 5,000-token file from a session
running at 147,000 per turn and you save 5,000 per turn — until you need it
again, at which point you have paid the drop, paid the search that found it, and
resumed paying the 5,000. Do that twice and the trim is a loss.

So the question is never "is this context expensive". It is:

    keep it       if  cost_per_turn * turns_left  <  cost_to_re-acquire
    let it go     otherwise

`cost_to_re-acquire` is the honest number, and it is bigger than it looks: the
search that locates the fact, the wrong file opened first, and the re-read
itself. It is also *slower*, which the token meter never shows.

**Note the asymmetry with H13.** An automatic compaction is 904x profitable
because it drops nearly everything and keeps working. A *hand-picked* trim of one
expensive file is often a loss, because the thing you chose to drop is usually
the thing you were about to need. Wholesale is cheap; retail is not.

**The resolution is durable notes, not more context.** A fact on disk costs zero
per turn and is re-acquired by reading forty lines instead of re-deriving it from
a 60MB transcript. That is the whole argument for F2, restated as arithmetic: the
cheapest place to keep a fact you might need is not in the conversation and not
in your memory of it, but in a file whose name the next agent can guess.

**Practical form:** before ending a session — and when a compaction is
obviously near — write down what the next turn would otherwise have to
rediscover. Findings go in this file. Anything project-specific and short-lived
goes on the board as a note. If it is worth re-reading, it was worth writing.

### H15. After a compaction, check the load-bearing claim. Do not recall it.

Compaction keeps the shape of a memory and drops the detail, so a fact you no
longer hold arrives feeling exactly like one you do. There is no internal
signal separating them. Confidence is not evidence of having checked.

**Incident:** an hour after a compaction, this session stated that
`docs/build-rules.md` already recorded the heredoc escaping trap. It did not;
the section did not exist and had to be written from scratch. What survived was
the memory of having *decided* the rule, which is indistinguishable from the
memory of having *written* it.

**Practical form:** one `grep` before one citation. If a claim is going to
steer the work — a rule exists, a function is called that, a number was
measured — and it predates a compaction, verify it. It costs one tool call.
The wrong version costs whatever gets built on top of it.

### H16. Compact at 80–100k, after a commit. Never let a session grow toward the 1M window.

H13 says an auto-compaction pays for itself. This rule is about *when*.
Re-reading is 98% of tokens (H1), so what a session costs is set by how big
its context gets before it is cut.

**Incident:** measured 2026-09-14 over one project's 18 session transcripts
(10,589 turns, deduped by message id). Two sessions ran on a 1M-token window and
never compacted. They averaged 548k and 516k tokens of context per turn, and
were **77% of everything the 18 sessions spent**. Capped by auto-compaction
(about 170k), the same work would have cost roughly 70% less. Sessions that did
auto-compact averaged 123k per turn.

Replaying the same work, with the same new tokens and output per turn, compacted
at a threshold T instead of at auto (~170k):

    compact at   spend vs auto   compactions
      130k           -11%           1.4x
      100k           -18%           1.9x
       80k           -23%           2.5x
       60k           -25%           3.6x

Weights: output 5, input 1, cache read 0.1, cache write 1.25. Each compaction
is charged at ~110 s and a ~4.5k-token summary.

**Why not 60k:** the replay does not charge for re-reading files after a
compaction (H14), or for the wall clock and misplaced certainty (H13). Those
grow with the number of compactions, so the real optimum is above where the
table bottoms out. Past 80k the extra saving is 2%, for half again as many
compactions.

**Practical form:**
- When context passes about 80–100k, finish the current step, commit, and
  compact.
- Before compacting, put what the next turn needs on the board or in a file
  (H14).
- After it, verify the load-bearing claim (H15).
- A session on a 1M window gets the same threshold. The bigger window is room
  for one large read, not permission to stop compacting.

---

## I. Editing files without breaking them

### I1. Never author code through a shell heredoc.

Write the patch script with a file-writing tool, and build every ambiguous
character from its char code:

    const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
    const Q  = String.fromCharCode(34);  // "
    const SQ = String.fromCharCode(39);  // '
    const BS = String.fromCharCode(92);  // backslash
    const NL = BS + "n";                 // the two-character escape, not a newline

**Incident:** three times in one session. The last one put a double-quoted
string inside a double-quoted string and turned a two-character `\n` into a real
newline on the way through the shell, producing `SyntaxError: missing ) after
argument list` in a file that had been working. The repair attempt then failed
too, for the same reason. `git diff -U6` found it; a char-code script fixed it
in one pass.

**Why:** the shell, the heredoc and the language each get a turn at
interpreting your quotes and backslashes, and they do not agree. Char codes
survive all three because there is nothing left to interpret.

### I2. These files are CRLF. Keep them that way.

`core.autocrlf=true`, no `.gitattributes`. A patch script must split on CRLF,
work in LF, and restore CRLF on save. Otherwise the diff is the whole file and
the actual change is unreviewable.

**Why:** a line-ending change looks like bad indentation to a reviewer and like
a rewrite to git. It is the trap that wastes an hour looking for a formatting
bug that was never there.

### I3. Assert your anchor matched exactly once.

    const parts = s.split(anchor);
    if (parts.length !== 2) throw new Error("matched " + (parts.length - 1) + " times");

**Why:** zero matches means your idea of the file is stale (A4) and a silent
no-op looks exactly like success. Two matches means you are about to change the
wrong one.

---

## J. Delegating to a local runner

### J1. A runner is blind. Paste the source; never name a file.

The ollama runners are prompt-in, text-out over `/api/generate`. No filesystem,
no tools, no repo. A prompt that says "read `docs/packaging.md` first" is an
instruction the model physically cannot follow.

**Incident:** two build tasks failed this way. One said so in its own reasoning:
*"We need to read docs/packaging.md to understand spec. But we don't have file
content."* The prompts were mine, and they broke a rule I had already written
down.

**Fix:** slice the source out of the file at prompt-build time
(`slice(rel, a, b)`, `block(rel, marker)`) so the model sees the bytes actually
on disk rather than what you remember being there. Then tell it plainly that it
has no filesystem, and ask for the new function plus the one-line anchor it
replaces — not a whole file.

### J2. A runner that stops mid-sentence hit a limit — and there are THREE, not one.

A thinking model spends `num_predict` twice: once reasoning, once answering.
But output budget is only the second limit anyone should check, because a
generation that stops early can be stopped by any of:

  - `num_predict` — the output budget (thinking + answer).
  - `num_ctx`  — the context window, which the PROMPT shares. Generation dies
    at whichever fills first, and the symptom is IDENTICAL: `response` empty,
    reasoning stranded in `thinking`.
  - the HTTP client's headers timeout — with `stream: false`, ollama sends no
    headers until generation ENDS, so a call that thinks longer than the
    timeout dies while the model was doing exactly what it was asked for.

**Incidents, in the order they were misread.** (1) A local reasoning model was
flagged `thinking: false` because of its name; three build tasks came back as stranded
reasoning and it read as the model being bad. 1,200 tokens is not enough to
think *and* answer. (2) Raising `num_predict` fixed that HALF of the time: a
further build task stranded at num_predict 14,000 and another at 32,000 on a
cloud model, still mid-reasoning — the real limit was `num_ctx`, which nothing in this
repo ever set, so ollama's default applied to a prompt of ~2,700 tokens. The
same symptom had three owners in a row, and one was blamed twice. (3) With the
window finally open, a cloud model call died on undici's 5-minute headers timeout —
fixed by streaming (`stream: true`), which also happens to be the shape in
which the other two limits stop being invisible: `done_reason` and the token
counts arrive on every chunk.

**Diagnostic (runner-limits.mjs enforces it):** read `done_reason` and the
counts before choosing a fix. `length` + `eval_count` at the budget = budget;
`length` + counts under it = the window; a stop = no failure at all. Output
that is confident and wrong is still a comprehension failure, and it needs the
opposite fix from any of these.

**Cost of getting it wrong:** two num_predict raises while three more tasks
stranded — each "fix" looked confirmed because the next attempt got further
before dying. A diagnosis that is not read from the runner's own report is a
guess, no matter how coherent the story around it is.

### J3. Hand the prompt over as an argument list, never through a shell.

    execFileSync(process.execPath, [SERVER, "task", lane, title, prompt], { ... })

**Why:** prompts contain code, and code contains every character a shell treats
as punctuation. An argument list has no shell in it, so there is nothing to
re-interpret. Same reasoning as I1, one layer out.

### J4. Peer output is a draft.

A returned task is a proposal to review, not a change to apply. Read it as you
would a pull request from someone who could not see the repo — because that is
exactly what it is.

### J5. Hand off a whole file's worth of work, never one small function.

A runner's tokens are free. The orchestrator's turns around each handoff are
not: writing the prompt, launching it, reading the draft and fixing it is 2–4
turns, and every one re-reads the whole conversation (H1). A 20-line spec for
a 25-line function buys almost nothing and costs all of those turns.

**Practical form:**
- Batch every function in one file into one handoff: one launch, one review.
- Code under about 30 lines, where the spec is nearly the code, you write
  yourself, in the same turn as its check.
- Checks are still written before either path, and verification never
  delegates (J4).

**Incident:** measured 2026-09-14 on one 1,237-turn build session, from its
transcript deduped by message id. 153 runner calls generated about
750k tokens, but only about 60k tokens of code landed. The 225 orchestrator
turns spent on handoffs cost about 4.5x what writing that code directly would
have: roughly 20% of the session's spend, for no saving. The one file handed
off as a batch (seven functions, one launch, one review) was the one clear win.

### J6. Ask for a role, not a model. The bus picks the runner, and retries a miss once elsewhere.

Which model is fast or reliable depends on the machine, the models pulled and
the week, so no rule names one. A rule names the job; the bus fills it from its
own finished tasks (`routing.mjs` `pickForRole`):

    role    the job                              the bus picks, over each runner's last 10 finishes
    quick   an ordinary job, about one file      lowest median run time among runners missing <= 25%
    deep    a long or tricky body (> 2k tokens)  fewest misses, then the longest answers

A miss is a failed task or a done one with no final answer. A runner needs 3
finishes before its record chooses; until then `task_add` pins nothing, the
lane's default runs, and the reply says so. The usual gates still apply:
enabled, the prompt fits its ctx, not on a three-failure streak.

**Practical form:**
- `task_add` with `role: "quick"` or `"deep"`, or no role and the prompt's
  size decides. The reply names the runner and why; pass `runner_id` to
  override.
- A miss is retried once, automatically, on the role's next runner, never the
  one that missed. A retry that misses too is left for a person: two runners
  missing the same prompt is about the prompt.
- An empty answer is a limit first (J2): read `done_reason` before blaming the
  model.

**Why:** measured 2026-09-14 over 153 calls in one session, two runners differed
threefold in time per call (29 s against 86 s) and nearly twofold in empty
answers (11% against 6%), while both spent 92–95% of what they generated
thinking. Neither was the slow part: the orchestrator's turns around them were
(J5). A rule written as "use model X for Y" was true for one machine for one
week; the measurement is what generalises.

---

## K. Running the bus itself

### K1. Every process that invokes `server.mjs` must name the project.

`stateDir()` resolves, in order: `AGENT_BUS_PROJECT`, else `git rev-parse
--git-common-dir` **against `process.cwd()`**. Shell out without setting one of
them and the bus serves whatever repo the calling shell happened to be sitting
in.

    execFileSync(process.execPath, [SERVER, "task", lane, title, prompt], {
      cwd: HUB,
      env: { ...process.env, AGENT_BUS_PROJECT: HUB },
    })

**Incident:** a requeue script queued two tasks, printed "Queued t5" and "Queued
t6", exited 0 — and put both on a different project's bus, because the tool that ran
it had its own working directory. The tasks then appeared to have vanished from
the hub. Time went into ruling out a lost write and a lock race, both of which
were fine. Nothing warned, because from the bus's point of view nothing was
wrong.

**Why this is the packaging bug in miniature:** `PROJECT_ROOT` is
`path.resolve(DIR, "..", "..")`, and a wrong root does not throw. `sessions.mjs`
hashes it to find the transcript directory, so the bus silently watches the
wrong project and reports confidently about it. See `docs/packaging.md`; the
same failure at install time is why `projectRoot()` has to replace the constant.

**The general rule:** when a wrong answer is indistinguishable from a right one,
the input has to be stated explicitly, not inferred from ambient state. Ambient
state is whatever the last tool left behind.

### K2. Bus calls save no tokens. Do the bus steps for a commit in one command.

The lock and the board keep agents out of each other's git work. That is what
they are for, and it is worth paying for. But the tool call is not the only
cost: every separate turn re-reads the whole conversation (H1).

    node server.mjs claim <name> <path> "commit X" && git commit -m "…"; node server.mjs release <name>

**Incident:** measured 2026-09-14 on the same 1,237-turn session: 142 turns
(11%) were bus calls alone, at 16.2M tokens of re-reading. Claim,
commit and release done as three turns cost three times what one command
costs, and they are no safer.

---

## L. Reporting yourself

### L1. When you catch yourself being wrong, file it.

    node tools/agent-bus/server.mjs miss "what I said" "what was true" "how it surfaced"

It lands on the board, so `findFixes` indexes it and the next agent meets it
before repeating it. Reporting the same subject again increments a counter
rather than adding a second note — a mistake made twice should look recurring,
not scroll away as two slips.

**Why the pair and not the correction:** a note saying "X is actually Y" hands
the next agent an answer. A miss hands it something better — the knowledge that
this is a question worth checking rather than recalling. The answer expires.
The warning does not.

### L2. What counts.

A miss is a **confident assertion that turned out to be false**: a rule cited
that was not there, a function named that does not exist, a number quoted from
memory that the data contradicts, a file described without opening it.

Not a miss: a stated assumption that proved wrong (that is D4 working), a
refusal (C1), or a guess you labelled as a guess. The distinguishing mark is
the **absence of hedging** — you were not uncertain, you were wrong.

**File it even when nothing broke.** The near miss is the cheap one to learn
from, and it is the one most likely to go unreported, because there is no
damage pointing at it.

### L3. A miss reported three times is a rule that has not been written yet.

The counter exists to be read. A subject that keeps coming back is not a
discipline problem; it is a missing guardrail, a badly named function, or a
fact that lives somewhere nobody looks. Promote it into this file with its
incident, and the reports stop.

**Why this is in the rulebook and not left to good intent:** an agent that has
just discovered it was wrong would rather move on, and every incentive it has
points at quietly correcting the work and saying nothing. That instinct is what
keeps a fixable pattern invisible for months. Filing it is the job, not an
apology.
