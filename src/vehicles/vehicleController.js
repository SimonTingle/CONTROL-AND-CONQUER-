import * as THREE from 'three';
import { buildVehicleMesh } from './vehicleFactory.js';
import { VEHICLE_CATALOG } from './catalog.js';
import { disposeObject3D } from '../core/disposeObject3D.js';

const ARRIVE_DISTANCE = 1.5;
const BRAKE_SPEED = 0.1; // at or below this the vehicle counts as stopped
const STEER_GAIN = 1.8; // how hard a click order leans on the steering
const GRADE_PROBE = 2.5; // world units to look ahead when measuring the climb
const MIN_CLIMB_FACTOR = 0.15; // a near-limit climb is a crawl, not a stop
// Grinding against terrain too steep to climb wears the vehicle down — just
// enough to give the repair bay a real reason to run. Floored well above
// zero: nothing here destroys a vehicle.
const BLOCKED_DAMAGE_RATE = 0.6; // health/second while blocked
const BLOCKED_DAMAGE_FLOOR = 0.15; // fraction of maxHealth
const _up = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3(1, 0, 0); // body-local forward axis
const _lateral = new THREE.Vector3(0, 0, 1); // body-local lateral axis
const _yawQuat = new THREE.Quaternion();
const _pitchQuat = new THREE.Quaternion();
const _rollQuat = new THREE.Quaternion();
const _contact = new THREE.Vector3();

const LOD_TIERS = {
  FULL: 0,  // 0-40 units: full detail, all lights
  MID: 1,   // 40-100 units: headlamps only
  LOW: 2,   // 100+ units: no lights
};
const LOD_DISTANCES = [40, 100];

// Per-wheel travel scratch, reused each frame and grown for the widest rig seen.
// Shared across instances safely because it never outlives a single call.
let _needed = new Float64Array(8);
function travelScratch(n) {
  if (_needed.length < n) _needed = new Float64Array(n);
  return _needed;
}

/** One spawned, drivable vehicle. */
class VehicleInstance {
  constructor(def, spawnPoint, facing, teamId = 0) {
    this.def = def;
    // Discriminates the two destroyable kinds without a fragile array lookup
    // (an instance mid-destroy may already be spliced from its owner's array
    // by the time a later hook runs). See core/entities.js.
    this.kind = 'vehicle';
    // Numeric, not a Team reference — see core/team.js for why.
    this.teamId = teamId;
    this.group = buildVehicleMesh(def);
    this.group.position.copy(spawnPoint);
    this.heading = facing;
    this.target = null;
    // Nothing damages a vehicle yet; the field exists so the HUD has a real
    // value to read and combat has somewhere to write.
    this.health = def.maxHealth;
    // 'mobile' | 'armed' | 'deploying' | 'deployed'. Commands drive the
    // transitions; 'deploying' -> 'deployed' is fired by the terraform when the
    // pad finishes, so the vehicle never claims to be deployed before the
    // ground under it actually is.
    this.mode = 'mobile';
    this.sweepPhase = 0;
    this.speed = 0; // magnitude, for HUD
    this.forwardSpeed = 0; // signed, negative in reverse
    this.throttle = 0;
    this.steer = 0;
    this.accelerating = false;
    this.steerAngle = 0; // current front-wheel angle, radians
    this.grade = 0;
    this.blocked = false;
    // Set fresh each tick by TrafficController, ahead of movement — true holds
    // an autonomous vehicle in place rather than push through one nearby.
    this.yielding = false;
    // Seconds remaining in a reverse maneuver, or null when not reversing —
    // see beginReverse().
    this.reverseTimer = null;
    this.headlightsOn = false;
    this.lodTier = LOD_TIERS.FULL; // distance-based level of detail
    this.createdAt = Date.now(); // timestamp for menu ordering
    // Set by RadialMenu while this vehicle's command menu is up. An autonomous
    // driver holds position while it is true, so the menu does not slide away
    // from under the player's cursor mid-decision.
    this.menuOpen = false;
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

  /**
   * Mobility multipliers for the current mode. Getters consulted where speed is
   * used, rather than mutating `def` — the catalog entry is shared by every
   * instance and must stay the vehicle's spec, not its current condition.
   */
  get speedFactor() {
    return this.mode === 'armed' ? this.def.turret?.armedSpeedFactor ?? 0.35 : 1;
  }

  get steerFactor() {
    return this.mode === 'armed' ? this.def.turret?.armedSteerFactor ?? 0.4 : 1;
  }

  /** Screen-space anchor for the radial menu, so it need not know about wheels. */
  get menuAnchorHeight() {
    return this.def.dims.hullHeight + this.def.dims.wheelRadius * 2;
  }

  /** Deployed or deploying: the vehicle is committed to a spot and cannot drive. */
  /** Only mid-flatten is locked down — once deployed the base is free to
   * drive off its dock spot (nothing in the pad/building system is tied to
   * its live position; see deployOrigin below for what does track it). */
  get immobile() {
    return this.mode === 'deploying';
  }

  /** Order a move. Silently refused if the point is underwater. */
  setTarget(x, z, heightmap) {
    if (this.immobile) return false;
    if (heightmap.heightAt(x, z) <= heightmap.seaLevelY) return false;
    this.target = new THREE.Vector2(x, z);
    this.blocked = false;
    return true;
  }

  /**
   * Order finished — reached, or given up on.
   *
   * The reason is for the HUD badge and for logging. It is deliberately *not*
   * something an autonomous driver should steer by: like `blocked`, nothing
   * clears it on the coasting path, so it goes stale. A driver that needs to
   * know whether it arrived should measure its own distance to its own goal.
   *
   * @param {'reached'|'blocked'|'cancelled'} [reason]
   */
  arrive(reason = 'reached') {
    this.lastArrival = reason;
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
    // Refused at the input rather than in update(): with nothing held and no
    // target, update() already falls through to coast(), so immobility needs no
    // branch of its own.
    if (this.immobile) {
      this.throttle = 0;
      this.steer = 0;
      return;
    }
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
  /**
   * @param {import('../terrain/heightmap.js').Heightmap} heightmap
   * @param {number} [heading] probe direction; defaults to the vehicle's own.
   *   `driveToTarget` passes the heading it is turning toward, not the current
   *   one — otherwise a vehicle parked facing a locally steep patch reads as
   *   blocked for literally any destination. It can never clear that on its
   *   own: forwardSpeed stays at zero while blocked, and the bicycle-model
   *   steering can only turn a vehicle that is already moving.
   */
  readGrade(heightmap, heading = this.heading) {
    const pos = this.group.position;
    const aheadX = pos.x + Math.cos(heading) * GRADE_PROBE;
    const aheadZ = pos.z + Math.sin(heading) * GRADE_PROBE;
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
    // Manual input always wins, the same as every other override in this
    // class — a reverse maneuver only an autonomous driver would have
    // started should not fight the player's own hands on the wheel.
    if (this.reverseTimer != null && this.throttle === 0 && this.steer === 0) {
      this._driveReverse(dt, heightmap);
      this.settleOnGround(heightmap);
      return;
    }

    if (this.throttle !== 0 || this.steer !== 0) this.driveManual(dt, heightmap);
    else if (this.target) this.driveToTarget(dt, heightmap);
    else this.coast(dt, heightmap);

    this.settleOnGround(heightmap);
  }

  /**
   * Back straight up for `duration` seconds — no steering, whatever order is
   * live stays live (untouched), so normal driving just resumes toward it
   * once this clears. For an autonomous vehicle whose forward path is
   * genuinely blocked, backing off is often the only thing that actually
   * creates room; a forward-angled detour alone can't help a vehicle that's
   * already touching the obstacle.
   */
  beginReverse(duration) {
    this.reverseTimer = duration;
  }

  _driveReverse(dt, heightmap) {
    this.reverseTimer -= dt;
    this.accelerating = false;
    // Probe the grade behind it — that's the direction it's about to travel.
    const { factor, climbable } = this.readGrade(heightmap, this.heading + Math.PI);
    if (climbable) {
      this.forwardSpeed = Math.max(
        this.forwardSpeed - this.def.acceleration * dt,
        -this.def.reverseSpeed * factor * this.speedFactor
      );
    } else {
      // Backing into terrain just as bad — don't crawl into it either.
      this.forwardSpeed = Math.min(this.forwardSpeed, 0);
    }
    this.advance(dt);

    if (this.reverseTimer <= 0) {
      this.reverseTimer = null;
      this.forwardSpeed = 0;
    }
  }

  /**
   * Called only from the frame `blocked` is actively (re)determined — never
   * from a blanket per-frame check. `blocked` has no path back to false once
   * a vehicle gives up trying (coasting doesn't touch it), so gating damage
   * on the flag alone would grind a motionless, no-longer-trying vehicle down
   * forever instead of just the moment it's genuinely pushing against terrain.
   */
  _applyBlockedDamage(dt) {
    const floor = this.def.maxHealth * BLOCKED_DAMAGE_FLOOR;
    this.health = Math.max(floor, this.health - BLOCKED_DAMAGE_RATE * dt);
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
    const step = this.def.steerRate * this.steerFactor * dt;
    this.steerAngle += THREE.MathUtils.clamp(clamped - this.steerAngle, -step, step);

    if (this.steerAngle !== 0 && this.forwardSpeed !== 0) {
      const wheelbase = this.group.userData.wheelbase;
      this.heading += (this.forwardSpeed / wheelbase) * Math.tan(this.steerAngle) * dt;
    }

    // Point the steered wheels where they are actually steering. A second
    // steering axle takes a fraction of full lock, as on a real 8x8.
    // Both wheels on an axle take the same angle: true Ackermann turns the
    // inner wheel more than the outer, which is only visible at full lock from
    // very close in — deliberately skipped, not overlooked.
    for (const wheel of this.group.userData.steeredWheels) {
      wheel.rotation.y = -this.steerAngle * wheel.userData.steerRatio;
    }
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
      if (this.blocked) this._applyBlockedDamage(dt);
      if (climbable) {
        this.forwardSpeed = Math.min(
          this.forwardSpeed + def.acceleration * dt,
          def.speed * factor * this.speedFactor
        );
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
          : Math.max(
              this.forwardSpeed - def.acceleration * dt,
              -def.reverseSpeed * factor * this.speedFactor
            );
    } else {
      this.accelerating = false;
      this.applyRollingResistance(dt);
    }

    this.advance(dt);
  }

  /** Click-to-move (mobile): steer toward the order and drive it out. */
  driveToTarget(dt, heightmap) {
    // Set by TrafficController just before this runs, for autonomous vehicles
    // with another one nearby. A hold, not an abandonment — the order stays
    // live, and driving resumes on its own the moment the flag clears.
    if (this.yielding) {
      this.forwardSpeed = 0;
      this.speed = 0;
      this.accelerating = false;
      return;
    }

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

    const { factor, climbable } = this.readGrade(heightmap, desiredHeading);
    if (!climbable) {
      // Abandon the order rather than grind against the slope forever.
      this.blocked = true;
      this._applyBlockedDamage(dt);
      this.arrive('blocked');
      return;
    }
    this.blocked = false;
    this.accelerating = true;

    // Ease off while still turning sharply, and while closing on the target.
    // Floored rather than clamped to zero: the bicycle model can only turn a
    // vehicle that is moving (heading changes with forwardSpeed), so a vehicle
    // starting out pointed away from its target — a harvester rolling off a
    // dock, say — would otherwise sit at exactly zero speed forever, unable to
    // ever turn toward where it needs to go. A slow crawl lets it arc round.
    const alignment = Math.max(0.12, Math.cos(delta));
    // driveToTarget assigns speed outright rather than through the acceleration
    // cap, so the armed factor has to be applied here too.
    this.forwardSpeed =
      this.def.speed * this.speedFactor * alignment * Math.min(1, dist / 6) * factor;

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
  /**
   * Traverse the turret.
   *
   * Armed, it ping-pongs across the fire arc rather than spinning continuously:
   * a sweep reads as *scanning* where a full rotation reads as broken, it never
   * has to wrap an angle, and it exercises the same `fireArc` the targeting
   * model will clamp against once there is something to acquire.
   */
  updateTurret(dt) {
    const turret = this.group.userData.turret;
    if (!turret) return;

    if (this.mode === 'armed') {
      this.sweepPhase += dt * this.def.turret.sweepRate;
      turret.rotation.y = Math.sin(this.sweepPhase) * (this.def.turret.fireArc / 2);
    } else if (turret.rotation.y !== 0) {
      // Stow forward when disarmed, rather than freezing mid-sweep.
      turret.rotation.y = THREE.MathUtils.damp(turret.rotation.y, 0, 6, dt);
      if (Math.abs(turret.rotation.y) < 1e-3) turret.rotation.y = 0;
      this.sweepPhase = 0;
    }
  }

  updateLOD(camera) {
    const dist = this.group.position.distanceTo(camera.position);
    let newTier = LOD_TIERS.FULL;
    if (dist > LOD_DISTANCES[1]) newTier = LOD_TIERS.LOW;
    else if (dist > LOD_DISTANCES[0]) newTier = LOD_TIERS.MID;

    if (newTier === this.lodTier) return;
    this.lodTier = newTier;

    const lights = this.group.userData.lights;
    if (!lights) return;

    // Lights visible at all zoom levels; updateLights controls intensity
    for (const spot of lights.spots) spot.visible = true;
    for (const spot of lights.tailSpots) spot.visible = true;
    for (const spot of lights.reverseSpots) spot.visible = true;
  }

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

    // The lamps also throw a faint red wash on the ground behind. Like the
    // reversing beam it only lights up once the headlights are on: a red patch
    // on sunlit grass reads as a rendering fault rather than a brake light.
    const tailGlow = headlightsOn ? (this.braking ? 1 : 0.3) : 0;
    for (const spot of lights.tailSpots) {
      spot.intensity = lights.config.tailBeamIntensity * tailGlow;
    }

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
   * off the ground. Instead we sample the terrain under every wheel contact and
   * fit the body to the least-squares plane through them, with ride height from
   * the mean, which is exactly where that plane's centroid sits.
   *
   * The fit rather than a front/rear average because axles need not be evenly
   * spaced: an 8x8 with a close-coupled rear bogie has its wheel centroid off
   * the body centre, and group averages silently mis-report pitch for it. For a
   * symmetric four-wheeler the two are algebraically identical.
   */
  settleOnGround(heightmap) {
    const pos = this.group.position;
    const { wheelContacts, contactFit } = this.group.userData;
    const { cx, cz, dxx, dzz } = contactFit;

    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);

    let sum = 0;
    let sxh = 0;
    let szh = 0;

    for (const c of wheelContacts) {
      // Rotate the local contact offset into world space by the current heading.
      const wx = pos.x + c.x * cos - c.z * sin;
      const wz = pos.z + c.x * sin + c.z * cos;
      const h = heightmap.heightAt(wx, wz);

      sum += h;
      // Σ(x−x̄)h is Σ(x−x̄)(h−h̄), since Σ(x−x̄) is zero by construction.
      sxh += (c.x - cx) * h;
      szh += (c.z - cz) * h;
    }

    const pitch = Math.atan(dxx > 0 ? sxh / dxx : 0);
    const roll = Math.atan(dzz > 0 ? szh / dzz : 0);

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
    const needed = travelScratch(contacts.length);
    g.updateMatrixWorld(true);

    // How far each wheel must move to reach the ground it is over. Measured
    // from the group matrix, so it never depends on last frame's travel.
    let maxNeeded = -Infinity;
    let minNeeded = Infinity;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      _contact.set(c.x, 0, c.z).applyMatrix4(g.matrixWorld);
      needed[i] = heightmap.heightAt(_contact.x, _contact.z) - _contact.y;
      if (needed[i] > maxNeeded) maxNeeded = needed[i];
      if (needed[i] < minNeeded) minNeeded = needed[i];
    }

    // Ride at the midpoint of what the wheels need rather than their mean.
    // Centring splits the terrain's roughness evenly between compression and
    // droop, so the travel budget only has to cover half the range — pinning
    // the body to either extreme buries one wheel or leaves another hanging.
    const ride = (maxNeeded + minNeeded) / 2;
    g.position.y += ride;

    for (let i = 0; i < contacts.length; i++) {
      contacts[i].mesh.position.y =
        contacts[i].baseY + THREE.MathUtils.clamp(needed[i] - ride, -limit, limit);
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

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.activate] false to spawn without taking the keys —
   *   a factory shipping a unit must not yank the camera off whatever the
   *   player was watching.
   * @param {number} [opts.teamId] owning team; defaults to the player's, so
   *   every existing caller keeps spawning player units unchanged.
   */
  spawn(def, spawnPoint, facing = 0, { activate = true, teamId = 0 } = {}) {
    const instance = new VehicleInstance(def, spawnPoint, facing, teamId);
    this.instances.push(instance);
    // So a raycast hit on any part of the mesh can walk up to its instance.
    instance.group.userData.selectable = instance;
    this.scene.add(instance.group);
    if (!activate) return instance;
    // Through setActive, so a vehicle left with the throttle held does not
    // drive off on its own the moment the player spawns another one.
    return this.setActive(instance);
  }

  /**
   * The real removal — take the instance out of the world for good. Called
   * from entities.js's destroy pipeline, after every other system's own
   * cleanup hook has had a chance to run, so nothing downstream is still
   * reading this instance's mesh or position when it disposes.
   */
  remove(inst) {
    const i = this.instances.indexOf(inst);
    if (i !== -1) this.instances.splice(i, 1);
    // Defensive: the caller's own onDestroy hook is what normally reassigns
    // `active` before this runs, so this is only ever a no-op safety net.
    if (this.active === inst) this.active = null;
    this.scene.remove(inst.group);
    disposeObject3D(inst.group);
  }

  /** Catalog lookup by id, so commands can price a unit without importing the catalog. */
  defOf(id) {
    return VEHICLE_CATALOG.find((d) => d.id === id) ?? null;
  }

  /**
   * The spawned instance of a catalog entry owned by a team, if there is one.
   * Team-scoped because "do I already have one of these?" is only ever a
   * question about your own fleet.
   */
  instanceOf(def, teamId = 0) {
    return this.instances.find((i) => i.def.id === def.id && i.teamId === teamId) ?? null;
  }

  /**
   * Hand control to an already-spawned vehicle. The others stay in the world
   * and keep being updated — a parked scout is still a scout, it just is not
   * the one the keys are wired to.
   */
  setActive(instance) {
    if (!instance) return null;
    // Drop any input the outgoing vehicle was holding, or it drives off on its
    // own the moment the player takes the keys elsewhere.
    if (this.active && this.active !== instance) {
      this.active.setDriveInput(0, 0);
      this.active.target = null;
    }
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
   * @param {THREE.Camera} [camera] for LOD distance calculations
   */
  update(dt, heightmap, headlightsOn = false, camera = null) {
    for (const instance of this.instances) {
      instance.update(dt, heightmap);
      instance.updateTurret(dt);
      if (camera) instance.updateLOD(camera);
      instance.updateLights(headlightsOn);
    }
  }
}
