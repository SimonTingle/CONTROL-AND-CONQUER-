import * as THREE from 'three';

const _desired = new THREE.Vector3();
const _focus = new THREE.Vector3();

const ORBIT_SENSITIVITY = 0.006; // radians per pixel dragged
const PAN_SENSITIVITY = 0.0015; // fraction of camera distance per pixel
const MIN_PITCH = 0.06; // just above ground level
const MAX_PITCH = 1.35; // just short of straight overhead
const MIN_DISTANCE = 8;
const MAX_DISTANCE = 160;
/**
 * Where the camera starts. Raised from 26 at the player's request: 26 put the
 * viewport close enough that the surrounding ground — and, on a first deploy,
 * whether there is any ground at all — was off screen. The zoom range either
 * side is unchanged; only the starting point moves.
 */
const DEFAULT_DISTANCE = 40;

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

    this.distance = opts.distance ?? DEFAULT_DISTANCE;
    // Height is expressed as a pitch angle rather than a fixed offset, so
    // dragging the mouse vertically has a single value to drive and the framing
    // stays sane at any zoom level.
    this.pitch = opts.pitch ?? 0.4; // radians above the horizon
    this.lookAhead = opts.lookAhead ?? 8;
    this.positionStiffness = opts.positionStiffness ?? 4.5;
    this.headingStiffness = opts.headingStiffness ?? 2.6;
    this.minClearance = opts.minClearance ?? 3;

    this.azimuthOffset = 0; // player swing around the vehicle
    this.panOffset = new THREE.Vector3(); // player nudge to the framing
    this.followHeading = null;
    this.enabled = true;
  }

  /** Snap straight behind the vehicle, e.g. the frame it spawns. */
  reset(vehicle) {
    this.followHeading = vehicle.heading;
    this.azimuthOffset = 0;
    this.panOffset.set(0, 0, 0);
    this.place(vehicle, 1);
  }

  /** Mouse orbit. dx/dy are pointer deltas in pixels. */
  orbit(dx, dy) {
    this.azimuthOffset -= dx * ORBIT_SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + dy * ORBIT_SENSITIVITY,
      MIN_PITCH,
      MAX_PITCH
    );
  }

  /** Mouse pan — shifts the framing without unanchoring from the vehicle. */
  pan(dx, dy) {
    const angle = (this.followHeading ?? 0) + this.azimuthOffset;
    // Right vector of the current view, in the ground plane.
    this.panOffset.x += Math.sin(angle) * dx * PAN_SENSITIVITY * this.distance;
    this.panOffset.z += -Math.cos(angle) * dx * PAN_SENSITIVITY * this.distance;
    this.panOffset.y += dy * PAN_SENSITIVITY * this.distance;
  }

  zoom(delta) {
    this.distance = THREE.MathUtils.clamp(this.distance + delta, MIN_DISTANCE, MAX_DISTANCE);
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

    // Spherical: pitch sets how far above the vehicle the camera rides, so
    // zooming in keeps the same viewing angle instead of flattening out.
    const ground = Math.cos(this.pitch) * this.distance;
    _desired.set(
      target.x - Math.cos(angle) * ground + this.panOffset.x,
      target.y + Math.sin(this.pitch) * this.distance + this.panOffset.y,
      target.z - Math.sin(angle) * ground + this.panOffset.z
    );

    // Never let a hill (or the sea) come through the lens.
    const groundY = Math.max(hm.heightAt(_desired.x, _desired.z), hm.seaLevelY);
    if (_desired.y < groundY + this.minClearance) _desired.y = groundY + this.minClearance;

    this.camera.position.lerp(_desired, blend);

    // Look slightly ahead of the vehicle so the road, not the roof, fills frame.
    _focus.set(
      target.x + Math.cos(vehicle.heading) * this.lookAhead + this.panOffset.x,
      target.y + 1.6 + this.panOffset.y,
      target.z + Math.sin(vehicle.heading) * this.lookAhead + this.panOffset.z
    );
    this.camera.lookAt(_focus);
  }
}
