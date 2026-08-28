/**
 * What your units actually say, and when.
 *
 * ## Observed, never called back into
 *
 * Chatter reads simulation state and writes nothing. That is a deliberate
 * shape, not a coincidence: the natural place to hook "a harvester is taking
 * fire" is `markDangerZone`, which is called from *inside* `harvesterAI`
 * (`harvesterAI.js`), and running a UI callback from sim code is precisely how
 * a UI handler ends up writing sim state — the failure this codebase has
 * already paid for more than once (see CLAUDE.md on player actions as data).
 *
 * So `observe()` diffs state instead, and is driven from the half-second stats
 * tick in `renderTick` rather than per frame. That is the cadence main.js
 * already uses for everything that "only moves when something is structurally
 * wrong", and chatter is firmly in that category — nobody needs to be told at
 * 60 Hz that a scout found something.
 *
 * ## Your team only
 *
 * Every line is gated on `localTeamId`. Because audio is presentation-only
 * this can never desync — a peer hearing different chatter is cosmetic by
 * construction — but hearing the enemy's radio would be an intelligence leak
 * that changes how the game is played, which is a design fault rather than a
 * technical one.
 *
 * ## Why the scheduler is not optional
 *
 * `speechSynthesis.speak()` **queues**. It does not drop, and it does not
 * interrupt. Push twenty lines during a firefight and the browser will still
 * be talking about it a minute later, narrating a battle that finished. So:
 * one line at a time, a global gap between lines, a per-event cooldown, a
 * bounded queue that *drops the lowest priority* rather than growing, and
 * pre-emption so "base under attack" beats "unit ready".
 *
 * All timing is on the render clock (`performance.now`), never `simClock` —
 * this is presentation, and using the sim clock would invite someone to
 * serialise it.
 */
import { speak, voiceClassFor, VOICE_CLASSES, DEFAULT_VOICE_CLASS } from './radio.js';

/**
 * The lines, as data.
 *
 * `reply` is what makes this a radio *net* rather than a notification queue:
 * the user asked for units that speak **to each other**, so the important
 * events are a call from one crew and an answer from another. A reply is
 * scheduled as its own line, so it obeys the same one-at-a-time rule and
 * cannot overlap the call it answers.
 *
 * `priority` is absolute, not relative to recency: a base under attack matters
 * more than a factory finishing however long ago the last line was.
 */
export const CHATTER_LINES = {
  contact: {
    priority: 3,
    cooldownSeconds: 12,
    calls: [
      { from: 'recon', text: 'Contact. Hostiles on my position.' },
      { from: 'recon', text: 'Eyes on. Enemy units, danger close.' },
      { from: 'recon', text: 'Taking fire, breaking off.' },
    ],
    replies: [
      { from: 'command', text: 'Copy contact. Fall back and hold.' },
      { from: 'combat', text: 'Armour moving to support.' },
    ],
  },
  harvesterUnderFire: {
    priority: 4,
    cooldownSeconds: 15,
    calls: [
      { from: 'economy', text: 'We are under fire out here!' },
      { from: 'economy', text: 'Harvester taking hits, pulling out.' },
    ],
    replies: [
      { from: 'command', text: 'Abandon the field. Get back to base.' },
      { from: 'combat', text: 'On our way. Hold on.' },
    ],
  },
  baseUnderAttack: {
    priority: 9,
    cooldownSeconds: 20,
    calls: [
      { from: 'command', text: 'Base under attack. All units, defend.' },
      { from: 'command', text: 'We are being hit at home. Fall back now.' },
    ],
  },
  unitLost: {
    priority: 6,
    cooldownSeconds: 10,
    calls: [
      { from: 'command', text: 'We just lost a unit.' },
      { from: 'command', text: 'Unit down. Confirm your positions.' },
    ],
  },
  structureLost: {
    priority: 7,
    cooldownSeconds: 12,
    calls: [
      { from: 'command', text: 'We have lost a structure.' },
    ],
  },
  unitReady: {
    priority: 1,
    cooldownSeconds: 8,
    calls: [
      { from: 'combat', text: 'Rolling out.' },
      { from: 'combat', text: 'Ready and standing by.' },
      { from: 'economy', text: 'Harvester online, heading to the field.' },
    ],
  },
  structureComplete: {
    priority: 2,
    cooldownSeconds: 8,
    calls: [
      { from: 'support', text: 'Construction complete.' },
      { from: 'support', text: 'Structure is online.' },
    ],
  },
};

/** Minimum seconds between two lines, on top of each line's own duration. */
const GLOBAL_GAP_SECONDS = 1.2;
/** Beat before a reply answers its call. */
const REPLY_GAP_SECONDS = 0.6;
/**
 * How many lines may wait. Small on purpose: a radio net is a live channel,
 * and a line about a fight that ended thirty seconds ago is worse than
 * silence. Overflow drops the lowest-priority entry, never the newest.
 */
const MAX_QUEUE = 3;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export class Chatter {
  /**
   * @param {object} [opts]
   * @param {(text: string, opts: object) => boolean} [opts.speak] injectable
   *   for tests — the real one reaches the Web Speech API and a voice pool.
   * @param {(line: {speaker: string, text: string}) => void} [opts.onCaption]
   * @param {() => number} [opts.clock] seconds; injectable so a test can drive
   *   cooldowns without waiting in real time.
   */
  constructor({ speak: speakFn = speak, onCaption, clock = now } = {}) {
    this.speak = speakFn;
    this.onCaption = onCaption;
    this.clock = clock;
    this.queue = [];
    this.busy = false;
    this.nextFreeAt = 0;
    this.lastSaidAt = new Map(); // event -> seconds
    // What observe() compares against. Null means "no baseline yet", which is
    // distinct from zero: on the first observation a fresh match has 0 units
    // and should not announce three units lost.
    this.previous = null;
  }

  /**
   * Offer an event to the net. Returns whether it was accepted.
   *
   * @param {string} event a key of CHATTER_LINES
   * @param {object} [opts]
   * @param {number} [opts.teamId] the team the event happened to
   * @param {number} [opts.localTeamId] the team whose radio this is
   */
  report(event, { teamId, localTeamId } = {}) {
    const spec = CHATTER_LINES[event];
    if (!spec) return false;
    // Your net, your team. Not a desync risk — audio is presentation — but
    // hearing the enemy's traffic would be free intelligence.
    if (teamId !== undefined && localTeamId !== undefined && teamId !== localTeamId) return false;

    const t = this.clock();
    const last = this.lastSaidAt.get(event);
    if (last !== undefined && t - last < spec.cooldownSeconds) return false;
    this.lastSaidAt.set(event, t);

    const call = pick(spec.calls);
    this.enqueue({ event, priority: spec.priority, from: call.from, text: call.text });

    if (spec.replies?.length) {
      const reply = pick(spec.replies);
      // One below the call, so an interleaved higher-priority event still cuts
      // in front of the answer — but the answer still outranks routine
      // traffic, because a call left hanging reads as a bug.
      this.enqueue({ event, priority: spec.priority - 0.5, from: reply.from, text: reply.text, isReply: true });
    }
    return true;
  }

  enqueue(line) {
    this.queue.push(line);
    if (this.queue.length <= MAX_QUEUE) return;
    // Drop the lowest priority, and among equals the oldest — never simply
    // the newest, or a burst of routine traffic would push out the one line
    // that mattered.
    let worst = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].priority < this.queue[worst].priority) worst = i;
    }
    this.queue.splice(worst, 1);
  }

  /**
   * Drive the queue. Called from the same half-second tick as `observe`.
   *
   * Highest priority first rather than FIFO: the queue exists precisely
   * because more happened than can be said, so what gets said should be what
   * matters most, not what happened first.
   */
  pump() {
    if (this.busy || !this.queue.length) return;
    const t = this.clock();
    if (t < this.nextFreeAt) return;

    let best = 0;
    for (let i = 1; i < this.queue.length; i++) {
      if (this.queue[i].priority > this.queue[best].priority) best = i;
    }
    const line = this.queue.splice(best, 1)[0];

    const voiceClass = VOICE_CLASSES[line.from] ? line.from : DEFAULT_VOICE_CLASS;
    const speaker = VOICE_CLASSES[voiceClass].label;
    this.busy = true;
    const started = this.speak(line.text, {
      voiceClass,
      onDone: () => {
        this.busy = false;
        this.nextFreeAt = this.clock() + (line.isReply ? REPLY_GAP_SECONDS : GLOBAL_GAP_SECONDS);
      },
    });
    // A muted radio still resolves the line rather than wedging the queue —
    // `speak` calls onDone synchronously in that case, so `busy` is already
    // false by here and this is only a guard against a speak() that returns
    // without ever calling back.
    if (!started && this.busy) this.busy = false;
    this.onCaption?.({ speaker, text: line.text });
  }

  /**
   * Diff the world and report what changed. Pure observation.
   *
   * @param {object} state
   * @param {number} state.localTeamId
   * @param {number} state.units owned units alive
   * @param {number} state.structures owned structures standing
   * @param {number} state.dangerZones count of live danger zones for this team
   * @param {boolean} state.dangerNearBase whether any of them is near home
   * @param {number} [state.harvestersInDanger]
   */
  observe(state) {
    const prev = this.previous;
    this.previous = { ...state };
    // First observation establishes the baseline and says nothing. Without
    // this, loading into a match with a base and three units would announce
    // them all as newly built.
    if (!prev || prev.localTeamId !== state.localTeamId) return;

    const team = { teamId: state.localTeamId, localTeamId: state.localTeamId };

    if (state.dangerNearBase && !prev.dangerNearBase) this.report('baseUnderAttack', team);
    if (state.harvestersInDanger > (prev.harvestersInDanger ?? 0)) this.report('harvesterUnderFire', team);
    else if (state.dangerZones > prev.dangerZones) this.report('contact', team);

    if (state.units < prev.units) this.report('unitLost', team);
    else if (state.units > prev.units) this.report('unitReady', team);

    if (state.structures < prev.structures) this.report('structureLost', team);
    else if (state.structures > prev.structures) this.report('structureComplete', team);

    this.pump();
  }

  /** Forget everything — a new match is a new net. */
  reset() {
    this.queue.length = 0;
    this.busy = false;
    this.nextFreeAt = 0;
    this.lastSaidAt.clear();
    this.previous = null;
  }
}

/** Every voice class named by any line, for the integrity test. */
export function referencedVoiceClasses() {
  const used = new Set();
  for (const spec of Object.values(CHATTER_LINES)) {
    for (const line of [...(spec.calls ?? []), ...(spec.replies ?? [])]) used.add(line.from);
  }
  return [...used];
}

export { voiceClassFor };
