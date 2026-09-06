// ─── Sentry status API ────────────────────────────────────────────────────
// One tiny read so Integrations can show whether the inbound Sentry webhook
// is actually wired up on this server — same "appConfigured" pattern
// ../github/routes.ts already returns from fetchGithub(). /api auth applies.

import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

export async function registerSentryStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/sentry/status", async () => ({ configured: !!config.sentryWebhookSecret }));
}
