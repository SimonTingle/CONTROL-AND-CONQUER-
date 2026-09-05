/**
 * The hamburger menu's World Settings page, restricted during a skirmish.
 *
 * Reported directly: in online and vs-AI multiplayer, only "High-quality
 * shadows" (Performance), Camera and Sound should be reachable — every other
 * group either reshapes the world (Terrain shape, Ground, Water, Atmosphere)
 * or manages accounts/saves, neither of which makes sense once a match is
 * already running against another player or an AI commander.
 *
 * A follow-up report asked for Save/Load specifically back for vs-AI: loading
 * a local snapshot mid-*online* match rewinds this client's world with no way
 * to tell the peer — the exact "two clients silently disagree" failure
 * docs/plans/split-brain-invisible-to-the-hash.md exists to close — but vs-AI
 * has no peer, and `core/snapshot.js` fully serializes and restores
 * `game.aiCommanders`, so a save/load round-trip there is self-consistent.
 * See docs/plans/readd-save-load-vs-ai.md. So the two skirmish modes now show
 * genuinely different group sets, not one shared restriction.
 *
 * `simState()` already disabled the individual *controls* that write
 * simulation state during an online match specifically — this is a different,
 * coarser rule: hide whole groups, per mode. The two are independent (a group
 * can be shown-but-locked, or hidden outright), so this needs its own
 * coverage rather than assuming the simState() tests already imply it.
 *
 * `buildSchema()` only *describes* controls — every `get`/`set` is a closure
 * that is stored, not called, while the schema array itself is built — so it
 * can be exercised with minimal stub `world`/`view` objects that satisfy
 * property access without a real three.js scene. `game.mode` is the only
 * input this file's own behaviour actually branches on.
 *
 * `__API_URL__` is a Vite build-time global; shimmed the same way
 * tests/match-client-protocol.test.mjs does, since controlSchema.js imports
 * net/api.js at module scope.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.__API_URL__ = '';

const { buildSchema, isSkirmishMode, settingsHintFor } = await import('../src/ui/controlSchema.js');

/** Just enough of `world`/`view`/`game` for buildSchema() to construct its
 * closures without dereferencing anything eagerly. */
function makeStubs(mode) {
  const world = {
    atmosphere: { cycle: { enabled: false, periodSeconds: 0 }, params: {} },
    heightmap: { params: {} },
    terrain: { uniforms: {}, material: {}, lodDistance: 0 },
    water: { uniforms: {} },
  };
  const view = {
    chase: {},
    lighting: {},
    input: {},
    renderer: { shadowMap: { enabled: true } },
  };
  const game = {
    mode,
    account: null,
    shadowQuality: { high: true },
    setShadowQuality: () => {},
    listLocalSaves: () => [],
  };
  return { world, view, game };
}

function titlesFor(mode) {
  const { world, view, game } = makeStubs(mode);
  return buildSchema(world, view, game).map((g) => g.title);
}

function groupsFor(mode) {
  return buildSchema(...Object.values(makeStubs(mode)));
}

const ALL_GROUPS = [
  'Save / Load', 'Performance', 'Atmosphere', 'Terrain shape',
  'Ground', 'Water', 'Camera', 'Sound', 'Game / debug',
];

test('isSkirmishMode is true for both online and vs-AI, false otherwise', () => {
  assert.equal(isSkirmishMode({ mode: 'multiplayer-online' }), true);
  assert.equal(isSkirmishMode({ mode: 'multiplayer-ai' }), true);
  assert.equal(isSkirmishMode({ mode: 'sandbox' }), false);
  assert.equal(isSkirmishMode({ mode: undefined }), false);
  assert.equal(isSkirmishMode(null), false);
});

test('sandbox sees every settings group, unrestricted', () => {
  const titles = titlesFor('sandbox');
  // Account is absent only because __API_URL__ is unset above
  // (api.isConfigured === false), matching a backend-less build exactly as
  // accountGroup's own comment describes.
  for (const expected of ALL_GROUPS) {
    assert.ok(titles.includes(expected), `sandbox is missing "${expected}"`);
  }
});

// --- online: unchanged by the Save/Load follow-up ---------------------------

test('multiplayer-online still shows only Performance, Camera and Sound', () => {
  assert.deepEqual(titlesFor('multiplayer-online'), ['Performance', 'Camera', 'Sound']);
});

test('multiplayer-online still hides Save/Load along with the world-shaping groups', () => {
  const titles = titlesFor('multiplayer-online');
  for (const hidden of [
    'Save / Load', 'Atmosphere', 'Terrain shape', 'Ground', 'Water', 'Game / debug',
  ]) {
    assert.ok(!titles.includes(hidden), `online still shows "${hidden}" — this is the desync risk`);
  }
});

// --- vs-AI: Save/Load is back -----------------------------------------------

test('multiplayer-ai shows Save/Load, Performance, Camera and Sound', () => {
  assert.deepEqual(titlesFor('multiplayer-ai'), ['Save / Load', 'Performance', 'Camera', 'Sound']);
});

test('multiplayer-ai still hides the genuinely world-shaping and account groups', () => {
  const titles = titlesFor('multiplayer-ai');
  for (const hidden of ['Atmosphere', 'Terrain shape', 'Ground', 'Water', 'Game / debug']) {
    assert.ok(!titles.includes(hidden), `vs-AI still shows "${hidden}"`);
  }
});

test("Save/Load's own controls are unchanged between sandbox and vs-AI — the fix only toggles group visibility", () => {
  const full = groupsFor('sandbox').find((g) => g.title === 'Save / Load');
  const restricted = groupsFor('multiplayer-ai').find((g) => g.title === 'Save / Load');
  assert.deepEqual(
    restricted.controls.map((c) => c.type),
    full.controls.map((c) => c.type),
  );
});

// --- shared across both skirmish modes --------------------------------------

for (const mode of ['multiplayer-online', 'multiplayer-ai']) {
  test(`${mode}'s Performance group is exactly High-quality shadows`, () => {
    const group = groupsFor(mode).find((g) => g.title === 'Performance');
    assert.equal(group.controls.length, 1);
    assert.equal(group.controls[0].label, 'High-quality shadows');
  });
}

test('Camera and Sound keep every one of their existing controls in a skirmish — the fix hides groups, not controls within a kept group', () => {
  const full = groupsFor('sandbox');
  const restricted = groupsFor('multiplayer-online');

  for (const title of ['Camera', 'Sound']) {
    const fullLabels = full.find((g) => g.title === title).controls.map((c) => c.label);
    const restrictedLabels = restricted.find((g) => g.title === title).controls.map((c) => c.label);
    assert.deepEqual(restrictedLabels, fullLabels, `${title}'s own controls changed under restriction`);
  }
});

// --- the chooser hint -------------------------------------------------------

test('settingsHintFor describes what each mode actually shows', () => {
  assert.equal(settingsHintFor({ mode: 'multiplayer-online' }), 'Shadows, camera, sound');
  assert.equal(settingsHintFor({ mode: 'multiplayer-ai' }), 'Save/load, shadows, camera, sound');
  assert.equal(settingsHintFor({ mode: 'sandbox' }), 'Terrain, atmosphere, camera');
  assert.equal(settingsHintFor(undefined), 'Terrain, atmosphere, camera');
});
