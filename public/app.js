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
function renderEntryText(container, text) {
  container.replaceChildren();
  container.classList.remove('md');
  const m = text.match(/^\s*<think>([\s\S]*?)(?:<\/think>\s*)([\s\S]*)$/);
  const body = m ? m[2].trim() : text;
  if (m) {
    container.append(
      el('details', { class: 'think' },
        el('summary', {}, 'thinking…'),
        el('div', { class: 'think-body' }, m[1].trim())),
    );
  }
  // Completed messages render as markdown (streaming ones stay plain text
  // and get re-rendered here on the final entry event). Thinking stays
  // plain inside its fold - it is scratch work, not a document.
  mdRender(container, body);
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

/** Build a GenParams object from optional temp/ctx input values; undefined if both blank. */
function genParams(tempValue, ctxValue) {
  const p = {};
  const t = parseFloat(tempValue);
  if (Number.isFinite(t)) p.temperature = t;
  const c = parseInt(ctxValue, 10);
  if (Number.isFinite(c) && c > 0) p.num_ctx = c;
  return Object.keys(p).length ? p : undefined;
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
    return [el('span', { class: 'sev warn', title: 'partial output kept' }, 'cancelled')];
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
async function withBoxFree(action) {
  try {
    return await action();
  } catch (err) {
    if (!/box is busy|already running/i.test(err.message || '')) throw err;
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
    if (this.session) {
      const e = this.session.entries.find((x) => x.id === entryId);
      if (e) e.text += delta;
    }
    const node = document.querySelector(`[data-entry-body="${entryId}"]`);
    if (node) {
      const scroller = node.closest('.transcript-scroll, .view-scroll');
      const nearBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      node.textContent += delta;
      if (scroller && nearBottom) scroller.scrollTop = scroller.scrollHeight;
      // Cards only re-render on entry/state events, never per token - so the
      // reasoning/streaming pill would otherwise stay whatever it was when
      // the card was stamped, before any tokens existed.
      const pill = node.closest('.card')?.querySelector('.badge.busy');
      if (pill) {
        const t = node.textContent;
        pill.textContent = t.includes('<think>') && !t.includes('</think>') ? 'reasoning' : 'streaming';
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

async function openSession(id) {
  App.session = await Api.getSession(id);
  mountSessionView(App.session);
  renderSessionList();
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

  const ul = document.getElementById('session-list');
  ul.replaceChildren(
    ...sessions.map((s) =>
      el(
        'li',
        { class: App.session?.id === s.id ? 'active' : '', onclick: () => openSession(s.id) },
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
function renderStatus() {
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
      label.textContent = `${base} - OVERFLOWING: Ollama is silently truncating from the top!`;
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

  es.addEventListener('snapshot', (ev) => {
    const { state, session } = JSON.parse(ev.data);
    App.runState = state;
    if (session) {
      // an active run exists on the server - attach to it
      App.session = session;
      mountSessionView(session);
    }
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
    const { entryId } = JSON.parse(ev.data);
    if (App.session) {
      App.session.entries = App.session.entries.filter((e) => e.id !== entryId);
      currentViewRenderContent();
    }
  });

  es.addEventListener('error-event', () => {});
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
