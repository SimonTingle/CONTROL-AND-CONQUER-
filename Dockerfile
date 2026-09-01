# Static Vite/Three.js build, served by nginx. Suitable for CapRover and for a
# plain Docker Swarm stack deploy of the same image.
#
# IMPORTANT: no HEALTHCHECK instruction here. CapRover does its own HTTP
# readiness probe against the app's configured "Container HTTP Port" — an
# additional Docker-level HEALTHCHECK has been observed to fight CapRover's
# deploy-wait logic and cause an infinite Swarm task restart loop (service
# recreated every few seconds, never reaches "healthy", persistent 502) even
# though the container itself starts cleanly every time. If you need a health
# endpoint for a separate non-CapRover Swarm stack, add HEALTHCHECK there, not
# in this image.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Baked in at build time — Vite's define constants have no runtime config
# file to read later, so this has to be an image build-time input, not a
# container-runtime env var.
#
# Defaults to the live production API rather than empty: this CapRover
# instance's GitHub-deploy method (Method 3) has no UI field for passing
# --build-arg through to the build, so the value actually used in production
# is whatever this default is, not something set per-deploy. Override with
# --build-arg VITE_API_URL=... for a build that should stay backend-less
# (e.g. testing the offline path, or a different environment's own server).
ARG VITE_API_URL="https://control-conquer-api.apps.simontingle.com"
ENV VITE_API_URL=$VITE_API_URL

# The commit this build came from, for vite.config.js's version stamp.
#
# node:20-alpine has no git, so `git rev-parse` inside the build always fails
# and every deployed bundle used to stamp itself 'unknown' — see the
# `/bin/sh: git: not found` line in any CapRover build log. CapRover injects
# CAPROVER_GIT_COMMIT_SHA on every build (no UI field needed, which matters
# here: the GitHub-deploy method has none), so passing it through is what makes
# the browser console line name a real commit.
#
# Unlike the API image, there is nothing to protect from cache invalidation by
# placing this later: `COPY . .` above already busts on any repo change.
ARG CAPROVER_GIT_COMMIT_SHA=""
ENV CAPROVER_GIT_COMMIT_SHA=$CAPROVER_GIT_COMMIT_SHA

RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
