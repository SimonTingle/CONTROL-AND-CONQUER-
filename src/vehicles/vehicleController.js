import * as THREE from 'three';
import { buildVehicleMesh } from './vehicleFactory.js';

const ARRIVE_DISTANCE = 1.5;
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
  }

  /** Order a move. Silently refused if the point is underwater. */
  setTarget(x, z, heightmap) {
    if (heightmap.heightAt(x, z) <= heightmap.seaLevelY) return false;
    this.target = new THREE.Vector2(x, z);
    return true;
  }

  update(dt, heightmap) {
    const pos = this.group.position;

    if (this.target) {
      const dx = this.target.x - pos.x;
      const dz = this.target.y - pos.z;
      const dist = Math.hypot(dx, dz);

      if (dist < ARRIVE_DISTANCE) {
        this.target = null;
      } else {
        const desiredHeading = Math.atan2(dz, dx);
        let delta = desiredHeading - this.heading;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest turn
        const maxTurn = this.def.turnSpeed * dt;
        this.heading += THREE.MathUtils.clamp(delta, -maxTurn, maxTurn);

        // Slow down while still turning sharply, and while approaching.
        const alignment = Math.max(0, Math.cos(delta));
        const speed = this.def.speed * alignment * Math.min(1, dist / 6);
        pos.x += Math.cos(this.heading) * speed * dt;
        pos.z += Math.sin(this.heading) * speed * dt;
      }
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
