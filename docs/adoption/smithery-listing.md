# Smithery listing — the honest version

Researched 2026-10-08 against https://smithery.ai/docs/build/publish.md.

**Upfront verdict: Smithery is gated behind packaging work we haven't done.**
Do Show HN and awesome-mcp first; this one is last.

## Why it's gated

Smithery publishes servers two ways, and neither is "point at a git repo":

1. **URL path** — requires the server reachable over **Streamable HTTP** with
   OAuth discovery. agent-bus is a **stdio** JSON-RPC server. Wrong transport;
   would need an HTTP shim built and hosted. Not worth it.
2. **Local (MCPB bundle) path** — a downloadable `.mcpb` (MCP Bundle, the
   former DXT format) clients run locally. This is the right path for us, and
   it requires the npm-package work in `docs/packaging.md` first: a `.mcpb` is
   a manifest + packaged server, and right now the hub is a folder in a git
   repo whose PROJECT_ROOT assumes it sits at `<repo>/tools/agent-bus/`.

So the real dependency chain is:

    packaging.md project_root() + package.json → npm publish → .mcpb bundle
    → smithery mcp publish ./agent-bus.mcpb -n garciaaustin105/agent-bus

## The steps, once packaging is done (from the publish docs)

1. Build the `.mcpb` bundle for the stdio server.
2. Publish:
   ```sh
   smithery mcp publish ./agent-bus.mcpb -n your-org/agent-bus
   ```
3. Smithery scans the bundle to extract tools, prompts, resources. The
   stdio MCP surface is 28 tools, so scanning needs no help.
4. Settings → Verification: complete the automatic official-vendor checklist.

## Notes and gotchas (from the docs, verified above)

- Config passed by the client at session start needs a **config schema**
  (JSON Schema; optional `x-from` extension) — for us that is roughly
  `AGENT_BUS_PROJECT`, i.e. the server should accept it as a declared
  client-config field rather than only an env var.
- No `smithery.yaml` is mentioned anywhere in the current publish docs —
  older blog posts reference it; the docs now use the manifest/bundle flow.
- If we ever add a Streamable HTTP endpoint for hosted use: return **401**
  (never 403) for unauthenticated requests, so OAuth discovery works; that is
  their #1 reported 403-during-scan complaint.