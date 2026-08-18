import * as THREE from 'three';
import { buildVehicleMesh, turningCircleOf } from '../vehicles/vehicleFactory.js';

const SPIN_SPEED = 0.5; // radians / second

/** Odometer metres → a short human string, rolling over to km past 1000. */
function formatDistance(metres) {
  const m = metres ?? 0;
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * The live per-instance stat line for an Active card. Health % is universal;
 * the rest is type-specific — distance for movers, lifetime credits for the
 * harvester, distance + kills for the gun platform. Keyed off def.id rather
 * than tags so a new vehicle gets a deliberate line rather than a default it
 * was never designed around.
 */
function instanceStatsText(inst) {
  const healthPct = Math.round((inst.health / inst.def.maxHealth) * 100);
  const dist = formatDistance(inst.odometer);
  switch (inst.def.id) {
    case 'crystal-harvester':
      return `${healthPct}% · ${Math.round(inst.creditsDelivered ?? 0)} cr`;
    case 'gun-platform':
      return `${healthPct}% · ${dist} · ${inst.kills ?? 0} kills`;
    default:
      return `${healthPct}% · ${dist}`;
  }
}

/**
 * Right-side drawer of small live 3D previews, one per catalog entry. Each
 * preview owns its own scene/camera so the vehicle can actually spin in real
 * time rather than being a canned sprite — consistent with the "procedural,
 * not sprites" goal for units. All cards share one WebGL context, rendered
 * into in turn and blitted onto each card's plain 2D canvas, so the context
 * count stays fixed regardless of catalog size.
 *
 * Rendering only happens while the drawer is open: update() is a no-op
 * otherwise, so hidden canvases cost nothing per frame.
 */
// Square, matching the card's aspect-ratio: 1 — a preview framed for a wide
// rectangle and then squashed into a square by CSS would off-center the mesh.
const PREVIEW_WIDTH = 128;
const PREVIEW_HEIGHT = 128;

export class VehiclePicker {
  constructor(catalog, { onSelect, vehicles, playerTeamId = 0 } = {}) {
    this.catalog = catalog;
    this.onSelect = onSelect;
    this.vehicles = vehicles;
    // Only the player's own vehicles ever populate "Active Vehicles" — see
    // buildPreviews() and update()'s rebuild check below. Without this, every
    // AI opponent's units would appear as clickable cards in the player's own
    // drawer, and clicking one hands the player driving control of it.
    this.playerTeamId = playerTeamId;
    this.open = false;
    this.previews = [];

    // One WebGL context shared by every card, rendered into in turn and
    // blitted onto each card's own plain 2D canvas — a context per card
    // would scale with the catalog and browsers cap those around sixteen.
    this.sharedRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.sharedRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.sharedRenderer.setSize(PREVIEW_WIDTH, PREVIEW_HEIGHT, false);
    this.sharedRenderer.shadowMap.enabled = false;
    // Entries with no `unlock` requirement are available from the start.
    this.unlocked = new Set(catalog.filter((d) => !d.unlock).map((d) => d.id));
    this.cards = new Map();
    this.lockText = () => 'Locked';
    this.lastInstanceCount = 0;

    this.toggleButton = document.getElementById('vehicle-toggle');
    this.panel = document.getElementById('vehicle-panel');
    this.grid = document.getElementById('vehicle-grid');

    this.toggleButton.addEventListener('click', () => this.setOpen(!this.open));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.setOpen(false);
    });

    this.buildPreviews();
  }

  /**
   * Swap the catalog and redraw the drawer — how author-built vehicles appear
   * (and, at the start of an online match, disappear again). Newly-added
   * entries with no `unlock` requirement are available immediately, matching
   * the rule the constructor applies to the built-ins.
   */
  setCatalog(catalog) {
    this.catalog = catalog;
    for (const def of catalog) {
      if (!def.unlock) this.unlocked.add(def.id);
    }
    this.buildPreviews();
  }

  buildPreviews() {
    this.grid.replaceChildren();
    this.previews = [];
    this.cards = new Map();

    // Section 1: Active spawned vehicles — the player's own only. `vehicles`
    // is one flat array across every team (human and every AI opponent), so
    // without this filter every enemy unit would show up here too, and
    // clicking one would hand the player driving control of it.
    const instances = (this.vehicles?.instances ?? []).filter(
      (i) => i.teamId === this.playerTeamId
    );
    if (instances.length > 0) {
      const section = document.createElement('div');
      section.className = 'vehicle-section';

      const heading = document.createElement('h3');
      heading.className = 'vehicle-section-title';
      heading.textContent = 'Active Vehicles';
      section.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'vehicle-section-grid';

      // Sort by creation time (oldest first)
      const sortedInstances = [...instances].sort((a, b) => a.createdAt - b.createdAt);

      for (const instance of sortedInstances) {
        const card = this._buildInstanceCard(instance);
        grid.appendChild(card);
      }
      section.appendChild(grid);
      this.grid.appendChild(section);
    }

    // Section 2: Available to spawn
    const section = document.createElement('div');
    section.className = 'vehicle-section';

    const heading = document.createElement('h3');
    heading.className = 'vehicle-section-title';
    heading.textContent = 'Available to Spawn';
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'vehicle-section-grid';

    // Produced units are not spawnable from the drawer.
    for (const def of this.catalog.filter((d) => d.spawnable !== false)) {
      const card = document.createElement('button');
      card.className = 'vehicle-card';
      card.type = 'button';
      card.setAttribute('aria-label', `Select ${def.name}`);

      const canvas = document.createElement('canvas');
      card.appendChild(canvas);

      const caption = document.createElement('div');
      caption.className = 'vehicle-card-caption';

      const label = document.createElement('span');
      label.className = 'vehicle-card-label';
      label.textContent = def.name;
      caption.appendChild(label);

      // Turning circle comes from the built mesh's real wheelbase, not a
      // number typed into the catalog, so it can never drift from the model.
      const stats = document.createElement('span');
      stats.className = 'vehicle-card-stats';
      // A def with no steered axle has no finite turning circle at all.
      const circle = turningCircleOf(def);
      stats.textContent =
        `${def.speed} u/s · turning circle ` +
        (Number.isFinite(circle) ? `${circle.toFixed(1)} u` : 'none');
      caption.appendChild(stats);

      const lock = document.createElement('span');
      lock.className = 'vehicle-card-lock';
      caption.appendChild(lock);

      card.appendChild(caption);

      card.addEventListener('click', () => {
        if (!this.unlocked.has(def.id)) return;
        this.onSelect?.(def);
      });
      grid.appendChild(card);
      this.cards.set(def.id, { card, lock, def });
      this.applyLockState(def.id);

      this.previews.push(this.createPreview(def, canvas));
    }
    section.appendChild(grid);
    this.grid.appendChild(section);
  }

  _buildInstanceCard(instance) {
    const card = document.createElement('button');
    card.className = 'vehicle-card vehicle-card-active';
    card.type = 'button';
    card.setAttribute('aria-label', `Select ${instance.def.name}`);

    const canvas = document.createElement('canvas');
    card.appendChild(canvas);

    const caption = document.createElement('div');
    caption.className = 'vehicle-card-caption';

    const label = document.createElement('span');
    label.className = 'vehicle-card-label';
    label.textContent = instance.def.name;
    caption.appendChild(label);

    // Live per-instance stats. Unlike the spawn cards' hover-reveal stats, an
    // Active card's are always shown (see .vehicle-card-active rule in the CSS)
    // and refreshed every frame in update().
    const stats = document.createElement('span');
    stats.className = 'vehicle-card-stats';
    stats.textContent = instanceStatsText(instance);
    caption.appendChild(stats);

    card.appendChild(caption);

    card.addEventListener('click', () => {
      this.vehicles?.setActive(instance);
    });

    // Carry the instance + its stats node on the preview so update() can keep
    // the numbers live without rebuilding the card.
    const preview = this.createPreview(instance.def, canvas);
    preview.instance = instance;
    preview.statsEl = stats;
    this.previews.push(preview);
    return card;
  }

  /** Unlock (or re-lock) a catalog entry and update its card in place. */
  setUnlocked(id, unlocked) {
    if (unlocked === this.unlocked.has(id)) return false;
    if (unlocked) this.unlocked.add(id);
    else this.unlocked.delete(id);
    this.applyLockState(id);
    return true;
  }

  applyLockState(id) {
    const entry = this.cards.get(id);
    if (!entry) return;
    const unlocked = this.unlocked.has(id);
    entry.card.classList.toggle('locked', !unlocked);
    entry.card.disabled = !unlocked;
    entry.card.setAttribute(
      'aria-label',
      unlocked ? `Select ${entry.def.name}` : `${entry.def.name} — locked`
    );
    entry.lock.textContent = unlocked ? '' : this.lockText(entry.def);
  }

  createPreview(def, canvas) {
    const width = PREVIEW_WIDTH;
    const height = PREVIEW_HEIGHT;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100);
    const dist = def.previewDistance ?? 9;
    camera.position.set(dist * 0.7, dist * 0.55, dist * 0.9);
    camera.lookAt(0, def.dims.hullHeight * 0.4, 0);

    // Fixed 3-point rig — a small preview doesn't need the world's sun.
    scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x30291f, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 6, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x7fbfff, 0.6);
    rim.position.set(-5, 2, -4);
    scene.add(rim);

    const mesh = buildVehicleMesh(def);
    mesh.position.y = 0;
    scene.add(mesh);

    return { ctx, scene, camera, mesh };
  }

  dispose() {
    this.sharedRenderer.dispose();
  }

  setOpen(open) {
    this.open = open;
    this.panel.classList.toggle('open', open);
    this.panel.setAttribute('aria-hidden', String(!open));
    this.toggleButton.classList.toggle('active', open);
    this.toggleButton.setAttribute('aria-expanded', String(open));
  }

  /** Spins and renders every preview. Cheap no-op while the drawer is closed. */
  update(dt) {
    if (!this.open) return;

    // Rebuild active vehicles section if the player's own instances have
    // changed. Counting only the player's own — not the raw total — so an AI
    // opponent spawning or losing a unit doesn't spuriously rebuild the
    // player's drawer every time.
    const currentInstanceCount = (this.vehicles?.instances ?? []).filter(
      (i) => i.teamId === this.playerTeamId
    ).length;
    if (currentInstanceCount !== this.lastInstanceCount) {
      this.buildPreviews();
      this.lastInstanceCount = currentInstanceCount;
    }

    for (const p of this.previews) {
      p.mesh.rotation.y += dt * SPIN_SPEED;
      // Active cards carry a live instance — refresh their health/stat line in
      // place. A plain string compare avoids touching the DOM on frames where
      // nothing changed (most of them, at 60fps against stats that tick slowly).
      if (p.instance && p.statsEl) {
        const text = instanceStatsText(p.instance);
        if (p.statsEl.textContent !== text) p.statsEl.textContent = text;
      }
      // Render through the one shared context, then copy the result onto
      // this card's own 2D canvas before moving to the next preview.
      this.sharedRenderer.render(p.scene, p.camera);
      p.ctx.drawImage(this.sharedRenderer.domElement, 0, 0);
    }
  }
}
