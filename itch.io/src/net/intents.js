/**
 * Player intent as data.
 *
 * Every way a human can change the world — a radial-menu command, a move order,
 * a building placement, a harvest or attack target, even holding W — is
 * expressed here as a small JSON-safe object, and applied by `applyIntent`.
 *
 * ## Why intent is not applied where it is produced
 *
 * All of this used to happen synchronously inside DOM event handlers, which is
 * fine for one machine and impossible for several: two clients would apply the
 * same click on different ticks and diverge immediately. Turning intent into
 * data buys three things at once —
 *
 *  1. it can be sent over a wire (this is exactly the lockstep wire format),
 *  2. it can be applied at a deterministic point in the tick rather than
 *     whenever the browser happened to deliver an event, and
 *  3. it can be recorded and replayed, which is what lets the determinism
 *     harness cover human input and not just the AI.
 *
 * Single player uses the same path, one turn shorter: intents queue and drain
 * at the top of the next sim step. That is at most 16ms of delay, imperceptible
 * in play, and worth it to have **one** code path that is exercised constantly
 * rather than a networked path that only runs in multiplayer.
 *
 * ## What crosses the wire, and what does not
 *
 * Raycasting, placement validity and menu gating all stay local and immediate —
 * they are pure reads that make the UI feel responsive, and their *results* are
 * what get queued. Because the issuing client resolves the values once and
 * everyone receives them verbatim, no quantisation is needed: peers are acting
 * on identical bytes rather than each re-deriving a float.
 */

import { commandsFor } from '../vehicles/commands.js';

/** Wire-form constructors. Kept together so the vocabulary is greppable. */
export const Intent = {
  /**
   * A radial-menu command, identified by id rather than by closure.
   * `instanceKind` ('vehicle' | 'structure') disambiguates the id: vehicle and
   * structure ids are separate counters that both start at 1, so the same
   * number can legitimately refer to one of each at once.
   */
  command: (instanceId, instanceKind, cmdId) => ({ t: 'cmd', instanceId, instanceKind, cmdId }),
  /** Tap-to-move / click order for one vehicle. */
  move: (instanceId, x, z) => ({ t: 'move', instanceId, x, z }),
  /**
   * Drive keys. Sent on change only — the state persists between changes, so
   * holding W is two messages (press, release) rather than 60 per second.
   */
  drive: (instanceId, throttle, steer) => ({ t: 'drive', instanceId, throttle, steer }),
  /** Place a structure at an already-validated point. */
  build: (defId, padId, x, z, teamId) => ({ t: 'build', defId, padId, x, z, teamId }),
  /** Send a harvester to a specific crystal field. */
  harvest: (instanceId, fieldId) => ({ t: 'harvest', instanceId, fieldId }),
  /** Lock sustained fire onto a specific enemy. */
  target: (instanceId, targetId, targetKind) => ({ t: 'target', instanceId, targetId, targetKind }),
  /**
   * Block or unblock a crystal field for one team's harvesters. Its own intent
   * rather than a `cmd` because a field has no catalog def or mode for
   * `commandsFor` to key off — see intents.js's `applyIntent` for the rest of
   * the reasoning.
   */
  blockField: (fieldId, teamId, blocked) => ({ t: 'blockField', fieldId, teamId, blocked }),
  /**
   * Hold a unit still while its command menu is open, and release it again.
   *
   * This looks like pure UI and is not: autonomous drivers read `menuOpen`
   * (harvesterAI, aiCommander) and stop for it, and opening a menu nulls the
   * unit's order outright. So it is a player action that changes the world,
   * and it travels like every other one. It used to be written straight onto
   * the instance from a DOM handler, which held the unit on the opening
   * client only while the peer's copy drove away.
   */
  menuHold: (instanceId, instanceKind, held) => ({ t: 'menuHold', instanceId, instanceKind, held }),
};

function vehicleById(ctx, id) {
  return ctx.vehicles.instances.find((v) => v.id === id && !v.dead) ?? null;
}

/**
 * Apply one intent to the simulation.
 *
 * @param {object} intent wire form, as built above
 * @param {object} ctx the shared command context (vehicles, structures, game, …)
 * @param {number|null} teamId the team this intent came from, taken from the
 *   match roster rather than the message. Enforced here so a malformed or
 *   hostile input cannot order another team's units around. Null means local
 *   play, where there is only one human team to begin with.
 * @returns {boolean} whether it actually changed anything — false for an intent
 *   that has become stale (its unit died, its command is no longer legal). A
 *   stale intent is normal, not an error: two turns of input delay is plenty of
 *   time for the world to move on.
 */
export function applyIntent(intent, ctx, teamId = null) {
  if (!intent || typeof intent !== 'object') return false;
  const owns = (inst) => inst && (teamId === null || inst.teamId === teamId);

  switch (intent.t) {
    case 'cmd': {
      const inst = intent.instanceKind === 'structure'
        ? ctx.structures.instances.find((s) => s.id === intent.instanceId && !s.dead) ?? null
        : vehicleById(ctx, intent.instanceId);
      if (!owns(inst)) return false;
      // commandsFor resolves the command list for the instance's *current*
      // mode, so a command that was legal when clicked but isn't now simply
      // won't be found — which is the stale-intent case, handled by falling out.
      const cmd = commandsFor(inst, ctx).find((c) => c.id === intent.cmdId);
      // `enabled` is re-checked here rather than trusted from click time.
      // commandsFor computes enabledResult but does not gate execute() on it,
      // so without this a queued command could run after it stopped being
      // affordable or legal — and, worse, could do so on only some clients.
      if (!cmd || cmd.enabledResult !== true || !cmd.execute) return false;
      // A `local: true` command only enters a UI mode on the client that
      // chose it (see commands.js). It should never have been submitted, and
      // running it here would put every peer into that mode. main.js's
      // onCommand already routes these away from submitIntent; this is the
      // backstop, so a future call site that forgets cannot resurrect the bug.
      if (cmd.local) return false;
      cmd.execute(inst, ctx);
      return true;
    }

    case 'move': {
      const inst = vehicleById(ctx, intent.instanceId);
      if (!owns(inst)) return false;
      return !!inst.setTarget(intent.x, intent.z, ctx.heightmap);
    }

    case 'drive': {
      const inst = vehicleById(ctx, intent.instanceId);
      if (!owns(inst)) return false;
      // Latched, not applied once: the vehicle keeps driving until a new drive
      // intent changes it, which is what makes "send on change only" correct.
      inst.setDriveInput(intent.throttle, intent.steer);
      return true;
    }

    case 'build': {
      const pad = ctx.terraform.pads.find((p) => p.id === intent.padId);
      const def = ctx.structures.defOf(intent.defId);
      if (!def || (teamId !== null && intent.teamId !== teamId)) return false;
      // Re-validated on every client rather than trusted from the issuer: the
      // ground may have been taken during the input delay, and all clients must
      // reach the same verdict about whether it was.
      if (!pad || !ctx.structures.canPlaceAt(pad, def, intent.x, intent.z)) return false;
      ctx.structures.place(def, pad, { x: intent.x, z: intent.z }, { teamId: intent.teamId });
      return true;
    }

    case 'harvest': {
      const inst = vehicleById(ctx, intent.instanceId);
      if (!owns(inst)) return false;
      const field = (ctx.world.blooms?.fields ?? []).find((f) => f.id === intent.fieldId) ?? null;
      // A field blocked for this team refuses the order the same way a stale
      // one does — silently, per this function's own "false is normal"
      // contract. The harvester keeps whatever it was doing before.
      if (!field || field.blockedByTeam?.has(inst.teamId)) return false;
      inst.targetField = field;
      return true;
    }

    case 'target': {
      const inst = vehicleById(ctx, intent.instanceId);
      if (!owns(inst)) return false;
      const pool = intent.targetKind === 'structure' ? ctx.structures.instances : ctx.vehicles.instances;
      const victim = pool.find((e) => e.id === intent.targetId && !e.dead);
      if (!victim || victim.teamId === inst.teamId) return false;
      inst.mode = 'armed';
      inst.combatTarget = victim;
      return true;
    }

    case 'menuHold': {
      const inst = intent.instanceKind === 'structure'
        ? ctx.structures.instances.find((s) => s.id === intent.instanceId && !s.dead) ?? null
        : vehicleById(ctx, intent.instanceId);
      if (!owns(inst)) return false;
      inst.menuOpen = !!intent.held;
      return true;
    }

    case 'blockField': {
      // A team can only ever set its own block — `owns` doesn't apply here
      // (there is no instance to own), so the same roster check is done
      // directly against the intent's own claimed team.
      if (teamId !== null && intent.teamId !== teamId) return false;
      const field = (ctx.world.blooms?.fields ?? []).find((f) => f.id === intent.fieldId) ?? null;
      if (!field) return false;
      field.blockedByTeam ??= new Set();
      if (intent.blocked) field.blockedByTeam.add(intent.teamId);
      else field.blockedByTeam.delete(intent.teamId);
      return true;
    }

    default:
      return false;
  }
}

/**
 * The local player's outbox.
 *
 * In single player this drains straight into the sim at the top of each step.
 * In a match it is handed to the lockstep session instead, which stamps it with
 * a turn number and sends it — the producers never need to know which mode they
 * are in.
 */
export class IntentQueue {
  constructor() {
    this.pending = [];
  }

  push(intent) {
    if (intent) this.pending.push(intent);
  }

  /** Take everything queued, leaving the queue empty. */
  drain() {
    if (!this.pending.length) return [];
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
