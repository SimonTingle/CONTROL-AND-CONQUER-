/**
 * Victory / defeat, plus what happened.
 *
 * The same full-screen overlay shape as portalScreen and difficultyScreen —
 * a root div toggled with `.hidden`, built once, shown on demand — rather
 * than a HUD block, because it ends the match rather than reporting on one in
 * progress.
 */
export class MatchEndScreen {
  /** @param {() => void} onPlayAgain returns the player to the portal. */
  constructor(onPlayAgain) {
    this.onPlayAgain = onPlayAgain;
    this.root = document.getElementById('match-end');
    this.open = false;
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.playerWon
   * @param {object|null} opts.winner the surviving Team, or null if the
   *   player was eliminated and someone else is still playing
   * @param {Array} opts.teams every team, for the summary table
   */
  show({ playerWon, winner, teams }) {
    if (this.open) return; // a match ends once
    this.open = true;

    const panel = document.createElement('div');
    panel.className = 'portal-panel match-end-panel';

    const h1 = document.createElement('h1');
    h1.textContent = playerWon ? 'Victory' : 'Defeat';
    h1.className = playerWon ? 'match-end-win' : 'match-end-lose';
    panel.appendChild(h1);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = playerWon
      ? 'Every other base on the island is gone.'
      : winner
        ? `${winner.name} took the island.`
        : 'Your base station was destroyed.';
    panel.appendChild(hint);

    panel.appendChild(this._buildSummary(teams));

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'portal-card portal-back';
    again.textContent = 'Play Again';
    again.addEventListener('click', () => this.onPlayAgain?.());
    panel.appendChild(again);

    this.root.replaceChildren(panel);
    this.root.classList.remove('hidden');
  }

  _buildSummary(teams) {
    const table = document.createElement('table');
    table.className = 'match-summary';

    const head = document.createElement('tr');
    for (const label of ['Team', 'Earned', 'Built', 'Lost', 'Buildings']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.appendChild(th);
    }
    table.appendChild(head);

    for (const team of teams) {
      const row = document.createElement('tr');
      if (team.defeated) row.classList.add('defeated');

      const name = document.createElement('td');
      name.textContent = team.name + (team.defeated ? ' — eliminated' : '');
      // The same colour the team's tracers used, so the table reads back
      // against what the player actually watched happen.
      name.style.color = `#${team.color.toString(16).padStart(6, '0')}`;
      row.appendChild(name);

      for (const value of [
        Math.round(team.stats.creditsEarned),
        team.stats.unitsBuilt,
        team.stats.unitsLost,
        team.stats.structuresBuilt,
      ]) {
        const td = document.createElement('td');
        td.textContent = String(value);
        row.appendChild(td);
      }
      table.appendChild(row);
    }
    return table;
  }
}
