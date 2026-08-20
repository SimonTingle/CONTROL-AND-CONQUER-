/**
 * The simulation's own clock — the only time source simulation logic may read.
 *
 * Everything in `src/vehicles` and `src/core` that needs "how long ago did this
 * happen" must read `simClock.time`, never `performance.now()` or `Date.now()`.
 * Wall clock differs between machines and, just as importantly, does not advance
 * at all under `window.__step`'s headless fast-forward — so a ban or a threat
 * memory keyed to it behaves differently in a fast-forwarded test than in real
 * play, and differently again on two machines simulating the same match.
 *
 * This is a mutable module singleton rather than a constructor argument because
 * there is exactly one simulation per page, and threading a clock through
 * HarvesterAI -> CombatController -> VehicleInstance would be a lot of plumbing
 * for a value none of them should ever be able to set.
 *
 * `main.js` owns advancing it (once per simTick, and reset on match start).
 */

/**
 * Seconds of simulation per step. Fixed, and identical on every client —
 * variable-`dt` integration is why two machines running identical inputs still
 * drift apart, so lockstep requires this to be a constant rather than whatever
 * the last animation frame happened to take.
 */
export const SIM_DT = 1 / 60;

export const simClock = {
  /** Steps simulated since the match began. Monotonic; the lockstep sequence number. */
  tick: 0,
  /** `tick * SIM_DT`. Seconds of simulated time — not wall-clock seconds. */
  time: 0,
};

/** Advance one fixed step. Called only by main.js's simTick. */
export function advanceSimClock() {
  simClock.tick++;
  simClock.time = simClock.tick * SIM_DT;
}

/** Rewind to zero — a new match, or a snapshot restore that carries its own tick. */
export function resetSimClock(tick = 0) {
  simClock.tick = tick;
  simClock.time = tick * SIM_DT;
}
