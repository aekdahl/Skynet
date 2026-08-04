// ─── GitHub integration module ────────────────────────────────────────────
// A workspace connects via a GitHub App installation; the orchestrator pushes
// agent branches and opens PRs through the GitProvider, gated by a server-side
// safety preflight. See docs/github-integration.md for the full contract.

export type { GitProvider, GithubConnectionStore, PushRequest, PushResult, SafetyViolation } from "./types.js";
export { evaluateSafety, requiresApproval } from "./safety.js";
export { GithubService, githubService, configureGithub } from "./service.js";
export { registerGithubRoutes } from "./routes.js";
export { parseRepoRef } from "./repo-ref.js";
