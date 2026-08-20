#!/usr/bin/env bash
#
# Pull the main frontend's source down into this itch.io fork.
#
# This directory is a deliberate fork, not a build variant: it has its own
# package.json and its own vite.config.js, and nothing keeps it in step with
# the repo root automatically. That is the trade the fork buys — the itch.io
# build can diverge without any risk to the deployed site — and this script is
# the other half of it, so "pick up the latest game code" is one command
# instead of a manual file hunt.
#
# It copies one way only: root -> itch.io. It never writes to the root, and it
# never touches this directory's own build config.
#
#   ./sync-from-main.sh --dry-run    show what would change, write nothing
#   ./sync-from-main.sh              do it
#   ./sync-from-main.sh --force      do it even with uncommitted changes here
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Paths copied from the root, each replacing its counterpart here wholesale.
# This is an allow-list rather than a whole-directory mirror with exclusions,
# so nothing this fork owns — package.json, vite.config.js, README.md,
# .gitignore, .env, this script, dist/, node_modules/ — can be reached by a
# sync even by accident.
SYNC=(src index.html public)

DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# A copy-based sync has exactly one way to hurt you: silently overwriting edits
# you made here and had not yet committed. Refuse rather than warn — a warning
# scrolls past, and the work is unrecoverable once the copy has run.
if [ "$FORCE" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  if [ -n "$(git -C "$ROOT" status --porcelain -- "$HERE" 2>/dev/null)" ]; then
    echo "refusing to sync: itch.io/ has uncommitted changes." >&2
    echo "commit or stash them first, or re-run with --force to discard them." >&2
    echo "run with --dry-run to see what a sync would overwrite." >&2
    exit 1
  fi
fi

# diff + cp rather than rsync: rsync is not installed everywhere (it is absent
# from most slim Linux images), and this repo's tooling is otherwise
# dependency-free. `diff -rq` gives us the change listing for free, and the
# copy is a delete-then-copy so that a file removed at the root does not
# linger here — the one thing a plain `cp -R` would get wrong.
changed=0
for path in "${SYNC[@]}"; do
  if [ ! -e "$ROOT/$path" ]; then
    echo "skipping $path — not present at the repo root" >&2
    continue
  fi

  if [ -e "$HERE/$path" ]; then
    out="$(diff -rq "$HERE/$path" "$ROOT/$path" 2>&1 || true)"
  else
    out="new: $path"
  fi

  [ -z "$out" ] && continue
  changed=1
  # Reword diff's "Only in <root>" / "Only in <here>" into the direction the
  # sync actually goes, which is the part that matters when reading this.
  # $HERE is inside $ROOT, so its rule has to come first or every line here
  # matches the root rule and gets reported as an upstream addition.
  echo "$out" \
    | sed -e "s|^Only in $HERE/\{0,1\}\(.*\): \(.*\)$|deleted here:   \1/\2|" \
          -e "s|^Only in $ROOT/\{0,1\}\(.*\): \(.*\)$|added upstream: \1/\2|" \
          -e "s|^Files .* and $ROOT/\(.*\) differ$|updated:        \1|" \
          -e "s|: /|: |"

  if [ "$DRY_RUN" -eq 0 ]; then
    rm -rf "${HERE:?}/$path"
    cp -R "$ROOT/$path" "$HERE/$path"
  fi
done

if [ "$changed" -eq 0 ]; then
  echo "up to date with the repo root — nothing to copy."
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo
  echo "dry run — nothing was written."
  exit 0
fi

cat <<'EOF'

Synced. src/, index.html and public/ here are now byte-identical to the repo
root; any itch-only edits that lived in them are gone. This fork's build
config was not touched.

Next: cd itch.io && npm run build (or npm run zip), and check the game still
loads before uploading.
EOF
