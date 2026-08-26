/**
 * How the current match is going — one page of the left drawer.
 *
 * Live, not a post-mortem: everything here is read fresh off `game.teams` and
 * `vehicles.instances` on a timer while the page is open, so it is useful
 * mid-match rather than only at the end. matchEndScreen.js is the post-mortem
 * and stays that.
 *
 * Mode-aware rather than mode-selectable. Sandbox, Multiplayer AI and
 * Multiplayer Online differ only in how many teams exist and whether those
 * teams have player names behind them — and only one match exists at a time,
 * so there is nothing to switch between.
 *
 * **"Score" is harvest income**, `stats.harvesterEarningsTotal`, not
 * `stats.creditsEarned`. Those look interchangeable and are not: `Team.earn()`
 * is also credited for selling a structure back and for an AI build refund, so
 * creditsEarned counts credits that were never produced, and a build/sell loop
 * inflates it without harvesting anything. The screen says so in as many words
 * rather than leaving a number to be misread.
 *
 * Deliberately not sharing a table builder with matchEndScreen.js. That one
 * builds once, from data that has stopped changing, with fixed columns. This
 * one rebuilds on a timer against live data, substitutes player names, and
 * draws comparison bars. The only identical part is a few lines of header
 * construction; the real overlap is the `.match-summary` CSS class, and that
 * *is* shared.
 */

/** Seconds of real time between re-reads. Render-only state, so plain dt. */
const REFRESH_INTERVAL = 0.5;

export class StatisticsScreen {
  /**
   * @param {object} opts
   * @param {object} opts.game for `teams`, `mode` and `playerNames`
   * @param {object} opts.vehicles VehicleController — live harvesters, and
   *   `defOf` for turning a def id into a readable name
   * @param {object} opts.structures StructureController — `defOf` again, since
   *   a gun turret is a shooter too and can hold the top-kills record
   */
  constructor({ game, vehicles, structures }) {
    this.game = game;
    this.vehicles = vehicles;
    this.structures = structures;
    this.root = null;
    this.mounted = false;
    this._accum = 0;
  }

  mount(container) {
    this.root = document.createElement('div');
    this.root.className = 'stats-screen';
    container.appendChild(this.root);
    this.mounted = true;
    this._accum = 0;
    this._render();
  }

  unmount() {
    this.mounted = false;
    this.root = null;
  }

  update(dt) {
    if (!this.mounted) return;
    this._accum += dt;
    if (this._accum < REFRESH_INTERVAL) return;
    this._accum = 0;
    this._render();
  }

  // ---- rendering ----

  _render() {
    if (!this.root) return;
    const teams = this.game.teams ?? [];
    this.root.replaceChildren();

    if (!teams.length) {
      const empty = document.createElement('p');
      empty.className = 'hint stats-note';
      empty.textContent = 'No match in progress.';
      this.root.appendChild(empty);
      return;
    }

    this.root.append(
      this._section('Match', this._buildSummaryTable(teams)),
      this._section('Harvesters', this._buildHarvesterTable(teams)),
      this._section('Combat', this._buildKillsTable(teams))
    );

    const note = document.createElement('p');
    note.className = 'hint stats-note';
    note.textContent =
      'Score is credits harvested — what the economy actually produced. Sale and refund income is counted separately, under Earned.';
    this.root.appendChild(note);
  }

  _section(title, table) {
    const wrap = document.createElement('section');
    wrap.className = 'stats-section';
    const h = document.createElement('h2');
    h.textContent = title;
    wrap.append(h, table);
    return wrap;
  }

  /**
   * The name to show for a team. In an online match this is the player behind
   * it, when the server has told us; everywhere else it is the team's own name.
   * `Team.name` itself is never written — the minimap, HUD and radial menu go
   * on showing exactly what they showed before.
   */
  _labelFor(team) {
    const online = this.game.mode === 'multiplayer-online';
    return (online && this.game.playerNames?.[team.id]) || team.name;
  }

  _defName(defId) {
    return (
      this.vehicles.defOf(defId)?.name ??
      this.structures.defOf(defId)?.name ??
      defId
    );
  }

  _headerRow(labels) {
    const head = document.createElement('tr');
    for (const label of labels) {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    }
    return head;
  }

  _teamRow(team) {
    const row = document.createElement('tr');
    if (team.defeated) row.classList.add('defeated');
    const name = document.createElement('td');
    name.className = 'stats-team-cell';
    name.textContent = this._labelFor(team) + (team.defeated ? ' — out' : '');
    // The colour this team's tracers used, so the table reads back against
    // what was actually watched happening.
    name.style.color = `#${team.color.toString(16).padStart(6, '0')}`;
    row.appendChild(name);
    return row;
  }

  _table(headerLabels) {
    const table = document.createElement('table');
    table.className = 'match-summary stats-table';
    table.appendChild(this._headerRow(headerLabels));
    return table;
  }

  /**
   * A number, with a bar behind it scaled against the best value in its own
   * column. Comparison at a glance without a charting library — and because it
   * is a plain div behind the text, it simply stops being drawn on a narrow
   * screen (see style.css) rather than needing a mobile variant.
   */
  _statCell(value, max) {
    const td = document.createElement('td');
    td.className = 'stat-cell';
    if (max > 0 && value > 0) {
      const bar = document.createElement('div');
      bar.className = 'stat-cell-bar';
      bar.style.width = `${Math.min(100, (value / max) * 100)}%`;
      td.appendChild(bar);
    }
    const text = document.createElement('span');
    text.className = 'stat-cell-value';
    text.textContent = String(Math.round(value));
    td.appendChild(text);
    return td;
  }

  /**
   * Stats down the side, teams across the top — the transpose of how
   * matchEndScreen lays the same data out, and not a stylistic choice: this
   * table lives in a ~320px drawer, and a column per stat overflowed it at six
   * stats (measured, in a browser). Teams are few and stats will keep being
   * added, so the axis that grows has to be the vertical one. It also buys
   * room for real labels — "Structures built" rather than a glyph.
   */
  _buildSummaryTable(teams) {
    const rows = [
      { label: 'Score', get: (t) => t.stats.harvesterEarningsTotal },
      { label: 'Credits earned', get: (t) => t.stats.creditsEarned },
      { label: 'Units built', get: (t) => t.stats.unitsBuilt },
      { label: 'Units lost', get: (t) => t.stats.unitsLost },
      { label: 'Structures built', get: (t) => t.stats.structuresBuilt },
      { label: 'Structures lost', get: (t) => t.stats.structuresLost },
    ];

    const table = document.createElement('table');
    table.className = 'match-summary stats-table stats-table-transposed';

    const head = document.createElement('tr');
    head.appendChild(document.createElement('th')); // corner, above the labels
    for (const team of teams) {
      const th = document.createElement('th');
      th.textContent = this._labelFor(team);
      th.style.color = `#${team.color.toString(16).padStart(6, '0')}`;
      if (team.defeated) th.classList.add('stats-out');
      head.appendChild(th);
    }
    table.appendChild(head);

    for (const spec of rows) {
      const tr = document.createElement('tr');
      const label = document.createElement('td');
      label.className = 'stats-row-label';
      label.textContent = spec.label;
      tr.appendChild(label);
      // Scaled against the best team in this row, so a bar reads as "against
      // the leader at this stat" rather than against the biggest number on
      // screen — Score and Units built are not on comparable scales.
      const max = Math.max(0, ...teams.map(spec.get));
      for (const team of teams) tr.appendChild(this._statCell(spec.get(team), max));
      table.appendChild(tr);
    }
    return table;
  }

  _buildHarvesterTable(teams) {
    const table = this._table(['Team', 'Working', 'Lost', 'Total']);
    for (const team of teams) {
      const live = this.vehicles.instances
        .filter((v) => v.teamId === team.id && !v.dead && v.def.id === 'crystal-harvester')
        .map((v) => Math.round(v.creditsDelivered ?? 0))
        .sort((a, b) => b - a);
      const lost = [...team.stats.deadHarvesterEarnings]
        .map((n) => Math.round(n))
        .sort((a, b) => b - a);

      const row = this._teamRow(team);
      for (const list of [live, lost]) {
        const td = document.createElement('td');
        td.className = 'stats-list-cell';
        td.textContent = list.length ? list.join(' · ') : '—';
        row.appendChild(td);
      }
      const total = document.createElement('td');
      total.className = 'stats-total-cell';
      total.textContent = String(Math.round(team.stats.harvesterEarningsTotal));
      row.appendChild(total);
      table.appendChild(row);
    }
    return table;
  }

  _buildKillsTable(teams) {
    const table = this._table(['Team', 'Top unit', 'Best type']);
    for (const team of teams) {
      const row = this._teamRow(team);

      const top = team.stats.topKillsVehicle;
      const topCell = document.createElement('td');
      topCell.className = 'stats-list-cell';
      topCell.textContent = top ? `${this._defName(top.defId)} · ${top.kills}` : '—';
      row.appendChild(topCell);

      // Highest total across every unit of a type — a different question from
      // the single best individual above, and often a different answer.
      const best = Object.entries(team.stats.killsByDefId).sort((a, b) => b[1] - a[1])[0];
      const typeCell = document.createElement('td');
      typeCell.className = 'stats-list-cell';
      typeCell.textContent = best ? `${this._defName(best[0])} · ${best[1]}` : '—';
      row.appendChild(typeCell);

      table.appendChild(row);
    }
    return table;
  }
}
