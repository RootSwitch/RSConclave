// Login / first-run setup overlay. Full-screen and modal on purpose: nothing
// behind it is usable without a session anyway (every data route returns 401),
// so the overlay IS the app until you are signed in.
'use strict';

const Auth = {
  overlay: null,

  /** Resolve auth state; returns the username, or null after showing the overlay. */
  async check() {
    const s = await Api.getAuthSession();
    if (s.authenticated) return s.user;
    this.show(s.needsSetup);
    return null;
  },

  show(needsSetup) {
    this.hide();
    const err = el('div', { class: 'error-text' });
    const userEl = el('input', {
      placeholder: 'Username',
      value: needsSetup ? 'admin' : '',
      autocomplete: 'username',
    });
    const passEl = el('input', { type: 'password', placeholder: 'Password', autocomplete: needsSetup ? 'new-password' : 'current-password' });
    const pass2El = needsSetup
      ? el('input', { type: 'password', placeholder: 'Password again', autocomplete: 'new-password' })
      : null;

    const submit = async () => {
      err.textContent = '';
      if (needsSetup && passEl.value !== pass2El.value) {
        err.textContent = 'Passwords do not match.';
        return;
      }
      try {
        if (needsSetup) await Api.authSetup(userEl.value.trim(), passEl.value);
        else await Api.authLogin(userEl.value.trim(), passEl.value);
        // Full reload: SSE must reconnect with the new cookie, and every
        // cached per-user list (sessions, personas, presets) starts clean.
        location.reload();
      } catch (e) {
        err.textContent = e.message;
      }
    };
    for (const input of [userEl, passEl, pass2El]) {
      if (input) input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
    }

    this.overlay = el('div', { id: 'auth-overlay' },
      el('div', { class: 'auth-card' },
        el('div', { class: 'row', style: 'justify-content: center' },
          el('span', { class: 'brand-name', style: 'font-size: 16px; font-weight: 600' }, 'RSConclave')),
        el('div', { class: 'muted', style: 'text-align: center' },
          needsSetup
            ? 'No accounts exist yet. This first account claims the instance and adopts any existing sessions.'
            : 'Sign in to your sessions.'),
        userEl,
        passEl,
        pass2El,
        el('button', { class: 'primary', onclick: submit }, needsSetup ? 'Create account' : 'Sign in'),
        err,
      ),
    );
    document.body.append(this.overlay);
    (needsSetup ? userEl : userEl).focus();
  },

  hide() {
    this.overlay?.remove();
    this.overlay = null;
  },

  async logout() {
    try { await Api.authLogout(); } catch {}
    location.reload();
  },
};
