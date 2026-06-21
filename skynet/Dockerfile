# ─── Skynet — one image, two roles ─────────────────────────────────────────
# Multi-stage build (Architecture Brief §05): build the web SPA + server, then
# the runtime image serves the static SPA *and* the API/WS from one process.

FROM node:22-slim AS base
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
