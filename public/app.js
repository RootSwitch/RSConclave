// App shell: global state, SSE client with reconnect, view switching, session list.
'use strict';

/* ---------- tiny DOM helpers (used by all views) ---------- */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

/**
 * Render entry text with <think> blocks collapsed. Only used for COMPLETED
 * entries - streaming entries stay plain text so token appends keep working.
 */
function renderEntryText(container, text, entryKind) {
  container.replaceChildren();
  container.classList.remove('md');
  /*
   * A person's own words are never reasoning output, and searching them for
   * "<think>" anywhere would fold away part of a message that merely mentions
   * the tag - which people using this app have every reason to do.
   */
  if (entryKind === 'user') {
    mdRender(container, text);
    return;
  }
  /*
   * EVERY think block, in place.
   *
   * The old pattern was anchored at the start and matched once, so a model that
   * interleaves reasoning with content - which the provider normaliser
   * legitimately produces - had its second block rendered as literal "<think>"
   * text in the transcript. Safe (it is a text node) but it dumps reasoning into
   * the middle of the answer with no delimiter.
   *
   * Walking the string keeps document order, so a fold sits where its thinking
   * actually happened rather than being hoisted to the top.
   */
  const re = /<think>([\s\S]*?)(?:<\/think>|$)/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(last, m.index);
    if (before.trim()) parts.push({ prose: before });
    if (m[1].trim()) parts.push({ think: m[1] });
    last = m.index + m[0].length;
    if (m[0].length === 0) break; // defensive: never spin on a zero-width match
  }
  if (!parts.length && last === 0) {
    // No thinking at all, which is the common case - render the whole thing.
    mdRender(container, text);
    return;
  }
  const tail = text.slice(last);
  if (tail.trim()) parts.push({ prose: tail });
  for (const p of parts) {
    if (p.think !== undefined) {
      container.append(
        el('details', { class: 'think' },
          el('summary', {}, 'thinking…'),
          el('div', { class: 'think-body' }, p.think.trim())),
      );
    } else {
      // Thinking stays plain inside its fold - it is scratch work, not a
      // document - so only prose goes through the markdown renderer.
      const block = el('div', {});
      mdRender(block, p.prose.trim());
      container.append(block);
    }
  }
}

/*
 * What a streaming entry shows while "hide reasoning" is on: the prose, with
 * every <think> block - closed or still open - removed.
 *
 * Live reasoning is scratch work, and some models are neurotic out loud:
 * debating tone, reminding themselves what they are, second-guessing a
 * finished answer. Watching that in real time is distracting at best. This is
 * DISPLAY-ONLY - every token still lands in the entry, and the completed card
 * still carries the full fold - so hiding costs nothing but the spectacle.
 *
 * The trailing-fragment trim stops a half-arrived "<thi" from flashing as
 * literal text for one token before the rest of the tag lands.
 */
function visibleDuringStream(text) {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const open = closed.indexOf('<think>');
  let visible = open === -1 ? closed : closed.slice(0, open);
  const lt = visible.lastIndexOf('<');
  if (lt !== -1 && lt >= visible.length - 7 && '<think>'.startsWith(visible.slice(lt))) {
    visible = visible.slice(0, lt);
  }
  return visible.replace(/^\s+/, '');
}

/**
 * Is this entry finished?
 *
 * NOT "does it have stats": only a model turn ever gets stats, so human turns,
 * narrator injections and every entry of an imported session (import strips
 * stats) looked like they were still streaming - forever. That cost them their
 * copy and fork buttons, left a live "streaming" pill on a paused session, and
 * kept their text rendering as plain text instead of markdown.
 *
 * An entry is in flight only while it is the one the engine is currently
 * writing, so anything that is not the live speaker is done by definition.
 */
function entryComplete(entry, isStreamingNow = false) {
  if (entry.kind === 'error' || entry.error) return true;
  if (entry.stats?.durationMs !== undefined) return true;
  return !isStreamingNow;
}

function statsLine(stats) {
  if (!stats || stats.durationMs === undefined) return '';
  const secs = stats.durationMs / 1000;
  let s = `${stats.evalCount ?? '?'} tok · ${secs.toFixed(1)}s`;
  if (stats.evalCount && secs > 0) s += ` · ${(stats.evalCount / secs).toFixed(1)} tok/s`;
  return s;
}

/** 4096 → "4k", 262144 → "256k", 1200 → "1.2k" */
function fmtK(n) {
  if (n === null || n === undefined) return '?';
  if (n < 1000) return String(n);
  const k = n / 1024;
  return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + 'k';
}

/** "4k / 128k max" - configured window vs trained max; null numCtx = server default. */
function ctxLabel(info) {
  if (!info || (info.contextLength === null && info.numCtx === null)) return '';
  const window = info.numCtx ?? 4096;
  const dflt = info.numCtx === null ? '(default) ' : '';
  return `ctx ${fmtK(window)} ${dflt}/ ${fmtK(info.contextLength)} max`;
}

/** The endpoint record behind an id, or undefined once it has been deleted. */
function endpointOf(endpointId) {
  return App.config.endpoints.find((e) => e.id === endpointId);
}

/** Build a GenParams object from optional temp/ctx/max-out values; undefined if all blank. */
function genParams(tempValue, ctxValue, maxTokensValue) {
  const p = {};
  const t = parseFloat(tempValue);
  if (Number.isFinite(t)) p.temperature = t;
  const c = parseInt(ctxValue, 10);
  if (Number.isFinite(c) && c > 0) p.num_ctx = c;
  const m = parseInt(maxTokensValue, 10);
  if (Number.isFinite(m) && m > 0) p.maxTokens = m;
  return Object.keys(p).length ? p : undefined;
}

/*
 * A ceiling on how much this seat may generate. Every provider honours it -
 * Ollama as num_predict, the rest as max_tokens - but the reason it is worth
 * typing differs: on your own box a rambling model costs you time, on a
 * metered API it costs money, and a council seat with no ceiling is an open
 * tab. Blank means the provider's own default.
 */
function maxTokensInput(value) {
  const input = el('input', { type: 'number', step: '256', min: '1', placeholder: 'max out',
    title: 'Maximum tokens this seat may generate in one turn. Blank = the server default, '
      + 'which is usually what you want here.\n\n'
      + 'Everything this app talks to is your own hardware, so a long answer costs you seconds - '
      + 'while a cap set too low can silence a model completely. The cap covers REASONING: these '
      + 'models routinely spend 90% of a turn thinking, by an amount that varies several-fold '
      + 'between runs of the same prompt, so a number that worked yesterday can produce an empty '
      + 'answer today. Set it only when you deliberately want turns cut short.' });
  if (value !== undefined && value !== null) input.value = value;
  return input;
}

/*
 * Show a control only for Ollama endpoints.
 *
 * num_ctx is an Ollama option and does nothing anywhere else, but the input
 * rendered for every seat regardless - so on an Anthropic or Gemini seat it
 * read as a context control that silently did nothing, tooltip cheerfully
 * explaining about VRAM. Same reasoning as keep_alive and the ON THE BOX
 * panel, which were hidden by kind when cloud endpoints arrived; this one was
 * missed.
 *
 * `source` is either an endpoint <select> (re-checked whenever it changes) or
 * a fixed endpoint id for rows whose endpoint cannot change. `idOf` reads the
 * id out of the select for the pickers that encode "endpointId|model".
 *
 * Returns sync(): call it after the select's options are filled in. Several of
 * these selects are populated asynchronously AFTER the row is built, so the
 * first check runs against an empty value, and filling options programmatically
 * fires no change event to correct it.
 */
function ollamaOnly(node, source, idOf) {
  const read = () => (typeof source === 'string' ? source : idOf ? idOf(source) : source.value);
  const sync = () => node.classList.toggle('hidden', endpointOf(read())?.kind !== 'ollama');
  if (typeof source !== 'string') source.addEventListener('change', sync);
  sync();
  return sync;
}


/** num_ctx input used by every seat/stage row. */
function ctxInput(value) {
  const input = el('input', { type: 'number', step: '1024', min: '512', placeholder: 'ctx',
    title: 'num_ctx - context window in tokens for this seat. Blank = Modelfile / Ollama default. Bigger costs VRAM (KV cache).' });
  if (value !== undefined && value !== null) input.value = value;
  return input;
}

/** Display name for a model: the endpoint's alias when one is set, else the id. */
function modelLabel(endpointId, model) {
  const ep = App.config.endpoints.find((e) => e.id === endpointId);
  return ep?.aliases?.[model] || model;
}

/**
 * Picker-ready [{id, label}] sorted by display name - which is the point of
 * aliases: rename "qwen3-coder:30b" to "Alibaba qwen3-coder" and it files
 * under A, exactly where you will look for it.
 */
function displayModels(endpointId, models) {
  return models
    .map((id) => ({ id, label: modelLabel(endpointId, id) }))
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
}

/** Standard picker option: alias + ctx suffix; the real id in the tooltip. */
function modelOption(endpointId, m) {
  return el('option', {
    value: m.id,
    title: m.label === m.id ? null : m.id,
  }, m.label + ctxSuffix(App.modelInfo(endpointId, m.id)));
}

/** Short select-option suffix: " - 4k ctx" (marks server-default windows with *) */
function ctxSuffix(info) {
  if (!info || (info.contextLength === null && info.numCtx === null)) return '';
  return ` - ${fmtK(info.numCtx ?? 4096)}${info.numCtx === null ? '*' : ''} ctx`;
}

/** Span that shows a model's context info; fills in when /api/show data lands. */
function ctxTag(endpointId, model) {
  const span = el('span', { class: 'ctx-tag', dataset: { ctxFor: `${endpointId}|${model}` },
    title: 'configured window / trained maximum ("default" = Ollama server default, usually 4k)' });
  const info = App.modelInfo(endpointId, model);
  if (info) span.textContent = ctxLabel(info);
  return span;
}

function fillCtxTags() {
  for (const node of document.querySelectorAll('[data-ctx-for]')) {
    const sep = node.dataset.ctxFor.indexOf('|');
    const info = App.modelInfo(node.dataset.ctxFor.slice(0, sep), node.dataset.ctxFor.slice(sep + 1));
    if (info) node.textContent = ctxLabel(info);
  }
}
document.addEventListener('model-info-loaded', fillCtxTags);

/**
 * Status for a card entry as a pill (shape + colour, per the suite's rule that
 * state must survive a colour-blind reader), plus monospace stats when done.
 */
function entryStatus(entry, complete) {
  if (entry.kind === 'error') {
    return [el('span', { class: 'sev crit', title: entry.error || 'error' }, 'error')];
  }
  if (entry.error === 'cancelled') {
    // Says what "kept" means. The old label was just "partial output kept",
    // which read as "kept, so it still counts" - and in half the modes it did
    // and in half it did not. It is kept to read, copy and continue; it is not
    // handed to later turns as though it were a finished answer.
    return [el('span', { class: 'sev warn',
      title: 'Stopped part-way. The partial text is kept here to read, copy or continue, but it is not sent as context to later turns.',
    }, 'cancelled')];
  }
  if (!complete) {
    // An open <think> with no close yet means the model is still reasoning -
    // say so instead of the generic "streaming", which reads as the answer.
    const reasoning = entry.text.includes('<think>') && !entry.text.includes('</think>');
    return [el('span', { class: 'badge busy' }, reasoning ? 'reasoning' : 'streaming')];
  }
  const out = [el('span', { class: 'badge ok' }, 'done')];
  const s = statsLine(entry.stats);
  if (s) out.push(el('span', { class: 'stats' }, s));
  return out;
}

/**
 * Append a freshly saved preset to its picker and select it, so saving is
 * visibly confirmed instead of only showing up after a remount.
 */
function addPresetOption(sel, id, name) {
  if (!sel) return;
  sel.append(el('option', { value: id }, name));
  sel.value = id;
}

/**
 * Save a preset, overwriting any preset of the same name - which is how you
 * FIX one: load it, correct the mistake, save under the same name. Before
 * this, presets were write-once; a wrong model choice was permanent.
 *
 * Server-first on purpose: the new list is PUT before local state or the
 * picker change, so a failed write leaves everything - data and UI - exactly
 * as it was, with no rollback bookkeeping.
 *
 * entryBody is the preset minus id/name (councils and roundtables carry
 * {config}, pipelines carry {stages}).
 */
async function savePresetNamed(listKey, sel, idPrefix, entryBody) {
  const list = App.presets[listKey] ?? [];
  const selected = list.find((p) => p.id === sel?.value);
  const name = (prompt('Preset name (an existing name overwrites that preset):', selected?.name ?? '') ?? '').trim();
  if (!name) return;
  const existing = list.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const entry = existing
    ? { ...existing, ...entryBody, name }
    : { id: idPrefix + Date.now().toString(36), name, ...entryBody };
  const newList = existing ? list.map((p) => (p === existing ? entry : p)) : [...list, entry];
  try {
    await Api.putPresets({ ...App.presets, [listKey]: newList });
  } catch (e) {
    alert(e.message);
    return;
  }
  App.presets[listKey] = newList;
  if (existing) {
    const opt = [...sel.options].find((o) => o.value === entry.id);
    if (opt) opt.textContent = name; // renamed casing follows the save
    sel.value = entry.id;
  } else {
    addPresetOption(sel, entry.id, name);
  }
}

/** Delete button for a preset picker: removes whatever is selected in it. */
function presetDeleteButton(getSel, listKey) {
  return el('button', { class: 'mini danger', title: 'Delete the selected preset', onclick: async () => {
    const sel = getSel();
    const list = App.presets[listKey] ?? [];
    const p = list.find((x) => x.id === sel?.value);
    if (!p) { alert('Pick a preset in the dropdown first.'); return; }
    if (!confirm(`Delete preset "${p.name}"?`)) return;
    const newList = list.filter((x) => x.id !== p.id);
    try {
      await Api.putPresets({ ...App.presets, [listKey]: newList });
    } catch (e) {
      alert(e.message);
      return;
    }
    App.presets[listKey] = newList;
    [...sel.options].find((o) => o.value === p.id)?.remove();
    sel.value = '';
  } }, '✕');
}

/*
 * Enter-key policy, applied everywhere so the same gesture never means two
 * things:
 *   A. single-line <input>  -> Enter runs the nearest action (web-wide form
 *      convention). onEnterSubmit.
 *   B. compose textarea with ONE action -> Enter sends, Shift+Enter makes a
 *      newline (chat convention). onEnterSend.
 *   C. long-form textarea (prompts, scenarios, personas, templates) ->
 *      Enter is always a newline. No handler at all; these are documents.
 * The roundtable inject box is deliberately left on C despite being a
 * compose box: it has two destinations (Narrator and User), so Enter cannot
 * pick one, and guessing wrong is worse than asking for a click.
 */
function onEnterSubmit(inputs, action) {
  for (const input of inputs) {
    if (!input) continue;
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        action();
      }
    });
  }
}

function onEnterSend(textarea, action) {
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      action();
    }
  });
}

/*
 * Which ballot option did this answer land on? Mirrors pickOption() in
 * server/vote.ts, deliberately: the server's copy is what exports and any
 * future API consumer use, and this one lets the tally bars fill in live as
 * each member finishes rather than after a refresh.
 *
 * The word boundaries are the whole trick. Substring matching counts "I would
 * rather not commit" as a vote for "No", and once you notice that you also
 * notice "know", "nothing" and "cannot". Read from the end, because a model
 * thinking out loud names several options before committing to one.
 */
function pickBallotOption(text, options) {
  if (!text || !text.trim()) return null;
  const ranked = [...options].sort((a, b) => b.length - a.length);
  let best = null;
  for (const option of ranked) {
    const trimmed = option.trim();
    if (!trimmed) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lead = /^\w/.test(trimmed) ? '\\b' : '';
    const trail = /\w$/.test(trimmed) ? '\\b' : '';
    const re = new RegExp(lead + escaped + trail, 'gi');
    let at = -1;
    for (const m of text.matchAll(re)) at = m.index;
    if (at === -1) continue;
    if (!best || at > best.at) best = { option, at };
  }
  return best ? best.option : null;
}

/*
 * Resume, wherever it is needed. It began as one button in the session
 * header, which is exactly the wrong place for it: a stopped 8k-token chat
 * reopens scrolled to the bottom, where the fixed bottom bar was spending its
 * permanently-visible position on a note telling you to scroll up and find
 * this button. The bar now holds the button itself; the note was directions
 * to it.
 */
function resumeButton(sessionId) {
  return el('button', { class: 'primary', onclick: async () => {
    try {
      await Api.resumeSession(sessionId);
      await openSession(sessionId);
    } catch (err) { alert(err.message); }
  } }, 'Resume');
}

function copyButton(getText) {
  return el('button', { class: 'mini', title: 'copy text', onclick: (ev) => {
    navigator.clipboard.writeText(getText()).then(() => {
      ev.target.textContent = '✓';
      setTimeout(() => (ev.target.textContent = 'copy'), 1200);
    });
  } }, 'copy');
}

function renameButton(sessionId, getTitle, onRenamed) {
  return el('button', { class: 'mini', title: 'rename session', onclick: async () => {
    const title = prompt('Session title:', getTitle());
    if (!title?.trim()) return;
    try {
      await Api.renameSession(sessionId, title.trim());
      onRenamed(title.trim());
      renderSessionList();
    } catch (err) { alert(err.message); }
  } }, '✎');
}

/**
 * Open a blank setup form for this session's mode, pre-filled from its stored
 * config. Nothing about the original session changes.
 *
 * Without this, realising you want one different model or a slightly reworded
 * scenario after starting an eight-participant roundtable means rebuilding the
 * whole thing by hand, because presets are only useful if you thought to save
 * one first. The setup forms already know how to load a preset, so a session's
 * config is fed through the same path.
 */
async function cloneSession(sessionId) {
  // Re-read rather than trusting the session object the header closed over at
  // mount time. Re-running consolidation on a different engine rewrites the
  // stored config, and a clone taken from the stale copy silently reproduces
  // the engine that already failed.
  const session = await Api.getSession(sessionId);
  const view = viewForSession(session);
  App.session = null;
  if (view === 'council') Council.mount(null);
  else if (view === 'roundtable') Roundtable.mount(null);
  else if (view === 'pipeline') Pipeline.mount(null);
  else if (view === 'chat') Chat.mount(null);
  else throw new Error(`cannot clone a ${session.mode} session`);
  showView(view);
  renderSessionList();

  const target = view === 'council' ? Council
    : view === 'roundtable' ? Roundtable
    : view === 'pipeline' ? Pipeline : Chat;
  await target.applyConfig(session.config);
}

function cloneButton(session) {
  return el('button', {
    title: 'Open a new setup pre-filled from this session, to tweak and re-run',
    onclick: () => cloneSession(session.id).catch((err) => alert(err.message)),
  }, 'Clone to new');
}

/**
 * Branch a session at one entry into a new one.
 *
 * Reroll and "re-run from here" both destroy what was there. Forking keeps both
 * readings, which is what you actually want when a roundtable takes an
 * interesting wrong turn: you want to try the other path without losing this one.
 */
function forkButton(sessionId, entryId) {
  return el('button', {
    class: 'mini',
    title: 'Copy this session up to here into a new one and continue from there',
    onclick: async (ev) => {
      ev.stopPropagation();
      try {
        const { sessionId: forked } = await Api.forkSession(sessionId, entryId);
        await openSession(forked);
        renderSessionList();
      } catch (err) { alert(err.message); }
    },
  }, 'fork');
}

/*
 * Run an action that needs the box, offering to clear it if something else of
 * yours is holding it.
 *
 * Starting anything while a run is parked returns "the box is busy" and, before
 * this, no way forward from the message - you had to know that Stop lived in
 * another view. The confirm is deliberate rather than automatic: stopping is
 * destructive to whatever is mid-flight, so it stays a decision.
 */
/*
 * Drafts that survive a re-render.
 *
 * The compose bar, the roundtable gate bar and the council follow-up band are
 * rebuilt with replaceChildren on EVERY state event - and a state event arrives
 * from a second tab, from an SSE reconnect, and after every turn. So a
 * half-typed message, inject or follow-up was silently destroyed by something
 * the user did not do. Keeping the text in a map keyed per field means the
 * rebuild is free to throw the DOM away.
 *
 * clearDraft is called on a successful submit - not on rebuild - so the box
 * only empties when the text actually went somewhere.
 */
const drafts = new Map();

const draftCarets = new Map();
let draftFocused = null; // key of the field the user was last typing in

/**
 * Wire an input/textarea to a draft key: restores on create, records on input.
 *
 * Restoring the caret and the focus matters as much as restoring the text. A
 * rebuild detaches the node you are typing in, which drops focus to <body> - so
 * keeping the text but not the focus just means the next dozen keystrokes go
 * nowhere, which is harder to notice than losing the text outright.
 */
function keepDraft(key, node) {
  const caretable = !!node.setSelectionRange && node.type !== 'number';
  const saved = drafts.get(key);
  if (saved !== undefined && saved !== '') {
    node.value = saved;
    if (caretable) {
      const at = draftCarets.get(key) ?? node.value.length;
      try { node.setSelectionRange(at, at); } catch {}
    }
  }
  node.addEventListener('input', () => {
    drafts.set(key, node.value);
    if (caretable) draftCarets.set(key, node.selectionStart);
    // Keys carry a session id so a draft cannot surface in the wrong
    // conversation, which means they accumulate as you browse. Map keeps
    // insertion order, so dropping from the front discards the least recently
    // started draft - far more than anyone has open at once.
    while (drafts.size > 24) {
      const oldest = drafts.keys().next().value;
      drafts.delete(oldest);
      draftCarets.delete(oldest);
    }
  });
  node.addEventListener('focus', () => { draftFocused = key; });
  /*
   * Only a user-driven blur means they left the field; a blur caused by the
   * rebuild ripping the node out must NOT clear the flag, or the replacement
   * field will not know to take the focus back.
   *
   * The check is deferred because the two are indistinguishable at blur time -
   * Chrome dispatches blur during removal while the node still reports
   * isConnected true. One turn of the event loop later a removed node is
   * plainly disconnected. setTimeout rather than a microtask so it lands after
   * the replacement's refocus below.
   */
  node.addEventListener('blur', () => {
    setTimeout(() => {
      if (draftFocused === key && node.isConnected) draftFocused = null;
    }, 0);
  });

  if (draftFocused === key) {
    // Deferred because keepDraft runs while the node is still detached, and
    // focus() on a detached node does nothing. The whole render is synchronous,
    // so by the time microtasks run the node is in the document.
    queueMicrotask(() => {
      if (!node.isConnected) return;
      const a = document.activeElement;
      if (a && a !== document.body) return; // they moved on; do not yank them back
      node.focus();
      if (caretable) {
        const at = draftCarets.get(key) ?? node.value.length;
        try { node.setSelectionRange(at, at); } catch {}
      }
    });
  }
  return node;
}

function clearDraft(key) {
  drafts.delete(key);
  draftCarets.delete(key);
  if (draftFocused === key) draftFocused = null;
}

/**
 * Focus without stealing it. A rebuild that unconditionally focused its own box
 * pulled the caret out of whatever the user was actually typing in - including
 * a field in a different panel. If something focusable is still focused, leave
 * it alone; if the old node was just detached, activeElement falls back to body
 * and focusing is the right move.
 */
function focusIfIdle(node) {
  const a = document.activeElement;
  if (!a || a === document.body) node.focus();
}

/*
 * Run an async click handler at most once at a time.
 *
 * The server-side race that let a double Enter start two generations is fixed,
 * but the client should not be sending the second request at all: without this,
 * a double-click on Send / Step / Reroll / Speak / inject either duplicated an
 * entry or produced a "a generation is already running" alert for something the
 * user only meant to do once. Keyed per call site, so two different buttons do
 * not block each other.
 */
const inFlight = new Set();
async function once(key, action) {
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  try {
    return await action();
  } finally {
    inFlight.delete(key);
  }
}

async function withBoxFree(action) {
  try {
    return await action();
  } catch (err) {
    const message = err.message || '';
    /*
     * Only offer the takeover for a run this user owns. The prompt used to fire
     * for ANOTHER user's generation too, promising to stop something the server
     * would refuse - confirming then produced a raw "running another user's
     * session" alert. The server now words those two cases differently.
     */
    if (/another user/i.test(message)) throw err;
    if (!/box is busy|already running/i.test(message)) throw err;
    if (!confirm('The box is busy with your current run.\n\nStop it and continue?')) return undefined;
    await Api.stopRun();
    return await action();
  }
}

/** Comma-separated tag editor for a session header. */
function tagEditor(session, onChanged) {
  const shown = () => (session.tags?.length ? session.tags.join(', ') : '');
  const label = el('span', { class: 'muted' }, shown() || 'no tags');
  return el('span', { class: 'row' },
    label,
    el('button', { class: 'mini', title: 'Tags group sessions in the sidebar', onclick: async () => {
      const next = prompt('Tags for this session (comma separated):', shown());
      if (next === null) return;
      const tags = next.split(',').map((t) => t.trim()).filter(Boolean);
      try {
        await Api.setTags(session.id, tags);
        session.tags = tags.length ? tags : undefined;
        label.textContent = shown() || 'no tags';
        renderSessionList();
        onChanged?.(tags);
      } catch (err) { alert(err.message); }
    } }, 'tags'),
  );
}

/**
 * Import a session exported from another instance. Reads the file in the
 * browser and posts the parsed object, so a file that is not JSON at all fails
 * here with a clear message rather than as a 400 from the server.
 */
function importSessionButton() {
  const input = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const res = await Api.importSession(parsed);
      await renderSessionList();
      await openSession(res.sessionId);
    } catch (err) {
      alert(`Could not import that file: ${err.message}`);
    } finally {
      input.value = ''; // so re-picking the same file fires onchange again
    }
  };
  const btn = el('button', { class: 'nav-btn', title: 'Load a session exported as JSON', onclick: () => input.click() }, 'Import session');
  return el('span', {}, btn, input);
}

/* ---------- global state ---------- */
const App = {
  config: { endpoints: [] },
  personas: [],
  presets: { consolidatorTemplate: '', councils: [], roundtables: [] },
  modelsByEndpoint: {}, // endpointId -> string[] (lazy, cached)
  tagFilter: null,      // one tag at a time, or null for everything
  selecting: false,     // sidebar is in pick-several-to-delete mode
  selected: new Set(),  // session ids ticked while selecting
  hideThinking: localStorage.getItem('rsconclave.hideThinking') === '1',
  streamBuf: new Map(), // entryId -> full streamed text; the pill reads this when hiding
  modelInfoByEndpoint: {}, // endpointId -> { model: {contextLength, numCtx} }
  session: null, // session currently shown (active run or a loaded historical one)
  runState: { sessionId: null, phase: 'idle' },
  currentView: null,

  isActiveSession() {
    return this.session && this.runState.sessionId === this.session.id;
  },

  async loadModels(endpointId, force = false) {
    if (!force && this.modelsByEndpoint[endpointId]) return this.modelsByEndpoint[endpointId];
    const { models } = await Api.getModels(endpointId);
    this.modelsByEndpoint[endpointId] = models;
    // context info loads in the background; pickers re-label when it lands
    this.loadModelInfo(endpointId).catch(() => {});
    return models;
  },

  async loadModelInfo(endpointId) {
    if (this.modelInfoByEndpoint[endpointId]) return this.modelInfoByEndpoint[endpointId];
    const { info } = await Api.getModelInfo(endpointId);
    this.modelInfoByEndpoint[endpointId] = info;
    document.dispatchEvent(new CustomEvent('model-info-loaded', { detail: { endpointId } }));
    return info;
  },

  modelInfo(endpointId, model) {
    return this.modelInfoByEndpoint[endpointId]?.[model] ?? null;
  },

  upsertEntry(entry) {
    if (!this.session) return;
    const i = this.session.entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) this.session.entries[i] = entry;
    else this.session.entries.push(entry);
  },

  appendToken(entryId, delta) {
    let full = null;
    if (this.session) {
      const e = this.session.entries.find((x) => x.id === entryId);
      if (e) { e.text += delta; full = e.text; }
    }
    const node = document.querySelector(`[data-entry-body="${entryId}"]`);
    if (node) {
      /*
       * The full stream is tracked separately from the DOM because the DOM may
       * be FILTERED: with "hide reasoning" on, the node shows only prose, so
       * neither the pill nor a later toggle-off could recover the reasoning
       * from node.textContent. The entry (when the session is loaded) is the
       * authority; the buffer covers the gap when it is not.
       */
      if (full === null) full = (this.streamBuf.get(entryId) ?? node.textContent) + delta;
      this.streamBuf.set(entryId, full);
      const scroller = node.closest('.transcript-scroll, .view-scroll');
      const nearBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      if (this.hideThinking) node.textContent = visibleDuringStream(full);
      else node.textContent += delta;
      if (scroller && nearBottom) scroller.scrollTop = scroller.scrollHeight;
      // Cards only re-render on entry/state events, never per token - so the
      // reasoning/streaming pill would otherwise stay whatever it was when
      // the card was stamped, before any tokens existed. It reads the FULL
      // text: with reasoning hidden, the visible text is exactly the part
      // with no <think> in it, and the pill would never say "reasoning" again.
      const pill = node.closest('.card')?.querySelector('.badge.busy');
      if (pill) {
        pill.textContent = full.includes('<think>') && !full.includes('</think>') ? 'reasoning' : 'streaming';
      }
    }
  },
};

/* ---------- view switching ---------- */
const views = {};
function showView(name) {
  App.currentView = name;
  for (const [n, section] of Object.entries(views)) section.classList.toggle('hidden', n !== name);
  // selected state uses --se-active; the accent stays reserved for primary actions
  for (const n of ['chat', 'council', 'roundtable', 'pipeline', 'settings']) {
    document.getElementById(`nav-${n}`).classList.toggle('selected', name === n && !App.session);
  }
}

function viewForSession(session) {
  return session.mode; // council | roundtable | pipeline - view names match modes
}

function mountSessionView(session) {
  const name = viewForSession(session);
  if (name === 'council') Council.mount(session);
  else if (name === 'pipeline') Pipeline.mount(session);
  else if (name === 'chat') Chat.mount(session);
  else Roundtable.mount(session);
  showView(name);
}

/*
 * Sequence-guarded, the same way the search box is. Click session A then B
 * quickly and whichever response lands LAST won - so a slow fetch for A could
 * mount A's transcript while the sidebar highlighted B, and the two disagreed
 * until the next click.
 */
let openSeq = 0;
async function openSession(id) {
  const mySeq = ++openSeq;
  const session = await Api.getSession(id);
  if (mySeq !== openSeq) return; // a newer click already won
  App.session = session;
  mountSessionView(App.session);
  renderSessionList();
  renderTitle(); // the tab carries the session name, and no state event fires here
}

/* ---------- session search ---------- */

/** Text node with each case-insensitive occurrence of q wrapped for emphasis.
 *  Built with elements, never markup - snippets contain model output. */
function highlightMatches(text, q) {
  const wrap = el('span', {});
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let pos = 0;
  for (let idx = lower.indexOf(needle); idx !== -1; idx = lower.indexOf(needle, pos)) {
    wrap.append(text.slice(pos, idx), el('span', { class: 'search-mark' }, text.slice(idx, idx + q.length)));
    pos = idx + q.length;
  }
  wrap.append(text.slice(pos));
  return wrap;
}

function renderSearchResults(results, q) {
  const ul = document.getElementById('session-list');
  if (!results.length) {
    ul.replaceChildren(el('li', { class: 'muted' }, 'no matches'));
    return;
  }
  ul.replaceChildren(...results.map((r) =>
    el('li', { onclick: () => openSession(r.id) },
      el('span', {}, r.title),
      el('span', { class: 'sess-meta' },
        el('span', {}, `${r.mode} · ${r.total} match${r.total === 1 ? '' : 'es'}`)),
      ...r.hits.map((h) =>
        el('div', { class: 'search-hit' },
          el('span', { class: 'search-speaker' }, h.speaker + ': '),
          highlightMatches(h.snippet, q))),
    )));
}

function initSearch() {
  const input = document.getElementById('session-search');
  let timer = null;
  let seq = 0; // out-of-order guard: a slow early response must not clobber a newer one
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      const mySeq = ++seq;
      if (q.length < 2) {
        renderSessionList();
        return;
      }
      try {
        const { results } = await Api.searchSessions(q);
        if (mySeq === seq) renderSearchResults(results, q);
      } catch {}
    }, 250);
  });
}

/* ---------- session list ---------- */
/**
 * Chips for every tag in use, plus "all". Rendered from the sessions themselves
 * rather than a stored tag list, so deleting the last session with a tag makes
 * that tag disappear on its own.
 */
function renderTagFilter(sessions) {
  const host = document.getElementById('tag-filter');
  if (!host) return;
  const tags = [...new Set(sessions.flatMap((s) => s.tags ?? []))].sort((a, b) => a.localeCompare(b));
  if (!tags.length) {
    host.replaceChildren();
    App.tagFilter = null;
    return;
  }
  // A filter pinned to a tag that no longer exists would hide everything.
  if (App.tagFilter && !tags.includes(App.tagFilter)) App.tagFilter = null;

  const chip = (label, value) =>
    el('button', {
      class: 'mini tag-chip' + (App.tagFilter === value ? ' selected' : ''),
      onclick: () => {
        App.tagFilter = App.tagFilter === value ? null : value;
        renderSessionList();
      },
    }, label);
  host.replaceChildren(chip('all', null), ...tags.map((t) => chip(t, t)));
}

/*
 * Bulk delete. Testing this app produces dozens of throwaway sessions in an
 * afternoon, and clearing them one confirm at a time is its own chore.
 *
 * "All" means everything CURRENTLY LISTED, not everything on disk - with a tag
 * filter active that is the whole point, and a select-all that silently
 * reached past the filter would be the kind of surprise you cannot undo.
 */
function renderBulkBar(sessions) {
  const host = document.getElementById('session-bulk');
  if (!host) return;
  const visible = sessions.map((s) => s.id);
  if (!App.selecting) {
    host.replaceChildren(el('button', {
      class: 'mini',
      title: 'Pick several sessions to delete at once',
      onclick: () => { App.selecting = true; App.selected = new Set(); renderSessionList(); },
    }, 'Select'));
    return;
  }
  const chosen = visible.filter((id) => App.selected.has(id));
  host.replaceChildren(
    el('span', { class: 'muted' }, `${chosen.length} of ${visible.length}`),
    el('span', { class: 'grow' }),
    el('button', { class: 'mini', onclick: () => { for (const id of visible) App.selected.add(id); renderSessionList(); } }, 'all'),
    el('button', { class: 'mini', onclick: () => { App.selected = new Set(); renderSessionList(); } }, 'none'),
    el('button', {
      class: 'mini danger',
      disabled: chosen.length ? null : 'disabled',
      onclick: async () => {
        if (!confirm(`Delete ${chosen.length} session${chosen.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
        try {
          const { skipped } = await Api.deleteSessions(chosen);
          // The live run is skipped rather than failing the batch, so say so
          // instead of leaving one row behind with no explanation.
          if (skipped) alert(`${skipped} session was left alone because it is the active run. Stop it first.`);
        } catch (err) { alert(err.message); }
        if (App.session && chosen.includes(App.session.id)) App.session = null;
        App.selecting = false;
        App.selected = new Set();
        renderSessionList();
      },
    }, 'Delete'),
    el('button', { class: 'mini', onclick: () => { App.selecting = false; App.selected = new Set(); renderSessionList(); } }, 'Cancel'),
  );
}

async function renderSessionList() {
  // While a search is active, its results own the list - the background
  // refreshes that fire on session events must not clobber them.
  const searchBox = document.getElementById('session-search');
  if (searchBox && searchBox.value.trim().length >= 2) return;
  let sessions = [];
  try {
    sessions = await Api.listSessions();
  } catch {}

  renderTagFilter(sessions);
  // Filtering, not grouping: a session can carry several tags, so grouping would
  // have to either duplicate rows or pick a winner. One active tag at a time
  // keeps the list honest about what it is showing.
  if (App.tagFilter) sessions = sessions.filter((s) => (s.tags ?? []).includes(App.tagFilter));

  renderBulkBar(sessions);

  const ul = document.getElementById('session-list');
  ul.replaceChildren(
    ...sessions.map((s) =>
      el(
        'li',
        {
          class: [App.session?.id === s.id ? 'active' : '', App.selecting ? 'selectable' : ''].filter(Boolean).join(' '),
          // In select mode a click picks rather than opens. Loading a session
          // mid-selection would swap the whole view out from under the choice
          // being made.
          onclick: () => {
            if (!App.selecting) return openSession(s.id);
            if (App.selected.has(s.id)) App.selected.delete(s.id);
            else App.selected.add(s.id);
            renderSessionList();
          },
        },
        App.selecting
          ? el('input', {
              type: 'checkbox',
              // Rendered from the set rather than left to the DOM, so the state
              // survives the re-render this list does on every session event.
              ...(App.selected.has(s.id) ? { checked: 'checked' } : {}),
              onclick: (ev) => ev.stopPropagation(),
              onchange: () => {
                if (App.selected.has(s.id)) App.selected.delete(s.id);
                else App.selected.add(s.id);
                renderBulkBar(sessions);
              },
            })
          : null,
        el('span', {}, s.title),
        el(
          'span',
          { class: 'sess-meta' },
          el('span', {}, `${s.mode} · ${s.status}`),
          ...(s.tags?.length ? [el('span', { class: 'sess-tags' }, s.tags.join(' · '))] : []),
          el('span', {
            class: 'sess-del',
            title: 'delete session',
            onclick: async (ev) => {
              ev.stopPropagation();
              if (!confirm(`Delete "${s.title}"?`)) return;
              try {
                await Api.deleteSession(s.id);
              } catch (err) {
                alert(err.message);
              }
              if (App.session?.id === s.id) App.session = null;
              renderSessionList();
            },
          }, '✕'),
        ),
      ),
    ),
  );
}

/* ---------- status strip ---------- */
/*
 * The tab title, which is the only part of this app visible from another tab.
 *
 * A local run can take a minute or more, so tabbing away is the normal thing
 * to do - and until now the tab said "RSOperator" whether it was thinking hard
 * or had finished ten minutes ago.
 *
 * The state marker goes FIRST because a background tab is narrow enough to
 * show only a few characters; a leading dot reads as "still going" at a glance
 * without anything else being legible. The app name stays on the end, for the
 * usual case of several tabs open at once.
 *
 * Deliberately no Notification API: it needs a permission prompt, and a local
 * tool asking for one is exactly the sort of thing that makes people wonder
 * what else it is doing. The title costs nothing and asks for nothing.
 */
const TITLE_APP = document.title;
let titleLastPhase = 'idle';
let titleWaitingUnseen = false;

/*
 * NOTHING FROM THE CONVERSATION GOES IN THE TAB TITLE.
 *
 * The first version put the session title and the speaking model up there,
 * which read well in a wide tab and was wrong anyway: a tab title is one of
 * the leakiest surfaces a browser has. It shows up in screenshots, screen
 * shares, the alt-tab switcher, and browser history - places the prompt has no
 * business being just because you looked away for a minute. It was also too
 * long to survive the truncation a background tab applies.
 *
 * So: a marker and the app name, nothing else. The marker leads because tabs
 * truncate from the right, which is also why every mail and chat client puts
 * its unread count in front rather than behind.
 */
function renderTitle() {
  const st = App.runState;
  const running = st.phase === 'generating' || st.phase === 'auto_stepping';
  const wasRunning = titleLastPhase === 'generating' || titleLastPhase === 'auto_stepping';
  // Finishing while you were watching is not news; you saw it happen.
  if (wasRunning && !running && document.hidden) titleWaitingUnseen = true;
  if (running) titleWaitingUnseen = false;
  titleLastPhase = st.phase;

  /*
   * A gated roundtable waits on you indefinitely, so it counts as something
   * waiting whether or not you were here when it stopped. Chat rests in the
   * same phase between every message - marking that would pin the badge on
   * permanently, which is the same as no badge at all.
   */
  const gateWaiting = st.phase === 'awaiting_gate' && st.mode === 'roundtable';
  if (gateWaiting || titleWaitingUnseen) document.title = `(1) ${TITLE_APP}`;
  else if (running) document.title = `● ${TITLE_APP}`;
  else document.title = TITLE_APP;
}

// Coming back to the tab IS the acknowledgement; nothing else clears it.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    titleWaitingUnseen = false;
    renderTitle();
  }
});

function renderStatus() {
  renderTitle();
  const strip = document.getElementById('status-strip');
  const st = App.runState;
  const busy = st.phase !== 'idle' && st.phase !== 'done';
  // Someone else's generation occupies the box; say so without saying whose.
  if (!busy && (App.boxBusy || st.boxBusy)) {
    strip.classList.remove('hidden');
    document.getElementById('status-phase').textContent = 'box busy - another user is generating';
    document.getElementById('context-meter-wrap').classList.add('hidden');
    return;
  }
  strip.classList.toggle('hidden', !busy);
  if (!busy) return;
  let text = st.phase;
  if (st.phase === 'generating') {
    text = st.waitingFirstToken
      ? `loading ${st.currentSpeaker ?? 'model'} on remote box…`
      : `${st.currentSpeaker ?? '…'} is responding`;
  } else if (st.phase === 'awaiting_gate') {
    text = `waiting - next: ${st.nextSpeaker ?? '?'}`;
  }
  document.getElementById('status-phase').textContent = text;
  const wrap = document.getElementById('context-meter-wrap');
  wrap.classList.toggle('hidden', st.contextPct === undefined);
  if (st.contextPct !== undefined) {
    const fill = document.getElementById('context-meter-fill');
    fill.style.width = `${Math.min(100, st.contextPct)}%`;
    fill.classList.toggle('warn', st.contextPct >= 90 && st.contextPct <= 100);
    fill.classList.toggle('crit', st.contextPct > 100);
    const label = document.getElementById('context-meter-label');
    const base = `~${fmtK(st.contextTokens)} of ${fmtK(st.contextWindow)} ctx (${st.contextPct}%)`;
    if (st.contextPct > 100) {
      // Only Ollama quietly drops the oldest turns and answers anyway. Another
      // server's behaviour past its window is its own business, and claiming
      // otherwise sent people to look at the wrong machine.
      label.textContent = st.contextLocal
        ? `${base} - OVERFLOWING: Ollama is silently truncating from the top!`
        : `${base} - OVER THE LIMIT for this server's context window`;
      label.classList.add('ctx-overflow');
    } else if (st.contextPct >= 90) {
      label.textContent = `${base} - nearly full`;
      label.classList.add('ctx-overflow');
    } else {
      label.textContent = base;
      label.classList.remove('ctx-overflow');
    }
  }
}

/* ---------- SSE ---------- */
function connectSse() {
  const es = new EventSource('/events');

  /*
   * A snapshot arrives on every connect - including the silent reconnects
   * EventSource does after a network blip, a laptop waking, or a server
   * restart. It used to remount the active run's view unconditionally, so a
   * user reading a different session, editing Settings, or halfway through a
   * setup form was yanked to the live run and lost what they had typed, for no
   * reason they could see.
   *
   * Attaching on the FIRST snapshot is the behaviour worth keeping: open the app
   * with a run in progress and it takes you there. After that, a snapshot only
   * refreshes what you are already looking at.
   */
  let firstSnapshot = true;
  es.addEventListener('snapshot', (ev) => {
    const { state, session } = JSON.parse(ev.data);
    App.runState = state;
    if (session) {
      if (App.session?.id === session.id) {
        // Already attached: take the fresh data (the run may have advanced
        // while we were disconnected) without remounting, so drafts and scroll
        // position survive.
        App.session = session;
        currentViewRenderContent();
      } else if (firstSnapshot && !App.session) {
        App.session = session;
        mountSessionView(session);
      }
    }
    firstSnapshot = false;
    renderStatus();
    renderSessionList();
    currentViewUpdate();
  });

  es.addEventListener('state', (ev) => {
    App.runState = JSON.parse(ev.data);
    renderStatus();
    currentViewUpdate();
    if (App.runState.phase !== 'generating') renderBoxStatus();
    if (App.runState.phase === 'done') renderSessionList();
  });

  es.addEventListener('entry', (ev) => {
    const entry = JSON.parse(ev.data);
    App.streamBuf.delete(entry.id); // the entry now carries its own full text
    if (App.session && App.runState.sessionId === App.session.id) {
      App.upsertEntry(entry);
      currentViewRenderContent();
    }
    renderSessionList();
  });

  es.addEventListener('token', (ev) => {
    const { entryId, delta } = JSON.parse(ev.data);
    App.appendToken(entryId, delta);
  });

  es.addEventListener('busy', (ev) => {
    const { busy } = JSON.parse(ev.data);
    // Only meaningful when the run is not ours; our own state renders richer.
    App.boxBusy = busy && App.runState.sessionId === null;
    renderStatus();
  });

  es.addEventListener('session-title', (ev) => {
    const { sessionId, title } = JSON.parse(ev.data);
    if (App.session?.id === sessionId) {
      App.session.title = title;
      const h = document.querySelector('.view:not(.hidden) h3.view-title');
      if (h) h.textContent = title;
    }
    renderSessionList();
  });

  es.addEventListener('remove-entry', (ev) => {
    const { entryId, sessionId } = JSON.parse(ev.data);
    // Scoped by session. Filtering on the id alone meant a reroll driven from
    // one tab could strip entries out of a DIFFERENT session open in another -
    // forks used to share entry ids with their source, which made that
    // reachable. Fork mints fresh ids now; this is the belt to that braces.
    if (App.session && (!sessionId || App.session.id === sessionId)) {
      App.session.entries = App.session.entries.filter((e) => e.id !== entryId);
      currentViewRenderContent();
    }
  });

  /*
   * The server's error channel. It is named 'error-event' rather than 'error'
   * because EventSource already defines an 'error' event for transport
   * failures - a server-sent event of that name is ambiguous with it. This
   * listener existed as an empty stub against a name the server never emitted,
   * so every recoverable failure the engine reported was dropped on the floor;
   * errors only appeared where a view happened to render state.lastError, and
   * council did not.
   */
  es.addEventListener('error-event', (ev) => {
    let message = 'the run failed';
    try { message = JSON.parse(ev.data).message || message; } catch {}
    App.runState.lastError = message;
    currentViewUpdate();
    currentViewRenderContent();
    renderStatus();
  });
  es.onerror = () => {
    /* EventSource auto-reconnects; snapshot will resync us */
  };
}

function currentViewUpdate() {
  if (App.currentView === 'council') Council.updateState();
  else if (App.currentView === 'roundtable') Roundtable.updateState();
  else if (App.currentView === 'pipeline') Pipeline.updateState();
  else if (App.currentView === 'chat') Chat.updateState();
}
function currentViewRenderContent() {
  if (App.currentView === 'council') Council.renderCards();
  else if (App.currentView === 'roundtable') Roundtable.renderTranscript();
  else if (App.currentView === 'pipeline') Pipeline.renderCards();
  else if (App.currentView === 'chat') Chat.renderTranscript();
}

/* ---------- what's loaded on the box ---------- */
async function renderBoxStatus() {
  const div = document.getElementById('box-status');
  let data;
  try {
    data = await Api.getPs();
  } catch {
    return;
  }
  const blocks = [];
  for (const ep of data.endpoints) {
    // state gets a shape as well as a colour
    const dotClass = ep.error ? 'dot bad' : ep.models.length ? 'dot ok' : 'dot';
    const head = el('div', {}, el('span', { class: dotClass }), el('span', { class: 'box-name' }, ep.name));
    const rows = ep.error
      ? [el('div', { class: 'box-model' }, 'unreachable')]
      : ep.models.length
        ? ep.models.map((m) => el('div', { class: 'box-model' }, `${m.name} · ${m.vramGb} GB`))
        : [el('div', { class: 'box-model' }, 'nothing loaded')];
    blocks.push(el('div', { class: 'box-ep' }, head, ...rows));
  }
  div.replaceChildren(...blocks);
}

/* ---------- mobile drawer ---------- */
function closeDrawer() {
  document.body.classList.remove('drawer-open');
}

function initDrawer() {
  document.getElementById('nav-drawer').onclick = () =>
    document.body.classList.toggle('drawer-open');
  document.getElementById('drawer-backdrop').onclick = closeDrawer;
  // Choosing anything in the sidebar is a destination: close the drawer so
  // the view you asked for is what you see. No-op on desktop, where the
  // class has no effect.
  document.getElementById('sidebar').addEventListener('click', (e) => {
    if (e.target.closest('button, li')) closeDrawer();
  });
}

/* ---------- resizable sidebar ---------- */
const SIDEBAR_KEY = 'rsconclave.sidebarWidth';
const SIDEBAR_MIN = 180;
const SIDEBAR_DEFAULT = 235;
/** Upper bound is a share of the window, not a constant: 480px is half of a
 *  small laptop screen but a sliver of a 4K one. */
const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.min(560, window.innerWidth - 320));

function setSidebarWidth(px, persist) {
  const w = Math.round(Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), px)));
  document.documentElement.style.setProperty('--se-sidebar-w', w + 'px');
  if (persist) {
    try { localStorage.setItem(SIDEBAR_KEY, String(w)); } catch {}
  }
  return w;
}

function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  const saved = Number(localStorage.getItem(SIDEBAR_KEY) || 0);
  if (saved) setSidebarWidth(saved, false);

  /*
   * Pointer events rather than mouse events: one code path covers mouse, pen and
   * touch. The move/up listeners go on window, NOT on the handle - a drag that
   * outruns a 7px target would otherwise deliver its events to whatever the
   * cursor passed over instead. setPointerCapture would also solve that, but it
   * throws when the pointer is not live and would then take the listener
   * registration down with it, leaving a handle that does nothing.
   *
   * Width is measured from the sidebar's own left edge, so it does not matter
   * where inside the handle the grab started.
   */
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const left = sidebar.getBoundingClientRect().left;
    document.body.classList.add('resizing-sidebar');

    const move = (ev) => setSidebarWidth(ev.clientX - left, false);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing-sidebar');
      // Persist once, on release, rather than on every pointermove.
      setSidebarWidth(sidebar.getBoundingClientRect().width, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  handle.addEventListener('dblclick', () => setSidebarWidth(SIDEBAR_DEFAULT, true));

  // Keyboard: the handle is focusable, so it has to be operable without a mouse.
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 32 : 8;
    const current = sidebar.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') setSidebarWidth(current - step, true);
    else if (e.key === 'ArrowRight') setSidebarWidth(current + step, true);
    else if (e.key === 'Home') setSidebarWidth(SIDEBAR_DEFAULT, true);
    else return;
    e.preventDefault();
  });

  /*
   * Re-apply the stored width on every resize, letting the clamp decide. The
   * stored value is absolute, so a narrow window has to squeeze it - but only
   * for as long as the window is narrow. Clamping in place instead (and leaving
   * it there) meant one trip through a phone-sized window permanently shrank
   * the sidebar until a reload. Not persisted, so the preference survives.
   */
  window.addEventListener('resize', () => {
    const stored = Number(localStorage.getItem(SIDEBAR_KEY) || 0) || SIDEBAR_DEFAULT;
    setSidebarWidth(stored, false);
  });
}

/* ---------- init ---------- */
async function init() {
  initThemePicker();
  initDrawer();
  initSidebarResize();
  /*
   * The hide-reasoning toggle lives in the status strip because that is the
   * only thing on screen at the exact moment the reasoning is streaming past.
   * Flipping it mid-stream re-renders the live bubble at once - waiting for
   * the next token would usually be imperceptible, but the one time it is not
   * is a model sitting silent inside a long think, which is exactly when
   * someone reaches for this.
   */
  const hideBox = document.getElementById('hide-think-box');
  hideBox.checked = App.hideThinking;
  hideBox.addEventListener('change', () => {
    App.hideThinking = hideBox.checked;
    try { localStorage.setItem('rsconclave.hideThinking', App.hideThinking ? '1' : '0'); } catch {}
    const live = App.session?.entries.at(-1);
    if (App.runState.phase !== 'generating' || !live) return;
    const node = document.querySelector(`[data-entry-body="${live.id}"]`);
    if (node) node.textContent = App.hideThinking ? visibleDuringStream(live.text) : live.text;
  });
  document.getElementById('import-slot')?.replaceChildren(importSessionButton());
  initSearch();

  // Auth first: without a session every data call below would 401 anyway.
  // Auth.check shows the login/setup overlay and returns null when signed out;
  // signing in reloads the page, which lands back here with a cookie.
  try {
    App.user = await Auth.check();
  } catch (err) {
    document.body.append(el('div', { class: 'error-text', style: 'padding: 20px' },
      'Cannot reach the server: ' + err.message));
    return;
  }
  if (!App.user) return;
  const chip = document.getElementById('user-chip');
  chip.classList.remove('hidden');
  chip.querySelector('.user-name').textContent = App.user;

  views.chat = document.getElementById('view-chat');
  views.council = document.getElementById('view-council');
  views.roundtable = document.getElementById('view-roundtable');
  views.pipeline = document.getElementById('view-pipeline');
  views.settings = document.getElementById('view-settings');

  document.getElementById('nav-chat').onclick = () => {
    App.session = null;
    Chat.mount(null);
    showView('chat');
    renderSessionList();
  };
  document.getElementById('nav-council').onclick = () => {
    App.session = null;
    Council.mount(null);
    showView('council');
    renderSessionList();
  };
  document.getElementById('nav-roundtable').onclick = () => {
    App.session = null;
    Roundtable.mount(null);
    showView('roundtable');
    renderSessionList();
  };
  document.getElementById('nav-pipeline').onclick = () => {
    App.session = null;
    Pipeline.mount(null);
    showView('pipeline');
    renderSessionList();
  };
  document.getElementById('nav-settings').onclick = () => {
    Settings.mount();
    showView('settings');
  };

  try {
    [App.config, App.personas, App.presets] = await Promise.all([
      Api.getConfig(),
      Api.getPersonas(),
      Api.getPresets(),
    ]);
  } catch (err) {
    console.error('failed to load config', err);
  }

  connectSse();
  renderSessionList();
  renderBoxStatus();
  setInterval(renderBoxStatus, 30_000);

  // Enter steps the roundtable when the gate is open and focus isn't in a field
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (App.currentView !== 'roundtable' || App.runState.phase !== 'awaiting_gate') return;
    // Scope to the roundtable view: chat mounts its own #gate-bar, and a
    // hidden chat view earlier in the DOM would otherwise shadow this one.
    const stepBtn = [...document.querySelectorAll('#view-roundtable #gate-bar button')].find((b) => b.textContent === 'Step ▸');
    if (stepBtn) stepBtn.click();
  });

  if (!App.config.endpoints.length) {
    Settings.mount();
    showView('settings');
  } else {
    Council.mount(null);
    showView('council');
  }
}

init();
