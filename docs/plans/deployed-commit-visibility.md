# Making the deployed commit visible

## What prompted this

A merged fix did not reach production, and it took two rounds of log forensics
to establish that — which is the actual defect this change addresses.

The sequence: PR #107 fixed a CSRF hook that was 500ing every
cookie-authenticated write (create/join/start match, logout, password reset,
saves). It merged to `main` as `c196ece`. Production was redeployed. Matches
still failed. The API log still showed:

```
TypeError: next is not a function
  at Object.csrfUnlessBearer (file:///app/src/auth/plugin.js:53:16)
```

The only way to work out what was actually running was to read that line
number against the repository:

- At `f4ee003` (the PR #106 merge), `plugin.js:53` is exactly
  `return app.csrfProtection(req, reply);` — the broken 2-arg call.
- On `c196ece` that decorator sits at line 67 and takes `(req, reply, done)`.

So production was serving `f4ee003`: **one commit behind**. CapRover had built
from a stale ref. Two further details corroborated it, and are worth recording
because they explain why the deploy *looked* successful:

- The API build was a 100% cache hit, including `Step 6/10 : COPY src ./src
  ---> Using cache`. A `COPY` only cache-hits on byte-identical content.
  `server/src/` is unchanged between `51b1b0b` and `f4ee003`, so building
  `f4ee003` legitimately reuses the entire previous image. The cache was
  correct; the input was old.
- The *frontend* rebuilt in the same deploy (new bundle hash). Not a
  contradiction: PR #106 changed root `src/`, so the frontend's broad
  `COPY . .` invalidated while the API's narrower `COPY src ./src` did not.
  One commit, two build contexts, two different cache outcomes.

None of that should have been necessary. A running server ought to be able to
say which commit it is.

## Why the version stamp that already existed did not help

`vite.config.js` has stamped builds with `git rev-parse --short HEAD` since
early on, logged to the browser console at startup, explicitly so a player
could answer "am I running a stale version?".

It has never worked in production. The build image is `node:20-alpine`, which
ships no git, so the `execSync` throws and the `catch` returns `'unknown'` —
on **every deployed build**. CapRover's own logs say so plainly:

```
Step 8/13 : RUN npm run build
> vite build
/bin/sh: git: not found
```

The fallback was written for "no git available (e.g. a source tarball)" — read
as the rare case. It was in fact the only case that mattered. The stamp was
correct exactly where it was not needed (development, where `git log` is right
there) and silent everywhere it was.

The API had no version marker at all: `/health` returned `{ status: 'ok' }`.

## The fix

CapRover already passes `CAPROVER_GIT_COMMIT_SHA` as a build arg on **every**
build, and both Dockerfiles were discarding it. The build logs had been saying
this the whole time:

```
[Warning] One or more build-args [CAPROVER_GIT_COMMIT_SHA ...] were not consumed
```

This matters for this deployment specifically: the CapRover GitHub-deploy
method has no UI field for custom build args (the root `Dockerfile` already
carries a comment about that, which is why `VITE_API_URL` is a baked default
rather than passed per-deploy). `CAPROVER_GIT_COMMIT_SHA` is injected
automatically, so it needs no configuration — nothing to set up on the
CapRover side.

Four small changes:

- **`server/Dockerfile`** — `ARG CAPROVER_GIT_COMMIT_SHA` →
  `ENV GIT_COMMIT_SHA`, declared *after* `COPY src ./src`. Placement is
  deliberate: an ARG/ENV whose value changes every commit invalidates every
  layer beneath it, and higher up it would re-run `npm install` — including
  argon2's compile-from-source — on every deploy. Nothing below that line is
  expensive.
- **`server/src/index.js`** — module-scope `COMMIT_SHA`, logged as
  `[version] commit <sha>` immediately before `Server listening at …` (where
  anyone reading a deploy log is already looking), and added to `/health`.
- **`Dockerfile`** — same ARG, passed into the build environment. No cache
  concern here: `COPY . .` above already invalidates on any repo change.
- **`vite.config.js`** — `commitHash()` falls back to
  `CAPROVER_GIT_COMMIT_SHA` before giving up on `'unknown'`. Git is still tried
  first, so development keeps the more informative `-dirty` suffix.

`unknown` is retained as the final fallback everywhere. A missing version stamp
is a diagnostic gap, never a reason to fail a liveness probe or a build.

## Verification

**`node --test server/test/*.test.mjs` — 5 pass** (2 new, 3 pre-existing CSRF).
The new tests assert the property that was missing: the commit is visible
*from outside the process*, via `app.inject('/health')`. `COMMIT_SHA` is read
at module load, so the two cases import `index.js` under cache-busting query
strings rather than relying on per-test process isolation (`node --test` gives
each *file* its own process, not each test).

**Two negative controls**, by surgical edit, each failing behaviourally:

| reverted | result |
|---|---|
| `/health` back to `{ status: 'ok' }` | both new tests fail |
| `COMMIT_SHA` stops reading the env | the "reports the commit" test fails |

**Frontend, built for real with git made to fail** (a stub `git` on `PATH`
exiting 127, reproducing alpine's `git: not found`):

- with `CAPROVER_GIT_COMMIT_SHA=feedface99` → the SHA is present in the emitted
  bundle;
- with no SHA → the bundle stamps `unknown`, reproducing today's production
  behaviour exactly.

`npm test` (root) — 500 pass, unchanged.

## Honest limits

- **The Docker images were not built.** This environment's egress proxy blocks
  Docker Hub blob downloads (403 on the registry CDN), so `node:20-alpine`
  cannot be pulled. The `ARG`/`ENV` plumbing is verified by the equivalent
  environment-variable behaviour tested directly in Node, plus code inspection
  of the Dockerfiles — **not** by a real image build.
- Consequently the layer-cache claim (that placing the API's `ENV` after
  `COPY src ./src` keeps `npm install` cached) is argued from Docker's
  documented invalidation rules, not demonstrated. Worth confirming on the
  first real deploy: the install step should still say `Using cache`.
- `/health` now exposes the commit publicly. Judged acceptable — the repository
  is the source of truth for what that commit contains, and this is the endpoint
  whose entire purpose is answering "what is this process?". Flagged rather
  than assumed.
- This makes a stale deploy *visible*. It does not prevent one. Why CapRover
  built a stale ref is still unestablished — with this in place, the next
  occurrence is a one-line check instead of an investigation.
- `itch.io/` deliberately not synced: that fork owns its own `vite.config.js`,
  is built by hand where git is available, and none of the files
  `sync-from-main.sh` copies (`src/`, `index.html`, `public/`) changed here.
