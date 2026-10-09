# Show HN draft — ready to submit

**Submitted by:** you (the user), at https://news.ycombinator.com/submit

## Title

    Show HN: Agent-bus – a lock, noticeboard and bench for teams of AI agents

(alt, if you'd rather lead with the pain it fixes: "Show HN: I run 5+ AI
agents together; agent-bus stops them stepping on each other")

## Text

Hi HN. I kept several AI coding agents working together in one repo — Claude
sessions, a local model runner, shell scripts — and two things kept going
wrong, neither fixable by talking more:

1. Two sessions used the same working tree and switched branches under each
   other mid-edit.
2. A lane spec went stale between being written and being read — four times.
   Nobody was talking when each fact went stale, so no message could have
   caught them.

So I built the thing those failures imply: a shared **lock** (a claim is
released by process death, not a heartbeat — `kill(pid, 0)` turns out to be
exactly "is this session still real", which beats any TTL for the mid-rebase
case), a **noticeboard** that outlives conversations, and messaging as the
smaller third feature. There's also a bench that benchmarks the local models
you already have, a handoff verb for session-to-session transfer, and a
savings counter that reads the actual Claude transcripts and reports what
every session spent — because the whole point of delegating to local models
is the token bill, and it was invisible.

No dependencies: raw JSON-RPC over stdio, plain Node ≥ 20. Runs as an MCP
server, a CLI, and a small desktop dashboard — one repo, cloned and run.

Repo: https://github.com/Garciaaustin105-wq/agent-bus

Highlights I'd bet on:

- 487-check harness (17 suites) that all use temp dirs, never real state
- Zero-dependency contract, enforced by a harness assertion, not comments
- The steward pattern: a small local model (~7B) triages reported problems,
  drafts the brief, and a person reviews before anything touches code
- Cross-install lessons: a lesson travels as the shape of a mistake, never
  anyone's actual data; only a human can make it a rulebook rule

Windows-first (it began on a Windows box with three agents fighting over
it); the CLI and dashboard are plain Node and run anywhere.

Happy to answer questions about the design choices — especially the
process-death lock vs heartbeat tradeoff, and the deliberate dumbness of
"who can unblock this blocker" keyword matching.