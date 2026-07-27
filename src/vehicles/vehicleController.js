import * as THREE from 'three';
import { buildVehicleMesh } from './vehicleFactory.js';

const ARRIVE_DISTANCE = 1.5;
const GRADE_PROBE = 2.5; // world units to look ahead when measuring the climb
const MIN_CLIMB_FACTOR = 0.15; // a near-limit climb is a crawl, not a stop
const _up = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3(1, 0, 0); // body-local forward axis
const _lateral = new THREE.Vector3(0, 0, 1); // body-local lateral axis
const _yawQuat = new THREE.Quaternion();
const _pitchQuat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _contact = new THREE.Vector3();
const _needed = [0, 0, 0, 0]; // per-wheel travel scratch, reused each frame

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

    this.settleOnGround(heightmap);
  }

  /**
   * Sit the vehicle on its wheels.
   *
   * Sampling one point under the chassis is not enough — on any slope the body
   * has to pitch and roll, and rotating a centre-sampled body lifts the wheels
   * off the ground. Instead we sample the terrain under each of the four wheel
   * contacts and fit the body to the plane they describe: pitch from the
   * front/rear difference, roll from the left/right difference, and ride height
   * from the mean, which is exactly where the contact plane's centroid sits.
   */
  settleOnGround(heightmap) {
    const pos = this.group.position;
    const { wheelContacts, wheelbase, track } = this.group.userData;

    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);

    let sum = 0;
    let front = 0;
    let rear = 0;
    let left = 0;
    let right = 0;

    for (const c of wheelContacts) {
      // Rotate the local contact offset into world space by the current heading.
      const wx = pos.x + c.x * cos - c.z * sin;
      const wz = pos.z + c.x * sin + c.z * cos;
      const h = heightmap.heightAt(wx, wz);

      sum += h;
      if (c.x > 0) front += h; else rear += h;
      if (c.z > 0) right += h; else left += h;
    }

    // Two wheels contribute to each of front/rear and left/right.
    const pitch = Math.atan2((front - rear) / 2, wheelbase);
    const roll = Math.atan2((right - left) / 2, track);

    pos.y = sum / wheelContacts.length;

    // Yaw first, then pitch about the body's lateral axis and roll about its
    // forward axis. Composed in local space, so the order is yaw * pitch * roll.
    _yawQuat.setFromAxisAngle(_up, -this.heading);
    _pitchQuat.setFromAxisAngle(_lateral, pitch);
    _rollQuat.setFromAxisAngle(_forward, -roll);

    this.group.quaternion.copy(_yawQuat).multiply(_pitchQuat).multiply(_rollQuat);

    this.applySuspension(heightmap);
  }

  /**
   * Close the last gap. The body sits on the plane through the four contacts,
   * but real terrain curves between them, so a rigid body always leaves a wheel
   * hanging over a crest or dip. Each wheel is allowed to travel in its arch
   * until it meets the ground it is actually over.
   */
  applySuspension(heightmap) {
    const g = this.group;
    const contacts = g.userData.wheelContacts;
    const limit = g.userData.suspensionTravel;
    g.updateMatrixWorld(true);

    // How far each wheel must move to reach the ground it is over. Measured
    // from the group matrix, so it never depends on last frame's travel.
    let maxNeeded = -Infinity;
    let minNeeded = Infinity;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      _contact.set(c.x, 0, c.z).applyMatrix4(g.matrixWorld);
      _needed[i] = heightmap.heightAt(_contact.x, _contact.z) - _contact.y;
      if (_needed[i] > maxNeeded) maxNeeded = _needed[i];
      if (_needed[i] < minNeeded) minNeeded = _needed[i];
    }

    // Ride at the midpoint of what the wheels need rather than their mean.
    // Centring splits the terrain's roughness evenly between compression and
    // droop, so the travel budget only has to cover half the range — pinning
    // the body to either extreme buries one wheel or leaves another hanging.
    const ride = (maxNeeded + minNeeded) / 2;
    g.position.y += ride;

    for (let i = 0; i < contacts.length; i++) {
      contacts[i].mesh.position.y =
        contacts[i].baseY + THREE.MathUtils.clamp(_needed[i] - ride, -limit, limit);
    }
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
