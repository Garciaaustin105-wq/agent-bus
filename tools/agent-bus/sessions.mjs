/**
 * The transcripts on this machine, read and cached.
 *
 * The I/O half of the token watch (A2). token-watch.mjs does the arithmetic and
 * touches no disk; this file touches disk and does no arithmetic. Both the hub
 * window (lane 2, render it continuously) and the hub agent (lane 2a, nudge
 * before the expensive turns) read through here, so there is one cache, one
 * liveness rule and one definition of where transcripts live.
 *
 * WHY THE CACHE IS NOT OPTIONAL. A full scan on this machine is 110 MB and
 * about 400 ms. The window re-renders whenever anything on the bus moves and
 * the agent polls every five seconds; either one doing that scan unthrottled
 * would make the hub the most expensive thing in the room, which would be a
 * poor advertisement for a token watch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROJECT_ROOT } from "./server.mjs";
import { scanTranscript, watch } from "./token-watch.mjs";

/**
 * Claude Code stores transcripts in a directory named after the project root,
 * with every non-alphanumeric character replaced by a dash. PROJECT_ROOT is the
 * repo this bus serves, so pointing the bus at another project points the watch
 * at that project too — one setting, not two that can disagree.
 */
export function sessionDirFor(root) {
  return path.join(os.homedir(), ".claude", "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
}
export const SESSION_DIR = sessionDirFor(PROJECT_ROOT);

/**
 * Ninety minutes with no new turn and the session is over.
 *
 * Advice to compact a conversation nobody is in is noise, and noise is how a
 * wall display stops being read. mtime is the signal that exists: the bus knows
 * which AGENTS are registered but not which transcript belongs to which one, so
 * it cannot do better than this yet.
 */
export const LIVE_MS = 90 * 60 * 1000;

// The harness sets this small so a transcript written mid-suite is visible to
// the next render without waiting out a 30 s cache.
const TTL_MS = Number(process.env.AGENT_BUS_SESSION_TTL_MS) || 30_000;
const scanCache = new Map(); // file -> { key, scan }
// Per session directory. A hub page for another registered space reads THAT
// project's transcripts (dogfood report 2026-09-13: "no saved tokens nothing
// of you is showing" — the session worked in an app space, and the only
// token panels on the hub read the hub's own project).
const cachedByDir = new Map(); // dir -> { at, value }

/**
 * Every session for this project, worst first, each with its assessment.
 *
 * Returns the shape token-watch.mjs::watch returns, plus `missing` for a
 * project nobody has opened in Claude Code yet — which is a fact about the
 * machine, not an error, and the callers say so rather than showing zeros.
 */
export function readSessions({ force = false, ttlMs = TTL_MS, root = PROJECT_ROOT } = {}) {
  const now = Date.now();
  const dir = sessionDirFor(root);
  const cached = cachedByDir.get(dir);
  if (!force && cached && now - cached.at < ttlMs) return cached.value;

  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => path.join(dir, n));
  } catch {
    const empty = { rows: [], baseline: null, totals: null, missing: true, dir };
    cachedByDir.set(dir, { at: now, value: empty });
    return empty;
  }

  const sessions = [];
  const seen = new Set();
  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue; // vanished between the listing and the stat
    }
    // Size as well as mtime: a transcript appended to within the same
    // millisecond as the last scan would otherwise read as unchanged.
    const key = st.mtimeMs + ":" + st.size;
    seen.add(file);
    let hit = scanCache.get(file);
    if (!hit || hit.key !== key) {
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      hit = { key, scan: scanTranscript(text) };
      scanCache.set(file, hit);
    }
    if (hit.scan.turns) {
      sessions.push({ id: path.basename(file).slice(0, 8), idle: now - st.mtimeMs, scan: hit.scan });
    }
  }
  // Forget only this directory's vanished files; other spaces keep their scans.
  for (const file of scanCache.keys()) {
    if (path.dirname(file) === dir && !seen.has(file)) scanCache.delete(file);
  }

  const value = { ...watch(sessions), missing: false, dir };
  cachedByDir.set(dir, { at: now, value });
  return value;
}

/** The live sessions only — the ones that can still act on what they are told. */
export function liveSessions(opts) {
  return readSessions(opts).rows.filter((r) => r.idle < LIVE_MS);
}
