import { defineConfig, loadEnv } from 'vite';
import { execSync } from 'node:child_process';

/**
 * Stamps every build with the git commit it was built from and when, so a
 * console log at startup can answer "am I running a stale version?" without
 * guessing from feel. Computed once here (build time), not at runtime in the
 * browser, since the browser has no git access and this only needs to be
 * true as of the build, not live.
 */
function commitHash() {
  try {
    // --dirty is deliberate: a build made from uncommitted changes should
    // say so, not silently claim to be the last real commit.
    return execSync('git rev-parse --short HEAD').toString().trim() +
      (execSync('git status --porcelain').toString().trim() ? '-dirty' : '');
  } catch {
    return 'unknown'; // no git available (e.g. a source tarball) — fail soft, not the whole build
  }
}

export default defineConfig(({ mode }) => {
  // loadEnv rather than process.env alone: Vite does not put .env values on
  // process.env, so without this the only way to point a dev build at a local
  // API server is to prefix every command with it. `.env` is gitignored (the
  // committed template is server/.env.example), so this stays a local override.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  return {
  define: {
    __APP_VERSION__: JSON.stringify(commitHash()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    // Where the API server lives (accounts, cloud saves, match relay). Baked
    // in at build time like the version stamp, since the frontend ships as a
    // static nginx image with no runtime config to read.
    //
    // Empty string is the deliberate default and means "no backend": the game
    // must stay fully playable — sandbox, AI matches, local saves — without
    // one. Only cloud saves and online multiplayer need this set.
    __API_URL__: JSON.stringify(env.VITE_API_URL ?? ''),
    // The main site is same-site with the API, so its session rides an
    // httpOnly cookie the page cannot read — strictly safer, and there is no
    // reason to trade it away where cookies work. Only the itch.io fork, which
    // browsers serve cross-site in a third-party iframe and therefore strip
    // the cookie from, turns this on. See src/net/api.js's USE_BEARER_AUTH.
    __USE_BEARER_AUTH__: JSON.stringify(env.VITE_USE_BEARER_AUTH === 'true'),
  },
  };
});
