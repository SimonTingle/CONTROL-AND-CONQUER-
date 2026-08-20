/**
 * The single source of truth for "what is a game".
 *
 * Used by local saves, cloud saves, and — once online multiplayer lands — the
 * desync-recovery and late-join path, which need exactly the same thing: take
 * a running world, turn it into plain JSON, and rebuild it identically
 * somewhere else.
 *
 * Three rules shape everything here:
 *
 * 1. **Store what cannot be recomputed.** Terrain regenerates exactly from its
 *    seed, so the heightfield is never stored — only the params, plus the pad
 *    records needed to replay the flattening on top (see terraform.restorePad).
 *    Meshes, LOD tiers, quaternions and GPU textures are all derived and are
 *    rebuilt by the normal spawn path.
 *
 * 2. **Rebuild through the real APIs.** Restore calls `vehicles.spawn` and
 *    `structures.place`, never `new VehicleInstance` — so meshes, selectable
 *    userData and shadow-caster arrays are wired exactly as in a live game,
 *    and a change to those paths can't silently skip loaded entities.
 *
 * 3. **Cross-references travel as ids, never as object graphs.** A docked
 *    harvester, a repair bay, a combat target and the player's own vehicle are
 *    all live object references at runtime; each becomes an integer here and
 *    is resolved back in a second pass, after every entity exists.
 */

import * as THREE from 'three';
import { simClock, resetSimClock } from './simClock.js';

/**
 * Bumped whenever the shape below changes incompatibly. Stored in every
 * snapshot so a future version can migrate rather than misread old data.
 */
// v2 closed real gaps rather than reshaping anything: harvester cargo/timers/
// bans, AI commander timers, combat cooldown/turret aim, and the sim tick.
// v1 saves still load — the restore paths below all tolerate the fields being
// absent, which is why this stayed a readable bump and not a migration.
export const SCHEMA_VERSION = 2;

/** Transient controller state that is rebuilt or self-heals, and is deliberately not saved. */
const REBUILT_ON_LOAD =
  'mesh/LOD/quaternion, fog textures, nav-grid caches, dock queue slot sets, ' +
  'per-vehicle reveal caches, in-flight tracer visuals, traffic yield cooldowns';

// ---------------------------------------------------------------------------
// serialize
// ---------------------------------------------------------------------------

/** A Uint8Array as base64 — JSON has no binary type and fog masks are ~65KB each. */
function bytesToBase64(bytes) {
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) on a 65k array overflows the
  // argument limit in some engines.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const round = (n, dp = 3) => Number(n.toFixed(dp));

/** `{x, z}` from a Vector2/Vector3/plain point, or null. */
function point2(p) {
  if (!p) return null;
  return { x: round(p.x), z: round(p.z ?? p.y) };
}

function serializeVehicle(inst) {
  const pos = inst.group.position;
  return {
    id: inst.id,
    defId: inst.def.id,
    teamId: inst.teamId,
    x: round(pos.x),
    y: round(pos.y),
    z: round(pos.z),
    heading: round(inst.heading, 5),
    health: round(inst.health, 2),
    mode: inst.mode,
    headlightsOn: inst.headlightsOn,
    target: point2(inst.target),
    // Ordering key for the picker's Active list, and the lifetime stats shown
    // on its cards. createdAt was previously unserialized, so a reload reset
    // every vehicle's age (and thus the card order); include it here too.
    createdAt: inst.createdAt,
    odometer: round(inst.odometer ?? 0, 2),
    kills: inst.kills ?? 0,
    creditsDelivered: round(inst.creditsDelivered ?? 0, 2),
    // Drive state, so a vehicle mid-journey resumes at speed rather than
    // snapping to a standstill.
    speed: round(inst.speed, 3),
    throttle: round(inst.throttle, 3),
    steer: round(inst.steer, 3),
    steerAngle: round(inst.steerAngle, 4),
    shouldPark: inst.shouldPark ?? false,
    // Combat timing. Without these a restored unit fires the instant it loads,
    // its cooldown having defaulted to 0 — a free alpha strike after any load
    // or resync. `turretBearing` is deliberately absent: it is a derived
    // getter over turretYaw, not state.
    fireCooldown: round(inst._fireCooldown ?? 0, 3),
    turretAim: inst.turretAim === null || inst.turretAim === undefined
      ? null
      : round(inst.turretAim, 5),
    threatUntil: round(inst.threatUntil ?? 0, 3),
    // Cross-references, as ids. Bloom fields already carry a stable id.
    targetFieldId: inst.targetField?.id ?? null,
    combatTargetId: inst.combatTarget?.id ?? null,
    combatTargetKind: inst.combatTarget?.kind ?? null,
    repair: inst.repair
      ? {
          bayId: inst.repair.bay?.id ?? null,
          state: inst.repair.state,
          queuePosition: inst.repair.queuePosition ?? null,
          owed: inst.repair.owed ?? 0,
          // The drive leg itself. Without these a save taken mid-approach
          // restarted its detour sequence from scratch on load and could take a
          // different route than the one in progress; `claimedOrder` in
          // particular decides whether the controller re-issues its own order,
          // which is what keeps it from riding a stale one.
          detours: inst.repair.detours ?? 0,
          waypoint: point2(inst.repair.waypoint),
          stallTimer: round(inst.repair.stallTimer ?? 0, 3),
          claimedOrder: inst.repair.claimedOrder ?? false,
          bestDistance:
            inst.repair.bestDistance == null ? null : round(inst.repair.bestDistance, 2),
          noProgressTimer: round(inst.repair.noProgressTimer ?? 0, 3),
        }
      : null,
  };
}

function serializeStructure(inst) {
  return {
    id: inst.id,
    defId: inst.def.id,
    teamId: inst.teamId,
    x: round(inst.x),
    z: round(inst.z),
    hN: round(inst.hN, 5),
    angle: round(inst.angle, 5),
    health: round(inst.health, 2),
    mode: inst.mode,
    progress: round(inst.progress, 4),
    upgradeLevel: inst.upgradeLevel ?? 0,
    padId: inst.pad?.id ?? null,
    buildTimeOverride: inst.buildTimeOverride ?? null,
    dockedHarvesterId: inst.dockedHarvester?.id ?? null,
    dockedVehicleId: inst.dockedVehicle?.id ?? null,
    parkedHarvesterIds: (inst.parkedHarvesters ?? []).map((v) => v.id),
  };
}

function serializeTeam(team) {
  return {
    id: team.id,
    name: team.name,
    color: team.color,
    isHuman: team.isHuman,
    credits: round(team.credits, 2),
    homePoint: point2(team.homePoint),
    weaponTier: team.weaponTier,
    defeated: team.defeated,
    reachedRelocateThreshold: team.reachedRelocateThreshold,
    stats: { ...team.stats },
    // The per-team explored mask: the one genuinely irreproducible bulk value
    // in a save, since it records where this team has actually driven.
    fog: team.fog ? bytesToBase64(team.fog.data) : null,
  };
}

/**
 * @param {object} ctx { world, heightmap, terraform, vehicles, structures, game, harvesterAI }
 * @returns {object} a plain JSON-safe object
 */
export function serialize(ctx) {
  const { world, terraform, vehicles, structures, game } = ctx;
  const heightmap = ctx.heightmap ?? world.heightmap;

  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    rebuiltOnLoad: REBUILT_ON_LOAD, // documentation for anyone reading a raw save

    mode: game.mode,
    difficultyId: game.difficulty?.id ?? null,
    aiMatch: game.aiMatch ? { ...game.aiMatch } : null,

    // Terrain is a seed plus knobs — never a megabyte of heights.
    terrain: { ...heightmap.params },

    // Replayed over the regenerated terrain, in this order.
    pads: terraform.pads.map((p) => ({
      id: p.id,
      x: round(p.x),
      z: round(p.z),
      teamId: p.teamId ?? 0,
      radius: p.radius,
      blend: p.blend,
      targetN: round(p.targetN, 6),
      progress: round(p.progress, 4),
      complete: p.complete,
    })),

    teams: (game.teams ?? []).map(serializeTeam),
    vehicles: vehicles.instances.filter((v) => !v.dead).map(serializeVehicle),
    structures: structures.instances.filter((s) => !s.dead).map(serializeStructure),

    // Tire tracks: one shared mask, not per-team, since a track mark is
    // exactly as irreproducible as where a team has scouted (it records where
    // vehicles actually drove). Unlike team.fog this is run-length encoded
    // first: the mask is a megabyte and almost entirely zero, so raw base64
    // would add ~1.4MB to every save and put the localStorage quota at risk.
    tracksRLE: world.trackMask ? bytesToBase64(world.trackMask.toRLE()) : null,

    // Which vehicle the player was driving.
    activeVehicleId: vehicles.active?.id ?? null,

    // Harvester routing state, keyed by vehicle id. Held in a Map keyed by
    // object identity at runtime, so it has to be flattened out separately.
    harvesterStates: serializeHarvesterStates(ctx),
    aiCommanders: serializeAiCommanders(ctx),
    // The simulation's own clock. Field bans and threat memory are expressed in
    // sim time, so restoring them without the tick they were written against
    // would make every one of them either already expired or unreachably distant.
    simTick: simClock.tick,
  };
}

function serializeHarvesterStates(ctx) {
  const states = ctx.harvesterAI?.states;
  if (!states) return [];
  const out = [];
  for (const [inst, s] of states) {
    if (inst.dead) continue;
    out.push({
      vehicleId: inst.id,
      state: s.state,
      fieldId: s.field?.id ?? null,
      facilityId: s.facility?.id ?? null,
      dest: point2(s.dest),
      parkingBayIndex: s.parkingBayIndex ?? null,
      queuePosition: s.queuePosition ?? null,
      // `load` is the harvester's cargo. Omitting it (as this did) silently
      // emptied every harvester on load — a crystal run in progress lost its
      // whole payload, and the HUD's load readout reset to 0.
      load: round(s.load ?? 0, 2),
      resumeState: s.resumeState ?? null,
      waypoint: point2(s.waypoint),
      detours: s.detours ?? 0,
      // The three timers. Restoring a harvester without them restarts its
      // stall/pause/retry accounting, which is what makes a reloaded harvester
      // behave differently from one that was never saved.
      stallTimer: round(s.stallTimer ?? 0, 3),
      pauseTimer: round(s.pauseTimer ?? 0, 3),
      retryTimer: round(s.retryTimer ?? 0, 3),
      // Repair-retreat state. The bay is a live ref, stored by id and re-looked
      // up on restore; a TO_REPAIR run that can't resolve its bay falls back to
      // IDLE (see the restore block). The cooldown keeps a just-failed retreat
      // from immediately re-firing after a load.
      repairBayId: s.repairBay?.id ?? null,
      repairRetryCooldown: round(s.repairRetryCooldown ?? 0, 3),
      // Progress tracking, so a reload doesn't hand a circling harvester a
      // fresh six seconds of grace before anything notices it again.
      progressLeg: s.progressLeg ?? null,
      bestDistance: s.bestDistance == null ? null : round(s.bestDistance, 2),
      noProgressTimer: round(s.noProgressTimer ?? 0, 3),
      // Field bans, as [fieldId, expirySimTime] pairs. These are sim-time
      // based (see simClock.js), so they survive a round trip meaningfully.
      bans: s.bans ? [...s.bans].map(([id, until]) => [id, round(until, 3)]) : [],
    });
  }
  return out;
}

/**
 * Each AI team's commander. Small scalars, but omitting them meant a load reset
 * `startTimer` to the full configured build delay — a complete AI restart, with
 * every team standing still again for its opening delay however far into the
 * match the save was taken.
 */
function serializeAiCommanders(ctx) {
  const out = [];
  for (const c of ctx.game?.aiCommanders ?? []) {
    out.push({
      teamId: c.team.id,
      startTimer: round(c.startTimer, 3),
      retryTimer: round(c.retryTimer, 3),
      buildTimer: round(c.buildTimer, 3),
      armyTargetTimer: round(c.armyTargetTimer, 3),
      baseOrderElapsed: round(c.baseOrderElapsed, 3),
      // Latched counters — these only ever widen, so resetting them would send
      // a commander back to searching a ring it has already proven is no good.
      exploreRadius: round(c.exploreRadius, 2),
      baseRelocateAttempts: c.baseRelocateAttempts,
    });
    // `armyTarget` is deliberately not saved: it is a live entity reference
    // that _manageArmy re-picks on its own interval anyway.
  }
  return out;
}

// ---------------------------------------------------------------------------
// deserialize
// ---------------------------------------------------------------------------

export class SnapshotVersionError extends Error {
  constructor(found) {
    super(
      `Save has schema version ${found}, this build understands ${SCHEMA_VERSION}. ` +
        `Saves from a newer version cannot be loaded.`
    );
    this.name = 'SnapshotVersionError';
  }
}

/**
 * Rebuild a world from a snapshot, in place.
 *
 * Order is load-bearing and mirrors the care taken over destroy ordering:
 * terrain → pads → teams → structures → vehicles → cross-references last,
 * because the final pass resolves ids that only mean something once every
 * entity exists.
 */
export function deserialize(ctx, snap) {
  if (!snap || typeof snap !== 'object') throw new Error('Snapshot is empty or malformed.');
  if (snap.schemaVersion > SCHEMA_VERSION) throw new SnapshotVersionError(snap.schemaVersion);

  const { world, terraform, vehicles, structures, game } = ctx;

  // --- clear the current world -------------------------------------------
  // Through each controller's own remove(), which detaches the mesh and
  // disposes its geometry — skipping it would leak a whole world's GPU
  // resources on every load.
  for (const inst of [...vehicles.instances]) vehicles.remove(inst);
  for (const inst of [...structures.instances]) structures.remove(inst);
  vehicles.active = null;
  terraform.pads.length = 0;
  terraform.jobs.length = 0;

  // --- terrain, then pads replayed on top --------------------------------
  world.regenerate(snap.terrain);
  for (const pad of snap.pads) terraform.restorePad(pad);

  // world.regenerate() already cleared trackMask (the ground it described is
  // gone); restore it from the save now that the fresh mask exists. Saves
  // written before the mask changed resolution carry a `tracks` field instead,
  // which no longer matches the grid — those are simply dropped rather than
  // migrated, since tracks are cosmetic and fade within 75s of play anyway.
  if (snap.tracksRLE && world.trackMask) {
    world.trackMask.fromRLE(base64ToBytes(snap.tracksRLE));
  }

  // --- teams --------------------------------------------------------------
  for (const saved of snap.teams) {
    const team = game.teams[saved.id];
    if (!team) continue;
    team.credits = saved.credits;
    team.homePoint = saved.homePoint;
    team.weaponTier = saved.weaponTier;
    team.defeated = saved.defeated;
    team.reachedRelocateThreshold = saved.reachedRelocateThreshold;
    Object.assign(team.stats, saved.stats);
    if (saved.fog && team.fog) {
      team.fog.data.set(base64ToBytes(saved.fog));
      // The mask's own derived counts and GPU texture are refreshed from the
      // bytes we just wrote, rather than being carried in the save.
      team.fog.dirty = true;
      if (team.fog.texture) team.fog.texture.needsUpdate = true;
    }
  }

  // --- structures ---------------------------------------------------------
  const padById = new Map(terraform.pads.map((p) => [p.id, p]));
  const structureById = new Map();
  for (const saved of snap.structures) {
    const def = structures.defOf(saved.defId);
    if (!def) continue; // a save referencing a def this build no longer has
    const pad = saved.padId != null ? padById.get(saved.padId) : null;
    const inst = structures.restore(def, saved, pad);
    structureById.set(saved.id, inst);
  }

  // --- vehicles -----------------------------------------------------------
  const vehicleById = new Map();
  for (const saved of snap.vehicles) {
    const def = vehicles.defOf(saved.defId);
    if (!def) continue;
    const inst = vehicles.spawn(
      def,
      new THREE.Vector3(saved.x, saved.y, saved.z),
      saved.heading,
      { activate: false, teamId: saved.teamId, id: saved.id }
    );
    inst.health = saved.health;
    inst.mode = saved.mode;
    inst.headlightsOn = saved.headlightsOn;
    inst.speed = saved.speed;
    inst.throttle = saved.throttle;
    inst.steer = saved.steer;
    inst.steerAngle = saved.steerAngle;
    inst.shouldPark = saved.shouldPark;
    // Combat timing (v2+). `??` throughout so a v1 save still loads, just
    // without these — the same tolerance every other v2 field relies on.
    inst._fireCooldown = saved.fireCooldown ?? 0;
    inst.turretAim = saved.turretAim ?? null;
    inst.threatUntil = saved.threatUntil ?? 0;
    // Age + lifetime stats. `??` keeps older saves loading: a missing createdAt
    // falls back to the fresh tick spawn() just stamped, stats default to 0.
    if (saved.createdAt != null) inst.createdAt = saved.createdAt;
    inst.odometer = saved.odometer ?? 0;
    inst.kills = saved.kills ?? 0;
    inst.creditsDelivered = saved.creditsDelivered ?? 0;
    if (saved.target) inst.target = new THREE.Vector2(saved.target.x, saved.target.z);
    vehicleById.set(saved.id, inst);
  }

  // A base station saved mid-deploy needs its pad's job wired back to it: the
  // original onComplete (commands.js's 'deploy' command) is a closure over the
  // vehicle instance and cannot be serialized, so without this the pad would
  // finish flattening (terraform.js's restorePad re-queues the job) but the
  // vehicle would sit at mode 'deploying' forever, never becoming 'deployed'.
  for (const inst of vehicleById.values()) {
    if (inst.mode !== 'deploying') continue;
    const job = terraform.jobs.find((j) => (j.pad.teamId ?? 0) === inst.teamId && !j.pad.complete);
    if (!job) continue;
    job.onComplete = () => {
      inst.mode = 'deployed';
      inst.deployOrigin = { x: inst.group.position.x, z: inst.group.position.z };
      inst.spireGrown = false;
    };
  }

  // --- cross-references, now that everything exists -----------------------
  const fieldById = new Map((world.blooms?.fields ?? []).map((f) => [f.id, f]));
  const lookup = (kind, id) =>
    kind === 'structure' ? structureById.get(id) : vehicleById.get(id);

  for (const saved of snap.vehicles) {
    const inst = vehicleById.get(saved.id);
    if (!inst) continue;

    if (saved.targetFieldId != null) inst.targetField = fieldById.get(saved.targetFieldId) ?? null;
    if (saved.combatTargetId != null) {
      // A dangling combat target is harmless — combatController re-acquires on
      // the next tick — so a miss here is left null rather than treated as an
      // error.
      inst.combatTarget = lookup(saved.combatTargetKind, saved.combatTargetId) ?? null;
    }
    if (saved.repair?.bayId != null) {
      const bay = structureById.get(saved.repair.bayId);
      // Without its bay the repair record would be a permanent stall, so it is
      // dropped entirely rather than restored half-resolved.
      if (bay) {
        inst.repair = {
          bay,
          state: saved.repair.state,
          queuePosition: saved.repair.queuePosition,
          owed: saved.repair.owed,
          // Drive-leg state. `??` so a save written before these existed still
          // loads — it just restarts the approach, which is the old behaviour.
          detours: saved.repair.detours ?? 0,
          waypoint: saved.repair.waypoint ?? null,
          stallTimer: saved.repair.stallTimer ?? 0,
          claimedOrder: saved.repair.claimedOrder ?? false,
          bestDistance: saved.repair.bestDistance ?? null,
          noProgressTimer: saved.repair.noProgressTimer ?? 0,
        };
      }
    }
  }

  for (const saved of snap.structures) {
    const inst = structureById.get(saved.id);
    if (!inst) continue;
    if (saved.dockedHarvesterId != null) {
      inst.dockedHarvester = vehicleById.get(saved.dockedHarvesterId) ?? null;
    }
    if (saved.dockedVehicleId != null) {
      inst.dockedVehicle = vehicleById.get(saved.dockedVehicleId) ?? null;
    }
    if (saved.parkedHarvesterIds?.length) {
      inst.parkedHarvesters = saved.parkedHarvesterIds
        .map((id) => vehicleById.get(id))
        .filter(Boolean);
    }
  }

  // --- harvester routing --------------------------------------------------
  if (ctx.harvesterAI) {
    ctx.harvesterAI.states.clear();
    for (const saved of snap.harvesterStates) {
      const inst = vehicleById.get(saved.vehicleId);
      if (!inst) continue;
      const state = ctx.harvesterAI._stateFor(inst);
      state.state = saved.state;
      state.field = saved.fieldId != null ? (fieldById.get(saved.fieldId) ?? null) : null;
      state.facility = saved.facilityId != null ? (structureById.get(saved.facilityId) ?? null) : null;
      state.dest = saved.dest;
      state.parkingBayIndex = saved.parkingBayIndex;
      state.queuePosition = saved.queuePosition;
      // v2+. Cargo especially: without it every harvester loaded empty.
      state.load = saved.load ?? 0;
      state.resumeState = saved.resumeState ?? state.resumeState;
      state.waypoint = saved.waypoint ?? null;
      state.detours = saved.detours ?? 0;
      state.stallTimer = saved.stallTimer ?? 0;
      state.pauseTimer = saved.pauseTimer ?? 0;
      state.retryTimer = saved.retryTimer ?? 0;
      // Repair retreat (v-newer). Resolve the bay by id; if it's gone, a
      // TO_REPAIR run has nowhere to go, so drop back to IDLE rather than
      // leaving the harvester driving at a null destination.
      state.repairBay =
        saved.repairBayId != null ? (structureById.get(saved.repairBayId) ?? null) : null;
      state.repairRetryCooldown = saved.repairRetryCooldown ?? 0;
      state.progressLeg = saved.progressLeg ?? null;
      state.bestDistance = saved.bestDistance ?? null;
      state.noProgressTimer = saved.noProgressTimer ?? 0;
      if (state.state === 'to-repair' && !state.repairBay) state.state = 'idle';
      state.bans = new Map(saved.bans ?? []);
    }
  }

  // --- AI commanders ------------------------------------------------------
  // Timers only; `armyTarget` is a live reference the commander re-picks on its
  // own interval, and `economy` is derived from difficulty in the constructor.
  if (snap.aiCommanders?.length) {
    const byTeam = new Map((game.aiCommanders ?? []).map((c) => [c.team.id, c]));
    for (const saved of snap.aiCommanders) {
      const c = byTeam.get(saved.teamId);
      if (!c) continue;
      c.startTimer = saved.startTimer ?? 0;
      c.retryTimer = saved.retryTimer ?? 0;
      c.buildTimer = saved.buildTimer ?? 0;
      c.armyTargetTimer = saved.armyTargetTimer ?? 0;
      c.baseOrderElapsed = saved.baseOrderElapsed ?? 0;
      if (saved.exploreRadius != null) c.exploreRadius = saved.exploreRadius;
      if (saved.baseRelocateAttempts != null) c.baseRelocateAttempts = saved.baseRelocateAttempts;
    }
  }

  // --- match context ------------------------------------------------------
  game.mode = snap.mode;
  if (snap.aiMatch) game.aiMatch = { ...snap.aiMatch };
  // The sim clock last: bans and threat memory restored above are expressed
  // against it, so it has to land as the value they were written under.
  resetSimClock(snap.simTick ?? 0);

  // Restoring the player's vehicle last, through setActive, so the camera and
  // input rig attach exactly as they would on a normal selection.
  if (snap.activeVehicleId != null) {
    const active = vehicleById.get(snap.activeVehicleId);
    if (active) vehicles.setActive(active);
  }

  return {
    vehicles: vehicleById.size,
    structures: structureById.size,
    pads: terraform.pads.length,
  };
}
