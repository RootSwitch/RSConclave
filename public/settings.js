// Settings view: endpoints table with connectivity test, personas CRUD.
'use strict';

const Settings = {
  root: null,

  mount() {
    this.root = document.getElementById('view-settings');
    this.root.replaceChildren();
    const scroll = el('div', { class: 'view-scroll' });
    scroll.append(el('h3', { class: 'view-title' }, 'Settings'));
    // Personas last: it is the one block that grows without bound, so
    // everything fixed-size stays reachable without scrolling past it.
    scroll.append(this.buildAccount(), this.buildUsers(), this.buildEndpoints(), this.buildPersonas(), this.buildDocuments());
    this.root.append(scroll);
  },

  /* ---------- account (yours) ---------- */

  buildAccount() {
    const current = el('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
    const next = el('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
    /*
     * Typed twice, like first-run setup already asks. Not ceremony: changing a
     * password signs out every other session, so a typo here locks you out of
     * a password you never knowingly chose, and you find out at the next sign
     * in rather than now. First-run setup confirmed and this did not, which
     * had it backwards - setup is the recoverable one.
     */
    const confirm = el('input', {
      type: 'password',
      placeholder: 'Repeat new password',
      autocomplete: 'new-password',
    });
    const msg = el('span', { class: 'muted' });
    const say = (text, bad) => {
      msg.textContent = text;
      msg.className = bad ? 'error-text' : 'muted';
    };
    const changePassword = async () => {
      say('');
      if (next.value !== confirm.value) {
        say('Passwords do not match.', true);
        return;
      }
      try {
        await Api.changePassword(current.value, next.value);
        current.value = ''; next.value = ''; confirm.value = '';
        say('Changed. Other sessions were signed out.');
      } catch (err) { say(err.message, true); }
    };
    onEnterSubmit([current, next, confirm], changePassword);
    return el('div', { class: 'settings-block' },
      el('div', { class: 'row' },
        el('label', {}, `Account: ${App.user}`),
        el('span', { class: 'grow' }),
      ),
      el('div', { class: 'row' },
        current, next, confirm,
        el('button', {
          class: 'primary',
          title: 'Other browsers signed in as you are signed out',
          onclick: changePassword,
        }, 'Change password'),
        msg,
      ),
    );
  },

  /* ---------- users (no roles: any account manages accounts) ---------- */

  buildUsers() {
    const listWrap = el('div', { class: 'col' });
    const refresh = async () => {
      const users = await Api.listAccounts().catch(() => []);
      listWrap.replaceChildren(...users.map((u) =>
        el('div', { class: 'row' },
          el('span', { class: 'badge' }, u.username),
          el('span', { class: 'muted' }, u.username === App.user ? 'you' : ''),
          el('span', { class: 'grow' }),
          u.username === App.user ? null : el('button', {
            class: 'danger mini',
            title: 'Removes the account and signs them out; their data stays on disk under data/users/',
            onclick: async () => {
              if (!confirm(`Delete account "${u.username}"? Their sessions stay on disk but become inaccessible in the UI.`)) return;
              try { await Api.deleteAccount(u.username); refresh(); }
              catch (err) { alert(err.message); }
            },
          }, 'Delete'),
        )));
    };
    refresh();

    const name = el('input', { placeholder: 'Username' });
    const pass = el('input', { type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'new-password' });
    const msg = el('span', { class: 'error-text' });
    const addUser = async () => {
      msg.textContent = '';
      try {
        await Api.addAccount(name.value.trim(), pass.value);
        name.value = ''; pass.value = '';
        refresh();
      } catch (err) { msg.textContent = err.message; }
    };
    onEnterSubmit([name, pass], addUser);
    return el('div', { class: 'settings-block' },
      el('div', { class: 'row' },
        el('label', {}, 'Users (each gets separate sessions, personas and presets)'),
        el('span', { class: 'grow' }),
      ),
      listWrap,
      el('div', { class: 'row' },
        name, pass,
        el('button', { onclick: addUser }, '+ add user'),
        msg,
      ),
    );
  },

  /* ---------- endpoints ---------- */

  buildEndpoints() {
    const rowsWrap = el('div', { class: 'col' });
    const rows = []; // {els, testResult}

    const addRow = (ep) => {
      const els = {
        name: el('input', { placeholder: 'Name', value: ep?.name ?? '' }),
        baseUrl: el('input', { placeholder: 'http://10.0.0.5:11434', value: ep?.baseUrl ?? '' }),
        kind: el('select', {},
          el('option', { value: 'ollama' }, 'ollama'),
          el('option', { value: 'openai' }, 'openai-compat')),
        keepAlive: el('input', { placeholder: 'keep_alive (5m)', value: ep?.defaultKeepAlive ?? '', style: 'width: 80px' }),
      };
      if (ep?.kind) els.kind.value = ep.kind;
      const testResult = el('div', { class: 'test-result', style: 'grid-column: 1 / -1' });
      const id = ep?.id ?? 'ep' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const rowObj = { id, els, testResult, aliases: { ...(ep?.aliases ?? {}) } };

      // Alias editor: one input per discovered model. Aliases are display
      // names only - sessions and API calls keep the real id - so renaming is
      // always safe. Sorting by alias is the point: name it how you file it.
      const aliasWrap = el('div', { class: 'col hidden', style: 'grid-column: 1 / -1' });
      const aliasBtn = el('button', {
        title: 'Show the models as you want to see them: vendor prefixes, shorthand, sort order',
        onclick: async () => {
          if (!aliasWrap.classList.toggle('hidden')) {
            aliasWrap.replaceChildren(el('span', { class: 'muted' }, 'loading models…'));
            try {
              await save();
              const { models } = await Api.getModels(id);
              aliasWrap.replaceChildren(...models.map((m) => {
                const input = el('input', {
                  placeholder: 'display name (blank = model id)',
                  value: rowObj.aliases[m] ?? '',
                  style: 'flex: 1',
                });
                input.addEventListener('input', () => {
                  const v = input.value.trim();
                  if (v) rowObj.aliases[m] = v;
                  else delete rowObj.aliases[m];
                });
                return el('div', { class: 'row' }, el('span', { class: 'code-chip' }, m), input);
              }), el('div', { class: 'muted' }, 'Names apply after Save.'));
            } catch (err) {
              aliasWrap.replaceChildren(el('span', { class: 'error-text' }, err.message));
            }
          }
        },
      }, 'Model names');

      const testBtn = el('button', { onclick: async () => {
        testResult.textContent = 'testing…';
        try {
          await save(); // discovery goes through the server, which reads saved config
          const { models } = await Api.getModels(id);
          testResult.textContent = `✓ ${models.length} models: ${models.join(', ')}`;
          App.modelsByEndpoint[id] = models;
        } catch (err) {
          testResult.textContent = '✗ ' + err.message;
        }
      } }, 'Test');
      // Confirmed, because this one persists immediately - and it takes the
      // endpoint's aliases with it. The persona ✕ beside it looks identical but
      // only edits local state, so a mis-click here used to be the expensive one.
      const delBtn = el('button', { class: 'danger', title: 'Delete this endpoint (saves immediately)', onclick: () => {
        const name = els.name.value.trim() || 'this endpoint';
        if (!confirm(`Delete ${name}?\n\nSaved straight away, along with any model aliases on it.`)) return;
        rows.splice(rows.indexOf(rowObj), 1);
        row.remove();
        save().catch((e) => alert(e.message));
      } }, '✕');

      // Enter anywhere in an endpoint row saves the whole endpoints block
      onEnterSubmit([els.name, els.baseUrl, els.keepAlive],
        () => save().then(() => alert('saved')).catch((e) => alert(e.message)));

      const row = el('div', { class: 'endpoint-row' },
        els.name, els.baseUrl, els.kind, els.keepAlive,
        el('span', { class: 'row' }, testBtn, aliasBtn, delBtn),
        testResult, aliasWrap);
      rowsWrap.append(row);
      rows.push(rowObj);
    };

    const save = async () => {
      const endpoints = rows
        .filter((r) => r.els.baseUrl.value.trim())
        .map((r) => ({
          id: r.id,
          name: r.els.name.value.trim() || r.els.baseUrl.value.trim(),
          baseUrl: r.els.baseUrl.value.trim().replace(/\/+$/, ''),
          kind: r.els.kind.value,
          defaultKeepAlive: r.els.keepAlive.value.trim() || undefined,
          aliases: Object.keys(r.aliases).length ? r.aliases : undefined,
        }));
      await Api.putConfig({ endpoints });
      App.config.endpoints = endpoints;
      App.modelsByEndpoint = {};
      // The context-window cache has to go too. It was keyed by endpoint id and
      // returned unconditionally, so repointing an endpoint from one box to
      // another kept showing the OLD box's numbers until a full reload - and
      // those numbers are what people size num_ctx from.
      App.modelInfoByEndpoint = {};
    };

    for (const ep of App.config.endpoints) addRow(ep);

    return el('div', { class: 'settings-block' },
      el('div', { class: 'row' },
        el('label', {}, 'Inference endpoints'),
        el('span', { class: 'grow' }),
        el('button', {
          title: 'For RSConclave running as a container ON the inference box: pre-fills the host.docker.internal address the compose file maps to the host',
          onclick: () => addRow({ name: 'This host', baseUrl: 'http://host.docker.internal:11434', kind: 'ollama' }),
        }, '+ host Ollama'),
        el('button', { onclick: () => addRow() }, '+ add endpoint'),
        el('button', { class: 'primary', onclick: () => save().then(() => alert('saved')).catch((e) => alert(e.message)) }, 'Save'),
      ),
      el('div', { class: 'muted' },
        'kind "ollama" = native API (/api/tags, /api/chat - richer stats). kind "openai-compat" = /v1 API (llama.cpp server, etc). Base URL without /v1 suffix. ' +
        'Containerized on the inference box itself? Use http://host.docker.internal:11434 - and the host\'s Ollama must listen beyond localhost (OLLAMA_HOST=0.0.0.0), or the name resolves and still refuses.'),
      rowsWrap,
    );
  },

  /* ---------- personas ---------- */

  buildPersonas() {
    const rowsWrap = el('div', { class: 'col' });
    const rows = [];

    // One fold per persona: collapsed shows the name and a snippet of the
    // prompt, which is enough to pick one out of a list. The name input and
    // the prompt live inside the fold rather than in the summary, so a click
    // on either cannot fight the disclosure toggle.
    const addRow = (p) => {
      const els = {
        name: el('input', { placeholder: 'Persona name', value: p?.name ?? '', style: 'flex: 1' }),
        prompt: el('textarea', { rows: 4, placeholder: 'System prompt for this persona…' }, p?.systemPrompt ?? ''),
      };
      // Name is single-line so Enter saves; the prompt beneath it is
      // long-form, where Enter must stay a newline.
      onEnterSubmit([els.name], () => save().catch((e) => alert(e.message)));
      const id = p?.id ?? 'ps' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

      /*
       * What this persona remembers, editable in place. The text is editable
       * because a model wrote it and the person is the editor of record;
       * the provenance line is shown because "where did it get that idea" is
       * the first question a wrong memory raises. Deleting is unsaved until
       * Save, like everything else on this page.
       */
      // A cloned entry arrives without an id (see the duplicate button) and
      // gets a fresh one, so forgetting it on one fork leaves the other alone.
      const memories = (p?.memories ?? []).map((m) => ({
        entry: { ...m, id: m.id ?? 'mem' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) },
        textEl: el('textarea', { rows: 3 }, m.text),
      }));
      const rowObj = { id, els, memories };
      const memWrap = el('div', { class: 'col' });
      const memHeader = el('span', { class: 'muted' });
      const syncMem = () => {
        const live = memories.map((m) => m.textEl.value).join('\n\n');
        memHeader.textContent = memories.length
          ? `${memories.length} ${memories.length === 1 ? 'memory' : 'memories'} · ~${Math.ceil(live.length / 4)} tok sent with every turn`
          : 'nothing yet - summarise a chat, then press Remember on the summary';
      };
      const renderMem = () => {
        memWrap.replaceChildren(...memories.map((m) => {
          const meta = `${m.entry.at.slice(0, 10)}`
            + (m.entry.model ? ` · ${m.entry.model}` : '')
            + (m.entry.sessionTitle ? ` · from "${m.entry.sessionTitle}"` : '');
          const forget = el('button', { class: 'danger mini', title: 'Forget this (press Save to keep the change)', onclick: () => {
            memories.splice(memories.indexOf(m), 1);
            renderMem();
          } }, '✕');
          m.textEl.oninput = syncMem;
          return el('div', { class: 'memory-entry' },
            el('div', { class: 'row memory-meta' }, el('span', {}, meta), el('span', { class: 'grow' }), forget),
            m.textEl);
        }));
        syncMem();
      };
      renderMem();
      // Compaction runs against the memories as SAVED, so the label says so;
      // the result opens as its own session and replaces nothing by itself.
      const compact = p?.memories?.length
        ? judgeSection({
            summary: 'Compact these memories into one',
            modelLabel: 'Compactor',
            roomHint: 'The compactor reads every memory at once - give it a window bigger than the list.',
            templateLabel: 'Template ({{MEMORY}} = the memories as last saved)',
            template: App.presets.compactTemplate || '{{MEMORY}}',
            runLabel: 'Compact',
            onRun: async (endpointId, model, template, params) => {
              const r = await Api.compactMemory(id, endpointId, model, template, params);
              await openSession(r.sessionId);
            },
          })
        : null;

      const title = el('span', { class: 'persona-title' });
      const preview = el('span', { class: 'persona-preview' });
      const syncSummary = () => {
        title.textContent = els.name.value.trim() || '(unnamed persona)';
        preview.textContent = (memories.length ? `[${memories.length} remembered] ` : '')
          + els.prompt.value.trim().replace(/\s+/g, ' ');
      };
      els.name.addEventListener('input', syncSummary);
      els.prompt.addEventListener('input', syncSummary);
      syncSummary();

      // Unsaved, unlike the endpoint ✕ - so the title says so rather than
      // leaving two identical buttons with opposite consequences.
      const delBtn = el('button', { class: 'danger mini', title: 'Remove this persona (press Save to keep the change)', onclick: (ev) => {
        // inside a summary: without both, the click also toggles the fold
        ev.preventDefault();
        ev.stopPropagation();
        rows.splice(rows.indexOf(rowObj), 1);
        row.remove();
      } }, '✕');
      /*
       * Fork a persona, memories and all. The point is a controlled
       * comparison: run the same remembered history forward under two
       * different models and watch where they diverge. Copying the memories
       * is what makes it a fork rather than a fresh start, and the entries
       * get new ids so pruning one side leaves the other alone.
       */
      const cloneBtn = el('button', { class: 'mini', title: 'Duplicate this persona with its memories (press Save to keep it)', onclick: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        addRow({
          name: `${els.name.value.trim() || 'persona'} (copy)`,
          systemPrompt: els.prompt.value,
          memories: memories.map((m) => ({ ...m.entry, id: undefined, text: m.textEl.value })),
        });
        rowsWrap.lastElementChild.scrollIntoView({ block: 'nearest' });
      } }, 'duplicate');

      const row = el('details', { class: 'persona-row' },
        el('summary', {}, title, preview, el('span', { class: 'grow' }), cloneBtn, delBtn),
        el('div', { class: 'col' },
          el('div', { class: 'row' }, el('label', {}, 'Name'), els.name),
          els.prompt,
          el('div', { class: 'row' }, el('label', {}, 'Memory'), memHeader),
          memWrap,
          compact));
      if (!p) row.open = true; // a persona you just added needs filling in
      rowsWrap.append(row);
      rows.push(rowObj);
    };

    /*
     * The confirmation is the button itself. An alert said "saved" and then
     * left the page looking exactly as it did before - which, right after
     * creating a persona, reads as "did that take?". A state change where
     * the click happened answers the question the alert only restated.
     */
    const saveBtn = el('button', { class: 'primary' }, 'Save');
    const save = async () => {
      // Memories are sent as this page knows them - edited text, minus the
      // forgotten ones. Sending the key at all is what lets a deletion stick;
      // a client that omits it leaves the server's copy alone (see PUT).
      const personas = rows
        .filter((r) => r.els.name.value.trim())
        .map((r) => ({
          id: r.id,
          name: r.els.name.value.trim(),
          systemPrompt: r.els.prompt.value,
          memories: r.memories.map((m) => ({ ...m.entry, text: m.textEl.value })),
        }));
      await Api.putPersonas(personas);
      App.personas = personas;
      saveBtn.textContent = 'Saved ✓';
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 1600);
    };
    saveBtn.onclick = () => save().catch((e) => alert(e.message));

    for (const p of App.personas) addRow(p);

    return el('div', { class: 'settings-block' },
      el('div', { class: 'row' },
        el('label', {}, 'Personas (reusable base system prompts)'),
        el('span', { class: 'grow' }),
        el('button', { onclick: () => addRow() }, '+ add persona'),
        saveBtn,
      ),
      rowsWrap,
    );
  },

  /* ---------- documents ---------- */

  /*
   * The reference library: named verbatim texts attached to conversations
   * from the chat and council setup forms. Deliberately dumb - not a persona
   * (material, not identity), not a memory (nothing distils or rewrites it),
   * not editable per chat (a library entry that drifts per conversation stops
   * being a library). Its one job is sparing you re-pulling the same file
   * into every conversation that needs it.
   */
  buildDocuments() {
    const rowsWrap = el('div', { class: 'col' });
    const rows = [];

    const addRow = (d) => {
      const els = {
        name: el('input', { placeholder: 'Document name (e.g. RSCanvas DIGEST)', value: d?.name ?? '', style: 'flex: 1' }),
        text: el('textarea', { rows: 6, placeholder: 'Paste the document, or load it from a file…' }, d?.text ?? ''),
      };
      const id = d?.id ?? 'doc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const rowObj = { id, els, addedAt: d?.addedAt ?? new Date().toISOString() };

      const title = el('span', { class: 'persona-title' });
      const size = el('span', { class: 'prompt-size' });
      const syncSummary = () => {
        title.textContent = els.name.value.trim() || '(unnamed document)';
        const tok = estimateTokens(els.text.value);
        size.textContent = tok ? `about ${fmtK(tok)} tokens` : '';
      };
      els.name.addEventListener('input', syncSummary);
      els.text.addEventListener('input', syncSummary);
      syncSummary();

      /*
       * Straight from disk, because the whole point is a file like DIGEST.md
       * that lives in a repo: pull it once here instead of once per chat.
       * Re-loading the same file later is how an updated document gets
       * refreshed - the library stores text, not a path, so nothing tracks
       * the file behind your back.
       */
      const fileBtn = el('button', { class: 'mini', title: 'Load a text file into this document, replacing its text.', onclick: (ev) => {
        ev.preventDefault();
        const input = el('input', { type: 'file', accept: '.md,.txt,.text,.markdown,text/*' });
        input.onchange = () => {
          const f = input.files?.[0];
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            els.text.value = String(reader.result ?? '');
            if (!els.name.value.trim()) els.name.value = f.name.replace(/[.](md|txt|text|markdown)$/i, '');
            syncSummary();
          };
          reader.readAsText(f);
        };
        input.click();
      } }, 'load file');

      const delBtn = el('button', { class: 'danger mini', title: 'Remove this document (press Save to keep the change)', onclick: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        rows.splice(rows.indexOf(rowObj), 1);
        row.remove();
      } }, '✕');

      const row = el('details', { class: 'persona-row' },
        el('summary', {}, title, size, el('span', { class: 'grow' }), fileBtn, delBtn),
        el('div', { class: 'col' },
          el('div', { class: 'row' }, el('label', {}, 'Name'), els.name),
          els.text));
      if (!d) row.open = true;
      rowsWrap.append(row);
      rows.push(rowObj);
    };

    const saveBtn = el('button', { class: 'primary' }, 'Save');
    const save = async () => {
      const documents = rows
        .filter((r) => r.els.name.value.trim() && r.els.text.value.trim())
        .map((r) => ({ id: r.id, name: r.els.name.value.trim(), text: r.els.text.value, addedAt: r.addedAt }));
      await Api.putDocuments(documents);
      App.documents = documents;
      saveBtn.textContent = 'Saved ✓';
      setTimeout(() => { saveBtn.textContent = 'Save'; }, 1600);
    };
    saveBtn.onclick = () => save().catch((e) => alert(e.message));

    for (const d of App.documents) addRow(d);

    return el('div', { class: 'settings-block' },
      el('div', { class: 'row' },
        el('label', {}, 'Documents (reference material to attach to conversations)'),
        el('span', { class: 'grow' }),
        el('button', { onclick: () => addRow() }, '+ add document'),
        saveBtn,
      ),
      rowsWrap,
    );
  },

};
