/**
 * Hamburger drawer. Renders whatever buildSchema() describes, binds each widget
 * straight to its getter/setter, and debounces the controls that force a CPU
 * heightfield rebuild so dragging a slider stays smooth.
 */

import { showToast } from './toast.js';

const REBUILD_DEBOUNCE_MS = 90;
const LONG_PRESS_MS = 500; // touch equivalent of a right-click

/** A filename-safe slug for a save name, so an odd name can't break the download. */
function safeSlug(name) {
  return (name || 'save').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'save';
}

/**
 * Strip the bulky, opaque masks from a snapshot for a human/Claude-readable
 * diagnostic. `teams[].fog` and top-level `tracksRLE` are base64 blobs (a
 * 256×256 mask per team, a 1024×1024 track mask) that are 80–95% of a save's
 * bytes and say nothing about game logic — see snapshot.js. Everything else
 * (teams, vehicles, structures, harvester states, AI commanders, terrain
 * params) is kept. Returns a new object; the input is not mutated.
 */
function stripMasks(snap) {
  const out = { ...snap };
  if (out.tracksRLE) out.tracksRLE = null;
  if (Array.isArray(out.teams)) {
    out.teams = out.teams.map((t) => (t && t.fog != null ? { ...t, fog: null } : t));
  }
  return out;
}

/** Hand `text` to the browser as a download named `filename`. */
function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been dispatched — doing it synchronously can
  // cancel the download on some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export class Menu {
  /**
   * @param {Array|Function} schema the control groups, or a function returning
   *   them. Pass a function when some control's *label* (not just its value)
   *   depends on state that changes at runtime — signing in and out rewrites
   *   the Account row's text, which refreshValues() cannot do because it only
   *   re-reads getters into existing widgets.
   */
  constructor(schema, statsScreen = null) {
    this.buildSchema = typeof schema === 'function' ? schema : () => schema;
    // The Statistics page. Owned elsewhere because its content is a live table,
    // not a list of tunables — the schema/createControl pipeline below has no
    // vocabulary for that, and bending it into one would serve neither.
    this.statsScreen = statsScreen;
    this.toggleButton = document.getElementById('menu-toggle');
    this.panel = document.getElementById('panel');
    this.body = document.getElementById('panel-body');
    this.title = this.panel.querySelector('header h1');
    this.stats = document.getElementById('hud-stats');
    this.open = false;
    this.pendingRebuild = null;
    // Which page of the drawer is showing. The drawer used to be nothing but
    // World Settings; it is now a two-item chooser that swaps this body in
    // place, so every render path has to say which page it is drawing.
    this.view = 'chooser'; // 'chooser' | 'settings' | 'stats'

    this.toggleButton.addEventListener('click', () => this.setOpen(!this.open));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.setOpen(false);
      if (e.key.toLowerCase() === 'm' && e.target === document.body) this.setOpen(!this.open);
    });

    this.renderChooser();
  }

  /**
   * Re-render World Settings from scratch. For value-only updates prefer
   * refreshValues().
   *
   * A no-op on any other page, which matters more than it looks: this fires on
   * sign-in, sign-out and every snapshot load (see the call sites in main.js),
   * none of which are a reason to yank someone off Statistics mid-read. Going
   * back to Settings rebuilds from buildSchema() anyway, so nothing goes stale.
   */
  rebuild() {
    if (this.view !== 'settings') return;
    this.render(this.buildSchema());
  }

  setOpen(open) {
    this.open = open;
    this.panel.classList.toggle('open', open);
    this.panel.setAttribute('aria-hidden', String(!open));
    this.toggleButton.classList.toggle('active', open);
    this.toggleButton.setAttribute('aria-expanded', String(open));
    // Set by main.js once the vehicle picker also exists, so opening this
    // drawer can close that one on a narrow screen — see the wiring site for
    // why: the two are otherwise unaware of each other.
    if (open) {
      // Always land on the chooser rather than wherever it was left: the
      // drawer is opened far more often to check something than to resume
      // whichever page was last read.
      this.renderChooser();
      this.onOpen?.();
    } else {
      // Stop the stats refresh while nothing is on screen.
      this.statsScreen?.unmount();
    }
  }

  /** The drawer's landing page: pick a section, nothing else. */
  renderChooser() {
    this.view = 'chooser';
    this.statsScreen?.unmount();
    this.title.textContent = 'Menu';
    this.body.replaceChildren();
    this.controls = [];

    const item = (label, hint, onSelect) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'panel-chooser-item';
      const name = document.createElement('span');
      name.className = 'panel-chooser-name';
      name.textContent = label;
      const sub = document.createElement('span');
      sub.className = 'panel-chooser-hint';
      sub.textContent = hint;
      button.append(name, sub);
      button.addEventListener('click', onSelect);
      return button;
    };

    this.body.append(
      item('Statistics', 'How this match is going', () => this.showStatistics()),
      item('World Settings', 'Terrain, atmosphere, camera', () => this.showSettings())
    );
  }

  showSettings() {
    this.view = 'settings';
    this.statsScreen?.unmount();
    this.title.textContent = 'World Settings';
    this.render(this.buildSchema());
  }

  showStatistics() {
    this.view = 'stats';
    this.title.textContent = 'Statistics';
    this.body.replaceChildren(this._backRow());
    this.controls = [];
    this.statsScreen?.mount(this.body);
  }

  _backRow() {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'action panel-back';
    back.textContent = '← Menu';
    back.addEventListener('click', () => this.renderChooser());
    return back;
  }

  /**
   * Per-frame tick, forwarded only to the page that wants one — today just
   * Statistics, and only while it is actually showing.
   */
  update(dt) {
    if (this.view === 'stats') this.statsScreen?.update(dt);
  }

  render(schema) {
    this.body.replaceChildren(this._backRow());
    // Reset alongside the DOM, not just append to it: rebuild() fires on
    // sign-in, sign-out and every snapshot load, and without this the previous
    // render's controls stay in the list forever — so refreshValues() ends up
    // calling _sync() on widgets that were detached several rebuilds ago.
    this.controls = [];
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

    // Is the suggestion list *meant* to be showing? Tracked explicitly rather
    // than inferred from `document.activeElement`, which is what the old code
    // did and is not reliable across an await: on iOS the software keyboard
    // sliding up over a backdrop-filter panel is enough to make activeElement
    // read as something else for a moment, and an in-flight fetch resolving in
    // that window used to skip its render permanently. A flag set on focus and
    // cleared on blur says what activeElement was only ever a proxy for, and
    // says it correctly at every point in an async gap.
    let listOpen = false;

    const closeList = () => {
      listOpen = false;
      list.classList.add('hidden');
      closeExportMenu();
    };

    // At most one export menu at a time; closing it is idempotent.
    let exportMenu = null;
    let exportDismiss = null;
    const closeExportMenu = () => {
      exportDismiss?.();
      exportDismiss = null;
      exportMenu?.remove();
      exportMenu = null;
    };

    /**
     * Resolve the raw save JSON for `name` and download it — the exact bytes as
     * the full save, or the mask-stripped diagnostic. Failures (a cloud fetch
     * that didn't come back) toast rather than fail silently.
     */
    const runExport = async (name, diagnostic) => {
      closeExportMenu();
      try {
        const { json } = await control.onExport(name);
        if (json == null) throw new Error('save not found');
        const text = diagnostic
          ? JSON.stringify(stripMasks(JSON.parse(json)), null, 2)
          : json;
        const suffix = diagnostic ? '.diagnostic.json' : '.json';
        downloadText(safeSlug(name) + suffix, text);
      } catch (err) {
        showToast(`Could not export "${name}": ${err.message ?? err}`, 6000);
      }
    };

    /** A tiny two-item menu anchored to a suggestion row. */
    const openExportMenu = (name) => {
      closeExportMenu();
      const menu = document.createElement('div');
      menu.className = 'save-field-export-menu';
      for (const [label, diagnostic] of [
        ['Export save', false],
        ['Export diagnostic', true],
      ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'save-field-export-item';
        btn.textContent = label;
        // mousedown/touchstart, not click: the field's blur handler closes the
        // list on pointer-down elsewhere; acting here keeps us ahead of it.
        const go = (e) => { e.preventDefault(); runExport(name, diagnostic); };
        btn.addEventListener('mousedown', go);
        btn.addEventListener('touchstart', go, { passive: false });
        menu.appendChild(btn);
      }
      // Sits inside the same positioned wrap as the suggestion list, so it
      // rides along with the field rather than needing absolute page coords.
      wrap.appendChild(menu);
      exportMenu = menu;

      // Dismiss on a pointer-down outside the menu, or Escape. Listeners are
      // removed together via exportDismiss so none can outlive the menu.
      const onAway = (e) => {
        if (!menu.contains(e.target)) closeExportMenu();
      };
      const onKey = (e) => {
        if (e.key === 'Escape') closeExportMenu();
      };
      exportDismiss = () => {
        document.removeEventListener('mousedown', onAway, true);
        document.removeEventListener('touchstart', onAway, true);
        document.removeEventListener('keydown', onKey);
      };
      // Capture phase + a tick's delay so the very pointer-down that opened the
      // menu doesn't immediately close it.
      setTimeout(() => {
        document.addEventListener('mousedown', onAway, true);
        document.addEventListener('touchstart', onAway, true);
        document.addEventListener('keydown', onKey);
      }, 0);
    };

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
        if (control.onExport) item.title = 'Right-click or long-press to export';
        // mousedown/touchstart, not click: both fire before the input's blur,
        // so the list is still open (and not yet hidden by it) when a pick
        // lands. A plain click handler would lose the race to blur closing it.
        const pick = () => {
          input.value = name;
          closeList();
          syncLoadEnabled();
        };
        // preventDefault on any button so the input keeps focus — otherwise a
        // right-click blurs it, and the blur's closeList() tears down the very
        // export menu the contextmenu is about to open. Only the left button
        // actually picks; the right button is handled by contextmenu below.
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (e.button === 0) pick();
        });

        if (control.onExport) {
          // Desktop: right-click exports.
          item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openExportMenu(name);
          });
          // Touch: a long press exports; a short tap still picks. The timer is
          // cancelled if the finger moves (a scroll) or lifts early.
          let pressTimer = null;
          let longFired = false;
          const clearPress = () => {
            if (pressTimer) clearTimeout(pressTimer);
            pressTimer = null;
          };
          item.addEventListener('touchstart', (e) => {
            e.preventDefault();
            longFired = false;
            clearPress();
            pressTimer = setTimeout(() => {
              longFired = true;
              openExportMenu(name);
            }, LONG_PRESS_MS);
          }, { passive: false });
          item.addEventListener('touchmove', clearPress, { passive: true });
          item.addEventListener('touchend', (e) => {
            clearPress();
            if (!longFired) { e.preventDefault(); pick(); }
          }, { passive: false });
          item.addEventListener('touchcancel', clearPress, { passive: true });
        } else {
          item.addEventListener('touchstart', (e) => { e.preventDefault(); pick(); }, { passive: false });
        }
        list.appendChild(item);
      }
      list.classList.remove('hidden');
    };

    /**
     * Re-read the list from wherever it really lives, then re-render if the
     * field is still showing.
     *
     * Cloud fields carry a `refresh` that fetches from the server; local fields
     * have none, since localStorage is already synchronous and always current.
     * The cloud cache starts empty (controlSchema.js) and only this fills it, so
     * a render that happens *before* this resolves is a render of nothing —
     * which is why the focus handler below renders again after awaiting rather
     * than only before.
     */
    const refreshList = async () => {
      if (!control.refresh) return;
      try {
        await control.refresh();
      } catch (err) {
        // Silent failure here is indistinguishable from "you have no saves",
        // and a console warning is invisible on a phone — which is exactly
        // where this field is hardest to use. Say it out loud.
        console.warn('save-field refresh failed:', err);
        showToast(`Could not load your cloud saves: ${err.message ?? err}`, 6000);
      }
      if (!input.isConnected) return; // the menu was rebuilt out from under us
      if (listOpen) renderSuggestions();
      syncLoadEnabled();
    };

    input.addEventListener('focus', () => {
      listOpen = true;
      // Show whatever is already cached immediately, so a local field (and a
      // cloud field on a second tap) opens with no perceptible delay, then
      // reconcile against the server and render again with the real list.
      renderSuggestions();
      refreshList();
    });
    input.addEventListener('input', () => {
      lastKeyWasSpace = false;
      renderSuggestions();
    });
    input.addEventListener('blur', closeList);

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        closeList();
        doSave(); // syncLoadEnabled runs inside, once the save has actually landed
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

    /**
     * The one save path. Both the button and the Return key go through here so
     * the busy guard, the await, and the post-save list refresh apply to both —
     * pressing Return used to call onSave() bare, so a cloud save made that way
     * never surfaced its error and never appeared in the list afterwards.
     */
    const doSave = async () => {
      if (busy) return;
      setBusy(true);
      try {
        await control.onSave(input.value.trim());
        // Let a just-saved name appear immediately. Errors here are reported
        // rather than swallowed: if the list can't be re-read, the name the
        // player just saved will appear to have vanished, and they deserve to
        // know that's a fetch problem and not a lost save.
        await refreshList();
      } finally {
        setBusy(false);
        syncLoadEnabled();
        // Only if the field is still open — Save is usually clicked *after*
        // tapping away from the input, and the Enter path closes the list on
        // purpose. Neither should have the dropdown spring back open.
        if (listOpen) renderSuggestions();
      }
    };

    saveBtn.addEventListener('click', doSave);

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
