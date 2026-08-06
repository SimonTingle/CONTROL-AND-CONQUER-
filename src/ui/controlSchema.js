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
  const color = (label, get, set) => ({ type: 'color', label, get, set });

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
        // Local saves work fully offline — no account, no backend. A native
        // prompt() for the slot name keeps this to one control each rather
        // than introducing a text-field control type for a single use.
        {
          type: 'button',
          label: 'Save game (local)',
          action: () => {
            const slot = window.prompt('Save slot name:', 'default');
            if (slot === null) return; // cancelled
            game.saveGame(slot || 'default');
            window.alert(`Saved to "${slot || 'default'}".`);
          },
        },
        {
          type: 'button',
          label: 'Load game (local)',
          action: () => {
            const slot = window.prompt('Load which slot?', 'default');
            if (slot === null) return;
            const result = game.loadGame(slot || 'default');
            if (!result) window.alert(`No save found in slot "${slot || 'default'}".`);
          },
        },
        // Cloud saves need both a backend build and a signed-in account —
        // hidden rather than shown-disabled, since an offline build has no
        // sensible "sign in" action to point the player at.
        ...(api.isConfigured && game.account
          ? [
              {
                type: 'button',
                label: 'Save to cloud',
                action: async () => {
                  const name = window.prompt('Cloud save name:', 'default');
                  if (name === null) return;
                  try {
                    await game.saveToCloud(name || 'default');
                    window.alert(`Saved "${name || 'default'}" to your account.`);
                  } catch (err) {
                    window.alert(`Could not save: ${err.message ?? err}`);
                  }
                },
              },
              {
                type: 'button',
                label: 'Load from cloud',
                action: async () => {
                  let saves;
                  try {
                    saves = await game.listCloudSaves();
                  } catch (err) {
                    window.alert(`Could not reach the server: ${err.message ?? err}`);
                    return;
                  }
                  if (!saves.length) {
                    window.alert('No cloud saves yet.');
                    return;
                  }
                  const listing = saves
                    .map((s, i) => `${i + 1}. ${s.name} — ${new Date(s.updatedAt).toLocaleString()}`)
                    .join('\n');
                  const pick = window.prompt(`${listing}\n\nEnter a number to load:`, '1');
                  if (pick === null) return;
                  const chosen = saves[Number(pick) - 1];
                  if (!chosen) return;
                  try {
                    await game.loadFromCloud(chosen.id);
                  } catch (err) {
                    window.alert(`Could not load: ${err.message ?? err}`);
                  }
                },
              },
            ]
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
        slider('Sun elevation', -10, 90, 0.5,
          () => atmo.params.elevation, (v) => atmo.set({ elevation: v })),
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
        { type: 'button', label: 'New random world', action: () => view.regenerate({ seed: (Math.random() * 1e9) | 0 }) },
        slider('Seed', 0, 100000, 1,
          () => terrain.seed % 100000, (v) => view.regenerate({ seed: v }), { rebuild: true }),
        slider('Amplitude', 10, 220, 1,
          () => terrain.amplitude, (v) => {
            terrain.amplitude = v;
            tu.uAmplitude.value = v;
            world.water.updateLevel();
          }),
        slider('Frequency', 0.4, 5, 0.05,
          () => terrain.frequency, (v) => view.regenerate({ frequency: v }), { rebuild: true }),
        slider('Octaves', 1, 9, 1,
          () => terrain.octaves, (v) => view.regenerate({ octaves: v }), { rebuild: true }),
        slider('Ridges ↔ rolling', 0, 1, 0.01,
          () => terrain.ridgeBlend, (v) => view.regenerate({ ridgeBlend: v }), { rebuild: true }),
        slider('Domain warp', 0, 1.2, 0.01,
          () => terrain.warp, (v) => view.regenerate({ warp: v }), { rebuild: true }),
        slider('Plateau (buildable)', 0, 1, 0.01,
          () => terrain.plateau, (v) => view.regenerate({ plateau: v }), { rebuild: true }),
        slider('Sea level', 0, 0.6, 0.005,
          () => terrain.seaLevel, (v) => {
            terrain.seaLevel = v;
            tu.uSeaLevel.value = v;
            world.water.updateLevel();
          }),
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
        toggle('Headlights (force on)',
          () => view.lighting.forceHeadlights, (v) => (view.lighting.forceHeadlights = v)),
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
