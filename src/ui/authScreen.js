/**
 * Sign in / create account overlay.
 *
 * Follows portalScreen.js's pattern (a full-screen overlay that builds its own
 * DOM and hides itself on completion) rather than introducing a second UI
 * idiom.
 *
 * Signing in is **optional** everywhere. This screen is only reached
 * deliberately — from the settings drawer, or from a cloud feature that needs
 * an account — and always offers a way to carry on without one. The game has
 * always been playable offline and must stay that way.
 */

import { api, ApiError } from '../net/api.js';

/** Server error codes → something a person can act on. */
const MESSAGES = {
  invalid_credentials: 'That email and password combination is not recognised.',
  email_taken: 'An account with that email already exists. Try signing in instead.',
  invalid_input: 'Check the highlighted fields and try again.',
  network_unreachable: 'Cannot reach the server. You can keep playing offline.',
  no_backend_configured: 'This build has no account server configured.',
  authentication_required: 'Please sign in again.',
};

export class AuthScreen {
  /** @param {(user: object|null) => void} onDone called with the signed-in user, or null if dismissed. */
  constructor(onDone) {
    this.onDone = onDone;
    this.mode = 'login'; // 'login' | 'register'
    this.open = false;
    this.root = document.getElementById('auth-screen');
    this.build();
  }

  build() {
    this.panel = document.createElement('div');
    this.panel.className = 'portal-panel auth-panel';

    this.heading = document.createElement('h1');
    this.panel.appendChild(this.heading);

    this.hint = document.createElement('p');
    this.hint.className = 'hint';
    this.panel.appendChild(this.hint);

    this.form = document.createElement('form');
    this.form.className = 'auth-form';
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });

    this.displayNameField = this.field('Display name', 'text', 'nickname');
    this.emailField = this.field('Email', 'email', 'email');
    this.passwordField = this.field('Password', 'password', 'current-password');

    this.form.append(this.displayNameField.wrap, this.emailField.wrap, this.passwordField.wrap);

    this.error = document.createElement('p');
    this.error.className = 'auth-error';
    this.error.hidden = true;
    // Announce failures to screen readers — a visually obvious red message is
    // invisible to anyone not looking at it.
    this.error.setAttribute('role', 'alert');
    this.form.appendChild(this.error);

    this.submitBtn = document.createElement('button');
    this.submitBtn.type = 'submit';
    this.submitBtn.className = 'auth-submit';
    this.form.appendChild(this.submitBtn);

    this.panel.appendChild(this.form);

    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'auth-toggle';
    this.toggle.addEventListener('click', () => {
      this.mode = this.mode === 'login' ? 'register' : 'login';
      this.render();
    });
    this.panel.appendChild(this.toggle);

    // The escape hatch that keeps accounts genuinely optional.
    this.skip = document.createElement('button');
    this.skip.type = 'button';
    this.skip.className = 'auth-skip';
    this.skip.textContent = 'Continue without an account';
    this.skip.addEventListener('click', () => this.close(null));
    this.panel.appendChild(this.skip);

    this.root.appendChild(this.panel);
    this.render();
  }

  field(labelText, type, autocomplete) {
    const wrap = document.createElement('label');
    wrap.className = 'auth-field';

    const span = document.createElement('span');
    span.textContent = labelText;

    const input = document.createElement('input');
    input.type = type;
    input.autocomplete = autocomplete;
    input.required = true;

    wrap.append(span, input);
    return { wrap, input };
  }

  render() {
    const registering = this.mode === 'register';
    this.heading.textContent = registering ? 'Create account' : 'Sign in';
    this.hint.textContent = registering
      ? 'An account stores your saves in the cloud and lets you play online.'
      : 'Sign in to reach your cloud saves and online matches.';
    this.submitBtn.textContent = registering ? 'Create account' : 'Sign in';
    this.toggle.textContent = registering
      ? 'Already have an account? Sign in'
      : 'Need an account? Create one';

    this.displayNameField.wrap.hidden = !registering;
    this.displayNameField.input.required = registering;
    // A password manager should be offered a *new* password on the register
    // form and the saved one on the sign-in form.
    this.passwordField.input.autocomplete = registering ? 'new-password' : 'current-password';

    this.error.hidden = true;
  }

  async submit() {
    const email = this.emailField.input.value.trim();
    const password = this.passwordField.input.value;
    const displayName = this.displayNameField.input.value.trim();

    this.submitBtn.disabled = true;
    this.error.hidden = true;

    try {
      const { user } =
        this.mode === 'register'
          ? await api.register(email, password, displayName)
          : await api.login(email, password);
      this.close(user);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'request_failed';
      // Password length is the one rejection worth spelling out, since the
      // requirement isn't visible until you trip it.
      const lengthProblem = err instanceof ApiError && err.details?.password?.length;
      this.error.textContent = lengthProblem
        ? 'Password must be at least 12 characters.'
        : (MESSAGES[code] ?? 'Something went wrong. Please try again.');
      this.error.hidden = false;
    } finally {
      this.submitBtn.disabled = false;
    }
  }

  show() {
    this.open = true;
    this.root.classList.remove('hidden');
    this.emailField.input.focus();
  }

  close(user) {
    this.open = false;
    this.root.classList.add('hidden');
    this.passwordField.input.value = ''; // don't leave a password sitting in the DOM
    this.onDone?.(user);
  }
}
