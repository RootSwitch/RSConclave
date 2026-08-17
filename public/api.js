// Fetch wrappers for every server endpoint.
'use strict';

const Api = {
  async _json(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Session expired or revoked mid-use: show the login overlay instead of
      // scattering "not signed in" alerts across whatever the user clicked.
      // The auth endpoints themselves are exempt so a wrong password renders
      // as a message in the form, not a fresh overlay.
      if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/session') &&
          !url.startsWith('/api/password') && typeof Auth !== 'undefined') {
        Auth.show(false);
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  },
  _post(url, body) {
    return this._json(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  },
  _put(url, body) {
    return this._json(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  getAuthSession: () => Api._json('/api/session'),
  authSetup: (username, password) => Api._post('/api/setup', { username, password }),
  authLogin: (username, password) => Api._post('/api/login', { username, password }),
  authLogout: () => Api._post('/api/logout'),
  changePassword: (current, next) => Api._post('/api/password', { current, next }),
  listAccounts: () => Api._json('/api/users'),
  addAccount: (username, password) => Api._post('/api/users', { username, password }),
  deleteAccount: (username) => Api._json(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),

  getConfig: () => Api._json('/api/config'),
  putConfig: (cfg) => Api._put('/api/config', cfg),
  getPersonas: () => Api._json('/api/personas'),
  putPersonas: (list) => Api._put('/api/personas', list),
  getPresets: () => Api._json('/api/presets'),
  putPresets: (p) => Api._put('/api/presets', p),
  getModels: (endpointId) => Api._json(`/api/models?endpointId=${encodeURIComponent(endpointId)}`),
  getModelInfo: (endpointId) => Api._json(`/api/model-info?endpointId=${encodeURIComponent(endpointId)}`),

  listSessions: () => Api._json('/api/sessions'),
  searchSessions: (q) => Api._json(`/api/search?q=${encodeURIComponent(q)}`),
  getSession: (id) => Api._json(`/api/sessions/${id}`),
  deleteSession: (id) => Api._json(`/api/sessions/${id}`, { method: 'DELETE' }),
  deleteSessions: (ids) => Api._post('/api/sessions/delete', { ids }),
  resumeSession: (id) => Api._post(`/api/sessions/${id}/resume`),
  forkSession: (id, entryId) => Api._post(`/api/sessions/${id}/fork`, { entryId }),
  importSession: (session) => Api._post('/api/sessions/import', session),
  setTags: (id, tags) =>
    Api._json(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
    }),

  councilStart: (config) => Api._post('/api/council/start', config),
  councilRerunMember: (sessionId, memberIndex) => Api._post('/api/council/rerun-member', { sessionId, memberIndex }),
  councilConsolidate: (sessionId, template, endpointId, model, params) =>
    Api._post('/api/council/consolidate', { sessionId, template, endpointId, model, params }),
  councilFollowup: (sessionId, prompt) => Api._post('/api/council/followup', { sessionId, prompt }),

  rtStart: (config) => Api._post('/api/roundtable/start', config),
  rtSystemPrompts: (config) => Api._post('/api/roundtable/system-prompts', config),
  rtStep: (nextParticipantId, auto) => Api._post('/api/roundtable/step', { nextParticipantId, auto }),
  rtInject: (text, as) => Api._post('/api/roundtable/inject', { text, as }),
  rtReroll: () => Api._post('/api/roundtable/reroll'),
  rtPause: () => Api._post('/api/roundtable/pause'),
  rtStop: () => Api._post('/api/roundtable/stop'),
  rtHumanTurn: (participantId, text) => Api._post('/api/roundtable/human-turn', { participantId, text }),
  rtConsolidate: (sessionId, endpointId, model, template, params) =>
    Api._post('/api/roundtable/consolidate', { sessionId, endpointId, model, template, params }),

  // stop applies to whatever run is active, not just roundtables
  stopRun: () => Api._post('/api/run/stop'),

  chatStart: (config) => Api._post('/api/chat/start', config),
  chatSend: (text) => Api._post('/api/chat/send', { text }),
  chatRegenerate: () => Api._post('/api/chat/regenerate'),
  chatContinue: () => Api._post('/api/chat/continue'),

  pipelineStart: (config) => Api._post('/api/pipeline/start', config),
  pipelineRerun: (sessionId, stageIndex) => Api._post('/api/pipeline/rerun', { sessionId, stageIndex }),

  renameSession: (id, title) =>
    Api._json(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  getPs: () => Api._json('/api/ps'),

  cancel: () => Api._post('/api/cancel'),
  councilSkip: () => Api._post('/api/council/skip'),
  getState: () => Api._json('/api/state'),
};
