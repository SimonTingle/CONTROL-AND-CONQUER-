/**
 * Landing screen, shown before anything else. Routes to one of the game's
 * three modes — all of which now have somewhere to go; Multiplayer Online
 * routes to the lobby, which handles "no backend" and "not signed in" itself
 * rather than the portal having to know about either.
 */
export const PORTAL_MODES = [
  {
    id: 'sandbox',
    name: 'Sandbox Test',
    blurb: 'Solo island. Build, harvest, explore — no opponents.',
  },
  {
    id: 'multiplayer-ai',
    name: 'Multiplayer AI',
    blurb: 'Compete against AI-controlled bases, all versus all.',
  },
  {
    id: 'multiplayer-online',
    name: 'Multiplayer Online',
    blurb: 'Play against other people over the network.',
  },
];

export class PortalScreen {
  /**
   * @param {(modeId: string) => void} onChoose called once, with the picked
   *   mode's id.
   * @param {object} [account] account UI wiring, all optional. Omitting it
   *   (or leaving `isConfigured` false) renders the portal exactly as before
   *   — this is the first screen every player sees, so a backend-less build
   *   must show no trace of an account affordance it cannot honour.
   * @param {boolean} [account.isConfigured] whether a backend is configured at all.
   * @param {() => object|null} [account.getAccount] current signed-in user, or null.
   * @param {() => void} [account.onSignIn] opens the sign-in/register overlay.
   * @param {() => void} [account.onSignOut] signs out.
   * @param {() => void} [account.onGodMode] opens the vehicle builder. Only
   *   ever reachable from the God Mode button, which renders for one account.
   */
  constructor(onChoose, account = {}) {
    this.onChoose = onChoose;
    this.account = account;
    this.root = document.getElementById('portal');
    this.open = true;
    this.buildGrid();
  }

  /** Call after sign-in/sign-out so the corner and God Mode's visibility both reflect the new state. */
  refreshAccount() {
    if (!this.accountBar) return;
    this.renderAccountBar();
    this.renderButtonRow();
  }

  renderAccountBar() {
    const { isConfigured, getAccount } = this.account;
    this.accountBar.replaceChildren();
    if (!isConfigured) return; // no backend: show nothing, exactly as before this feature existed

    const user = getAccount?.();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'portal-account-btn';
    if (user) {
      btn.textContent = `Signed in as ${user.displayName} · Sign out`;
      btn.addEventListener('click', () => this.account.onSignOut?.());
    } else {
      btn.textContent = 'Sign in / create account';
      btn.addEventListener('click', () => this.account.onSignIn?.());
    }
    this.accountBar.appendChild(btn);
  }

  /**
   * The five buttons pinned to the image's black lower third: sign-in,
   * the three mode buttons, and God Mode last — visible only for that one
   * account, since it isn't a general-purpose admin role yet.
   */
  renderButtonRow() {
    this.buttonRow.replaceChildren();

    const authBtn = document.createElement('button');
    authBtn.type = 'button';
    authBtn.className = 'portal-mode-btn';
    authBtn.textContent = 'Sign in / create account';
    authBtn.addEventListener('click', () => this.account.onSignIn?.());
    this.buttonRow.appendChild(authBtn);

    for (const mode of PORTAL_MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'portal-mode-btn';
      btn.textContent = mode.name;
      btn.addEventListener('click', () => this.choose(mode.id));
      this.buttonRow.appendChild(btn);
    }

    // God mode is now two apps rather than one, so it offers a choice instead
    // of launching straight into the vehicle builder. Listed as data so a
    // third app is one line here and one branch at the callback.
    const user = this.account.getAccount?.();
    if (user?.email === 'tingleteaching@gmail.com') {
      for (const app of GOD_MODE_APPS) {
        const godBtn = document.createElement('button');
        godBtn.type = 'button';
        godBtn.className = 'portal-mode-btn god-mode-btn';
        godBtn.textContent = app.label;
        godBtn.addEventListener('click', () => this.account.onGodMode?.(app.id));
        this.buttonRow.appendChild(godBtn);
      }
    }
  }

  buildGrid() {
    const panel = document.createElement('div');
    panel.className = 'portal-panel';

    this.accountBar = document.createElement('div');
    this.accountBar.className = 'portal-account-bar';
    this.renderAccountBar();
    panel.appendChild(this.accountBar);

    const h1 = document.createElement('h1');
    h1.textContent = 'Procedural Terrain';
    panel.appendChild(h1);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Choose how you want to play.';
    panel.appendChild(hint);

    this.buttonRow = document.createElement('div');
    this.buttonRow.className = 'portal-button-row';
    this.renderButtonRow();

    this.root.replaceChildren(panel, this.buttonRow);
  }

  choose(modeId) {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('hidden');
    this.onChoose?.(modeId);
  }

  showComingSoon() {
    const panel = document.createElement('div');
    panel.className = 'portal-panel';

    const h1 = document.createElement('h1');
    h1.textContent = 'Multiplayer Online';
    panel.appendChild(h1);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Networked play is not built yet — coming in a future update.';
    panel.appendChild(hint);

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'portal-card portal-back';
    back.textContent = 'Back';
    back.addEventListener('click', () => this.buildGrid());
    panel.appendChild(back);

    this.root.replaceChildren(panel);
  }
}

/**
 * The god-mode apps. `vehicle` is first and keeps the plain "God Mode" label
 * it has always had, so the button someone already knows does not move or
 * rename underneath them.
 */
const GOD_MODE_APPS = [
  { id: 'vehicle', label: 'God Mode' },
  { id: 'sound', label: 'Sound Creator' },
];
