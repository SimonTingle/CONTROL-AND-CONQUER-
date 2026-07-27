import * as THREE from 'three';
import { buildVehicleMesh } from './vehicleFactory.js';

const ARRIVE_DISTANCE = 1.5;
const GRADE_PROBE = 2.5; // world units to look ahead when measuring the climb
const MIN_CLIMB_FACTOR = 0.15; // a near-limit climb is a crawl, not a stop
const _up = new THREE.Vector3(0, 1, 0);
const _normal = new THREE.Vector3();
const _tiltQuat = new THREE.Quaternion();
const _yawQuat = new THREE.Quaternion();

/** One spawned, drivable vehicle. */
class VehicleInstance {
  constructor(def, spawnPoint, facing) {
    this.def = def;
    this.group = buildVehicleMesh(def);
    this.group.position.copy(spawnPoint);
    this.heading = facing;
    this.target = null;
    this.speed = 0;
    this.grade = 0;
    this.blocked = false;
  }

  /** Order a move. Silently refused if the point is underwater. */
  setTarget(x, z, heightmap) {
    if (heightmap.heightAt(x, z) <= heightmap.seaLevelY) return false;
    this.target = new THREE.Vector2(x, z);
    this.blocked = false;
    return true;
  }

  /** Order finished — reached, or given up on. */
  arrive() {
    this.target = null;
    this.speed = 0;
  }

  /** True while this vehicle is actively driving toward an order. */
  get hasOrder() {
    return this.target !== null;
  }

  update(dt, heightmap) {
    const pos = this.group.position;

    if (this.target) {
      const dx = this.target.x - pos.x;
      const dz = this.target.y - pos.z;
      const dist = Math.hypot(dx, dz);

      if (dist < ARRIVE_DISTANCE) {
        this.arrive();
      } else {
        const desiredHeading = Math.atan2(dz, dx);
        let delta = desiredHeading - this.heading;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest turn
        const maxTurn = this.def.turnSpeed * dt;
        this.heading += THREE.MathUtils.clamp(delta, -maxTurn, maxTurn);

        // Sample the ground a short way ahead to get the grade the vehicle is
        // about to drive into — rise over run, positive uphill.
        const aheadX = pos.x + Math.cos(this.heading) * GRADE_PROBE;
        const aheadZ = pos.z + Math.sin(this.heading) * GRADE_PROBE;
        const grade =
          (heightmap.heightAt(aheadX, aheadZ) - heightmap.heightAt(pos.x, pos.z)) / GRADE_PROBE;
        this.grade = grade;

        if (grade > this.def.maxClimbGrade) {
          // Too steep to climb: abandon the order rather than grind against the
          // slope forever. This is the terrain limit, not just a slowdown.
          this.blocked = true;
          this.target = null;
        } else {
          this.blocked = false;

          // Uphill costs speed, approaching the climb limit costs nearly all of
          // it; downhill gives back a little.
          const terrainFactor =
            grade > 0
              ? Math.max(MIN_CLIMB_FACTOR, 1 - (grade / this.def.maxClimbGrade) * 0.85)
              : Math.min(1.25, 1 + -grade * 0.35);

          // Slow down while still turning sharply, and while approaching.
          const alignment = Math.max(0, Math.cos(delta));
          const speed = this.def.speed * alignment * Math.min(1, dist / 6) * terrainFactor;
          this.speed = speed;
          pos.x += Math.cos(this.heading) * speed * dt;
          pos.z += Math.sin(this.heading) * speed * dt;
        }
      }
    } else {
      this.speed = 0;
    }

    pos.y = heightmap.heightAt(pos.x, pos.z) + this.group.userData.groundClearance;

    // Orient to face the heading, then tilt to match the ground normal so the
    // vehicle visibly sits on slopes instead of floating level above them.
    heightmap.normalAt(pos.x, pos.z, _normal);
    _yawQuat.setFromAxisAngle(_up, -this.heading);
    _tiltQuat.setFromUnitVectors(_up, _normal);
    this.group.quaternion.slerpQuaternions(this.group.quaternion, _tiltQuat.multiply(_yawQuat), 0.25);
  }
}

/** Owns every spawned vehicle and the one the player currently controls. */
export class VehicleController {
  constructor(scene) {
    this.scene = scene;
    this.instances = [];
    this.active = null;
  }

  spawn(def, spawnPoint, facing = 0) {
    const instance = new VehicleInstance(def, spawnPoint, facing);
    this.instances.push(instance);
    this.scene.add(instance.group);
    this.active = instance;
    return instance;
  }

  /** Move order for whichever vehicle the player is currently driving. */
  commandActive(x, z, heightmap) {
    return this.active?.setTarget(x, z, heightmap) ?? false;
  }

  update(dt, heightmap) {
    for (const instance of this.instances) instance.update(dt, heightmap);
  }
}
