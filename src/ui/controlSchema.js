/**
 * Declarative description of every tunable in the world.
 *
 * Each control says how to read and write its value; menu.js turns that into
 * widgets. Keeping this as data rather than hand-built DOM means adding a knob
 * later — wind, seasons, unit density — is one entry, not a UI change.
 *
 * `rebuild: true` marks a control that changes the shape of the heightfield and
 * therefore needs a (debounced) CPU regeneration. Everything else is a uniform
 * write and applies on the next frame.
 */
import { api } from '../net/api.js';

export function buildSchema(world, view, game) {
  const atmo = world.atmosphere;
  const terrain = world.heightmap.params;
  const tu = world.terrain.uniforms;
  const wu = world.water.uniforms;

  const slider = (label, min, max, step, get, set, opts = {}) => ({
    type: 'slider', label, min, max, step, get, set, ...opts,
  });
  const toggle = (label, get, set) => ({ type: 'toggle', label, get, set });

  /**
   * Mark a control that writes *simulation* state (not just how the world is
   * drawn) so the menu disables it during an online match.
   *
   * These are authoring and debug affordances. In single player they are
   * harmless; in a match they mutate state the other client has no way of
   * learning about, and the peers silently diverge — a scrubbed sun changes
   * `cycle.phase`, which changes the `sunElevation` fed to blooms.update, which
   * changes crystal regrowth. Regenerating terrain is worse still: every spawn
   * point is derived from the heightmap.
   *
   * Disabling beats syncing them: nothing here is gameplay, and replicating a
   * terrain rebuild mid-match would mean re-deriving the entire world.
   */
  const simState = (control) =>
    game?.mode === 'multiplayer-online'
      ? { ...control, locked: true, lockHint: 'Locked during an online match — it would desync the other player.' }
      : control;
  const color = (label, get, set) => ({ type: 'color', label, get, set });
  // opts: { placeholder, saveLabel, loadLabel, refresh } — refresh is only
  // needed by fields whose list isn't already synchronous (cloud saves).
  const saveField = (get, onSave, onLoad, opts = {}) => ({
    type: 'save-field', get, onSave, onLoad, ...opts,
  });

  // Accounts are entirely optional — this group hides itself in a build with
  // no API server (__API_URL__ empty), so an offline build shows no sign-in
  // affordance it cannot honour.
  const accountGroup = api.isConfigured
    ? [
        {
          title: 'Account',
          controls: game.account
            ? [
                {
                  type: 'button',
                  label: `Sign out (${game.account.displayName})`,
                  action: () => game.signOut(),
                },
              ]
            : [
                {
                  type: 'button',
                  label: 'Sign in / create account',
                  action: () => game.signIn(),
                },
              ],
        },
      ]
    : [];

  return [
    ...accountGroup,
    {
      title: 'Save / Load',
      controls: [
        // Local saves work fully offline — no account, no backend. The field
        // lists existing slot names as you type (game.listLocalSaves()) so
        // re-saving over or loading a known name doesn't mean retyping it
        // exactly; Save always proceeds (new or overwrite), Load only acts on
        // an exact match.
        saveField(
          () => game.listLocalSaves(),
          (name) => {
            game.saveGame(name || 'default');
            window.alert(`Saved to "${name || 'default'}".`);
          },
          (name) => {
            const result = game.loadGame(name || 'default');
            if (!result) window.alert(`No save found named "${name || 'default'}".`);
          }
        ),
        // Cloud saves need both a backend build and a signed-in account —
        // hidden rather than shown-disabled, since an offline build has no
        // sensible "sign in" action to point the player at.
        ...(api.isConfigured && game.account
          ? (() => {
              // Cloud names are upserted by (user_id, name) server-side
              // (server/src/routes/saves.js), so — same as local slots — a
              // name is unique per account and safe to treat as the field's
              // key. This cache is what get()/onLoad read; `refresh` (called
              // on focus by menu.js) is what keeps it real.
              let cloudSaves = [];
              return [
                saveField(
                  () => cloudSaves.map((s) => s.name),
                  async (name) => {
                    try {
                      await game.saveToCloud(name || 'default');
                      window.alert(`Saved "${name || 'default'}" to your account.`);
                    } catch (err) {
                      window.alert(`Could not save: ${err.message ?? err}`);
                    }
                  },
                  async (name) => {
                    const match = cloudSaves.find((s) => s.name === name);
                    if (!match) {
                      window.alert(`No cloud save named "${name || 'default'}".`);
                      return;
                    }
                    try {
                      await game.loadFromCloud(match.id);
                    } catch (err) {
                      window.alert(`Could not load: ${err.message ?? err}`);
                    }
                  },
                  {
                    placeholder: 'Cloud save name…',
                    saveLabel: 'Save to cloud',
                    loadLabel: 'Load from cloud',
                    refresh: async () => {
                      cloudSaves = await game.listCloudSaves();
                    },
                  }
                ),
              ];
            })()
          : []),
      ],
    },
    {
      title: 'Performance',
      controls: [
        // Defaults to off on mobile, on on desktop — see
        // docs/performance-optimization-plan.md Phase 2. Soft shadows are
        // several times more expensive per fragment than the alternative;
        // this just lets either platform override the default in either
        // direction rather than being stuck with it.
        toggle('High-quality shadows',
          () => game.shadowQuality.high, (v) => game.setShadowQuality(v)),
      ],
    },
    {
      title: 'Atmosphere',
      open: true,
      controls: [
        // The cycle drives elevation/azimuth itself every frame (world.js calls
        // atmosphere.update(dt)), so Sun elevation below scrubs `cycle.phase`
        // rather than writing `params.elevation` — otherwise the cycle would
        // overwrite it on the very next frame and the slider would just snap
        // back, which is exactly what it used to do. Azimuth is still derived
        // from phase, so it follows the scrub and its own slider only bites
        // once the cycle is switched off.
        simState(toggle('Day/night cycle', () => atmo.cycle.enabled, (v) => (atmo.cycle.enabled = v))),
        // A full day defaults to 30 minutes, which means ~13 minutes of play
        // before dusk — long enough that the cycle looks broken when you're
        // testing. Shorten this to watch a whole day (and the headlights coming
        // on by themselves) in seconds.
        simState(slider('Day length (min)', 0.5, 30, 0.5,
          () => atmo.cycle.periodSeconds / 60, (v) => (atmo.cycle.periodSeconds = v * 60))),
        // Scrubs time of day while the cycle runs; a plain direct set once it's
        // off. Note the sun's arc peaks at 70°, so the top of this range clamps
        // while cycling.
        simState(slider('Sun elevation', -10, 90, 0.5,
          () => atmo.params.elevation,
          (v) => (atmo.cycle.enabled ? atmo.scrubToElevation(v) : atmo.set({ elevation: v })))),
        slider('Sun azimuth', 0, 360, 1,
          () => atmo.params.azimuth, (v) => atmo.set({ azimuth: v })),
        slider('Haze / turbidity', 0, 20, 0.1,
          () => atmo.params.turbidity, (v) => atmo.set({ turbidity: v })),
        slider('Sky depth (rayleigh)', 0, 6, 0.05,
          () => atmo.params.rayleigh, (v) => atmo.set({ rayleigh: v })),
        slider('Sun glow (mie)', 0, 0.05, 0.0005,
          () => atmo.params.mieCoefficient, (v) => atmo.set({ mieCoefficient: v })),
        slider('Glow spread', 0, 0.99, 0.01,
          () => atmo.params.mieDirectionalG, (v) => atmo.set({ mieDirectionalG: v })),
        slider('Exposure', 0.1, 1.5, 0.01,
          () => atmo.params.exposure, (v) => atmo.set({ exposure: v })),
        slider('Fog density', 0, 0.006, 0.00005,
          () => atmo.params.fogDensity, (v) => atmo.set({ fogDensity: v })),
        slider('Fog tint (cool ↔ warm)', -1, 1, 0.05,
          () => atmo.params.fogTint, (v) => atmo.set({ fogTint: v })),
        slider('Sun intensity', 0, 6, 0.05,
          () => atmo.params.sunIntensity, (v) => atmo.set({ sunIntensity: v })),
        slider('Ambient fill', 0, 2, 0.02,
          () => atmo.params.ambientIntensity, (v) => atmo.set({ ambientIntensity: v })),
      ],
    },
    {
      title: 'Terrain shape',
      controls: [
        simState({ type: 'button', label: 'New random world', action: () => view.regenerate({ seed: (Math.random() * 1e9) | 0 }) }),
        simState(slider('Seed', 0, 100000, 1,
          () => terrain.seed % 100000, (v) => view.regenerate({ seed: v }), { rebuild: true })),
        simState(slider('Amplitude', 10, 220, 1,
          () => terrain.amplitude, (v) => {
            terrain.amplitude = v;
            tu.uAmplitude.value = v;
            world.water.updateLevel();
          })),
        simState(slider('Frequency', 0.4, 5, 0.05,
          () => terrain.frequency, (v) => view.regenerate({ frequency: v }), { rebuild: true })),
        simState(slider('Octaves', 1, 9, 1,
          () => terrain.octaves, (v) => view.regenerate({ octaves: v }), { rebuild: true })),
        simState(slider('Ridges ↔ rolling', 0, 1, 0.01,
          () => terrain.ridgeBlend, (v) => view.regenerate({ ridgeBlend: v }), { rebuild: true })),
        simState(slider('Domain warp', 0, 1.2, 0.01,
          () => terrain.warp, (v) => view.regenerate({ warp: v }), { rebuild: true })),
        simState(slider('Plateau (buildable)', 0, 1, 0.01,
          () => terrain.plateau, (v) => view.regenerate({ plateau: v }), { rebuild: true })),
        simState(slider('Sea level', 0, 0.6, 0.005,
          () => terrain.seaLevel, (v) => {
            terrain.seaLevel = v;
            tu.uSeaLevel.value = v;
            world.water.updateLevel();
          })),
      ],
    },
    {
      title: 'Ground',
      controls: [
        slider('Snow line', 0, 1, 0.01, () => tu.uSnowLine.value, (v) => (tu.uSnowLine.value = v)),
        slider('Snow blend', 0.01, 0.4, 0.01, () => tu.uSnowBlend.value, (v) => (tu.uSnowBlend.value = v)),
        slider('Rock slope', 0, 1, 0.01, () => tu.uRockSlope.value, (v) => (tu.uRockSlope.value = v)),
        slider('Rock blend', 0.01, 0.5, 0.01, () => tu.uRockBlend.value, (v) => (tu.uRockBlend.value = v)),
        slider('Beach width', 0, 0.15, 0.002, () => tu.uSandBand.value, (v) => (tu.uSandBand.value = v)),
        slider('Surface detail', 0, 1.5, 0.02, () => tu.uDetail.value, (v) => (tu.uDetail.value = v)),
        slider('Colour variation', 0, 1, 0.02, () => tu.uMacro.value, (v) => (tu.uMacro.value = v)),
        color('Grass', () => tu.uColorGrass.value, (c) => tu.uColorGrass.value.set(c)),
        color('Rock', () => tu.uColorRock.value, (c) => tu.uColorRock.value.set(c)),
        color('Sand', () => tu.uColorSand.value, (c) => tu.uColorSand.value.set(c)),
        color('Snow', () => tu.uColorSnow.value, (c) => tu.uColorSnow.value.set(c)),
      ],
    },
    {
      title: 'Water',
      controls: [
        slider('Wave speed', 0, 2, 0.02, () => wu.uWaveSpeed.value, (v) => (wu.uWaveSpeed.value = v)),
        slider('Wave scale', 0.005, 0.3, 0.005, () => wu.uWaveScale.value, (v) => (wu.uWaveScale.value = v)),
        slider('Wave strength', 0, 2, 0.02, () => wu.uWaveStrength.value, (v) => (wu.uWaveStrength.value = v)),
        slider('Depth falloff', 2, 60, 1, () => wu.uDepthFade.value, (v) => (wu.uDepthFade.value = v)),
        color('Shallow', () => wu.uShallow.value, (c) => wu.uShallow.value.set(c)),
        color('Deep', () => wu.uDeep.value, (c) => wu.uDeep.value.set(c)),
      ],
    },
    {
      title: 'Camera',
      controls: [
        toggle('Chase camera', () => view.chase.enabled, (v) => view.setChase(v)),
        slider('Chase distance', 8, 140, 1,
          () => view.chase.distance, (v) => (view.chase.distance = v)),
        slider('Chase angle', 0.06, 1.35, 0.01,
          () => view.chase.pitch, (v) => (view.chase.pitch = v)),
        slider('Look ahead', 0, 40, 1,
          () => view.chase.lookAhead, (v) => (view.chase.lookAhead = v)),
        slider('Follow lag', 0.5, 12, 0.1,
          () => view.chase.headingStiffness, (v) => (view.chase.headingStiffness = v)),
      ],
    },
    {
      title: 'Game / debug',
      controls: [
        // Also the production worst-case fps test. Beams come from a fixed pool
        // of four lights (headlightPool.js), so scene light count is 6 whether
        // it's noon or midnight and whether there are 2 vehicles or 80 — there
        // is no heavier lighting state to measure. Turn this on, press `p`, and
        // the fps shown is the floor. Watch the HUD's light count while you do:
        // if it isn't 6, something has started creating per-entity lights again.
        toggle('Headlights (force on)',
          () => view.lighting.forceHeadlights, (v) => (view.lighting.forceHeadlights = v)),
        // TESTING ONLY, and expect it to hurt — that's the point. This gives
        // every vehicle its own pair of real beams, which is the expensive
        // shape headlightPool.js exists to avoid: light cost scales with fleet
        // size again, and toggling it stalls for a few hundred ms while every
        // material re-links. Useful for seeing what per-vehicle lights actually
        // cost on your own hardware, and for confirming the HUD's light-count
        // warning fires. Pair it with 'Headlights (force on)' to see the beams
        // in daylight. Leave it off for real play.
        toggle('Flood: beams on ALL vehicles (test)',
          () => view.lighting.floodHeadlights, (v) => (view.lighting.floodHeadlights = v)),
        toggle('Tap-to-move (mobile)',
          () => view.input.tapToMove, (v) => (view.input.tapToMove = v)),
        toggle('Buildable-ground overlay',
          () => tu.uOverlay.value > 0.5, (v) => (tu.uOverlay.value = v ? 1 : 0)),
        slider('Max buildable slope', 0.05, 1, 0.01,
          () => tu.uOverlayMaxSlope.value, (v) => (tu.uOverlayMaxSlope.value = v)),
        toggle('Shadows', () => view.renderer.shadowMap.enabled, (v) => {
          view.renderer.shadowMap.enabled = v;
          world.terrain.material.needsUpdate = true;
        }),
        toggle('Wireframe', () => world.terrain.material.wireframe,
          (v) => (world.terrain.material.wireframe = v)),
        slider('LOD distance', 80, 700, 10,
          () => world.terrain.lodDistance, (v) => (world.terrain.lodDistance = v)),
      ],
    },
  ];
}
