// ─── MCP servers module ───────────────────────────────────────────────────
// Per-workspace custom MCP server configs (roadmap "Tools via MCP"),
// encrypted at rest (same AES-256-GCM envelope as ../secrets, under
// SKYNET_MASTER_KEY) and resolved by the orchestrator into a run's
// StartSpec.mcpServers. A stored secret value is write-only over the API and
// never logged.

export type { McpServerStore, McpServerRecord } from "./types.js";
export { McpServerService, mcpServerService, McpServersDisabledError, UnknownMcpServerError, ReservedMcpServerNameError } from "./service.js";
export { registerMcpServerRoutes } from "./routes.js";
