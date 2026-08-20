# itch.io build

An independent copy of the game's frontend, packaged for upload to itch.io as
an HTML5 game. It talks to the same production API as the main site, so an
itch.io player signs in with the same account, sees the same cloud saves, and
joins the same matches.

Nothing outside this directory is involved in building it, and building it
cannot affect the deployed site.

## Build

```sh
cd itch.io
npm install
npm run zip     # build + package as control-and-conquer-itch.zip
```

Then upload `control-and-conquer-itch.zip` on itch.io and tick **"This file
will be played in the browser"**.

`npm run build` alone leaves the output in `dist/`. If you package by hand,
zip the *contents* of `dist/`, not the folder — itch.io looks for
`index.html` at the top level of the archive and shows "no index.html" if it
is one directory down.

`npm run dev` and `npm run preview` work as usual for checking it locally.

## What differs from the root build

Two things, both in `vite.config.js`:

- **`base: './'`** — itch.io serves an uploaded zip from a hashed path, not a
  domain root, so every asset URL has to be relative. The default base of
  `'/'` produces a page that loads and then 404s on its own script.
- **The API URL is a committed default** rather than a Docker build arg. The
  root build gets `VITE_API_URL` from `--build-arg`; there is no Dockerfile in
  this path and `.env` is gitignored, so the value is written into
  `vite.config.js` where it stays reproducible. Override per-build with
  `VITE_API_URL=… npm run build` — an empty string disables the backend, and
  the game stays playable in sandbox and AI matches without it.

Everything else — `src/`, `index.html`, `public/` — is a plain copy of the
repo root.

## Keeping up with the main game

This is a fork, not a build variant. Editing `src/` at the repo root does
**not** change anything here. To pull the latest game code down:

```sh
./sync-from-main.sh --dry-run   # see what would change
./sync-from-main.sh             # do it
```

It copies `src/`, `index.html` and `public/` one way, root → here, and never
touches this directory's own build config. It refuses to run over uncommitted
changes in `itch.io/`, because the copy would destroy them; commit or stash
first, or pass `--force` if you mean to discard them.

The corollary: a bug fixed here is not fixed at the root. Fix it at the root
and sync, unless the fix is genuinely itch-only.
