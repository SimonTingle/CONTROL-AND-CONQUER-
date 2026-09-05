/**
 * Decides which hint, if any, should be on screen right now.
 *
 * ## Observed, never called back into
 *
 * The shape is lifted wholesale from `audio/chatter.js`, and for the same
 * reason. The natural way to fire "they just built their first refinery" is a
 * callback from `structures.onComplete`, and running UI code from inside sim
 * code is exactly how a UI handler ends up writing sim state — the failure
 * this codebase has already paid for more than once (CLAUDE.md, and the
 * `menuHold` trap documented in `net/intents.js`). So this diffs a plain
 * context object handed to it from the existing half-second poll in
 * `renderTick`, reads nothing else, and writes nothing at all.
 *
 * It holds no reference to `game`, `vehicles` or the DOM. That is what makes
 * it testable without a browser, and it is worth keeping that way.
 *
 * ## All timing is on the render clock
 *
 * `observe()` accumulates the render `dt` it is passed, never `simClock`.
 * Hints are presentation: a player who reads slowly must not desync from one
 * who reads quickly, and putting hint timers on the sim clock would invite
 * somebody to serialise them into the state hash.
 *
 * ## The pacing constants are the whole design
 *
 * Each one is defending against a specific way that on-screen help stops being
 * help. They are the difference between a hint system and an interruption.
 */

/**
 * Nothing fires during this opening window.
 *
 * A player who has just pressed Start is orienting — reading the terrain,
 * finding their units, working out which way is up. A card that lands in the
 * first few seconds is read as an obstacle, not an offer.
 */
export const OPENING_QUIET_SECONDS = 12;

/**
 * Minimum gap between one hint leaving the screen and the next appearing.
 *
 * Without this, every hint whose `when` is already true queues up behind the
 * first OK and fires as a chain of cards — the wall of text this system exists
 * to avoid, delivered one click at a time.
 */
export const MIN_GAP_SECONDS = 30;

/**
 * Ceiling per match. Even a player who never dismisses anything early is done
 * being taught after four, and the rest keep for next time — the seen-list is
 * persisted, so nothing is lost by stopping.
 */
export const MAX_PER_MATCH = 4;

export class HintSystem {
  /**
   * @param {object} deps
   * @param {object} deps.profile the playerProfile module, or a fake with the
   *   same four functions. Injected rather than imported so tests can run
   *   without localStorage.
   * @param {Array} deps.defs hint definitions, see hintDefs.js
   * @param {boolean} deps.isTouch selects `textTouch` over `text`
   * @param {(hint: {id, title, text}) => void} deps.onShow
   * @param {() => void} deps.onHide
   */
  constructor({ profile, defs, isTouch = false, onShow, onHide } = {}) {
    this.profile = profile;
    this.defs = defs ?? [];
    this.isTouch = isTouch;
    this.onShow = onShow;
    this.onHide = onHide;

    this.reset();
  }

  /** A new match: clear per-match pacing, keep the persisted seen-list. */
  reset() {
    this.elapsed = 0;
    this.sinceLast = MIN_GAP_SECONDS; // the first hint waits only on the quiet period
    this.shownThisMatch = 0;
    this.current = null;
    /** Ids retired by `retiredWhen` — this match only, and never persisted:
     * the player demonstrated the skill, they didn't read the hint, so on a
     * later match it is still allowed to introduce itself. */
    this.retired = new Set();
  }

  /**
   * @param {object} ctx live match state; see hintDefs.js for the fields read.
   *   Must include `dt` (render seconds) and `mode`.
   */
  observe(ctx) {
    this.elapsed += ctx.dt ?? 0;

    // `elapsedSeconds` is supplied here rather than by the caller so there is
    // exactly one clock in play, and it is this render-side one. A def that
    // reached for simClock instead would be a readiness test on simulation
    // time, which is the first step towards somebody serialising it.
    const view = { ...ctx, elapsedSeconds: this.elapsed };

    // Retirement runs unconditionally — before the enabled check, before the
    // quiet period, and while a card is already up. A player who solves
    // something while hints are switched off should not be told about it if
    // they switch them back on later in the same match.
    for (const def of this.defs) {
      if (def.retiredWhen?.(view)) this.retired.add(def.id);
    }

    // Switching hints off takes the visible card with it. Checked ahead of the
    // one-card-at-a-time guard below, because a player reaching for that
    // toggle is telling us to stop *now*, and leaving the card they were
    // looking at on screen would read as the switch not working. Cleared
    // rather than dismissed: they turned hints off, they did not read it, so
    // it is still owed to them if they turn them back on.
    if (!this.profile.hintsEnabled()) {
      this.clear();
      return;
    }

    if (this.current) return; // one card at a time
    this.sinceLast += ctx.dt ?? 0;

    if (this.shownThisMatch >= MAX_PER_MATCH) return;
    if (this.elapsed < OPENING_QUIET_SECONDS) return;
    if (this.sinceLast < MIN_GAP_SECONDS) return;

    // Never talk over the player. An open command ring or drawer means they
    // are mid-decision, and a base under attack means they have something far
    // more urgent to read than advice. The hint keeps; the moment does not.
    if (ctx.radialOpen || ctx.drawerOpen || ctx.underAttack) return;

    const hint = this._pick(view);
    if (!hint) return;

    this.current = hint;
    this.shownThisMatch += 1;
    this.onShow?.({
      id: hint.id,
      title: hint.title,
      text: (this.isTouch && hint.textTouch) || hint.text,
    });
  }

  /** Highest-priority eligible hint, or null. */
  _pick(ctx) {
    let best = null;
    for (const def of this.defs) {
      if (!def.modes.includes(ctx.mode)) continue;
      if (this.retired.has(def.id)) continue;
      if (this.profile.hasSeenHint(def.id)) continue;
      if (!def.when(ctx)) continue;
      if (!best || def.priority > best.priority) best = def;
    }
    return best;
  }

  /**
   * The OK button. Marks the hint seen — permanently, so it never returns —
   * and restarts the gap so the next one does not land on the click that
   * dismissed this one.
   */
  dismiss() {
    if (!this.current) return;
    this.profile.markHintSeen(this.current.id);
    this.current = null;
    this.sinceLast = 0;
    this.onHide?.();
  }

  /** Tear down without marking anything seen — match over, or hints disabled. */
  clear() {
    if (!this.current) return;
    this.current = null;
    this.sinceLast = 0;
    this.onHide?.();
  }
}
