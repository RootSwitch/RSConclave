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
    scroll.append(this.buildAccount(), this.buildUsers(), this.buildEndpoints(), this.buildPersonas());
    this.root.append(scroll);
  },

  /* ---------- account (yours) ---------- */

  buildAccount() {
    const current = el('input', { type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
    const next = el('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
    const msg = el('span', { class: 'muted' });
    const changePassword = async () => {
      msg.textContent = '';
      try {
        await Api.changePassword(current.value, next.value);
        current.value = ''; next.value = '';
        msg.textContent = 'Changed. Other sessions were signed out.';
      } catch (err) { msg.textContent = err.message; }
    };
    onEnterSubmit([current, next], changePassword);
    return el('div', { class: 'settings-block' },
      el('div', { class: 'row' },
        el('label', {}, `Account: ${App.user}`),
        el('span', { class: 'grow' }),
      ),
      el('div', { class: 'row' },
        current, next,
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
      const delBtn = el('button', { class: 'danger', onclick: () => {
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
      onEnterSubmit([els.name], () => save().then(() => alert('saved')).catch((e) => alert(e.message)));
      const id = p?.id ?? 'ps' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const rowObj = { id, els };

      const title = el('span', { class: 'persona-title' });
      const preview = el('span', { class: 'persona-preview' });
      const syncSummary = () => {
        title.textContent = els.name.value.trim() || '(unnamed persona)';
        preview.textContent = els.prompt.value.trim().replace(/\s+/g, ' ');
      };
      els.name.addEventListener('input', syncSummary);
      els.prompt.addEventListener('input', syncSummary);
      syncSummary();

      const delBtn = el('button', { class: 'danger mini', title: 'Remove this persona', onclick: (ev) => {
        // inside a summary: without both, the click also toggles the fold
        ev.preventDefault();
        ev.stopPropagation();
        rows.splice(rows.indexOf(rowObj), 1);
        row.remove();
      } }, '✕');

      const row = el('details', { class: 'persona-row' },
        el('summary', {}, title, preview, el('span', { class: 'grow' }), delBtn),
        el('div', { class: 'col' },
          el('div', { class: 'row' }, el('label', {}, 'Name'), els.name),
          els.prompt));
      if (!p) row.open = true; // a persona you just added needs filling in
      rowsWrap.append(row);
      rows.push(rowObj);
    };

    const save = async () => {
      const personas = rows
        .filter((r) => r.els.name.value.trim())
        .map((r) => ({ id: r.id, name: r.els.name.value.trim(), systemPrompt: r.els.prompt.value }));
      await Api.putPersonas(personas);
      App.personas = personas;
    };

    for (const p of App.personas) addRow(p);

    return el('div', { class: 'settings-block' },
      el('div', { class: 'row' },
        el('label', {}, 'Personas (reusable base system prompts)'),
        el('span', { class: 'grow' }),
        el('button', { onclick: () => addRow() }, '+ add persona'),
        el('button', { class: 'primary', onclick: () => save().then(() => alert('saved')).catch((e) => alert(e.message)) }, 'Save'),
      ),
      rowsWrap,
    );
  },
};
