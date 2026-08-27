// ─── Static SPA serving ───────────────────────────────────────────────────
// One image, two roles (Architecture Brief §05): the server serves the built
// web SPA alongside the API/WS. Only active when a build is present (i.e. in
// the Docker image or after `pnpm --filter @skynet/web build`); in dev the SPA
// is served by Vite, so this is skipped.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerStatic(app: FastifyInstance): Promise<boolean> {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = apps/server/dist → ../../web/dist = apps/web/dist
  const webDist = process.env.WEB_DIST ?? join(here, "../../web/dist");
  if (!existsSync(join(webDist, "index.html"))) return false;

  await app.register(fastifyStatic, { root: webDist });

  // SPA fallback — serve index.html for non-API, non-WS routes. /v1 (the
  // OpenAI-compat + REST interop surface) is a JSON API like /api — an
  // unmatched path under it should 404 as JSON, not silently serve the SPA
  // shell to a programmatic client expecting an error body.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws") || req.url.startsWith("/v1")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
  return true;
}
