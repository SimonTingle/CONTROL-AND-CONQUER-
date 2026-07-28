/**
 * Difficulty select, shown once before play.
 *
 * All a difficulty currently does is set how much of the island the scout has
 * to reveal before the base station unlocks — so it is deliberately one number
 * per entry rather than a bag of multipliers nothing reads yet.
 */
export const DIFFICULTIES = [
  {
    id: 'easy',
    name: 'Easy',
    unlockAt: 0.15,
    blurb: 'A short survey and the base station is yours.',
  },
  {
    id: 'normal',
    name: 'Normal',
    unlockAt: 0.35,
    blurb: 'Map a good third of the island before reinforcements.',
  },
  {
    id: 'hard',
    name: 'Hard',
    unlockAt: 0.6,
    blurb: 'Most of the coast and the interior. Bring headlights.',
  },
];

export class DifficultyScreen {
  /**
   * @param {(difficulty: object) => void} onChoose called once, with the picked entry
   */
  constructor(onChoose) {
    this.onChoose = onChoose;
    this.root = document.getElementById('difficulty');
    this.open = true;
    this.build();
  }

  build() {
    const panel = document.createElement('div');
    panel.className = 'difficulty-panel';

    const h1 = document.createElement('h1');
    h1.textContent = 'Choose difficulty';
    panel.appendChild(h1);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'The island starts uncharted. Drive the scout to reveal it — the base station unlocks once enough of it is mapped.';
    panel.appendChild(hint);

    const grid = document.createElement('div');
    grid.className = 'difficulty-grid';

    for (const d of DIFFICULTIES) {
      const card = document.createElement('button');
      card.className = 'difficulty-card';
      card.type = 'button';

      const name = document.createElement('span');
      name.className = 'difficulty-card-name';
      name.textContent = d.name;
      card.appendChild(name);

      const target = document.createElement('span');
      target.className = 'difficulty-card-target';
      target.textContent = `${Math.round(d.unlockAt * 100)}% explored`;
      card.appendChild(target);

      const blurb = document.createElement('span');
      blurb.className = 'difficulty-card-blurb';
      blurb.textContent = d.blurb;
      card.appendChild(blurb);

      card.addEventListener('click', () => this.choose(d));
      grid.appendChild(card);
    }

    panel.appendChild(grid);
    this.root.replaceChildren(panel);
  }

  choose(difficulty) {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('hidden');
    this.onChoose?.(difficulty);
  }
}
