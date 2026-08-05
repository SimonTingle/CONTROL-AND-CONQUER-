/**
 * Hamburger drawer. Renders whatever buildSchema() describes, binds each widget
 * straight to its getter/setter, and debounces the controls that force a CPU
 * heightfield rebuild so dragging a slider stays smooth.
 */

const REBUILD_DEBOUNCE_MS = 90;

export class Menu {
  /**
   * @param {Array|Function} schema the control groups, or a function returning
   *   them. Pass a function when some control's *label* (not just its value)
   *   depends on state that changes at runtime — signing in and out rewrites
   *   the Account row's text, which refreshValues() cannot do because it only
   *   re-reads getters into existing widgets.
   */
  constructor(schema) {
    this.buildSchema = typeof schema === 'function' ? schema : () => schema;
    this.toggleButton = document.getElementById('menu-toggle');
    this.panel = document.getElementById('panel');
    this.body = document.getElementById('panel-body');
    this.stats = document.getElementById('hud-stats');
    this.open = false;
    this.pendingRebuild = null;

    this.toggleButton.addEventListener('click', () => this.setOpen(!this.open));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.setOpen(false);
      if (e.key.toLowerCase() === 'm' && e.target === document.body) this.setOpen(!this.open);
    });

    this.render(this.buildSchema());
  }

  /** Re-render from scratch. For value-only updates prefer refreshValues(). */
  rebuild() {
    this.render(this.buildSchema());
  }

  setOpen(open) {
    this.open = open;
    this.panel.classList.toggle('open', open);
    this.panel.setAttribute('aria-hidden', String(!open));
    this.toggleButton.classList.toggle('active', open);
    this.toggleButton.setAttribute('aria-expanded', String(open));
  }

  render(schema) {
    this.body.replaceChildren();
    for (const group of schema) {
      const details = document.createElement('details');
      details.className = 'group';
      if (group.open) details.open = true;

      const summary = document.createElement('summary');
      summary.textContent = group.title;
      details.appendChild(summary);

      for (const control of group.controls) {
        details.appendChild(this.createControl(control));
      }
      this.body.appendChild(details);
    }
  }

  createControl(control) {
    const row = document.createElement('div');
    row.className = `control control-${control.type}`;

    if (control.type === 'button') {
      const button = document.createElement('button');
      button.className = 'action';
      button.textContent = control.label;
      button.addEventListener('click', () => {
        control.action();
        this.refreshValues();
      });
      row.appendChild(button);
      return row;
    }

    const label = document.createElement('label');
    label.textContent = control.label;
    row.appendChild(label);

    if (control.type === 'slider') {
      const readout = document.createElement('span');
      readout.className = 'readout';
      label.appendChild(readout);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = control.min;
      input.max = control.max;
      input.step = control.step;
      input.value = control.get();
      readout.textContent = format(input.value);

      input.addEventListener('input', () => {
        const value = parseFloat(input.value);
        readout.textContent = format(value);
        if (control.rebuild) this.debounceRebuild(() => control.set(value));
        else control.set(value);
      });

      row.appendChild(input);
      control._sync = () => {
        input.value = control.get();
        readout.textContent = format(input.value);
      };
    } else if (control.type === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = control.get();
      input.addEventListener('change', () => control.set(input.checked));
      row.appendChild(input);
      control._sync = () => (input.checked = control.get());
    } else if (control.type === 'color') {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = `#${control.get().getHexString()}`;
      input.addEventListener('input', () => control.set(input.value));
      row.appendChild(input);
      control._sync = () => (input.value = `#${control.get().getHexString()}`);
    }

    this.controls = this.controls || [];
    this.controls.push(control);
    return row;
  }

  /**
   * Terrain-shape edits cost a full CPU regeneration, so coalesce the flood of
   * `input` events a slider drag produces into one rebuild per idle moment.
   */
  debounceRebuild(fn) {
    clearTimeout(this.pendingRebuild);
    this.pendingRebuild = setTimeout(fn, REBUILD_DEBOUNCE_MS);
  }

  /** Re-read every widget from its source, e.g. after "New random world". */
  refreshValues() {
    for (const control of this.controls || []) control._sync?.();
  }

  setStats(text) {
    this.stats.textContent = text;
  }
}

function format(value) {
  const n = parseFloat(value);
  if (Number.isInteger(n)) return String(n);
  return Math.abs(n) < 0.01 ? n.toPrecision(2) : n.toFixed(2);
}
