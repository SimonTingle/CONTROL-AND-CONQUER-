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

/**
 * @param {object} instance the VehicleInstance the menu was opened on
 * @param {object} ctx { vehicles, world, heightmap, terraform, game }
 * @returns {Array<{id, label, hint?, enabled?, execute?}>}
 */
export function commandsFor(instance, ctx) {
  const byId = COMMANDS[instance.def.id];
  if (!byId) return [];
  return (byId[instance.mode] ?? []).map((cmd) => ({
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
 * One "Build X" command per unit a structure produces, generated from the
 * catalog rather than written out. Adding a unit to a structure's `produces`
 * list is then the entire change — no command to write, and nothing here to
 * keep in sync with the catalog.
 */
function producedByCommands(structureId) {
  const def = STRUCTURE_CATALOG.find((d) => d.id === structureId);
  const produces = def?.produces ?? [];
  return produces.map((unitId) => ({
    id: `build-${unitId}`,
    label: `Build ${VEHICLE_CATALOG.find((v) => v.id === unitId)?.name ?? unitId}`,
    hint: (instance, ctx) => `${ctx.vehicles.defOf(unitId).cost} cr`,
    enabled(instance, ctx) {
      const unitDef = ctx.vehicles.defOf(unitId);
      const team = ctx.game.teamOf(instance);
      if (team.credits < unitDef.cost) {
        return `Needs ${unitDef.cost} cr (have ${Math.floor(team.credits)})`;
      }
      return true;
    },
    execute(instance, ctx) {
      const unitDef = ctx.vehicles.defOf(unitId);
      // spend() is the gate, not the enabled() check — that ran when the
      // menu opened and the balance can have moved since.
      if (ctx.game.teamOf(instance).spend(unitDef.cost)) ctx.produceUnit(unitDef, instance);
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
      REPAIR_COMMAND,
    ],
    armed: [
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

  'harvester-facility': {
    building: [],
    idle: [...producedByCommands('harvester-facility'), UPGRADE_COMMAND],
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
