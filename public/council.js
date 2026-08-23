// Council view: setup form (with duplicate-member support and presets),
// chronological response cards, follow-up rounds, consolidation controls.
'use strict';

const Council = {
  root: null,
  cardsWrap: null,
  followupWrap: null,
  form: null, // { promptEl, memberRows: [], consolidatorSel, templateEl, unloadEl, errEl }

  /** session = null → fresh setup; session = council session → view/attach mode */
  mount(session) {
    this.root = document.getElementById('view-council');
    App.session = session;
    this.root.replaceChildren();

    const scroll = el('div', { class: 'view-scroll' });
    this.root.append(scroll);

    if (!session) {
      scroll.append(el('h3', { class: 'view-title' }, 'Convene the Council of Elders'));
      scroll.append(this.buildSetup());
      this.form.titleEl = null;
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
        this.buildReconsolidate(session),
      );
    }

    this.cardsWrap = el('div');
    this.followupWrap = el('div');
    scroll.append(this.cardsWrap, this.followupWrap);
    this.renderCards();
  },

  buildReconsolidate(session) {
    // An imported session's config is stored as-is, so it may be missing the
    // consolidator entirely. Dereferencing it threw mid-mount, after the view
    // had already been wiped: showView never ran and App.session pointed at a
    // session that was not on screen.
    const cfg = session.config?.consolidator;
    if (!cfg) {
      return el('div', { class: 'error-text', style: 'margin-bottom: 12px' },
        'This session has no consolidator in its config - it was probably imported from ' +
        'an incomplete export. The transcript below is intact; re-running consolidation is not available.');
    }
    const templateEl = el('textarea', { rows: 6 }, cfg.template);

    // Engine is editable here, not just the template. A council with enough
    // members can hand the consolidator more transcript than its window holds,
    // and the fix is a model with a bigger one - re-running the same engine on
    // the same input just fails again.
    const endpointSel = el('select', {}, ...App.config.endpoints.map((ep) => el('option', { value: ep.id }, ep.name)));
    if (App.config.endpoints.some((ep) => ep.id === cfg.endpointId)) endpointSel.value = cfg.endpointId;
    const modelSel = el('select', {});
    const ctxEl = ctxInput(cfg.params?.num_ctx);
    ollamaOnly(ctxEl, endpointSel); // this select is filled at construction, so no re-sync
    const maxOutEl = maxTokensInput(cfg.params?.maxTokens);

    const fillModels = async (preferred) => {
      modelSel.replaceChildren(el('option', {}, 'loading…'));
      try {
        const epId = endpointSel.value;
        const models = await App.loadModels(epId);
        await App.loadModelInfo(epId).catch(() => {});
        modelSel.replaceChildren(...displayModels(epId, models).map((m) => modelOption(epId, m)));
        if (preferred && models.includes(preferred)) modelSel.value = preferred;
      } catch {
        modelSel.replaceChildren(el('option', {}, 'error'));
      }
    };
    if (App.config.endpoints.length) fillModels(cfg.model);
    endpointSel.onchange = () => fillModels();

    return el('details', { style: 'margin-bottom: 12px' },
      el('summary', {}, 'Re-run consolidation (change engine or template)'),
      el('div', { class: 'col' },
        el('div', { class: 'row' },
          el('label', {}, 'Consolidator'), endpointSel, modelSel, ctxEl,
          el('span', { class: 'muted', title: 'It reads every response at once, so it needs the largest window of the run' }, 'needs the most room'),
        ),
        templateEl,
        el('div', { class: 'row' },
          el('button', { class: 'primary', onclick: async () => {
            if (!modelSel.value) return;
            try {
              await Api.councilConsolidate(
                session.id, templateEl.value,
                endpointSel.value, modelSel.value, genParams(undefined, ctxEl.value, maxOutEl.value),
              );
            } catch (err) { alert(err.message); }
          } }, 'Re-run consolidation'),
        ),
      ),
    );
  },

  buildSetup() {
    const promptEl = el('textarea', { rows: 5, placeholder: 'The question to put before the council…' });
    const modelListEl = el('div', { class: 'model-list' }, el('span', { class: 'muted' }, 'loading models…'));
    const consolidatorSel = el('select', {});
    const templateEl = el('textarea', { rows: 7 }, App.presets.consolidatorTemplate || '');
    const unloadEl = el('input', { type: 'checkbox' });
    const ballotEl = el('input', {
      placeholder: 'e.g. Yes, No, Needs more information',
      title: 'Leave blank for a normal council. Two or more options turns on ballot mode.',
    });
    /*
     * Sometimes the spread of answers IS the output. Consolidating is an extra
     * call, on the largest context of the run, often to the priciest model -
     * and it is the wrong shape entirely when you wanted five opinions rather
     * than one synthesis. Off means off for THIS run only: the consolidator is
     * still recorded, so the Consolidate button in the session view can still
     * synthesise afterwards if you change your mind.
     */
    const consolidateEl = el('input', { type: 'checkbox' });
    consolidateEl.checked = true;
    const consolidatorCtxEl = ctxInput();
    const consolidatorMaxOutEl = maxTokensInput();
    const syncConsolidatorCtx = ollamaOnly(consolidatorCtxEl, consolidatorSel, (s) => (s.value || '|').split('|')[0]);
    const errEl = el('div', { class: 'error-text' });

    /*
     * Right-sizing the council for the prompt, before spending a run on it.
     * Without this the only way to learn a prompt was too big for a seat was
     * to send it to a model with a known-large window, read the context meter
     * afterwards, and work backwards - which is a whole run to answer a
     * question the app could answer while you type.
     */
    const promptSizeEl = el('span', { class: 'prompt-size' });
    const fitSummaryEl = el('span', { class: 'muted' });
    const consolidatorFitEl = el('span', { class: 'fit-tag' });
    const fitBtn = el('button', {
      title: 'Raise the ctx of every checked member (and the consolidator) to a window this prompt fits in, capped at what each model was trained for.',
      onclick: () => this.fitPrompt(),
    }, 'Fit this prompt');

    this.form = { promptEl, consolidatorSel, templateEl, unloadEl, ballotEl, consolidateEl, consolidatorCtxEl,
      consolidatorMaxOutEl, syncConsolidatorCtx, errEl, memberRows: [], modelListEl,
      promptSizeEl, fitSummaryEl, consolidatorFitEl, fitBtn };

    // Cheap enough to run on every keystroke: the estimate is a length read,
    // and the row loop is as long as the model list.
    promptEl.addEventListener('input', () => this.refreshFit());
    consolidatorSel.addEventListener('change', () => this.refreshFit());
    consolidatorCtxEl.addEventListener('input', () => this.refreshFit());
    consolidateEl.addEventListener('change', () => this.refreshFit());

    const presetSel = el('select', {}, el('option', { value: '' }, ' - load preset - '),
      ...App.presets.councils.map((p) => el('option', { value: p.id }, p.name)));
    presetSel.onchange = () => {
      const p = App.presets.councils.find((x) => x.id === presetSel.value);
      if (p) this.applyPreset(p.config);
    };
    this.form.presetSel = presetSel;

    // Kept so applyConfig can wait for the checklist before ticking boxes in it.
    this.form.ready = this.populateModels().catch((err) => errEl.append(err.message));

    const consolidatorRow = el('div', { class: 'row' },
      el('label', {}, 'Consolidator'),
      consolidatorSel,
      consolidatorCtxEl,
      consolidatorMaxOutEl,
      consolidatorFitEl,
      el('span', { class: 'muted', title: 'The consolidator reads every response at once - it usually needs the biggest window of all.' }, '⟵ give it room'),
    );
    const templateDetails = el('details', {},
      el('summary', {}, 'Consolidator prompt template ({{PROMPT}}, {{RESPONSES}})'),
      templateEl,
    );
    // The consolidator's engine, window and template are noise when nothing is
    // going to consolidate.
    const applyConsolidateUI = () => {
      const off = !consolidateEl.checked;
      for (const node of [consolidatorRow, templateDetails]) node.classList.toggle('hidden', off);
    };
    consolidateEl.addEventListener('change', applyConsolidateUI);
    applyConsolidateUI();

    return el('div', { class: 'setup-band' },
      el('div', { class: 'row' },
        el('label', {}, 'Prompt'),
        el('span', { class: 'grow' }),
        presetSel,
        el('button', { onclick: () => this.savePreset() }, 'Save as preset'),
        presetDeleteButton(() => this.form.presetSel, 'councils'),
      ),
      promptEl,
      el('div', { class: 'row' }, promptSizeEl, fitSummaryEl, el('span', { class: 'grow' }), fitBtn),
      el('label', {}, 'Council members (queried in order, one at a time - ＋ adds the same model again, e.g. at another temperature)'),
      modelListEl,
      el('div', { class: 'row' },
        el('label', { title: 'Off: run the members and stop, leaving their answers side by side. You can still consolidate later from the session.' },
          consolidateEl, ' consolidate the answers'),
        el('span', { class: 'grow' }),
      ),
      consolidatorRow,
      el('div', { class: 'row' },
        el('label', {}, unloadEl, ' unload each model after its turn (keep_alive=0)'),
      ),
      templateDetails,
      el('details', {},
        el('summary', {}, 'Ballot - tally a straight answer as well as the prose (optional)'),
        el('div', { class: 'col' },
          el('span', { class: 'muted' },
            'Comma separated options. Every member is asked to end with exactly one of them, ' +
            'and the results are counted. The prose answers still happen - the count is an ' +
            'extra signal, not a replacement.'),
          ballotEl,
        ),
      ),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => this.run() }, 'Run Council'),
        errEl,
      ),
    );
  },

  /** memberRows: ordered array of {endpointId, model, cb, tempInput, ctxInput, rowEl, isClone} */
  addMemberRow(endpointId, model, opts = {}) {
    const cb = el('input', { type: 'checkbox' });
    if (opts.checked) cb.checked = true;
    const temp = el('input', { type: 'number', step: '0.1', min: '0', max: '2', placeholder: 'temp' });
    if (opts.temp !== undefined) temp.value = opts.temp;
    const ctx = ctxInput(opts.numCtx);
    ollamaOnly(ctx, endpointId); // fixed endpoint for this row, so no re-sync needed
    const maxOut = maxTokensInput(opts.maxTokens);
    // Every row carries its own fit tag, clones included: a clone shares the
    // model but has its own ctx box, so it can be sized differently.
    const fitEl = el('span', { class: 'fit-tag' });
    const row = { endpointId, model, cb, tempInput: temp, ctxInput: ctx, maxOutInput: maxOut, fitEl, isClone: !!opts.isClone };
    // Typing a bigger window must clear the warning it caused, or the fix
    // looks like it did nothing until the next render.
    ctx.addEventListener('input', () => this.refreshFit());
    cb.addEventListener('change', () => this.refreshFit());

    const controls = [];
    if (opts.isClone) {
      controls.push(el('button', { class: 'mini danger', title: 'remove this instance', onclick: () => {
        this.form.memberRows.splice(this.form.memberRows.indexOf(row), 1);
        row.rowEl.remove();
      } }, '−'));
    } else {
      controls.push(el('button', { class: 'mini', title: 'add another instance of this model', onclick: () => {
        const clone = this.addMemberRow(endpointId, model, { isClone: true, checked: true });
        row.rowEl.after(clone.rowEl);
        const at = this.form.memberRows.indexOf(row) + 1;
        this.form.memberRows.splice(at, 0, this.form.memberRows.pop());
      } }, '＋'));
    }

    // Name and ctx sit together on the left; the spacer comes AFTER them.
    // With the spacer between name and ctx, a widescreen row put half a
    // meter of blank space exactly where the eye tracks name-to-window.
    row.rowEl = el('div', { class: `model-item${opts.isClone ? ' clone' : ''}` },
      cb, el('span', { title: modelLabel(endpointId, model) === model ? null : model },
        (opts.isClone ? '↳ ' : '') + modelLabel(endpointId, model)),
      opts.isClone ? null : ctxTag(endpointId, model),
      fitEl,
      el('span', { class: 'grow' }),
      temp, ctx, maxOut, ...controls);
    this.form.memberRows.push(row);
    return row;
  },

  /*
   * Redraw every fit marker from the prompt as it stands. Members are judged
   * on the prompt; the consolidator is judged on a PROJECTION, because its
   * real input is the prompt plus every reply and those do not exist yet.
   * The assumption behind the projection is named in the hover rather than
   * buried, since a confident wrong number is worse than an honest estimate.
   */
  refreshFit() {
    const f = this.form;
    if (!f) return;
    const needed = estimateTokens(f.promptEl.value);
    f.promptSizeEl.textContent = needed ? `about ${fmtK(needed)} tokens` : '';
    f.promptSizeEl.title = needed
      ? 'Rough estimate at four characters per token. Markdown, code and JSON pack more tokens per character than prose, so treat this as a floor.'
      : '';

    let checked = 0;
    let short = 0;
    for (const row of f.memberRows) {
      const verdict = fitVerdict(needed, App.modelInfo(row.endpointId, row.model), row.ctxInput.value);
      renderFitTag(row.fitEl, verdict);
      if (row.cb.checked) {
        checked++;
        if (verdict) short++;
      }
    }

    // The consolidator reads the prompt plus every answer. Projected, and
    // only when it is actually going to run.
    const [cEp, cModel] = (f.consolidatorSel.value || '|').split('|');
    const projected = needed + checked * ASSUMED_REPLY_TOKENS;
    const consolidatorVerdict = f.consolidateEl.checked
      ? fitVerdict(projected, App.modelInfo(cEp, cModel), f.consolidatorCtxEl.value)
      : null;
    renderFitTag(f.consolidatorFitEl, consolidatorVerdict);
    if (consolidatorVerdict) {
      f.consolidatorFitEl.title += ` Projected from the prompt plus ${checked} ${checked === 1 ? 'reply' : 'replies'} at an assumed ${fmtK(ASSUMED_REPLY_TOKENS)} each - a guess, since the replies do not exist yet.`;
    }

    if (!needed || !checked) {
      f.fitSummaryEl.textContent = '';
      return;
    }
    f.fitSummaryEl.textContent = short
      ? `- ${short} of ${checked} checked ${short === 1 ? 'member needs' : 'members need'} a bigger window`
      : `- all ${checked} checked ${checked === 1 ? 'member has' : 'members have'} room`;
  },

  /*
   * Raise every checked seat to a window this prompt fits in. Only ever
   * raises: a seat already big enough is left alone, because its number may
   * have been measured (see tools/measure-ctx.sh) and lowering it to a
   * computed one would throw that away.
   */
  fitPrompt() {
    const f = this.form;
    const needed = estimateTokens(f.promptEl.value);
    if (!needed) { f.fitSummaryEl.textContent = '- nothing to fit yet'; return; }
    const rows = f.memberRows.filter((r) => r.cb.checked);
    if (!rows.length) { f.fitSummaryEl.textContent = '- check some members first'; return; }

    // Round up to a whole 1k: num_ctx is allocated in blocks anyway, and a
    // round number in the box is easier to recognise as deliberate later.
    const target = (want) => Math.ceil(want / 1024) * 1024;
    let raised = 0;
    const stuck = [];
    const raise = (input, info, want, label) => {
      if (!info) return; // no /api/show data: nothing to be confident about
      if (info.contextLength && want > info.contextLength) { stuck.push(label); return; }
      const current = Number(input.value) > 0 ? Number(input.value) : (info.numCtx ?? 4096);
      const to = target(want);
      if (current >= to) return;
      input.value = to;
      raised++;
    };

    for (const row of rows) {
      raise(row.ctxInput, App.modelInfo(row.endpointId, row.model),
        needed + REPLY_HEADROOM_TOKENS, modelLabel(row.endpointId, row.model));
    }
    if (f.consolidateEl.checked) {
      const [cEp, cModel] = (f.consolidatorSel.value || '|').split('|');
      raise(f.consolidatorCtxEl, App.modelInfo(cEp, cModel),
        needed + rows.length * ASSUMED_REPLY_TOKENS + REPLY_HEADROOM_TOKENS, modelLabel(cEp, cModel));
    }

    this.refreshFit();
    // Say what happened rather than leaving the boxes to be noticed, and name
    // the seats no setting can help - their markers stay red, but the reason
    // belongs in words too.
    const parts = [];
    if (raised) parts.push(`raised ${raised} ${raised === 1 ? 'seat' : 'seats'}`);
    if (stuck.length) parts.push(`${stuck.join(', ')} cannot fit it at all`);
    if (!parts.length) parts.push('every checked seat already had room');
    f.fitSummaryEl.textContent = `- ${parts.join('; ')}`;
  },

  async populateModels() {
    const { modelListEl, consolidatorSel } = this.form;
    modelListEl.replaceChildren();
    consolidatorSel.replaceChildren();
    this.form.memberRows = [];
    if (!App.config.endpoints.length) {
      modelListEl.append(el('span', { class: 'error-text' }, 'No endpoints configured - add one in Settings.'));
      return;
    }
    for (const ep of App.config.endpoints) {
      modelListEl.append(el('div', { class: 'endpoint-group-label' }, ep.name));
      let models = [];
      try {
        models = await App.loadModels(ep.id);
        await App.loadModelInfo(ep.id).catch(() => {});
      } catch (err) {
        modelListEl.append(el('div', { class: 'error-text' }, err.message));
        continue;
      }
      for (const m of displayModels(ep.id, models)) {
        const row = this.addMemberRow(ep.id, m.id, {});
        modelListEl.append(row.rowEl);
        consolidatorSel.append(el('option', {
          value: `${ep.id}|${m.id}`,
          // Same detail hover as every other model picker - the consolidator
          // is the seat most worth checking, since it reads the whole run.
          title: modelDetailText(ep.id, m.id, App.modelInfo(ep.id, m.id)),
        }, `${m.label} (${ep.name})${ctxSuffix(App.modelInfo(ep.id, m.id))}`));
      }
    }
    this.form.syncConsolidatorCtx(); // the select finally has a value to read
    // Rows exist now, and a cloned session arrives with its prompt already
    // filled - so the markers have something to say before any keystroke.
    this.refreshFit();
  },

  collectConfig() {
    const f = this.form;
    const members = [];
    for (const row of f.memberRows) {
      if (!row.cb.checked) continue;
      members.push({
        endpointId: row.endpointId,
        model: row.model,
        params: genParams(row.tempInput.value, row.ctxInput.value, row.maxOutInput.value),
      });
    }
    const [cEndpoint, cModel] = (f.consolidatorSel.value || '|').split('|');
    return {
      prompt: f.promptEl.value.trim(),
      members,
      consolidator: {
        endpointId: cEndpoint,
        model: cModel,
        template: f.templateEl.value,
        params: genParams(undefined, f.consolidatorCtxEl.value, f.consolidatorMaxOutEl.value),
      },
      unloadBetweenModels: f.unloadEl.checked,
      skipConsolidation: f.consolidateEl.checked ? undefined : true,
      // One option is not a ballot, it is a leading question - so anything under
      // two is treated as ballot mode being off.
      ballot: (() => {
        const opts = f.ballotEl.value.split(',').map((o) => o.trim()).filter(Boolean);
        return opts.length >= 2 ? opts : undefined;
      })(),
    };
  },

  /** Clone entry point: same as a preset, but the prompt comes along too. */
  async applyConfig(config) {
    await this.form.ready;
    this.applyPreset(config, true);
  },

  applyPreset(config, withPrompt) {
    const f = this.form;
    if (withPrompt && config.prompt) f.promptEl.value = config.prompt;
    // reset: uncheck all, drop clones
    for (const row of [...f.memberRows]) {
      if (row.isClone) {
        f.memberRows.splice(f.memberRows.indexOf(row), 1);
        row.rowEl.remove();
      } else {
        row.cb.checked = false;
        row.tempInput.value = '';
        row.ctxInput.value = '';
      }
    }
    for (const m of config.members) {
      const base = f.memberRows.find((r) => r.endpointId === m.endpointId && r.model === m.model && !r.cb.checked);
      if (base) {
        base.cb.checked = true;
        if (m.params?.temperature !== undefined) base.tempInput.value = m.params.temperature;
        if (m.params?.num_ctx !== undefined) base.ctxInput.value = m.params.num_ctx;
      } else {
        const anchor = f.memberRows.find((r) => r.endpointId === m.endpointId && r.model === m.model && !r.isClone);
        if (!anchor) continue; // model no longer on the box
        const clone = this.addMemberRow(m.endpointId, m.model, {
          isClone: true, checked: true,
          temp: m.params?.temperature,
          numCtx: m.params?.num_ctx,
        });
        anchor.rowEl.after(clone.rowEl);
        const at = f.memberRows.indexOf(anchor) + 1;
        f.memberRows.splice(at, 0, f.memberRows.pop());
      }
    }
    const cKey = `${config.consolidator.endpointId}|${config.consolidator.model}`;
    if ([...f.consolidatorSel.options].some((o) => o.value === cKey)) f.consolidatorSel.value = cKey;
    if (config.consolidator.template) f.templateEl.value = config.consolidator.template;
    f.consolidatorCtxEl.value = config.consolidator.params?.num_ctx ?? '';
    f.unloadEl.checked = !!config.unloadBetweenModels;
    f.ballotEl.value = (config.ballot ?? []).join(', ');
    // A preset or clone changes which seats are checked and what windows they
    // carry, and neither fires an input event.
    this.refreshFit();
  },

  async savePreset() {
    const config = this.collectConfig();
    if (!config.members.length) { this.form.errEl.textContent = 'Select members before saving a preset.'; return; }
    config.prompt = ''; // presets are member/consolidator setups, not prompts
    await savePresetNamed('councils', this.form.presetSel, 'cn', { config });
  },

  run() {
    const f = this.form;
    f.errEl.textContent = '';
    const config = this.collectConfig();
    if (!config.prompt) { f.errEl.textContent = 'Prompt is empty.'; return; }
    if (!config.members.length) { f.errEl.textContent = 'Select at least one council member.'; return; }
    if (!config.consolidator.model) { f.errEl.textContent = 'Pick a consolidator.'; return; }
    once('council-start', () => withBoxFree(() => Api.councilStart(config)))
      .then(async (started) => {
        if (!started) return; // declined stopping the run that was in the way
        const { sessionId } = started;
        App.session = await Api.getSession(sessionId);
        this.mount(App.session);
        renderSessionList();
      })
      .catch((err) => { f.errEl.textContent = err.message; });
  },

  /* ---------- cards ---------- */

  /**
   * Ballot tally, at the top so the count is the first thing you see and the
   * reasoning is underneath it.
   *
   * The matching rules live in server/vote.ts and are duplicated here rather
   * than fetched, so the bars update live as each member finishes instead of
   * appearing only after a round trip. Both sides read from the same entries,
   * so they agree; if they ever stop agreeing, vote.ts is the one that counts,
   * because it is what the export uses.
   */
  buildTallyCard(session, options) {
    const counts = options.map((option) => ({ option, voters: [] }));
    const undecided = [];
    /*
     * One vote per seat per round, last answer wins - the same rule as
     * tallyBallot in server/vote.ts, which is what the export uses. Counting
     * every entry double-counted: re-runs and follow-up rounds both APPEND, so
     * a 4-member council with one follow-up read "8 of 4 voted" with every
     * model listed twice. Both copies had the defect, so they agreed on the
     * wrong number, which is worse than disagreeing.
     */
    const latest = new Map();
    let round = 0;
    for (const e of session.entries) {
      if (e.kind === 'user') { round++; continue; }
      if (e.kind !== 'participant' || e.memberIndex === undefined || e.memberIndex < 0) continue;
      if (!(e.stats?.durationMs !== undefined || e.error)) continue; // still streaming
      latest.set(round + '|' + e.memberIndex, e);
    }
    for (const e of latest.values()) {
      const who = e.model || e.speaker;
      const choice = e.error ? null : pickBallotOption(e.text, options);
      if (choice) counts.find((c) => c.option === choice).voters.push(who);
      else undecided.push(who);
    }
    const cast = counts.reduce((n, c) => n + c.voters.length, 0);
    const rows = counts.map((c) => {
      const pct = cast ? Math.round((c.voters.length / cast) * 100) : 0;
      return el('div', { class: 'tally-row' },
        el('span', { class: 'tally-label', title: c.option }, c.option),
        el('span', { class: 'tally-bar' }, el('span', { class: 'tally-fill', style: `width:${pct}%` })),
        el('span', { class: 'num' }, String(c.voters.length)),
        el('span', { class: 'muted', title: c.voters.join(', ') }, c.voters.join(', ')),
      );
    });
    if (undecided.length) {
      rows.push(el('div', { class: 'tally-row' },
        el('span', { class: 'tally-label muted' }, 'no clear answer'),
        el('span', { class: 'tally-bar' }),
        el('span', { class: 'num' }, String(undecided.length)),
        el('span', { class: 'muted' }, undecided.join(', ')),
      ));
    }
    return el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('span', { class: 'model-name' }, 'Ballot'),
        el('span', { class: 'muted' }, `${cast} of ${session.config.members.length} voted`)),
      el('div', { class: 'card-body' }, ...rows));
  },

  renderCards() {
    if (!this.cardsWrap) return;
    const session = App.session;
    if (!session || session.mode !== 'council') { this.cardsWrap?.replaceChildren(); return; }

    const cfg = session.config;
    const isActive = App.isActiveSession();
    const generating = isActive && App.runState.phase === 'generating';

    this.cardsWrap.replaceChildren();
    // Council was the one view that never surfaced a run failure: a preset
    // whose endpoint was deleted went straight to 'done' with no members and no
    // explanation. Chat, roundtable and pipeline all render this already.
    if (App.isActiveSession() && App.runState.lastError) {
      this.cardsWrap.append(el('div', { class: 'card' },
        el('div', { class: 'card-header' },
          el('span', { class: 'model-name' }, 'Run failed'),
          el('span', { class: 'sev crit' }, 'error')),
        el('div', { class: 'card-body error-text' }, App.runState.lastError)));
    }
    if (cfg.ballot?.length) this.cardsWrap.append(this.buildTallyCard(session, cfg.ballot));
    let userCount = 0;
    for (const entry of session.entries) {
      if (entry.kind === 'user') {
        userCount++;
        // The prompt is the single most reusable string in a council - it is
        // what you feed to a different set of models next.
        this.cardsWrap.append(el('div', { class: 'card prompt-card' },
          el('div', { class: 'card-header' },
            el('span', { class: 'model-name' }, userCount === 1 ? 'Prompt' : `Follow-up ${userCount - 1}`),
            el('span', { class: 'grow' }),
            copyButton(() => entry.text)),
          el('div', { class: 'card-body' }, entry.text)));
      } else {
        this.cardsWrap.append(this.buildEntryCard(session, entry, generating));
      }
    }

    // queued placeholders for members that haven't answered the latest prompt yet
    if (generating) {
      const lastUserIdx = session.entries.findLastIndex((e) => e.kind === 'user');
      const afterUser = session.entries.slice(lastUserIdx + 1);
      cfg.members.forEach((m, i) => {
        if (!afterUser.some((e) => e.memberIndex === i)) {
          this.cardsWrap.append(el('div', { class: 'card' },
            el('div', { class: 'card-header' },
              el('span', { class: 'model-name' }, m.model),
              el('span', { class: 'badge' }, 'queued')),
            el('div', { class: 'card-body' })));
        }
      });
      if (!afterUser.some((e) => e.kind === 'consolidation')) {
        this.cardsWrap.append(el('div', { class: 'card consolidation' },
          el('div', { class: 'card-header' },
            el('span', { class: 'model-name' }, `Consolidation - ${cfg.consolidator.model}`),
            el('span', { class: 'badge' }, 'awaiting responses')),
          el('div', { class: 'card-body' })));
      }
    }

    this.renderFollowup(session, generating);
  },

  buildEntryCard(session, entry, generating) {
    const isConsolidation = entry.kind === 'consolidation';
    const complete = entryComplete(entry, generating && entry === session.entries.at(-1));
    const actions = [copyButton(() => entry.text), forkButton(session.id, entry.id)];
    if (!generating && entry.memberIndex !== undefined && entry.memberIndex >= 0 && !isConsolidation) {
      actions.push(el('button', { class: 'mini', onclick: () =>
        Api.councilRerunMember(session.id, entry.memberIndex).catch((e) => alert(e.message)) }, 'Re-run'));
    }
    // The consolidation is the council's one distilled answer - the same
    // thing a persona memory is made of, so it can become one.
    if (isConsolidation && complete && entry.text) actions.push(saveMemoryButton(session, entry));
    if (generating && !complete) {
      /*
       * Two ways out of a member that is not going well, and the difference
       * matters: Skip abandons this one and lets the rest of the council
       * answer, Cancel ends the whole run. Cancel used to be the only option,
       * so one model crawling cost you every answer already collected.
       * Consolidation is the exception - there is nothing after it to skip to.
       */
      if (!isConsolidation) {
        actions.push(el('button', {
          class: 'mini',
          title: 'Give up on this model and move to the next member. The answers already collected are kept.',
          onclick: () => Api.councilSkip().catch((e) => alert(e.message)),
        }, 'Skip'));
      }
      actions.push(el('button', {
        class: 'mini danger',
        title: 'Stop the whole council here.',
        onclick: () => Api.cancel().catch(() => {}),
      }, 'Cancel'));
    }

    const body = el('div', { class: 'card-body', dataset: { entryBody: entry.id } });
    if (complete) renderEntryText(body, entry.text, entry.kind);
    else body.textContent = entry.text;

    return el('div', { class: `card${isConsolidation ? ' consolidation' : ''}` },
      el('div', { class: 'card-header' },
        el('span', { class: 'model-name' }, isConsolidation ? `Consolidation - ${entry.model}` : entry.model ?? entry.speaker),
        el('span', { class: 'row' }, ...entryStatus(entry, complete), ...actions),
      ),
      body,
    );
  },

  renderFollowup(session, generating) {
    this.followupWrap.replaceChildren();
    if (generating || !session.entries.some((e) => e.kind === 'consolidation')) return;
    // Drafted: this band is rebuilt on every state event, which used to eat a
    // half-written follow-up whenever anything else happened.
    const draftKey = `council-followup:${session.id}`;
    const ta = keepDraft(draftKey,
      el('textarea', { rows: 3, placeholder: 'Ask the council a follow-up - each member answers with its own previous response as context… (Enter to ask, Shift+Enter for a newline)' }));
    const ask = () => {
      const p = ta.value.trim();
      if (!p) return;
      ta.value = '';
      clearDraft(draftKey);
      once('council-followup', () => Api.councilFollowup(session.id, p)).catch((e) => {
        ta.value = p; // failed ask: give the text back
        drafts.set(draftKey, p);
        alert(e.message);
      });
    };
    onEnterSend(ta, ask);
    this.followupWrap.append(el('div', { class: 'setup-band' },
      el('label', {}, 'Follow-up round'),
      ta,
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: ask }, 'Ask all members'),
      ),
    ));
  },

  updateState() {
    this.renderCards();
  },
};

/*
 * Once, at module scope, not per setup build. /api/show lands well after the
 * checklist is drawn - a seat's window is unknown until it does - and a
 * listener registered inside buildSetup would leave one more stale call
 * behind every time a council was configured.
 */
document.addEventListener('model-info-loaded', () => Council.refreshFit());
