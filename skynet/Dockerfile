# ─── Skynet — one image, two roles ─────────────────────────────────────────
# Multi-stage build (Architecture Brief §05): build the web SPA + server, then
# the runtime image serves the static SPA *and* the API/WS from one process.

FROM node:22-slim AS base
# git is a hard runtime dependency, not a build tool: the server shells out to it
# for clone-on-connect, per-agent worktrees, the merge engine, and previews. The
# slim image omits it, so without this the GCP/container server fails every git
# op with `spawn git ENOENT`. Installed in `base` so the runtime stage (FROM base)
# inherits it in a single cached layer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
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
