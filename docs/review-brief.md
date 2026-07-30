# RSConclave: brief for an independent code review

You are reviewing a small self-hosted web app before its first public release.
It is public domain (Unlicense), so read anything you like.

**What would help most:** findings that survive scrutiny. This codebase has
already had one adversarial pass, and the cheap observations - "there is no
CSRF token", "the endpoint URL is user-controlled", "any account can manage
accounts" - are all known, deliberate, and explained below. Repeating them
costs the reader attention without adding anything. What is genuinely wanted is
the thing the last reviewer missed.

---

## 1. What it is

A web UI for orchestrating **sequential** multi-model workflows against local
LLM servers (Ollama, or anything OpenAI-compatible such as llama.cpp server).
Four modes:

- **Chat** - 1:1 with one model.
- **Council** - one prompt to N models in turn, then a consolidator model reads
  all the labelled answers and synthesises one. Optional ballot mode tallies a
  straight answer alongside the prose.
- **Roundtable** - 2+ participants (model + persona + role overlay) take turns
  in one shared conversation, human-gated. A participant can be the human.
- **Pipeline** - chained stages, each receiving the previous stage's output as
  `{{INPUT}}`.

It is used by one person at a time on a home network, with accounts so a
household keeps separate histories.

## 2. How to read it

Zero dependencies. Node runs the TypeScript directly via type stripping, the
frontend is vanilla HTML/JS/CSS, there is no build step and no framework. If
you are looking for a bundler config or a `node_modules`, there isn't one.

```
server/
  main.ts        HTTP entry: routes, auth gating, cross-site guard, static+SSE wiring
  engine.ts      THE core. Owns the single active run, one-generation-at-a-time,
                 ownership, gating, auto-step, abort, persistence. Start here.
  providers.ts   Ollama + OpenAI-compatible streaming clients, NDJSON/SSE parsing
  auth.ts        scrypt passwords, opaque session tokens, per-IP login lockout
  store.ts       JSON persistence, atomic writes, per-user directories
  router.ts      tiny method+path router, JSON body reader
  sse.ts         per-user event fan-out
  roundtable.ts  turn order + N-party to 2-role message mapping   (pure)
  council.ts     transcript assembly, consolidator templating      (pure)
  pipeline.ts    stage input resolution, template rendering        (pure)
  chat.ts        transcript to user/assistant mapping              (pure)
  vote.ts        ballot option matching and tallying               (pure)
  text.ts        <think> stripping, transcript rendering           (pure)
  tokens.ts      prompt token estimation                           (pure)
public/          one file per view, plus app.js (shell + shared helpers)
```

The pure modules are unit-tested (`npm test`, 102 tests). `engine.ts` is not,
which is discussed in §5.

Run it with no GPU at all:

```bash
npm run mock     # fake Ollama, three models
npm start        # http://127.0.0.1:7777
```

## 3. Deliberate decisions - please do not report these as bugs

Each of these is a considered trade-off for a single-user-at-a-time app on a
trusted LAN. Argue with the reasoning if you think it is wrong, but please
engage with the reasoning rather than restating the surface fact.

1. **No roles.** Any signed-in account can create and delete other accounts,
   and can rewrite the shared endpoint list. Accounts exist to keep histories
   separate between people who already trust each other, not to defend against
   each other. Documented in the README as "a household or a few friends".

2. **The endpoint list is shared and user-controlled, and the server fetches
   it.** That is SSRF by construction: the entire purpose of the server is to
   proxy inference to an address you chose. A blocklist would be false comfort
   on a LAN app whose legitimate targets are private addresses. Validation
   exists (http/https only, bounded count) to stop malformed saves wedging the
   app, not as a security boundary.

3. **No CSRF token.** Cookies are `SameSite=Lax` and `isCrossSite()` in
   `main.ts` rejects any request with a cross-site `Sec-Fetch-Site` or foreign
   `Origin`; body-carrying methods must be `application/json`, which forces a
   preflight this server never answers. If you can defeat that combination,
   that is a finding worth having.

4. **Transcripts are plaintext JSON on disk.** Filesystem access reads
   everything. Accounts separate people sharing the app, not the disk.

5. **One generation at a time, globally.** A hardware truth (one GPU, one
   model), not a quota. Non-owners see a bare `busy` flag with no content.

6. **`uncaughtException` is not trapped**, though `unhandledRejection` is. By
   the time an uncaught exception fires, state may be half-applied; restarting
   is more honest than continuing on a corrupt heap.

7. **No `"type"` field in package.json.** Both values break the app - `module`
   breaks the CommonJS tooling and the browser-loaded `markdown.js`, and
   `commonjs` disables Node's module detection so every `.ts` file fails on its
   first import. The reasoning is recorded in the file.

## 4. Where the interesting bugs have actually been

Recent real defects, as calibration for where this code tends to go wrong.
Related mistakes elsewhere are exactly what a second pass might catch.

- **A fire-and-forget run that threw took the whole process down.** Runs start
  from request handlers without awaiting, so a throw became an unhandled
  rejection, and Node's default is exit. A stale endpoint id (an ordinary
  consequence of deleting an endpoint in Settings) killed the server for
  everyone while returning HTTP 200 to the caller. Now funnelled through
  `engine.launch()`.
- **`stopRun()` cleared the active slot while the aborted turn was still
  unwinding**, and persistence was guarded on "is anything active" - so it
  silently did nothing at the one moment there was something to save. Partial
  output and the cancellation marker were both lost.
- **Cancel behaved differently per mode.** Roundtable and pipeline stopped;
  council carried on through every remaining member and then consolidated.
- **Sessions kept `status: 'active'` forever**, so several claimed to be the
  live run at once.
- **A splice broadcast only its first removed entry**, so rerolling after a
  narrator injection dropped that injection from disk while the UI kept showing
  it.
- **Ballot matching counted "I would rather *no*t commit" as a vote for "No"**
  until word boundaries were added.
- **Tags were stored, and returned by the single-session route, but missing
  from the session-list projection** - which is the only call the sidebar
  makes, so the feature could not work.

The pattern worth noting: **the failures cluster around state that lives across
an `await`, and around agreement between what the browser was told and what
reached the disk.** Those are the seams to lean on.

## 5. Known-thin areas, honestly

Not fishing for reassurance here - these are the places a reviewer is most
likely to find something real.

- **`engine.ts` has no unit tests.** It is stateful, single-instance, and every
  interesting behaviour spans an `await`. `dev/probe-runcontrol.mjs` drives the
  real server over HTTP and checks four run-control behaviours, but that is a
  thin net over a large surface.
- **Multi-user paths are unverified.** Takeover, box-busy, and per-user SSE
  isolation were reasoned about and read carefully, not proven. Concurrent
  two-user behaviour has never been executed.
- **Read-modify-write on shared JSON files.** `users.json`,
  `authsessions.json` and `config.json` are read, mutated and written. Two
  known races around `await hashPassword` were fixed by re-reading after the
  await. Whether others remain, especially in the session-token path, has not
  been established.
- **No Content-Security-Policy.** The app renders model output, so this is the
  obvious defence-in-depth gap. The blocker is one inline `<script>` in
  `index.html` (the pre-paint theme applier) that would have to move first.
- **Login lockout is 5 attempts per minute per IP, with no backoff**, keyed on
  `req.socket.remoteAddress`. Behind a reverse proxy every client shares one
  key. `X-Forwarded-For` is deliberately not trusted.
- **SSE connections are unbounded per user**, and the heartbeat writes to every
  client with no drain handling.
- **`listSessions()` parses every session file on every list and every search.**
  Fine at tens of sessions; untested at thousands.
- **The ballot matcher is duplicated** in `server/vote.ts` and
  `public/app.js` (`pickBallotOption`) so the tally can fill in live. They were
  checked against the same cases by hand. Nothing enforces that they stay in
  agreement.

## 6. What a useful finding looks like

Ranked by what would actually help:

1. A concrete failure this code can reach: the input or sequence, what happens,
   why it matters. Especially anything involving two users, an abort landing at
   an awkward moment, or the browser and disk disagreeing.
2. A correctness bug in the pure modules - turn-order mapping, context
   truncation, `<think>` stripping across chunk boundaries, ballot matching.
   These are unit-tested, so a hole here is a hole in the tests too.
3. An auth or isolation flaw that works *within* the stated trust model: one
   signed-in user reading another's transcripts, a session token surviving
   something that should revoke it, a path escaping its user directory.
4. Somewhere the code and its comment disagree. The comments explain reasoning
   rather than syntax, so a stale one is actively misleading.
5. Design feedback on the concurrency model, if you think one-run-at-a-time is
   the wrong shape given the hardware constraint.

Please skip: formatting, naming, "consider adding TypeScript strict mode" (it
is on), "consider a framework", "add a linter", dependency suggestions (zero
dependencies is the point), and the seven items in §3.

If you find nothing in a section, saying so plainly is more useful than
manufacturing a finding to fill it.
