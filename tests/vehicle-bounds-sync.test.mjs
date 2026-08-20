/**
 * The vendored server copy of the vehicle bounds must match the editor's.
 *
 * The server enforces stat bounds on defs it hands to a match, but it cannot
 * import src/builder/builderSchema.js — server/Dockerfile copies only
 * server/src into the API image. So the table is generated and committed, and
 * this is what stops the copy drifting: change a slider range without running
 * `npm run sync:bounds` and the bound is silently unenforced on the server
 * while still being shown in the editor.
 *
 * Run: node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveBounds } from '../src/builder/builderSchema.js';
import { renderBoundsModule, GENERATED_PATH } from '../scripts/sync-vehicle-bounds.mjs';
import { VEHICLE_BOUNDS } from '../server/src/vehicles/vehicleBounds.js';

test('the committed server bounds match the editor schema', () => {
  assert.deepEqual(VEHICLE_BOUNDS, deriveBounds());
});

test('the committed file is exactly what the generator would write', () => {
  // Not the same check: the one above compares parsed values, this one
  // compares bytes, so a hand-edit that happens to preserve the values (or a
  // stale header) is still caught.
  assert.equal(readFileSync(GENERATED_PATH, 'utf8'), renderBoundsModule());
});

test('the bounds table is not empty — a generator that silently wrote nothing would pass the others', () => {
  assert.ok(Object.keys(VEHICLE_BOUNDS).length > 20);
});
