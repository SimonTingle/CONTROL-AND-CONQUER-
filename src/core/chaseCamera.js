import * as THREE from 'three';

const _desired = new THREE.Vector3();
const _focus = new THREE.Vector3();

/**
 * Third-person chase camera: always above and behind the vehicle.
 *
 * The camera follows a *smoothed* copy of the vehicle's heading rather than the
 * heading itself. Tracking it directly makes the camera whip around every time
 * the vehicle corrects its steering; lagging it slightly reads as a camera
 * operator swinging to keep up, and lets you actually see the turn happen.
 */
export class ChaseCamera {
  constructor(camera, heightmap, opts = {}) {
    this.camera = camera;
    this.heightmap = heightmap;

    this.distance = opts.distance ?? 26;
    this.height = opts.height ?? 11;
    this.lookAhead = opts.lookAhead ?? 8;
    this.positionStiffness = opts.positionStiffness ?? 4.5;
    this.headingStiffness = opts.headingStiffness ?? 2.6;
    this.minClearance = opts.minClearance ?? 3;

    this.azimuthOffset = 0; // player swing around the vehicle
    this.followHeading = null;
    this.enabled = true;
  }

  /** Snap straight behind the vehicle, e.g. the frame it spawns. */
  reset(vehicle) {
    this.followHeading = vehicle.heading;
    this.azimuthOffset = 0;
    this.place(vehicle, 1);
  }

  update(dt, vehicle) {
    if (this.followHeading === null) this.followHeading = vehicle.heading;

    // Ease the follow heading toward the vehicle's, by the shortest way round.
    let delta = vehicle.heading - this.followHeading;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    this.followHeading += delta * (1 - Math.exp(-this.headingStiffness * dt));

    this.place(vehicle, 1 - Math.exp(-this.positionStiffness * dt));
  }

  /** @param {number} blend 0 = stay put, 1 = snap to the ideal spot. */
  place(vehicle, blend) {
    const hm = this.heightmap;
    const target = vehicle.group.position;
    const angle = this.followHeading + this.azimuthOffset;

    _desired.set(
      target.x - Math.cos(angle) * this.distance,
      target.y + this.height,
      target.z - Math.sin(angle) * this.distance
    );

    // Never let a hill (or the sea) come through the lens.
    const groundY = Math.max(hm.heightAt(_desired.x, _desired.z), hm.seaLevelY);
    if (_desired.y < groundY + this.minClearance) _desired.y = groundY + this.minClearance;

    this.camera.position.lerp(_desired, blend);

    // Look slightly ahead of the vehicle so the road, not the roof, fills frame.
    _focus.set(
      target.x + Math.cos(vehicle.heading) * this.lookAhead,
      target.y + 1.6,
      target.z + Math.sin(vehicle.heading) * this.lookAhead
    );
    this.camera.lookAt(_focus);
  }
}
