/**
 * Central destroy pipeline for anything with a lifetime — vehicles and
 * structures today, more later.
 *
 * Two steps on purpose. `queueDestroy` marks an instance dead the instant
 * something decides to kill it — synchronously, so any code running later
 * the same tick can already see `.dead` and skip it. The actual cleanup
 * (releasing docks, queue slots, disposing meshes, splicing out of whatever
 * array owns it) waits for `flush()`, called from exactly one point in the
 * tick — never mid-iteration, or a system walking its own array while
 * another system splices out of it would skip or double-visit an entry.
 *
 * Cleanup is an explicit array of hooks, not an event bus: every system that
 * owns instance-keyed state (harvesterAI's dock reservations,
 * repairController's bay queue, trafficController's cooldowns, the vehicle
 * and structure collections themselves) registers its own hook here, in the
 * order main.js wires things up. Explicit and greppable, matching this
 * codebase's existing self-heal sweeps (_sweepFacilities, _sweepBays) rather
 * than a subscribe-anywhere pattern that would be harder to trace.
 */
export class Entities {
  constructor() {
    this._queue = [];
    this._hooks = [];
  }

  /** Register a hook to run on every destroyed instance, in registration order. */
  onDestroy(hook) {
    this._hooks.push(hook);
  }

  /**
   * Mark an instance dead and schedule its cleanup. Safe to call more than
   * once on the same instance — only the first call queues it, so two
   * systems independently deciding the same thing should die don't double it up.
   */
  queueDestroy(inst) {
    if (inst.dead) return;
    inst.dead = true;
    this._queue.push(inst);
  }

  /** Run every hook against every instance queued since the last flush. */
  flush() {
    if (this._queue.length === 0) return;
    // Snapshot and clear up front: a hook that itself queues another destroy
    // (a bay taking a docked vehicle with it, say) must not be able to grow
    // the array this loop is iterating — it lands in the next flush instead.
    const batch = this._queue;
    this._queue = [];
    for (const inst of batch) {
      for (const hook of this._hooks) hook(inst);
    }
  }
}
