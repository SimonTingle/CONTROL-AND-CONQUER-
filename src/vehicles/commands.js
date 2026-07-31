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
    const d = Math.hypot(s.x - pos.x, s.z - pos.z);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * Shared across every vehicle type that can actually drive to a bay — a
 * deployed base station can't move, so it's excluded (matches the existing
 * `immobile` getter). One object, spliced into more than one catalog entry
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
    if (ctx.game.credits < tier.cost) return `Needs ${tier.cost} cr (have ${Math.floor(ctx.game.credits)})`;
    return true;
  },
  execute(instance, ctx) {
    const tier = instance.def.upgradeTiers?.[instance.upgradeLevel];
    if (!tier) return;
    // spend() is the real gate — balance may have moved since the menu opened.
    if (ctx.game.spend(tier.cost)) instance.upgradeLevel++;
  },
};

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
          return ctx.terraform.canDeployAt(pos.x, pos.z, instance.def.deploy);
        },
        execute(instance, ctx) {
          const pos = instance.group.position;
          instance.mode = 'deploying';
          instance.setDriveInput(0, 0);
          instance.target = null;
          ctx.terraform.deployPad(pos.x, pos.z, {
            ...instance.def.deploy,
            // The vehicle only calls itself deployed once the ground actually is.
            onComplete: () => {
              instance.mode = 'deployed';
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
          const pad = ctx.terraform.padAt(instance.group.position.x, instance.group.position.z);
          if (!pad || !pad.complete) return 'Needs a finished pad';
          const def = ctx.structures.defOf('harvester-facility');
          if (ctx.structures.instanceOf('harvester-facility')) return 'Already built';
          if (!ctx.structures.freeSlot(pad, def.footprint)) return 'No free slot on the pad';
          return true;
        },
        execute(instance, ctx) {
          const pad = ctx.terraform.padAt(instance.group.position.x, instance.group.position.z);
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
          const pad = ctx.terraform.padAt(instance.group.position.x, instance.group.position.z);
          if (!pad || !pad.complete) return 'Needs a finished pad';
          const def = ctx.structures.defOf('repair-bay');
          // Per-pad, not global — a base built after relocating gets its own
          // fresh allowance rather than being blocked by one built earlier.
          if (pad.buildings.some((b) => b.id === 'repair-bay')) return 'Already built here';
          if (ctx.game.credits < def.cost) {
            return `Needs ${def.cost} cr (have ${Math.floor(ctx.game.credits)})`;
          }
          if (!ctx.structures.freeSlot(pad, def.footprint)) return 'No free slot on the pad';
          return true;
        },
        execute(instance, ctx) {
          const pad = ctx.terraform.padAt(instance.group.position.x, instance.group.position.z);
          const def = ctx.structures.defOf('repair-bay');
          // spend() is the real gate — balance can have moved since the menu
          // opened — so only enter placement mode once it actually clears.
          if (!pad || !ctx.game.spend(def.cost)) return;
          ctx.buildPlacementMode = { def, pad };
        },
      },
      {
        id: 'relocate-base',
        label: 'Relocate Base',
        hint: 'Leaves a power spire behind',
        enabled(instance, ctx) {
          if (!ctx.game.reachedRelocateThreshold) return 'Needs 50000 cr lifetime earned';
          return true;
        },
        execute(instance, ctx) {
          const pos = instance.group.position;
          ctx.structures.placeAt(ctx.structures.defOf('power-spire'), pos.x, pos.z, ctx.heightmap);
          // Free to drive off and redeploy elsewhere via the existing 'deploy'
          // command, completely unchanged.
          instance.mode = 'mobile';
        },
      },
    ],
  },

  'harvester-facility': {
    building: [],
    idle: [
      {
        id: 'build-harvester',
        label: 'Build Harvester',
        hint: (instance, ctx) => `${ctx.vehicles.defOf(instance.def.produces).cost} cr`,
        enabled(instance, ctx) {
          const def = ctx.vehicles.defOf(instance.def.produces);
          if (ctx.game.credits < def.cost) {
            return `Needs ${def.cost} cr (have ${Math.floor(ctx.game.credits)})`;
          }
          return true;
        },
        execute(instance, ctx) {
          const def = ctx.vehicles.defOf(instance.def.produces);
          // spend() is the gate, not the enabled() check — that ran when the
          // menu opened and the balance can have moved since.
          if (ctx.game.spend(def.cost)) ctx.produceUnit(def, instance);
        },
      },
      UPGRADE_COMMAND,
    ],
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
