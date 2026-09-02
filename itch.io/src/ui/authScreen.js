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
  invalid_or_expired_token: 'This reset link is invalid or has expired. Request a new one.',
};

export class AuthScreen {
  /** @param {(user: object|null) => void} onDone called with the signed-in user, or null if dismissed. */
  constructor(onDone) {
    this.onDone = onDone;
    this.mode = 'login'; // 'login' | 'register' | 'forgot' | 'reset'
    this.resetToken = null; // set by showReset(); consumed on successful reset
    this.open = false;
    this.root = document.getElementById('auth-screen');
    this.build();
  }

  build() {
    this.panel = document.createElement('div');
    this.panel.className = 'portal-panel auth-panel';

    // A discreet way back to the portal without signing in — distinct from
    // `skip` below ("Continue without an account"), which reads as a choice
    // about the account itself, not as "I opened this by mistake." Matches
    // the same "← Back" affordance difficultyScreen.js/aiDifficultyScreen.js
    // now have, for the same reason: this used to be a one-way door.
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'auth-back';
    back.textContent = '← Back';
    back.addEventListener('click', () => this.close(null));
    this.panel.appendChild(back);

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

    // A second status line, separate from .auth-error, for the "check your
    // email" / "password changed" confirmations — those aren't failures and
    // shouldn't render in the error's red, or announce as role="alert".
    this.status = document.createElement('p');
    this.status.className = 'auth-status';
    this.status.hidden = true;
    this.form.appendChild(this.status);

    this.submitBtn = document.createElement('button');
    this.submitBtn.type = 'submit';
    this.submitBtn.className = 'auth-submit';
    this.form.appendChild(this.submitBtn);

    this.panel.appendChild(this.form);

    // Only ever shown on the login form — forgetting a password only makes
    // sense once there's a password to have forgotten.
    this.forgotLink = document.createElement('button');
    this.forgotLink.type = 'button';
    this.forgotLink.className = 'auth-toggle';
    this.forgotLink.textContent = 'Forgot password?';
    this.forgotLink.addEventListener('click', () => {
      this.mode = 'forgot';
      this.render();
    });
    this.panel.appendChild(this.forgotLink);

    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'auth-toggle';
    this.toggle.addEventListener('click', () => {
      // 'forgot'/'reset' both return to the sign-in form, not toggle to
      // 'register' — this button reads as "back" from either of those, and
      // as the login/register switch everywhere else.
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
    const { mode } = this;
    const copy = {
      login: {
        heading: 'Sign in',
        hint: 'Sign in to reach your cloud saves and online matches.',
        submit: 'Sign in',
        toggle: 'Need an account? Create one',
      },
      register: {
        heading: 'Create account',
        hint: 'An account stores your saves in the cloud and lets you play online.',
        submit: 'Create account',
        toggle: 'Already have an account? Sign in',
      },
      forgot: {
        heading: 'Reset password',
        hint: "Enter your account's email and we'll send a link to set a new password.",
        submit: 'Send reset link',
        toggle: 'Back to sign in',
      },
      reset: {
        heading: 'Set a new password',
        hint: 'Choose a new password for your account.',
        submit: 'Set new password',
        toggle: 'Back to sign in',
      },
    }[mode];

    this.heading.textContent = copy.heading;
    this.hint.textContent = copy.hint;
    this.submitBtn.textContent = copy.submit;
    this.toggle.textContent = copy.toggle;
    this.toggle.hidden = false;

    // Only the login form offers a way *into* 'forgot' — the other three
    // modes have nothing sensible for it to do.
    this.forgotLink.hidden = mode !== 'login';

    this.displayNameField.wrap.hidden = mode !== 'register';
    this.displayNameField.input.required = mode === 'register';

    // 'forgot' only needs the address to send a link to; 'reset' only needs
    // the new password (the account is identified by the URL token, not by
    // asking the person to re-enter their email).
    this.emailField.wrap.hidden = mode === 'reset';
    this.emailField.input.required = mode !== 'reset';
    this.passwordField.wrap.hidden = mode === 'forgot';
    this.passwordField.input.required = mode !== 'forgot';
    // A password manager should be offered a *new* password on register/reset
    // and the saved one on sign-in.
    this.passwordField.input.autocomplete =
      mode === 'register' || mode === 'reset' ? 'new-password' : 'current-password';

    this.error.hidden = true;
    this.status.hidden = true;
  }

  async submit() {
    const email = this.emailField.input.value.trim();
    const password = this.passwordField.input.value;
    const displayName = this.displayNameField.input.value.trim();

    this.submitBtn.disabled = true;
    this.error.hidden = true;
    this.status.hidden = true;

    try {
      if (this.mode === 'register') {
        this.close((await api.register(email, password, displayName)).user);
      } else if (this.mode === 'login') {
        this.close((await api.login(email, password)).user);
      } else if (this.mode === 'forgot') {
        await api.forgotPassword(email);
        // Same message whether or not the address has an account — the
        // server's response is already indistinguishable (see api.js), and
        // showing a different UI message here would defeat that.
        this.status.textContent = "If an account exists for that email, we've sent a reset link.";
        this.status.hidden = false;
        this.emailField.input.value = '';
      } else if (this.mode === 'reset') {
        await api.resetPassword(this.resetToken, password);
        this.resetToken = null;
        this.mode = 'login';
        this.render();
        this.status.textContent = 'Password changed. Sign in with your new password.';
        this.status.hidden = false;
      }
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

  /**
   * Reached from a mailed reset link (main.js reads `?resetToken=` off the
   * URL on load) — jumps straight to the "set new password" form rather than
   * making the player navigate there through sign-in first.
   */
  showReset(token) {
    this.mode = 'reset';
    this.resetToken = token;
    this.render();
    this.open = true;
    this.root.classList.remove('hidden');
    this.passwordField.input.focus();
  }

  close(user) {
    this.open = false;
    this.root.classList.add('hidden');
    this.passwordField.input.value = ''; // don't leave a password sitting in the DOM
    this.mode = 'login'; // next open always starts at sign-in, not wherever this one left off
    this.onDone?.(user);
  }
}
