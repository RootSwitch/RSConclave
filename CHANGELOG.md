# Changelog

## Unreleased

- **A stopped run can no longer mark its replacement as finished.** The
  independent review's one high finding, and it survived verification. Every
  run's tail code - `finishRun()`, the "back to the gate" blocks after a turn
  - read the GLOBAL active-run pointer, and every caller reaches that code
  across an await. Stop a council mid-stream and start a chat before the
  aborted turn finishes unwinding, and the dying council's `finishRun()`
  marked the brand-new chat as done. Over HTTP the window is milliseconds
  (the probe could not force it end to end), but calling stop and start in
  the same tick reproduces it every time, and the stop-and-start confirm
  makes the sequence a normal user action. Fixed by threading the run through
  `runTurn`, `runConsolidation` and `finishRun` and refusing to touch state
  once `active` is no longer that run - a displaced run's final status was
  already written by whoever displaced it. The judge tail in
  `consolidateRoundtable` was mutating the global directly; same fix. The
  run-control probe gained the stop-then-start race as a permanent check.

- **A rename in the instant after Stop is no longer silently reverted.** The
  aborted turn's unwind saves its partial output by writing the whole session
  from memory - and a rename or retag issued in that same instant goes to
  disk, because the session is no longer the live run. The stale in-memory
  copy then overwrote it. `persistOf` now re-reads title and tags from disk
  when the run it is saving has lost the active slot. (The review described
  a related race here; the mechanism it named cannot occur - the engine holds
  no session references besides the active run, and the check-and-write is
  synchronous - but chasing it surfaced this real, narrower window.)

- **Searching for a tag now finds the session.** Tags rendered in the sidebar
  and drove its filter chips, but the transcript search never looked at them -
  a tag that appeared nowhere else in the text returned nothing.

- **A seat named with brackets strips both spellings of its self-prefix.**
  "[Bot]:" was always stripped; the de-bracketed "Bot:" survived. The name's
  own brackets now come off before the optional ones around the pattern, so
  both forms strip. (The review's mechanism was off - it claimed the bracketed
  form required doubled brackets, which the optional matcher never did - but
  the residual case it pointed at was real.)

- **Standing up the inference box is now one command, context sizing
  included.** `tools/install-ollama.sh` is the companion to `install.sh`: that
  one deploys RSConclave, this one prepares the box it talks to. It detects
  the GPU vendor (or takes `--gpu nvidia|amd|cpu`), installs Ollama, writes a
  systemd drop-in for the bind address, model directory and keep-alive,
  restricts port 11434 to the hosts you name, and verifies the API answers.
  With `--pull MODEL --tune` it goes the last step: pull a model, measure its
  real per-token memory cost, and bake the largest fully-resident `num_ctx`
  into it - so the box comes up with the silent-truncation trap already
  closed. The tuning is `tools/measure-ctx.sh --apply`, new alongside it: the
  measuring tool can now write its own recommendation into the model (same
  name, a rebuild over the same blobs, every client benefits). The applied
  number is parsed back out of the printed report rather than computed twice,
  so what is applied is by construction what was shown.

  Two refusals are the point of the script. It will not install drivers - a
  reboot mid-script is a bad surprise, and docs/inference-host.md covers that
  part - and it will not proceed when a GPU is present but its driver does not
  answer (`nvidia-smi` for NVIDIA, `/dev/kfd` for AMD), because the failure
  that produces is the worst one this box has: everything starts, everything
  answers, and generation runs at CPU speed with nothing anywhere saying why.
  After the restart it surfaces Ollama's own "inference compute" verdict, so
  CPU fallback is announced instead of discovered three days later. Pass
  `--gpu cpu` to accept CPU inference knowingly.

  Honest caveat, also stated in the guide: the script targets a Linux systemd
  box and was built on a machine that is neither. Every branch runs against a
  stub harness (`dev/harness-install-ollama.sh`, committed - 24 checks
  covering the drop-in content, idempotency, both refusal paths, the firewall
  rules and the full pull-tune chain), and the harness already caught one real
  bug (an empty `--allow-from` array collapsing a test to `[ = set ]`). What
  stubs cannot prove is the real Ollama installer, systemd and a GPU behaving
  as stubbed: its first run on a real box is a test, not a ceremony.

- **The Windows launcher stopped printing advice that would break the app.**
  Adding `package.json` made Node emit `MODULE_TYPELESS_PACKAGE_JSON` and
  suggest adding `"type": "module"` - the one change confirmed to break this
  project. The npm scripts, the Dockerfile and the screenshot runner all
  suppress that warning; `RSConclave.cmd` calls node directly and was missed,
  so it printed the warning in the very window the README tells a user to leave
  open. Fixed, along with three other things in the same file:

  It waits with `ping` rather than `timeout`, because `timeout` needs a real
  console and dies with "Input redirection is not supported" the moment stdin is
  redirected - which is what happens when the launcher is started from a
  shortcut, a scheduled task or a wrapper rather than by double-clicking.

  It opens the scheme the server will actually be listening on. The server
  switches itself to HTTPS whenever it finds a certificate pair, and the
  launcher always opened `http://`, which just fails with nothing to explain
  why.

  It checks that Node exists and is at least 22 before launching, and says what
  to install if not, with a `pause` so the message survives a double-click.
  Previously a missing or too-old Node closed the minimized window instantly and
  left a dead browser tab as the only symptom.

  `.gitattributes` now pins `*.cmd` to CRLF, the mirror of the existing LF rule
  for `*.sh`. cmd.exe mishandles LF in some constructs, and this file is the
  entry point for anyone handed the app on Windows.

- **A Socratic Tutor persona, and one fewer example in the roundtable form.**
  The tutor teaches only by asking and is forbidden from confirming an answer
  even when the student is one step away, which makes it the second deliberate
  pair in the set: Plain Explainer and Socratic Tutor want the same outcome by
  opposite methods, the way Skeptic and Advocate hold opposing stances. Put
  them on facing seats and the roundtable argues about how to teach.

  The role-overlay field lost its example entirely rather than gaining a better
  one. The Ideas fold underneath now does the "what is this for" work, and any
  single example narrowed the mode to whatever domain it came from - which is
  the problem the fold was added to solve. The placeholder explains the field
  instead, and the tooltip spells out the layering (framing, persona, overlay,
  scenario).

- **The roundtable stopped implying it was a tabletop tool.** Every example in
  the setup form pointed the same way: the seat name suggested "DM", the role
  overlay suggested "You are the Dungeon Master", and the scenario field asked
  for "world context". Any one of those is fine; all three together quietly
  answered the question "what is this for?" before the user got to ask it.
  The name field now states what it actually does (blank uses the model name),
  the overlay and scenario examples are drawn from other domains, and a
  collapsed "Ideas" fold lists eight things people use a roundtable for -
  debate with a verdict, adversarial code review, pre-mortems, rehearsing a
  hard conversation, interview practice, editorial passes, Socratic tutoring,
  and tabletop sessions, which is still there, just no longer the only answer.

  Collapsed by default because the roundtable setup is already the longest
  screen in the app: it costs 38px on a phone until someone opens it. The
  README's "good for" list was widened to match.

  The Dungeon Master persona stays. One themed example among six is flavour;
  it was the form asking for the same theme three times that was the problem.

- **Fork a session from any message.** Reroll and "re-run from here" both destroy
  what was there, which is the wrong tool when a roundtable takes an
  interesting wrong turn - you want to try the other path without losing this
  one. Fork copies everything up to one entry into a new session, leaves the
  original untouched, and hands the copy back as the live run so you can keep
  going immediately. Provenance is recorded and shows up in exports, so a
  forked transcript is not mistaken for the whole story.

- **"The box is busy" now offers a way out.** Starting anything while one of
  your own runs was parked returned that message and nothing else - Stop lived
  in another view, so the only route forward was knowing where to look. Every
  start now offers to stop the run in the way. It asks rather than doing it
  automatically, because stopping something mid-flight is destructive.
  `engine.stopRun` was always mode-agnostic but only reachable at
  `/api/roundtable/stop`; there is a `/api/run/stop` now.

- **Session tags.** Free-text labels, edited from a session's header, shown on
  each sidebar row with filter chips above the list. Filtering rather than
  grouping, because a session can carry several tags and grouping would have to
  either duplicate rows or silently pick a winner. Tags are derived from the
  sessions themselves, so the last one carrying a tag taking it away makes the
  chip disappear on its own.

- **Import a session from JSON.** Export was one-way, which made sessions
  awkward to share with the people this is built for. This is the only route
  that turns uploaded JSON into stored state, so nothing in the file is
  trusted: a fresh id is minted rather than honoured, every field is coerced and
  bounded, and the status is forced so an import cannot claim to be a live run.

- **Council ballot mode.** Give the council a list of options and every member
  is asked to finish with exactly one of them; the results are tallied above the
  responses and included in exports. The prose answers still happen, because
  "four of five said yes" and the reasons they gave are useful for different
  things.

  The matcher was worth the care. Substring matching counts "I would rather
  **no**t commit" as a vote for No - and once you see that you also see "know",
  "nothing" and "cannot" - so options are matched on word boundaries, from the
  end of the answer backwards, longest option first. Reading from the end
  matters because a model thinking out loud names several options before
  committing to one. All of that is covered by tests, including the substring
  trap that a first pass got wrong.

- **Continue a reply that ran out of room.** A model stopping on its token
  budget leaves a sentence half-finished. Continue extends the same message in
  place rather than starting a second bubble the reader has to staple on, and
  the button only appears on the newest reply when the provider actually
  reported hitting the limit (`done_reason: length`, or `finish_reason` on
  openai-compat).

- **A deleted endpoint no longer breaks every session that referenced it.**
  Sessions record which endpoint they were created against, and a seat whose
  own endpoint id no longer resolves now falls back to that, and then to the
  only configured endpoint when there is just one. Deleting and recreating an
  endpoint in Settings used to leave every saved council and roundtable
  permanently broken - and, until the crash fix above, took the server with it.

- **A stale endpoint id no longer kills the server.** Every run is started
  fire-and-forget from a request handler, and `endpointById()` threw from
  outside the turn's try block - so a saved preset pointing at an endpoint you
  later deleted in Settings produced an unhandled rejection, which Node turns
  into process exit. The HTTP response was a cheerful 200 with a session id,
  and then the whole server was gone, taking every other user's in-flight run
  with it. Reproduced, then fixed: background runs go through a `launch()`
  helper that records the failure on the run, tells the owner, and leaves the
  process up. A `process.on('unhandledRejection')` backstop catches whatever
  the next person forgets to wrap. `uncaughtException` is deliberately not
  trapped - by then the heap may be half-updated and restarting is the honest
  outcome.

- **Cancel now stops a council, not just its current member.** Roundtable and
  pipeline both stopped on cancel; council carried on through every remaining
  member and then ran the consolidation, which is the opposite of what the
  button looks like it does. A member *error* still does not stop the run -
  skipping a dead endpoint so the others still answer is the whole point of a
  council - so only a cancel breaks the loop.

- **Stop mid-generation keeps the partial answer.** `stopRun()` clears the
  active run the instant you press Stop, while the aborted turn is still
  unwinding, and persistence was guarded on "is anything active" - so it
  silently did nothing at exactly the moment there was something to save. The
  text you had watched arrive, and the `cancelled` marker, were both dropped,
  leaving an empty bubble on disk that did not match what the browser showed.
  Writes are now addressed to a specific run rather than to whatever is
  current.

- **Only one session can claim to be active.** Status lived on disk as
  'active' until something explicitly stopped it, so starting a second session
  left the first still claiming the badge - the sidebar could show three at
  once, which it did in the README screenshot. The outgoing session is marked
  'paused' now, and roundtables set it back on resume.

- **Reroll no longer loses an injected message.** Splicing the transcript
  returned every entry from the reroll point onward, but only the first one's
  removal was broadcast - so rerolling after a Narrator injection dropped that
  injection from disk while the browser went on showing it.

- **Security pass.** Signing out or changing your password now closes that
  user's live SSE streams; a stream was authenticated only when it opened and
  never re-checked, so it kept delivering tokens after the cookie behind it
  stopped being valid. Deleting an account moves its data aside instead of
  leaving it in place, because "kept, deliberately" turned into "the next
  person to use that username inherits the previous one's transcripts".
  Static serving compares against the public directory plus a separator rather
  than a bare prefix, so a sibling directory whose name merely starts with
  "public" cannot be reached. Endpoint records are validated on save (http/https
  only, bounded count, no prototype keys in the alias map). Oversized bodies
  answer 413 instead of dropping the connection. Session titles are coerced and
  capped. `nosniff`, `no-referrer` and `DENY` framing headers are set. Two
  read-modify-write races around `await hashPassword` could lose a concurrent
  account creation or password change; both now read after the await.

- **The sidebar can be dragged wider or narrower.** Persisted per browser,
  double-click to reset, arrow keys when focused, clamped so the transcript
  always keeps room. The stored width is re-applied on window resize rather
  than clamped in place, so passing through a narrow window does not
  permanently shrink it.

- **Mobile: the theme picker no longer reads as the menu.** With wrapping
  allowed, it fell to the start of a second row directly under the hamburger,
  where being the widest control made it look like the primary navigation. The
  top bar is now a single row with the picker pinned right, and the menu button
  is labelled "Menu" and bordered instead of being a bare glyph. When space
  runs short the app's own name is the only thing that yields, shrinking to an
  ellipsis and then to nothing - the controls all keep their size, since a
  "Sign out" squeezed into two lines reading "Sig ou" was the previous
  behaviour.

- **The README now opens with what this is for instead of how it is built.**
  It led with mechanism ("orchestrating sequential multi-model workflows
  against remote inference servers"), which describes the implementation to
  someone who has not yet been told why they would want it. It now opens with
  the thing it does that other clients make you do by hand, and the fact that
  it lives next to your inference box so the same history follows you from
  desktop to phone.

  A scope paragraph sits immediately after, because setting that expectation
  early is what turns a would-be bug report into understood design: one GPU,
  one model at a time, accounts for private histories rather than parallel
  generation, a trusted LAN rather than the open internet, and explicitly not
  a router across many hosts.

  New **"Try it without a GPU"** section, promoting something that already
  existed but was buried in the testing notes: `npm run mock` serves three
  fake models, so a visitor can clone the repo and click through all four
  modes on a laptop before deciding whether they want it. The fake models are
  awkward on purpose - one advertises a 2048-token window so the context meter
  turns red, one streams a separate reasoning field so the `<think>` folding
  is visible.

  Also new: a configuration table for the six environment variables (`PORT`,
  `HOST`, `ADMIN_PASSWORD`, `RSCONCLAVE_DATA`, `TLS_CERT`, `TLS_KEY`), which
  were previously scattered across prose or undocumented; the volume backup
  command; a note on the pinned compose project name; and a License section.
  The context-window material moved out of the introduction into its own
  section, since it is the most important setting to understand but not the
  first thing a reader needs.

  Corrected while in there: the testing section said to "exercise both
  workflows" and there have been four for some time, and the intro named Node
  24 where `engines` allows 22.18 and up.

- **Non-erasable TypeScript is now caught by `npm test` instead of at runtime.**
  Node strips type annotations and runs the JavaScript underneath; it never
  transforms anything. So `enum`, `namespace` blocks, parameter properties,
  decorators, `import =` and `export =` all fail with
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` when the file is loaded. `tsconfig.json`
  has always set `erasableSyntaxOnly`, but that only bites if someone runs
  `tsc`, and there is no TypeScript dependency here to run it - so enforcement
  was editor-only. Anyone without a TS-aware editor could add an `enum` and
  nothing would notice until the file happened to be imported at runtime.
  `tools/erasable-check.js` closes that, and `npm test` now runs it plus
  charcheck before the unit tests.

  The tool blanks comments, strings and regex literals before scanning, which
  is most of its bulk. Without that the first false positive is a comment
  explaining why we avoid enums, and a checker that cries wolf is a checker
  someone switches off. Distinguishing a regex literal from a division sign
  needs the keyword rule (`return /re/.test(x)` is a regex even though the
  preceding character is a letter), and constructor parameters are matched by
  counting parens rather than with `[^)]*`, because a real signature contains
  parens of its own in default values and function types. Both cases have
  tests, along with the false-positive guards.

- **Fixed a misleading warning introduced with `package.json`.** Node prints
  `MODULE_TYPELESS_PACKAGE_JSON` when no `"type"` is declared and advises
  adding `"type": "module"` - which is the one change confirmed to break this
  project, since `public/markdown.js` and the CommonJS tools depend on not
  being modules. Every script that runs a `.ts` file now disables that
  specific warning, and the reason sits in `package.json` next to it.
  Suppressing advice that is wrong here beats printing it on every run and
  trusting nobody acts on it.

- **`npm test` works now, along with start/dev/charcheck/mock/screenshots.**
  A `package.json` exists purely to name the project and hold those scripts:
  `dependencies` is empty and `npm install` still installs nothing, so the
  zero-dependency promise is unchanged - the file makes it explicit rather
  than contradicting it.

  It deliberately declares no `"type"`, and adding one breaks the app in
  either direction. `"module"` makes `public/markdown.js` and
  `tools/charcheck.js` fail, since both are CommonJS (markdown.js carries a
  `module.exports` shim specifically so its pure parser half stays testable
  from `node:test`). `"commonjs"` is worse, and not obviously so: it marks
  the package type as *explicit*, which switches off Node's module detection,
  and then every `server/*.ts` file dies on its first `import`. Leaving it
  unset keeps `.js` as CommonJS while detection handles the type-stripped ESM
  `.ts` files. Both failure modes were confirmed, not assumed, and the
  reasoning is recorded in the file itself so the next person does not have
  to rediscover it.

  `engines` says `>=22.18.0` to match what the README actually claims about
  type stripping, rather than the 24.x this happens to be developed on. The
  Dockerfile copies `package.json` too - it changes nothing today, but if a
  `"type"` is ever added, dev and the container need to break together
  instead of one of them quietly disagreeing.

- **The README screenshots can be regenerated with one command.**
  `tools/screenshots/run.sh` starts a scripted inference server, brings the
  real app up against a throwaway `mktemp` data directory, builds the four
  demo sessions through the real HTTP API, drives headless Chrome over the
  DevTools protocol to theme and open each one, captures them into
  `docs/img/`, and tears the whole thing down. Screenshots go stale every
  time the layout moves, and the cost of refreshing them is what decides
  whether that actually happens - so it is now well under a minute rather
  than an afternoon of manual setup. The captures are genuine app output,
  not mocked-up markup: only the model replies are scripted, because four
  panels of identical lorem prose demonstrate nothing.

  Two details are load-bearing. The runner kills the pids it started rather
  than matching process names, because `pkill -f` is absent or ineffective
  on some platforms and can also hit a process the user started themselves;
  when it silently fails, the old port owner survives, the new one dies with
  `EADDRINUSE`, and the stale server answers every request, which looks
  exactly like the tool ignoring your changes. And the scripted pipeline
  replies are matched on the template's first line only, since every stage
  after the first has the previous stage's output pasted in as `{{INPUT}}` -
  a keyword search over the whole message makes all three stages match the
  first one and return the same text.

- **The README now shows the app instead of describing it.** A five-seat
  roundtable leads: Pac-Man and the four ghosts of the Maze Patrol arguing
  their way to a settlement, which demonstrates in one image what the mode
  is for - distinct models, distinct personas, per-seat colours, and the
  gate bar deciding who speaks next. Council, Pipeline and Chat follow in a
  new "Screens" section, each in a different palette so the theming is
  visible rather than claimed. Full width rather than a 2x2 grid, because at
  README width a quadrant is about 450px across and the transcripts stop
  being legible - which defeats the point of showing a transcript.

- **Removed internal infrastructure details from the compose comments.** The
  note explaining the named volume described a specific shared host path and
  which sibling services mount it. None of that is meaningful outside the
  network it came from, and it read as though the reader was expected to have
  the same layout. The reasoning that actually transfers - a named volume
  keeps this app's transcripts out of any other container's mount namespace -
  now stands on its own, with a pointer to the bind-mount alternative for
  anyone who would rather have the files on the host.

- **Renaming the checkout folder no longer orphans your transcripts.** Compose
  derives its project name from the directory when nothing says otherwise, and
  that name prefixes the real volume - so cloning into `RSConclave` rather than
  `rsconclave`, or renaming the folder afterwards, silently attached a fresh
  empty volume and left every session under the old prefix. Nothing was lost,
  but it presented as a total history wipe, which is a bad thing to have to
  reason about while looking at an empty session list. The compose file now
  pins `name: rsconclave`, so the volume is always
  `rsconclave_rsconclave-data` regardless of what the folder is called. The
  folder name is now purely cosmetic: nothing in the repo reads it.

- **Standing up the inference box no longer starts with a blank page.**
  `docs/inference-host.md` is a from-scratch runbook for the Linux host:
  OS, GPU driver, a separate disk for model blobs, Ollama as a service, and
  RSConclave running beside it. AMD is covered alongside NVIDIA throughout,
  because ROCm has two failure modes that look like something else - a user
  missing the `render`/`video` groups gets a silent fall back to CPU, and
  most consumer cards need `HSA_OVERRIDE_GFX_VERSION` to be recognised at
  all. Both present as "inference is mysteriously slow" rather than as an
  error. The guide points at Ollama's own compatibility list rather than
  reprinting one, since that table ages badly.

- **Context sizing is now measured instead of guessed.** `tools/measure-ctx.sh
  MODEL` loads a model at two context sizes, reads its real footprint from
  `/api/ps`, takes the slope, and reports bytes per token plus the largest
  `num_ctx` that stays fully GPU-resident - then prints the Modelfile line
  to bake it in. VRAM is auto-detected from `nvidia-smi` or `rocm-smi`.
  A published table cannot answer this: sliding-window and hybrid-Mamba
  models cost almost nothing per token while dense GQA models cost a lot, so
  two models of nearly identical size can differ more than tenfold. The
  recommendation rounds down to a 4k multiple rather than a power of two,
  which was throwing away up to half the usable headroom whenever the real
  ceiling landed just above one.

- **One command deploys the whole thing.** `tools/install.sh` installs Docker
  if absent, generates a certificate, writes an untracked
  `docker-compose.override.yml` with your port and an `ADMIN_PASSWORD`, and
  waits for the container to actually answer before claiming success. It is
  safe to re-run - existing certificates, override files and the data volume
  are never touched. Two details matter more than they look: the admin
  account is seeded so the login page is not sitting unclaimed on your
  network waiting for whoever finds it first, and the health probe tries
  both schemes every round rather than trusting `--no-tls`, because the
  server switches itself to HTTPS whenever it finds a cert pair and a
  single-scheme probe would call a healthy box dead.

- **One Enter-key rule across the whole app.** Only three fields handled
  Enter before: the login form and chat two boxes. Everything else, 
  including the roundtable own Speak box, needed a click. The policy is now
  explicit and applied everywhere - single-line inputs run the nearest
  action, compose textareas with one button send on Enter and newline on
  Shift+Enter, and long-form fields (prompts, scenarios, personas,
  templates) always newline. The roundtable inject box deliberately stays
  on newline: it has two destinations, Narrator and User, so Enter cannot
  pick one and guessing wrong is worse than a click.

- **Roundtable and Pipeline now say when no endpoints are configured.** With
  none, the only participant option is the human seat, so a fresh install
  offered a roundtable of you talking to yourself with no explanation. Chat
  and Council already warned; these two were silent.

- **Seven example personas ship by default.** Skeptic, Advocate, Code
  Reviewer, Dungeon Master, Plain Explainer, Socratic Tutor and Terse Analyst
  appear in an
  account that has never saved a persona - examples teach the feature
  faster than placeholder text, and each is written as a behavioural rule
  ("name the check and wait for a result") rather than an adjective,
  because a model can check itself against a rule and cannot check itself
  against a mood. Skeptic and Advocate are a deliberate pair: assigning
  opposing stances is the lever that makes a roundtable argue instead of
  converging on whoever spoke first. They are a fallback rather than a
  seed-on-create, so they never overwrite existing personas, and an
  account that deletes them all and saves stays empty.

- **Personas collapse to one row each.** Every persona is now a fold whose
  summary shows its name plus a one-line snippet of its prompt - enough to
  pick one out of a list - with the name field and prompt textarea inside.
  A dozen personas is a dozen 37px rows instead of a dozen textareas. The
  name field lives in the body rather than the summary so a click on it
  cannot fight the disclosure toggle; the remove button sits in the summary
  (so a persona can be dropped without opening it) and suppresses the
  toggle explicitly. Newly added personas open automatically, since an
  empty one exists to be filled in.

- **Settings reordered: Account, Users, Inference endpoints, Personas.**
  Personas is the one block that grows without bound, so it moves to the
  bottom - a handful of personas was pushing the account and endpoint
  controls below the fold.

- **First-class support for running the container on the inference box
  itself.** The compose file now maps host.docker.internal to the host
  gateway (extra_hosts: host-gateway - Docker Desktop provides the name,
  Linux does not until you map it), and Settings gains a "+ host Ollama"
  button that pre-fills http://host.docker.internal:11434. The gotcha is
  documented where you will hit it: the host Ollama must listen beyond
  localhost (OLLAMA_HOST=0.0.0.0), because container traffic arrives on
  the docker bridge - a 127.0.0.1-bound Ollama resolves and still refuses.

- **Code blocks carry a language label, copy, and save.** The fence info
  string models emit (the powershell in three-backticks-powershell) is the
  in-band format signal every chat app leans on; the renderer previously
  parsed fences but discarded it. Each block now shows the label with
  per-block copy and a save button that maps the label to a sensible
  filename (powershell to snippet.ps1, csv to snippet.csv, dockerfile to
  Dockerfile; unknown or missing labels fall back to snippet.txt - a wrong
  extension is a rename, a failed save would be a bug). No syntax
  highlighting by design: that is where zero-dependency stops being cheap,
  and a labeled monospace block carries most of the value.

- **Completed messages render as markdown.** Headings, bold and italic,
  inline code and fences, lists, rules and - the big one for model output -
  tables now render instead of showing their syntax. A translation table
  also maps the LaTeX symbol tokens some models sprinkle into prose
  (Gemma especially), so "$
ightarrow$" reads as an arrow instead of TeX
  source. The renderer is ~150 lines, zero-dependency, and builds DOM
  nodes only - model output never passes through innerHTML, so markup in a
  reply stays literal text. Streaming messages stay plain text and are
  re-rendered on completion; thinking stays plain inside its fold; wide
  tables scroll inside their own container. The parser half is pure and
  unit-tested (tables, fences, lists, LaTeX word boundaries, injection).

- **Roundtables can unload models between turns.** A setup toggle sends
  keep_alive=0 with each turn, so every speaker gets an empty box instead
  of loading beside a still-resident neighbor. Found on a RAM-constrained
  inference VM: gpt-oss:120b needs ~48 GB of system RAM and loads fine
  alone at its full 131k window, but when the previous speaker was still
  resident at its turn the memory estimate was rejected and the turn
  errored. Lowering the seat ctx barely shrinks this model (sliding-window
  KV is nearly free) though it does shift ~4.5 GB of weights from RAM to
  VRAM; the real fix is the guaranteed-empty handoff, at the price of a
  reload per turn. Councils have had the equivalent toggle since day one.

- **Search across saved sessions.** A search box above the session list scans
  titles, transcripts and setup text (prompts, scenarios, overlays,
  templates) - every message by every speaker. Results show the mode, a
  match count, and up to three speaker-attributed snippets with the term
  highlighted; clicking one opens the session, clearing the box restores the
  list. Case-insensitive substring, server-side over your own sessions only,
  and snippets are rendered as text nodes (they contain model output, which
  must never be treated as markup).

- **Council model list reads left-to-right again.** The context window
  display moved to sit directly after each model name; on a widescreen the
  old layout put the full width of the panel between a name and its ctx
  figure, exactly where the eye tracks when sizing a council. Temperature
  and num_ctx inputs stay right-aligned, and rows highlight on hover so the
  remaining gap is bridgeable.

- **Presets can now be corrected and deleted.** Saving under an existing
  name overwrites that preset - so fixing a wrong model choice is: load the
  preset, correct it, save with the same name (which the name prompt
  pre-fills when a preset is selected). A delete button sits next to each
  preset picker. Previously presets were write-once: a same-name save
  silently created a duplicate and nothing could remove one short of
  editing presets.json by hand. Writes are server-first - the new list is
  stored before local state or the picker updates, so a failed write
  changes nothing anywhere.

- **One scroller per view: the wheel now works everywhere between the topbar
  and the gate bar.** A scroll audit (enumerating every scrollable region and
  probing for wheel dead zones per view) found two structural defects behind
  the "scrolling sometimes does nothing" feeling. The roundtable and chat
  headers - title, exports, scenario brief, judge panel - sat OUTSIDE the
  transcript scroller: wheeling over them scrolled nothing, and every pixel
  they grew (an opened brief or judge panel) permanently shrank the
  conversation area instead of scrolling away. Both views now put the header
  inside a single `.transcript-scroll` that owns everything above the pinned
  gate bar, matching the shape council and pipeline already had. The
  sidebar's session list also ran its own nested scroller inside the
  sidebar's - two competing wheel targets a few pixels apart; the sidebar is
  now the only scroller there. Streaming follow-scroll moved to the new
  scroller and council/pipeline card streams now follow-scroll too.
  Remaining intentional inner scrollers: the council model checklist (capped
  at 55vh, chains to the page at its edges) and textareas' native scrolling.

- **Reasoning now streams live instead of reading as a stalled model.**
  Reasoning models arrive in two stream shapes: older templates put
  "<think>" inline in the content (already handled), but modern Ollama and
  DeepSeek-style openai-compat servers send reasoning in a separate
  per-chunk field - which the parser dropped entirely. The symptom: a
  deepseek-r1 or qwen3 turn showed "loading model on remote box" for the
  whole reasoning phase (the first-token signal only fired on content) and
  the reasoning never appeared anywhere. A normalizer in the provider now
  folds the separate field back into the inline "<think>" convention as it
  streams, so one code path drives everything downstream: reasoning streams
  live, folds into the collapsible block on completion, is stripped from
  other participants' context, and closes its tag even when a run is
  cancelled mid-think. Status pills say "reasoning" while the block is
  open, updated per token since cards only re-render on entry events. The
  mock now emits both shapes (mock-sage inline, mock-scribe separate-field
  at a realistic multi-second cadence) so this stays testable without a GPU.

- **Usable on a phone.** Below 760px the sidebar becomes a slide-in drawer
  behind a topbar hamburger (backdrop tap or any selection closes it), form
  controls grow to thumb size, and inputs go to 16px - which is also what
  stops mobile browsers auto-zooming the page every time a smaller field
  takes focus. Layout height uses dvh so the compose bar stays visible as
  Android's URL bar shows and hides. A web manifest plus SVG icon makes
  "Add to Home Screen" install a standalone app-like window - the login
  cookie is shared with the browser, so the installed app is already signed
  in. Desktop is untouched: the drawer CSS lives entirely behind the media
  query.

- **Every commit refreshes `dist/rsconclave.bundle`, a one-file transfer of
  the whole repo.** For deploying to a box with no route back to the dev
  machine's git: copy the bundle, `git clone /path/rsconclave.bundle` the
  first time, overwrite the same file and `git pull` thereafter - transfers
  stay incremental and history arrives intact. A bundle can only carry
  committed history, so `data/` (prompts, transcripts, certs, accounts) is
  structurally unable to leak into it, unlike a tar of the working tree.
  The hook lives in tracked `tools/hooks/` (`.git/hooks` dies with the
  clone); run `tools/install-hooks.sh` once per clone to wire it up, and a
  failed bundle warns without ever blocking the commit.

- **New Chat starts with your message, not an empty transcript.** The setup
  form now leads with a Message box (Enter starts the chat, Shift+Enter
  newlines), and Start Chat opens the transcript with the reply already
  streaming. Previously Start Chat opened an empty window with a second
  compose box, and the system prompt textarea sat where a message field
  belongs - so first messages kept landing in the system prompt and the
  "empty window after starting" read as a bug. Persona and system prompt now
  fold into a collapsed details block like every other optional dialog.

- **Roundtable participants no longer need names.** An unnamed seat takes its
  model's display name ("Human" for a human seat), so "add participant, pick
  model, start" is a complete setup. Duplicates get a numeric suffix because
  names are how the transcript and the models themselves tell speakers apart.
  The placeholder text stays as the nudge; typing a name still wins.

- **Custom model display names.** Each endpoint row in Settings gains a
  "Model names" editor: give any discovered model an alias ("Alibaba
  qwen3-coder", "OpenAI gpt-oss 20b") and every picker shows it and sorts by
  it - vendor grouping and preferred ordering fall out of naming alone.
  Aliases are cosmetic: sessions, exports and API calls keep the real model
  id (shown in the picker tooltip), so renaming never breaks history.

- **Multi-user accounts with fully separated histories.** Every data route now
  requires a signed-in user. Sessions, personas and presets move to
  `data/users/<name>/` - one account can never list, read, export or resume
  another's transcripts, and live token streams over SSE are delivered only to
  the run's owner. The single-active-run rule stays (it is a hardware fact -
  the box holds one model), so the run carries an owner: other users see a
  bare "box busy" flag, never whose run or a word of its content. The auth
  module is ported from LaunchCanvas: scrypt hashes, hashed opaque session
  tokens in HttpOnly SameSite=Lax cookies, a dummy-hash timing pad so unknown
  usernames cost the same as wrong passwords, and per-IP login lockout (5
  failures, one minute). Storage is JSON instead of SQLite so the app stays
  zero-dependency. First visitor claims the instance on a setup page, or set
  `ADMIN_PASSWORD` to pre-claim it; whoever claims it adopts all pre-auth
  data, moved (not copied) into their account. Usernames are stricter than
  LaunchCanvas's rule because they become directory names: a leading dot is
  rejected, so `..` cannot be an account. Accounts are managed in Settings
  (no roles; you cannot delete yourself or the last user; deleting an account
  revokes its logins but leaves its data on disk). Lost every password:
  delete `data/users.json` and `data/authsessions.json` - transcripts
  survive, accounts reset.

- **The container healthcheck moved to `/api/health`.** `/api/state` now
  requires a login, and a healthcheck that cannot authenticate would mark a
  perfectly working container unhealthy and restart it in a loop - the
  "degraded-but-working app gets restarted forever" failure the conventions
  warn about. `/api/health` answers without a session and reports nothing
  but liveness.

- **Clone any session into a new pre-filled setup.** Every session header gains
  "Clone to new", which opens a blank setup form for that mode already filled
  in from the session's stored config: participants with their models, personas,
  overlays, temperatures and per-seat `num_ctx`; council members including
  duplicated ones; pipeline stages and their templates; the original prompt or
  scenario. Previously, realising after starting an eight-participant roundtable
  that one model or one line of the scenario was wrong meant rebuilding it by
  hand, since presets only help if you thought to save one first. The setup
  forms already knew how to load a preset, so a session config is fed through
  the same path. The clone re-reads the session from the server rather than
  using the copy the header captured at mount time - re-running consolidation
  on a different engine rewrites the stored config, and a clone taken from the
  stale copy silently reproduced the engine that had just failed. Verified on
  all four modes: a three-participant roundtable round-trips byte for byte.

- **Re-run a council's consolidation on a different engine, not just a
  different template.** The re-consolidate panel now carries endpoint, model
  and `num_ctx` pickers alongside the template. A council with enough members
  can hand the consolidator more transcript than its context window holds, and
  the only fix is a model with a bigger window - re-running the same engine on
  the same input just fails the same way. The switch sticks: the stored config,
  the markdown export, and any later re-run all agree with whatever actually
  produced the synthesis.

- **HTTPS, automatically, when a certificate exists.** `tools/gen-cert.sh
  <hostname-or-ip>` writes a self-signed pair to `data/certs/`, and the server
  detects it at startup and serves HTTPS instead of HTTP. One listener either
  way: no second port, no flag, no separate config. Bring your own PEM by
  dropping it at the same two paths, or point `TLS_CERT` and `TLS_KEY`
  elsewhere. An unreadable certificate logs the ownership fix and falls back to
  HTTP rather than crashlooping, because a permission mistake should not take
  the app down. Verified both ways: HTTP 200 with no cert present, HTTPS 200
  after generating one, and plain HTTP refused on the TLS port.

- **`init: true` in the container, which the TLS work made necessary.** Node as
  PID 1 does not reap processes it did not spawn. The healthcheck now falls
  back to an HTTPS probe, and BusyBox `wget` spawns an `ssl_client` child to do
  it - one orphan per probe, forever. Zombies hold slots against the `nproc`
  limit of the HOST uid the container runs as (1000), so an unattended box
  eventually cannot fork anything as that user, including its own SSH sessions.
  The Canvas Suite hit exactly this and it took a day to bite. tini at PID 1
  costs nothing and Docker ships it.

- **Container logs are capped.** Docker's default json-file driver never
  rotates, so an unattended box fills its disk eventually. 10 MB x 5.

- **Adopted the RS project conventions.** `LICENSE` (Unlicense), a changelog,
  `.gitattributes` forcing LF on shell scripts so a Windows checkout still
  produces scripts the container can run, and `tools/charcheck.js` enforcing
  the no-em-dash rule as a check rather than a habit. The 87 em-dashes already
  in the tree were replaced with " - "; all 50 tests still pass.
