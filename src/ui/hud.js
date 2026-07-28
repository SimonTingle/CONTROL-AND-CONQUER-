/**
 * In-play HUD: the selected vehicle's health, and — while the scout is
 * selected — how much of the island is charted and how much is left before the
 * base station unlocks.
 *
 * Both top corners belong to the existing drawer buttons, so this lives bottom
 * left. It is refreshed from main.js's existing half-second stats tick rather
 * than every frame; nothing here changes fast enough to need 60 Hz.
 */
export class Hud {
  constructor() {
    this.root = document.getElementById('hud');
    this.build();
  }

  build() {
    this.name = el('div', 'hud-name');

    this.healthBar = el('div', 'hud-health-fill');
    const track = el('div', 'hud-health');
    track.appendChild(this.healthBar);
    this.healthLabel = el('div', 'hud-line');

    this.discovery = el('div', 'hud-discovery');
    this.discoveryValue = el('div', 'hud-discovery-value');
    this.unlockLine = el('div', 'hud-line');
    this.discovery.append(this.discoveryValue, this.unlockLine);

    this.root.replaceChildren(this.name, track, this.healthLabel, this.discovery);
  }

  /**
   * @param {object|null} vehicle the selected vehicle instance
   * @param {number} explored 0..1 of the island's land revealed
   * @param {object} difficulty the chosen difficulty entry
   * @param {boolean} unlocked whether the base station is already unlocked
   */
  update(vehicle, explored, difficulty, unlocked) {
    if (!vehicle) {
      this.root.classList.add('hidden');
      return;
    }
    this.root.classList.remove('hidden');

    this.name.textContent = vehicle.def.name;

    const max = vehicle.def.maxHealth;
    const pct = Math.max(0, Math.min(1, vehicle.health / max));
    this.healthBar.style.width = `${pct * 100}%`;
    this.healthLabel.textContent = `${Math.round(vehicle.health)} / ${max}`;

    // Discovery is the scout's job, so it is only worth screen space while the
    // scout is the one selected — and only until the unlock actually happens.
    const showDiscovery = vehicle.def.unlock === null;
    this.discovery.classList.toggle('hidden', !showDiscovery);
    if (!showDiscovery) return;

    this.discoveryValue.textContent = `${(explored * 100).toFixed(1)}% island charted`;

    if (unlocked) {
      this.unlockLine.textContent = 'Base Station unlocked';
      this.unlockLine.classList.add('hud-line-done');
    } else {
      const remaining = Math.max(0, difficulty.unlockAt - explored);
      this.unlockLine.textContent =
        `${(remaining * 100).toFixed(1)}% to unlock Base Station ` +
        `(${difficulty.name}: ${Math.round(difficulty.unlockAt * 100)}%)`;
      this.unlockLine.classList.remove('hud-line-done');
    }
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
