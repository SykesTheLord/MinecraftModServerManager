# Build context is the repo root (docker-compose.yml sets `context: .`)
# because this image bundles the built web SPA alongside the API.
#
# Every install uses `npm ci` against the root package-lock.json (this is an
# npm-workspaces monorepo; the workspaces have no lockfiles of their own), so
# the image ships exactly the dependency versions that were tested locally.
# Node 24 is the current Active LTS.

ARG NODE_IMAGE=node:24-trixie-slim

# Toolchain in case better-sqlite3 has no prebuilt binary for this platform.
FROM ${NODE_IMAGE} AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/

FROM toolchain AS build
RUN npm ci
COPY server server
COPY web web
RUN npm run build

FROM toolchain AS prod-deps
RUN npm ci --omit=dev --workspace=server

FROM ${NODE_IMAGE}
WORKDIR /app
COPY server/package.json ./
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/server/dist ./dist
COPY --from=build /repo/web/dist ./public

# Which commit this image was built from (scripts/apply.sh passes it); shown in Settings → About.
ARG APP_COMMIT=unknown
ENV NODE_ENV=production APP_COMMIT=${APP_COMMIT}
EXPOSE 8080
CMD ["node", "dist/index.js"]
