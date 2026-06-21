// Environment config — see .env.example for the full list.

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? "development",
  store: (process.env.STORE ?? "memory") as "memory" | "postgres",
  bus: (process.env.BUS ?? "memory") as "memory" | "redis",
  runner: (process.env.RUNNER ?? "mock") as "mock" | "claude" | "codex" | "gemini" | "cursor" | "copilot",
  // Working directory for a real runner (the target repo / agent worktree).
  runnerCwd: process.env.SKYNET_RUNNER_CWD || undefined,
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  // When true, requests without a valid token are rejected (401).
  authRequired: process.env.AUTH_REQUIRED === "true",
  // Target repo the merge queue integrates into. Unset → merge engine disabled
  // (diff-approve just completes the agent, the Phase 0 behavior).
  integrationRepo: process.env.SKYNET_INTEGRATION_REPO || undefined,
  baseBranch: process.env.SKYNET_BASE_BRANCH || "main",
  // Optional check command run in the repo before a merge is committed.
  checkCmd: process.env.SKYNET_CHECK_CMD || undefined,
};

export const now = (): number => Date.now();
