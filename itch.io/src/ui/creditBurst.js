/**
 * The flourish that plays when your team collects a bounty coin: the value
 * rises off the collecting vehicle, gold dust streaks across the screen to the
 * HUD's credit box, and the number flashes as it lands.
 *
 * **DOM, not 3D, and deliberately.** The effect's whole job is to connect a
 * point in the world to a point in the *interface*, and the HUD is DOM sitting
 * on top of the canvas. World particles could only ever fade out somewhere
 * near the edge of the screen and imply the rest; these actually arrive. It
 * also sidesteps depth sorting against terrain entirely, and it inherits the
 * HUD's own gold (`#f0c65a`, `.hud-credits` in style.css) rather than
 * maintaining a second copy of it in a material.
 *
 * **It is told when to fire; it never watches the number.** `hud.update` polls
 * credits on a half-second timer, so a flash driven by noticing the total had
 * changed would fire late, fire for harvester income too, and miss two
 * collections inside one poll window. The sim's collection hook calls
 * `play()` directly instead.
 *
 * Purely presentational: the credits were already awarded by the simulation
 * before this runs, so nothing here can desync a match. It is also the reason
 * `Math.random` and `performance.now` are fine in this file and not in
 * `vehicles/bounty.js`.
 */

/** Dust particles per collection. */
const PARTICLE_COUNT = 12;
/** Milliseconds for the dust to reach the HUD. */
const FLIGHT_MS = 620;
/** Milliseconds the rising "+N cr" label is on screen. */
const LABEL_MS = 1100;

export class CreditBurst {
  /**
   * @param {HTMLElement} target the element the dust flies to and that flashes
   *   on arrival — the HUD's `.hud-credits`
   */
  constructor(target) {
    this.target = target;
    this.layer = document.createElement('div');
    this.layer.className = 'credit-burst-layer';
    document.body.appendChild(this.layer);
  }

  /**
   * @param {number} value credits collected
   * @param {{x: number, y: number}} screen where on screen the coin was, in
   *   CSS pixels. The caller projects it — this file knows nothing about
   *   cameras.
   */
  play(value, screen) {
    // Off-screen collections still credit the player, but throwing dust in
    // from beyond the viewport just draws the eye to nothing. The HUD flash
    // still fires, so the credits are never silent.
    const onScreen =
      screen &&
      screen.x >= 0 &&
      screen.y >= 0 &&
      screen.x <= window.innerWidth &&
      screen.y <= window.innerHeight;

    if (onScreen) {
      this._label(value, screen);
      this._dust(screen);
    }
    // Delayed to the moment the dust arrives, so the number visibly reacts to
    // it rather than changing while the particles are still in the air.
    setTimeout(() => this._flash(), onScreen ? FLIGHT_MS : 0);
  }

  _label(value, screen) {
    const label = document.createElement('div');
    label.className = 'credit-burst-label';
    label.textContent = `+${value} cr`;
    label.style.left = `${screen.x}px`;
    label.style.top = `${screen.y}px`;
    this.layer.appendChild(label);
    // `animationend` rather than a timer: if the browser throttles the
    // animation (a backgrounded tab), the node is still removed when the
    // animation it is waiting on actually finishes.
    label.addEventListener('animationend', () => label.remove(), { once: true });
    // Belt and braces — a tab that never runs the animation at all would
    // otherwise leak the node.
    setTimeout(() => label.remove(), LABEL_MS * 2);
  }

  _dust(screen) {
    const box = this.target?.getBoundingClientRect();
    if (!box) return;
    const destX = box.left + box.width / 2;
    const destY = box.top + box.height / 2;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const dot = document.createElement('div');
      dot.className = 'credit-burst-dot';
      // Scattered start and staggered launch, so the dust reads as a spray
      // rather than a single object smeared into twelve copies.
      const spread = 26;
      const sx = screen.x + (Math.random() - 0.5) * spread;
      const sy = screen.y + (Math.random() - 0.5) * spread;
      dot.style.left = `${sx}px`;
      dot.style.top = `${sy}px`;
      // The curve. A straight line to the HUD looks like a UI transition; an
      // arc looks like something was thrown. Each particle gets its own
      // control point, which is what keeps the streak from collapsing into a
      // single line.
      const midX = (sx + destX) / 2 + (Math.random() - 0.5) * 220;
      const midY = Math.min(sy, destY) - 60 - Math.random() * 120;
      dot.style.setProperty('--mx', `${midX - sx}px`);
      dot.style.setProperty('--my', `${midY - sy}px`);
      dot.style.setProperty('--dx', `${destX - sx}px`);
      dot.style.setProperty('--dy', `${destY - sy}px`);
      dot.style.animationDelay = `${Math.random() * 90}ms`;
      this.layer.appendChild(dot);
      dot.addEventListener('animationend', () => dot.remove(), { once: true });
      setTimeout(() => dot.remove(), FLIGHT_MS * 3);
    }
  }

  _flash() {
    const t = this.target;
    if (!t) return;
    // Removed and re-added on the next frame rather than just re-added: the
    // class is already there when two coins land back to back, and the browser
    // will not restart an animation for a class that never left.
    t.classList.remove('credit-flash');
    requestAnimationFrame(() => t.classList.add('credit-flash'));
    t.addEventListener('animationend', () => t.classList.remove('credit-flash'), { once: true });
  }
}
