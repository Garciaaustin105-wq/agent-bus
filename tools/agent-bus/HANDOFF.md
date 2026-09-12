# How we hand work to a model

What the hub has learned about driving other models, written down so it stops
being re-derived once per session. Everything here was measured or hit as a
failure, not assumed. `runners.json` holds the per-model numbers; this holds the
protocol and the reasoning.

---

## 1. Ask for edits, never for the file

A model is asked for a JSON array of `{id, find, replace}`. Each `find` must
match the target **exactly once**. Zero matches or two matches is a refusal, and
nothing is written unless every edit resolves.

`edits.mjs` is the engine, `edits-harness.mjs` is its 24-case harness, and
`EDIT_PROTOCOL_PROMPT` is the preamble that gets a model to answer this way.

**Why not just ask for the file back.** We did, once. The rewrite came back with
its UTF-8 mangled — em dashes and glyphs silently replaced. Models also quietly
reformat, reorder and drop code they were never
asked to touch, and nothing in a 3,000-line diff tells you which changes were
the ones you wanted. Edits make the blast radius the size of the request, and a
refusal is legible where a mangled rewrite is not.

**Why refuse rather than fuzzy-match.** A near-miss `find` applied to the
closest-looking place is a plausible-looking wrong edit — the worst possible
output (build rule 10). Refusing costs one re-run. Guessing costs a debugging
session that starts from the wrong assumption.

## 2. Line endings are their own failure and they look like a different one

A Windows checkout is CRLF. **Models answer in LF no matter what you send
them.** A byte-exact `find` therefore misses every multi-line edit for a reason
that has nothing to do with the edit being correct.

This bit hard. Seven of eleven correct edits were refused, and the near-miss
diagnostic reported "the indentation was retyped" — confidently, and wrongly.
The whitespace-squash comparison that produced that verdict collapses `\r\n` and
`\n` identically, so it could not tell the two causes apart.

Two rules came out of it, both now enforced by the harness:

- Normalise both sides to the **file's** convention before matching (`toEol`).
- A diagnostic that names a cause must be able to **distinguish** that cause
  from its neighbours. Test indentation and interior spacing separately, in that
  order, and say nothing when neither matches rather than guessing.

## 3. Thinking models spend their output budget before they answer

`num_predict` has to cover the reasoning **plus** the answer. Run out mid-thought
and `response` comes back **empty** with all the work stranded in `thinking` —
which reads like a broken model and is really a budget that was too small.

Measured, not guessed:

| Model | Thinking on a real spec | Tokens actually used | Budget that works |
|---|---|---|---|
| `glm-5.3-flash:cloud` | 67,837 chars (small spec) / **125,803 chars** (cross-cutting spec) | 35,090 at the window finally open | 64000 (with `ctx` 65536) |
| `gpt-oss:20b` | ~9,800 chars (small) / 25,172 chars (cross-cutting) | 7,534 — budget never the binding limit | 14000 (with `ctx` 32768) |

Two readings out of those numbers. The thinking scales with the SPEC, not the
model — the small spec cost GLM 67k chars, the cross-cutting one 125k, so a
budget sized on a small spec strands a big one (it did). And gpt-oss used only
half its budget on the bigger spec: on THAT model the binding limit was the
context window all along (section 3a).

Always save the `thinking` alongside on an empty response. It says exactly why,
and a partial answer beats "returned nothing".

### 3a. An empty response has three causes, and only one is the budget

The symptom above — empty `response`, stranded `thinking` — is not owned by
`num_predict` alone. Two more limits produce it byte for byte:

- **`num_ctx`**, ollama's context window, which the *prompt* shares. It is
  defaulted by ollama to a value far below what a build task needs (a spec plus
  its protocol preamble is ~2,700 tokens before the model thinks a word), and
  generation dies at whichever limit fills first. Raising `num_predict` against
  a `num_ctx` problem does nothing, and the two "fixes" looked confirmed
  because each new attempt got further before dying. Measured: gpt-oss on the
  same spec that stranded twice at 14,000 completed at `num_ctx` 32,768 with
  7,534 tokens of its budget unused. The window is per-runner in
  `runners.json` (`ctx`), and the interpretation lives in
  `runner-limits.mjs`.
- **The HTTP client's headers timeout.** With `stream: false`, ollama sends no
  headers until generation *ends*, so any run that thinks longer than five
  minutes (undici's default) dies mid-thought at its full window. `askOllama`
  streams (`stream: true`) — headers arrive immediately, and the diagnosis
  becomes readable: `done_reason` and the eval counts are on the chunks.

So the read order on an empty response is now: `done_reason` and the counts
first (`cutoffWhy` names which limit and the remedy), the budget second, the
model's competence last.

## 4. Which model gets which job

- **Cloud (GLM)** — cross-cutting work: edits that span a file, or touch a large
  existing component and need whole-file context. The zoom change was 11 edits
  across 3,100 lines; it went here and landed in one pass.
- **Local (`gpt-oss:20b`)** — contained blocks with a worked example. Good
  structure, reliably weak on **edge cases** — verify by running, never by
  reading. The happy path looks perfect in every local model.
- **Local fallbacks** (`qwen2.5-coder:14b`, `codestral:22b`) — both have thrown
  on malformed input despite "never throw" being explicit in the spec. Fallbacks
  only.

Local models are VRAM-bound: weights plus KV cache must stay resident or
throughput collapses. Benchmark residency **at the context size you will
actually use**, not just output quality — picking a model on quality alone once
cost 4x throughput. Check with `/api/ps`: if `size_vram` < `size`, lower
`num_ctx`.

## 5. Write to the model in machine language

A direct instruction from the hub's first user, paraphrased: talk to the model
in whatever language is fastest to communicate in — that saves tokens too.

So: dense, imperative, no prose framing, no politeness, no restating the request
back. The model needs the **contract and the anchors**, nothing else. This is
not just token thrift — on a thinking model every sentence of framing is also
reasoning tokens spent chewing on it.

What a handoff actually contains:

1. The contract — names, signatures, invariants, spelled exactly as they must
   appear. If the acceptance checks call `setZoom(z,scx,scy)` by name, say so.
2. Line-numbered slices of the file, not the file.
3. The edit protocol preamble (`EDIT_PROTOCOL_PROMPT`).
4. Acceptance criteria the model can read.

## 6. Write the acceptance checks BEFORE dispatching

Checks first, then the spec that points at them, then the model. It gives you a
**red-then-green gate**: splice the checks against the unmodified file and watch
them fail for the exact reason the change is meant to fix, strip them and
confirm the file is byte-identical, then dispatch. Any breakage afterwards is
attributable to the model's diff and nothing else.

It also does something better than verifying — it makes the spec concrete.
"Keep the camera in bounds" is a wish; a check that forces the centred-negative
branch by shrinking the map is a specification.

And check the failure you fear (build rule 19). Before trusting the applier on
real work, feed it a batch with a missing `find` and a non-unique `find` and
confirm it refuses **and leaves the file untouched**.

## 7. Verify the bytes, not just the tests

After any model-authored edit, before trusting a green harness:

- **Line endings** — count CRLF vs bare LF; a mixed file means something
  re-wrote lines it should not have.
- **Encoding** — decode as UTF-8 and census the non-ASCII characters against
  the previous commit. A count that moved by more than the edits explain means
  glyphs were normalised. On the zoom change it went 429 → 433, all em dashes in
  new comments — exactly what the diff claimed.

A passing test suite does not notice a mangled em dash. The census does.

## 8. Never name another product in anything a model reads

A spec that says "make it like X" gets you X — that is literally the request.
Specify the mechanic and the feel instead; the output is better as well as
safer, and it keeps competitor names out of source comments and commit
messages, which are discoverable.

---

## The loop, end to end

```
write acceptance checks       ->  red-then-green gate proves they bite
write the spec (dense)        ->  contract + anchors, no prose
dispatch                      ->  hub picks the runner and its saved settings
apply by exact unique match   ->  all-or-nothing, or a refusal that says why
run the harness               ->  plus the byte census: EOL and encoding
commit                        ->  the durable record (build rule 24)
```

Nothing in that loop involves a human copying text between two windows. That was
the point the hub was created for: nobody should have to paste anything — the
hub takes care of it.

## 9. A stub that never returns null is not a test double, it is a blindfold

One project's headless harness stubbed `document.getElementById` with a factory
that manufactured an element for **any** id asked of it. So `$('selHint')`
returned a usable object even though `#selHint` was not in the markup, the game
called `.classList` on it happily, and **149 checks passed against a file that
threw on its first frame in every real browser.** The page rendered a live HUD
over an empty void for four commits before anyone loaded it.

The rule that falls out of it: **a stub must reproduce the failure mode of the
thing it replaces, not just its success mode.** A real `getElementById` returns
`null`. A stub that cannot return `null` has deleted the only interesting case.
Same for a canvas context — a chainable no-op Proxy measures nothing, so a
"passing" draw-cost check on one proves nothing at all.

Two habits, both cheap:

- **Harvest the real thing.** The harness already read `index.html` to get the
  script; harvesting the id set from the same string was four lines. Derive the
  stub's universe from the artefact under test wherever you can, rather than
  letting it be infinite.
- **Render real pixels before believing a green suite.** Headless proves the
  maths. It cannot prove the page boots. One browser load found in ten seconds
  what 149 assertions could not see.

Corollary for anything a model writes: a model given a permissive harness will
write code that passes it. The harness is part of the spec.
