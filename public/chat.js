// Chat view: plain 1:1 conversation with one model, using the same model
// picker, context metering and streaming as every other mode.
'use strict';

const Chat = {
  root: null,
  transcriptEl: null,
  composeBar: null,
  setup: null, // { endpoint, model, persona, system, temp, ctx, errEl, presetless }

  mount(session) {
    this.root = document.getElementById('view-chat');
    App.session = session;
    this.root.replaceChildren();

    if (!session) {
      const scroll = el('div', { class: 'view-scroll' });
      scroll.append(el('h3', { class: 'view-title' }, 'New Chat'), this.buildSetup());
      this.root.append(scroll);
      this.transcriptEl = null;
      this.composeBar = null;
      return;
    }

    const titleEl = el('h3', { class: 'view-title' }, session.title);
    const header = el('div', { style: 'padding: 14px 20px 0' },
      el('div', { class: 'row' },
        titleEl,
        renameButton(session.id, () => App.session.title, (t) => { App.session.title = t; titleEl.textContent = t; }),
      ),
      el('div', { class: 'row', style: 'margin-bottom: 8px' },
        el('span', { class: 'badge' }, session.config.model),
        el('a', { href: `/api/sessions/${session.id}/export.md`, download: '' }, el('button', {}, 'Export markdown')),
        el('a', { href: `/api/sessions/${session.id}`, target: '_blank' }, el('button', {}, 'View JSON')),
        cloneButton(session),
        !App.isActiveSession() ? resumeButton(session.id) : null,
      ),
      this.buildBrief(session),
    );
    this.transcriptEl = el('div', { id: 'transcript' });
    this.composeBar = el('div', { id: 'gate-bar' });
    // Same single-scroller shape as the roundtable: header rides inside it,
    // so wheeling anywhere above the compose bar scrolls the conversation.
    this.scrollEl = el('div', { class: 'transcript-scroll' }, header, this.transcriptEl);
    this.root.append(this.scrollEl, this.composeBar);
    this.renderTranscript();
    this.updateState();
  },

  buildBrief(session) {
    const cfg = session.config;
    const persona = App.personas.find((p) => p.id === cfg.personaId);
    if (!persona && !cfg.systemPrompt?.trim()) return null;
    return el('details', { class: 'session-brief' },
      el('summary', {}, 'System prompt'),
      el('div', { class: 'brief-scenario' },
        [persona?.systemPrompt?.trim(), cfg.systemPrompt?.trim()].filter(Boolean).join('\n\n')),
    );
  },

  /* ---------- setup ---------- */

  buildSetup() {
    const endpoint = el('select', {});
    const model = el('select', {});
    const persona = el('select', {}, el('option', { value: '' }, ' - none - '),
      ...App.personas.map((p) => el('option', { value: p.id }, p.name)));
    const system = el('textarea', { rows: 4, placeholder: 'System prompt (optional) - layered after the persona…' });
    // The message box is the star of the form. It used to not exist: Start
    // Chat opened an empty transcript with a second compose box, and the
    // system prompt textarea sat where a message field belongs - so first
    // messages kept landing in the system prompt.
    const message = el('textarea', {
      rows: 4,
      placeholder: 'Your first message… (Enter to start the chat, Shift+Enter for a newline)',
    });
    onEnterSend(message, () => this.start());
    const temp = el('input', { type: 'number', step: '0.1', min: '0', max: '2', placeholder: 'temp' });
    const ctx = ctxInput();
    // Label and input hide together, or the orphaned "ctx" caption stays put.
    const ctxField = el('span', { class: 'row' }, el('label', {}, 'ctx'), ctx);
    const syncCtx = ollamaOnly(ctxField, endpoint);
    const maxOut = maxTokensInput();
    const errEl = el('div', { class: 'error-text' });
    this.setup = { endpoint, model, persona, system, message, temp, ctx, maxOut, errEl };

    for (const ep of App.config.endpoints) endpoint.append(el('option', { value: ep.id }, ep.name));
    syncCtx(); // options exist now, so the kind is finally knowable
    const fillModels = async () => {
      model.replaceChildren(el('option', {}, 'loading…'));
      try {
        const epId = endpoint.value;
        const models = await App.loadModels(epId);
        await App.loadModelInfo(epId).catch(() => {});
        model.replaceChildren(...displayModels(epId, models).map((m) => modelOption(epId, m)));
      } catch (err) {
        model.replaceChildren(el('option', {}, 'error'));
        errEl.textContent = err.message;
      }
    };
    if (App.config.endpoints.length) fillModels();
    else errEl.textContent = 'No endpoints configured - add one in Settings.';
    endpoint.onchange = fillModels;
    this.setup.fillModels = fillModels; // applyConfig waits on this before picking a model

    const band = el('div', { class: 'setup-band' },
      el('div', { class: 'row' },
        el('label', {}, 'Model'), endpoint, model,
        el('label', {}, 'temp'), temp,
        ctxField,
        el('label', {}, 'max out'), maxOut,
      ),
      el('details', {},
        el('summary', {}, 'Persona & system prompt (optional)'),
        el('div', { class: 'col' },
          el('div', { class: 'row' }, el('label', {}, 'Persona'), persona),
          system,
        ),
      ),
      el('label', {}, 'Message'),
      message,
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => this.start() }, 'Start Chat'),
        errEl,
      ),
    );
    setTimeout(() => message.focus(), 0);
    return band;
  },

  /** Clone entry point: the model list must load before its value can be set. */
  async applyConfig(config) {
    const s = this.setup;
    if (config.endpointId && [...s.endpoint.options].some((o) => o.value === config.endpointId)) {
      s.endpoint.value = config.endpointId;
    }
    await s.fillModels();
    if (config.model && [...s.model.options].some((o) => o.value === config.model)) {
      s.model.value = config.model;
    }
    s.persona.value = config.personaId ?? '';
    s.system.value = config.systemPrompt ?? '';
    s.temp.value = config.params?.temperature ?? '';
    s.ctx.value = config.params?.num_ctx ?? '';
  },

  async start() {
    return once('chat-start', () => this._start());
  },

  async _start() {
    const s = this.setup;
    s.errEl.textContent = '';
    if (!s.model.value) { s.errEl.textContent = 'Pick a model.'; return; }
    const firstMessage = s.message.value.trim();
    try {
      const started = await withBoxFree(() => Api.chatStart({
        endpointId: s.endpoint.value,
        model: s.model.value,
        personaId: s.persona.value || undefined,
        systemPrompt: s.system.value.trim() || undefined,
        params: genParams(s.temp.value, s.ctx.value, s.maxOut.value),
      }));
      if (!started) return; // box was busy and you chose to leave it running
      const { sessionId } = started;
      await openSession(sessionId);
      // Starting IS sending: the transcript opens with the reply already
      // streaming. An empty message still just opens the compose view.
      if (firstMessage) await Api.chatSend(firstMessage);
    } catch (err) {
      // After openSession the setup form is unmounted; fall back to alert.
      if (document.contains(s.errEl)) s.errEl.textContent = err.message;
      else alert(err.message);
    }
  },

  /* ---------- transcript ---------- */

  renderTranscript() {
    if (!this.transcriptEl) return;
    const session = App.session;
    if (!session || session.mode !== 'chat') return;
    const sc = this.scrollEl;
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
    // Only the entry the engine is writing right now is in flight; see
    // entryComplete in app.js for why "has stats" was the wrong test.
    const generating = App.isActiveSession() && App.runState.phase === 'generating';

    this.transcriptEl.replaceChildren(
      ...session.entries.map((e) => {
        const mine = e.kind === 'user';
        const complete = entryComplete(e, generating && e === session.entries.at(-1));
        const textEl = el('div', { class: 'text', dataset: { entryBody: e.id } });
        if (complete && e.text) renderEntryText(textEl, e.text, e.kind);
        else textEl.textContent = e.text;

        const footer = [];
        const s = statsLine(e.stats);
        if (s) footer.push(el('span', {}, s));
        /*
         * Including your own messages. They used to be excluded on the theory
         * that you wrote them so you have them - but the whole point of
         * copying a prompt is to send it somewhere else, and fork and clone
         * both keep the model, so re-running one against a different engine
         * meant selecting the bubble by hand.
         */
        if (complete && e.text) footer.push(copyButton(() => e.text));
        if (complete && e.text) footer.push(forkButton(session.id, e.id));
        // Only the newest reply can be continued: extending an older one would
        // rewrite history the later turns were already answering.
        // A cancelled reply is continuable for the same reason a token-limited
        // one is, and it is the way to promote a partial back into context.
        if (complete && (e.truncated || e.error === 'cancelled') && !mine && e === session.entries.at(-1)) {
          footer.push(el('button', {
            class: 'mini',
            title: e.truncated
              ? 'This reply stopped at its token limit. Extend it in place.'
              : 'You stopped this reply. Finish it in place - once complete it counts as context again.',
            onclick: () => Api.chatContinue().catch((err) => alert(err.message)),
          }, 'continue'));
        }

        return el('div', { class: `bubble${mine ? ' mine' : ''}${e.kind === 'error' ? ' error' : ''}` },
          el('div', { class: 'speaker' }, mine ? 'You' : (e.model ?? 'assistant')),
          textEl,
          e.kind === 'error' ? el('div', { class: 'error-text' }, e.error ?? 'error') : null,
          footer.length ? el('div', { class: 'stats row' }, ...footer) : null,
        );
      }),
    );
    if (nearBottom) sc.scrollTop = sc.scrollHeight;
  },

  /* ---------- compose ---------- */

  updateState() {
    if (!this.composeBar) return;
    const session = App.session;
    if (!session || session.mode !== 'chat') return;
    const st = App.runState;
    this.composeBar.replaceChildren();

    if (!App.isActiveSession()) {
      this.composeBar.append(el('div', { class: 'row' },
        el('span', { class: 'muted' }, 'not the active session'),
        resumeButton(session.id)));
      return;
    }

    if (st.phase === 'generating') {
      this.composeBar.append(el('div', { class: 'row' },
        el('span', { class: 'gen-indicator blink' },
          st.waitingFirstToken ? `loading ${st.currentSpeaker} on remote box…` : 'responding…'),
        el('span', { class: 'grow' }),
        el('button', { class: 'danger', onclick: () => Api.cancel().catch(() => {}) }, 'Cancel'),
      ));
      return;
    }

    // Keyed by session so a message half-written to one chat does not appear
    // in the compose box of the next one you open.
    const draftKey = `chat-compose:${session.id}`;
    const box = keepDraft(draftKey,
      el('textarea', { rows: 3, class: 'grow', placeholder: 'Message… (Enter to send, Shift+Enter for a newline)' }));
    const send = async () => {
      const text = box.value.trim();
      if (!text) return;
      box.value = '';
      clearDraft(draftKey); // only once the text has actually gone somewhere
      try {
        await once('chat-send', () => Api.chatSend(text));
      } catch (err) {
        // Put it back rather than losing it to a failed send.
        box.value = text;
        drafts.set(draftKey, text);
        alert(err.message);
      }
    };
    onEnterSend(box, send);

    const hasReply = session.entries.some((e) => e.kind !== 'user');
    // A turn that failed before its reply entry existed leaves the transcript
    // ending on the question. Without a button for it the only way on was to
    // retype, which merged into a doubled user turn.
    const unanswered = session.entries.at(-1)?.kind === 'user';
    this.composeBar.append(
      el('div', { class: 'row' }, box),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: send }, 'Send ▸'),
        unanswered
          ? el('button', {
              title: 'That message never got a reply. Ask again without retyping it.',
              onclick: () => once('chat-regen', () => Api.chatRegenerate()).catch((e) => alert(e.message)),
            }, 'Retry ▸')
          : hasReply
            ? el('button', { onclick: () => once('chat-regen', () => Api.chatRegenerate()).catch((e) => alert(e.message)) }, 'Regenerate')
            : null,
        el('span', { class: 'grow' }),
        el('button', { class: 'danger', onclick: () => {
          if (confirm('End this chat?')) Api.stopRun().catch((e) => alert(e.message));
        } }, 'End'),
      ),
    );
    // append(null) would render a literal "null" text node
    if (st.lastError) this.composeBar.append(el('div', { class: 'error-text' }, st.lastError));
    focusIfIdle(box);
  },
};
