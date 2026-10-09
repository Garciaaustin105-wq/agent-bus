# awesome-mcp-servers PR draft — ready to file

Target repo: https://github.com/punkpeye/awesome-mcp-servers (the largest list).

## Category choice

`agent-bus` is multi-agent coordination (locks, noticeboard, handoff, a runner
queue — not commitments/escrow), so the closest existing sections are:

- **🛠️ Other Tools and Integrations** — safe, zero-friction.
- **🤝 Agreements & Coordination** — their scope is commitments/escrow/paid
  bounties; ours isn't that, so it risks a maintainer bounce.

Recommendation: file it under **Other Tools and Integrations**, and let the
maintainer move it if they'd rather split out a new "Agent Orchestration"
subsection — CONTRIBUTING says new categories are allowed ("please create one
and maintain alphabetical order"), so offer that as the option in the PR
description and let them pick.

## Entry (paste verbatim)

Place alphabetically within the chosen section by server display name
("agent-bus" sorts near the top of most sections). No npm badge — there is no
npm package yet (`agent-bus` is unclaimed on npm; see `docs/packaging.md`);
the language icon 📇 still applies (plain Node on disk):

```markdown
- <a href="https://github.com/Garciaaustin105-wq/agent-bus">agent-bus</a> 📇 🏠 🍎 🪟 🐧 - A shared lock, noticeboard, message bus and task queue for teams of AI agents working one repo — process-death locks, session handoffs, a model bench, and a savings counter that reads your real transcripts.
```

If the maintainer's convention is to include only entries that are installable
from a package registry, drop the badge icon and the entry still stands
(cloning is the install; the README's Getting it section is explicit).

## PR body

```markdown
Adds agent-bus under Other Tools and Integrations.

agent-bus is a zero-dependency MCP server + CLI + dashboard that coordinates
multiple AI agents working in one repo: an exclusive working-tree claim
(released by process death, not a heartbeat), a keyed noticeboard that
outlives conversations, a session-to-session handoff protocol, a task queue
with router delegation to local Ollama/OpenAI-dialect models, and a
cross-install lessons feed. Node ≥ 20, no npm install, 487-check harness.

Happy to move it to a new "Agent Orchestration" subsection if you'd prefer
that over Other Tools.
```

## Steps for you (user)

1. Fork punkpeye/awesome-mcp-servers.
2. Edit README.md at the chosen section, paste the entry in alphabetical spot.
3. Open the PR with the body above.
4. If a lint/CI runs on the PR, match whatever an existing entry fails fast on.