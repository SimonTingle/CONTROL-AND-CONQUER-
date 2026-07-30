import * as THREE from 'three';

/**
 * Radial command menu, anchored to a vehicle on screen.
 *
 * DOM buttons laid out on a circle rather than SVG arc segments. Arcs look the
 * part but cost per-path hit-testing, text-on-a-curve layout, and lose focus,
 * hover and disabled semantics that a `<button>` gives for free. A decorative
 * glowing ring carries the look; the buttons sit on it.
 *
 * The menu *follows* its vehicle rather than freezing where it opened —
 * anything else looks broken the moment the chase camera drifts or the vehicle
 * creeps. That makes this the first world-to-screen projection in the codebase:
 * the exact inverse of the NDC maths in core/pick.js.
 */

const RING_RADIUS = 96; // px from the anchor to the button centres
const CLOSE_SPEED = 0.5; // drive away faster than this and the menu closes

const _anchor = new THREE.Vector3();

export class RadialMenu {
  constructor(camera, { onCommand } = {}) {
    this.camera = camera;
    this.onCommand = onCommand;
    this.root = document.getElementById('radial-menu');
    this.instance = null;
    this.items = [];

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
  }

  get isOpen() {
    return this.instance !== null;
  }

  /**
   * @param {object} instance the vehicle to attach to
   * @param {Array} commands from commandsFor(); entries carry `enabledResult`
   */
  openFor(instance, commands) {
    this.instance = instance;
    this.items = commands;
    // Autonomous drivers watch this to hold position while the player decides —
    // without it the harvester's AI drives it away and update() shuts the menu.
    instance.menuOpen = true;

    const ring = el('div', 'rm-ring');
    const title = el('div', 'rm-title');
    title.textContent = instance.def.name;

    const nodes = [ring, title];

    commands.forEach((cmd, i) => {
      const button = el('button', 'rm-item');
      button.type = 'button';

      // Fan the entries around the top of the ring, so a single command sits
      // directly above the vehicle rather than off at 3 o'clock.
      const spread = Math.min(commands.length, 6);
      const angle = -Math.PI / 2 + (i - (spread - 1) / 2) * (Math.PI / 3.2);
      button.style.left = `${Math.cos(angle) * RING_RADIUS}px`;
      button.style.top = `${Math.sin(angle) * RING_RADIUS}px`;

      const label = el('span', 'rm-label');
      label.textContent = cmd.label;
      button.appendChild(label);

      const reason = typeof cmd.enabledResult === 'string' ? cmd.enabledResult : null;
      const sub = reason ?? cmd.hint;
      if (sub) {
        const subEl = el('span', 'rm-sub');
        subEl.textContent = sub;
        button.appendChild(subEl);
      }

      if (reason || cmd.enabledResult === false) {
        button.classList.add('disabled');
        button.disabled = true;
      } else {
        button.addEventListener('click', () => {
          const target = this.instance;
          this.close();
          this.onCommand?.(cmd, target);
        });
      }

      nodes.push(button);
    });

    this.root.replaceChildren(...nodes);
    this.root.classList.remove('hidden');
    // Position only. Going through update() here would run the drove-away check
    // against the speed the vehicle still has *this* instant — closing the menu
    // on the same call stack that opened it, before any tick has had a chance to
    // honour menuOpen and bring an autonomous vehicle to a stop.
    this._reposition();
  }

  close() {
    if (!this.isOpen) return;
    this.instance.menuOpen = false;
    this.instance = null;
    this.items = [];
    this.root.classList.add('hidden');
    this.root.replaceChildren();
  }

  /** Re-anchor to the vehicle, and retire the menu if it no longer applies. */
  update() {
    if (!this.isOpen) return;
    // Driving away is an implicit "never mind". Structures report zero.
    if (this.instance.speed > CLOSE_SPEED) return this.close();
    this._reposition();
  }

  /** Project the anchor to screen space and move the menu there. */
  _reposition() {
    const instance = this.instance;

    _anchor.copy(instance.group.position);
    _anchor.y += instance.menuAnchorHeight;
    _anchor.project(this.camera);

    // z > 1 means behind the camera, where projected x/y mirror nonsensically.
    if (_anchor.z > 1) return this.close();

    const x = (_anchor.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_anchor.y * 0.5 + 0.5) * window.innerHeight;
    this.root.style.transform = `translate(${x}px, ${y}px)`;
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
