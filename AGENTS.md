# Agents working in this repo

Read `docs/build-rules.md` before writing any code — it is the live rulebook,
updated as incidents happen, and it outranks your habits. `docs/how-we-work.md`
describes how work splits between the orchestrator, the implementing agents and
the person.

This repo is its own app: the bus derives this repo's own `.git`, so its board,
its agents and its lock are separate from any other project's. `AGENT_BUS_PROJECT`
exists to point the bus at a *different* project root — it is unset here.

**Unset does not mean safe.** It means the root is derived from `process.cwd()`,
and cwd belongs to whichever tool made the call, not to you. Any script that
shells out to `server.mjs` must pass `cwd` **and** `AGENT_BUS_PROJECT`
explicitly. Getting this wrong does not fail — it succeeds against the wrong
repo and prints the same confirmation either way. See rule K1.