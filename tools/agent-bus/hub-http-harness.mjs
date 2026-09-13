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
  {
    env: {
      ...process.env,
      AGENT_BUS_PROJECT: HOME,
      AGENT_BUS_SESSION_TTL_MS: "100", // see sessions.mjs — mid-suite transcript visibility
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
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

// ONE HUB PER PROJECT: a second launch against a port that already serves a
// hub must exit cleanly with the pointer to the running one — never a twin
// server with a second steward loop asking the model double.
const dup = spawn(
  process.execPath,
  [path.join(import.meta.dirname, "hub.mjs"), String(freePort)],
  { env: { ...process.env, AGENT_BUS_PROJECT: HOME }, stdio: ["ignore", "pipe", "pipe"] }
);
const dupOut = [];
dup.stdout.on("data", (c) => dupOut.push(String(c)));
dup.stderr.on("data", (c) => dupOut.push(String(c)));
await new Promise((r) => setTimeout(r, 3000));
await check("a SECOND hub on the same port refuses to start — one bus, one steward", async () => {
  assert.ok(dupOut.join("").includes("already running"), `no probe refusal: ${dupOut.join("").trim()}`);
  assert.ok(!dupOut.join("").includes("dashboard: http://"), "the twin started a dashboard anyway");
});

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

await check("a claimed task shows running <id>; a live process alone shows alive; a dead one is pruned", async () => {
  // The 1-hour prune and the 2-minute quiet both answer "has it called the
  // bus" — not "is it running". The pid closes that gap — but a live pid
  // proves the agent's PROCESS exists, not that it holds work (dogfood
  // report 2026-09-13: every card said "running" over a 0/0 board). So the
  // badge is three-valued: "running <task.id>" only when a claimed task
  // names this agent as its runner; "alive" for a verifiable process with
  // no claimed task; prune/quiet fallbacks unchanged. Each assertion gets
  // its own render so the cards cannot blur together.
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
  assert.ok(html.includes('<span class="mut">alive</span>'), "a live process with no claimed task shows alive");
  assert.ok(!html.includes('<span class="run">running'), "no running badge without a claimed task");
  assert.ok(!html.includes('class="card quiet"'), "a live process is not dimmed, whatever its lastSeen");

  // Now the same agent holds a claimed task: the badge names the task.
  s.tasks = (s.tasks ?? []).concat({
    id: "t-badge", lane: "build", title: "held", prompt: "", by: "test",
    status: "running", runner: "live-runner", at: stale, startedAt: stale,
  });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(s));
  html = await (await GET(base)).text();
  assert.ok(html.includes('<span class="run">running t-badge</span>'), "a claimed task earns running <id>");

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

await check("an app space shows ITS OWN token panels — its transcripts, its model work", async () => {
  // Dogfood report 2026-09-13: "no saved tokens nothing of you is showing on
  // the agent bus". The session worked in an app space; the only token panels
  // read the hub's own project, so its numbers showed nowhere.
  const dir = path.join(os.homedir(), ".claude", "projects", projA.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const line =
    '{"type":"assistant","message":{"usage":{"cache_read_input_tokens":3000,"cache_creation_input_tokens":300,"input_tokens":60,"output_tokens":7}}}';
  fs.writeFileSync(path.join(dir, "appsess1.jsonl"), line + "\n" + line + "\n");
  const st = JSON.parse(fs.readFileSync(projAState, "utf8"));
  st.taskSeq = 1;
  st.tasks = [{ id: "t1", lane: "local", title: "app model work", prompt: "x", status: "done",
    at: new Date().toISOString(), doneAt: new Date().toISOString(), usage: { prompt: 4321, output: 1000 } }];
  fs.writeFileSync(projAState, JSON.stringify(st));
  try {
    let html = "";
    for (let i = 0; i < 20; i++) {
      html = await (await GET(`${base}/?p=proj-a`)).text();
      if (html.includes("6,734")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const saved = (html.split("<h2>Tokens saved")[1] ?? "").split("<h2")[0];
    const work = (html.split("<h2>Work your model ran")[1] ?? "").split("<h2")[0];
    assert.ok(html.includes("<h2>The context budget</h2>"), "the context budget renders in the app space");
    assert.ok(saved.includes("appsess1") && saved.includes("6,734"), "the app's session is listed with its exact burn (2 x 3,367)");
    assert.ok(work.includes("5,321"), "the app's local-model work is counted on the app's page");
    assert.ok(!html.includes("<h2>This machine</h2>"), "the hardware panel stays on the hub's own page");
    const hub = await (await GET(`${base}/`)).text();
    assert.ok(!hub.includes("appsess1"), "the app's session does not leak onto the hub's own panels");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    const back = JSON.parse(fs.readFileSync(projAState, "utf8"));
    back.tasks = [];
    back.taskSeq = 0;
    fs.writeFileSync(projAState, JSON.stringify(back));
  }
});

await check("a session on an OLD copy of the bus is named on its card, and the hub's own page shows every space's agents", async () => {
  // Dogfood report 2026-09-13 ("i dont see you"): the session was on the
  // space's board all along, through a vendored server.mjs that records no
  // pid/host — so its card could never say alive, and the hub's own page said
  // "Nobody on the bus yet". a-worker above is exactly that record shape.
  const own = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  own.agents = {};
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(own));

  let html = await (await GET(`${base}/?p=proj-a`)).text();
  assert.ok(html.includes("older bus server"), "the card says which server wrote it");
  assert.ok(html.includes(`AGENT_BUS_PROJECT=${projA}`), "and names the project root to point it at");
  assert.ok(html.includes(path.join(import.meta.dirname, "server.mjs")), "and THIS hub's server.mjs");
  assert.ok(html.includes("(1 agent · "), "the Spaces bar counts the space's agents");

  // Dogfood report 2026-09-13 ("i see local ai on the bus but i dont see
  // you"): a pointer to the space was not enough — the hub's own page is the
  // one left open, so it lists every space's agents, each naming its space.
  const connectedOf = (h) => (h.split("<h2>Connected")[1] ?? "").split("<h2")[0];
  html = await (await GET(`${base}/`)).text();
  let connected = connectedOf(html);
  assert.ok(connected.startsWith(" (1)"), `the hub counts agents in every space: ${connected.slice(0, 20)}`);
  assert.ok(connected.includes("<b>a-worker</b>"), "the space's agent has a card on the hub's own page");
  assert.ok(connected.includes('in <a href="/?p=proj-a">proj-a</a>'), "and the card names the space it is in");

  // A stale entry on the hub's own board must not hide the spaces' agents.
  own.agents = { "old-cli": { lane: "cli", lastSeen: new Date(Date.now() - 10 * 60_000).toISOString() } }; // quiet, not yet pruned
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(own));
  connected = connectedOf(await (await GET(`${base}/`)).text());
  assert.ok(connected.startsWith(" (2)") && connected.includes("<b>a-worker</b>") && connected.includes("<b>old-cli</b>"),
    "a stale own-board entry and the space's agent both show");
  assert.ok(connected.indexOf("<b>a-worker</b>") < connected.indexOf("<b>old-cli</b>"), "most recently seen first");
  const oldCard = connected.slice(connected.indexOf("<b>old-cli</b>")).split('<div class="card')[0];
  assert.ok(!oldCard.includes("in <a href="), "the hub's own agent carries no space label");
  own.agents = {};
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(own));

  // A registration from THIS server (pid + host) never carries the warning.
  const a = JSON.parse(fs.readFileSync(projAState, "utf8"));
  const saved = a.agents["a-worker"];
  a.agents["a-worker"] = { ...saved, pid: child.pid, host: os.hostname() };
  fs.writeFileSync(projAState, JSON.stringify(a));
  html = await (await GET(`${base}/?p=proj-a`)).text();
  assert.ok(!html.includes("older bus server"), "a current registration is not flagged");
  assert.ok(html.includes('<span class="mut">alive</span>'), "and shows alive");
  connected = connectedOf(await (await GET(`${base}/`)).text());
  assert.ok(/<b>a-worker<\/b>\s*<span class="mut">alive<\/span>/.test(connected), "alive on the hub's own page too");
  a.agents["a-worker"] = saved;
  fs.writeFileSync(projAState, JSON.stringify(a));
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

await check("the savings headline is COMPACTION — local model work is a separate plain fact", async () => {
  const stPath = path.join(stateDir, "state.json");
  const seed = JSON.parse(fs.readFileSync(stPath, "utf8"));
  seed.taskSeq = (seed.taskSeq ?? 0) + 1;
  seed.tasks.push({
    id: `t${seed.taskSeq}`, lane: "local", title: "model-work proof",
    prompt: "x", status: "done", at: new Date().toISOString(), doneAt: new Date().toISOString(),
    usage: { prompt: 1200, output: 800 },
  });
  fs.writeFileSync(stPath, JSON.stringify(seed, null, 2));
  const expected = seed.tasks.reduce(
    (a, t) => a + (t.usage ? (t.usage.prompt || 0) + (t.usage.output || 0) : 0), 0);
  const html = await (await GET(`${base}/`)).text();
  const savedPanel = (html.split("<h2>Tokens saved")[1] ?? "").split("<h2")[0];
  const workPanel = (html.split("<h2>Work your model ran")[1] ?? "").split("<h2")[0];
  assert.ok(savedPanel.length > 0 && workPanel.length > 0, "both panels render");
  assert.ok(savedPanel.includes("saved by compacting:"), "the savings headline is compaction, not local work");
  assert.ok(
    !savedPanel.includes(expected.toLocaleString()),
    `the local task usage (${expected}) is NOT counted as savings`
  );
  assert.ok(
    workPanel.includes(expected.toLocaleString()) && workPanel.includes("since the hub started:"),
    "the model-work panel carries it as a plain fact"
  );
  assert.ok(
    !/\bsaved\b/.test(workPanel),
    "and it never calls itself savings"
  );
  assert.ok(!savedPanel.includes("$"), "NO dollar signs — tokens are the exact unit");
});

await check("a fresh install with no records shows honest empty states — nothing estimated to fill the blank", async () => {
  const html = await (await GET(`${base}/`)).text();
  const panel = (html.split("<h2>Tokens saved")[1] ?? "").split("<h2")[0];
  assert.ok(panel.includes("Sessions"), "the sessions section renders");
  assert.ok(
    panel.includes("No Claude Code sessions measured for this project yet"),
    "no transcripts -> the fill-in note, not fabricated rows"
  );
  assert.ok(
    panel.includes("No Claude Code transcripts for this project yet"),
    "the compaction counter says the same, honestly"
  );
  assert.ok(panel.includes("nothing is estimated to fill the blank"), "and the blank is named honestly");
});

await check("the sessions list shows every Claude session with what it burned — read locally, never summed into saved", async () => {
  // Claude Code stores transcripts under the REAL home, in a directory named
  // after the project root with every non-alphanumeric character dashed —
  // exactly what sessions.mjs derives from PROJECT_ROOT. Write one there so
  // the hub finds it on its next render.
  const dir = path.join(
    os.homedir(),
    ".claude",
    "projects",
    HOME.replace(/[^a-zA-Z0-9]/g, "-")
  );
  fs.mkdirSync(dir, { recursive: true });
  const line =
    '{"type":"assistant","message":{"usage":{"cache_read_input_tokens":1000,"cache_creation_input_tokens":100,"input_tokens":50,"output_tokens":25}}}';
  fs.writeFileSync(path.join(dir, "sessburn.jsonl"), line + "\n" + line + "\n");
  try {
    // Two turns x 1,175 = 2,350 burned. Poll: the render cache is 100 ms
    // (AGENT_BUS_SESSION_TTL_MS), so the row appears within a tick or two.
    let html = "";
    for (let i = 0; i < 20; i++) {
      html = await (await GET(`${base}/`)).text();
      if (html.includes("2,350")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const panel = (html.split("<h2>Tokens saved")[1] ?? "").split("<h2")[0];
    assert.ok(panel.includes("sessburn"), "the session id is listed");
    assert.ok(panel.includes("2,350"), "its burned total is the exact read+write+input+output sum");
    assert.ok(panel.includes("burned (billed to you)"), "the column names burned for what it is");
    const savedLine = panel.split("saved by compacting:")[1].split("tokens")[0];
    assert.ok(
      !savedLine.includes("2,350"),
      "burned is NEVER summed into saved — a session with no compaction adds nothing"
    );
    // The chars-÷-4 attribution panels must say so out loud (user request
    // request/label-approx-panels): approximate is labelled, exact stays exact.
    assert.ok(
      html.includes("Read into context — approximate"),
      "the chars-div-4 panels are labelled approximate"
    );
    assert.ok(
      html.includes("never summed into the exact"),
      "and the note names what stays exact"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); // nothing of ours left behind
  }
});

await check("the savings counter measures a REAL compaction — drop times every remaining turn, exactly", async () => {
  // A transcript with one labelled compaction: two fat turns, the marker, two
  // slim turns after. curve = read+write+input per turn, so
  //   curve = [100500, 106200, 8100, 8350], compactions = [2]
  //   drop = 106200 - 8100 = 98100, remaining turns after it = 2
  //   saved = 98100 x 2 = 196200
  const dir = path.join(
    os.homedir(),
    ".claude",
    "projects",
    HOME.replace(/[^a-zA-Z0-9]/g, "-")
  );
  fs.mkdirSync(dir, { recursive: true });
  const turn = (r, w, i) =>
    `{"type":"assistant","message":{"usage":{"cache_read_input_tokens":${r},"cache_creation_input_tokens":${w},"input_tokens":${i},"output_tokens":10}}}`;
  const lines = [
    turn(90000, 10000, 500),
    turn(105000, 1000, 200),
    '{"type":"system","compactMetadata":{}}',
    turn(5000, 3000, 100),
    turn(8200, 100, 50),
  ].join("\n");
  fs.writeFileSync(path.join(dir, "compburn.jsonl"), lines + "\n");
  try {
    let html = "";
    for (let i = 0; i < 20; i++) {
      html = await (await GET(`${base}/`)).text();
      if (html.includes("196,200")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const panel = (html.split("<h2>Tokens saved")[1] ?? "").split("<h2")[0];
    assert.ok(
      panel.includes("196,200"),
      "the exact drop x remaining turns is the headline number"
    );
    assert.ok(panel.includes("compburn"), "the session is named in the per-session table");
    assert.ok(
      !panel.includes("$"),
      "still no dollar figures — the exact unit is the only unit"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("the hub's own page totals tokens saved across EVERY space, one row per space", async () => {
  // Dogfood report 2026-09-13: "on the this hub page i dont see the tokens
  // saved". Sessions open in an app's folder, so the hub's own project alone
  // reads 0. The same compaction as above (196,200), but in proj-a.
  const dir = path.join(os.homedir(), ".claude", "projects", projA.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const turn = (r, w, i) =>
    `{"type":"assistant","message":{"usage":{"cache_read_input_tokens":${r},"cache_creation_input_tokens":${w},"input_tokens":${i},"output_tokens":10}}}`;
  fs.writeFileSync(path.join(dir, "spacecomp.jsonl"), [
    turn(90000, 10000, 500), turn(105000, 1000, 200),
    '{"type":"system","compactMetadata":{}}',
    turn(5000, 3000, 100), turn(8200, 100, 50),
  ].join("\n") + "\n");
  try {
    let html = "";
    for (let i = 0; i < 20; i++) {
      html = await (await GET(`${base}/`)).text();
      if (html.includes("<td>proj-a</td><td class=\"num\">1</td>")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const panel = (html.split("<h2>Tokens saved")[1] ?? "").split("<h2")[0];
    const headline = panel.split("saved by compacting:")[1]?.split("</div>")[0] ?? "";
    assert.ok(headline.includes("196,200"), `the hub headline counts the app space's compaction: ${headline}`);
    assert.ok(/<td>proj-a<\/td>\s*<td class="num">1<\/td>\s*<td class="num">196,200<\/td>/.test(panel),
      "a by-space row names proj-a with its compactions and its exact saving");
    assert.ok(/<td>this hub<\/td>\s*<td class="num">0<\/td>\s*<td class="num">0<\/td>/.test(panel),
      "the hub's own project is its own row, honestly zero");
    assert.ok(!panel.includes("spacecom"), "per-session rows stay on the space's own page");
    const app = await (await GET(`${base}/?p=proj-a`)).text();
    const appPanel = (app.split("<h2>Tokens saved")[1] ?? "").split("<h2")[0];
    assert.ok(appPanel.includes("196,200") && appPanel.includes("spacecom"), "the space's own page has the session");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check("a RUNNING task shows beside the tree lock even when the tree is free", async () => {
  const stPath = path.join(stateDir, "state.json");
  const seed = JSON.parse(fs.readFileSync(stPath, "utf8"));
  seed.taskSeq = (seed.taskSeq ?? 0) + 1;
  seed.tasks.push({
    id: `t${seed.taskSeq}`, lane: "test", title: "tree context",
    prompt: "x", status: "running", at: new Date().toISOString(),
  });
  fs.writeFileSync(stPath, JSON.stringify(seed, null, 2));
  const html = await (await GET(`${base}/`)).text();
  assert.ok(
    html.includes("task is running right now") || html.includes("tasks are running right now"),
    "the running-task context line renders beside a free lock"
  );
});

await check("the board has AREAS by job type and folds its history — recent head, older folded, nothing deleted", async () => {
  const stPath = path.join(stateDir, "state.json");
  const seed = JSON.parse(fs.readFileSync(stPath, "utf8"));
  const now = new Date().toISOString();
  for (let i = 0; i < 15; i++)
    seed.board[`problem/board-area-${String(i).padStart(2, "0")}`] = { value: "x", by: "t", at: now };
  for (let i = 0; i < 3; i++) seed.board[`request/board-area-${i}`] = { value: "x", by: "t", at: now };
  seed.board["status/board-area"] = { value: "x", by: "t", at: now };
  seed.board["general-note"] = { value: "x", by: "t", at: now };
  fs.writeFileSync(stPath, JSON.stringify(seed, null, 2));
  const html = await (await GET(`${base}/`)).text();
  assert.ok(html.includes("Problems (15)"), "each job type gets its own labelled area with a count");
  assert.ok(html.includes("Requests (3)"), "requests get their own area");
  assert.ok(
    html.includes("Status (") && html.includes("status/board-area"),
    "status keys get their own area"
  );
  assert.ok(
    html.includes("General (") && html.includes("general-note"),
    "and the unmatched keys get their own area"
  );
  assert.ok(html.includes("3 older in Problems"), "older notes fold behind one summary instead of growing the page");
  assert.ok(html.includes("problem/board-area-14"), "the newest problem is in the head");
  assert.ok(html.includes("problem/board-area-00"), "the oldest is still on the page — folded, not deleted");
});

await check("a DRAFT brief is dispatch-gated: approve queues it, changes leaves it unclaimed", async () => {
  const stPath = path.join(stateDir, "state.json");
  const seed = JSON.parse(fs.readFileSync(stPath, "utf8"));
  seed.taskSeq = (seed.taskSeq ?? 0) + 1;
  seed.tasks.push({
    id: `t${seed.taskSeq}`,
    lane: "fixes",
    title: "Brief draft: export 404",
    prompt: "PROBLEM: the export 404s. MUST PRODUCE: a route that works. DO NOT: touch auth. CONTEXT: none named.",
    status: "draft",
    briefDraftFor: "note:defect/export-404",
    by: "steward",
    at: new Date().toISOString(),
  });
  fs.writeFileSync(stPath, JSON.stringify(seed, null, 2));
  const draft = `t${seed.taskSeq}`;
  const page = await (await GET(`${base}/task/${draft}`)).text();
  assert.ok(page.includes("DRAFT brief"), "the draft says what it is");
  assert.ok(page.includes("Approve &amp; dispatch") || page.includes("Approve & dispatch"), "the form says what approval does");
  const ch = await fetch(`${base}/task/${draft}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: `action=review&task_id=${draft}&verdict=changes&notes=tighten+the+acceptance&back=${encodeURIComponent(`/task/${draft}`)}`,
  });
  assert.equal(ch.status, 303);
  const st1 = JSON.parse(fs.readFileSync(stPath, "utf8"));
  assert.equal(st1.tasks.find((x) => x.id === draft).status, "draft",
    "changes leaves the draft a draft — a worker still cannot claim it");
  const ap = await fetch(`${base}/task/${draft}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: `action=review&task_id=${draft}&verdict=approve&back=${encodeURIComponent(`/task/${draft}`)}`,
  });
  assert.equal(ap.status, 303);
  const st2 = JSON.parse(fs.readFileSync(stPath, "utf8"));
  const dispatched = st2.tasks.find((x) => x.id === draft);
  assert.equal(dispatched.status, "queued", "approve on a draft DISPATCHES it");
  assert.equal(dispatched.briefDraftFor, "note:defect/export-404", "the lineage stays on the task");
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