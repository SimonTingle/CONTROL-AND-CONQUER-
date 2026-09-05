/**
 * Multiplayer AI setup, shown after the portal routes here.
 *
 * `unlockAt` mirrors DIFFICULTIES' pacing knob so this screen's picks fold
 * into the same base-station-unlock logic in main.js without a second code
 * path. `teamCount` and `buildDelaySeconds` are stored on the match config
 * for the AI-opponent system (see the roadmap) to consume once it exists —
 * choosing a card here does not spawn any AI today.
 */
export const AI_DIFFICULTIES = [
  { id: 'easy', name: 'Easy', unlockAt: 0.15, teamCount: 1, blurb: '1 AI base to compete against.' },
  { id: 'normal', name: 'Normal', unlockAt: 0.35, teamCount: 2, blurb: '2 AI bases, all versus all.' },
  { id: 'hard', name: 'Hard', unlockAt: 0.6, teamCount: 3, blurb: '3 AI bases, all versus all.' },
  { id: 'expert', name: 'Expert', unlockAt: 0.8, teamCount: 4, blurb: '4 AI bases, all versus all.' },
];

const DEFAULT_BUILD_DELAY = 30; // seconds before an AI base starts building, once implemented
const MIN_BUILD_DELAY = 0;
const MAX_BUILD_DELAY = 180;

export class AiDifficultyScreen {
  /**
   * @param {(config: { difficulty: object, teamCount: number, buildDelaySeconds: number }) => void} onChoose
   *   called once, with the picked difficulty plus the build-delay setting.
   * @param {() => void} [onBack] returns to the portal without choosing —
   *   optional so existing test/embedding call sites without a portal to
   *   return to still work.
   */
  constructor(onChoose, onBack) {
    this.onChoose = onChoose;
    this.onBack = onBack;
    this.root = document.getElementById('ai-difficulty');
    this.open = false;
    this.selected = AI_DIFFICULTIES[1];
    this.buildDelaySeconds = DEFAULT_BUILD_DELAY;
    this.build();
  }

  /** Revealed once the portal screen routes here — starts hidden behind it. */
  show() {
    this.open = true;
    this.root.classList.remove('hidden');
  }

  build() {
    const panel = document.createElement('div');
    panel.className = 'difficulty-panel';

    const h1 = document.createElement('h1');
    h1.textContent = 'Multiplayer AI — choose difficulty';
    panel.appendChild(h1);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'Higher difficulty adds more AI-controlled bases, evenly spaced around the island — every team, including yours, plays all versus all.';
    panel.appendChild(hint);

    const grid = document.createElement('div');
    grid.className = 'difficulty-grid ai-difficulty-grid';

    const cards = new Map();
    for (const d of AI_DIFFICULTIES) {
      const card = document.createElement('button');
      card.className = 'difficulty-card';
      card.type = 'button';

      const name = document.createElement('span');
      name.className = 'difficulty-card-name';
      name.textContent = d.name;
      card.appendChild(name);

      const target = document.createElement('span');
      target.className = 'difficulty-card-target';
      target.textContent = `${d.teamCount} AI ${d.teamCount === 1 ? 'team' : 'teams'}`;
      card.appendChild(target);

      const blurb = document.createElement('span');
      blurb.className = 'difficulty-card-blurb';
      blurb.textContent = d.blurb;
      card.appendChild(blurb);

      card.addEventListener('click', () => this.selectCard(d, cards));
      cards.set(d.id, card);
      grid.appendChild(card);
    }
    panel.appendChild(grid);
    this.selectCard(this.selected, cards);

    const delayRow = document.createElement('label');
    delayRow.className = 'ai-difficulty-delay';
    delayRow.textContent = 'AI build delay ';

    const readout = document.createElement('span');
    readout.className = 'readout';
    readout.textContent = `${this.buildDelaySeconds}s`;
    delayRow.appendChild(readout);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(MIN_BUILD_DELAY);
    slider.max = String(MAX_BUILD_DELAY);
    slider.step = '5';
    slider.value = String(this.buildDelaySeconds);
    slider.addEventListener('input', () => {
      this.buildDelaySeconds = parseInt(slider.value, 10);
      readout.textContent = `${this.buildDelaySeconds}s`;
    });
    delayRow.appendChild(slider);
    panel.appendChild(delayRow);

    const note = document.createElement('p');
    note.className = 'hint ai-difficulty-note';
    note.textContent = 'This starts a match against AI-controlled bases at the chosen difficulty.';
    panel.appendChild(note);

    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'difficulty-card ai-difficulty-start';
    start.textContent = 'Start Match';
    start.addEventListener('click', () => this.choose());
    panel.appendChild(start);

    // A discreet way out — clicking into this screen from the portal used to
    // be a one-way door; a reload was the only way back.
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'portal-card portal-back';
    back.textContent = '← Back';
    back.addEventListener('click', () => this.back());
    panel.appendChild(back);

    this.root.replaceChildren(panel);
  }

  selectCard(difficulty, cards) {
    this.selected = difficulty;
    for (const [id, card] of cards) card.classList.toggle('selected', id === difficulty.id);
  }

  choose() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('hidden');
    this.onChoose?.({
      difficulty: this.selected,
      teamCount: this.selected.teamCount,
      buildDelaySeconds: this.buildDelaySeconds,
    });
  }

  back() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('hidden');
    this.onBack?.();
  }
}
