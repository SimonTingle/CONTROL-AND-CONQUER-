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
# container-runtime env var. Defaults to empty so every other build path
# (local docker build, CI, a plain docker run) is unaffected and the game
# stays fully playable with no backend configured.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
