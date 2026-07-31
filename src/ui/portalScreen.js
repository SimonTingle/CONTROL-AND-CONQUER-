/**
 * Landing screen, shown before anything else. Routes to one of the game's
 * three modes. "Multiplayer Online" has no destination yet — it swaps the
 * grid for a "Coming soon" message in place rather than firing onChoose, so
 * there is nothing downstream that has to pretend that mode works.
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
   *   mode's id — never called for 'multiplayer-online', which has no
   *   destination to route to yet.
   */
  constructor(onChoose) {
    this.onChoose = onChoose;
    this.root = document.getElementById('portal');
    this.open = true;
    this.buildGrid();
  }

  buildGrid() {
    const panel = document.createElement('div');
    panel.className = 'portal-panel';

    const h1 = document.createElement('h1');
    h1.textContent = 'Procedural Terrain';
    panel.appendChild(h1);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'Choose how you want to play.';
    panel.appendChild(hint);

    const grid = document.createElement('div');
    grid.className = 'portal-grid';

    for (const mode of PORTAL_MODES) {
      const card = document.createElement('button');
      card.className = 'portal-card';
      card.type = 'button';

      const name = document.createElement('span');
      name.className = 'portal-card-name';
      name.textContent = mode.name;
      card.appendChild(name);

      const blurb = document.createElement('span');
      blurb.className = 'portal-card-blurb';
      blurb.textContent = mode.blurb;
      card.appendChild(blurb);

      card.addEventListener('click', () => this.choose(mode.id));
      grid.appendChild(card);
    }

    panel.appendChild(grid);
    this.root.replaceChildren(panel);
  }

  choose(modeId) {
    if (!this.open) return;
    if (modeId === 'multiplayer-online') {
      this.showComingSoon();
      return;
    }
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
