import * as THREE from 'three';
import { buildVehicleMesh } from '../vehicles/vehicleFactory.js';

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
  constructor(catalog, { onSelect } = {}) {
    this.catalog = catalog;
    this.onSelect = onSelect;
    this.open = false;
    this.previews = [];

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

    for (const def of this.catalog) {
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

      card.addEventListener('click', () => this.onSelect?.(def));
      this.grid.appendChild(card);

      this.previews.push(this.createPreview(def, canvas));
    }
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
    for (const p of this.previews) {
      p.mesh.rotation.y += dt * SPIN_SPEED;
      p.renderer.render(p.scene, p.camera);
    }
  }
}
