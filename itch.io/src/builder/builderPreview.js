/**
 * The editor's centre panel: one vehicle on a turntable.
 *
 * Renders with the game's own `buildVehicleMesh`, not a lookalike — what the
 * author sees here is literally what spawns in a match, so a def that renders
 * wrong in the editor renders wrong in the game and vice versa. That is the
 * point; a second, simplified preview renderer would be free to disagree with
 * the real one and would eventually do so.
 *
 * Render-only code, so per CLAUDE.md it may use wall-clock time freely: the
 * turntable spin comes from a rAF delta and never touches simulation state.
 */
import * as THREE from 'three';
import { buildVehicleMesh } from '../vehicles/vehicleFactory.js';

export class BuilderPreview {
  /** @param {HTMLElement} host element to fill with the canvas. */
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f14);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.turntable = new THREE.Group();
    this.scene.add(this.turntable);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(30, 48),
      new THREE.MeshStandardMaterial({ color: 0x1a2027, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.key = new THREE.DirectionalLight(0xffffff, 2.2);
    this.key.position.set(6, 12, 8);
    this.scene.add(this.key);
    this.ambient = new THREE.AmbientLight(0x8fa6bb, 1.1);
    this.scene.add(this.ambient);

    this.night = false;
    this.spinning = true;
    this.angle = 0.6;
    this.distance = 16;
    this.group = null;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    this._last = performance.now();
    this._frame = null;
  }

  /**
   * Swap in a new vehicle. Called on every parameter change, so the old mesh's
   * geometries and materials are disposed rather than left to accumulate — a
   * slider drag is hundreds of rebuilds.
   */
  setDef(def) {
    this.disposeGroup();
    // A def can be mid-edit and briefly invalid (a cleared number field). The
    // editor validates before saving; here, just decline to draw rather than
    // throwing inside a rAF loop where the error is invisible.
    try {
      this.group = buildVehicleMesh(def);
      this.turntable.add(this.group);
    } catch {
      this.group = null;
    }
    // Frame the vehicle the same way vehiclePicker.js frames its cards.
    this.distance = def?.previewDistance ?? 16;
    this.height = (def?.dims?.hullHeight ?? 1.3) * 1.2;
  }

  disposeGroup() {
    if (!this.group) return;
    this.turntable.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    this.group = null;
  }

  /** Dim the scene lights so the vehicle's own lamps are visible. */
  setNight(on) {
    this.night = on;
    this.key.intensity = on ? 0.12 : 2.2;
    this.ambient.intensity = on ? 0.14 : 1.1;
    this.scene.background.set(on ? 0x05070a : 0x0b0f14);
  }

  resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this._frame) return;
    this.resize();
    this._last = performance.now();
    const loop = (now) => {
      const dt = Math.min((now - this._last) / 1000, 0.1);
      this._last = now;
      if (this.spinning) this.angle += dt * 0.35;
      this.turntable.rotation.y = this.angle;
      this.camera.position.set(0, (this.height ?? 1.5) + this.distance * 0.42, this.distance);
      this.camera.lookAt(0, this.height ?? 1.5, 0);
      this.renderer.render(this.scene, this.camera);
      this._frame = requestAnimationFrame(loop);
    };
    this._frame = requestAnimationFrame(loop);
  }

  stop() {
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = null;
  }

  /** Full teardown — the editor is opened and closed repeatedly in a session. */
  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.disposeGroup();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
