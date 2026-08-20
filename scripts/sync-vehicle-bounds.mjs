/**
 * Vendor the vehicle builder's slider ranges into the server.
 *
 * `server/Dockerfile` does `COPY src ./src` — the API image contains only
 * `server/src` and cannot import the repo-root `src/`. The server nonetheless
 * has to enforce the same stat bounds the editor shows, because it is the only
 * party that can enforce them fairly once a vehicle authored on one machine is
 * played on another.
 *
 * So the table is generated here rather than restated by hand, and
 * `tests/vehicle-bounds-sync.test.mjs` fails if the committed copy drifts from
 * `BUILDER_GROUPS`. Editing a slider range without re-running this is a test
 * failure, not a silently unenforced bound.
 *
 * Run: npm run sync:bounds
 */
import { writeFileSync } from 'node:fs';
import { deriveBounds } from '../src/builder/builderSchema.js';

export const GENERATED_PATH = 'server/src/vehicles/vehicleBounds.js';

export function renderBoundsModule(bounds = deriveBounds()) {
  const entries = Object.entries(bounds)
    .map(([path, { min, max }]) => `  '${path}': { min: ${min}, max: ${max} },`)
    .join('\n');
  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with \`npm run sync:bounds\` from the repo root. The source of
 * truth is BUILDER_GROUPS in src/builder/builderSchema.js;
 * tests/vehicle-bounds-sync.test.mjs fails if this copy drifts from it.
 *
 * Vendored rather than imported because server/Dockerfile copies only
 * server/src into the API image.
 */
export const VEHICLE_BOUNDS = {
${entries}
};
`;
}

// Only write when run directly, so the test can import the renderer.
if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(GENERATED_PATH, renderBoundsModule(), 'utf8');
  console.log(`wrote ${GENERATED_PATH}`);
}
