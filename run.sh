#!/usr/bin/env bash
# Local dev runner. Installs deps if needed and starts the Vite dev server.
#
# Usage:
#   ./run.sh           # dev server on http://localhost:5173
#   ./run.sh build      # production build into dist/
#   ./run.sh preview    # serve the production build locally (closest thing to prod)
#   ./run.sh docker      # build the CapRover/Swarm image and run it locally on :8080

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

mode="${1:-dev}"

ensure_deps() {
  if [ ! -d node_modules ]; then
    echo "Installing dependencies..."
    npm install
  fi
}

case "$mode" in
  dev)
    ensure_deps
    exec npm run dev -- --host
    ;;
  build)
    ensure_deps
    exec npm run build
    ;;
  preview)
    ensure_deps
    npm run build
    exec npm run preview -- --host
    ;;
  docker)
    echo "Building image procedural-terrain-game:local ..."
    docker build -t procedural-terrain-game:local .
    echo "Running on http://localhost:8080 (container port 80, CapRover's default) ..."
    exec docker run --rm -p 8080:80 procedural-terrain-game:local
    ;;
  *)
    echo "Unknown mode: $mode" >&2
    echo "Usage: $0 [dev|build|preview|docker]" >&2
    exit 1
    ;;
esac
