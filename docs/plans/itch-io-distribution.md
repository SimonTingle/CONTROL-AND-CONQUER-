# Shipping the frontend on itch.io

## The problem

The game should be playable from an itch.io page, alongside the existing
CapRover-deployed site, and an itch.io player should be a first-class player:
same account, same cloud saves, able to join a match against someone who came
in from the website. So the itch.io build is not an offline demo — it is the
same frontend talking to the same API, packaged differently.

"Packaged differently" is the whole of the technical problem, and it is
smaller than it sounds. It comes down to two facts about how itch.io serves an
HTML5 game.

## Evidence: what itch.io actually requires

1. **An uploaded zip is served from a hashed subpath**, not a domain root —
   something of the form `html-classic.itch.zone/html/<id>/index.html`, inside
   a sandboxed iframe. Vite's default `base` of `'/'` makes the built
   `index.html` reference `/assets/index-<hash>.js`. At that URL the leading
   slash resolves to the CDN root, not the game, so the page loads and then
   404s on its own script — a black canvas with two failed requests in the
   console and nothing else wrong. `base: './'` is the fix, and the built
   output confirms it:

   ```
   src="./assets/index-B-SrtWQ9.js"
   href="./assets/index-aLHLiXWV.css"
   url(../landscape-game-photo.png)     # from dist/assets/index-*.css
   ```

   That third line was the one worth checking rather than assuming.
   `src/ui/style.css:957` references the background image as
   `url('/landscape-game-photo.png')` — an absolute path into the public
   directory. Vite rewrites public-directory URLs to be base-relative, and
   under a relative base it resolves them *from the emitted stylesheet's own
   location* (`dist/assets/`), which is why `../` appears and is correct. No
   source change was needed for it. If a future change adds another absolute
   asset URL somewhere Vite does not rewrite (an inline `style` attribute, a
   string built at runtime), it will break only on itch.io and only for that
   asset.

2. **`index.html` must be at the top level of the zip.** Zipping the `dist`
   folder rather than its contents produces an upload that itch.io rejects
   with "no index.html". The `npm run zip` script does the `cd dist` so this
   is not a thing anyone has to remember.

The API URL needed one further decision. The root build takes `VITE_API_URL`
as a Docker `--build-arg` with a default baked into the root `Dockerfile`.
There is no Dockerfile in this path — the zip is built from a checkout by
hand — and `.env` is gitignored, so neither of the root's two mechanisms
carries a value here. The default therefore lives in `itch.io/vite.config.js`,
committed, which is the only place it is reproducible. Verified present in the
built bundle.

## What was decided, and the alternative rejected

The itch.io build lives in `itch.io/` as an **independent copy** of `src/`,
`index.html` and `public/`, with its own `package.json` and `vite.config.js`.

The alternative was a build variant off the single existing `src/` — an
`npm run build:itch` with a second Vite config. It is less code and has no
duplication, and on the two requirements above it would work fine, since both
are pure build config. It was rejected on the requirement that this "should
not interfere with code in the main repository": a shared source tree means
every future itch-specific tweak is a conditional inside code that the
deployed site also runs, and the failure mode of getting one wrong is breaking
production to fix an itch.io bug. A fork cannot do that.

The cost of a fork is the obvious one, and it is real: a bug fixed in one tree
is not fixed in the other, and copies drift silently. `sync-from-main.sh`
narrows that cost without pretending to eliminate it — one command,
root → `itch.io/` only, covering exactly `src/`, `index.html` and `public/`.

Three things about it were deliberate:

- **It is an allow-list, not a mirror with exclusions.** Only those three
  paths are ever copied, so nothing the fork owns — its build config, its
  README, the script itself — can be reached by a sync even by accident.
- **It refuses to run over uncommitted changes in `itch.io/`.** A copy-based
  sync has exactly one way to hurt you, and that is it; the overwritten work
  is unrecoverable, so this is a refusal with an exit code rather than a
  warning that scrolls past. `--force` is there for when discarding is the
  intent, and `--dry-run` always runs.
- **It uses `diff` and `cp`, not `rsync`.** `rsync` was the first
  implementation and is the natural tool, but it is absent from most slim
  Linux images (including the one this was written in), and the repo's tooling
  is otherwise dependency-free. `diff -rq` supplies the change listing;
  delete-then-copy supplies the removal propagation that a bare `cp -R` lacks.

## Verification

Built and inspected rather than assumed:

- `cd itch.io && npm install && npm run build` succeeds; `dist/index.html`
  references its assets relatively, and the production API URL is present in
  the emitted bundle (both greps shown above).
- `sync-from-main.sh` was exercised against a scratch change at the root: a
  modified file, a file added upstream, and a stale file existing only in the
  fork. The dry run listed all three with the right direction, the real run
  propagated the modification and the addition and deleted the stale file, and
  a second dry run then reported "up to date". The refusal path was confirmed
  to exit 1 with `itch.io/` dirty.
- Root `npm test`: 94 pass, 2 fail (`match-client-protocol`, `match-room`).
  Those two fail identically with this branch's changes stashed — they are
  pre-existing and unrelated. Root `npm run build` succeeds.

**Not verified:** the actual upload. The zip has not been put on itch.io, so
"itch.io accepts this archive and the game runs in its iframe" rests on the
two requirements above being the complete set, not on having seen it work.
The iframe sandbox in particular is untested against the game's pointer-lock
and fullscreen handling, and against the API's CORS policy for the
`html-classic.itch.zone` origin — that last one is a plausible next failure
and would be fixed on the server, not here.
