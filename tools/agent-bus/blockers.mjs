/**
 * The blocker seam — §5's second half. An agent that is stuck reports WHAT it
 * is blocked on and WHAT it needs; the bus matches that against (a) the
 * capabilities other agents declared and (b) the fixes the fleet already
 * banked, and messages the people who can help. When someone unblocks it, the
 * fix is written to the board under `fix-…` so the NEXT agent that hits the
 * same block is handed the answer instead of the wall.
 *
 * The three behaviors of roadmap §5, in bus terms:
 *
 *   asks agents what they can grant  → capable(), and register() nudges for it
 *   matches blockers to solvers      → matchCapable(), message on block()
 *   answers blocks with saved fixes  → matchFixes() on block(), fix note on unblock()
 *
 * Pure contract: words and objects in, matches and strings out, no disk, no
 * network (build rule 2). The state layer lives in server.mjs.
 *
 * Matching is deliberately DUMB — keyword tokens, deterministic, no model.
 * The hub agent is rules, not judgment (that is §5's own architecture), and a
 * match that can be explained ("you were named because you listed 'ollama'")
 * is worth more than a clever one nobody can audit. A dumb matcher that is
 * wrong in the direction of telling MORE people is safe; the failure mode is
 * noise, not silence.
 */

/** Lowercase word tokens, deduped — the vocabulary everything matches on. */
export const normalizeTerms = (text) => {
  const words = String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
  return [...new Set(words)];
};

/**
 * Who can grant what's needed. `agents` is [{name, lane, capable: [...]}].
 * An agent matches when its declared capabilities share at least one word
 * with the need; ranked by how many words matched, so the closest fit reads
 * first. Agents that declared nothing are invisible here — declaring is the
 * whole social contract.
 */
export function matchCapable(needed, agents) {
  const want = normalizeTerms(needed);
  if (!want.length) return [];
  const matches = [];
  for (const a of agents ?? []) {
    const declared = (a.capable ?? []).map(normalizeTerms).flat();
    const shared = want.filter((w) => declared.includes(w));
    if (shared.length) {
      matches.push({ name: a.name, lane: a.lane ?? null, matched: [...new Set(shared)] });
    }
  }
  return matches.sort((x, y) => y.matched.length - x.matched.length);
}

/**
 * The fixes the fleet already saved for this shape of problem. `boardEntries`
 * is [{key, value, at}]; only `fix-*` notes are searched, scored by shared
 * words, best-first, capped — a report that returns ten half-relevant essays
 * is a report nobody reads.
 */
export function matchFixes(what, needed, boardEntries, max = 3) {
  const want = new Set([...normalizeTerms(what), ...normalizeTerms(needed)]);
  if (!want.size) return [];
  return (boardEntries ?? [])
    .filter((e) => typeof e?.key === "string" && e.key.startsWith("fix-") && typeof e?.value === "string")
    .map((e) => {
      const shared = [...want].filter((w) => normalizeTerms(e.value).includes(w));
      return { key: e.key, value: e.value, at: e.at, score: shared.length };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || String(b.at ?? "").localeCompare(String(a.at ?? "")))
    .slice(0, max);
}

/** The board key an unblocked fix lands under — same subject, every time. */
export const fixNoteKey = (what) =>
  "fix-" +
  (String(what ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-") || "unnamed");

/**
 * Validate a capabilities declaration. Each entry is short (it is a matching
 * term, not a biography), the list is bounded, duplicates and empties drop
 * out — and the whole thing is a plain word list, so nothing here can smuggle
 * structure into state.
 */
export function capableList(capabilities) {
  if (!Array.isArray(capabilities)) {
    throw new Error("capabilities must be a list of short strings, e.g. ['ollama', 'stripe', 'tree']");
  }
  const clean = [...new Set(
    capabilities
      .map((c) => String(c ?? "").trim().toLowerCase())
      .filter((c) => c && c.length <= 40),
  )];
  if (!clean.length) {
    throw new Error("capabilities needs at least one non-empty entry, e.g. ['ollama', 'stripe']");
  }
  if (clean.length > 12) {
    throw new Error("capable takes at most 12 entries — declare what you can GRANT, not everything you know");
  }
  return clean;
}

/**
 * Keep the block log bounded: every OPEN block survives, resolved history is
 * capped (the fix notes on the board are the durable record — the log is
 * just traffic), and 100 total is the hard ceiling. Newest resolved survive
 * the cap; if opens alone overflow it, the oldest opens go — an open block
 * nobody answered in a hundred entries is stale by weight of company.
 */
export function pruneBlocks(blocks, maxResolved = 50, maxTotal = 100) {
  const list = blocks ?? [];
  const open = list.filter((b) => b.status === "open");
  const resolved = list.filter((b) => b.status !== "open");
  let kept = resolved.slice(-maxResolved);
  if (open.length + kept.length > maxTotal) {
    kept = kept.slice(-(maxTotal - open.length));
  }
  return [...open, ...kept];
}

/** What a matched solver receives in their inbox. */
export function blockMessage(block, match) {
  return [
    `Blocker ${block.id} from ${block.by}: ${block.what}`,
    `They need: ${block.needed}.`,
    `You were named because you can grant: ${match.matched.join(", ")}.`,
    `unblock("${block.id}", "<what you did>") when it is handled — the fix is banked on the board.`,
  ].join("\n");
}

/** What the reporting agent sees back: who was asked, what was already known. */
export function blockAnnounce(block, matches, fixes) {
  const lines = [`Reported ${block.id}.`];
  if (matches.length) {
    lines.push(
      `Asked ${matches.map((m) => m.name).join(", ")} — they can grant part of this (check inbox replies).`
    );
  } else {
    lines.push(
      "Nobody registered can grant this yet. Agents declare with capable([...]) — the register reply asks them to."
    );
  }
  if (fixes.length) {
    lines.push("", "The fleet has hit this shape before:");
    for (const f of fixes) {
      lines.push(`  ${f.key}: ${f.value.split("\n")[0].slice(0, 200)}`);
    }
  } else {
    lines.push("No saved fix matches yet — your unblock() will write the first one.");
  }
  return lines.join("\n");
}