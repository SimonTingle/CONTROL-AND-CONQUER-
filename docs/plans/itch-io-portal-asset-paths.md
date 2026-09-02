# The itch.io portal showed a broken logo (and, less visibly, no background)

## Report

User's own tree listing showed `control-conquer-font.png`/`.jpeg` and the two
game photos present, byte-identical, in both `itch.io/public/` and
`itch.io/dist/` — yet a screenshot of the running game showed the browser's
native broken-image placeholder (a bordered box with the `alt="Control &
Conquer"` text and a small broken-image icon) where the logo should be.

## Root cause

`portalScreen.js`'s logo `<img>` and `style.css`'s `#portal` background both
referenced their `public/`-served assets with a root-absolute path
(`/control-conquer-font.png`, `url('/landscape-game-photo.png')`). Vite does
not rewrite these — root-absolute references to `public/` are passed through
untouched regardless of the `base` config, by design, because they're meant
to resolve against wherever the site's actual root is.

That's fine for the root deployment (nginx serves the built `dist/` at the
domain root, so `/foo.png` is correct). It's wrong for itch.io: uploaded
HTML5 zips are served from a hashed non-root path — the exact thing
`itch.io/vite.config.js`'s own `base: './'` comment already documents, for
the assets Vite *does* rewrite (the `<script>`/`<link>` tags it emits). A
hardcoded `/foo.png` string in application code is invisible to that
mechanism and 404s against the real site's actual root instead of the
game's own directory.

Confirmed by grep against the built bundle
(`itch.io/dist/assets/index-*.js`) before any fix: it literally contained
`t.src="/control-conquer-font.png"` and
`url('/landscape-game-photo.png'` — present in the JS output exactly as
written in source, not adjusted for `base`.

## Fix

- `portalScreen.js`: `logo.src = \`${import.meta.env.BASE_URL}control-conquer-font.png\`;`
  — `BASE_URL` is `/` for the root build and `./` for itch.io, so simple
  concatenation is correct in both without a special case.
- The CSS background needed a different approach: `url()` can't read
  `import.meta.env`, so the path is now set as a `--portal-bg-url` custom
  property from JS instead of hardcoded in `style.css`. The first attempt at
  this used the same `BASE_URL`-relative string
  (`url('./landscape-game-photo.png')`) and was itself wrong — a relative
  `url()` *inside a custom property* resolves against the stylesheet that
  substitutes it (`dist/assets/index-*.css`), not the document, so on
  itch.io it 404'd as `dist/assets/landscape-game-photo.png` instead of
  `dist/landscape-game-photo.png`. Caught by simulating itch.io's real
  hosting shape locally (copying the built `dist/` under a nested path and
  serving it with a plain HTTP server) and watching the network requests in
  a real browser — the earlier "does it look right" screenshot check would
  not have caught this, since the failure only exists at a non-root URL.
  Fixed by resolving to an absolute URL before setting the property:
  `new URL(\`${import.meta.env.BASE_URL}landscape-game-photo.png\`, document.baseURI).href`.

## Verification

- `npm run build` (root) and the `itch.io` fork's build both pass.
- Grepped the built JS in both bundles to confirm `BASE_URL` concatenation
  resolved to the right literal (`/control-conquer-font.png` at root,
  `./control-conquer-font.png` for itch.io) before runtime, and to confirm
  the background fix uses `new URL(..., document.baseURI)` rather than a bare
  relative string.
- Reproduced the actual reported symptom: served the itch.io `dist/` output
  from `http://localhost:5299/some/nested/path/index.html` (simulating
  itch.io's real non-root hosting) with Playwright, watching for failed
  requests. Before the `document.baseURI` fix this still showed a 404 for
  `.../assets/landscape-game-photo.png`; after it, zero asset failures (the
  only failed request left is the unrelated auth API call, blocked by this
  environment's network sandboxing) and `.portal-logo` reports
  `complete && naturalWidth > 0`. Screenshot confirms the logo and
  background render correctly.
- `npm test`: 527/527, unaffected (no coverage exists for asset-path
  resolution — this is a pure asset-loading bug with no unit-testable
  surface without a real browser).

## Not investigated

`portrait-game-photo.png` is present in `public/` but has no reference
anywhere in `src/` — apparently unused, left alone since it's outside what
was reported.
