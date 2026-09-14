/**
 * Token watch — the contract behind lane 2 of the hub roadmap.
 *
 * ONE FACT SHAPES ALL OF THIS (H1). A cache read is the model re-reading the
 * conversation before it answers, and it happens on every turn. So a session's
 * marginal price per turn IS its current context size. That turns the
 * compaction question from taste into arithmetic:
 *
 *   Compacting costs about one turn at the current size — something has to read
 *   the conversation in order to summarise it. It buys back (current - baseline)
 *   tokens on every turn after that. So:
 *
 *       break-even turns = current / (current - baseline)
 *
 *   At 539k against a 57k baseline — the H5 incident, measured, not imagined —
 *   that is 1.1 turns. The session pays for the compaction it did not do before
 *   it finishes answering. At 70k it is 5.4 turns. At 60k it is 20. Nobody
 *   picked those numbers; they fall out of H1.
 *
 * WHY A CONTRACT AND NOT JUST THE REPORT. context-cost.cjs already computes
 * most of this, but it computes it on the way to a console.log — the numbers
 * exist for the length of one print. The hub has to render them continuously
 * and act on them (lane 2, lane 2a), which needs the numbers as values.
 *
 * PURE ON PURPOSE (A2). Everything here takes text or numbers and returns
 * numbers. No fs, no os, no homedir, no transcript paths. Reading the disk is
 * the caller's job, so the harness runs on string literals with no Claude
 * install and no sessions on the machine.
 *
 * ALL TOKEN COUNTS TAKEN FROM `usage` ARE EXACT — they are what the API
 * billed. Everything derived from text length is an APPROXIMATION at four
 * characters to the token: good enough to rank offenders, not good enough to
 * bill against. D4 — the two are never added together here.
 */

/**
 * A fresh session's context, in tokens, for when the machine has too few
 * sessions to measure its own baseline. Provenance: the H5 incident — a fresh
 * session on this project ran at about 57k a turn while the long one ran at
 * 539k. It is an ASSUMPTION, and it is labelled as one everywhere it is used.
 */
export const FRESH_FALLBACK_TOKENS = 57_000;

/** Approximate tokens from characters. Ranking only — see the header. */
export const approxTok = (chars) => Math.round(chars / 4);

const IMAGE = /\.(png|jpe?g|gif|webp|svg|pdf|bmp|tiff?)$/i;

/** Median, not mean (D1). One 9,720-turn session drags any mean it touches. */
export function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * One pass over one transcript's text. Everything the watch reports comes from
 * here, so this is the only function that knows a transcript's shape.
 *
 * Takes the file's CONTENTS, never its path (A2).
 */
export function scanTranscript(text) {
  const s = {
    turns: 0,
    read: 0, // cache_read_input_tokens — re-reading the conversation
    write: 0, // cache_creation_input_tokens — new context added
    input: 0, // uncached input
    output: 0, // what was actually written
    byTool: {}, // tool name -> approx tokens of the RESULT it produced
    images: { tok: 0, n: 0 }, // approx
    texts: { tok: 0, n: 0 }, // approx
    files: {}, // basename -> approx tokens, for the offenders list
    curve: [], // context size, in exact tokens, at each assistant turn
    compactions: [], // curve INDEX of the turn after each compaction
  };
  const nameOf = {}; // tool_use_id -> tool name
  const pathOf = {}; // tool_use_id -> file path, Read only

  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      // A half-written line at the tail is normal — the session is still being
      // appended to while we read it. Not an error, and not a reason to lose
      // the 9,719 turns above it.
      continue;
    }

    const usage = x?.message?.usage;
    if (x?.type === "assistant" && usage) {
      const read = usage.cache_read_input_tokens || 0;
      const write = usage.cache_creation_input_tokens || 0;
      const input = usage.input_tokens || 0;
      s.turns++;
      s.read += read;
      s.write += write;
      s.input += input;
      s.output += usage.output_tokens || 0;
      // The context the model actually held for this turn. Cache reads alone
      // under-report it by exactly the part that was not cached yet.
      s.curve.push(read + write + input);
    }

    // A compaction writes a system line then a user line, both before the next
    // assistant turn, so both see the same s.curve.length — the index that turn
    // will occupy. This sits above the content guard because the marker line
    // has no message.content; the last-index check is the dedupe.
    const isMarker =
      (x?.type === "system" && x?.compactMetadata != null) ||
      x?.isCompactSummary === true;
    if (isMarker && s.compactions[s.compactions.length - 1] !== s.curve.length) {
      s.compactions.push(s.curve.length);
    }

    const content = x?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const b of content) {
      if (b?.type === "tool_use") {
        nameOf[b.id] = b.name;
        if (b.name === "Read") pathOf[b.id] = b.input?.file_path || "";
      } else if (b?.type === "tool_result") {
        const body =
          typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        const tok = approxTok(body.length);
        // A result whose tool_use sat in a line we could not parse still cost
        // tokens. Count it, name it honestly, do not drop it (D3).
        const name = nameOf[b.tool_use_id] || "(unknown)";
        s.byTool[name] = (s.byTool[name] || 0) + tok;

        const p = pathOf[b.tool_use_id];
        if (p !== undefined) {
          const bucket = IMAGE.test(p) ? s.images : s.texts;
          bucket.tok += tok;
          bucket.n++;
          const base = p.split(/[\\/]/).pop() || "?";
          s.files[base] = (s.files[base] || 0) + tok;
        }
      }
    }
  }
  return s;
}

/** The context this session is paying for right now, in exact tokens. */
export const contextTokens = (scan) =>
  scan?.curve?.length ? scan.curve[scan.curve.length - 1] : 0;

/** What this session cost on its FIRST turn — the floor it started from. */
export const firstTurnTokens = (scan) => (scan?.curve?.length ? scan.curve[0] : 0);

/** Add up many scans. Totals only; per-session detail stays on the scans. */
export function mergeScans(scans) {
  const T = {
    sessions: 0,
    turns: 0,
    read: 0,
    write: 0,
    input: 0,
    output: 0,
    byTool: {},
    files: {},
    images: { tok: 0, n: 0 },
    texts: { tok: 0, n: 0 },
  };
  for (const s of scans || []) {
    if (!s) continue;
    T.sessions++;
    for (const k of ["turns", "read", "write", "input", "output"]) T[k] += s[k] || 0;
    for (const [k, v] of Object.entries(s.byTool || {})) T.byTool[k] = (T.byTool[k] || 0) + v;
    for (const [k, v] of Object.entries(s.files || {})) T.files[k] = (T.files[k] || 0) + v;
    for (const b of ["images", "texts"]) {
      T[b].tok += s[b]?.tok || 0;
      T[b].n += s[b]?.n || 0;
    }
  }
  return T;
}

/**
 * What a session costs per turn right AFTER a compaction, measured from the
 * sessions on it.
 *
 * Claude transcripts LABEL their compactions (a system compactMetadata line
 * beside a user isCompactSummary line), so the baseline is the curve point on
 * the turn each compaction resumed at — not the first turn of a session, and
 * not postTokens, which is the summary's size alone: the system prompt, tool
 * definitions and CLAUDE.md all come back on top of it. Transcripts that do
 * not label them (Codex, Cline) get a curve-drop inference, gated on BOTH a
 * ratio and an absolute floor — see measuredBaseline.
 *
 * Measured beats assumed (H6). Gated on sample size AND on spread (D2), and it
 * says what it could not use (D3) rather than quietly folding a bad sample
 * into the answer.
 */
export function measuredBaseline(scans, opts = {}) {
  const { minSessions = 3, maxSpread = 3 } = opts;
  const events = [];
  let inferred = 0;

  for (const scan of scans || []) {
    const curve = scan?.curve || [];
    const marks = Array.isArray(scan?.compactions) ? scan.compactions : [];

    if (marks.length) {
      for (const at of marks) {
        // Past the end: a compaction at the tail of a live session that has
        // not taken its next turn yet — no baseline to read. <= 1000: one
        // manual compaction here resumed with no cache read at all; a
        // different event, and a zero baseline would send every break-even
        // number downstream to infinity.
        if (at < curve.length && curve[at] > 1000) events.push(curve[at]);
      }
      // Markers and inference must never both fire on one transcript, or a
      // marked compaction gets counted twice.
      continue;
    }

    // No labels — Codex, Cline, anything that does not write them down. Both
    // tests, because either alone fails: a ratio test at 0.5 silently misses
    // real compactions (0.504 and 0.513 here), and one at 0.75 starts catching
    // ordinary turns where a big tool result aged out of the window.
    for (let i = 1; i < curve.length; i++) {
      if (
        curve[i] > 1000 &&
        curve[i] < curve[i - 1] * 0.75 &&
        curve[i - 1] - curve[i] > 30000
      ) {
        events.push(curve[i]);
        inferred++;
      }
    }
  }

  if (events.length < minSessions) return null;
  const lo = Math.min(...events);
  const hi = Math.max(...events);
  const spread = hi / lo;
  if (spread >= maxSpread) return null;
  // No outlier filtering: one event here resumed at 161,263 against a median
  // of 84,032 and it is real data. The median is what keeps one point from
  // moving the answer; the spread gate is what decides whether the population
  // is usable at all.
  return { baseline: Math.round(median(events)), n: events.length, spread, inferred };
}

export function baselineFrom(scans, opts = {}) {
  const measured = measuredBaseline(scans, opts);
  if (measured) {
    const source = measured.inferred
      ? `${measured.inferred} inferred from curve drops (transcript does not label them)`
      : "all labelled by the transcript";
    return {
      tokens: measured.baseline,
      n: measured.n,
      measured: true,
      spread: measured.spread,
      why: `resumed context on the turn after ${measured.n} compaction${measured.n === 1 ? "" : "s"}, ${source}`,
    };
  }
  // Nothing measurable from the compaction markers — fall through to the
  // first-turn logic below, unchanged.
  const { minSessions = 3, maxSpread = 3, fallback = FRESH_FALLBACK_TOKENS } = opts;
  const firsts = (scans || []).map(firstTurnTokens).filter((n) => n > 0);

  if (firsts.length < minSessions) {
    return {
      tokens: fallback,
      n: firsts.length,
      measured: false,
      why: `only ${firsts.length} session${firsts.length === 1 ? "" : "s"} to measure from, need ${minSessions}`,
    };
  }
  const lo = Math.min(...firsts);
  const hi = Math.max(...firsts);
  if (lo > 0 && hi / lo > maxSpread) {
    return {
      tokens: fallback,
      n: firsts.length,
      measured: false,
      spread: hi / lo,
      why: `first-turn context spreads ${(hi / lo).toFixed(1)}x across ${firsts.length} sessions (${lo.toLocaleString()} to ${hi.toLocaleString()}), wider than ${maxSpread}x`,
    };
  }
  return {
    tokens: Math.round(median(firsts)),
    n: firsts.length,
    measured: true,
    spread: hi / (lo || 1),
  };
}

/**
 * What compacting actually saved, in exact tokens (problem/saved-counter-wrong-frame,
 * the user's decisive reframing: "the point of token saved was by compacting
 * sessions and bus to help cloud agents not have to reread everything").
 *
 * The arithmetic is exact because the curve is exact: a compaction drops the
 * context a session re-reads on every turn, and the drop — multiplied by every
 * turn the session ran after it — is the re-read it never paid. No counterfactual,
 * no rates, no estimate: drop × remaining turns, summed over every compaction.
 *
 * But a claim's window ends at the NEXT compaction, not at the end of the
 * session (problem/saved-counter-compaction-window, the user's report that
 * ~35B saved cannot be real — it could not, and it was 51.6B measured). Once
 * another compaction runs, the smaller context is the one being re-read, and
 * the earlier drop stops growing; multiplying by all remaining turns gives
 * every compaction credit for re-reads a later one actually absorbed, and one
 * long, many-compaction session alone claimed 32.5B that no session could
 * ever have spent — a session cannot hold its pre-compaction context past the
 * context limit, so "compacted never" is not a counterfactual it could live.
 * drop × turns until the next compaction (the last one keeps the tail) is the
 * honest ceiling: generous while it was the only reset in sight, capped the
 * moment the real data says another reset happened.
 *
 * Compaction points come from the labelled transcript markers, or — for tools
 * that do not label them — the same double-gated curve-drop inference
 * measuredBaseline uses (both gates: a ratio test alone silently misses real
 * compactions and then starts catching ordinary turns). A transcript has either
 * markers or drops, never both; the same never-both rule as the baseline.
 *
 * Returns { total, events, per }, per[i] aligned to scans[i].
 */
export function compactionSavings(scans) {
  const compactionPoints = (scan) => {
    const curve = scan?.curve || [];
    const marks = Array.isArray(scan?.compactions) ? scan.compactions : [];
    if (marks.length) return marks;
    const inferred = [];
    for (let i = 1; i < curve.length; i++) {
      if (curve[i] > 1000 && curve[i] < curve[i - 1] * 0.75 && curve[i - 1] - curve[i] > 30000)
        inferred.push(i);
    }
    return inferred;
  };
  let total = 0;
  let events = 0;
  const per = [];
  for (const scan of scans || []) {
    const curve = scan?.curve || [];
    let sessionSaved = 0;
    let sessionEvents = 0;
    const points = compactionPoints(scan);
    for (let k = 0; k < points.length; k++) {
      // at is the first post-compaction turn; curve[at-1] is what the session
      // was about to keep re-reading. A compaction at the tail (no next turn
      // yet) has no drop to count and none to claim. The claim's window ends
      // at the next compaction — after that, the re-read actually paid is the
      // smaller context's, and the earlier drop has no more to give.
      const at = points[k];
      if (at > 0 && at < curve.length) {
        const drop = curve[at - 1] - curve[at];
        if (drop > 0) {
          const until = k + 1 < points.length ? points[k + 1] : curve.length;
          sessionSaved += drop * (until - at);
          sessionEvents++;
        }
      }
    }
    per.push({ tokens: sessionSaved, events: sessionEvents });
    total += sessionSaved;
    events += sessionEvents;
  }
  return { total, events, per };
}

/**
 * How many more turns this session has to run before compacting now would have
 * paid for itself. See the header for the derivation — it is H1, nothing else.
 *
 * Infinity means never: a session at or below the baseline has nothing to give
 * back, and summarising it would cost more than it saves.
 */
export function breakEvenTurns(current, baseline) {
  const excess = current - baseline;
  if (!(excess > 0)) return Infinity;
  return current / excess;
}

/**
 * The measurement, and a band to display it in.
 *
 * C2 — this reports, it does not rule. `level` exists so a window can colour a
 * row; the numbers beside it are the actual finding. The two turn counts ARE a
 * chosen line, unlike the break-even itself, and they sit in the signature so
 * that nobody has to read this file to find out what they are.
 *
 * C4 — nothing here acts. The hub shows it and an agent decides.
 */
export function assess(scan, opts = {}) {
  const { baseline = FRESH_FALLBACK_TOKENS, watchTurns = 20, compactTurns = 5 } = opts;
  const current = contextTokens(scan);
  const be = breakEvenTurns(current, baseline);
  const excess = Math.max(0, current - baseline);

  let level = "ok";
  if (be <= compactTurns) level = "compact";
  else if (be <= watchTurns) level = "watch";

  return {
    level,
    turns: scan?.turns || 0,
    contextTokens: current,
    baselineTokens: baseline,
    excessTokensPerTurn: excess,
    breakEvenTurns: be,
    // One sentence of measurement, phrased so it stays true when it is quoted
    // on its own in a board note or a nudge.
    line:
      be === Infinity
        ? `${current.toLocaleString()} tokens a turn, at or under the ${baseline.toLocaleString()} baseline — nothing to reclaim`
        : `${current.toLocaleString()} tokens re-read every turn, ${excess.toLocaleString()} of it above a fresh session; compacting pays for itself in ${be.toFixed(1)} more turns`,
  };
}

/**
 * Which sessions are worth telling somebody about right now, and which are not.
 *
 * The nudge (lane 2a) is three judgements, and all three are arithmetic, so
 * they belong here rather than in the agent (A2): is anyone still in that
 * session, has it passed break-even, and have we already said so recently.
 * The agent keeps the part that is not arithmetic — writing to the board.
 *
 * `seen` maps note key to an ISO timestamp of the last time it was filed. It
 * is passed in rather than held here because this file holds no state.
 */
export function dueForNudge(rows, seen = {}, opts = {}) {
  const { now = Date.now(), liveMs = Infinity, renudgeMs = 0, level = "compact" } = opts;
  const out = [];
  for (const r of rows || []) {
    const a = r?.assessment;
    if (!a) continue;
    // A dead session cannot act on advice, and advice nobody can act on is how
    // a wall display stops being read.
    if (!(r.idle < liveMs)) continue;
    if (a.level !== level) continue;
    const key = "context-" + r.id;
    const last = Date.parse(seen[key] ?? 0) || 0;
    if (now - last < renudgeMs) continue;
    out.push({ key, id: r.id, turns: a.turns, line: a.line });
  }
  return out;
}

/**
 * Every session, worst first, with its assessment attached.
 *
 * Takes either bare scans or {…, scan} wrappers, so a caller that knows which
 * session belongs to which agent can carry that through without this file
 * learning what an agent is.
 */
export function watch(scans, opts = {}) {
  const list = (scans || []).filter((x) => x && (x.scan?.turns || x.turns));
  const bare = list.map((x) => x.scan || x);
  const baseline = opts.baseline ?? baselineFrom(bare, opts);
  const tokens = typeof baseline === "number" ? baseline : baseline.tokens;
  const rows = list
    .map((x) => ({ ...x, assessment: assess(x.scan || x, { ...opts, baseline: tokens }) }))
    .sort((a, b) => b.assessment.contextTokens - a.assessment.contextTokens);
  return { baseline, rows, totals: mergeScans(bare) };
}
