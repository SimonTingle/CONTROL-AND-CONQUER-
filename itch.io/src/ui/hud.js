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
    // Three independent blocks, each with its own visibility rule. Deliberately
    // no early returns anywhere in update(): the previous shape hid everything
    // when nothing was selected and skipped everything after health for
    // non-scouts, which made "add a block and watch it silently vanish" the
    // default outcome.
    this.economy = el('div', 'hud-economy');
    this.creditsValue = el('div', 'hud-credits');
    this.economy.append(this.creditsValue);

    this.selection = el('div', 'hud-selection');
    this.name = el('div', 'hud-name');
    this.healthBar = el('div', 'hud-health-fill');
    const health = el('div', 'hud-health');
    health.appendChild(this.healthBar);
    this.healthLabel = el('div', 'hud-line');
    this.selection.append(this.name, health, this.healthLabel);

    this.load = el('div', 'hud-load');
    this.loadBar = el('div', 'hud-load-fill');
    const loadTrack = el('div', 'hud-load-track');
    loadTrack.appendChild(this.loadBar);
    this.loadLabel = el('div', 'hud-line');
    this.load.append(loadTrack, this.loadLabel);

    this.discovery = el('div', 'hud-discovery');
    this.discoveryValue = el('div', 'hud-discovery-value');
    this.unlockLine = el('div', 'hud-line');
    this.discovery.append(this.discoveryValue, this.unlockLine);

    this.root.replaceChildren(this.economy, this.selection, this.load, this.discovery);
  }

  /**
   * One options object rather than a growing positional list.
   *
   * @param {object} o
   * @param {object|null} o.vehicle the selected vehicle or structure
   * @param {number} o.explored 0..1 of the island's land revealed
   * @param {object} o.difficulty the chosen difficulty entry
   * @param {boolean} o.unlocked whether the base station is already unlocked
   * @param {number} o.credits current balance
   * @param {boolean} o.economyActive whether there is an economy to report yet
   * @param {number} o.load cargo aboard the selected vehicle
   */
  /**
   * Just the health bar, split out so it can run every frame.
   *
   * The rest of `update` is polled twice a second, which is ample for a
   * percentage or a credit balance but far too slow once something is being
   * shot: at that cadence a unit can take several hits — or die outright —
   * between readings, so the bar appears to jump or never move at all. Health
   * is the one number that has to track the simulation frame for frame.
   */
  updateHealth(vehicle) {
    if (!vehicle) return;
    const max = vehicle.def.maxHealth;
    const pct = Math.max(0, Math.min(1, vehicle.health / max));
    this.healthBar.style.width = `${pct * 100}%`;
    this.healthLabel.textContent = `${Math.round(vehicle.health)} / ${max}`;
    // Reads as damage at a glance without needing the number.
    this.healthBar.classList.toggle('hud-health-critical', pct <= 0.3);
  }

  update({ vehicle, explored, difficulty, unlocked, credits = 0, economyActive = false, load = 0 }) {
    const capacity = vehicle?.def?.capacity ?? 0;
    // Discovery is the scout's job, so it only earns screen space while the
    // scout is the one selected.
    const showDiscovery = !!vehicle && vehicle.def.unlock === null;

    this.economy.classList.toggle('hidden', !economyActive);
    this.selection.classList.toggle('hidden', !vehicle);
    this.load.classList.toggle('hidden', !capacity);
    this.discovery.classList.toggle('hidden', !showDiscovery);
    // The panel itself only disappears when literally nothing has content.
    this.root.classList.toggle('hidden', !economyActive && !vehicle);

    if (economyActive) {
      this.creditsValue.textContent = `${Math.floor(credits)} cr`;
    }

    if (vehicle) {
      this.name.textContent = vehicle.def.name;
      this.updateHealth(vehicle);
    }

    if (capacity) {
      this.loadBar.style.width = `${Math.min(1, load / capacity) * 100}%`;
      this.loadLabel.textContent = `cargo ${Math.round(load)} / ${capacity}`;
    }

    if (showDiscovery) {
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
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
