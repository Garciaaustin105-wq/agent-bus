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
export const SESSION_DIR = path.join(
  os.homedir(),
  ".claude",
  "projects",
  PROJECT_ROOT.replace(/[^a-zA-Z0-9]/g, "-")
);

/**
 * Ninety minutes with no new turn and the session is over.
 *
 * Advice to compact a conversation nobody is in is noise, and noise is how a
 * wall display stops being read. mtime is the signal that exists: the bus knows
 * which AGENTS are registered but not which transcript belongs to which one, so
 * it cannot do better than this yet.
 */
export const LIVE_MS = 90 * 60 * 1000;

const TTL_MS = 30_000;
const scanCache = new Map(); // file -> { key, scan }
let cached = { at: 0, value: null };

/**
 * Every session for this project, worst first, each with its assessment.
 *
 * Returns the shape token-watch.mjs::watch returns, plus `missing` for a
 * project nobody has opened in Claude Code yet — which is a fact about the
 * machine, not an error, and the callers say so rather than showing zeros.
 */
export function readSessions({ force = false, ttlMs = TTL_MS } = {}) {
  const now = Date.now();
  if (!force && cached.value && now - cached.at < ttlMs) return cached.value;

  let files;
  try {
    files = fs
      .readdirSync(SESSION_DIR)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => path.join(SESSION_DIR, n));
  } catch {
    const empty = { rows: [], baseline: null, totals: null, missing: true, dir: SESSION_DIR };
    cached = { at: now, value: empty };
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
  for (const file of scanCache.keys()) if (!seen.has(file)) scanCache.delete(file);

  const value = { ...watch(sessions), missing: false, dir: SESSION_DIR };
  cached = { at: now, value };
  return value;
}

/** The live sessions only — the ones that can still act on what they are told. */
export function liveSessions(opts) {
  return readSessions(opts).rows.filter((r) => r.idle < LIVE_MS);
}
