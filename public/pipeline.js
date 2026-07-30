// Pipeline view: chain stages where each stage's template receives the
// previous stage's output as {{INPUT}}. Draft → critique → rewrite, etc.
'use strict';

const Pipeline = {
  root: null,
  cardsWrap: null,
  stages: [], // setup rows: {id, els}
  inputEl: null,
  errEl: null,

  mount(session) {
    this.root = document.getElementById('view-pipeline');
    App.session = session;
    this.root.replaceChildren();

    const scroll = el('div', { class: 'view-scroll' });
    this.root.append(scroll);

    if (!session) {
      scroll.append(el('h3', { class: 'view-title' }, 'Build a Pipeline'));
      scroll.append(this.buildSetup());
    } else {
      const titleEl = el('h3', { class: 'view-title' }, session.title);
      scroll.append(
        el('div', { class: 'row', style: 'margin-bottom: 10px' },
          titleEl,
          renameButton(session.id, () => App.session.title, (t) => { App.session.title = t; titleEl.textContent = t; }),
          el('span', { class: 'grow' }),
          el('a', { href: `/api/sessions/${session.id}/export.md`, download: '' }, el('button', {}, 'Export markdown')),
          el('a', { href: `/api/sessions/${session.id}`, target: '_blank' }, el('button', {}, 'View JSON')),
          cloneButton(session),
        ),
        el('div', { class: 'muted', style: 'margin-bottom: 10px' },
          // config.stages can be absent on an imported session; a throw here
          // left the view half-mounted.
          (session.config?.stages?.length
            ? 'Stages: ' + session.config.stages.map((s, i) => `${i + 1}. ${s.name?.trim() || s.model}`).join(' → ')
            : 'No stages in this session config (imported from an incomplete export).')),
      );
    }

    this.cardsWrap = el('div');
    scroll.append(this.cardsWrap);
    this.renderCards();
  },

  /* ---------- setup ---------- */

  buildSetup() {
    this.stages = [];
    this.inputEl = el('textarea', { rows: 5, placeholder: 'Initial input - fed to stage 1 as {{INPUT}}…' });
    this.errEl = el('div', { class: 'error-text' });
    const rowsWrap = el('div', { class: 'col' });
    this.rowsWrap = rowsWrap;

    const presets = App.presets.pipelines ?? [];
    const presetSel = el('select', {}, el('option', { value: '' }, ' - load preset - '),
      ...presets.map((p) => el('option', { value: p.id }, p.name)));
    presetSel.onchange = () => {
      const p = (App.presets.pipelines ?? []).find((x) => x.id === presetSel.value);
      if (p) {
        this.stages = [];
        rowsWrap.replaceChildren();
        for (const s of p.stages) this.addStageRow(rowsWrap, s);
      }
    };
    this.presetSel = presetSel;

    const wrap = el('div', { class: 'setup-band' },
      el('div', { class: 'row' },
        el('label', {}, 'Input'),
        el('span', { class: 'grow' }),
        presetSel,
        el('button', { onclick: () => this.savePreset() }, 'Save as preset'),
        presetDeleteButton(() => this.presetSel, 'pipelines'),
      ),
      this.inputEl,
      el('label', {}, 'Stages (run in order; each template gets the previous output as {{INPUT}})'),
      rowsWrap,
      el('button', { onclick: () => this.addStageRow(rowsWrap) }, '+ add stage'),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => this.run() }, 'Run Pipeline'),
        this.errEl,
      ),
    );
    this.addStageRow(rowsWrap);
    if (!App.config.endpoints.length) {
      this.errEl.textContent = 'No endpoints configured - add one in Settings.';
    }
    return wrap;
  },

  /** Clone entry point. Stage rows fill their own model lists as they mount. */
  async applyConfig(config) {
    this.stages = [];
    this.rowsWrap.replaceChildren();
    for (const s of config.stages ?? []) this.addStageRow(this.rowsWrap, s);
    this.inputEl.value = config.input ?? '';
  },

  addStageRow(rowsWrap, preset) {
    const id = 's' + Math.random().toString(36).slice(2, 8);
    const els = {
      name: el('input', { placeholder: `Stage name (e.g. Draft)`, value: preset?.name ?? '' }),
      endpoint: el('select', {}),
      model: el('select', {}),
      temp: el('input', { type: 'number', step: '0.1', min: '0', max: '2', placeholder: 'temp' }),
      ctx: ctxInput(preset?.params?.num_ctx),
      template: el('textarea', { rows: 3, placeholder: 'Stage prompt - use {{INPUT}} for the previous output…' },
        preset?.template ?? ''),
    };
    if (preset?.params?.temperature !== undefined) els.temp.value = preset.params.temperature;

    for (const ep of App.config.endpoints) els.endpoint.append(el('option', { value: ep.id }, ep.name));
    if (preset?.endpointId) els.endpoint.value = preset.endpointId;
    const fillModels = async () => {
      els.model.replaceChildren(el('option', {}, 'loading…'));
      try {
        const epId = els.endpoint.value;
        const models = await App.loadModels(epId);
        await App.loadModelInfo(epId).catch(() => {});
        els.model.replaceChildren(...displayModels(epId, models).map((m) => modelOption(epId, m)));
        if (preset?.model && models.includes(preset.model)) els.model.value = preset.model;
      } catch {
        els.model.replaceChildren(el('option', {}, 'error'));
      }
    };
    if (App.config.endpoints.length) fillModels();
    els.endpoint.onchange = fillModels;

    const removeBtn = el('button', { class: 'danger', title: 'remove', onclick: () => {
      this.stages = this.stages.filter((s) => s.id !== id);
      row.remove();
    } }, '✕');

    const row = el('div', { class: 'stage-row' },
      els.name, els.endpoint, els.model, els.temp, els.ctx, removeBtn, els.template);
    rowsWrap.append(row);
    this.stages.push({ id, els });
    return row;
  },

  collectStages() {
    const stages = [];
    for (const s of this.stages) {
      if (!s.els.model.value || !s.els.template.value.trim()) continue;
      stages.push({
        name: s.els.name.value.trim() || undefined,
        endpointId: s.els.endpoint.value,
        model: s.els.model.value,
        template: s.els.template.value,
        params: genParams(s.els.temp.value, s.els.ctx.value),
      });
    }
    return stages;
  },

  async savePreset() {
    const stages = this.collectStages();
    if (!stages.length) { this.errEl.textContent = 'Add at least one stage (with a template) before saving.'; return; }
    if (!App.presets.pipelines) App.presets.pipelines = [];
    await savePresetNamed('pipelines', this.presetSel, 'pl', { stages });
  },

  run() {
    this.errEl.textContent = '';
    const input = this.inputEl.value.trim();
    const stages = this.collectStages();
    if (!input) { this.errEl.textContent = 'Input is empty.'; return; }
    if (!stages.length) { this.errEl.textContent = 'Add at least one stage with a template.'; return; }
    once('pipeline-start', () => withBoxFree(() => Api.pipelineStart({ input, stages })))
      .then(async (started) => {
        if (!started) return; // declined stopping the run that was in the way
        App.session = await Api.getSession(started.sessionId);
        this.mount(App.session);
        renderSessionList();
      })
      .catch((err) => { this.errEl.textContent = err.message; });
  },

  /* ---------- cards ---------- */

  renderCards() {
    if (!this.cardsWrap) return;
    const session = App.session;
    if (!session || session.mode !== 'pipeline') { this.cardsWrap?.replaceChildren(); return; }

    const cfg = session.config;
    const isActive = App.isActiveSession();
    const generating = isActive && App.runState.phase === 'generating';

    this.cardsWrap.replaceChildren();
    for (const entry of session.entries) {
      if (entry.kind === 'user') {
        this.cardsWrap.append(el('div', { class: 'card prompt-card' },
          el('div', { class: 'card-header' }, el('span', { class: 'model-name' }, 'Input')),
          el('div', { class: 'card-body' }, entry.text)));
      } else {
        this.cardsWrap.append(this.buildStageCard(session, entry, generating));
      }
    }

    if (generating) {
      const doneStages = new Set(session.entries.filter((e) => e.memberIndex !== undefined).map((e) => e.memberIndex));
      cfg.stages.forEach((s, i) => {
        if (!doneStages.has(i)) {
          this.cardsWrap.append(el('div', { class: 'card' },
            el('div', { class: 'card-header' },
              el('span', { class: 'model-name' }, `${i + 1}. ${s.name?.trim() || s.model}`),
              el('span', { class: 'badge' }, 'queued')),
            el('div', { class: 'card-body' })));
        }
      });
    }
    if (App.runState.lastError && isActive) {
      this.cardsWrap.append(el('div', { class: 'error-text' }, App.runState.lastError));
    }
  },

  buildStageCard(session, entry, generating) {
    const complete = entryComplete(entry, generating && entry === session.entries.at(-1));
    const stageNo = (entry.memberIndex ?? 0) + 1;
    const actions = [copyButton(() => entry.text)];
    if (!generating && entry.memberIndex !== undefined) {
      actions.push(el('button', { class: 'mini', title: 'discard this and later outputs, run again from this stage', onclick: () =>
        Api.pipelineRerun(session.id, entry.memberIndex).catch((e) => alert(e.message)) }, 'Re-run from here'));
    }
    if (generating && !complete) {
      actions.push(el('button', { class: 'mini danger', onclick: () => Api.cancel().catch(() => {}) }, 'Cancel'));
    }

    const body = el('div', { class: 'card-body', dataset: { entryBody: entry.id } });
    if (complete) renderEntryText(body, entry.text, entry.kind);
    else body.textContent = entry.text;

    return el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('span', { class: 'model-name' }, `${stageNo}. ${entry.speaker}`),
        el('span', { class: 'row' },
          ...entryStatus(entry, complete),
          ...actions,
        ),
      ),
      body,
    );
  },

  updateState() {
    this.renderCards();
  },
};
