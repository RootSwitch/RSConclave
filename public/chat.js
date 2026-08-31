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
        el('span', { class: 'grow' }),
        // Rebuilt on every mount, which is every completed turn, so it grows
        // with the conversation rather than being a snapshot of when it opened.
        rateSparkline(session),
      ),
      this.buildBrief(session),
      // Kept on `this` so the bottom bar's Summarise button can open it; on a
      // long conversation the fold lives a lot of scrollback away.
      (this.summarizeFold = this.buildSummarizeSection(session)),
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
    // Fetched from the server rather than assembled here, for the reason the
    // roundtable disclosure gives: what is shown must be what is sent, and a
    // persona's memory is now a layer this view does not build.
    const body = el('div', { class: 'brief-scenario' }, 'loading…');
    Api.chatSystemPrompt(cfg)
      .then((r) => { body.textContent = r.prompt; })
      .catch((e) => { body.textContent = `(could not load: ${e.message})`; });
    return el('details', { class: 'session-brief' },
      el('summary', {}, 'System prompt'),
      body,
    );
  },

  /*
   * Summarise: the roundtable's judge wearing different words. The result is
   * a consolidation entry in this chat, which is the only kind of entry that
   * can be saved as a persona memory - so this fold is where memory starts.
   * In a compaction session the same fold re-runs the compaction, against the
   * memories as they stood when the session was made (see consolidateTranscript).
   */
  buildSummarizeSection(session) {
    const compacting = Boolean(session.config.compactsPersonaId);
    return judgeSection({
      summary: compacting
        ? 'Re-run the compaction with another model or template'
        : 'Summarise this conversation (for a persona memory)',
      modelLabel: compacting ? 'Compactor' : 'Summariser',
      roomHint: compacting
        ? 'The compactor reads every memory at once - give it a window bigger than the list.'
        : 'The summariser reads the whole conversation at once - give it a window bigger than the chat.',
      templateLabel: compacting
        ? 'Template ({{MEMORY}} = the memories being compacted)'
        : 'Template - {{TRANSCRIPT}} whole conversation, {{SOURCE}} your messages only, {{MEMORY}} what is already remembered',
      /*
       * Two jobs, two templates. Summarising a conversation and distilling
       * reference material want opposite things: one is about the exchange,
       * the other about the subject, and the wrong one produces a memory that
       * describes a document being shown rather than what it said. The
       * distillation template reads {{SOURCE}} so the model's own clarifying
       * questions are not in front of it to be mistaken for facts.
       */
      templates: compacting
        ? [{ key: 'compactTemplate', name: 'Compact', fallback: '{{MEMORY}}' }]
        : [
            { key: 'summarizeTemplate', name: 'Conversation', fallback: '{{TRANSCRIPT}}' },
            { key: 'distilTemplate', name: 'Reference material', fallback: '{{SOURCE}}' },
          ],
      runLabel: compacting ? 'Compact again' : 'Summarise',
      onRun: (endpointId, model, template, params) => Api.chatSummarize(session.id, endpointId, model, template, params),
      // A chat started from a preset remembers which summariser it used, so
      // the tenth memory-building conversation does not re-pick the model the
      // first nine used.
      seat: (App.presets.chats ?? []).find((p) => p.id === session.config.presetId)?.summarizer,
      onSeat: async (used) => {
        const list = App.presets.chats ?? [];
        const p = list.find((x) => x.id === session.config.presetId);
        if (!p) return;
        const next = list.map((x) => (x.id === p.id ? { ...x, summarizer: used } : x));
        App.presets = { ...App.presets, chats: next };
        await Api.putPresets(App.presets).catch(() => {}); // a preference, not the work
      },
    });
  },

  /* ---------- setup ---------- */

  buildSetup() {
    const endpoint = el('select', {});
    const model = el('select', {});
    // The memory count rides on the name: picking a persona that remembers
    // things is a different act from picking one that does not, and the
    // difference should be visible where the choice is made.
    const persona = el('select', {}, el('option', { value: '' }, ' - none - '),
      ...App.personas.map((p) => el('option', { value: p.id },
        `${p.name}${p.memories?.length ? ` (${p.memories.length} ${p.memories.length === 1 ? 'memory' : 'memories'})` : ''}`)));
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
    /*
     * The first message is where a pasted document meets a model window, and
     * until now nothing said whether the two were compatible - the same gap
     * the council setup had. One seat instead of several, so it is a single
     * marker rather than a list, but the arithmetic is the app's job either
     * way. Counts the system prompt too, since that is sent with every turn.
     */
    // Attached reference material for this chat; the fold below owns the UI.
    const docState = { ids: [] };
    const sizeEl = el('span', { class: 'prompt-size' });
    const fitEl = el('span', { class: 'fit-tag' });
    /*
     * A saved chat setup: model, persona and settings under a name. The other
     * three modes have had presets all along and chat did not, which stopped
     * making sense once building a persona's memory meant picking the same
     * combination over and over. Same word as the other modes on purpose -
     * this is not a new concept, it is the one chat was missing.
     */
    const presetSel = el('select', {}, el('option', { value: '' }, ' - load preset - '),
      ...(App.presets.chats ?? []).map((p) => el('option', { value: p.id }, p.name)));
    // Says what picking a remembering persona actually commits you to, beside
    // the control that does it - the same mark the sidebar uses on the
    // sessions that result.
    const personaNoteEl = el('span', { class: 'muted' });
    this.setup = { endpoint, model, persona, system, message, temp, ctx, maxOut, errEl, sizeEl, fitEl, presetSel, personaNoteEl, docState };

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

    presetSel.onchange = async () => {
      const p = (App.presets.chats ?? []).find((x) => x.id === presetSel.value);
      if (!p) return;
      if ([...endpoint.options].some((o) => o.value === p.endpointId)) endpoint.value = p.endpointId;
      await fillModels();
      if ([...model.options].some((o) => o.value === p.model)) model.value = p.model;
      persona.value = p.personaId ?? '';
      temp.value = p.params?.temperature ?? '';
      ctx.value = p.params?.num_ctx ?? '';
      maxOut.value = p.params?.maxTokens ?? '';
      syncCtx();
      this.refreshSetupFit();
    };
    const savePreset = async () => {
      if (!model.value) { errEl.textContent = 'Pick a model before saving a preset.'; return; }
      const name = prompt('Name this preset (persona + model):',
        `${App.personas.find((x) => x.id === persona.value)?.name ?? 'No persona'} + ${modelLabel(endpoint.value, model.value)}`);
      if (!name?.trim()) return;
      const existing = (App.presets.chats ?? []).find((x) => x.name === name.trim());
      const entry = {
        id: existing?.id ?? 'pr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: name.trim(),
        personaId: persona.value || undefined,
        endpointId: endpoint.value,
        model: model.value,
        params: genParams(temp.value, ctx.value, maxOut.value),
        // Kept if this preset already had one: the summariser is learned from
        // use (see the summarise fold), not typed in here.
        summarizer: existing?.summarizer,
      };
      const list = [...(App.presets.chats ?? []).filter((x) => x.id !== entry.id), entry];
      App.presets = { ...App.presets, chats: list };
      await Api.putPresets(App.presets);
      presetSel.replaceChildren(el('option', { value: '' }, ' - load preset - '),
        ...list.map((p) => el('option', { value: p.id }, p.name)));
      presetSel.value = entry.id;
    };

    const band = el('div', { class: 'setup-band' },
      el('div', { class: 'row' },
        el('label', { title: 'A saved chat setup: model, persona and settings under a name. Memory-building chats reuse the same one every time.' }, 'Preset'),
        presetSel,
        el('button', { onclick: () => savePreset().catch((e) => alert(e.message)) }, 'Save as preset'),
        presetDeleteButton(() => this.setup.presetSel, 'chats'),
      ),
      el('div', { class: 'row' },
        el('label', {}, 'Model'), endpoint, model,
        el('label', {}, 'temp'), temp,
        ctxField,
        el('label', {}, 'max out'), maxOut,
      ),
      /*
       * Persona on its own line, out of the fold it used to share with the
       * system prompt. The two were collapsed together as "optional", which
       * was true of the system prompt and stopped being true of the persona
       * the moment memory existed: it is now the first choice in a
       * memory-building chat, and the control that saves it sat two rows
       * above the control that sets it.
       */
      el('div', { class: 'row' },
        el('label', { title: 'The persona this chat wears. One that remembers carries its memories into every turn.' }, 'Persona'),
        persona,
        personaNoteEl,
      ),
      documentsFold(docState, () => this.refreshSetupFit()),
      el('details', {},
        el('summary', {}, 'System prompt (optional)'),
        el('div', { class: 'col' },
          el('span', { class: 'muted' },
            'Free text layered after the persona and its memories, for this chat only.'),
          system,
        ),
      ),
      el('label', {}, 'Message'),
      message,
      el('div', { class: 'row' }, sizeEl, fitEl),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => this.start() }, 'Start Chat'),
        errEl,
      ),
    );
    // The persona's memory is a layer this form does not build, so its size is
    // not knowable here - a persona with a long memory shifts the number, and
    // saying so beats quietly being wrong about it.
    for (const node of [message, system, ctx]) node.addEventListener('input', () => this.refreshSetupFit());
    for (const node of [model, persona, endpoint]) node.addEventListener('change', () => this.refreshSetupFit());
    setTimeout(() => message.focus(), 0);
    return band;
  },

  /** Does the first message fit the model picked for it? See buildSetup. */
  refreshSetupFit() {
    const s = this.setup;
    if (!s || !s.sizeEl.isConnected) return;
    const p = App.personas.find((x) => x.id === s.persona.value);
    const remembers = p?.memories?.length ?? 0;
    s.personaNoteEl.className = remembers ? 'sess-memory' : 'muted';
    s.personaNoteEl.textContent = remembers
      ? `◈ remembers ${remembers} ${remembers === 1 ? 'conversation' : 'conversations'} - this chat can add to that`
      : '';
    const needed = estimateTokens(s.message.value) + estimateTokens(s.system.value) + documentTokens(s.docState.ids);
    s.sizeEl.textContent = needed ? `about ${fmtK(needed)} tokens` : '';
    s.sizeEl.title = needed
      ? 'Message plus system prompt, roughly, at four characters per token. A persona with memories adds more that this form cannot see.'
      : '';
    renderFitTag(s.fitEl, fitVerdict(needed, App.modelInfo(s.endpoint.value, s.model.value), s.ctx.value));
  },

  /** Clone entry point: the model list must load before its value can be set. */
  /*
   * `firstMessage` arrives separately because a chat's opening prompt is not a
   * declared part of ChatConfig the way a council's `prompt` is - the caller
   * reads it off the transcript. Cloning a chat used to drop it silently and
   * leave you retyping the thing you were trying to vary.
   */
  async applyConfig(config, firstMessage) {
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
    // Dropped by the same omission as the message: council restores both of
    // these on clone, so a chat that quietly lost its attached documents and
    // its output cap was inconsistent rather than deliberate.
    s.maxOut.value = config.params?.maxTokens ?? '';
    s.docState.ids = (config.documentIds ?? []).filter((id) => App.documents.some((d) => d.id === id));
    s.docState.sync?.();
    if (firstMessage) s.message.value = firstMessage;
    this.refreshSetupFit();
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
        // A profile resolves to its real model and its saved params here, so
        // the session records numbers rather than a reference to config.
        ...seatFrom(s.endpoint.value, s.model.value, genParams(s.temp.value, s.ctx.value, s.maxOut.value)),
        personaId: s.persona.value || undefined,
        systemPrompt: s.system.value.trim() || undefined,
        documentIds: s.docState.ids.length ? s.docState.ids : undefined,
        // Recorded so the summarise fold can offer the same summariser again.
        presetId: s.presetSel.value || undefined,
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
        // In a compaction session the user turn is the memory list, not
        // something the person typed - it reads as a record, not as "mine".
        const mine = e.kind === 'user' && !session.config.compactsPersonaId;
        const summary = e.kind === 'consolidation';
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
        if (summary && complete && e.text) footer.push(saveMemoryButton(session, e));
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

        const speaker = mine ? 'You'
          : summary ? `Summary - ${e.model ?? e.speaker}`
          : e.kind === 'user' ? e.speaker
          : (e.model ?? 'assistant');
        return el('div', { class: `bubble${mine ? ' mine' : ''}${e.kind === 'error' ? ' error' : ''}${summary ? ' consolidation' : ''}` },
          el('div', { class: 'speaker' }, speaker),
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

    /*
     * The jump to the summarise fold rides in BOTH bar states. A finished
     * conversation is not the active session, and that is exactly the one
     * most worth distilling into a memory - requiring a Resume first would
     * be a hoop, since running the summariser resumes the session anyway.
     */
    const summarizeJump = () => session.entries.some((e) => e.kind !== 'user')
      ? el('button', {
          title: 'Open the summarise panel at the top of the conversation.',
          onclick: () => {
            if (this.summarizeFold) this.summarizeFold.open = true;
            this.scrollEl.scrollTop = 0;
          },
        }, session.config.compactsPersonaId ? 'Compact ↑' : 'Summarise ↑')
      : null;

    if (!App.isActiveSession()) {
      this.composeBar.append(el('div', { class: 'row' },
        el('span', { class: 'muted' }, 'not the active session'),
        resumeButton(session.id),
        summarizeJump()));
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

    /*
     * What this message would cost, before it is irreversible. Quiet unless
     * there is something to say: a one-line reply needs no commentary, and a
     * readout that is always there stops being read. The sidebar meter still
     * reports the turn already sent - this one is about the turn you are
     * about to send.
     */
    const draftSizeEl = el('span', { class: 'prompt-size' });
    const syncDraft = () => {
      const p = chatTurnProjection(session, box.value);
      const draft = estimateTokens(box.value);
      if (!p) {
        // No measured turn to build on. The draft's own size is still worth
        // saying once it is big enough to be a surprise.
        draftSizeEl.className = 'prompt-size';
        draftSizeEl.textContent = draft >= 500 ? `this message: about ${fmtK(draft)} tokens` : '';
        draftSizeEl.title = draft >= 500 ? 'Rough estimate at four characters per token.' : '';
        return;
      }
      const notable = draft >= 500 || p.pct >= 90;
      draftSizeEl.className = `prompt-size${p.pct > 100 ? ' over' : p.pct >= 90 ? ' near' : ''}`;
      draftSizeEl.textContent = notable
        ? `next turn: about ${fmtK(p.total)} of ${fmtK(p.window)} ctx (${p.pct}%)`
        : '';
      draftSizeEl.title = notable
        ? `This message is about ${fmtK(p.draft)} tokens on top of the conversation so far.`
          + (p.pct > 100
            ? ' Over the window: Ollama will silently drop the oldest turns, which is where the system prompt lives.'
            : ' Rough estimate at four characters per token, so treat it as a floor.')
        : '';
    };
    box.addEventListener('input', syncDraft);
    syncDraft();

    const hasReply = session.entries.some((e) => e.kind !== 'user');
    // A turn that failed before its reply entry existed leaves the transcript
    // ending on the question. Without a button for it the only way on was to
    // retype, which merged into a doubled user turn.
    const unanswered = session.entries.at(-1)?.kind === 'user';
    // A summary is not a reply; Regenerate after one would delete it and
    // re-answer the turn before. It re-runs from its own fold instead.
    const lastIsSummary = session.entries.at(-1)?.kind === 'consolidation';
    this.composeBar.append(
      el('div', { class: 'row' }, box),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: send }, 'Send ▸'),
        draftSizeEl,
        unanswered
          ? el('button', {
              title: 'That message never got a reply. Ask again without retyping it.',
              onclick: () => once('chat-regen', () => Api.chatRegenerate()).catch((e) => alert(e.message)),
            }, 'Retry ▸')
          : hasReply && !lastIsSummary
            ? el('button', { onclick: () => once('chat-regen', () => Api.chatRegenerate()).catch((e) => alert(e.message)) }, 'Regenerate')
            : null,
        summarizeJump(),
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

/*
 * Once, at module scope. /api/show lands after the form is drawn, and a
 * listener registered inside buildSetup would leave a stale call behind for
 * every chat set up in a session - the same trap the council checklist had.
 */
document.addEventListener('model-info-loaded', () => Chat.refreshSetupFit());

/*
 * A model pulled on the box while this form was open appears without a reload.
 * The selection is preserved across the re-fill: the list changing under
 * someone mid-choice must not silently move what they picked.
 */
document.addEventListener('models-changed', async (e) => {
  const s = Chat.setup;
  if (!s || s.endpoint.value !== e.detail.endpointId) return;
  const keep = s.model.value;
  await s.fillModels();
  if ([...s.model.options].some((o) => o.value === keep)) s.model.value = keep;
  Chat.refreshSetupFit();
});
