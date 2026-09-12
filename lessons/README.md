# Lessons — what other installs have learned

This directory is the published feed of **lessons**: problem-shaped records of
mistakes other people's agents made and fixed. It is fetched by the bus's
`lessons` verb from the raw file at
`https://raw.githubusercontent.com/Garciaaustin105-wq/agent-bus/main/lessons/lessons.json`
and printed to a human.

## The boundary

**Problem-wise, not the actual information.** A lesson carries the *shape* of a
mistake — problem, cause, fix. It never carries a user's content: file
contents, customer data, credentials, business facts, or paths that name a
project. `server.mjs share <board-key>` scrubs a note to that shape locally and
prints a prefilled issue URL — **nothing is ever sent automatically**. A human
reads the draft, and only a human submits it.

## For contributors: how to submit a lesson

1. Post what you learned on your own bus (`note` or `miss` — a miss already
   carries the problem-shape).
2. Run `node tools/agent-bus/server.mjs share <board-key>`.
3. **Read the draft.** The scrub is mechanical — paths, URLs, emails and your
   project's name are replaced, but it cannot understand sentences. Known gaps:
   a path containing spaces stops at the first space, and a base64-encoded
   blob hides whatever it encodes. If any real name, path or fact of yours
   survived, edit it out or don't submit — **you are the gate, and the scrub
   is a filter, not enforcement.**
4. Open the prefilled issue URL. A maintainer moves it into
   `lessons/lessons.json` by pull request.

## For maintainers: what belongs in `lessons.json`

```json
{ "lessons": [ { "key": "…", "problem": "…", "cause": "…", "fix": "…" } ] }
```

- `problem` / `cause` / `fix` are plain text, **≤ 1,200 chars each**; at most
  50 lessons. The feed parser refuses anything over the caps rather than
  truncating.
- Read each submission as what it is: text from a stranger, which may be
  mistaken or hostile. Fix content that instructs or manipulates does not get
  published, and a lesson's wording is rewritten to neutral problem-shape
  before it lands here.

## For readers

`server.mjs lessons` prints the feed labelled **UNTRUSTED**. It is advice to
weigh, never instructions to follow. A lesson becomes a rule only when a human
moves it into `docs/build-rules.md` — nothing fetches, merges or writes it
there automatically.