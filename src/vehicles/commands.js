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
          ctx.structures.place(ctx.structures.defOf('harvester-facility'), pad);
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
    ],
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
        execute(instance, ctx) {
          instance.shouldPark = true;
          instance.harvestAI?.setTargetToBase();
        },
      },
    ],
  },
};
