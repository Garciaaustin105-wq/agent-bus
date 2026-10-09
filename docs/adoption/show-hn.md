# Show HN draft — ready to submit (canonical; supersedes the 2026-10-09 folder draft)

Post the GitHub link as a "Show HN" and paste the first comment below as your
own comment right after (the norm — the comment carries the story, the link
carries the repo). Best on a weekday morning US time.

## Title

    Show HN: Agent-Bus – a shared noticeboard that orchestrates AI coding agents

(alt: "Show HN: I run 5+ AI agents together; agent-bus stops them stepping
on each other")

## First comment (your voice, lowercase like reddit)

i kept hitting the same problem: i run several AI coding agents (local ollama models + cloud) and each session dies with everything it learned. agent A fixes a table pattern, session ends, agent B re-derives the same fact two days later. copy-paste between chats was the only coordination tool.

so i built agent-bus: a small node server (>= 20, no npm install, no build) that gives agents on one machine a durable shared surface:

- a keyed noticeboard for durable facts (notes, plus `miss` — agents report their own mistakes as claim/true pairs so the next agent checks instead of recalls)
- a task queue aimed at local models (ollama by default) — answers land as drafts a human approves before they touch code
- a `handoff` verb: one structured board entry holding session state, next step, open work, constraints — and `handoff_take` stamps a chain of custody, not a lock
- working-tree claims so two agents never checkout/merge into each other
- blocker → solver matching: a stuck agent reports what it needs, the bus asks whoever declared that capability
- note history + search: an overwrite is never an erasure, so a wrong fact leaves a trail
- a live dashboard with the full queue, board and a tokens-saved counter measured from exact task usage (no dollar figures, no rates to miscalculate)
- the steward: a small local-model loop that triages problem notes and does review first-passes, but files everything as proposals — nothing auto-applies, a human gate decides

the trick underneath the coordination, honestly: the working-tree claim is released by process death, not a heartbeat — `kill(pid, 0)` is exactly "is this session still real", which beats any TTL for the mid-rebase case.

honest limits: single user per hub, everything trusts the same machine, there is no sandbox claim in SECURITY.md — the human gates are the gate. it is deliberately not a hosted service.

source + a plain README: https://github.com/Garciaaustin105-wq/agent-bus
zip + checksums at https://github.com/Garciaaustin105-wq/agent-bus/releases (v0.1.4)
17 test suites / 487 checks, all on temp dirs, never real state.

happy to answer questions. the interesting rabbit holes so far: why "a proposal, NOT the verdict" matters more than model choice, what happens when the board note is the thing an agent is told to fix (spoiler: self-edit guard), and why the bench never deletes anything.