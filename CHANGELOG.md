# Changelog

## Unreleased

**A document library, so the same file stops being re-pulled into every
conversation.** Testing the memory persona meant pasting the same DIGEST.md
into chat after chat - the friction was never attaching it, it was going to
get it. **Documents** in Settings holds named verbatim texts (paste, or load
straight from a file); a **Reference material** fold in the chat and council
setup forms attaches them, showing each document's token cost at the moment of
choosing, because attaching the DIGEST should feel like attaching 21k tokens.
Attached material rides every turn as a fenced block after every other layer,
framed as material to draw on rather than instructions - and it can never leak
into a summary, for the same structural reason a persona's memory cannot: it
is config, not a transcript entry, so {{TRANSCRIPT}} and {{SOURCE}} have
nothing to carry. In a council every member gets the same material (part of
the question, not a difference between seats - answers stay comparable) and
the consolidator gets none of it, since its input is the answers. The fit
markers count attached documents, so a 4k seat goes amber the moment a 5k
document lands on it, and the pipeline's input box gains insert buttons - a
document into stage 1 is the clean route to a persona memory. Deliberately
dumb throughout: not a persona, not a memory, not editable per conversation.
A library entry that drifts per chat stops being a library.

An empty library now says so where the control would be, rather than
rendering nothing. Hiding it entirely was meant to spare you a line that only
said "go to Settings", but it left the one case that mattered indistinguishable
from a stale install: someone who knows the feature exists, cannot find it, and
has no way to tell "you have no documents" from "you have the wrong build". The
chat, council and pipeline setup forms carry a muted line and a button straight
to Settings, matching how personas already behave, and both disappear for good
once a document exists.

**A model added on the box now shows up without a reload.** The model list was
cached for the life of the page, and only two things cleared it: reloading, or
saving Settings - because save() wipes those caches as a side effect. That made
"write your config to disk" the working answer to "I pulled a new model", which
nobody would guess and which nothing in the app said. Pickers now serve the
cached list immediately and refetch behind it, raising an event only when the
list actually changed, so opening any setup form picks up a new model at the
cost of one background request and no waiting - even when a box is off.

There is also a **Refresh** button per endpoint, next to Test. It is the only
thing that drops the cached context info too, which is what changes when a
num_ctx is re-baked on the box rather than when a model is added.

**Model profiles: the same model saved twice with different windows.** A baked
num_ctx is one global answer, but the right window is not global - a model
alone on the card wants everything it can hold, and the same model in a
five-way council wants a fraction so the others stay resident beside it. The
KV cache is allocated up front, not as the conversation grows, so a 128k seat
costs 128k of VRAM to answer "what's 2+2".

Settings > an endpoint > **Models** now has a **＋** beside each model that
saves a variation: its own name, its own context window. Profiles appear in
every picker sorted among the real models, showing their own window rather
than the model's baked default, and in council they arrive as their own
seat - which is the shape the ＋-a-seat button already had.

Resolved at setup and never stored: a session records the real model id and
the real numbers, so deleting a profile cannot strand a transcript and an
exported session stays readable without the config that made it. A seat's own
ctx box still wins, because a profile is a starting point rather than a lock.

**Measure all, so a fleet is one button rather than thirteen.** Context sizing
made you press Measure per model and wait on each, which is why measuring a
whole box meant dropping to the shell script. The panel now runs the list in
sequence, naming the model in progress and scrolling to it, with the per-model
buttons disabled while it works. Sequential is not politeness: the server keeps
one measurement per user and cancels the previous when a new one starts, so
firing them together would kill all but the last. A second press stops the
batch, cancelling the model in flight and leaving the rest untouched - the
models already done keep their results.

**A tokens/sec sparkline on chat and roundtable headers.** A rate that halves
partway through a conversation is the visible symptom of a context window the
card cannot actually hold - as the transcript grows, layers spill to system RAM
and throughput collapses. That is a change you feel long before you would think
to go looking for it, and no single turn's number makes it obvious. Three turns
minimum, because two points have a slope but no shape. Hovering gives the high,
the low, and whether the last few turns are down on the opening ones; a drop of
a third or more turns the line amber and says what usually causes it.

**Token rates now exclude model load time.** `durationMs` is wall clock, so a
cold model charged its load against the first turn: 80 tokens after a 6-second
load reported 12 tok/s for a model generating at 88. Every conversation
therefore looked like it sped up, and a real decline would have been masked by
it. Ollama reports `eval_duration` separately and it is now kept, so elapsed
time stays wall clock - that is the honest answer to "how long did I wait" -
while the RATE is the provider's own. Measured on the same five turns: 16.8,
79.3, 80.7, 79.8, 79.6 by wall clock against a true 88.2, 88.2, 89.2, 89.0,
88.5.

**The recommended num_ctx is now verified by loading at it, not extrapolated
to.** Two probes at 2k and 8k give a straight line, and on real hardware that
line over-promises badly: on a 24 GB 7900XTX it recommended 176128 for
qwen3.6:27b, and loading at that put 58% of the model on the card and 15 t/s on
the clock, against 60 t/s at a window that fits. Ollama picks its layer split
at load time from its own estimate, and `/api/ps` "size" understates what that
reserves once the context is large - neither is visible from the low end of the
curve. The measurement now loads at its own answer and binary-searches down
until the card takes the whole model. For that case the honest number is 77824,
and it spills at 90112. Costs a handful of extra loads; the alternative is a
number that is arithmetically true and three times slower.

**A box running on the CPU is told so instead of being sized.** The ROG Ally X
reports `size_vram` 0 - its 780M is not a GPU Ollama will use - and budgeting
that against a stated VRAM figure invented an answer about hardware doing none
of the work. The cost per token is still reported, because context costs memory
either way, but no window is recommended: the real ceiling is free system RAM,
which nothing reachable over HTTP can see.

**Clone to new on a chat now brings the opening message, its documents and its
output cap.** A council keeps its prompt in the config, so cloning one carries
the question across; a chat's opening message is not a declared config field,
so the clone arrived blank and you retyped the thing you were trying to vary.
It is read off the transcript now, which is the record that is actually kept.
The same omission was quietly dropping attached documents and maxTokens, both
of which the council clone had always restored.

**GB now means what the box on your video card means.** The budget multiplied
your stated VRAM by 1e9 while a "24 GB" card holds 24 GiB, so it under-counted
by 1.8 GB and turned a stated 10% safety margin into a real 16% one nobody had
chosen. Everything now computes and reports in GiB and labels it GB - the same
convention Windows Task Manager uses, which is where anyone checks this. The
safety factor moved to 0.85 so the effective headroom is unchanged: the units
were corrected, not the policy. On a 24 GB card the difference is large,
because it was compounding with people deducting a desktop allowance by hand:
deepseek-r1:32b went from 2k to 8k, qwen3-coder:30b from 8k to 28k, and
gemma4:31b and laguna-xs-2.1 stopped reporting as too big to fit at all.

**A model too big to fit is no longer loaded to discover that.** `/api/tags`
gives the on-disk size, and weights cannot occupy less memory than they occupy
on disk - so a model larger than the whole card is answered in a fraction of a
second instead of several minutes of the box paging itself into the ground.
The threshold is the whole card rather than the safety-reduced budget: this
exists to catch the hopeless, not the tight, and an MoE just over the margin
turned out to load entirely into VRAM.

**"Over budget" and "running in system RAM" stopped being the same message.**
A model whose weights exceed the budget was told it would run partly in system
RAM - while the probe printed directly above it showed every byte resident on
the card. That answer sends someone shopping for a card they already own. The
two cases are now distinguished by what `/api/ps` actually reported.

**Context measurement can be cancelled.** It loads the model twice, so an
ill-judged one used to be unstoppable. Cancel aborts the in-flight load and
unloads whatever reached the card, so the box is not left holding a model
nobody asked for.

**Context sizing moved into the app.** Finding the largest `num_ctx` a model
can actually hold was a POSIX shell script - a fair ask of someone running a
headless Ubuntu GPU host, and an absurd one of someone whose entire setup is
Ollama and this app on one Windows machine, who would have to install Git Bash
before they could begin. **Settings > an Ollama endpoint > Context sizing**
now lists that box's models with a Measure button each: same method, same
arithmetic, no terminal. It loads the model twice, reports what the weights
cost and what a thousand tokens of context cost, and recommends a window -
saying which ceiling bound it, because a VRAM cap is an argument for a bigger
card and a trained-maximum cap is not. **Bake in** then writes it into the
model on the box for every client of that daemon, not just this app, and only
ever the number just displayed.

The budget it sizes against comes from a new **VRAM GB** field on the
endpoint, because an HTTP client cannot see the card the way `nvidia-smi`
can - stated once per box rather than asked for every time. What is free is
then derived from `/api/ps`, which is better than the script when the box is
remote and worse in one specific way: it sees only what Ollama is holding, so
a desktop compositor or a game holding two gigabytes is invisible to it. On a
machine someone is actually using, treat the free figure as optimistic.

**`measure-ctx.sh --apply` no longer needs the ollama CLI.** It shelled out to
`ollama create`, which made the one step that writes something the only step
that could not run from a machine reaching the daemon over the network and
nothing else - the normal arrangement for a headless GPU box driven from a
different host, and precisely the case `--host` exists to serve. It now POSTs
to the daemon's own `/api/create`, falling back to the older request shape for
daemons that predate the rename, so the whole script is HTTP end to end and
needs nothing installed but curl. The printed manual equivalent is a curl
command for the same reason.

**A model named without a tag no longer fails at the finish line.** `/api/ps`
reports fully qualified names, so asking for `gemma3` had it come back as
`gemma3:latest` and an exact match on what was typed found nothing - the run
died with "could not read /api/ps" *after* both slow probe loads had already
happened. Requests still send the name as given, which the daemon resolves
either way; only the matching qualifies it.

**`measure-ctx.sh` no longer sizes a remote model against the local card.**
Every step of that script is HTTP against `--host` - the probes, the trained
maximum, even `--apply`, since a Modelfile whose `FROM` is a model name is
resolved by that daemon out of its own blobs with nothing uploaded. VRAM
detection was the one exception: `nvidia-smi` and `rocm-smi` describe the
machine the script runs on. Pointed at another box it would quietly budget
against the wrong card and print a confident recommendation for hardware it
never looked at, which is worse than refusing. A non-local `--host` now
requires `--vram`, and says so along with the command to read free VRAM off
that box.

**Skip pressed mid-answer no longer stops the whole council.** Skip worked
when it landed while a model was still loading, and behaved exactly like
Cancel when it landed while tokens were flowing - which is when it is usually
pressed. The abort has three different exits inside a turn (the model-info
fetch, a clean stream return, a thrown stream), and only one of them labelled
the entry 'skipped'; the mid-stream exit returns cleanly from the provider
layer and carried a hardcoded 'cancelled' straight to the council loop, which
did what that label told it to and ended the run. All three exits now share
one label. Reproduced and verified against a real inference box, and the
probe that covers both windows plus Cancel now lives in the tree
(dev/probe-skip.mjs) - its predecessor lived outside the repo, died with a
session, and this is what its absence cost.

**Council members can wear a persona, which is what the + button was always
for.** A member is sent the bare prompt and nothing else, and that is still the
default - it is what makes one member's answer comparable with another's. But
it meant the only way a duplicated row could differ from its original was
temperature, and there was no way at all to put two standing instructions
against each other on the same question. Now each row has a persona picker in
front of its temperature, so the same model can sit twice under two different
prompts and be judged side by side by the consolidator. The persona brings its
memories with it, layered exactly as in chat and roundtable, and the prompt
size check counts them against that seat's window.

**Roundtable and pipeline rows stopped pushing their last control past the
border.** Both grids were declared a column short of the number of controls in
the row, so "max out" was dealt the 30px slot meant for the remove button and
hung outside the row, while the button itself wrapped onto a line of its own.
It had been that way since max out was added and the templates were not grown
to match. The seat-fit warning added last week was landing in the 32px colour
column too, with its message running off the side; it now spans the row.

**A persona stopped remembering facts and started remembering the act of
summarising.** Told to record only what was new and to "say so in one line" if
nothing was, a summariser wrote "no new information was shared" - and that got
saved as a memory. The next summariser then found, at the bottom of the
reference block and immediately before the instruction to write a memory, an
example of exactly the shape it was being asked for, and copied it. Four
rounds in, a conversation about sim-racing games produced a summary about
TFTP, word for word the memory from two conversations earlier.

Four changes close the loop. The templates now forbid writing about the
conversation, about the task, or about what was or was not new - a memory is
facts or it is nothing. "Nothing worth remembering" is a **sentinel** the app
recognises and refuses to store, rather than a sentence that becomes one; the
summary shows "nothing to remember" where its Remember button would be. The
already-remembered block is **fenced and labelled reference-only**, so it
reads less like a template to copy. And a summary that is **near-identical to
an existing memory** is refused with the percentage and the date it matches,
offering "Save anyway" - the same failure, caught at the door.

**Personas can be duplicated, memories and all.** For running one remembered
history forward under two different models and watching where they diverge.
The copied entries get fresh ids, so pruning one fork leaves the other alone,
and each keeps the conversation it came from.

**Chat gets presets, like the other three modes always had.** Building a
memory means the same persona, the same model and the same summariser over and
over, and every one of those was a separate pick on a form. A chat preset
saves that combination under a name, alongside the council, roundtable and
pipeline presets - not a new concept, just the one chat was missing. The
summariser is learned from use rather than configured, so the one you ran last
time is the one offered next. Sessions started from a preset record it.

**The sidebar marks a conversation that feeds a memory** with a glyph and the
persona's name, because what is said in one outlives it - and the list was the
one place that gave no hint before you opened it.

**Distilling a document into a memory is its own job, and now has its own
tools.** Building a persona that knows about your projects meant pasting a
write-up into a chat, letting the model reply, and summarising the result -
which put the model's own reaction into the memory. Its clarifying questions
and its "would you like me to..." came back out as though they were facts
about the subject, and compounded with every document added.

Three changes. The summarise fold picks between **Conversation** and
**Reference material**: one is about the exchange, the other about the
subject, and the wrong one writes a memory describing a document being shown
rather than what it said. The reference template reads a new **`{{SOURCE}}`**
placeholder - your turns only, with every model reply left out - so the noise
is structurally absent rather than something the prompt has to argue with,
the same reason a persona's memory is not in its own transcript. And an
edited template is now **saved** when you click away from it: these are the
kind you tune once and want every time, and retyping a distillation prompt
for the eighth document was the real friction. The roundtable judge's
template persists the same way.

**A pipeline's final output can be saved as a memory.** It is the cleanest
route to one there is: a document in, your own template, a distillation out,
and no conversation whose questions end up in the result - and a pipeline
setup saves as a named preset, so the prompt is written once and reused. Only
the last stage; an intermediate output is working material, not the product,
and a chat reply is still a turn rather than a distillation.

**Chat and roundtable get the same sizing the council does.** The council
markers answered "will this paste fit" only where a council was being
assembled - the same paste into a chat, which is where a document more often
lands, still went in blind.

A chat's compose box now projects the turn you are about to send: `next turn:
about 21k of 4k ctx (528%)`, red past the window, with the reason in the
hover. The status meter already reported this, one turn too late - it measures
what was sent, so pasting a document into an 85%-full conversation showed 140%
afterwards, by which point the oldest turns were already gone. Quiet for an
ordinary message: a one-line reply needs no commentary. The chat setup form
marks its first message against the model picked for it, exactly as the
council checklist does.

A roundtable seat is marked against its **standing cost** - the framing, the
persona, that persona's memories, the seat overlay and the scenario - which it
pays on every turn before a word of conversation exists, and which nothing
reported until the first turn ran. The scenario says what it costs, and that
it is charged to every seat on every turn.

**A council says whether the prompt fits before you run it.** Pasting a long
document into a council was a guess: the model list showed each seat's window,
but nothing said how big the prompt was, so the only way to find out was to
send it to a model with a known-large window, read the context meter
afterwards, and work backwards - a whole run spent answering a question the
app could answer while you type. The prompt box now carries a live estimate
("about 21k tokens"), and any seat that cannot take it is marked. Two markers,
because there are two different problems: amber **needs ~22k** means the
window is too small as set and a bigger `num_ctx` on that row fixes it, red
**over its 8k limit** means the prompt exceeds what the model was trained for
and no setting will help. The amber hover adds the part that is easy to miss -
raising a seat past its Modelfile default is where it can stop fitting in VRAM
and start spilling into system RAM. **Fit this prompt** does the arithmetic
for every checked seat at once, capped at each model's trained maximum, and
names the ones it could not help. Seats already big enough are left alone,
since their number may have been measured rather than guessed.

The consolidator is marked too, on a projection, because it is the seat most
likely to overflow and the only one whose real input cannot be known in
advance - it reads the prompt plus every answer, and the answers do not exist
yet. The hover states the assumption it is built on rather than presenting a
confident number. All of it is an estimate at four characters per token, which
runs low on exactly the text most worth checking, so every figure is phrased
as "about" and the markers leave room for a reply on top.

**Personas can remember.** A persona was a system prompt and nothing more:
every chat with it started from zero, and the only way to carry anything
across was to paste it into the prompt by hand. A chat now has a **Summarise**
fold - the roundtable's judge pointed at a conversation - whose output can be
saved to a persona with **Remember**. From then on that persona's memories go
into every chat and every roundtable seat that wears it, after its own prompt
and framed as things it remembers rather than as instructions; the System
prompt fold on a session shows exactly what went out. The summariser is shown
what the persona already remembers and asked to write only what is new, so a
long-running relationship does not converge on the same five bullets, and it
can never see the memory inside the transcript, because the system prompt is
not a transcript entry. Nothing is remembered without a click on the text that
becomes the memory. Settings lists every memory with its date, author model
and source conversation, editable and deletable, with a rough count of the
tokens they add to each turn. **Compact** rewrites a long list as one entry,
as a session you read before choosing to replace the list - summaries of
summaries lose resolution, and that is a decision, not a policy. Any
consolidation can become a memory: a council's synthesis or a roundtable
verdict as readily as a chat summary. Deliberately a dated list and not a
database - small enough to read, and reading it is the point.

Refined after first real use: saving spells out its two outcomes as verbs,
**Append** or **Erase & replace**, because a checkbox called "replace
existing" read as ambiguous between them and the wrong guess is destructive.
The bottom bar gains a **Summarise ↑** button that opens the panel at the top,
so a long conversation does not mean scrolling all the way up to distil it.
The markdown export now carries the full system prompt - persona, memory and
session layers - marked as rendered at export time, since memories evolve;
before, a transcript showed a model that plainly knew things with no trace of
how it knew them. And the summariser's default template now says a remembered
fact the assistant echoed back is not new, after a real second-session summary
re-recorded the first memory's open threads by way of the model repeating
them.

**Saving personas answers at the button.** Save popped an alert and then left
the page looking exactly as it had before - which, right after creating a
persona, reads as "did that take?". The button itself now flips to "Saved ✓"
for a moment instead.

**A turn that stopped short says so on screen, not just to the consolidator.**
A council member that hit its output cap or died mid-stream took the same green
"done" pill as one that answered in full. The transcript handed to the
consolidator carried the marker; the person reading the screen got nothing, so
the only way to find out a model had stopped early was to count tokens or go
digging in the server's logs. Those turns now show an amber **incomplete** pill
with the token count beside it, and hovering says which ending it was - a
dropped stream reads differently from a budget that ran out, and the difference
is the whole diagnosis. Councils, pipelines and roundtables; chat already offered
Continue, which said the same thing. It matters most in a roundtable, where
a half-finished turn is what the NEXT seat answers.

**A model that hit its output cap was described to the consolidator as
finished.** The label needed both an error and a truncation flag, and hitting
the cap sets only the flag, because nothing went wrong - the model just ran out
of budget. That is the commonest way a turn ends unfinished, and it was the one
case that went unmarked, so the consolidator weighed half an answer as a whole
one. Truncation alone is now enough. Cancelled turns keep their own wording.

**measure-ctx.sh sizes against free VRAM, not the sticker on the card.** It
budgeted against the card's total capacity, which is the right number only on
an idle box - and in a council it routinely is not, because each model stays
resident for its keep-alive after its turn. So the measurement promised a
window that had room, the third model to load found several GB already gone,
and a `num_ctx` that ran fully on the GPU in testing quietly spilled to system
RAM in use: same setting, a fraction of the speed, and nothing on screen
saying so. It now reads what is actually free, names whatever else is holding
the card so a small budget explains itself, and refuses rather than guessing
when there is under a gigabyte left. The model being measured is unloaded
first, so its own footprint never counts against its own budget. Sizing for an
idle card is still available as `--assume-empty`, and the report always states
which basis it used rather than implying it measured a number that was
supplied or assumed. Also fixes the AMD path, which read the VRAM columns by
position and could land on "used" where it meant "total" - it now finds them
by header name, since the order has moved between rocm-smi versions.

**One slow model no longer costs you the whole council.** Cancel was the only
way out of a member that was crawling, and it ends the run - so abandoning the
third of five seats threw away the two answers already collected, recoverable
only by copying them into a consolidator by hand. Councils now have **Skip**
next to Cancel while a member is generating: it drops that member, moves to
the next one, keeps everything already answered, and still consolidates at the
end. The skipped seat is reported to the consolidator as `(skipped)` rather
than as its half-finished text, because skip means you did not want that
opinion counted. Cancel is unchanged and still stops everything. Council only
- a roundtable turn feeds the next speaker and a pipeline stage feeds the next
stage, so there is nothing to carry on to.

**A stream that dies mid-answer says so.** Every ordinary ending - finished,
hit the token cap, hit a stop sequence - arrives as a final frame from the
provider. A connection that closes mid-generation instead (an OOM-killed
runner, a box that went away) produced an entry that looked finished: real
text, no error, no marker, and a missing token count as the only clue. That is
exactly what "the model just stopped mid-sentence" looks like from the
outside. Such a turn is now marked like a cancelled one - text kept, flagged
incomplete, Continue offered, and labelled for any consolidator reading the
transcript. Distinct from an abruptly destroyed socket, which already
surfaced as an error.

**Model pickers show what a model actually is.** /api/show carries the whole
`ollama show` output - the CLI has no privileged access, it is a client of the
same endpoint - and all of it but two context numbers was being read and
discarded. Quantization now rides in the option text (`- 256k ctx Q4_K_M`),
and hovering any model gives the rest: parameter size, whether num_ctx is set
in the Modelfile or defaulted, the trained maximum, capabilities, and any
Modelfile parameters. It answers the question that sends you to a terminal -
"is this model set up sensibly, and is it quantized hard enough to explain
that?" - without leaving the picker. An unset temperature stays absent rather
than being reported as zero, because Ollama omits it and its own default
applies.

**A re-baked model shows its new context without a server restart.** The
context info from /api/show was cached forever, so after measure-ctx.sh
--apply changed a model's num_ctx on the box, the app kept showing the
pre-bake default - and deleting and re-adding the endpoint did not help,
because the cache is keyed by base URL and model name, which a re-add does
not change. The cache now expires after five minutes, and saving endpoints
in Settings clears it immediately, so the re-add instinct works.

**measure-ctx.sh no longer recommends more context than the model was
trained for.** A sliding-window model costs almost nothing per token, and
extrapolating that slope produced - and with --apply, BAKED - a num_ctx of
1.2 million into a model trained for far less. The old behaviour printed a
warning next to the number and applied it anyway. The trained maximum now
comes from /api/show and caps both the recommendation and the bake; the
report says which ceiling won. Token counts also carry their human name
("131072  (128k)") - a missing digit hides in plain sight, which is how a
1.2M recommendation got waved through as hundred-k-ish.

**The login card leads with the mark.** It carried the app name in plain text,
which reads as a placeholder next to the rest of the suite - every sibling app
opens its login with the icon beside the name. The favicon already on every
page now sits in the card header too.

**Resume lives at the bottom too.** A stopped long chat reopens scrolled to
the end, where the fixed bottom bar was spending its permanently-visible
position on a note telling you to scroll all the way up and find the Resume
button. The bar now holds the button itself, in chat and roundtable both. This
also settled a contradiction: a finished roundtable's gate bar said "use
Resume to continue it" while the header deliberately hid Resume for status
'done' - directions to a button that did not exist.

**Hide reasoning while it streams.** Live reasoning is scratch work, and some
models are neurotic out loud - debating tone, reminding themselves what they
are, second-guessing an answer they already finished. A "hide reasoning"
toggle in the status strip shows only the prose while a model streams;
everything else is untouched. The tokens still arrive, the reasoning pill
still says reasoning, and the completed message still snaps to markdown with
the full expandable fold - what you skip is only the live spectacle. Flipping
it mid-stream applies at once, in both directions, and the choice persists.

**The tab title says what the run is doing, and nothing else.** A turn on your
own hardware can take a minute, so tabbing away is normal - and the tab said
"RSConclave" whether a model was mid-thought or had finished ten minutes ago.
It now shows `● RSConclave` while generating and `(1) RSConclave` when
something is waiting on you: a run that finished while you were elsewhere, or a
roundtable gate. Coming back clears it. The marker leads because tabs truncate
from the right.

Nothing from the conversation goes up there. A first cut included the session
title and the speaking model, which read well in a wide tab and was wrong
regardless: a tab title turns up in screenshots, screen shares, the alt-tab
switcher and browser history. Chat rests in the same waiting phase as a gated
roundtable and is excluded from the badge - a marker that is always on says
nothing. No Notification API and no permission prompt.

**Copy buttons on the text you started with.** The prompt, the input, the
scenario, your own chat messages - the strings most worth reusing were the ones
with no way to get them out short of the JSON view or selecting by hand. Your
own turns were deliberately skipped on the theory that you wrote them so you
have them, which misses the point: copying a prompt is how you send it
somewhere ELSE, and fork and clone both keep the original model. The roundtable
scenario was the worst of them - it is config rather than a transcript entry,
so it appeared in no bubble at all.

**A finished session can be deleted.** Holding the active slot was treated as
being active, so any run that had ENDED still refused deletion with "stop it
first" - advice nobody could take, because there was nothing running and the
UI correctly showed no Stop button. The only way out was starting another
session purely to evict the old one. Deletion is now refused only while a
generation is genuinely in flight, and says so; anything finished, errored or
parked mid-roundtable gives up the slot and goes.

**Clear sessions in bulk.** Select in the sidebar, tick what you want gone (or
"all", which means everything currently listed - a tag filter still applies, so
select-all never reaches past what you can see), and delete in one request
rather than one confirm per session. The live run is skipped rather than
failing the batch, and says so.

**Council consolidation is optional.** Sometimes a spread of separate answers
is the output and comparing them adds nothing - and the consolidation is an
extra call on the largest context of the run. Untick "consolidate the answers"
and the council ends at the members. The consolidator is still recorded either
way, so the Consolidate button in the session view can still synthesise
afterwards if you change your mind.

**A model that only thought is no longer presented as having answered.** Give a
reasoning model a small output cap and it can spend the whole budget inside
`<think>`, close the tag, and stop with no prose at all. The entry is then
hundreds of characters long, so the check for "did this member say anything"
passed on the raw text - and the consolidator was handed a labelled response
block containing nothing, which it dutifully summarised. Emptiness is now
judged on the answer, the same way every other check in the codebase already
judged it. Found by running a real council against local reasoning models.

**Every seat gets a `max out` cap, and `ctx` stops appearing where it does
nothing.** `maxTokens` was already in the params type and already honoured by
both providers - Ollama as num_predict, openai-compat as max_tokens - but
nothing in the UI ever set it, so a seat's answer had no ceiling but the
server's own default. `num_ctx` is the mirror image: an Ollama option that does
nothing for an openai-compatible server, whose input nevertheless rendered on
every seat with a tooltip explaining about VRAM. It now shows only for Ollama
seats. Both apply across chat, council members, the consolidator, roundtable
seats, the judge, and pipeline stages.

**Changing your password now asks for it twice.** A change signs out every
other session, so a typo locked you out of a password you never knowingly
chose - and you found out at the next sign in, not while you were still
sitting in Settings with a working session. First-run setup already confirmed
and this did not, which had it backwards: setup is the recoverable one.

**Roundtable setup shows what each seat is actually told.** A council member is
sent your prompt and nothing else - no system prompt at all, which is the
point: independent answers have to be uncontaminated by knowing others exist.
A roundtable seat is the opposite. It is given framing it never asked for - who
it is, who else is present, how other turns are labelled, and not to write
anyone else's lines - and that framing is what keeps the seats from blurring
into one voice. It stays non-configurable for that reason, but "What each seat
is told" in the setup band now shows the assembled prompt verbatim, layer by
layer, for every model seat. The panel calls the same function the engine calls
and refetches on every open, because a disclosure that drifts from what is
really sent is worse than none: it gets believed.

**The context meter stops blaming Ollama for other servers.** Any endpoint
without a readable window was measured against Ollama's 4096-token default,
and an openai-compatible server exposes no /api/show - so a llama.cpp box
running 32k reported an ordinary conversation as overflowing, and warned that
Ollama was silently truncating it. An unknown window is now unknown and the
meter stays out of the way; the Ollama-specific warning only appears for Ollama.

**A cancelled pipeline is no longer filed as a finished one.** Pressing Cancel
mid-stage broke out of the stage loop without recording that the break was a
cancel, so the sidebar showed a run the user had stopped as though it had
completed. Councils were fixed for this once already; pipelines were missed.

**A re-run no longer rewrites how a session ended.** Re-running one council
member, or redoing a consolidation, stamped the session 'done' whatever it had
been - so reopening a council you had STOPPED and re-running a member quietly
promoted it to completed. Reopening a session marks it active, so the prior
status is now remembered across the reopen. Relatedly, a session left 'active'
on disk by a process that exited mid-run no longer shows as active in the
sidebar after a restart, when nothing is running at all.

**A failed Continue no longer condemns the reply it was extending.** A failure
part-way through a continuation turned the whole entry into an error card,
restyling an answer the user had already read as a failure. The reply stays
what it is, marked incomplete - exactly where a cancelled continuation leaves
it - and continuing again clears the marker.

**The Windows launcher checks Node's minor version**, not just the major. Type
stripping landed in 22.18, so 22.0 through 22.17 passed the check and then
failed at the first import with a syntax error nobody could act on.

Found while reviewing RSOperator, a fork of this app, and ported back;
`dev/probe-runcontrol.mjs` gains two experiments covering the cancel and re-run
bookkeeping, both of which fail without the fix.

## 0.1.0 - 2026-07-30

First public release. Everything below is the work that got it here, newest
first - it reads as a development log rather than a release note, which is
deliberate: the reasoning behind a decision is the part worth keeping, and most
entries exist because something was wrong in a way worth remembering.

- **Pipeline "Re-run from here" now discards what it said it would.** The button
  has always promised to discard this and later outputs, but the server only
  appended - so after a re-run the view showed two cards for every stage from
  that point on, with nothing marking which was current. Both old and new cards
  kept working "Re-run from here" buttons, exports contained both outputs, and no
  "queued" placeholders appeared during the re-run because the stale entries
  already satisfied the view's done-stages check. Nothing downstream was worth
  keeping in any case: it was derived from the output being replaced. The stage's
  own output and everything after it is now dropped first, and a stale error
  message no longer outlives the attempt that produced it.

- **A slow first token no longer aborts the run at 120 seconds.** The idle timer
  raced every read including the first, and a server that sends response headers
  before it starts generating - llama.cpp's SSE does - spends the model load and
  the prompt processing inside that first read. Loading a 30B from cold disk past
  two minutes is ordinary, so the run died with "no data for 120s" while the UI
  was still truthfully showing "loading model", which is precisely what the
  README said would not happen. The first byte now gets its own 10-minute budget
  and the 120s idle timer starts once bytes are arriving. Verified against a
  stub that holds its first token for 125 seconds. The budget is generous rather
  than absent because the box runs one generation at a time, so an endpoint that
  never answers would otherwise hold that slot until someone pressed Cancel; the
  README says so now.

- **Exports survive an unclosed code fence, and show reasoning instead of hiding
  it.** Entry text went into the document raw, so a single unbalanced ``` in any
  reply swallowed the rest of the export into a code block when rendered, and
  `<think>` blocks were emitted verbatim - which a markdown renderer treats as an
  unknown HTML tag and drops entirely, so the reasoning either vanished or bled
  into the answer with no delimiter. Fences are balanced now and reasoning is
  quoted under a **reasoning** label. Cancelled turns are marked in the export
  too, for the same reason they are marked in the UI. The export had no tests at
  all; it has nine now.

- **Stream reads no longer drop a truncated final character or keep a stray CR.**
  The end-of-stream path never flushed the text decoder, so bytes held back for a
  character that might have continued were silently discarded when the stream
  simply stopped; and the final unterminated line skipped the carriage-return
  strip every other line got.

- **Search snippets stay on the match** when case-folding changes the string's
  length (`İ` lowercases to two code units), which used to slide the snippet off
  the text it was meant to be showing.

- **Every reasoning block folds away, not just the first one.** The pattern was
  anchored at the start of the text and matched once, so a model that interleaves
  thinking with content - which the provider normaliser legitimately produces -
  had its second block rendered as literal `<think>` text in the middle of the
  answer. Folds now sit where the thinking actually happened instead of being
  hoisted to the top. Your own messages are left alone: searching them for
  `<think>` anywhere would have hidden part of any message that merely mentions
  the tag, which is a thing people using this app do.

- **Clicking through sessions quickly no longer leaves the view and the sidebar
  disagreeing.** Session opens had no ordering guard (the search box already had
  one), so clicking A then B showed whichever response happened to land last -
  A's transcript under B's highlight until the next click.

- **Repointing an endpoint no longer reports the old box's context windows.**
  Saving endpoints cleared the model list cache but not the context-window
  cache, which was returned unconditionally - so after moving an endpoint from
  one machine to another, every ctx tag kept showing the previous machine's
  numbers until a full reload. Those numbers are exactly what people size
  `num_ctx` from.

- **The two identical-looking ✕ buttons in Settings now say what they do.**
  Deleting an endpoint saves immediately and takes its model aliases with it, so
  it asks first; removing a persona only edits local state until you press Save,
  so its tooltip says so.

- **`remove-entry` events are scoped to their session.** The handler matched on
  entry id alone, so a reroll driven from one tab could strip entries out of a
  different session open in another - reachable because forks used to share
  entry ids with their source. Forks mint fresh ids now; this is the second
  layer.

- **A message that never got a reply is no longer a dead end.** When a turn
  failed before its reply entry existed - which is what happens when a saved
  session's endpoint has since been deleted in Settings - the transcript ended
  on the question and there was nothing to do about it. Regenerate refused
  ("nothing to regenerate") on a first message, and on a later one it walked
  back PAST the unanswered question to the previous reply, so it destroyed what
  had just been typed and re-answered the message before it. Now an unanswered
  message is simply answered, and the compose bar offers "Retry" for it instead
  of leaving retyping - into a doubled user turn - as the only way on.

- **Rerolling your own typed turn hands the text back instead of eating it.**
  Reroll walks back to the last participant entry, and a human seat's turn is
  one - but the loop it then started stops immediately when the next speaker is
  a person. So pressing Reroll after typing your own turn deleted what you wrote
  and did nothing at all. The text now returns to the speak box with the gate
  pointed at that seat.

- **The "box is busy" prompt no longer offers to stop a run it cannot.** The
  offer to stop-and-continue appeared for another user's generation too, and
  confirming it produced a raw "running another user's session" alert. The two
  situations now read differently, and the takeover is only offered for a run
  you own.

- **Login rate limiting now constrains concurrent attackers, not just patient
  ones.** The check ran up front but the counter only incremented after the body
  read and the awaited scrypt, so sixty simultaneous attempts all passed the
  check before any of them recorded a failure: sixty passwords tried, zero 429s,
  and the guess rate scaled with the attacker's socket count. Counting at the
  start of the attempt closes it - sixty concurrent attempts now give five 401s
  and fifty-five 429s. A correct password still clears the counter, so mistyping
  twice and then getting it right costs nothing.

- **The public routes no longer buffer 10 MB before looking at it.** One cap
  covered everything, including unauthenticated login and setup, each of which
  then handed the result to scrypt - a couple of hundred concurrent requests
  meant gigabytes held and every other filesystem and crypto job queued behind
  the scrypt runs. Credentials get 4 KB, most routes 1 MB, session import (the
  one route that carries a real document) keeps 10 MB. An oversize body is
  refused on its declared `content-length` before a byte is read, and a chunked
  body that keeps streaming after its 413 is now hung up on instead of drained
  forever.

- **Assorted hardening from the same review.** A bogus-token logout rewrote
  `authsessions.json` every time, because `delete` returns true for a key that
  was never there. The login timing pad was built lazily, so the first
  unknown-user login after each restart paid two scrypt runs instead of one -
  a measurable "no such user" exactly where the pad exists to hide it. Cookie
  `Max-Age` was fixed at login while the server slid the session's expiry, so
  someone using the app daily was bounced to the login page on day 30 with a
  valid session; the cookie is re-issued on each authenticated request.
  `/events` had no connection cap, and every token of every run iterates the
  client set. `PUT /api/presets` stored whatever it was given, so `null` broke
  that account's preset UI on every load. The login form had no in-flight guard
  (two quick Enters ran setup twice) and its focus ternary picked the same field
  either way.

- **Bad requests answer 400/404/409 instead of 500.** "Pick an endpoint and
  model", "that username already exists" and "session not found" all came back
  as 500, which says the server is broken and retrying might help - so a typo in
  a request looked identical to a real fault, in the browser and in the logs.
  Everything the engine and auth reject for bad input now carries the class of
  the failure: 400 for malformed input, 404 for something missing, 409 for the
  wrong state (the box is busy, a generation is already running). Anything else
  still returns 500, deliberately - mapping unknown throws to 400 would hide
  genuine bugs.

  Two of those 500s were real crashes rather than mislabelled rejections:
  `inject` with a JSON number for `text` reached `.trim` and threw TypeError
  (optional chaining guards null, not a number), and a non-numeric
  `stageIndex` became NaN, which compares false against every bound and was
  handed to the engine as a stage index. Both are validated at the boundary now.

- **"Partial output kept" now means one thing everywhere.** A cancelled reply
  was context in the roundtable and in the council's consolidator but not in
  chat, council follow-ups or a pipeline stage, while the badge said the same
  words in all of them. The rule was written out separately in six places and
  three of them disagreed - the council disagreed with itself, feeding a
  fragment to the consolidator that its own follow-up rounds withheld.

  One predicate now answers for all six. A cancelled generation is a fragment,
  often mid-sentence, so it is never handed over as a finished turn: it is out
  of every conversational history. The two places that render a LABELLED
  transcript - the council's `{{RESPONSES}}` block and the judge transcript -
  include it marked `(INCOMPLETE - CANCELLED PART-WAY)` instead, because the
  format can say what it is and reporting "no response" would contradict the
  text on screen. The badge tooltip now says the partial is kept to read, copy
  or continue and is not sent as context.

  `continue` is the way back: it works on a cancelled reply now, not just one
  that hit its token limit, and finishing it clears the marker so the reply
  counts as context again. Verified against a recording endpoint - a completed
  turn still reaches the next speaker, the fragment does not, `continue` does
  receive the partial it is asked to extend, and cancelling the continuation
  leaves the entry marked.

- **A dropped connection no longer throws you into the live run and eats what
  you were typing.** Two review findings that turn out to be the same moment.
  Every SSE connect delivers a state snapshot, and the handler remounted the
  active run's view unconditionally - so a silent EventSource reconnect after a
  network blip, a laptop waking, or a server restart yanked you out of whatever
  session you were reading and into the run. Reproduced: viewing a finished chat
  while a roundtable was live, dropping the stream moved the view to the
  roundtable within one retry. Now the first snapshot still attaches (opening the
  app with a run in progress should take you to it), while later ones only
  refresh the view you already have open.

  The same rebuild was destroying in-progress text. The compose bar, the
  roundtable gate bar and the council follow-up band are rebuilt with
  `replaceChildren` on every state event - and a state event arrives from a
  second tab, from a reconnect, and after every turn - so a half-written
  message, inject or follow-up vanished, and an Auto count you had set to 20
  reset itself to 5. Those fields now keep their text in a registry keyed per
  field and per session, so the rebuild is free to throw the DOM away and a
  draft written to one chat cannot surface in another. They are cleared on a
  successful submit rather than on rebuild, and restored if the submit fails.

  Focus and caret are restored too, which matters as much as the text: the
  rebuild detaches the node you are typing in and focus falls to `<body>`, so
  keeping the text without the focus just means the next dozen keystrokes go
  nowhere - harder to notice than losing the text outright. Verified with real
  clicks and keystrokes: text, caret position and focus all survive, continued
  typing lands in the right place, and a field you deliberately clicked away
  from does not steal the focus back.

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
