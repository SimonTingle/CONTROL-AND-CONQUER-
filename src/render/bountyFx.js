import * as THREE from 'three';

/**
 * The bobbing, spinning coin that marks a wreck, and its glow.
 *
 * Presentation only — the coins themselves are simulation state and live in
 * `vehicles/bounty.js`. This reads that array each frame and draws it, the
 * same split `projectileFx.js` has from `projectiles.js`.
 *
 * The coin gets the same day/night treatment as a shell does, and reuses
 * `projectileFx`'s `nightFactor` to get it rather than defining a second set
 * of thresholds: by day it is a bright disc with a small dark shadow, at night
 * the shadow becomes a gold glow pool on the ground. Three systems (headlights,
 * shells, coins) agreeing on when night starts is worth the shared import.
 *
 * Bobbing and spinning are driven by *real frame time*, not sim time, and are
 * deliberately not synchronised between coins — nothing reads them, so they
 * are free to be as pretty as they like.
 */

import { nightFactor } from './projectileFx.js';

const POOL_SIZE = 24;
const BOB_HEIGHT = 0.55;
const BOB_SPEED = 2.4; // radians/second
const SPIN_SPEED = 2.9;
/** Height above the ground the coin hovers at, before bobbing. */
const HOVER = 2.1;

/** Credit value that draws a nominal-sized coin; bigger bounties draw bigger. */
const REFERENCE_VALUE = 200;

export class BountyFx {
  constructor(scene, heightmap) {
    this.heightmap = heightmap;
    this._slotFor = new Map();
    this._slots = [];
    this._free = [];
    this._elapsed = 0;

    // A short cylinder on its side reads as a coin from the game's fixed
    // top-down-ish camera far better than a sphere or a flat disc: the disc
    // vanishes edge-on as it spins, and the sphere never reads as currency.
    const coinGeo = new THREE.CylinderGeometry(1, 1, 0.22, 16);
    coinGeo.rotateX(Math.PI / 2);

    const glowGeo = new THREE.PlaneGeometry(1, 1);
    glowGeo.rotateX(-Math.PI / 2);

    for (let i = 0; i < POOL_SIZE; i++) {
      // Gold, matching the HUD's credit colour (`.hud-credits`, #f0c65a) so
      // the coin, the dust it throws and the number it lands in are visibly
      // the same currency.
      const coinMat = new THREE.MeshStandardMaterial({
        color: 0xf0c65a,
        emissive: 0xb8862a,
        emissiveIntensity: 0.8,
        metalness: 0.85,
        roughness: 0.28,
      });
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0xf0c65a,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const groundMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });

      const coin = new THREE.Mesh(coinGeo, coinMat);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), haloMat);
      const ground = new THREE.Mesh(glowGeo, groundMat);
      coin.castShadow = true;
      coin.frustumCulled = false;
      halo.frustumCulled = false;
      ground.frustumCulled = false;
      coin.visible = halo.visible = ground.visible = false;
      scene.add(coin, halo, ground);

      this._slots.push({ coin, halo, ground, coinMat, haloMat, groundMat, phase: 0 });
      this._free.push(i);
    }
  }

  /**
   * @param {Array} live `bounties.instances` — read only
   * @param {number} dt real frame time
   * @param {number} elevation sun elevation, degrees
   */
  update(live, dt, elevation) {
    this._elapsed += dt;
    const night = nightFactor(elevation);
    const seen = new Set();

    for (const c of live) {
      seen.add(c.id);
      let index = this._slotFor.get(c.id);
      if (index === undefined) {
        // Out of slots: the coin is still there and still collectable, it just
        // isn't drawn. As with shells, the simulation is unaffected — which is
        // what makes a fixed pool safe.
        if (this._free.length === 0) continue;
        index = this._free.pop();
        this._slotFor.set(c.id, index);
        const s = this._slots[index];
        // Offset per coin so a field of them doesn't bob in lockstep, which
        // reads as a mechanism rather than as loose objects.
        s.phase = (c.id % 16) * 0.4;
        s.coin.visible = s.halo.visible = s.ground.visible = true;
      }

      const s = this._slots[index];
      // A richer bounty is a bigger, brighter coin — the value is legible from
      // the coin itself, before you drive over it and read the number.
      const scale = 0.7 * Math.cbrt(Math.max(0.25, c.value / REFERENCE_VALUE));
      const groundY = this.heightmap.heightAt(c.x, c.z);
      const bob = Math.sin(this._elapsed * BOB_SPEED + s.phase) * BOB_HEIGHT;

      s.coin.position.set(c.x, groundY + HOVER + bob, c.z);
      s.coin.rotation.y = this._elapsed * SPIN_SPEED + s.phase;
      s.coin.scale.setScalar(scale);

      s.halo.position.copy(s.coin.position);
      s.halo.scale.setScalar(scale * (1.9 + 0.15 * Math.sin(this._elapsed * 3 + s.phase)));
      // The halo carries almost all of the coin's night-time presence, so it
      // brightens as the sun goes down rather than sitting at one opacity.
      s.haloMat.opacity = 0.18 + 0.34 * night;

      s.ground.position.set(c.x, groundY + 0.09, c.z);
      if (night < 0.5) {
        const dayness = 1 - night * 2;
        s.groundMat.blending = THREE.NormalBlending;
        s.groundMat.color.setHex(0x000000);
        s.groundMat.opacity = 0.3 * dayness;
        s.ground.scale.setScalar(scale * 2.4);
      } else {
        const nightness = (night - 0.5) * 2;
        s.groundMat.blending = THREE.AdditiveBlending;
        s.groundMat.color.setHex(0xf0c65a);
        s.groundMat.opacity = 0.34 * nightness;
        s.ground.scale.setScalar(scale * 6);
      }
      s.groundMat.needsUpdate = true;
    }

    for (const [id, index] of this._slotFor) {
      if (seen.has(id)) continue;
      const s = this._slots[index];
      s.coin.visible = s.halo.visible = s.ground.visible = false;
      this._slotFor.delete(id);
      this._free.push(index);
    }
  }

  clear() {
    for (const [, index] of this._slotFor) {
      const s = this._slots[index];
      s.coin.visible = s.halo.visible = s.ground.visible = false;
      this._free.push(index);
    }
    this._slotFor.clear();
  }
}
