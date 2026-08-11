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

    if (control.type === 'save-field') {
      return this.createSaveField(row, control);
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

    // Controls flagged `locked` write simulation state (see controlSchema's
    // `simState`). Disabled at the element level rather than merely dimmed, so
    // a stray tap on a phone cannot desync a match through a control that only
    // *looks* unavailable.
    if (control.locked) {
      row.classList.add('control-locked');
      row.style.opacity = '0.45';
      for (const el of row.querySelectorAll('input, button, select')) el.disabled = true;
      if (control.lockHint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = control.lockHint;
        row.appendChild(hint);
      }
      // Skip _sync: refreshValues() would otherwise keep writing values into
      // inputs nobody can change, which is noise at best.
      control._sync = null;
    }

    this.controls = this.controls || [];
    this.controls.push(control);
    return row;
  }

  /**
   * Save-name field: a text input, a tappable suggestion list, and Save/Load
   * buttons. Built by hand rather than `<datalist>` — iOS Safari has never
   * reliably shown a datalist's dropdown, and "pick an existing save from a
   * list" is the first thing this control needs to do on every platform, not
   * just desktop. Buttons stack full-width below the input rather than sitting
   * beside it, matching every other button in this drawer (`button.action` is
   * always `width: 100%`) and keeping both comfortably tappable at the panel's
   * fixed 320px width.
   */
  createSaveField(row, control) {
    const wrap = document.createElement('div');
    wrap.className = 'save-field-input-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = control.placeholder ?? 'Save name…';
    input.autocomplete = 'off'; // don't let the OS's own field history render over ours
    input.autocapitalize = 'off';
    input.setAttribute('autocorrect', 'off'); // Safari-specific; harmless elsewhere
    input.spellcheck = false;

    const list = document.createElement('div');
    list.className = 'save-field-suggestions hidden';

    let lastKeyWasSpace = false;

    const renderSuggestions = () => {
      const names = control.get();
      const val = input.value.trim();
      const matches = val ? names.filter((n) => n.toLowerCase().includes(val.toLowerCase())) : names;
      list.innerHTML = '';
      if (matches.length === 0) {
        list.classList.add('hidden');
        return;
      }
      for (const name of matches) {
        const item = document.createElement('div');
        item.className = 'save-field-suggestion';
        item.textContent = name;
        // mousedown/touchstart, not click: both fire before the input's blur,
        // so the list is still open (and not yet hidden by it) when a pick
        // lands. A plain click handler would lose the race to blur closing it.
        const pick = () => {
          input.value = name;
          list.classList.add('hidden');
          syncLoadEnabled();
        };
        item.addEventListener('mousedown', (e) => { e.preventDefault(); pick(); });
        item.addEventListener('touchstart', (e) => { e.preventDefault(); pick(); }, { passive: false });
        list.appendChild(item);
      }
      list.classList.remove('hidden');
    };

    input.addEventListener('focus', () => {
      renderSuggestions();
      // Cloud fields carry a `refresh` that fetches the real list from the
      // server; local fields have none, since localStorage is already
      // synchronous and always current. Re-render (and re-check Load) once it
      // resolves, but only if focus hasn't already moved on.
      if (control.refresh) {
        control.refresh()
          .then(() => {
            if (document.activeElement === input) renderSuggestions();
            syncLoadEnabled();
          })
          .catch((err) => console.warn('save-field refresh failed:', err));
      }
    });
    input.addEventListener('input', () => {
      lastKeyWasSpace = false;
      renderSuggestions();
    });
    input.addEventListener('blur', () => list.classList.add('hidden'));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        control.onSave(input.value.trim());
        list.classList.add('hidden');
        syncLoadEnabled(); // the name just saved now exists, so Load can enable
        return;
      }
      if (e.key !== ' ') {
        lastKeyWasSpace = false;
        return;
      }
      if (lastKeyWasSpace) {
        // second space in a row: let it through as a literal space
        lastKeyWasSpace = false;
        return;
      }
      const val = input.value;
      const names = control.get();
      const matches = val ? names.filter((n) => n !== val && n.startsWith(val)) : [];
      if (matches.length === 1) {
        e.preventDefault();
        input.value = matches[0];
        renderSuggestions();
        syncLoadEnabled();
      }
      lastKeyWasSpace = true;
    });

    wrap.append(input, list);
    row.appendChild(wrap);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'action';
    saveBtn.textContent = control.saveLabel ?? 'Save';

    const loadBtn = document.createElement('button');
    loadBtn.className = 'action';
    loadBtn.textContent = control.loadLabel ?? 'Load';

    // Distinct from Load's aria-disabled "no exact match" state — a save/load
    // in flight (cloud only; local ones resolve in the same tick) disables
    // both buttons so a slow network can't be double-clicked into two
    // overlapping saves, without that busy state being mistaken for "no save
    // found" by Load's own click handler.
    let busy = false;
    const setBusy = (b) => {
      busy = b;
      saveBtn.classList.toggle('save-field-disabled', b);
      loadBtn.classList.toggle('save-field-disabled', b || loadBtn.getAttribute('aria-disabled') === 'true');
    };

    saveBtn.addEventListener('click', async () => {
      if (busy) return;
      setBusy(true);
      try {
        await control.onSave(input.value.trim());
        if (control.refresh) await control.refresh().catch(() => {}); // let a just-saved name appear immediately
      } finally {
        setBusy(false);
        syncLoadEnabled();
        if (document.activeElement === input) renderSuggestions();
      }
    });

    loadBtn.addEventListener('click', async () => {
      if (busy) return;
      if (loadBtn.getAttribute('aria-disabled') === 'true') {
        window.alert(`No save found named "${input.value.trim() || 'default'}".`);
        return;
      }
      setBusy(true);
      try {
        await control.onLoad(input.value.trim());
      } finally {
        setBusy(false);
      }
    });

    // Load only ever acts on an exact match — aria-disabled (not the native
    // `disabled`) keeps it keyboard/tap-reachable so it can explain why.
    const syncLoadEnabled = () => {
      const exact = control.get().includes(input.value.trim());
      loadBtn.classList.toggle('save-field-disabled', !exact || busy);
      loadBtn.setAttribute('aria-disabled', String(!exact));
    };
    input.addEventListener('input', syncLoadEnabled);
    syncLoadEnabled();

    row.append(saveBtn, loadBtn);

    // Only re-check Load's enabled state, not the suggestion list itself — the
    // list already reads control.get() fresh every time it opens, and syncing
    // it here would pop it open on any unrelated refreshValues() call (e.g.
    // "New random world"), not just while this field is actually focused.
    control._sync = syncLoadEnabled;
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
