/**
 * Harness for fleet discovery — the probe, the drafts, the render, and the
 * askOpenAI runner the discovery feeds.
 *
 * The failures being pinned are the three hard lines in discover.mjs: the
 * probe never points off this machine, nothing-answering is a valid answer
 * rather than an error, and every draft ships disabled — discovery is
 * evidence, runners.json is authority.
 *
 * The probe itself is pure (fake fetch, no network). askOpenAI's SSE parse
 * gets ONE real loopback socket, because a stream parser is exactly the kind
 * of thing a fake lies about.
 *
 *   node tools/agent-bus/discover-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import http from "node:http";
import {
  buildRunnerDrafts,
  discoverLocal,
  probePort,
  renderDiscover,
  WELL_KNOWN_PORTS,
} from "./discover.mjs";
import { askRunner } from "./server.mjs";

const checks = [];
function check(label, fn) {
  checks.push(
    Promise.resolve()
      .then(fn)
      .then(() => console.log(`ok  [${label}]`))
      .catch((e) => {
        fails.push(`${label}: ${e.message}`);
        console.log(`FAIL [${label}] ${e.message}`);
      })
  );
}
const fails = [];
const rejects = async (fn, why) => {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`expected a refusal: ${why}`);
};

const answers = (body) => async () => ({
  ok: true,
  text: async () => JSON.stringify(body),
});
const refuses = async () => {
  throw new Error("ECONNREFUSED");
};

/* ------------------------------ the probe -------------------------------- */

check("probe-refuses-non-loopback-before-any-fetch", async () => {
  // The guard fires before the fetch is even attempted: there is no argument
  // anywhere that turns this probe into a scanner for someone else's network.
  const urls = [];
  await rejects(
    () => probePort({ host: "192.168.1.14", port: 1234, label: "x", kind: "openai" }, (u) => {
      urls.push(u);
      return answers({ data: [] })().then((r) => r);
    }),
    "a LAN address must be refused",
  );
  assert.equal(urls.length, 0, "the fetch never even ran");
});

check("nothing-answering-is-a-valid-answer-not-an-error", async () => {
  const found = await discoverLocal(WELL_KNOWN_PORTS, refuses, 100);
  assert.deepEqual(found, [], "an empty inventory is a normal result");
});

check("a-port-that-answers-garbage-is-skipped-not-fatal", async () => {
  // 1234 speaks OpenAI; 11434 has a database on it today. The scan reports
  // what it found and says nothing dramatic about the rest.
  const fetchImpl = (url) => {
    if (url.includes(":11434")) return answers("<html>not json</html>")();
    if (url.includes(":1234")) return answers({ data: [{ id: "qwen2.5-7b-instruct" }] })();
    return refuses();
  };
  const found = await discoverLocal(WELL_KNOWN_PORTS, fetchImpl, 100);
  assert.equal(found.length, 1, "one server found");
  assert.equal(found[0].models[0], "qwen2.5-7b-instruct");
});

check("ollama-and-openai-shapes-both-parse-from-v1-models", async () => {
  // Ollama serves the same OpenAI-compatible /v1/models its dialect siblings
  // do — one probe shape covers every local server family.
  const fetchImpl = (url) => {
    if (url.includes(":11434")) return answers({ data: [{ id: "gpt-oss:20b" }] })();
    if (url.includes(":1234")) return answers({ data: [{ id: "qwen2.5-7b-instruct" }] })();
    return refuses();
  };
  const found = await discoverLocal(WELL_KNOWN_PORTS, fetchImpl, 100);
  assert.equal(found.length, 2);
  assert.equal(found.find((f) => f.kind === "ollama").models[0], "gpt-oss:20b");
  assert.equal(found.find((f) => f.kind === "openai").models[0], "qwen2.5-7b-instruct");
});

/* ----------------------------- the drafts -------------------------------- */

check("drafts-are-typed-by-kind-and-loopback-rooted", () => {
  const drafts = buildRunnerDrafts([
    { port: 11434, kind: "ollama", label: "Ollama", models: ["gpt-oss:20b"] },
    { port: 1234, kind: "openai", label: "LM Studio", models: ["qwen2.5-7b-instruct"] },
  ]);
  const ollama = drafts.find((d) => d.type === "ollama");
  const openai = drafts.find((d) => d.type === "openai");
  assert.equal(ollama.model, "gpt-oss:20b", "the ollama draft names the model");
  assert.equal(openai.baseUrl, "http://127.0.0.1:1234/v1", "the openai draft points at the server it was found on");
  assert.equal(openai.model, "qwen2.5-7b-instruct");
});

check("every-draft-ships-disabled", () => {
  // Discovery never enables. The human pastes the block, reads it, and flips
  // each runner on — the inventory is evidence, the file is authority.
  const drafts = buildRunnerDrafts([
    { port: 1234, kind: "openai", label: "LM Studio", models: ["a", "b"] },
  ]);
  assert.equal(drafts.length, 2);
  for (const d of drafts) assert.equal(d.enabled, false, `${d.id} must be disabled`);
});

check("duplicate-model-names-get-unique-ids", () => {
  // Two servers happily serve the same model name; runners.json keys on id.
  const drafts = buildRunnerDrafts([
    { port: 1234, kind: "openai", label: "LM Studio", models: ["qwen"] },
    { port: 8080, kind: "openai", label: "llama.cpp", models: ["qwen"] },
  ]);
  const ids = drafts.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, "no id collision");
  assert.deepEqual(ids, ["openai-qwen", "openai-qwen-2"]);
});

/* ----------------------------- the render -------------------------------- */

check("render-names-the-gate-and-the-disabled-state", () => {
  const findings = [{ port: 1234, kind: "openai", label: "LM Studio", models: ["m"] }];
  const out = renderDiscover(findings, buildRunnerDrafts(findings));
  assert.ok(out.includes("DISABLED"), "the human is told pasting adds nothing that runs");
  assert.ok(out.includes("runners.json"), "and where the drafts go");
  assert.ok(out.includes("m"), "the found model is listed");
});

check("render-of-an-empty-machine-is-calm-not-an-error", () => {
  const out = renderDiscover([], []);
  assert.ok(out.includes("nothing"), "a cloud-only machine gets a normal sentence");
  assert.ok(!out.toLowerCase().includes("error"), "and no error language");
});

/* ------------------- the runner the drafts feed (real socket) ------------- */

check("askRunner-runs-an-openai-runner-over-a-real-sse-stream", async () => {
  // One real loopback socket: a stream parser is exactly the thing a fake
  // fetch would lie about. The server answers in OpenAI SSE shape, with the
  // first data: line split across two writes — the seam a per-chunk buffer
  // would lose.
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const line1 = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\n';
    res.write(line1.slice(0, 20));
    setTimeout(() => {
      res.write(line1.slice(20) + 'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, 10);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const out = await askRunner(
      { id: "t", type: "openai", model: "m", baseUrl: `http://127.0.0.1:${port}/v1` },
      "say hi",
    );
    assert.equal(out, "hello", "deltas reassembled across the chunk seam");
  } finally {
    srv.close();
  }
});

check("askRunner-refuses-an-openai-runner-pointed-off-this-machine", async () => {
  // The loopback boundary holds on the RUN side, not just the probe side.
  await rejects(
    () => askRunner({ id: "bad", type: "openai", model: "m", baseUrl: "http://10.0.0.9:1234/v1" }, "hi"),
    "an off-box baseUrl must be refused",
  );
  await rejects(
    () => askRunner({ id: "bad", type: "openai", model: "m", baseUrl: "https://api.example.com/v1" }, "hi"),
    "https is for cloud APIs this runner type does not speak — refused, not silently sent",
  );
});

await Promise.all(checks);
console.log(`\n${checks.length - fails.length} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log(`  ${f}`);
  process.exit(1);
}
console.log("DONE");