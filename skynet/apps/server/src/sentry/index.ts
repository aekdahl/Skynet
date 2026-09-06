// ─── Sentry integration module ────────────────────────────────────────────
// The Sentry half of roadmap "Tools via MCP" — an inbound webhook (new/
// regressed issue → task); see docs/integrations-catalog.md. Pairs with a
// custom Sentry MCP server (../mcp-servers) an operator grants a project so
// the agent that picks up the resulting task can act back into Sentry.

export { registerSentryWebhookRoutes, parseSentryWebhook } from "./webhook.js";
export type { SentryIssueSignal } from "./webhook.js";
export { registerSentryStatusRoutes } from "./routes.js";
