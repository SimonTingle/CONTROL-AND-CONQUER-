/**
 * Multiplayer lobby — create or join a match, then wait for the host to start.
 *
 * Reuses the full-screen overlay shape of portalScreen/difficultyScreen rather
 * than inventing a third idiom, so it inherits their layout and styling and
 * only adds what a lobby genuinely needs: a list that refreshes, and a roster
 * that fills in while you wait.
 *
 * The lobby polls rather than holding a socket. The match socket is the
 * expensive, stateful thing and it should not exist until there is a match to
 * run — a player browsing lobbies has nothing to keep in sync.
 */

const POLL_MS = 2000;

export class LobbyScreen {
  /**
   * @param {object} opts
   * @param {object} opts.api the shared API client.
   * @param {(matchId: string) => void} opts.onStart the match is starting; join it.
   * @param {() => void} opts.onBack return to the portal.
   * @param {() => object|null} [opts.getAccount] the signed-in user, so a
   *   rejoined match can tell whether this client is its host. Optional so
   *   existing test/embedding call sites without an account concept still
   *   work — a rejoin then just never claims host status.
   */
  constructor({ api, onStart, onBack, getAccount }) {
    this.api = api;
    this.onStart = onStart;
    this.onBack = onBack;
    this.getAccount = getAccount;
    this.open = false;
    this.timer = null;
    /** The match we are sitting in, if any. */
    this.current = null;
    /**
     * Has `onStart` already fired for the match we are sitting in?
     *
     * Two independent races can otherwise fire it twice: the host's own click
     * in `start()` overlapping a poll's `refresh()` seeing `status === 'running'`
     * moments later, or two overlapping polls both seeing it (a slow request on
     * a bad connection). `onStart` runs `beginMatch`, which is purely additive —
     * it spawns starting forces without clearing anything — so a second call
     * doubles every vehicle on the board. This flag is the one thing both paths
     * check before calling it, and it is reset only when the lobby is opened
     * again for a fresh visit (`show()`), not by anything within one.
     */
    this.entered = false;

    this.root = document.createElement('div');
    this.root.id = 'lobby';
    this.root.className = 'hidden';
    this.panel = document.createElement('div');
    this.panel.className = 'portal-panel';
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);
  }

  show() {
    this.open = true;
    this.entered = false;
    this.root.classList.remove('hidden');
    this.checkForOwnMatch();
    this.startPolling();
  }

  /**
   * Look for a match this player is already part of before falling back to
   * the open-lobby browse list.
   *
   * `GET /matches` (behind `renderBrowser`) only ever lists `status = 'open'`
   * — correct for browsing, since a running match should not look joinable to
   * a stranger — but that left nothing else in its place. A match's id lived
   * only in this screen's own `current` field, which a page reload wipes.
   * Once that happened, mid-match, to *either* player, there was no path back
   * in for anyone — confirmed directly: reload a connected host's tab during a
   * live match and the guest's session stalls (by design, see `ws/match.js`'s
   * roster quorum) with nowhere to go. `/matches/mine` is what this reads.
   *
   * A network failure here must not block the lobby from opening at all —
   * this is a recovery path layered on top of the ordinary browse flow, not a
   * dependency of it.
   */
  async checkForOwnMatch() {
    let mine;
    try {
      mine = await this.api.getMyMatch();
    } catch {
      mine = null;
    }
    // The screen may have been closed, or this exact rejoin already completed
    // via the poll loop, while the request was in flight.
    if (!this.open || this.entered) return;
    if (mine?.match) {
      this.current = mine.match;
      this.isHost = mine.match.hostUserId === this.getAccount?.()?.id;
      if (mine.match.status === 'running') {
        this.entered = true;
        this.hide();
        this.onStart(mine.match.id);
        return;
      }
      this.renderRoom(mine.match, mine.players);
      return;
    }
    this.renderBrowser();
  }

  hide() {
    this.open = false;
    this.root.classList.add('hidden');
    this.stopPolling();
  }

  startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll: either the lobby list, or the roster of the match we are in. */
  async refresh() {
    if (!this.open) return;
    try {
      if (this.current) {
        const { match, players } = await this.api.getMatch(this.current.id);
        // Re-check after the await, not just before it: `hide()` (from a
        // click on `start()`, or from this same branch on an earlier poll)
        // cannot cancel a request already in flight, and this poll's result
        // is stale the moment either happens.
        if (!this.open || this.entered) return;
        this.current = match;
        // The host pressing Start is what everyone else is waiting on — it is
        // the only signal that moves a guest out of this screen.
        if (match.status === 'running') {
          this.entered = true;
          this.hide();
          this.onStart(match.id);
          return;
        }
        this.renderRoom(match, players);
      } else {
        this.renderBrowser(await this.api.listMatches());
      }
    } catch (err) {
      this.renderError(err);
    }
  }

  // --- views ---------------------------------------------------------------

  heading(text, sub) {
    const h = document.createElement('h1');
    h.textContent = text;
    this.panel.appendChild(h);
    if (sub) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = sub;
      this.panel.appendChild(p);
    }
  }

  button(label, onClick, { primary = false } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = primary ? 'action primary' : 'action';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  renderError(err) {
    this.panel.replaceChildren();
    this.heading('Multiplayer Online', 'Could not reach the server.');
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = err?.code === 'no_backend_configured'
      ? 'This build has no backend configured, so online play is unavailable.'
      : err?.code === 'authentication_required'
        ? 'Sign in from the portal to play online.'
        : (err?.message ?? 'Unknown error.');
    this.panel.appendChild(p);
    this.panel.appendChild(this.button('Back', () => { this.hide(); this.onBack(); }));
  }

  async renderBrowser(matches) {
    if (matches === undefined) {
      try {
        matches = await this.api.listMatches();
      } catch (err) {
        return this.renderError(err);
      }
    }
    this.panel.replaceChildren();
    this.heading('Multiplayer Online', 'Join an open match, or start your own.');

    const grid = document.createElement('div');
    grid.className = 'portal-grid';
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No open matches. Create one and wait for somebody to join.';
      this.panel.appendChild(empty);
    }
    for (const m of matches) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'portal-card';
      const name = document.createElement('div');
      name.className = 'portal-card-name';
      name.textContent = m.name;
      const blurb = document.createElement('div');
      blurb.className = 'portal-card-blurb';
      blurb.textContent =
        `${m.hostName ?? 'Someone'} · ${m.playerCount}/${m.maxPlayers} players` +
        (m.aiCount ? ` · ${m.aiCount} AI` : '');
      card.append(name, blurb);
      card.addEventListener('click', () => this.join(m.id));
      grid.appendChild(card);
    }
    this.panel.appendChild(grid);

    this.panel.appendChild(this.button('Create match', () => this.create(), { primary: true }));
    this.panel.appendChild(this.button('Back', () => { this.hide(); this.onBack(); }));
  }

  renderRoom(match, players) {
    this.panel.replaceChildren();
    this.heading(match.name, `Waiting for players — ${players.length}/${match.maxPlayers}`);

    const list = document.createElement('div');
    list.className = 'portal-grid';
    for (const p of players) {
      const card = document.createElement('div');
      card.className = 'portal-card';
      const name = document.createElement('div');
      name.className = 'portal-card-name';
      name.textContent = p.displayName ?? 'Player';
      const blurb = document.createElement('div');
      blurb.className = 'portal-card-blurb';
      blurb.textContent = `Team ${p.teamId}`;
      card.append(name, blurb);
      list.appendChild(card);
    }
    this.panel.appendChild(list);

    // Only the host can start, and the server enforces that independently — the
    // button is hidden for guests as a courtesy, not as the security boundary.
    if (this.isHost) {
      const start = this.button('Start match', () => this.start(), { primary: true });
      // Starting alone is legal (the other seats fill with AI), so this is never
      // disabled — a host who wants a solo run against AI can have one.
      this.panel.appendChild(start);
    } else {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'Waiting for the host to start the match…';
      this.panel.appendChild(hint);
    }
    this.panel.appendChild(this.button('Leave', () => this.leave()));
  }

  // --- actions -------------------------------------------------------------

  async create() {
    try {
      const match = await this.api.createMatch({
        name: 'Skirmish',
        maxPlayers: 2,
        aiCount: 0,
        difficultyId: 'normal',
      });
      this.current = match;
      this.isHost = true;
      await this.refresh();
    } catch (err) {
      this.renderError(err);
    }
  }

  async join(id) {
    try {
      const { match } = await this.api.joinMatch(id);
      this.current = match;
      this.isHost = false;
      await this.refresh();
    } catch (err) {
      this.renderError(err);
    }
  }

  async start() {
    // Set before the request, not after: a poll's `refresh()` can observe
    // `status === 'running'` and race to call `onStart` itself while this
    // request is still in flight (the host's own click is what flips that
    // status). `entered` is the one guard both paths share.
    if (this.entered) return;
    this.entered = true;
    try {
      await this.api.startMatch(this.current.id);
      const id = this.current.id;
      this.hide();
      this.onStart(id);
    } catch (err) {
      this.entered = false; // the attempt failed; a retry must be allowed to fire
      this.renderError(err);
    }
  }

  async leave() {
    const id = this.current?.id;
    this.current = null;
    this.isHost = false;
    if (id) {
      try {
        await this.api.leaveMatch(id);
      } catch { /* leaving a match that is already gone is not a failure */ }
    }
    this.renderBrowser();
  }
}
