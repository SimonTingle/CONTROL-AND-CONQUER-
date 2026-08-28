/**
 * The sound editor — god mode's second app.
 *
 * Three columns, mirroring `builderScreen.js`: the dashboard of sounds on the
 * left, the waveform and distance rig in the centre, the parameters on the
 * right. Plain DOM and no framework, like every other screen here.
 *
 * Two things it does that the vehicle builder does not.
 *
 * **The left column lists game moments, not files.** A vehicle editor starts
 * from the vehicles that exist; a sound editor has to start from the sounds
 * the game *should* have, because the most valuable thing an author can do
 * here is give a cue to a moment that currently passes in silence. So the
 * dashboard is driven by `soundEvents.js` and groups by whether a moment has
 * a sound at all — with the silent ones shown as a first-class category
 * rather than as an absence.
 *
 * **Ability level filters the right column.** One schema, three views. The
 * level is stored on the recipe, so a sound remembers how its author likes to
 * work, and moving between levels never rebuilds the sound.
 */
import { SoundPreview } from './soundPreview.js';
import {
  SOUND_GROUPS, LAYER_CONTROLS, LEVELS, MAX_LAYERS,
  controlVisible, getPath, setPath,
} from './soundSchema.js';
import {
  applyMacros, blankLayer, blankRecipe, cloneRecipe, forkRecipe, syncId, validateRecipe,
} from './soundRecipe.js';
import { loadCustomRecipes, saveCustomSound, deleteCustomSound } from './customSounds.js';
import { SOUND_EVENTS, silentEvents } from '../audio/soundEvents.js';
import { clearAudition } from '../audio/audio.js';

/** Macro sliders always start neutral — see `applyMacros`'s note on why they
 * are measured from a base rather than stored. */
const NEUTRAL_MACROS = { size: 1, brightness: 1, length: 1 };

export class SoundScreen {
  /**
   * @param {object} [opts]
   * @param {() => void} [opts.onClose]
   * @param {(message: string) => void} [opts.toast]
   */
  constructor({ onClose, toast } = {}) {
    this.root = document.getElementById('sound-builder');
    this.onClose = onClose;
    this.toast = toast ?? ((m) => console.info('[sound]', m));
    this.saved = [];
    this.recipe = blankRecipe();
    this.macroBase = cloneRecipe(this.recipe);
    this.macros = { ...NEUTRAL_MACROS };
    this.currentSaveId = null;
    this.build();
  }

  get level() {
    return this.recipe.editorLevel ?? 'medium';
  }

  open() {
    this.root.classList.remove('hidden');
    this.preview.start();
    this.buildParams();
    this.preview.setRecipe(this.recipe);
    this.showProblems();
    this.refreshSaved();
  }

  close() {
    this.preview.stop();
    // Drop the audition binding and its baked buffer. Left installed, an
    // unsaved experiment would keep occupying the cache — and, worse, the
    // reserved id would still resolve to whatever was last being edited.
    clearAudition();
    this.root.classList.add('hidden');
    this.onClose?.();
  }

  build() {
    this.root.replaceChildren();

    const bar = document.createElement('header');
    bar.className = 'builder-bar';
    const title = document.createElement('h1');
    title.textContent = 'Sound Creator';
    bar.appendChild(title);

    const spacer = document.createElement('div');
    spacer.className = 'builder-bar-spacer';
    bar.appendChild(spacer);

    // The ability switch. Deliberately in the top bar rather than buried in
    // the parameter column: it changes what the whole editor looks like, so it
    // should not look like one more setting among the sound's own.
    const levels = document.createElement('div');
    levels.className = 'sound-levels';
    this.levelButtons = {};
    for (const level of LEVELS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'builder-btn sound-level';
      b.textContent = level;
      b.addEventListener('click', () => this.setLevel(level));
      this.levelButtons[level] = b;
      levels.appendChild(b);
    }
    bar.appendChild(levels);

    this.status = document.createElement('span');
    this.status.className = 'builder-status';
    bar.appendChild(this.status);

    bar.appendChild(this.button('New', () => this.loadRecipe(blankRecipe(), null)));
    bar.appendChild(this.button('Play', () => this.preview.audition()));
    bar.appendChild(this.button('Save draft', () => this.save({ draft: true })));
    bar.appendChild(this.button('Save', () => this.save({ draft: false }), 'primary'));
    bar.appendChild(this.button('Close', () => this.close()));
    this.root.appendChild(bar);

    const cols = document.createElement('div');
    cols.className = 'builder-cols';

    this.left = document.createElement('aside');
    this.left.className = 'builder-left';
    cols.appendChild(this.left);

    const centre = document.createElement('div');
    centre.className = 'builder-centre';
    this.stage = document.createElement('div');
    this.stage.className = 'sound-stage';
    centre.appendChild(this.stage);
    cols.appendChild(centre);

    this.right = document.createElement('aside');
    this.right.className = 'builder-right';
    cols.appendChild(this.right);

    this.root.appendChild(cols);

    this.preview = new SoundPreview(this.stage);
    this.buildParams();
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

  setLevel(level) {
    this.recipe.editorLevel = level;
    // Level is identity-adjacent, not sound-changing — but it *is* part of the
    // fingerprint (it is not in IDENTITY_KEYS), so the id has to be re-derived
    // like any other edit or the recipe would fail its own id check on save.
    syncId(this.recipe);
    this.buildParams();
  }

  // ---- parameters ----

  buildParams() {
    this.right.replaceChildren();
    this.syncers = [];

    for (const level of LEVELS) {
      this.levelButtons[level].classList.toggle('sound-level-on', level === this.level);
    }

    for (const group of SOUND_GROUPS) {
      const controls = group.controls.filter((c) => controlVisible(c, this.level));
      if (!controls.length) continue;
      const section = document.createElement('section');
      section.className = 'builder-group';
      const h = document.createElement('h2');
      h.textContent = group.title;
      section.appendChild(h);
      for (const control of controls) section.appendChild(this.buildControl(control));
      this.right.appendChild(section);
    }

    // Which game moment this sound replaces. Not in SOUND_GROUPS because its
    // options are the event registry, which is a live list rather than a
    // fixed one — and because binding is a different kind of decision from
    // shaping, so it reads better with its own heading.
    this.right.appendChild(this.buildBinding());

    // Layers are a list, so they cannot be described by fixed dotted paths.
    // Only `advanced` gets to add and remove them; `medium` still edits the
    // layers a sound already has.
    if (this.level !== 'low') this.right.appendChild(this.buildLayers());

    this.syncParams();
  }

  buildBinding() {
    const section = document.createElement('section');
    section.className = 'builder-group';
    const h = document.createElement('h2');
    h.textContent = 'Plays when';
    section.appendChild(h);

    const row = document.createElement('div');
    row.className = 'builder-row';
    const label = document.createElement('label');
    label.textContent = 'Game moment';
    row.appendChild(label);

    const select = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Not bound yet';
    select.appendChild(none);
    for (const event of SOUND_EVENTS) {
      const o = document.createElement('option');
      o.value = event.id;
      o.textContent = event.wired ? event.label : `${event.label} (silent today)`;
      select.appendChild(o);
    }
    select.addEventListener('change', () => {
      // Binding does not change the sound, and `event` is an identity key, so
      // this deliberately does *not* move the id — re-binding must not orphan
      // the buffer already baked for this recipe.
      this.recipe.event = select.value || null;
      this.showProblems();
      this.renderSaved();
    });
    row.appendChild(select);
    this.syncers.push(() => (select.value = this.recipe.event ?? ''));
    section.appendChild(row);

    this.bindNote = document.createElement('p');
    this.bindNote.className = 'builder-empty';
    section.appendChild(this.bindNote);
    this.syncers.push(() => {
      const event = SOUND_EVENTS.find((e) => e.id === this.recipe.event);
      this.bindNote.textContent = event?.wired === false
        ? 'This moment has no sound in the game yet — a call site still has to be added in code before it can be heard.'
        : '';
    });
    return section;
  }

  buildControl(control) {
    const row = document.createElement('div');
    row.className = 'builder-row';
    const label = document.createElement('label');
    label.textContent = control.label;
    row.appendChild(label);

    let input;
    let read;
    const isMacro = control.path.startsWith('macros.');

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
        if (isMacro) {
          this.macros[control.path.slice('macros.'.length)] = v;
          applyMacros(this.recipe, this.macroBase, this.macros);
        } else {
          setPath(this.recipe, control.path, v);
        }
        this.onEdit();
      });
      read = () => {
        const v = isMacro
          ? this.macros[control.path.slice('macros.'.length)]
          : getPath(this.recipe, control.path);
        input.value = v ?? control.min;
        readout.textContent = Number(input.value);
      };
    } else if (control.type === 'select') {
      const opts = control.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
      input = document.createElement('select');
      for (const opt of opts) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      }
      input.addEventListener('change', () => {
        setPath(this.recipe, control.path, input.value === '' ? null : input.value);
        this.onEdit();
      });
      read = () => (input.value = getPath(this.recipe, control.path) ?? '');
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.addEventListener('input', () => {
        setPath(this.recipe, control.path, input.value);
        this.onEdit();
      });
      read = () => (input.value = getPath(this.recipe, control.path) ?? '');
    }

    row.appendChild(input);
    this.syncers.push(read);
    return row;
  }

  buildLayers() {
    const section = document.createElement('section');
    section.className = 'builder-group';
    const h = document.createElement('h2');
    h.textContent = 'Layers';
    section.appendChild(h);

    (this.recipe.layers ?? []).forEach((layer, index) => {
      const card = document.createElement('div');
      card.className = 'sound-layer';

      const head = document.createElement('div');
      head.className = 'sound-layer-head';
      const name = document.createElement('strong');
      name.textContent = `${index + 1}. ${layer.kind === 'tone' ? 'Tone' : 'Noise'}`;
      head.appendChild(name);
      if (this.level === 'advanced' && this.recipe.layers.length > 1) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'builder-card-del';
        del.textContent = '×';
        del.title = 'Remove this layer';
        del.addEventListener('click', () => {
          this.recipe.layers.splice(index, 1);
          this.macroBase = cloneRecipe(this.recipe);
          this.macros = { ...NEUTRAL_MACROS };
          this.onEdit();
          this.buildParams();
        });
        head.appendChild(del);
      }
      card.appendChild(head);

      for (const control of LAYER_CONTROLS[layer.kind] ?? []) {
        if (!controlVisible(control, this.level)) continue;
        card.appendChild(this.buildLayerControl(control, index));
      }
      section.appendChild(card);
    });

    if (this.level === 'advanced' && (this.recipe.layers?.length ?? 0) < MAX_LAYERS) {
      const add = document.createElement('div');
      add.className = 'sound-layer-add';
      for (const kind of ['noise', 'tone']) {
        add.appendChild(this.button(`Add ${kind}`, () => {
          this.recipe.layers.push(blankLayer(kind));
          // The macro base has to move with the layer list, or a later macro
          // drag would rebuild the layers from a base that is missing this one
          // and silently delete it.
          this.macroBase = cloneRecipe(this.recipe);
          this.macros = { ...NEUTRAL_MACROS };
          this.onEdit();
          this.buildParams();
        }));
      }
      section.appendChild(add);
    }
    return section;
  }

  buildLayerControl(control, index) {
    const row = document.createElement('div');
    row.className = 'builder-row';
    const label = document.createElement('label');
    label.textContent = control.label;
    row.appendChild(label);

    let input;
    let read;
    const layer = () => this.recipe.layers[index];

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
        layer()[control.field] = v;
        // Editing a layer directly makes the current macro positions
        // meaningless as offsets from the old base, so the base is re-taken
        // and the macros return to neutral. Without this the next macro drag
        // would undo the edit just made.
        this.macroBase = cloneRecipe(this.recipe);
        this.macros = { ...NEUTRAL_MACROS };
        this.onEdit();
      });
      read = () => {
        const v = layer()?.[control.field];
        input.value = v ?? control.min;
        readout.textContent = Number(input.value);
      };
    } else {
      const opts = control.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
      input = document.createElement('select');
      for (const opt of opts) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      }
      input.addEventListener('change', () => {
        layer()[control.field] = input.value;
        this.macroBase = cloneRecipe(this.recipe);
        this.macros = { ...NEUTRAL_MACROS };
        this.onEdit();
      });
      read = () => (input.value = layer()?.[control.field] ?? '');
    }

    row.appendChild(input);
    this.syncers.push(read);
    return row;
  }

  syncParams() {
    for (const sync of this.syncers) sync();
  }

  onEdit() {
    // The id is derived from the recipe's contents, so any edit moves it.
    // Re-derived here, the one place every widget funnels through, so no
    // control has to remember to do it.
    syncId(this.recipe);
    this.preview.setRecipe(this.recipe);
    this.showProblems();
  }

  showProblems() {
    const problems = validateRecipe(this.recipe, { catalog: this.otherSounds() });
    this.status.textContent = problems.length ? problems[0] : 'Ready';
    this.status.classList.toggle('builder-status-bad', problems.length > 0);
    return problems;
  }

  /** Everything this sound must not collide with — but not its own save row,
   * or re-saving would report its own id as taken. */
  otherSounds() {
    return this.saved.filter((r) => r.saveId !== this.currentSaveId);
  }

  // ---- the dashboard ----

  loadRecipe(recipe, saveId) {
    this.recipe = cloneRecipe(recipe);
    this.macroBase = cloneRecipe(this.recipe);
    this.macros = { ...NEUTRAL_MACROS };
    this.currentSaveId = saveId;
    this.buildParams();
    this.preview.setRecipe(this.recipe);
    this.showProblems();
    this.renderSaved();
  }

  async refreshSaved() {
    try {
      const { recipes, broken } = await loadCustomRecipes();
      this.saved = recipes;
      if (broken.length) this.toast(`${broken.length} saved sound(s) could not be loaded.`);
    } catch {
      // No backend, or signed out. The editor still works; nothing to list.
      this.saved = [];
    }
    this.renderSaved();
  }

  renderSaved() {
    if (!this.left) return;
    this.left.replaceChildren();

    const drafts = this.saved.filter((r) => r.draft);
    const finished = this.saved.filter((r) => !r.draft);

    this.left.appendChild(this.recipeGroup('My sounds', finished));
    if (drafts.length) this.left.appendChild(this.recipeGroup('Drafts', drafts, true));

    // The silent moments, first-class. This is the column's whole reason for
    // being driven by the event registry rather than by what has been saved:
    // it is a list of what the game is missing, which nothing else surfaces.
    const silent = silentEvents();
    const section = document.createElement('section');
    section.className = 'builder-group';
    const h = document.createElement('h2');
    h.textContent = 'Silent moments';
    section.appendChild(h);
    for (const event of silent) {
      const card = this.card(event.label, () => {
        const recipe = blankRecipe(event.label);
        recipe.event = event.id;
        this.loadRecipe(syncId(recipe), null);
      });
      if (event.note) card.title = event.note;
      section.appendChild(card);
    }
    this.left.appendChild(section);

    // Built-ins are offered as something to fork, not to edit in place —
    // editing one would change a sound every existing save and every peer
    // already agrees on. A fork *approximates* the built-in: `GENERATORS` is
    // JS, not data, so this is a starting point rather than a decompile, and
    // the heading says so rather than implying otherwise.
    const forks = document.createElement('section');
    forks.className = 'builder-group';
    const fh = document.createElement('h2');
    fh.textContent = 'Built-in (copy to approximate)';
    forks.appendChild(fh);
    for (const event of SOUND_EVENTS.filter((e) => e.builtin)) {
      forks.appendChild(this.card(event.label, () => {
        const recipe = forkRecipe(blankRecipe(event.label));
        recipe.event = event.id;
        this.loadRecipe(syncId(recipe), null);
      }));
    }
    this.left.appendChild(forks);
  }

  recipeGroup(title, recipes, dim = false) {
    const section = document.createElement('section');
    section.className = dim ? 'builder-group builder-group-dim' : 'builder-group';
    const h = document.createElement('h2');
    h.textContent = title;
    section.appendChild(h);

    if (!recipes.length) {
      const empty = document.createElement('p');
      empty.className = 'builder-empty';
      empty.textContent = 'Nothing yet.';
      section.appendChild(empty);
    }
    for (const recipe of recipes) {
      section.appendChild(this.card(
        recipe.saveName ?? recipe.name,
        () => this.loadRecipe(recipe, recipe.saveId),
        () => this.remove(recipe),
      ));
    }
    return section;
  }

  card(name, onOpen, onDelete) {
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
    // A draft is explicitly allowed to be unfinished. A finished sound is not:
    // it gets installed over a game event and baked on every peer.
    if (problems.length && !draft) {
      this.toast(`Cannot save: ${problems[0]}`);
      return;
    }
    try {
      await saveCustomSound(this.recipe.name, this.recipe, { draft });
      this.toast(draft ? 'Draft saved.' : `Saved “${this.recipe.name}”.`);
      await this.refreshSaved();
    } catch (err) {
      this.toast(err?.message ?? 'Could not save.');
    }
  }

  async remove(recipe) {
    try {
      await deleteCustomSound(recipe.saveId);
      if (this.currentSaveId === recipe.saveId) this.currentSaveId = null;
      await this.refreshSaved();
    } catch (err) {
      this.toast(err?.message ?? 'Could not delete.');
    }
  }

  dispose() {
    this.preview?.dispose();
  }
}
