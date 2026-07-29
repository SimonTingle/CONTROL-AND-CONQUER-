import * as THREE from 'three';
import { buildVehicleMesh, turningCircleOf } from '../vehicles/vehicleFactory.js';

const SPIN_SPEED = 0.5; // radians / second

/**
 * Right-side drawer of small live 3D previews, one per catalog entry. Each
 * preview owns a tiny renderer/scene/camera so the vehicle can actually spin
 * in real time rather than being a canned sprite — consistent with the
 * "procedural, not sprites" goal for units.
 *
 * Rendering only happens while the drawer is open: update() is a no-op
 * otherwise, so hidden canvases cost nothing per frame.
 */
export class VehiclePicker {
  constructor(catalog, { onSelect, vehicles } = {}) {
    this.catalog = catalog;
    this.onSelect = onSelect;
    this.vehicles = vehicles;
    this.open = false;
    this.previews = [];
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

  buildPreviews() {
    this.grid.replaceChildren();
    this.previews = [];
    this.cards = new Map();

    // Section 1: Active spawned vehicles
    const instances = this.vehicles?.instances ?? [];
    if (instances.length > 0) {
      const section = document.createElement('div');
      section.className = 'vehicle-section';

      const heading = document.createElement('h3');
      heading.className = 'vehicle-section-title';
      heading.textContent = 'Active Vehicles';
      section.appendChild(heading);

      // Sort by creation time (oldest first)
      const sortedInstances = [...instances].sort((a, b) => a.createdAt - b.createdAt);

      for (const instance of sortedInstances) {
        const card = this._buildInstanceCard(instance);
        section.appendChild(card);
      }
      this.grid.appendChild(section);
    }

    // Section 2: Available to spawn
    const section = document.createElement('div');
    section.className = 'vehicle-section';

    const heading = document.createElement('h3');
    heading.className = 'vehicle-section-title';
    heading.textContent = 'Available to Spawn';
    section.appendChild(heading);

    // Produced units are not spawnable from the drawer — and each card costs a
    // WebGL context, which browsers cap at around sixteen.
    for (const def of this.catalog.filter((d) => d.spawnable !== false)) {
      const card = document.createElement('button');
      card.className = 'vehicle-card';
      card.type = 'button';
      card.setAttribute('aria-label', `Select ${def.name}`);

      const canvas = document.createElement('canvas');
      card.appendChild(canvas);

      const label = document.createElement('span');
      label.className = 'vehicle-card-label';
      label.textContent = def.name;
      card.appendChild(label);

      // Turning circle comes from the built mesh's real wheelbase, not a
      // number typed into the catalog, so it can never drift from the model.
      const stats = document.createElement('span');
      stats.className = 'vehicle-card-stats';
      // A def with no steered axle has no finite turning circle at all.
      const circle = turningCircleOf(def);
      stats.textContent =
        `${def.speed} u/s · turning circle ` +
        (Number.isFinite(circle) ? `${circle.toFixed(1)} u` : 'none');
      card.appendChild(stats);

      const lock = document.createElement('span');
      lock.className = 'vehicle-card-lock';
      card.appendChild(lock);

      card.addEventListener('click', () => {
        if (!this.unlocked.has(def.id)) return;
        this.onSelect?.(def);
      });
      section.appendChild(card);
      this.cards.set(def.id, { card, lock, def });
      this.applyLockState(def.id);

      this.previews.push(this.createPreview(def, canvas));
    }
    this.grid.appendChild(section);
  }

  _buildInstanceCard(instance) {
    const card = document.createElement('button');
    card.className = 'vehicle-card vehicle-card-active';
    card.type = 'button';
    card.setAttribute('aria-label', `Select ${instance.def.name}`);

    const canvas = document.createElement('canvas');
    card.appendChild(canvas);

    const label = document.createElement('span');
    label.className = 'vehicle-card-label';
    label.textContent = instance.def.name;
    card.appendChild(label);

    card.addEventListener('click', () => {
      this.vehicles?.setActive(instance);
    });

    this.previews.push(this.createPreview(instance.def, canvas));
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
    const width = 150;
    const height = 108;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    renderer.shadowMap.enabled = false;

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

    return { renderer, scene, camera, mesh };
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

    // Rebuild active vehicles section if instances have changed
    const currentInstanceCount = this.vehicles?.instances?.length ?? 0;
    if (currentInstanceCount !== this.lastInstanceCount) {
      this.buildPreviews();
      this.lastInstanceCount = currentInstanceCount;
    }

    for (const p of this.previews) {
      p.mesh.rotation.y += dt * SPIN_SPEED;
      p.renderer.render(p.scene, p.camera);
    }
  }
}
