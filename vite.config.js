import { defineConfig } from 'vite';
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

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(commitHash()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
