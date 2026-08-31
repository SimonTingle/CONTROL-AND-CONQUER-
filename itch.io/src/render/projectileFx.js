import * as THREE from 'three';

/**
 * Everything you can see about a shell: the shell itself, the mark it throws
 * on the ground beneath it, the muzzle flash behind it and the explosion in
 * front of it.
 *
 * **This file reads simulation state and never writes it.** The shells are
 * owned by `vehicles/projectiles.js` and moved by the fixed-step sim; this
 * draws whatever is in that array at whatever rate the display manages. It
 * follows the same split `renderTick` has from `simTick` in main.js, and it is
 * why `Math.random` is fine here (debris scatter) and forbidden there.
 *
 * Everything is pooled. Shots are frequent and short-lived, so allocating
 * meshes per shot would build and dispose dozens of objects a second; the
 * pools cap that at a constant regardless of how big the battle gets.
 *
 * ## The ground mark
 *
 * A shell needs to read against the ground it is flying over, and what makes
 * that read changes completely between noon and midnight. So each shell gets
 * one ground-projected quad that is *cross-faded by sun elevation* rather than
 * two separate effects switched between:
 *
 *  - **Sun high** — a small, dark, tight blob shadow. It sits under the shell
 *    and tracks it, giving the altitude cue a shell otherwise has none of.
 *  - **Dusk through dawn** — the same quad widens, brightens, takes the
 *    shell's own colour and switches to additive blending, becoming a soft
 *    glow pool washing over the ground beneath a lit projectile.
 *
 * A real `castShadow` on the shell mesh was the obvious alternative and is
 * worse on both ends: it costs shadow-map fill for a sub-metre object, and it
 * gives nothing at night, when there is no sun to cast from and the glow pool
 * would still have to exist. One quad does both jobs and costs one quad.
 *
 * The elevation thresholds are shared with the headlight gate and the flare
 * command (main.js's `headlightsWanted`, commands.js's dusk gate) so that
 * missiles, headlights and flares all agree on when night has started —
 * three systems disagreeing about that was a real risk worth designing out.
 */

/** Sun elevation (degrees) at and above which it is unambiguously day. */
export const DAY_ELEVATION = 12;
/** Sun elevation at and below which it is unambiguously night. */
export const NIGHT_ELEVATION = -2;

/**
 * 0 at full day, 1 at full night, smoothly between. Everything time-of-day
 * dependent in this file goes through this one function, so dusk and dawn
 * behave identically without either being special-cased.
 */
export function nightFactor(elevation) {
  const t = (DAY_ELEVATION - elevation) / (DAY_ELEVATION - NIGHT_ELEVATION);
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c); // smoothstep — no crease at either threshold
}

const SHELL_POOL_SIZE = 64;
const IMPACT_POOL_SIZE = 16;
const DEBRIS_PER_IMPACT = 6;
const DEBRIS_POOL_SIZE = IMPACT_POOL_SIZE * DEBRIS_PER_IMPACT;
/**
 * Concurrent impact lights. Hard-capped because each one is a real light the
 * renderer has to account for in every lit material — a barrage that spawned
 * one per shell would recompile shaders mid-fight and tank the frame rate.
 * Oldest is recycled, so a heavy exchange keeps lighting its most recent
 * impacts rather than going dark.
 */
const LIGHT_POOL_SIZE = 6;

const IMPACT_DURATION = 0.45; // seconds, expanding fireball
const DEBRIS_DURATION = 0.9;
const MUZZLE_DURATION = 0.07;
const DEBRIS_GRAVITY = 34;

/** Radius of the fireball for a nominal-damage shell; scaled by calibre below. */
const BASE_IMPACT_RADIUS = 2.2;
/** Damage that counts as "nominal" — the calibre scale is relative to this. */
const REFERENCE_DAMAGE = 20;

export class ProjectileFx {
  /**
   * @param {THREE.Scene} scene
   * @param {object} heightmap for grounding the shadow/glow quad and debris
   * @param {object} game for team colours when a turret has no projectileColor
   */
  constructor(scene, heightmap, game) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.game = game;

    /** projectile id -> pool slot, so a shell keeps the same mesh all flight. */
    this._slotFor = new Map();
    this._shells = [];
    this._freeShells = [];

    const quadGeo = new THREE.PlaneGeometry(1, 1);
    quadGeo.rotateX(-Math.PI / 2); // lie flat on the ground

    for (let i = 0; i < SHELL_POOL_SIZE; i++) {
      const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      // The ground mark's blending is switched between normal (shadow) and
      // additive (glow) as the sun goes down — a material property, so one
      // mesh really does serve both roles.
      const markMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // Without this the quad z-fights the terrain it is lying on.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });

      const core = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), coreMat);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 6), glowMat);
      const mark = new THREE.Mesh(quadGeo, markMat);
      // Position moves every frame; a cached bound would pop these in and out.
      core.frustumCulled = false;
      glow.frustumCulled = false;
      mark.frustumCulled = false;
      core.visible = glow.visible = mark.visible = false;
      scene.add(core, glow, mark);

      this._shells.push({ core, glow, mark, coreMat, glowMat, markMat, id: null });
      this._freeShells.push(i);
    }

    // --- impacts ---------------------------------------------------------
    this._impacts = [];
    for (let i = 0; i < IMPACT_POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd08a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      this._impacts.push({ mesh, mat, elapsed: 0, radius: 1, active: false });
    }

    this._debris = [];
    const debrisGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    const debrisMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 1 });
    for (let i = 0; i < DEBRIS_POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(debrisGeo, debrisMat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      this._debris.push({ mesh, vx: 0, vy: 0, vz: 0, elapsed: 0, active: false });
    }

    this._lights = [];
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xffb15a, 0, 40);
      light.visible = false;
      scene.add(light);
      this._lights.push({ light, elapsed: 0, peak: 0, active: false });
    }
    this._nextLight = 0;

    // --- muzzle flashes ---------------------------------------------------
    this._muzzles = [];
    for (let i = 0; i < 12; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xfff0c0,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.6, 6, 5), mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      this._muzzles.push({ mesh, mat, elapsed: 0, active: false });
    }
    this._nextMuzzle = 0;
  }

  /** Team colour fallback, so an AI-vs-AI fight stays readable for weapons
   * that never got their own `projectileColor`. */
  _colorOf(p) {
    return p.color ?? this.game.teams[p.teamId]?.color ?? 0xffffff;
  }

  /**
   * Draw this frame's shells.
   *
   * @param {Array} live `projectiles.instances` — read only
   * @param {number} elevation sun elevation in degrees
   */
  updateShells(live, elevation) {
    const night = nightFactor(elevation);
    const seen = new Set();

    for (const p of live) {
      seen.add(p.id);
      let slotIndex = this._slotFor.get(p.id);
      if (slotIndex === undefined) {
        // Out of pool slots: this shell simply isn't drawn. The simulation is
        // unaffected — it still flies, still lands, still deals its damage —
        // which is exactly the property that makes a fixed pool safe here.
        if (this._freeShells.length === 0) continue;
        slotIndex = this._freeShells.pop();
        this._slotFor.set(p.id, slotIndex);
        const slot = this._shells[slotIndex];
        slot.id = p.id;
        const color = this._colorOf(p);
        slot.coreMat.color.setHex(color);
        slot.glowMat.color.setHex(color);
        slot.core.visible = true;
        slot.glow.visible = true;
        slot.mark.visible = true;
      }

      const slot = this._shells[slotIndex];
      slot.core.position.set(p.x, p.y, p.z);
      slot.glow.position.copy(slot.core.position);

      // The ground mark sits directly under the shell, on the terrain.
      const groundY = this.heightmap.heightAt(p.x, p.z);
      const altitude = Math.max(0, p.y - groundY);
      slot.mark.position.set(p.x, groundY + 0.08, p.z);

      // Higher shell, larger and softer mark — the altitude cue.
      const spread = 1 + altitude * 0.09;

      // `blending` is the only thing set below that needs a program refresh;
      // colour, opacity and scale are picked up without one. Remembered here
      // so `needsUpdate` can be set on the frame it actually changes — which
      // is at most once per shell, at the day/night crossover — instead of on
      // every frame for every shell in flight. At the 64-shell pool cap that
      // was 64 forced program re-acquisitions per frame during a firefight.
      const prevBlending = slot.markMat.blending;

      if (night < 0.5) {
        // Daylight half of the cross-fade: a dark blob, tightening and
        // strengthening as the sun climbs.
        const dayness = 1 - night * 2;
        slot.markMat.blending = THREE.NormalBlending;
        slot.markMat.color.setHex(0x000000);
        slot.markMat.opacity = 0.34 * dayness / spread;
        slot.mark.scale.setScalar(1.6 * spread);
      } else {
        // Night half: the same quad becomes an additive coloured pool, wider
        // and brighter than the shadow ever was.
        const nightness = (night - 0.5) * 2;
        slot.markMat.blending = THREE.AdditiveBlending;
        slot.markMat.color.setHex(this._colorOf(p));
        slot.markMat.opacity = 0.4 * nightness / Math.sqrt(spread);
        slot.mark.scale.setScalar(3.2 * spread);
      }
      if (slot.markMat.blending !== prevBlending) slot.markMat.needsUpdate = true;
    }

    // Release slots whose shell resolved this tick.
    for (const [id, slotIndex] of this._slotFor) {
      if (seen.has(id)) continue;
      const slot = this._shells[slotIndex];
      slot.core.visible = slot.glow.visible = slot.mark.visible = false;
      slot.id = null;
      this._slotFor.delete(id);
      this._freeShells.push(slotIndex);
    }
  }

  /**
   * A shell landed. Called from the sim's `onImpact` hook, but everything it
   * does is presentational.
   *
   * @param {object} impact `{x, y, z, ground, damage, calibre, teamId, color}`
   * @param {number} elevation sun elevation, for the night-only light
   */
  spawnImpact(impact, elevation) {
    // Calibre drives the whole effect: a scout's autocannon should pop, a
    // heavy tank's main gun should shake the screen.
    const scale = Math.sqrt(Math.max(0.2, (impact.calibre ?? REFERENCE_DAMAGE) / REFERENCE_DAMAGE));
    const radius = BASE_IMPACT_RADIUS * scale;

    const slot = this._impacts.find((s) => !s.active) ?? this._impacts[0];
    slot.active = true;
    slot.elapsed = 0;
    slot.radius = radius;
    slot.mesh.position.set(impact.x, impact.y + radius * 0.35, impact.z);
    slot.mesh.visible = true;
    slot.mat.opacity = 1;
    slot.mesh.scale.setScalar(0.3 * radius);

    // Debris only from ground hits — a shell that hit a hull throws wreckage,
    // which is `leaveWreckage`'s job, not a shower of dirt.
    if (impact.ground) {
      let spawned = 0;
      for (const d of this._debris) {
        if (spawned >= DEBRIS_PER_IMPACT) break;
        if (d.active) continue;
        d.active = true;
        d.elapsed = 0;
        // Render-only, so an unseeded random is correct here — see the header.
        const angle = Math.random() * Math.PI * 2;
        const speed = (4 + Math.random() * 7) * scale;
        d.vx = Math.cos(angle) * speed;
        d.vz = Math.sin(angle) * speed;
        d.vy = (7 + Math.random() * 8) * scale;
        d.mesh.position.set(impact.x, impact.y + 0.2, impact.z);
        d.mesh.scale.setScalar(scale * (0.6 + Math.random() * 0.8));
        d.mesh.visible = true;
        spawned++;
      }
    }

    // The night flash. Created only below the day threshold: by daylight a
    // point light of this size is invisible against the sun and would be pure
    // cost. This is the effect that makes a night barrage read from across the
    // map.
    const night = nightFactor(elevation);
    if (night > 0.15) {
      const l = this._lights[this._nextLight];
      this._nextLight = (this._nextLight + 1) % LIGHT_POOL_SIZE;
      l.active = true;
      l.elapsed = 0;
      l.peak = 90 * scale * scale * night;
      l.light.distance = 26 * scale;
      l.light.color.setHex(impact.ground ? 0xffb15a : 0xffd6a0);
      l.light.position.set(impact.x, impact.y + 1.5 * scale, impact.z);
      l.light.visible = true;
    }
  }

  /** A brief flash at the barrel, at the moment of firing. */
  spawnMuzzleFlash(x, y, z, color, calibre = REFERENCE_DAMAGE) {
    const m = this._muzzles[this._nextMuzzle];
    this._nextMuzzle = (this._nextMuzzle + 1) % this._muzzles.length;
    m.active = true;
    m.elapsed = 0;
    m.mesh.position.set(x, y, z);
    m.mesh.scale.setScalar(Math.sqrt(Math.max(0.2, calibre / REFERENCE_DAMAGE)));
    m.mat.color.setHex(color);
    m.mat.opacity = 0.9;
    m.mesh.visible = true;
  }

  /**
   * Advance every transient effect. `dt` here is real frame time, not sim
   * time — these are presentation and should decay at the rate the viewer
   * experiences, not the rate the simulation ticks.
   */
  updateEffects(dt) {
    for (const s of this._impacts) {
      if (!s.active) continue;
      s.elapsed += dt;
      const f = Math.min(1, s.elapsed / IMPACT_DURATION);
      // Fast out, slow settle: the fireball's growth eases off while its
      // opacity keeps falling, which is what reads as dissipating rather than
      // simply shrinking.
      s.mesh.scale.setScalar(s.radius * (0.3 + 1.4 * Math.sqrt(f)));
      s.mat.opacity = (1 - f) * (1 - f);
      if (f >= 1) {
        s.active = false;
        s.mesh.visible = false;
      }
    }

    for (const d of this._debris) {
      if (!d.active) continue;
      d.elapsed += dt;
      d.vy -= DEBRIS_GRAVITY * dt;
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.mesh.rotation.x += dt * 6;
      d.mesh.rotation.z += dt * 4;
      // Stops at the ground rather than falling through it. No bounce: a
      // chunk of dirt that bounces reads as a rock, which is the wrong story.
      const groundY = this.heightmap.heightAt(d.mesh.position.x, d.mesh.position.z);
      if (d.mesh.position.y <= groundY) {
        d.mesh.position.y = groundY;
        d.vx = d.vz = d.vy = 0;
      }
      if (d.elapsed >= DEBRIS_DURATION) {
        d.active = false;
        d.mesh.visible = false;
      }
    }

    for (const l of this._lights) {
      if (!l.active) continue;
      l.elapsed += dt;
      const f = Math.min(1, l.elapsed / IMPACT_DURATION);
      // Sharper falloff than the fireball: a real flash is over before the
      // smoke is, and a light that lingers reads as a fire, not an explosion.
      l.light.intensity = l.peak * (1 - f) * (1 - f) * (1 - f);
      if (f >= 1) {
        l.active = false;
        l.light.visible = false;
        l.light.intensity = 0;
      }
    }

    for (const m of this._muzzles) {
      if (!m.active) continue;
      m.elapsed += dt;
      const f = Math.min(1, m.elapsed / MUZZLE_DURATION);
      m.mat.opacity = 0.9 * (1 - f);
      if (f >= 1) {
        m.active = false;
        m.mesh.visible = false;
      }
    }
  }

  /** Every shell is gone (new game, load, terrain regenerate). */
  clear() {
    for (const [, slotIndex] of this._slotFor) {
      const slot = this._shells[slotIndex];
      slot.core.visible = slot.glow.visible = slot.mark.visible = false;
      slot.id = null;
      this._freeShells.push(slotIndex);
    }
    this._slotFor.clear();
    for (const s of this._impacts) {
      s.active = false;
      s.mesh.visible = false;
    }
    for (const d of this._debris) {
      d.active = false;
      d.mesh.visible = false;
    }
    for (const l of this._lights) {
      l.active = false;
      l.light.visible = false;
      l.light.intensity = 0;
    }
    for (const m of this._muzzles) {
      m.active = false;
      m.mesh.visible = false;
    }
  }
}
