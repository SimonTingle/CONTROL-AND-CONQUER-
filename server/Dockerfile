# API server (accounts, cloud saves, match relay). Deployed as its own CapRover
# app, separate from the root Dockerfile's static nginx frontend image.
#
# IMPORTANT: no HEALTHCHECK instruction here, for the same reason the frontend
# image omits one. CapRover runs its own HTTP readiness probe against the app's
# configured Container HTTP Port; an additional Docker-level HEALTHCHECK has
# been observed to fight CapRover's deploy-wait logic and put the service into
# an infinite Swarm restart loop (recreated every few seconds, never reaching
# "healthy", persistent 502) even when the container itself starts cleanly.
# The /health and /health/ready routes exist for manual checks and for a
# separate non-CapRover Swarm deploy — just don't wire them up as a
# Docker HEALTHCHECK when CapRover is the deploy target.
#
# ALSO IMPORTANT: this app terminates WebSockets (/ws/match/:id, the lockstep
# match relay). CapRover's nginx does not forward the Upgrade/Connection
# headers unless "Websocket Support" is ticked in the app's HTTP Settings —
# without it every connection attempt arrives as an ordinary GET and the route
# answers 426 (it used to answer a bare, bodyless 404, which is why this note
# exists). Nothing else about the app misbehaves: REST, auth and saves all work
# normally, so the only symptom is that online matches never connect.

FROM node:20-alpine

# argon2 ships prebuilt binaries for common platforms but falls back to
# compiling from source; without these the install fails on alpine.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/index.js"]
