/**
 * The dashboard's HTTP edge, against a REAL hub process on a real socket.
 *
 * The failure being pinned (audit S1): loopback binds the port to the machine
 * but not the page. A form POST from any website open in any browser is a
 * simple request — no CORS preflight — so without an Origin check,
 * http://evil.example could drive the bus: release a claim, post as "human",
 * start workers. And without a Host check, DNS rebinding (a remote domain
 * resolving to 127.0.0.1) reads the page.
 *
 *   node tools/agent-bus/hub-http-harness.mjs   (exit 0 = all green)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// A free port, found the boring way: bind 0, read what the OS gave, release.
const freePort = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
  s.on("error", reject);
});

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-hub-http-"));
const stateDir = path.join(HOME, ".git", "agent-bus");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
  path.join(stateDir, "state.json"),
  JSON.stringify({ agents: {}, lock: null, messages: [], board: {}, tasks: [], taskSeq: 0 })
);
// The hub renders the repo's docs live (rules, how-we-work, the workflow
// spine); seed the real spine so the panel has something to parse.
fs.mkdirSync(path.join(HOME, "docs"), { recursive: true });
fs.copyFileSync(
  path.join(import.meta.dirname, "..", "..", "docs", "workflow-spine.md"),
  path.join(HOME, "docs", "workflow-spine.md")
);

const child = spawn(
  process.execPath,
  [path.join(import.meta.dirname, "hub.mjs"), String(freePort)],
  { env: { ...process.env, AGENT_BUS_PROJECT: HOME }, stdio: ["ignore", "pipe", "pipe"] }
);

// The hub prints its real port once listening. "0" is refused as NaN by the
// port parser, so pass a free high port picked the boring way: try until it
// answers.
let port = 0;
const lineChunks = [];
child.stdout.on("data", (c) => {
  lineChunks.push(String(c));
  const m = lineChunks.join("").match(/dashboard: http:\/\/127\.0\.0\.1:(\d+)/);
  if (m && !port) {
    port = Number(m[1]);
    ready();
  }
});
child.stderr.on("data", (c) => process.stderr.write(c));

let portDeadline;
const ready = () => clearTimeout(portDeadline);
portDeadline = setTimeout(() => {
  console.log("FAIL [hub started] no listen line within 15s");
  process.exit(1);
}, 15_000);

// Wait for the port line, then a moment for the server to accept.
const waitPort = async () => {
  while (!port) await new Promise((r) => setTimeout(r, 50));
};

const GET = (url, headers = {}) => fetch(url, { headers });

// Raw socket client: fetch() forbids setting the Host header (it is a
// forbidden header in the fetch spec), and DNS rebinding is exactly a forged
// Host — so this check goes through node:http, which allows it.
const rawGet = (headers) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "GET", headers },
      resolve
    );
    req.on("error", reject);
    req.end();
  });

await waitPort();
const base = `http://127.0.0.1:${port}`;

let pass = 0;
let fail = 0;
const check = async (label, fn) => {
  try {
    await fn();
    pass++;
    console.log(`ok  [${label}]`);
  } catch (e) {
    fail++;
    console.log(`FAIL [${label}] ${e.message}`);
  }
};

await check("an evil Origin is refused — the drive-by form POST gets nothing", async () => {
  const res = await fetch(`${base}/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.example" },
    body: "action=note&key=pwned&value=posted-from-a-webpage",
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  const board = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(board.board.pwned, undefined, "the forged note must not be on the board");
});

await check("the dashboard's own Origin is accepted", async () => {
  const res = await fetch(`${base}/`, {
    method: "POST",
    redirect: "manual", // else fetch follows the 303 and reports the 200 after it
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: "action=note&key=own-origin&value=ok",
  });
  assert.equal(res.status, 303, `expected 303 redirect, got ${res.status}`);
  const board = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.ok(board.board["own-origin"], "the note landed");
});

await check("a non-browser client (no Origin header) is still allowed", async () => {
  const res = await fetch(`${base}/`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "action=note&key=no-origin&value=ok",
  });
  assert.equal(res.status, 303, `curl/scripts have nothing to coerce; got ${res.status}`);
});

await check("a foreign Host header is refused — DNS rebinding reads nothing", async () => {
  const res = await rawGet({ host: "evil.example" });
  assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}`);
  res.resume();
});

await check("the normal page still renders", async () => {
  const res = await GET(base);
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const html = await res.text();
  assert.ok(html.includes("agent-bus"), "the dashboard page");
  assert.ok(html.includes("This machine"), "the hardware panel renders even where nvidia-smi is absent");
});

await check("a live process shows running even hours cold; a dead one falls back to quiet", async () => {
  // The 1-hour prune and the 2-minute quiet both answer "has it called the
  // bus" — not "is it running". The pid closes that gap: the hub asks the OS
  // whether the agent's process exists, so a long-lived agent working locally
  // between bus calls stays bright, and the fallback stays honest. Each
  // assertion gets its own render so the two cards cannot blur together.
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const s = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  s.agents = {
    "live-runner": {
      lane: "build", cwd: HOME, pid: child.pid, host: os.hostname(),
      registeredAt: stale, lastSeen: stale,
    },
  };
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(s));
  let html = await (await GET(base)).text();
  assert.ok(html.includes('<span class="run">running</span>'), "the badge renders for a verifiable process");
  assert.ok(!html.includes('class="card quiet"'), "a live process is not dimmed, whatever its lastSeen");

  s.agents = {
    "ghost-cli": {
      lane: "cli", cwd: HOME, pid: 4000000000, host: os.hostname(),
      registeredAt: stale, lastSeen: stale,
    },
  };
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(s));
  html = await (await GET(base)).text();
  assert.ok(!html.includes('<span class="run">running</span>'), "a dead pid earns no badge");
  // The render path prunes, so the hour-cold dead-pid agent is not even quiet
  // — it is gone, its name freed. Quiet is for the two-minute window; past the
  // hour with no verifiable process, the honest board has nobody on it.
  assert.ok(!html.includes("ghost-cli"), "pruned at render, not displayed stale");
  assert.ok(html.includes("Nobody on the bus yet"), "the empty board says so");
});

await check("a task has its own page with its own worktree and problems", async () => {
  const q = await fetch(`${base}/`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "action=task&lane=local&title=fix+the+gauge&prompt=" +
      encodeURIComponent("rewrite the gauge module, spec: do it exactly"),
  });
  assert.equal(q.status, 303, `queueing got ${q.status}`);
  const res = await GET(`${base}/task/t1`);
  assert.equal(res.status, 200, `task page got ${res.status}`);
  const html = await res.text();
  assert.ok(html.includes("fix the gauge"), "the task's title");
  assert.ok(html.includes("rewrite the gauge module"), "the FULL prompt, not the 200-char preview");
  assert.ok(html.includes("Its worktree"), "the worktree section");
  assert.ok(html.includes("Problems (0)"), "the problems section, empty for a clean task");
});

await check("a task id that does not exist is a 404, not a broken page", async () => {
  const res = await GET(`${base}/task/t999`);
  assert.equal(res.status, 404, `unknown task got ${res.status}`);
});

await check("the learning panels render — recurring misses hot, outcomes per runner", async () => {
  // Nothing else writes state between requests, so a direct write here is
  // safe; the hub re-reads the file on every request.
  const s = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const nowIso = new Date().toISOString();
  s.board["miss-wrong-schema"] = {
    value: "SELF-REPORTED MISS (3x — RECURRING). CLAIMED: the column is an integer.",
    by: "lane-d", at: nowIso, miss: true, seen: 3,
  };
  s.tasks.push(
    { id: "t2", title: "draft the module", lane: "local", status: "done",
      model: "gpt-oss", result: "x".repeat(3000), at: nowIso, doneAt: nowIso },
    { id: "t3", title: "draft the sibling", lane: "local", status: "failed",
      model: "gpt-oss", result: "budget ran out mid-thought", at: nowIso, doneAt: nowIso }
  );
  // Real tasks always come from task_add, which bumps taskSeq past the id it
  // handed out. A direct push that skips that leaves taskSeq at 1, so the next
  // POST reissues t2 and two tasks share an id — /task/t2 then renders the
  // older one and every later check reads the wrong task. Keep the sequence
  // honest: the simulation writes what the real writer would have left.
  s.taskSeq = 3;
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(s));
  const html = await (await GET(base)).text();
  assert.ok(html.includes("Learning debt (1)"), "the debt panel exists and counts");
  assert.ok(html.includes("miss-wrong-schema"), "the miss is listed");
  assert.ok(html.includes("reported 3x"), "the recurrence is visible — that is the L3 trigger");
  assert.ok(html.includes("the delegation ledger"), "the outcome panel exists");
  assert.ok(html.includes(">gpt-oss<"), "the runner appears with its outcomes");
  assert.ok(html.includes('style="color:var(--warn)">1<'), "the failure is rendered hot, not silently");
});

await check("the workflow spine renders — ten stages, live from the doc", async () => {
  const html = await (await GET(base)).text();
  assert.ok(html.includes("The workflow spine — 10 stages"), `panel heading, got: ${html.slice(0, 0)}`);
  for (const stage of ["Idea", "Spec", "Design", "Build", "Review", "Test", "Release", "Publish", "Monitor", "Maintain"]) {
    assert.ok(html.includes(stage), `stage ${stage}`);
  }
  assert.ok(html.includes("Human-only."), "the human-only line is the spine's point");
  assert.ok(!html.includes("Gaps, in the order they bite"), "the essay stays in the file, not the panel");
});

// §6 — spaces. A second project with its own bus, registered in the hub's
// registry; the window switches to it with ?p= and its forms write THERE, not
// here.
const projA = path.join(HOME, "proj-a");
const projADir = path.join(projA, ".git", "agent-bus");
fs.mkdirSync(projADir, { recursive: true });
const projAState = path.join(projADir, "state.json");
fs.writeFileSync(
  projAState,
  JSON.stringify({
    agents: { "a-worker": { lane: "build", lastSeen: new Date().toISOString(), cwd: projA } },
    lock: null, messages: [], tasks: [], taskSeq: 0,
    board: { "proj-a-fact": { value: "only proj-a renders this", by: "a-worker", at: new Date().toISOString() } },
  })
);
fs.writeFileSync(
  path.join(stateDir, "projects.json"),
  JSON.stringify([{ name: "proj-a", root: projA }])
);

await check("a registered ?p= renders that project's bus, not the hub's", async () => {
  const res = await GET(`${base}/?p=proj-a`);
  const html = await res.text();
  assert.ok(html.includes("proj-a-fact"), "the project's board note");
  assert.ok(html.includes("a-worker"), "the project's agent");
  assert.ok(!html.includes("own-origin"), "the hub's own notes do not leak in");
  assert.ok(html.includes("Spaces:") && html.includes("/?p=proj-a"), "the switcher bar");
  assert.ok(!html.includes("Start a worker"), "workers are the hub's own — no start form here");
  assert.ok(html.includes("server.mjs work local"), "the page says how to drain this queue instead");
});

await check("an unknown ?p= falls back to the hub, with a note", async () => {
  const res = await GET(`${base}/?p=ghost-app`);
  const html = await res.text();
  assert.ok(html.includes("own-origin"), "the hub's own board");
  assert.ok(!html.includes("proj-a-fact"), "the unknown name renders nothing of proj-a");
  assert.ok(html.includes('no space named "ghost-app"'), "said out loud, not silently ignored");
});

await check("a vanished project root falls back to the hub too", async () => {
  fs.writeFileSync(
    path.join(stateDir, "projects.json"),
    JSON.stringify([{ name: "proj-a", root: projA }, { name: "gone", root: path.join(HOME, "deleted-root") }])
  );
  const res = await GET(`${base}/?p=gone`);
  const html = await res.text();
  assert.ok(html.includes("own-origin"), "fell back to the hub");
  fs.writeFileSync(path.join(stateDir, "projects.json"), JSON.stringify([{ name: "proj-a", root: projA }]));
});

await check("a form posted inside a space writes THAT space and redirects back to it", async () => {
  const res = await fetch(`${base}/?p=proj-a`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: "action=note&actor=desk&key=from-the-window&value=written+into+proj-a",
  });
  assert.equal(res.status, 303, `got ${res.status}`);
  assert.ok(res.headers.get("location").includes("p=proj-a"), `redirect kept the space: ${res.headers.get("location")}`);
  const written = JSON.parse(fs.readFileSync(projAState, "utf8"));
  assert.ok(written.board["from-the-window"], "the note landed in proj-a's bus");
  const hub = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.ok(!hub.board["from-the-window"], "and not in the hub's own bus");
});

await check("queueing work in a space gives that space its own task page", async () => {
  const q = await fetch(`${base}/?p=proj-a`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "action=task&lane=build&title=proj-a+job&prompt=" + encodeURIComponent("work for proj a only"),
  });
  assert.equal(q.status, 303, `queueing got ${q.status}`);
  const inProj = JSON.parse(fs.readFileSync(projAState, "utf8"));
  const tid = inProj.tasks.at(-1).id;
  const res = await GET(`${base}/task/${tid}?p=proj-a`);
  assert.equal(res.status, 200, `task page got ${res.status}`);
  const html = await res.text();
  assert.ok(html.includes("proj-a job"), "the task's title");
  assert.ok(html.includes("work for proj a only"), "the full prompt");
  const hubSide = await GET(`${base}/task/${tid}`);
  // Separate buses, so sequence ids can collide — the hub's own t1 is its own
  // earlier task. Isolation means the same id shows DIFFERENT work per space,
  // never one space's content under the other's.
  assert.equal(hubSide.status, 200, "the hub has its own t1");
  const hubHtml = await hubSide.text();
  assert.ok(hubHtml.includes("fix the gauge"), "the hub's t1 is the hub's task");
  assert.ok(!hubHtml.includes("work for proj a only"), "proj-a's prompt does not leak into it");
});

await check("the queue form offers the spine stages, and a stage lands on the task as data", async () => {
  const html = await (await GET(`${base}/`)).text();
  assert.ok(html.includes('<select name="stage">'), "the queue form has a stage dropdown");
  assert.ok(html.includes('value="idea"') && html.includes('value="maintain"'), "the stages come from the spine doc");
  const q = await fetch(`${base}/`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: "action=task&lane=local&title=staged+work&prompt=" + encodeURIComponent("with a stage") + "&stage=build",
  });
  assert.equal(q.status, 303);
  const st = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  // Find by title: earlier checks push tasks with hard-coded ids (t2, t3)
  // without bumping taskSeq, so a later POST can reuse an id and .at(-1) on
  // id lookup would render the WRONG task.
  const staged = st.tasks.filter((t) => t.title === "staged work").at(-1);
  assert.equal(staged.stage, "build", "the stage is data on the task");
  const page = await (await GET(`${base}/task/${staged.id}`)).text();
  assert.ok(page.includes(" · build"), "the task page shows the stage tag");
  const bad = await fetch(`${base}/`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: "action=task&lane=local&title=bad&prompt=x&stage=notastage",
  });
  const loc = new URL(bad.headers.get("location"), "http://127.0.0.1");
  assert.ok((loc.searchParams.get("flash") ?? "").includes("Unknown stage"), "a made-up stage is refused, not joined into the prompt");
  const st2 = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.ok(!st2.tasks.some((t) => t.title === "bad"), "and no task was created from it");
});

await check("the publish record renders, and a publish POST records into the space", async () => {
  const before = await (await GET(`${base}/`)).text();
  assert.ok(before.includes("Publish record"), "the panel is on the page");
  const p = await fetch(`${base}/`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: "action=publish&version=v0.1.0&what=" + encodeURIComponent("first demo ship"),
  });
  assert.equal(p.status, 303);
  const st = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(st.publishes.at(-1).version, "v0.1.0", "the record landed in state");
  const after = await (await GET(`${base}/`)).text();
  assert.ok(after.includes("v0.1.0") && after.includes("first demo ship"), "the panel renders the record");
});

await check("the health strip computes per space, from that space's own state", async () => {
  const hubHtml = await (await GET(`${base}/`)).text();
  assert.ok(hubHtml.includes("Pulse:"), "the current space's pulse is on the page");
  assert.ok(hubHtml.includes("awaiting review"), "review debt is a named number, not hidden");
  const projHtml = await (await GET(`${base}/?p=proj-a`)).text();
  assert.ok(projHtml.includes("Pulse: 1 queued"), "proj-a's strip counts ITS queued task");
});

await check("a done task carries a review form; a review lands; the self-review is refused", async () => {
  const q = await fetch(`${base}/`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: "action=task&lane=local&title=reviewable&prompt=" + encodeURIComponent("work worth reviewing"),
  });
  assert.equal(q.status, 303);
  const stPath = path.join(stateDir, "state.json");
  const st = JSON.parse(fs.readFileSync(stPath, "utf8"));
  const t = st.tasks.filter((x) => x.title === "reviewable").at(-1);
  t.status = "done";
  t.runner = "workerx";
  t.result = "the answer";
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2));
  const page0 = await (await GET(`${base}/task/${t.id}`)).text();
  assert.ok(page0.includes("Record review"), "the form is on the task page");
  assert.ok(page0.includes("Reviews (0)"), "no reviews yet, said");
  const r = await fetch(`${base}/task/${t.id}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: `action=review&task_id=${t.id}&verdict=approve&notes=looks+right&back=${encodeURIComponent(`/task/${t.id}`)}`,
  });
  assert.equal(r.status, 303, "review accepted");
  const loc = new URL(r.headers.get("location"), "http://127.0.0.1");
  assert.ok(loc.pathname === `/task/${t.id}`, "the back field returned the verdict to the task page, not the board");
  const st2 = JSON.parse(fs.readFileSync(stPath, "utf8"));
  assert.equal(st2.tasks.find((x) => x.id === t.id).reviews.length, 1, "the verdict is data on the task");
  const page1 = await (await GET(`${base}/task/${t.id}`)).text();
  assert.ok(page1.includes("Reviews (1)") && page1.includes("looks right"), "the review renders");
  const self = await fetch(`${base}/task/${t.id}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: `action=review&task_id=${t.id}&verdict=approve&notes=self&actor=workerx&back=${encodeURIComponent(`/task/${t.id}`)}`,
  });
  const selfFlash = new URL(self.headers.get("location"), "http://127.0.0.1").searchParams.get("flash") ?? "";
  assert.ok(selfFlash.includes("FAILED:") && selfFlash.includes("someone else"), "the worker cannot review its own task");
  const st3 = JSON.parse(fs.readFileSync(stPath, "utf8"));
  assert.equal(st3.tasks.find((x) => x.id === t.id).reviews.length, 1, "and nothing was recorded");
});

await check("live pages refresh themselves — the app window has no reload key", async () => {
  const st = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const task = st.tasks[0];
  const d1 = await (await GET(`${base}/`)).text();
  assert.ok(d1.includes('meta name="hub-render"'), "the board carries a render marker");
  assert.ok(d1.includes("setInterval"), "the board carries the watcher");
  // two renders of the SAME page must carry different markers, or the watcher
  // could never see a change and would never reload
  const d2 = await (await GET(`${base}/`)).text();
  const m1 = d1.match(/hub-render" content="(\d+)"/)[1];
  const m2 = d2.match(/hub-render" content="(\d+)"/)[1];
  assert.notEqual(m1, m2, "each render stamps its own marker");
  const tp = await (await GET(`${base}/task/${task.id}`)).text();
  assert.ok(tp.includes('meta name="hub-render"'), "task pages carry the marker too");
  // the saved copy stays on its blind meta refresh — the watcher would only
  // ever compare the file against itself
  const saved = fs.readFileSync(path.join(HOME, ".git", "agent-bus", "status.html"), "utf8");
  assert.ok(saved.includes('http-equiv="refresh"') && !saved.includes("setInterval"), "saved copy untouched");
});

// Kill, then give the hub a beat to release its fs.watchFile before the tree
// under it disappears — kill+rmSync in the same tick trips a libuv assertion
// on Windows (uv_handle_closing) and the process dies 127 after reporting
// all-green.
child.kill();
await new Promise((r) => setTimeout(r, 250));
fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);