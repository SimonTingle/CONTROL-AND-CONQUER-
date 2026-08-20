import { defineConfig, loadEnv } from 'vite';
import { execSync } from 'node:child_process';

/**
 * Build config for the itch.io distribution of the frontend.
 *
 * This is a near-copy of the root vite.config.js. It is deliberately a
 * separate file rather than a shared one: the root build ships a static nginx
 * image served from a domain root, and this build ships a zip that itch.io
 * unpacks at an arbitrary URL prefix inside a sandboxed iframe. The two have
 * genuinely different requirements, and `sync-from-main.sh` never overwrites
 * this file for that reason.
 */

function commitHash() {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim() +
      (execSync('git status --porcelain').toString().trim() ? '-dirty' : '');
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  return {
    // The one build difference that matters for itch.io. Uploaded HTML5 zips
    // are served from a hashed per-project path (…/index.html under some
    // directory that is not the domain root), so every emitted asset URL has
    // to be relative. With the default base of '/' the page loads and then
    // 404s on every script and stylesheet.
    base: './',

    define: {
      __APP_VERSION__: JSON.stringify(commitHash()),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      // Same production API as the main site: accounts, cloud saves and the
      // match relay are shared, so an itch.io player and a web player are on
      // the same backend.
      //
      // Unlike the root config this defaults to the live URL rather than ''.
      // The root build gets its value from a Docker --build-arg; there is no
      // Dockerfile in this path — the zip is built from a checkout by hand —
      // and `.env` is gitignored, so a committed default is the only way the
      // shipped value is reproducible. Override for a local or backend-less
      // build with VITE_API_URL=… npm run build (empty string disables the
      // backend entirely; the game stays playable in sandbox and AI matches).
      __API_URL__: JSON.stringify(
        env.VITE_API_URL ?? 'https://control-conquer-api.apps.simontingle.com',
      ),
    },
  };
});
