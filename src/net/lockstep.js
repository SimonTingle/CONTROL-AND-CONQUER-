/**
 * The client half of lockstep.
 *
 * The server (server/src/ws/match.js) collects each player's input for a turn
 * and broadcasts the complete set once everyone has reported. This class turns
 * that stream into a rule for when the local simulation is allowed to step.
 *
 * ## The rule
 *
 * A turn is TICKS_PER_TURN sim steps long. Before the first step of turn N, the
 * client must have the full input set for turn N. If it does not, it **stalls**
 * — it does not simulate ahead and reconcile later. That is the entire contract
 * that keeps every machine identical, and it is why a lagging player slows
 * everyone rather than desyncing them.
 *
 * ## Input delay, and why the queue is not sent for "now"
 *
 * Input the player produces during turn N is sent labelled turn N + DELAY. By
 * the time anyone needs to execute it, it has had DELAY turns (~200ms) to
 * arrive. This is what makes lockstep playable without an authoritative server:
 * the cost is a fixed, small command latency rather than rubber-banding.
 *
 * The consequence is that the first DELAY turns have no input to wait for, so
 * `start()` reports empty input for them immediately — otherwise every client
 * would sit waiting for turn 0 that nobody was ever going to send.
 */

/** Called with each released turn's inputs; the caller applies them to the sim. */
export class LockstepSession {
  /**
   * @param {object} opts
   * @param {number} opts.ticksPerTurn from the server's welcome, not hardcoded,
   *   so the pacing is decided in one place.
   * @param {number} opts.inputDelayTurns likewise.
   * @param {IntentQueue} opts.queue the local player's outbox.
   * @param {(inputs: object[]) => void} opts.onTurn applies a turn's inputs.
   * @param {(turn: number, inputs: object[]) => void} opts.send sends local input.
   */
  constructor({ ticksPerTurn, inputDelayTurns, queue, onTurn, send }) {
    this.ticksPerTurn = ticksPerTurn;
    this.inputDelayTurns = inputDelayTurns;
    this.queue = queue;
    this.onTurn = onTurn;
    this.send = send;

    /** The turn currently being simulated. */
    this.turn = 0;
    /** How far into that turn, in sim steps. */
    this.tickInTurn = 0;
    /** turn -> inputs[], as released by the server. */
    this.received = new Map();
    /** Highest turn we have sent input for, so we never send one twice. */
    this.sentThrough = -1;
    this.started = false;
    /** Set while waiting on a turn — the UI reads this to say "waiting for…". */
    this.stalled = false;
    /** Purely for diagnostics: how many steps we have been stuck. */
    this.stallSteps = 0;
  }

  /**
   * Prime the input-delay window. The first DELAY turns can carry no input (the
   * match has not started, so the player cannot have acted during them), but the
   * server still waits for every player to report them — so report them at once
   * rather than deadlocking the match before it begins.
   */
  start() {
    if (this.started) return;
    this.started = true;
    for (let t = 0; t < this.inputDelayTurns; t++) this.send(t, []);
    this.sentThrough = this.inputDelayTurns - 1;
  }

  /**
   * Join a match that is already running, at the first turn not yet released.
   *
   * Distinct from `start()` in the one way that matters: it does **not** prime
   * turns 0..DELAY. Those were released long ago, the server rejects any late
   * input for them, and a rejoining client that reported them would sit waiting
   * for broadcasts that already happened — which is exactly how a late arrival
   * used to hang, silently, forever.
   *
   * Reporting begins immediately even though this client's world is still
   * stale: input is what the other players' turns are gated on, so staying
   * quiet to "wait for a snapshot first" would stall the whole match and stop
   * the host ever reaching the turn it promised the snapshot for. The stale
   * world is corrected a few turns later by the ordinary resync path.
   */
  resumeAt(turn) {
    this.started = true;
    this.resetTo(turn);
  }

  /** A turn's complete input set arrived from the server. */
  receiveTurn(turn, inputs) {
    this.received.set(turn, inputs ?? []);
  }

  /**
   * May the simulation take one step now?
   *
   * Called immediately before each sim step. Returns false to stall — the
   * caller must not advance the sim, and should keep rendering so the game
   * stays responsive rather than freezing.
   */
  beginStep() {
    if (this.tickInTurn === 0) {
      const inputs = this.received.get(this.turn);
      if (!inputs) {
        this.stalled = true;
        this.stallSteps++;
        return false;
      }
      this.stalled = false;
      this.stallSteps = 0;

      // Everything for this turn lands before its first step, so the batch is
      // applied at an identical point on every client.
      // Turn number goes with the batch: the caller needs it to stamp state
      // hashes and to line a resync snapshot up with a turn boundary.
      this.onTurn(inputs, this.turn);
      this.received.delete(this.turn);

      // Having begun turn N, send what the player has done for turn N + DELAY.
      // Sending here rather than on a timer ties the outgoing rate to the
      // simulation, so a client that stalls also stops sending — which is what
      // keeps the turn numbering from running away from the simulation.
      const sendFor = this.turn + this.inputDelayTurns;
      if (sendFor > this.sentThrough) {
        this.send(sendFor, this.queue.drain());
        this.sentThrough = sendFor;
      }
    }
    return true;
  }

  /** One sim step happened; advance the turn cursor. */
  endStep() {
    this.tickInTurn++;
    if (this.tickInTurn >= this.ticksPerTurn) {
      this.tickInTurn = 0;
      this.turn++;
    }
  }

  /**
   * Jump the cursor after a resync. The snapshot carries the state as of some
   * turn; everything buffered for earlier turns is now meaningless, and
   * re-applying it would undo the very correction we just accepted.
   */
  resetTo(turn) {
    this.turn = turn;
    this.tickInTurn = 0;
    for (const t of [...this.received.keys()]) {
      if (t < turn) this.received.delete(t);
    }
    this.sentThrough = Math.max(this.sentThrough, turn + this.inputDelayTurns - 1);
  }
}
