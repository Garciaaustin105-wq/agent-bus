/**
 * Fleet discovery — what can this machine actually run?
 *
 * The hub can only run what runners.json declares, and that file is
 * hand-written. For someone who never edited it, the hub is blind to half
 * their machine. This module scans — read-only — for the local model servers
 * that almost every tool exposes the same way: an OpenAI-compatible
 * /v1/models endpoint on a well-known port. Ollama serves it too, so one
 * probe shape covers Ollama, LM Studio, llama.cpp, vLLM and
 * text-generation-webui; a brand nobody uses is not a special case, it is
 * just a port that did not answer.
 *
 * Three hard lines, all pinned by the harness:
 *
 *   LOOPBACK ONLY. The probe never targets a non-loopback host — no argument
 *   anywhere can turn it into a scanner for someone else's network. There is
 *   no host parameter; there is a guard anyway, because a guard that is
 *   provably unreachable beats a design that relies on nobody adding one.
 *
 *   NOTHING ANSWERING IS A VALID ANSWER. No local models is a normal shape
 *   for this tool — most installs will be cloud-only. A refused connection or
 *   a timeout is skipped, not an error.
 *
 *   DISCOVERY NEVER ENABLES. The output is a DRAFT with every entry disabled:
 *   pasting it into runners.json adds the runners, and the human flips each
 *   one on. The inventory is evidence, not authority — the file stays the
 *   only thing the bus will run.
 *
 * Pure where possible: the probe takes its fetch implementation as an
 * argument, so the harness runs against fake servers with no network and no
 * disk (build rule 2). Only the CLI verb touches a real socket.
 */

// Who answers /v1/models where, by default. One line each, deliberately
// short: this is "the ports worth probing in a second", not a census.
export const WELL_KNOWN_PORTS = [
  { port: 11434, kind: "ollama", label: "Ollama" },
  { port: 1234, kind: "openai", label: "LM Studio" },
  { port: 8080, kind: "openai", label: "llama.cpp server" },
  { port: 8000, kind: "openai", label: "vLLM" },
  { port: 5000, kind: "openai", label: "text-generation-webui" },
];

const LOOPBACK = /^(?:127\.|localhost$|::1$|\[::1\]$)/;
/** Shared with server.mjs: a local runner URL is loopback or it is refused. */
export const assertLoopback = (host) => {
  if (!LOOPBACK.test(host)) {
    throw new Error(`the fleet probe only ever points at this machine — refusing "${host}"`);
  }
  return host;
};

/**
 * Probe one port for a models list. Resolves null for anything that is not a
 * clean answer — refused, timed out, non-JSON, wrong shape — because a port
 * with a database on it is not a failure, it is just not a model server.
 */
export async function probePort({ host = "127.0.0.1", port, label, kind }, fetchImpl = fetch, timeoutMs = 1_000) {
  assertLoopback(host);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`http://${host}:${port}/v1/models`, { signal: abort.signal });
  } catch {
    return null; // nothing there, or too slow to be worth waiting for
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return null;
  let doc;
  try {
    doc = JSON.parse(await res.text());
  } catch {
    return null;
  }
  const models = (Array.isArray(doc?.data) ? doc.data : [])
    .map((m) => (typeof m?.id === "string" ? m.id : null))
    .filter(Boolean);
  if (!models.length) return null;
  return { host, port, kind, label, models };
}

/**
 * Probe every well-known port in parallel. Returns the findings that
 * answered — possibly none, which is the normal answer on a cloud-only
 * machine, not an error.
 */
export async function discoverLocal(ports = WELL_KNOWN_PORTS, fetchImpl = fetch, timeoutMs = 1_000) {
  const probed = await Promise.all(ports.map((p) => probePort(p, fetchImpl, timeoutMs)));
  return probed.filter(Boolean);
}

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "model";

/**
 * Turn findings into runners.json-shaped entries. Every draft is disabled:
 * the human pastes the block, then flips each runner on after checking it.
 * Ids are namespaced by kind and deduped, because two servers can happily
 * serve the same model name and runners.json keys on id.
 */
export function buildRunnerDrafts(findings) {
  const drafts = [];
  const used = new Set();
  const nextId = (base) => {
    let id = base;
    let n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    return id;
  };
  for (const f of findings) {
    for (const model of f.models) {
      if (f.kind === "ollama") {
        drafts.push({
          id: nextId(`ollama-${slug(model)}`),
          label: `${model} — local (${f.label})`,
          type: "ollama",
          model,
          enabled: false,
          note: `Discovered on port ${f.port} (${f.label}). Measure ctx/predict before dispatch — see HANDOFF section 4.`,
        });
      } else {
        drafts.push({
          id: nextId(`${f.kind}-${slug(model)}`),
          label: `${model} — local (${f.label})`,
          type: "openai",
          baseUrl: `http://127.0.0.1:${f.port}/v1`,
          model,
          enabled: false,
          note: `Discovered on port ${f.port} (${f.label}), OpenAI-compatible. Measure ctx/predict before dispatch.`,
        });
      }
    }
  }
  return drafts;
}

/** The human-facing printout: what answered, the draft, and the gate. */
export function renderDiscover(findings, drafts) {
  const lines = ["FLEET DISCOVERY — what answered on this machine:"];
  if (!findings.length) {
    lines.push("  nothing — no local model server answered on the well-known ports.");
    lines.push("  That is a normal answer: a cloud-only install works fine, and the");
    lines.push("  cloud runners you declare in runners.json are the whole fleet.");
  } else {
    for (const f of findings) {
      lines.push(`  ${f.label} on :${f.port} (${f.models.length} model${f.models.length === 1 ? "" : "s"})`);
      for (const m of f.models) lines.push(`     ${m}`);
    }
  }
  lines.push("");
  if (drafts.length) {
    lines.push("DRAFT runner entries — paste into tools/agent-bus/runners.json.");
    lines.push("Every entry ships DISABLED: nothing runs until you set enabled:true,");
    lines.push("and ctx/predict should be measured on a real task first (HANDOFF §4).");
    lines.push("");
    lines.push(JSON.stringify({ runners: drafts }, null, 2));
  } else {
    lines.push("No drafts — nothing new to add.");
  }
  return lines.join("\n");
}