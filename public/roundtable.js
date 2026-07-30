// Roundtable view: participant setup, transcript bubbles, human gate bar.
'use strict';

const RT_COLORS = ['#d9a441', '#6ea8d9', '#6ec07a', '#c76ed9', '#d97a6e', '#5fc9c1', '#c9b45f'];

const Roundtable = {
  root: null,
  parts: [], // setup rows: {id, els: {...}}
  setupWrap: null,
  transcriptEl: null,
  gateBar: null,
  scenarioEl: null,
  keepLastEl: null,
  errEl: null,

  mount(session) {
    this.root = document.getElementById('view-roundtable');
    App.session = session;
    this.gateNextOverride = null;
    this.root.replaceChildren();

    if (!session) {
      const scroll = el('div', { class: 'view-scroll' });
      scroll.append(el('h3', { class: 'view-title' }, 'Assemble a Roundtable'));
      this.setupWrap = this.buildSetup();
      scroll.append(this.setupWrap);
      this.root.append(scroll);
      this.transcriptEl = null;
      this.gateBar = null;
      return;
    }

    // active or historical session: transcript + gate bar
    const titleEl = el('h3', { class: 'view-title' }, session.title);
    const header = el('div', { style: 'padding: 14px 22px 0' },
      el('div', { class: 'row' },
        titleEl,
        renameButton(session.id, () => App.session.title, (t) => { App.session.title = t; titleEl.textContent = t; }),
      ),
      el('div', { class: 'row', style: 'margin-bottom: 8px' },
        el('a', { href: `/api/sessions/${session.id}/export.md`, download: '' }, el('button', {}, 'Export markdown')),
        el('a', { href: `/api/sessions/${session.id}`, target: '_blank' }, el('button', {}, 'View JSON')),
        cloneButton(session),
        !App.isActiveSession() && session.status !== 'done'
          ? el('button', { class: 'primary', onclick: async () => {
              try {
                await Api.resumeSession(session.id);
                await openSession(session.id);
              } catch (err) { alert(err.message); }
            } }, 'Resume')
          : null,
      ),
      this.buildBrief(session),
      this.buildJudgeSection(session),
    );
    this.transcriptEl = el('div', { id: 'transcript' });
    this.gateBar = el('div', { id: 'gate-bar' });
    // One scroller owns header + transcript. With the header outside it, the
    // header was a wheel dead zone and every pixel it grew (opened brief,
    // judge panel) permanently shrank the conversation area.
    this.scrollEl = el('div', { class: 'transcript-scroll' }, header, this.transcriptEl);
    this.root.append(this.scrollEl, this.gateBar);
    this.renderTranscript();
    this.updateState();
  },

  /**
   * What started this conversation. Without it the only record of the opening
   * scenario is the truncated session title or the raw JSON.
   */
  buildBrief(session) {
    const cfg = session.config;
    const participants = cfg.participants ?? [];
    const personaName = (id) => App.personas.find((p) => p.id === id)?.name;

    const roster = el('div', { class: 'roster' },
      ...participants.map((p) => {
        const bits = [];
        if (p.kind === 'human') bits.push('human');
        else if (p.model) bits.push(p.model);
        const persona = personaName(p.personaId);
        if (persona) bits.push(`persona: ${persona}`);
        const row = el('div', { class: 'roster-row' },
          el('span', { class: 'rname' }, p.kind === 'human' ? `🧑 ${p.name}` : p.name),
          el('span', { class: 'rmodel' }, bits.join(' · ')),
          p.overlayPrompt ? el('span', { class: 'roverlay' }, p.overlayPrompt) : null,
        );
        if (p.color && p.kind !== 'human') row.style.borderLeft = `3px solid ${p.color}`;
        if (p.color) row.style.paddingLeft = '7px';
        return row;
      }),
    );

    return el('details', { class: 'session-brief' },
      el('summary', {}, 'Scenario & participants'),
      el('div', {},
        cfg.scenario?.trim()
          ? el('div', { class: 'brief-scenario' }, cfg.scenario.trim())
          : el('div', { class: 'muted brief-scenario' }, '(no scenario was set)'),
        el('div', { class: 'eyebrow', style: 'margin-bottom: 5px' }, 'Participants'),
        roster,
      ),
    );
  },

  /** Judge/consolidate: run a model over the whole transcript (verdicts, recaps). */
  buildJudgeSection(session) {
    const endpointSel = el('select', {}, ...App.config.endpoints.map((ep) => el('option', { value: ep.id }, ep.name)));
    const modelSel = el('select', {});
    const fillModels = async () => {
      modelSel.replaceChildren(el('option', {}, 'loading…'));
      try {
        const epId = endpointSel.value;
        const models = await App.loadModels(epId);
        await App.loadModelInfo(epId).catch(() => {});
        modelSel.replaceChildren(...displayModels(epId, models).map((m) => modelOption(epId, m)));
      } catch {
        modelSel.replaceChildren(el('option', {}, 'error'));
      }
    };
    if (App.config.endpoints.length) fillModels();
    endpointSel.onchange = fillModels;
    const templateEl = el('textarea', { rows: 6 }, App.presets.judgeTemplate || '{{TRANSCRIPT}}');
    const judgeCtxEl = ctxInput();
    return el('details', { style: 'margin-bottom: 10px' },
      el('summary', {}, 'Judge / consolidate this conversation'),
      el('div', { class: 'col' },
        el('div', { class: 'row' },
          el('label', {}, 'Judge model'), endpointSel, modelSel, judgeCtxEl,
          el('span', { class: 'muted', title: 'The judge reads the whole transcript at once - give it a window bigger than the conversation.' }, '⟵ give it room'),
        ),
        el('label', {}, 'Template ({{TRANSCRIPT}} = the labeled conversation)'),
        templateEl,
        el('div', { class: 'row' },
          el('button', { class: 'primary', onclick: () => {
            if (!modelSel.value) return;
            Api.rtConsolidate(session.id, endpointSel.value, modelSel.value, templateEl.value, genParams(undefined, judgeCtxEl.value))
              .catch((e) => alert(e.message));
          } }, 'Run judge'),
        ),
      ),
    );
  },

  /* ---------- setup ---------- */

  buildSetup() {
    this.parts = [];
    this.scenarioEl = el('textarea', {
      rows: 4,
      placeholder: 'The situation every participant is given: what is being decided, argued or played out, and anything they all already know…',
    });
    this.keepLastEl = el('input', { type: 'number', min: '0', placeholder: 'all' });
    this.errEl = el('div', { class: 'error-text' });
    const rowsWrap = el('div', { class: 'col' });
    this.rowsWrap = rowsWrap;

    const presetSel = el('select', {}, el('option', { value: '' }, ' - load preset - '),
      ...App.presets.roundtables.map((p) => el('option', { value: p.id }, p.name)));
    presetSel.onchange = () => {
      const p = App.presets.roundtables.find((x) => x.id === presetSel.value);
      if (p) this.applyPreset(p.config, rowsWrap);
    };
    this.presetSel = presetSel;

    const wrap = el('div', { class: 'setup-band' },
      el('div', { class: 'row' },
        el('label', {}, 'Participants (turn order = row order)'),
        el('span', { class: 'grow' }),
        presetSel,
        el('button', { onclick: () => this.savePreset() }, 'Save as preset'),
        presetDeleteButton(() => this.presetSel, 'roundtables'),
      ),
      rowsWrap,
      el('button', { onclick: () => this.addPartRow(rowsWrap) }, '+ add participant'),
      el('label', {}, 'Scenario'),
      this.scenarioEl,
      /*
       * Collapsed by default so it costs nothing on a phone, where the setup
       * form is already the longest screen in the app. It exists because every
       * example in this form used to be a tabletop one, which quietly suggested
       * that was the only thing a roundtable was for.
       */
      el('details', { class: 'ideas' },
        el('summary', {}, 'Ideas - what people use a roundtable for'),
        el('ul', { class: 'idea-list' },
          el('li', {}, el('b', {}, 'Debate with a verdict. '),
            'Two opposed seats (the Skeptic and Advocate personas are a matched pair), then Run judge over the transcript.'),
          el('li', {}, el('b', {}, 'Adversarial code review. '),
            'One seat defends the change, one hunts for the input that breaks it.'),
          el('li', {}, el('b', {}, 'Pre-mortem. '),
            'An optimist, a pessimist and a realist on the same plan, before you commit to it.'),
          el('li', {}, el('b', {}, 'Rehearse a hard conversation. '),
            'Take a seat yourself, give the other side a persona, and try the opening three ways.'),
          el('li', {}, el('b', {}, 'Interview practice. '),
            'An interviewer, you as the candidate, and a third seat scoring the answers.'),
          el('li', {}, el('b', {}, 'Editorial pass. '),
            'Writer, line editor and fact-checker taking turns on the same draft.'),
          el('li', {}, el('b', {}, 'Socratic tutoring. '),
            'A tutor allowed only to ask questions, and a student seat that has to answer.'),
          el('li', {}, el('b', {}, 'Tabletop session. '),
            'A DM seat plus a player character each, human-gated so you approve every turn.'),
        ),
      ),
      el('div', { class: 'row' },
        el('label', {}, 'Keep last N entries in context (blank = all)'),
        this.keepLastEl,
        el('label', { title: 'keep_alive=0 per turn. Slower (each speaker reloads), but a RAM-spilling model like gpt-oss:120b gets an empty box at its turn instead of failing its memory estimate against a still-resident neighbor.' },
          (this.unloadEl = el('input', { type: 'checkbox' })),
          ' unload models between turns'),
      ),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => this.start() }, 'Start Roundtable'),
        this.errEl,
      ),
    );
    this.addPartRow(rowsWrap);
    this.addPartRow(rowsWrap);
    // Without this the only endpoint option is the human seat, so a fresh
    // install silently offers a roundtable of you talking to yourself.
    if (!App.config.endpoints.length) {
      this.errEl.textContent = 'No endpoints configured - add one in Settings. Until then the only participant available is you.';
    }
    return wrap;
  },

  addPartRow(rowsWrap, preset) {
    const id = 'p' + Math.random().toString(36).slice(2, 8);
    const color = preset?.color ?? RT_COLORS[this.parts.length % RT_COLORS.length];
    const els = {
      color: el('input', { type: 'color', value: color }),
      name: el('input', {
        placeholder: 'Name (blank = the model)',
        title: 'What this seat is called in the transcript. Left blank it uses the model name, so a name is only worth typing when the role matters more than the engine.',
        value: preset?.name ?? '',
      }),
      endpoint: el('select', {}),
      model: el('select', {}),
      persona: el('select', {}, el('option', { value: '' }, ' - persona - '),
        ...App.personas.map((p) => el('option', { value: p.id }, p.name))),
      temp: el('input', { type: 'number', step: '0.1', min: '0', max: '2', placeholder: 'temp' }),
      ctx: ctxInput(preset?.params?.num_ctx),
      overlay: el('textarea', {
        rows: 2,
        // No example here on purpose. The Ideas fold below now does the "what is
        // this for" work, and any single example narrowed the whole mode to
        // whatever domain it came from.
        placeholder: 'Role overlay - what makes this seat different from the persona alone',
        title: 'Each seat gets a layered system prompt: framing, then the persona, then this, then the scenario. Use this to narrow a general persona to one side, role or stake.',
      }),
    };
    if (preset?.personaId) els.persona.value = preset.personaId;
    if (preset?.overlayPrompt) els.overlay.value = preset.overlayPrompt;
    if (preset?.params?.temperature !== undefined) els.temp.value = preset.params.temperature;

    for (const ep of App.config.endpoints) {
      els.endpoint.append(el('option', { value: ep.id }, ep.name));
    }
    els.endpoint.append(el('option', { value: '__human' }, '🧑 human (you)'));
    if (preset?.kind === 'human') els.endpoint.value = '__human';
    else if (preset?.endpointId) els.endpoint.value = preset.endpointId;
    const fillModels = async () => {
      const human = els.endpoint.value === '__human';
      els.model.disabled = human;
      els.persona.disabled = human;
      els.temp.disabled = human;
      els.ctx.disabled = human;
      if (human) {
        els.model.replaceChildren(el('option', {}, ' - '));
        return;
      }
      els.model.replaceChildren(el('option', {}, 'loading…'));
      try {
        const epId = els.endpoint.value;
        const models = await App.loadModels(epId);
        await App.loadModelInfo(epId).catch(() => {});
        els.model.replaceChildren(...displayModels(epId, models).map((m) => modelOption(epId, m)));
        if (preset?.model && models.includes(preset.model)) els.model.value = preset.model;
      } catch (err) {
        els.model.replaceChildren(el('option', {}, 'error'));
      }
    };
    if (App.config.endpoints.length) fillModels();
    els.endpoint.onchange = fillModels;

    const removeBtn = el('button', { class: 'danger', title: 'remove', onclick: () => {
      this.parts = this.parts.filter((p) => p.id !== id);
      row.remove();
    } }, '✕');

    const row = el('div', { class: 'participant-row' },
      els.color, els.name, els.endpoint, els.model, els.persona, els.temp, els.ctx, removeBtn, els.overlay);
    rowsWrap.append(row);
    this.parts.push({ id, els });
  },

  /** Clone entry point. Rows fill their own model lists, so no waiting needed. */
  async applyConfig(config) {
    this.applyPreset(config, this.rowsWrap);
  },

  applyPreset(config, rowsWrap) {
    this.parts = [];
    rowsWrap.replaceChildren();
    for (const p of config.participants) this.addPartRow(rowsWrap, p);
    this.scenarioEl.value = config.scenario ?? '';
    this.keepLastEl.value = config.keepLastTurns ?? '';
    if (this.unloadEl) this.unloadEl.checked = !!config.unloadBetweenTurns;
  },

  collectConfig() {
    const participants = [];
    // Names are optional: an unnamed seat takes its model's display name (or
    // "Human"), so "add participant, pick model, go" is a complete setup.
    // Duplicates get a numeric suffix because names are how the transcript
    // and the models themselves tell speakers apart - two seats both called
    // "qwen3-coder:30b" would merge into one voice.
    const used = new Map();
    const uniqueName = (base) => {
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      return n === 1 ? base : `${base} (${n})`;
    };
    for (const p of this.parts) {
      const human = p.els.endpoint.value === '__human';
      const typed = p.els.name.value.trim();
      const fallback = human ? 'Human' : (p.els.model.value ? modelLabel(p.els.endpoint.value, p.els.model.value) : '');
      const base = typed || fallback;
      if (!base) continue; // no name typed and no model picked: an empty row
      const name = uniqueName(base);
      participants.push({
        id: p.id,
        name,
        kind: human ? 'human' : undefined,
        endpointId: human ? '' : p.els.endpoint.value,
        model: human ? '' : p.els.model.value,
        personaId: (!human && p.els.persona.value) || undefined,
        overlayPrompt: (!human && p.els.overlay.value.trim()) || undefined,
        params: human ? undefined : genParams(p.els.temp.value, p.els.ctx.value),
        color: p.els.color.value,
      });
    }
    const keepLast = parseInt(this.keepLastEl.value, 10);
    return {
      participants,
      scenario: this.scenarioEl.value,
      turnOrder: 'round-robin',
      keepLastTurns: Number.isFinite(keepLast) && keepLast > 0 ? keepLast : undefined,
      unloadBetweenTurns: this.unloadEl?.checked || undefined,
    };
  },

  async savePreset() {
    const config = this.collectConfig();
    if (config.participants.length < 2) { this.errEl.textContent = 'Need at least 2 participants (each with a model or a name) to save.'; return; }
    await savePresetNamed('roundtables', this.presetSel, 'rt', { config });
  },

  start() {
    this.errEl.textContent = '';
    const config = this.collectConfig();
    if (config.participants.length < 2) { this.errEl.textContent = 'Need at least 2 participants - pick a model for each, names are optional.'; return; }
    once('rt-start', () => withBoxFree(() => Api.rtStart(config)))
      .then((started) => (started ? openSession(started.sessionId) : undefined))
      .catch((err) => { this.errEl.textContent = err.message; });
  },

  /* ---------- transcript ---------- */

  renderTranscript() {
    if (!this.transcriptEl) return;
    const session = App.session;
    if (!session || session.mode !== 'roundtable') return;
    const participants = session.config.participants ?? [];
    const sc = this.scrollEl;
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
    const generating = App.isActiveSession() && App.runState.phase === 'generating';

    this.transcriptEl.replaceChildren(
      ...session.entries.map((e) => {
        const p = participants.find((x) => x.id === e.participantId);
        const neutral = e.kind === 'narrator' || e.kind === 'user';
        const consolidation = e.kind === 'consolidation';
        const complete = entryComplete(e, generating && e === session.entries.at(-1));
        const cls = `bubble${neutral ? ' neutral' : ''}${e.kind === 'error' ? ' error' : ''}${consolidation ? ' consolidation' : ''}`;

        const textEl = el('div', { class: 'text', dataset: { entryBody: e.id } });
        if (complete && e.text) renderEntryText(textEl, e.text, e.kind);
        else textEl.textContent = e.text;

        const statsRow = [];
        const stats = statsLine(e.stats);
        if (stats) statsRow.push(el('span', {}, stats));
        if (complete && e.text && !neutral) statsRow.push(copyButton(() => e.text));
        // Forking matters most here: a roundtable that takes an interesting
        // wrong turn is worth branching rather than rerolling away.
        if (complete && e.text) statsRow.push(forkButton(session.id, e.id));

        const bubble = el('div', { class: cls },
          el('div', { class: 'speaker' },
            consolidation ? `Judge - ${e.speaker}` : e.speaker,
            e.model && e.speaker !== e.model ? el('span', { class: 'model-tag' }, `  ${e.model}`) : null,
          ),
          textEl,
          e.kind === 'error' ? el('div', { class: 'error-text' }, e.error ?? 'error') : null,
          statsRow.length ? el('div', { class: 'stats row' }, ...statsRow) : null,
        );
        if (p?.color && !neutral && !consolidation) bubble.style.borderLeftColor = p.color;
        return bubble;
      }),
    );
    if (nearBottom) sc.scrollTop = sc.scrollHeight;
  },

  /* ---------- gate bar ---------- */

  updateState() {
    if (!this.gateBar) return;
    const session = App.session;
    if (!session || session.mode !== 'roundtable') return;
    const st = App.runState;
    const isActive = App.isActiveSession();
    this.gateBar.replaceChildren();

    if (!isActive) {
      this.gateBar.append(el('div', { class: 'muted' },
        session.status === 'done' || session.status === 'stopped' || session.status === 'paused'
          ? `session ${session.status} - use Resume to continue it`
          : 'not the active session'));
      return;
    }

    if (st.phase === 'generating') {
      this.gateBar.append(el('div', { class: 'row' },
        el('span', { class: 'gen-indicator blink' },
          st.waitingFirstToken ? `loading ${st.currentSpeaker} on remote box…` : `${st.currentSpeaker} is responding…`),
        (st.autoRemaining ?? 0) > 0 ? el('span', { class: 'muted' }, `auto: ${st.autoRemaining} more`) : null,
        el('span', { class: 'grow' }),
        (st.autoRemaining ?? 0) > 0
          ? el('button', { onclick: () => Api.rtPause().catch(() => {}) }, 'Pause after this turn')
          : null,
        el('button', { class: 'danger', onclick: () => Api.cancel().catch(() => {}) }, 'Cancel'),
      ));
      return;
    }

    const participants = session.config.participants ?? [];
    const chosenId = this.gateNextOverride ?? st.nextParticipantId ?? participants[0]?.id;
    const chosen = participants.find((p) => p.id === chosenId);
    const nextSel = el('select', {},
      ...participants.map((p) => el('option', { value: p.id }, p.kind === 'human' ? `🧑 ${p.name}` : p.name)));
    if (chosenId) nextSel.value = chosenId;
    nextSel.onchange = () => {
      this.gateNextOverride = nextSel.value;
      this.updateState(); // swap Step vs Speak controls for human/model
    };

    // Drafted: this whole bar is rebuilt on every state event, so an Auto count
    // you had set back to 20 reset itself to 5 whenever anything happened.
    const autoN = keepDraft(`rt-auto:${session.id}`, el('input', { type: 'number', min: '1', max: '50', value: '5' }));
    const injectText = keepDraft(`rt-inject:${session.id}`,
      el('textarea', { rows: 2, class: 'grow', placeholder: 'Inject a message into the conversation…' }));

    const doInject = async (as) => {
      const text = injectText.value.trim();
      if (!text) return;
      try {
        await once('rt-inject', () => Api.rtInject(text, as));
        injectText.value = '';
        clearDraft(`rt-inject:${session.id}`);
      } catch (err) { alert(err.message); }
    };

    const turnControls = [];
    if (chosen?.kind === 'human') {
      const speakText = keepDraft(`rt-speak:${session.id}`, el('textarea', {
        rows: 2, class: 'grow',
        placeholder: `Speak as ${chosen.name}… (Enter to speak, Shift+Enter for a newline)`,
      }));
      const speak = async () => {
        const text = speakText.value.trim();
        if (!text) return;
        try {
          await once('rt-human', () => Api.rtHumanTurn(chosen.id, text));
          speakText.value = '';
          clearDraft(`rt-speak:${session.id}`);
          this.gateNextOverride = null;
        } catch (err) { alert(err.message); }
      };
      onEnterSend(speakText, speak);
      turnControls.push(speakText, el('button', { class: 'primary', onclick: speak }, 'Speak ▸'));
    } else {
      turnControls.push(
        el('button', { class: 'primary', onclick: () => {
          this.gateNextOverride = null;
          once('rt-step', () => Api.rtStep(nextSel.value, 0)).catch((e) => alert(e.message));
        } }, 'Step ▸'),
        el('label', {}, 'Auto ×'),
        autoN,
        el('button', { onclick: () => {
          this.gateNextOverride = null;
          once('rt-step', () => Api.rtStep(nextSel.value, parseInt(autoN.value, 10) || 1)).catch((e) => alert(e.message));
        } }, 'Go ▶▶'),
      );
    }

    this.gateBar.append(
      el('div', { class: 'row' },
        el('label', {}, 'Next:'),
        nextSel,
        ...turnControls,
        el('button', {
          title: 'Drop the last turn and take it again. Rerolling your own typed turn hands the text back to the speak box.',
          onclick: () => once('rt-reroll', async () => {
            const res = await Api.rtReroll();
            // A human seat has nothing to re-generate, so the server returns the
            // text instead of discarding it. Put it back where it was typed and
            // point the gate at that seat, which round-robin cannot infer now
            // that the turn is gone from the transcript.
            if (res?.restored) {
              this.gateNextOverride = res.restored.participantId;
              drafts.set(`rt-speak:${session.id}`, res.restored.text);
              this.updateState();
            }
          }).catch((e) => alert(e.message)),
        }, 'Reroll last'),
        el('span', { class: 'grow' }),
        el('button', { class: 'danger', onclick: () => {
          if (confirm('End this roundtable?')) Api.rtStop().catch((e) => alert(e.message));
        } }, 'Stop'),
      ),
      el('div', { class: 'row' },
        injectText,
        el('button', { onclick: () => doInject('narrator') }, 'Send as Narrator'),
        el('button', { onclick: () => doInject('user') }, 'Send as User'),
      ),
    );
    if (st.lastError) this.gateBar.append(el('div', { class: 'error-text' }, st.lastError));
  },
};
