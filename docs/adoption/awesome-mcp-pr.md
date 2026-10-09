# awesome-mcp-servers PR draft — ready to file (canonical; supersedes the 2026-10-09 folder draft)

Target repo: https://github.com/punkpeye/awesome-mcp-servers (the largest list;
entry format verified against the repo 2026-10-08 — entries are
markdown links `- [owner/repo](url) 📇 🏠 … - one-liner`, no periods on
descriptions, alphabetically ordered within each section).

## Where

Section `### Aggregators` (🤝/🔗 heading in the README) — direct precedent:
Jovancoding/Network-AI's "Multi-agent orchestration with a
race-condition-safe shared blackboard…" entry. Insert alphabetically:
sort by the repo's display name — the G block of
`[Garciaaustin105-wq/agent-bus](…)`.

Alternative (only if the maintainer prefers): brand-new
"Agent Orchestration" subsection — CONTRIBUTING allows new categories
("please create one and maintain alphabetical order"). Offer it in the PR
description; default to Aggregators.

## The entry (paste verbatim)

```markdown
- [Garciaaustin105-wq/agent-bus](https://github.com/Garciaaustin105-wq/agent-bus) 📇 🏠 🍎 🪟 🐧 - Durable shared noticeboard, task queue and session handoffs for multi-agent coding fleets, with a local-model steward and a live dashboard.
```

Badge legend check: 📇 = TypeScript/JS codebase ✓ (plain-node JS — no npm
package; `agent-bus` is unclaimed on npm, see `docs/packaging.md`); 🏠 = local ✓
(no hosted service); 🍎 🪟 🐧 ✓ (Node ≥ 20 runs all three). No 🎖️ (not an
official reference implementation). No glama score badge yet — the repo is not
Glama-indexed (see `directory-listings.md`); once indexed, add the badge the
way Network-AI's line carries one.

## PR body

Title: `Add Garciaaustin105-wq/agent-bus`

```markdown
Adds agent-bus under Aggregators (alphabetical).

agent-bus is an MCP server (stdio, plain Node ≥ 20, no npm install or build)
plus CLI and live desktop dashboard that gives AI coding agents on one
machine a durable shared surface: a keyed noticeboard (with history and
search — an overwrite is never an erasure), a task queue for local models
with human-gated review (nothing auto-applies), working-tree claims released
by process death instead of a heartbeat, blocker→solver matching, session
handoffs with a taken chain, and a local-model steward loop that triages
problems and drafts briefs — every verdict stays with a human.

- MIT
- v0.1.4, 17 test suites / 487 checks (temp dirs, never real state)
- SECURITY.md states the honest limits (single-user per hub, no sandbox claim)
```

## Steps for you (user)

1. Fork punkpeye/awesome-mcp-servers, branch `add-agent-bus` off main.
2. Edit README.md: paste the entry into Aggregators at the alphabetical spot.
3. Open the PR with the title + body above; watch CI (it checks link
   order/format) and fix anything it names.