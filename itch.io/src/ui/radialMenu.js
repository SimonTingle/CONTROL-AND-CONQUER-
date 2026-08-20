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
// The ring's on-screen size is entirely CSS+JS geometry (RING_RADIUS above,
// .rm-ring's own px width) with no stylesheet hook to shrink it from — a
// 196px ring is comfortable on a desktop pointer and dominates a phone
// screen. Scaled in update() by appending to the same transform already set
// there each frame, rather than a second property, since a plain CSS rule
// can't reach an inline style JS overwrites wholesale every call.
const MOBILE_RING = matchMedia('(max-width: 480px)');
const MOBILE_RING_SCALE = 0.72;

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

      // Spread commands evenly around the full circle. Two commands sit left-right
      // (0° and 180°); six spread 60° apart.
      const spread = commands.length;
      const angle = (i / spread) * Math.PI * 2;
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

    // On mobile, hints only show when the user holds a finger on the button.
    // On desktop, :hover in CSS handles it.
    const isMobile = navigator.maxTouchPoints > 0;
    if (isMobile) {
      for (const button of this.root.querySelectorAll('.rm-item:not(.disabled)')) {
        let hintTimer = null;
        button.addEventListener('pointerdown', () => {
          hintTimer = setTimeout(() => {
            button.classList.add('hint-active');
          }, 200);
        });
        button.addEventListener('pointerup', () => {
          if (hintTimer) clearTimeout(hintTimer);
          button.classList.remove('hint-active');
        });
        button.addEventListener('pointercancel', () => {
          if (hintTimer) clearTimeout(hintTimer);
          button.classList.remove('hint-active');
        });
      }
    }

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
    // scale() after translate() composes about the *translated* origin, i.e.
    // the anchor point itself — exactly what's wanted, since #radial-menu is
    // a zero-size point and every child (ring, buttons) is positioned
    // relative to it. The anchor doesn't move; only the ring shrinks around it.
    const scale = MOBILE_RING.matches ? ` scale(${MOBILE_RING_SCALE})` : '';
    this.root.style.transform = `translate(${x}px, ${y}px)${scale}`;
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
