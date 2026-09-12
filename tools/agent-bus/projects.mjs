/**
 * §6 — each app build lives in its own place.
 *
 * One board for everything was a transition shape. The seams already existed:
 * AGENT_BUS_PROJECT points a bus at a project root and its state lands in that
 * root's .git. What was missing was the layer above — a registry of the apps
 * this bus serves, so the hub can offer each one as its own space and route
 * what the desk writes into the right one.
 *
 * The registry lives in the bus's own state dir (the .git the state file lives
 * in), not in the repo tree and not in any app's tree. That placement is a
 * privacy decision, not a convenience: it holds real paths from this machine,
 * so it must never be committed — inside .git it cannot be.
 *
 * What the registry is NOT: a shared-facts layer. The rulebook, the runner
 * record and the token lessons are the hub's own learning and stay on the
 * hub's own bus; a project space carries only that project's board, lock,
 * agents, messages, blockers and queue.
 *
 * Pure where it can be (names, lists, resolution), fs-touching only where it
 * must be (the root has to exist on disk; the registry is a file). Every
 * function takes the registry dir explicitly, so server.mjs and hub.mjs each
 * anchor it to their own DIR and a test can point it anywhere.
 */

import fs from "node:fs";
import path from "node:path";

export const REGISTRY_FILE = "projects.json";
export const MAX_PROJECTS = 20;

/**
 * A name is a URL-safe slug: it appears in ?p= links on the hub, so anything
 * a URL could not carry unescaped is refused here rather than mangled there.
 * Lowercased, trimmed, 1-40 chars of [a-z0-9.-], and it must not start with
 * a dot — "..", "." and friends are path shapes, not names.
 */
export function cleanName(wanted) {
  const name = String(wanted ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,39}$/.test(name)) {
    throw new Error(
      `Project name "${String(wanted ?? "")}" is not a usable slug — ` +
        `use 1-40 chars: letters, digits, dots or dashes, starting with a letter or digit.`
    );
  }
  return name;
}

/**
 * A root must exist on disk at registration time. A typo registered as a path
 * would sit in the switcher looking exactly like the real app and silently
 * render an empty bus — an error that names the path is cheaper than that.
 */
export function cleanRoot(wanted) {
  const root = path.resolve(String(wanted ?? "").trim());
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    throw new Error(`No directory at "${root}" — check the path.`);
  }
  if (!st.isDirectory()) throw new Error(`"${root}" is a file, not a project root.`);
  return root;
}

/** Add or update one entry. Same name → new root (an app that moved checkouts). */
export function addProject(entries, name, root) {
  const nameL = cleanName(name);
  const rest = entries.filter((e) => e.name !== nameL);
  return [...rest, { name: nameL, root }].sort((a, b) => a.name.localeCompare(b.name));
}

export function removeProject(entries, name) {
  const nameL = cleanName(name);
  return entries.filter((e) => e.name !== nameL);
}

/**
 * The registry, bounded and ordered. Invalid shapes are dropped, not fatal:
 * a hand-edited registry with one bad line must not take the switcher down.
 */
export function registryList(entries, max = MAX_PROJECTS) {
  const good = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.name === "string" && typeof e.root === "string" && e.name)
    .slice(0, max);
  return good.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which space a ?p= selection means.
 *
 *   - nothing selected, or the selection IS this bus → { own: true }
 *   - a registered name whose root still exists → that space
 *   - a registered name whose root vanished, or an unknown name → null.
 *
 * The caller decides what null means; the hub falls back to its own space
 * rather than rendering an error page, because a stale registry entry is a
 * cosmetic problem and "show the hub" is the answer a person would pick.
 */
export function resolveProject(entries, wanted, ownRoot) {
  if (wanted == null || String(wanted).trim() === "") {
    return { name: null, root: ownRoot, own: true };
  }
  const name = String(wanted).trim().toLowerCase();
  const hit = entries.find((e) => e.name === name);
  if (!hit) return null;
  if (!fs.existsSync(hit.root)) return null;
  return { name: hit.name, root: path.resolve(hit.root), own: false };
}

/**
 * Where a project's bus state lives — the same shape stateDir() derives,
 * minus the mkdir: this is read-side only, and a root that has no bus yet
 * simply reads as an empty one.
 */
export function statePathForRoot(root) {
  return fs.existsSync(path.join(root, ".git"))
    ? path.join(root, ".git", "agent-bus", "state.json")
    : path.join(root, ".agent-bus", "state.json");
}

/**
 * Read the registry file. Missing, corrupt or wrong-shaped all read as an
 * empty registry — the switcher disappears rather than the hub breaking.
 */
export function readRegistry(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, REGISTRY_FILE), "utf8"));
    return registryList(Array.isArray(raw) ? raw : raw?.apps);
  } catch {
    return [];
  }
}

/** Write the registry atomically (tmp + rename, the same dance as the state file). */
export function writeRegistry(dir, entries) {
  const list = registryList(entries);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${REGISTRY_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  fs.renameSync(tmp, path.join(dir, REGISTRY_FILE));
  return list;
}