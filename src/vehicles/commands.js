/**
 * What each vehicle can be ordered to do, surfaced by the radial menu.
 *
 * Deliberately not on the catalog entries: those are pure data, and an
 * `execute` that reaches for the terraform or the fog would drag game systems
 * into a module the mesh factory imports. Commands are behaviour, so they live
 * here and take everything they need from a context object.
 *
 * A command's `enabled` returns `true`, or a **string explaining why not** —
 * the menu renders that string under a dimmed entry, so a refusal always says
 * what is wrong instead of silently doing nothing.
 */

import { STRUCTURE_CATALOG } from '../structures/structures.js';
import { VEHICLE_CATALOG } from './catalog.js';
import { WEAPON_TIERS } from '../core/team.js';

/**
 * @param {object} instance the VehicleInstance the menu was opened on
 * @param {object} ctx { vehicles, world, heightmap, terraform, game }
 * @returns {Array<{id, label, hint?, enabled?, execute?}>}
 */
export function commandsFor(instance, ctx) {
  const byId = COMMANDS[instance.def.id];
  if (!byId) return [];
  const base = byId[instance.mode] ?? [];

  // Author-built vehicles cannot be in COMMANDS: that object is assembled at
  // module import, before anyone has signed in and loaded theirs. So a working
  // structure's build list is completed here, per call, from whatever custom
  // vehicles name it in `producedBy`.
  const staticIds = new Set(base.map((c) => c.id));
  const extraBuilds = (instance.mode === 'idle' ? producedUnitIds(instance.def, ctx) : [])
    .filter((unitId) => !staticIds.has(`build-${unitId}`))
    .map((unitId) => buildCommandFor(unitId, { atBase: SPAWNS_AT_BASE.has(instance.def.id) }));

  return [...base, ...extraBuilds].map((cmd) => ({
    ...cmd,
    // A hint may be a function when it needs a live number, like a price.
    hint: typeof cmd.hint === 'function' ? cmd.hint(instance, ctx) : cmd.hint,
    enabledResult: cmd.enabled ? cmd.enabled(instance, ctx) : true,
  }));
}

/**
 * The pad a base station's own build/upgrade commands operate on. Its
 * `deployOrigin`, not its live position — a deployed base is drivable (see
 * vehicleController.js's `immobile`), so "the pad under my current feet"
 * stops being the right question the moment it drives off it.
 */
export function basePad(instance, ctx) {
  const anchor = instance.deployOrigin ?? instance.group.position;
  const pad = ctx.terraform.padAt(anchor.x, anchor.z);
  // A pad found by position could belong to somebody else if two bases
  // deployed close together; only your own is yours to build on.
  return pad && (pad.teamId ?? 0) === instance.teamId ? pad : null;
}

/**
 * The nearest finished repair bay, or null. Filtered to `mode === 'idle'` so a
 * bay still rising out of the ground can't be targeted — same convention
 * harvesterAI's own facility lookup uses.
 */
function nearestRepairBay(instance, ctx) {
  const pos = instance.group.position;
  let best = null;
  let bestD = Infinity;
  for (const s of ctx.structures.instances) {
    if (s.def.id !== 'repair-bay' || s.mode !== 'idle') continue;
    if (s.teamId !== instance.teamId) continue; // never queue at an enemy bay
    const d = Math.hypot(s.x - pos.x, s.z - pos.z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * Shared across every vehicle type that can actually drive to a bay. The base
 * station isn't spliced in below — a deployed one can drive now (see
 * vehicleController.js's `immobile`), but it isn't wired into the repair
 * queue/dock flow the way scouts and harvesters are, so it's left out rather
 * than half-supported. One object, spliced into more than one catalog entry
 * below; `commandsFor` shallow-spreads it per use, so sharing the reference is
 * safe.
 */
const REPAIR_COMMAND = {
  id: 'repair',
  label: 'Repair',
  hint(instance, ctx) {
    const bay = nearestRepairBay(instance, ctx);
    if (!bay) return 'Needs a repair bay';
    const missing = instance.def.maxHealth - instance.health;
    return `${Math.ceil(missing * bay.def.repair.creditsPerHealth)} cr`;
  },
  enabled(instance, ctx) {
    // Re-issuing this mid-repair would overwrite `instance.repair` without
    // releasing whatever dock/queue slot it already holds at the old bay —
    // simplest correct fix is to not offer it again until the current one ends.
    if (instance.repair) return 'Already repairing';
    if (instance.health >= instance.def.maxHealth) return 'Already at full health';
    if (!nearestRepairBay(instance, ctx)) return 'No repair bay built';
    return true;
  },
  execute(instance, ctx) {
    const bay = nearestRepairBay(instance, ctx);
    if (!bay) return; // balance of enabled() may have moved since the menu opened
    instance.repair = { bay, state: 'to-bay' };
  },
};

/**
 * Opens click-to-target mode (resolved in main.js's pointerup handler, same
 * shape as harvestSelectMode): the next click on an enemy vehicle locks
 * sustained fire onto it. Auto-arms rather than requiring a separate
 * Arm/Disarm step first — the point of this command is "fight that one",
 * not "prepare to fight". combatController's own _validTarget gate (range/
 * LoS/team/dead) does the rest: the lock clears itself once the target dies
 * or breaks contact, at which point normal automatic acquisition resumes.
 */
const SELECT_TARGET_COMMAND = {
  id: 'select-target',
  label: 'Select target',
  hint: 'Click an enemy to lock fire on it',
  execute(instance, ctx) {
    ctx.targetSelectMode = { unit: instance };
  },
};

/**
 * Shared by every building def that carries an `upgradeTiers` array —
 * currently the repair bay and the harvester facility. Per-instance: each
 * building tracks its own `upgradeLevel`, so upgrading one never touches
 * another, even of the same type.
 */
const UPGRADE_COMMAND = {
  id: 'upgrade',
  label: 'Upgrade',
  hint(instance) {
    const tiers = instance.def.upgradeTiers;
    const tier = tiers?.[instance.upgradeLevel];
    if (!tier) return 'Max tier';
    return `${tier.cost} cr — tier ${instance.upgradeLevel + 1}/${tiers.length}`;
  },
  enabled(instance, ctx) {
    const tiers = instance.def.upgradeTiers;
    if (!tiers || instance.upgradeLevel >= tiers.length) return 'Already at max tier';
    const tier = tiers[instance.upgradeLevel];
    const team = ctx.game.teamOf(instance);
    if (team.credits < tier.cost) return `Needs ${tier.cost} cr (have ${Math.floor(team.credits)})`;
    return true;
  },
  execute(instance, ctx) {
    const tier = instance.def.upgradeTiers?.[instance.upgradeLevel];
    if (!tier) return;
    // spend() is the real gate — balance may have moved since the menu opened.
    if (ctx.game.teamOf(instance).spend(tier.cost)) instance.upgradeLevel++;
  },
};

/**
 * Reclaim a deployed defense for a fraction of its cost, scaled by how much
 * health it has left — a turret whittled down to the floor by an attack
 * shouldn't refund the same as one that was never touched. There was
 * previously no way at all to get rid of a defense placed somewhere it
 * turns out to be wrong (blocking a build, guarding a perimeter the map
 * doesn't actually need) short of letting the enemy destroy it for free.
 *
 * Not wired to any structure by default — see the 'gun-turret'/
 * 'sensor-tower' entries below — since nothing here reads anything
 * defense-specific and a future structure could reuse it unchanged.
 */
const SELL_REFUND_FRACTION = 0.5;
function sellRefund(instance) {
  const { cost = 0, maxHealth = 1 } = instance.def;
  return Math.round(cost * SELL_REFUND_FRACTION * (instance.health / maxHealth));
}
const SELL_COMMAND = {
  id: 'sell',
  label: 'Sell',
  hint(instance) {
    return `+${sellRefund(instance)} cr`;
  },
  execute(instance, ctx) {
    ctx.game.teamOf(instance).earn(sellRefund(instance));
    // Queued through the destroy pipeline, same as deployDefenseCommands'
    // engineer-consuming execute() — not spliced here directly, so nothing
    // is removed from an array another system is still walking this tick.
    ctx.entities.queueDestroy(instance);
  },
};

/**
 * Team-scoped counterpart to UPGRADE_COMMAND — same hint/enabled/execute
 * shape, but reads and writes `team.weaponTier`/`WEAPON_TIERS` instead of a
 * building's own `instance.upgradeLevel`/`def.upgradeTiers`. One purchase
 * speeds up every combat vehicle the team owns, present and future — see
 * core/team.js's WEAPON_TIERS doc comment for why.
 */
const TEAM_WEAPON_UPGRADE_COMMAND = {
  id: 'upgrade-weapons',
  label: 'Upgrade Weapons',
  hint(instance, ctx) {
    const team = ctx.game.teamOf(instance);
    const tier = WEAPON_TIERS[team.weaponTier];
    if (!tier) return 'Max tier';
    return `${tier.cost} cr — tier ${team.weaponTier + 1}/${WEAPON_TIERS.length}`;
  },
  enabled(instance, ctx) {
    const team = ctx.game.teamOf(instance);
    if (team.weaponTier >= WEAPON_TIERS.length) return 'Already at max tier';
    const tier = WEAPON_TIERS[team.weaponTier];
    if (team.credits < tier.cost) return `Needs ${tier.cost} cr (have ${Math.floor(team.credits)})`;
    return true;
  },
  execute(instance, ctx) {
    const team = ctx.game.teamOf(instance);
    const tier = WEAPON_TIERS[team.weaponTier];
    if (!tier) return;
    if (team.spend(tier.cost)) team.weaponTier++;
  },
};

/**
 * One "Build X" command per unit a structure produces, generated from the
 * catalog rather than written out. Adding a unit to a structure's `produces`
 * list is then the entire change — no command to write, and nothing here to
 * keep in sync with the catalog.
 */
function producedByCommands(structureId) {
  const def = STRUCTURE_CATALOG.find((d) => d.id === structureId);
  return (def?.produces ?? []).map((unitId) => buildCommandFor(unitId));
}

/**
 * One "Build X" command.
 *
 * Split out of the two near-identical generators below so a command can also
 * be produced for a *single* id on demand — which is what author-built
 * vehicles need, since `COMMANDS` is assembled at module import, long before
 * anyone has signed in and loaded theirs.
 *
 * The unit's name is resolved through `ctx.vehicles.defOf` at call time rather
 * than from `VEHICLE_CATALOG` at generation time, because a custom vehicle is
 * not in that array — `defOf` searches the built-ins and then the custom defs.
 *
 * @param {string} unitId
 * @param {boolean} [atBase] spawn near the team's base rather than at the
 *   producing structure. The Armed Factory's units queue outside the base pad.
 */
function buildCommandFor(unitId, { atBase = false } = {}) {
  return {
    id: `build-${unitId}`,
    label: `Build ${VEHICLE_CATALOG.find((v) => v.id === unitId)?.name ?? unitId}`,
    hint: (instance, ctx) => `${ctx.vehicles.defOf(unitId)?.cost ?? '?'} cr`,
    enabled(instance, ctx) {
      const unitDef = ctx.vehicles.defOf(unitId);
      // A custom vehicle can vanish between menus — deleted in the editor, or
      // the mode changed to one that does not admit it. Refuse rather than
      // throw on a def that is no longer there.
      if (!unitDef) return 'Unavailable';
      const team = ctx.game.teamOf(instance);
      if (team.credits < unitDef.cost) {
        return `Needs ${unitDef.cost} cr (have ${Math.floor(team.credits)})`;
      }
      return true;
    },
    execute(instance, ctx) {
      const unitDef = ctx.vehicles.defOf(unitId);
      if (!unitDef) return;
      // spend() is the gate, not the enabled() check — that ran when the
      // menu opened and the balance can have moved since.
      if (ctx.game.teamOf(instance).spend(unitDef.cost)) {
        ctx.produceUnit(unitDef, atBase ? baseSpawnAnchor(instance, ctx) : instance);
      }
    },
  };
}

/**
 * Every unit id a structure can produce right now: its own `produces` list,
 * then any author-built vehicle naming it in `producedBy`.
 *
 * `producedBy` had no reader at all before this — the live link was the
 * structure's `produces` array, and the field was inert documentation on the
 * catalog defs. Custom vehicles make it load-bearing, since a player cannot
 * edit `structures.js`.
 *
 * Custom ids come *after* the built-ins deliberately. `aiCommander` takes the
 * first produced unit matching its wanted tag that is under its cap, so
 * appending means a custom vehicle supplements the AI's normal build order
 * rather than silently displacing it.
 *
 * Custom defs are read from `ctx.vehicles.extraDefs`, which is already
 * mode-gated: `applyCustomCatalog()` leaves it empty in an online match (see
 * src/builder/customCatalog.js), so nothing here has to re-check the mode for
 * a custom vehicle to be correctly unbuildable online.
 */
export function producedUnitIds(structureDef, ctx) {
  const own = structureDef?.produces ?? [];
  const extra = ctx?.vehicles?.extraDefs ?? [];
  if (!extra.length || !structureDef?.id) return own;
  const custom = extra
    .filter((d) => d.producedBy === structureDef.id && !own.includes(d.id))
    .map((d) => d.id);
  return custom.length ? [...own, ...custom] : own;
}

/**
 * The spot a newly produced military vehicle waits: near the team's base
 * station, just outside its pad — not next to the Armed Factory that built
 * it. produceUnit() only ever reads `.x`/`.z`/`.angle`/`.def.dockOffset`/
 * `.dock` off whatever "facility" it's handed, so this builds a small
 * stand-in shaped like one instead of passing the Armed Factory itself.
 */
function baseSpawnAnchor(instance, ctx) {
  const base = ctx.vehicles.instanceOf(ctx.vehicles.defOf('base-station'), instance.teamId);
  if (!base) return instance; // no base to anchor on — fall back to the factory's own spot
  const pad = basePad(base, ctx);
  const pos = base.group.position;
  return {
    x: pos.x,
    z: pos.z,
    angle: base.heading,
    dock: pos,
    // Clears the pad's flattened disc (and whatever else is built on it) —
    // sized off the pad's own radius, not a guessed constant, since a base
    // that relocated could sit on a differently-sized pad than the default.
    def: { dockOffset: (pad?.radius ?? base.def.deploy.padRadius) + 8 },
    // produceUnit reads this straight off the anchor it's handed — omitting
    // it silently defaulted every produced unit to team 0's vehicles.spawn
    // default, confirmed live: three AI teams' Light Tanks all turned up
    // owned by team 0. instance.teamId (the Armed Factory's own) is correct
    // here, not base.teamId — the two only differ if a base is ever captured
    // independently of its buildings, which cannot happen today, but reading
    // the producing structure's own team is the honest source of truth.
    teamId: instance.teamId,
  };
}

/**
 * producedByCommands' counterpart for a structure whose units should spawn
 * at the team's base rather than at the structure itself — currently just
 * the Armed Factory. Same shape, only `execute`'s spawn anchor differs.
 */
function producedNearBaseCommands(structureId) {
  const def = STRUCTURE_CATALOG.find((d) => d.id === structureId);
  return (def?.produces ?? []).map((unitId) => buildCommandFor(unitId, { atBase: true }));
}

/** Structures whose produced units wait by the base rather than at the works. */
const SPAWNS_AT_BASE = new Set(['armed-factory']);

/**
 * "Deploy X" for every defensive structure, offered by the field engineer.
 *
 * No new intent type: a radial command already crosses the wire as a `cmd`
 * intent, which every client resolves through commandsFor and executes
 * identically — the same route the base station's own `deploy` takes. Adding a
 * bespoke intent would be redundant wire format, and intent shapes are the one
 * thing peers on different builds cannot detect a mismatch in.
 *
 * The engineer is consumed. That is what makes placement a real commitment
 * rather than a free sprinkle of turrets, and it is why the cost lives on the
 * *vehicle* rather than being charged again here.
 */
function deployDefenseCommands() {
  return STRUCTURE_CATALOG.filter((d) => d.tags?.includes('defense')).map((def) => ({
    id: `deploy-${def.id}`,
    label: `Deploy ${def.name}`,
    hint: def.description,
    enabled(instance, ctx) {
      // Deployed on open ground, deliberately outside any pad: the whole point
      // is perimeter cover, and canPlaceAt would confine it to the base disc.
      // The one thing worth refusing is ground the building would stand in.
      const pos = instance.group.position;
      if (ctx.heightmap.heightAt(pos.x, pos.z) <= ctx.heightmap.seaLevelY) {
        return 'Cannot deploy in water';
      }
      return true;
    },
    execute(instance, ctx) {
      const pos = instance.group.position;
      ctx.structures.placeAt(def, pos.x, pos.z, ctx.heightmap, { teamId: instance.teamId });
      // Spent. Queued through the destroy pipeline rather than spliced here,
      // so nothing is removed from an array another system is still walking
      // this tick.
      ctx.entities.queueDestroy(instance);
    },
  }));
}

const COMMANDS = {
  'scout-buggy': {
    mobile: [
      {
        id: 'arm',
        label: 'Arm turret',
        hint: 'Scans, but slows you down',
        execute(instance) {
          instance.mode = 'armed';
          // Drop whatever it was doing: arming is a decision to hold position
          // and watch, not something you do mid-charge.
          instance.setDriveInput(0, 0);
          instance.target = null;
        },
      },
      SELECT_TARGET_COMMAND,
      REPAIR_COMMAND,
    ],
    armed: [
      SELECT_TARGET_COMMAND,
      {
        id: 'disarm',
        label: 'Disarm',
        hint: 'Full speed restored',
        execute(instance) {
          instance.mode = 'mobile';
        },
      },
    ],
  },

  'gun-platform': {
    // No separate arm step — select-target itself arms (see the command's own
    // comment). This mode list only needs a way back out.
    mobile: [SELECT_TARGET_COMMAND],
    armed: [
      SELECT_TARGET_COMMAND,
      {
        id: 'disarm',
        label: 'Disarm',
        hint: 'Full speed restored',
        execute(instance) {
          instance.mode = 'mobile';
        },
      },
    ],
  },

  'base-station': {
    mobile: [
      {
        id: 'deploy',
        label: 'Deploy base',
        hint: 'Flattens a construction pad',
        enabled(instance, ctx) {
          const pos = instance.group.position;
          return ctx.terraform.canDeployAt(pos.x, pos.z, instance.def.deploy, instance.teamId);
        },
        execute(instance, ctx) {
          const pos = instance.group.position;
          instance.mode = 'deploying';
          instance.setDriveInput(0, 0);
          instance.target = null;
          ctx.terraform.deployPad(pos.x, pos.z, {
            ...instance.def.deploy,
            // The pad belongs to whoever's base flattened it.
            teamId: instance.teamId,
            // The vehicle only calls itself deployed once the ground actually is.
            onComplete: () => {
              instance.mode = 'deployed';
              // Anchor for "has it wandered off the dock" — pos can't have
              // moved since deploying is still immobile, so this is the true
              // settle point, not a snapshot taken too early.
              instance.deployOrigin = { x: pos.x, z: pos.z };
              instance.spireGrown = false;
            },
          });
        },
      },
    ],
    deploying: [],
    deployed: [
      {
        id: 'build-harvester-facility',
        label: 'Harvester Facility',
        hint: 'Ships one harvester',
        enabled(instance, ctx) {
          const pad = basePad(instance, ctx);
          if (!pad || !pad.complete) return 'Needs a finished pad';
          const def = ctx.structures.defOf('harvester-facility');
          if (ctx.structures.instanceOf('harvester-facility', instance.teamId)) {
            return 'Already built';
          }
          if (!ctx.structures.freeSlot(pad, def.footprint)) return 'No free slot on the pad';
          return true;
        },
        execute(instance, ctx) {
          const pad = basePad(instance, ctx);
          // Enters manual placement instead of placing immediately — the
          // player picks exactly where on the pad it goes.
          ctx.buildPlacementMode = { def: ctx.structures.defOf('harvester-facility'), pad };
        },
      },
      {
        id: 'build-repair-bay',
        label: 'Repair Bay',
        hint: (instance, ctx) => `${ctx.structures.defOf('repair-bay').cost} cr`,
        enabled(instance, ctx) {
          const pad = basePad(instance, ctx);
          if (!pad || !pad.complete) return 'Needs a finished pad';
          const def = ctx.structures.defOf('repair-bay');
          // Per-pad, not global — a base built after relocating gets its own
          // fresh allowance rather than being blocked by one built earlier.
          if (pad.buildings.some((b) => b.id === 'repair-bay')) return 'Already built here';
          const team = ctx.game.teamOf(instance);
          if (team.credits < def.cost) {
            return `Needs ${def.cost} cr (have ${Math.floor(team.credits)})`;
          }
          if (!ctx.structures.freeSlot(pad, def.footprint)) return 'No free slot on the pad';
          return true;
        },
        execute(instance, ctx) {
          const pad = basePad(instance, ctx);
          const def = ctx.structures.defOf('repair-bay');
          // spend() is the real gate — balance can have moved since the menu
          // opened — so only enter placement mode once it actually clears.
          if (!pad || !ctx.game.teamOf(instance).spend(def.cost)) return;
          ctx.buildPlacementMode = { def, pad };
        },
      },
      {
        id: 'build-armed-factory',
        label: 'Armed Factory',
        hint: (instance, ctx) => `${ctx.structures.defOf('armed-factory').cost} cr`,
        enabled(instance, ctx) {
          const pad = basePad(instance, ctx);
          if (!pad || !pad.complete) return 'Needs a finished pad';
          const def = ctx.structures.defOf('armed-factory');
          if (ctx.structures.instanceOf('armed-factory', instance.teamId)) return 'Already built';
          const team = ctx.game.teamOf(instance);
          if (team.credits < def.cost) {
            return `Needs ${def.cost} cr (have ${Math.floor(team.credits)})`;
          }
          if (!ctx.structures.freeSlot(pad, def.footprint)) return 'No free slot on the pad';
          return true;
        },
        execute(instance, ctx) {
          const pad = basePad(instance, ctx);
          const def = ctx.structures.defOf('armed-factory');
          // spend() is the real gate — balance can have moved since the menu
          // opened — so only enter placement mode once it actually clears.
          if (!pad || !ctx.game.teamOf(instance).spend(def.cost)) return;
          ctx.buildPlacementMode = { def, pad };
        },
      },
      {
        id: 'relocate-base',
        label: 'Relocate Base',
        hint: 'Leaves a power spire behind',
        enabled(instance, ctx) {
          if (!ctx.game.teamOf(instance).reachedRelocateThreshold) {
            return 'Needs 50000 cr lifetime earned';
          }
          return true;
        },
        execute(instance, ctx) {
          const pos = instance.group.position;
          ctx.structures.placeAt(ctx.structures.defOf('power-spire'), pos.x, pos.z, ctx.heightmap, {
            teamId: instance.teamId,
          });
          // Free to drive off and redeploy elsewhere via the existing 'deploy'
          // command, completely unchanged.
          instance.mode = 'mobile';
        },
      },
    ],
  },

  'field-engineer': {
    mobile: deployDefenseCommands(),
  },

  // Sell is the only command either defense has: a gun-turret comes up
  // 'armed' (it has a turret block — see StructureInstance's own comment on
  // why), a sensor-tower 'idle' (it never does). Neither has anything else
  // to offer a player once placed — no upgrade tiers, nothing to produce.
  'gun-turret': {
    armed: [SELL_COMMAND],
  },
  'sensor-tower': {
    idle: [SELL_COMMAND],
  },

  'harvester-facility': {
    building: [],
    idle: [...producedByCommands('harvester-facility'), UPGRADE_COMMAND],
  },

  'armed-factory': {
    building: [],
    idle: [...producedNearBaseCommands('armed-factory'), TEAM_WEAPON_UPGRADE_COMMAND],
  },

  'repair-bay': {
    building: [],
    idle: [UPGRADE_COMMAND],
  },

  'crystal-harvester': {
    mobile: [
      {
        id: 'target-harvest',
        label: 'Target Harvest',
        hint: 'Click a specific bloom',
        execute(instance, ctx) {
          ctx.harvestSelectMode = { harvester: instance };
        },
      },
      {
        id: 'return-to-base',
        label: 'Return to Base',
        hint: 'Park at facility',
        execute(instance) {
          // The driver reads this when it next finishes unloading; there is no
          // handle to the AI from here, and it does not need one.
          instance.shouldPark = true;
        },
      },
      REPAIR_COMMAND,
    ],
  },
};
