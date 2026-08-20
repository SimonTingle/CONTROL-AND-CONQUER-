/**
 * The vehicle editor. Three columns: saved vehicles, live preview, parameters.
 *
 * Plain DOM and no framework, matching portalScreen.js — this is a screen like
 * any other, it just happens to own a WebGL context while open.
 *
 * Everything it produces is an ordinary vehicle def. There is no editor-only
 * format: `buildVehicleMesh` has no per-vehicle special cases, so a def built
 * here behaves in-game exactly like one shipped in catalog.js.
 */
import { VEHICLE_CATALOG } from '../vehicles/catalog.js';
import { BuilderPreview } from './builderPreview.js';
import { BUILDER_GROUPS, getPath, setPath, resyncAxles, resyncTracked } from './builderSchema.js';
import { blankDef, cloneDef, forkDef, validateDef, customIdFor } from './vehicleDraft.js';
import { loadCustomDefs, saveCustomVehicle, deleteCustomVehicle } from './customVehicles.js';

export class BuilderScreen {
  /**
   * @param {object} [opts]
   * @param {() => void} [opts.onClose] called when the author leaves the editor.
   * @param {(message: string) => void} [opts.toast] surface a message.
   */
  constructor({ onClose, toast } = {}) {
    this.root = document.getElementById('builder');
    this.onClose = onClose;
    this.toast = toast ?? ((m) => console.info('[builder]', m));
    this.saved = [];
    this.def = blankDef();
    this.currentSaveId = null;
    this.build();
  }

  open() {
    this.root.classList.remove('hidden');
    this.preview.start();
    this.syncParams();
    this.preview.setDef(this.def);
    this.showProblems();
    this.refreshSaved();
  }

  close() {
    this.preview.stop();
    this.root.classList.add('hidden');
    this.onClose?.();
  }

  build() {
    this.root.replaceChildren();

    const bar = document.createElement('header');
    bar.className = 'builder-bar';
    const title = document.createElement('h1');
    title.textContent = 'Vehicle Builder';
    bar.appendChild(title);

    const spacer = document.createElement('div');
    spacer.className = 'builder-bar-spacer';
    bar.appendChild(spacer);

    this.status = document.createElement('span');
    this.status.className = 'builder-status';
    bar.appendChild(this.status);

    bar.appendChild(this.button('New', () => this.loadDef(blankDef(), null)));
    bar.appendChild(this.button('Save draft', () => this.save({ draft: true })));
    bar.appendChild(this.button('Save', () => this.save({ draft: false }), 'primary'));
    bar.appendChild(this.button('Close', () => this.close()));
    this.root.appendChild(bar);

    const cols = document.createElement('div');
    cols.className = 'builder-cols';

    // Left — saved vehicles and drafts, plus the built-ins to fork from.
    this.left = document.createElement('aside');
    this.left.className = 'builder-left';
    cols.appendChild(this.left);

    // Centre — the preview, and the few view controls that belong with it.
    const centre = document.createElement('div');
    centre.className = 'builder-centre';
    this.stage = document.createElement('div');
    this.stage.className = 'builder-stage';
    centre.appendChild(this.stage);

    const viewBar = document.createElement('div');
    viewBar.className = 'builder-viewbar';
    viewBar.appendChild(this.checkbox('Night', false, (v) => this.preview.setNight(v)));
    viewBar.appendChild(this.checkbox('Spin', true, (v) => (this.preview.spinning = v)));
    centre.appendChild(viewBar);
    cols.appendChild(centre);

    // Right — the parameters.
    this.right = document.createElement('aside');
    this.right.className = 'builder-right';
    cols.appendChild(this.right);

    this.root.appendChild(cols);

    this.preview = new BuilderPreview(this.stage);
    this.buildParams();
    // Widgets are created empty — without this first read they show browser
    // defaults (a range input parks at its own midpoint) rather than the
    // vehicle actually loaded, and the first drag of any slider then writes
    // that wrong value into the def.
    this.syncParams();
    this.renderSaved();
  }

  button(label, onClick, variant) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = variant ? `builder-btn builder-btn-${variant}` : 'builder-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  checkbox(label, initial, onChange) {
    const wrap = document.createElement('label');
    wrap.className = 'builder-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initial;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, document.createTextNode(label));
    return wrap;
  }

  // ---- parameters ----

  buildParams() {
    this.right.replaceChildren();
    this.syncers = [];

    for (const group of BUILDER_GROUPS) {
      const section = document.createElement('section');
      section.className = 'builder-group';
      const h = document.createElement('h2');
      h.textContent = group.title;
      section.appendChild(h);
      for (const control of group.controls) section.appendChild(this.buildControl(control));
      this.right.appendChild(section);
    }
  }

  buildControl(control) {
    const row = document.createElement('div');
    row.className = 'builder-row';

    const label = document.createElement('label');
    label.textContent = control.label;
    row.appendChild(label);

    let input;
    let read;

    if (control.type === 'slider') {
      input = document.createElement('input');
      input.type = 'range';
      input.min = control.min;
      input.max = control.max;
      input.step = control.step;
      const readout = document.createElement('span');
      readout.className = 'builder-readout';
      label.appendChild(readout);
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        readout.textContent = v;
        setPath(this.def, control.path, v);
        // The axle count is not a lone number: axleOffsets() reads
        // axleFractions, so changing it without rewriting the arrays would
        // appear to do nothing at all.
        if (control.path === 'axles') resyncAxles(this.def);
        this.onEdit();
      });
      read = () => {
        const v = getPath(this.def, control.path);
        input.value = v ?? control.min;
        readout.textContent = Number(input.value);
      };
    } else if (control.type === 'toggle') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        setPath(this.def, control.path, input.checked);
        // Switching to tracks removes the steered axle entirely; switching
        // back restores it. Leaving the old ratios would describe a tank as
        // steering like a lorry.
        if (control.path === 'shape.tracked') {
          resyncTracked(this.def);
          this.syncParams();
        }
        this.onEdit();
      });
      read = () => (input.checked = !!getPath(this.def, control.path));
    } else if (control.type === 'color') {
      input = document.createElement('input');
      input.type = 'color';
      input.addEventListener('input', () => {
        setPath(this.def, control.path, input.value);
        this.onEdit();
      });
      read = () => (input.value = getPath(this.def, control.path) ?? '#ffffff');
    } else if (control.type === 'select') {
      // Options are either bare strings or {value, label} — the latter so a
      // choice can carry a null (`producedBy: null` = not buildable), which a
      // <select> can only represent as the empty string.
      const opts = control.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
      input = document.createElement('select');
      for (const opt of opts) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      }
      input.addEventListener('change', () => {
        // Empty string means "none" — stored as null so the def matches what
        // the catalog's own entries look like (`unlock: null`), rather than an
        // empty string nothing else in the game would recognise.
        setPath(this.def, control.path, input.value === '' ? null : input.value);
        this.onEdit();
      });
      read = () => (input.value = getPath(this.def, control.path) ?? '');
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.addEventListener('input', () => {
        setPath(this.def, control.path, input.value);
        // The id follows the name, so a renamed vehicle saves as a new one
        // rather than silently overwriting whatever shared its old slug.
        if (control.path === 'name') this.def.id = customIdFor(input.value);
        this.onEdit();
      });
      read = () => (input.value = getPath(this.def, control.path) ?? '');
    }

    row.appendChild(input);
    this.syncers.push(read);
    return row;
  }

  /** Re-read every widget from the def. Used after loading a different one. */
  syncParams() {
    for (const sync of this.syncers) sync();
  }

  onEdit() {
    this.preview.setDef(this.def);
    this.showProblems();
  }

  showProblems() {
    const problems = validateDef(this.def, { catalog: this.otherVehicles() });
    this.status.textContent = problems.length ? problems[0] : 'Ready';
    this.status.classList.toggle('builder-status-bad', problems.length > 0);
    return problems;
  }

  /**
   * Everything the current vehicle must not collide with: the built-ins, plus
   * the author's other saves — but not the one being edited, or re-saving a
   * vehicle would report its own id as taken.
   */
  otherVehicles() {
    return [...VEHICLE_CATALOG, ...this.saved.filter((d) => d.saveId !== this.currentSaveId)];
  }

  // ---- the left column ----

  loadDef(def, saveId) {
    this.def = cloneDef(def);
    this.currentSaveId = saveId;
    this.syncParams();
    this.preview.setDef(this.def);
    this.showProblems();
    this.renderSaved();
  }

  async refreshSaved() {
    try {
      const { defs, broken } = await loadCustomDefs();
      this.saved = defs;
      if (broken.length) {
        this.toast(`${broken.length} saved vehicle(s) could not be loaded.`);
      }
    } catch {
      // No backend, or signed out. The editor still works; nothing to list.
      this.saved = [];
    }
    this.renderSaved();
  }

  renderSaved() {
    if (!this.left) return;
    this.left.replaceChildren();

    const drafts = this.saved.filter((d) => d.draft);
    const finished = this.saved.filter((d) => !d.draft);

    this.left.appendChild(this.savedGroup('Saved', finished));
    if (drafts.length) this.left.appendChild(this.savedGroup('Drafts', drafts, true));

    // Built-ins are read-only, so they are offered as something to fork rather
    // than something to edit — editing one in place would change a vehicle
    // every existing save and every peer already agrees on.
    const section = document.createElement('section');
    section.className = 'builder-group';
    const h = document.createElement('h2');
    h.textContent = 'Built-in (copy to edit)';
    section.appendChild(h);
    for (const def of VEHICLE_CATALOG) {
      section.appendChild(
        this.savedCard(def.name, () => this.loadDef(forkDef(def), null))
      );
    }
    this.left.appendChild(section);
  }

  savedGroup(title, defs, dim = false) {
    const section = document.createElement('section');
    section.className = dim ? 'builder-group builder-group-dim' : 'builder-group';
    const h = document.createElement('h2');
    h.textContent = title;
    section.appendChild(h);

    if (!defs.length) {
      const empty = document.createElement('p');
      empty.className = 'builder-empty';
      empty.textContent = 'Nothing yet.';
      section.appendChild(empty);
    }
    for (const def of defs) {
      section.appendChild(
        this.savedCard(def.saveName ?? def.name, () => this.loadDef(def, def.saveId), () =>
          this.remove(def)
        )
      );
    }
    return section;
  }

  savedCard(name, onOpen, onDelete) {
    const row = document.createElement('div');
    row.className = 'builder-card';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'builder-card-open';
    open.textContent = name;
    open.addEventListener('click', onOpen);
    row.appendChild(open);

    if (onDelete) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'builder-card-del';
      del.textContent = '×';
      del.title = `Delete ${name}`;
      del.addEventListener('click', onDelete);
      row.appendChild(del);
    }
    return row;
  }

  // ---- persistence ----

  async save({ draft }) {
    const problems = this.showProblems();
    // A draft is explicitly allowed to be unfinished — that is what it is for.
    // A finished vehicle is not: it goes into the picker and gets spawned.
    if (problems.length && !draft) {
      this.toast(`Cannot save: ${problems[0]}`);
      return;
    }
    try {
      await saveCustomVehicle(this.def.name, this.def, { draft });
      this.toast(draft ? 'Draft saved.' : `Saved “${this.def.name}”.`);
      await this.refreshSaved();
    } catch (err) {
      this.toast(err?.message ?? 'Could not save.');
    }
  }

  async remove(def) {
    try {
      await deleteCustomVehicle(def.saveId);
      if (this.currentSaveId === def.saveId) this.currentSaveId = null;
      await this.refreshSaved();
    } catch (err) {
      this.toast(err?.message ?? 'Could not delete.');
    }
  }

  dispose() {
    this.preview?.dispose();
  }
}
