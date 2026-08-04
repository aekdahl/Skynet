# ─── Skynet — one image, two roles ─────────────────────────────────────────
# Multi-stage build (Architecture Brief §05): build the web SPA + server, then
# the runtime image serves the static SPA *and* the API/WS from one process.

FROM node:22-slim AS base
# Runtime deps the slim image omits, both required because the server (and the
# app previews it spawns) shell out to them:
#   • git    — clone-on-connect, per-agent worktrees, the merge engine, previews.
#   • procps — provides `ps`. Live-preview spawns each app's `npm run dev`, and
#     common dev tooling (concurrently / ps-tree, nodemon, etc.) shells out to
#     `ps -o pid --ppid …` to manage child processes. Without it every such
#     preview dies with `spawn ps ENOENT`.
# Without these the container fails with `spawn git ENOENT` / `spawn ps ENOENT`.
# Installed in `base` so the runtime stage (FROM base) inherits them in one layer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates procps \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

FROM base AS build
# Lockfile + workspace manifests first for layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 8080
# The server auto-detects apps/web/dist and serves the SPA alongside /api + /ws.
CMD ["node", "apps/server/dist/index.js"]
