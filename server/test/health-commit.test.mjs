/**
 * `/health` reports the commit the running image was built from.
 *
 * This exists because of a deploy that looked successful and was not. A CSRF
 * fix sat merged on `main` while production kept serving the commit before it:
 * CapRover rebuilt from a stale ref, the API's `COPY src ./src` layer cache-hit
 * on unchanged content, and the old image was reused. Nothing the running
 * server said could have revealed that — the only way to establish which
 * commit was live was to read a stack trace's line number against `git show`.
 *
 * So the assertion here is narrow and behavioural: whatever the image was
 * built from must be *visible from outside the process*. A version stamp that
 * is only correct in development is the exact failure being fixed — production
 * is where it matters and is precisely where the old `git rev-parse` stamp
 * silently returned 'unknown', because node:20-alpine ships no git.
 *
 * `COMMIT_SHA` is read at module load, so each case has to import `index.js`
 * in a process where the env is already set. `node --test` gives each *file*
 * its own process, not each test, so the two cases are separated with
 * `import()` cache-busting query strings rather than by file.
 *
 * Needs the same env `config.js` demands at import (DATABASE_URL et al), but
 * touches no database: `/health` is deliberately dependency-free (see the
 * route's own comment) and `app.inject()` opens no socket.
 *
 * Run: node --test server/test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Boot the API with a given GIT_COMMIT_SHA and ask /health what it is.
 * The query string forces a fresh module instance so the module-scope
 * COMMIT_SHA is re-evaluated against the env set here.
 */
async function healthWith(sha, cacheBuster) {
  const previous = process.env.GIT_COMMIT_SHA;
  if (sha === undefined) delete process.env.GIT_COMMIT_SHA;
  else process.env.GIT_COMMIT_SHA = sha;
  try {
    const { build } = await import(`../src/index.js?commit-test=${cacheBuster}`);
    const app = await build();
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    return res;
  } finally {
    if (previous === undefined) delete process.env.GIT_COMMIT_SHA;
    else process.env.GIT_COMMIT_SHA = previous;
  }
}

test('/health reports the commit the image was built from', async () => {
  const res = await healthWith('deadbeef1234', 'set');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok', commit: 'deadbeef1234' });
});

test('/health still answers when no commit was baked in', async () => {
  // A missing version stamp is a diagnostic gap, never a reason to fail the
  // liveness probe — this is the endpoint an orchestrator polls, and a 500
  // here would take the app down over a cosmetic unknown.
  const res = await healthWith(undefined, 'unset');
  assert.equal(res.statusCode, 200, 'liveness must not depend on the version stamp');
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().commit, 'unknown');
});
