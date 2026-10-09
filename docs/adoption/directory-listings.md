# Other MCP directory listings — notes (Smithery UNBLOCKED)

Researched against live docs 2026-10-08; corrects the 2026-10-09 folder draft
item 3 and an earlier "gated behind packaging" verdict — **Smithery is already
unblocked**: `smithery.yaml` at the repo root (commit `ee1ff24`,
2026-10-10) declares the stdio startCommand and was stdio-probed 25 tools
(now 28 after recall-and-care).

## Smithery (smithery.ai) — CAN BE SUBMITTED NOW

`smithery.yaml` at repo root:

```yaml
startCommand:
  type: stdio
  configSchema: { type: object, properties: {} }
  commandFunction: |-
    (config) => ({ "command": "node", "args": ["tools/agent-bus/server.mjs"], "env": {} })
```

Submit: smithery.ai publishing flow, repo-based install.

## Glama (glama.ai/mcp/servers) — auto-indexes GitHub by structure

Nothing to submit unless absent; then use their "add server" flow with the
repo URL. Once indexed, its score badge goes into the awesome-list entry line
(the way Network-AI's carries one).

## mcp.so — submit form

Repo URL + description. Use the directory one-liner.

## MCPMarket / PulseMCP — submission forms

PulseMCP takes a "what it does" write-up — use the base paragraph below.
MCPMarket category: pick **Developer Tools** (their taxonomy is not the
awesome-list taxonomy — never "Aggregators" here).

## X/Twitter + Reddit r/MCP — later, adapted copy

Keep the lowercase voice from the Show HN comment, cut to half length.

## Current base description + one-liners

- Base: agent-bus is a durability layer for AI agent fleets: one small local
  server (MCP over stdio + CLI + live dashboard, plain Node ≥ 20, MIT) giving
  every agent session a shared keyed noticeboard (with history + search), a
  task queue aimed at local models (human-gated, nothing auto-applies),
  working-tree claims, blocker→solver matching, session handoffs with a chain
  of custody, and a tokens-saved counter measured from exact task usage.
- ≤75 chars: "A shared noticeboard, task queue and handoff surface for agent fleets."
- Directory short: "Durable shared memory, task queue and session handoffs for
  multi-agent coding fleets, with a local-model steward and a live dashboard."

## Order

awesome-mcp PR first (do-follow link + most traffic), then mcp.so +
MCPMarket/PulseMCP forms (mechanical), Glama (waiting game), **Smithery now
that it is unblocked — any time**. Show HN whenever you like.