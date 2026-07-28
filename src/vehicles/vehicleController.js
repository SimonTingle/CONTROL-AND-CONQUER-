import * as THREE from 'three';
import { buildVehicleMesh } from './vehicleFactory.js';

const ARRIVE_DISTANCE = 1.5;
const BRAKE_SPEED = 0.1; // at or below this the vehicle counts as stopped
const STEER_GAIN = 1.8; // how hard a click order leans on the steering
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
    this.speed = 0; // magnitude, for HUD
    this.forwardSpeed = 0; // signed, negative in reverse
    this.throttle = 0;
    this.steer = 0;
    this.accelerating = false;
    this.steerAngle = 0; // current front-wheel angle, radians
    this.grade = 0;
    this.blocked = false;
    this.headlightsOn = false;
  }

  /**
   * Radius of the tightest circle this vehicle can drive, from its steering
   * geometry. A long wheelbase or a modest lock angle means a wide circle —
   * this is what makes each vehicle handle distinctly.
   */
  get turningRadius() {
    return this.group.userData.wheelbase / Math.tan(this.def.maxSteerAngle);
  }

  /** Kerb-to-kerb diameter, the number people actually quote. */
  get turningCircle() {
    return this.turningRadius * 2;
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
    this.forwardSpeed = 0;
    this.speed = 0;
    this.accelerating = false;
  }

  /** True while this vehicle is actively driving toward an order. */
  get hasOrder() {
    return this.target !== null;
  }

  /**
   * Player input for this frame. Any real input cancels a click order, so
   * grabbing the keys takes over rather than fighting an outstanding move.
   */
  setDriveInput(throttle, steer) {
    this.throttle = throttle;
    this.steer = steer;
    if (throttle !== 0 || steer !== 0) this.target = null;
  }

  /**
   * Reads the ground the vehicle is about to drive into.
   *
   * Shared by manual driving and click-to-move so terrain-dependent speed and
   * the impassable-climb limit behave identically however the vehicle is driven.
   *
   * @returns {{grade: number, factor: number, climbable: boolean}} `factor`
   *   scales top speed: uphill costs speed, downhill gives a little back.
   */
  readGrade(heightmap) {
    const pos = this.group.position;
    const aheadX = pos.x + Math.cos(this.heading) * GRADE_PROBE;
    const aheadZ = pos.z + Math.sin(this.heading) * GRADE_PROBE;
    const grade =
      (heightmap.heightAt(aheadX, aheadZ) - heightmap.heightAt(pos.x, pos.z)) / GRADE_PROBE;
    this.grade = grade;

    const climbable = grade <= this.def.maxClimbGrade;
    const factor =
      grade > 0
        ? Math.max(MIN_CLIMB_FACTOR, 1 - (grade / this.def.maxClimbGrade) * 0.85)
        : Math.min(1.25, 1 + -grade * 0.35);

    return { grade, factor, climbable };
  }

  update(dt, heightmap) {
    if (this.throttle !== 0 || this.steer !== 0) this.driveManual(dt, heightmap);
    else if (this.target) this.driveToTarget(dt, heightmap);
    else this.coast(dt, heightmap);

    this.settleOnGround(heightmap);
  }

  /**
   * Ease the front wheels toward a target angle, then yaw the body by what
   * that steering geometry actually produces.
   *
   * This is the bicycle model: a vehicle with wheelbase L at steer angle δ
   * travelling at speed v rotates at v·tan(δ)/L, tracing a circle of radius
   * L/tan(δ). Two things fall out for free that a flat yaw rate has to fake —
   * it cannot turn while stationary, and reversing swings the tail the other
   * way, because both follow from v's magnitude and sign.
   */
  applySteering(dt, targetAngle) {
    const maxAngle = this.def.maxSteerAngle;
    const clamped = THREE.MathUtils.clamp(targetAngle, -maxAngle, maxAngle);
    const step = this.def.steerRate * dt;
    this.steerAngle += THREE.MathUtils.clamp(clamped - this.steerAngle, -step, step);

    if (this.steerAngle !== 0 && this.forwardSpeed !== 0) {
      const wheelbase = this.group.userData.wheelbase;
      this.heading += (this.forwardSpeed / wheelbase) * Math.tan(this.steerAngle) * dt;
    }

    // Point the front wheels where they are actually steering.
    for (const wheel of this.group.userData.steeredWheels) wheel.rotation.y = -this.steerAngle;
  }

  /** Advance along the current heading and keep `speed` reporting magnitude. */
  advance(dt) {
    const pos = this.group.position;
    pos.x += Math.cos(this.heading) * this.forwardSpeed * dt;
    pos.z += Math.sin(this.heading) * this.forwardSpeed * dt;
    this.speed = Math.abs(this.forwardSpeed);
  }

  driveManual(dt, heightmap) {
    const def = this.def;
    const { factor, climbable } = this.readGrade(heightmap);

    // Front wheels swing toward lock at a finite rate, so the steering has
    // weight instead of snapping to full lock the instant a key goes down.
    this.applySteering(dt, this.steer * def.maxSteerAngle);

    if (this.throttle > 0) {
      this.accelerating = true;
      this.blocked = !climbable;
      if (climbable) {
        this.forwardSpeed = Math.min(this.forwardSpeed + def.acceleration * dt, def.speed * factor);
      } else {
        // Too steep: the slope stops it dead rather than letting it crawl up.
        this.forwardSpeed = Math.min(this.forwardSpeed, 0);
      }
    } else if (this.throttle < 0) {
      this.accelerating = false;
      this.blocked = false;
      // Brake first, then pull away in reverse once actually stopped.
      this.forwardSpeed =
        this.forwardSpeed > 0.1
          ? Math.max(this.forwardSpeed - def.braking * dt, 0)
          : Math.max(this.forwardSpeed - def.acceleration * dt, -def.reverseSpeed * factor);
    } else {
      this.accelerating = false;
      this.applyRollingResistance(dt);
    }

    this.advance(dt);
  }

  /** Click-to-move (mobile): steer toward the order and drive it out. */
  driveToTarget(dt, heightmap) {
    const pos = this.group.position;
    const dx = this.target.x - pos.x;
    const dz = this.target.y - pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < ARRIVE_DISTANCE) {
      this.arrive();
      return;
    }

    const desiredHeading = Math.atan2(dz, dx);
    let delta = desiredHeading - this.heading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // shortest turn

    const { factor, climbable } = this.readGrade(heightmap);
    if (!climbable) {
      // Abandon the order rather than grind against the slope forever.
      this.blocked = true;
      this.arrive();
      return;
    }
    this.blocked = false;
    this.accelerating = true;

    // Ease off while still turning sharply, and while closing on the target.
    const alignment = Math.max(0, Math.cos(delta));
    this.forwardSpeed = this.def.speed * alignment * Math.min(1, dist / 6) * factor;

    // Steer toward the target through the same geometry the player drives
    // through, so a click order obeys the vehicle's turning circle too.
    this.applySteering(dt, delta * STEER_GAIN);
    this.advance(dt);
  }

  /** No input, no order — roll to a stop. */
  coast(dt, heightmap) {
    this.accelerating = false;
    if (Math.abs(this.forwardSpeed) > 0.001) {
      this.readGrade(heightmap);
      this.applyRollingResistance(dt);
      // Hands off the wheel: the steering self-centres, and the vehicle keeps
      // arcing while it does, the way a rolling car does.
      this.applySteering(dt, 0);
      this.advance(dt);
    } else {
      this.forwardSpeed = 0;
      this.speed = 0;
    }
  }

  applyRollingResistance(dt) {
    const drop = this.def.rollingResistance * dt;
    this.forwardSpeed =
      this.forwardSpeed > 0
        ? Math.max(this.forwardSpeed - drop, 0)
        : Math.min(this.forwardSpeed + drop, 0);
  }

  /** Brake lights whenever it is not being driven forward under power. */
  get braking() {
    return !this.accelerating || this.forwardSpeed <= BRAKE_SPEED;
  }

  /** Reversing lamps follow the gearbox, not the driver's hands. */
  get reversing() {
    return this.forwardSpeed < -BRAKE_SPEED;
  }

  /**
   * Lamps. Headlights follow the sun; tail lights read the drivetrain.
   * @param {boolean} headlightsOn
   */
  updateLights(headlightsOn) {
    const lights = this.group.userData.lights;
    if (!lights) return;

    this.headlightsOn = headlightsOn;
    lights.headlampMaterial.emissiveIntensity = headlightsOn ? 2.2 : 0;
    for (const spot of lights.spots) {
      spot.intensity = headlightsOn ? lights.config.beamIntensity : 0;
    }

    // Dim running lights once the lamps are on, full red under braking.
    const running = headlightsOn ? 0.55 : 0;
    lights.tailMaterial.emissiveIntensity = this.braking ? 3.0 : running;

    // Reversing lamps are wired to the gearbox, so the lenses glow whenever the
    // vehicle is actually rolling backwards — day or night, like a real car.
    // The beam itself only lights up after dark, or it would wash a bright
    // patch onto sunlit ground for no visible benefit.
    const reversing = this.reversing;
    lights.reverseMaterial.emissiveIntensity = reversing ? 2.6 : 0;
    for (const spot of lights.reverseSpots) {
      spot.intensity = reversing && headlightsOn ? lights.config.reverseBeamIntensity : 0;
    }
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

  /** Route keyboard driving to the vehicle the player is currently in. */
  driveActive(throttle, steer) {
    this.active?.setDriveInput(throttle, steer);
  }

  /**
   * @param {boolean} headlightsOn driven by time of day, decided by the caller
   *   so the fleet does not have to know about the sky.
   */
  update(dt, heightmap, headlightsOn = false) {
    for (const instance of this.instances) {
      instance.update(dt, heightmap);
      instance.updateLights(headlightsOn);
    }
  }
}
