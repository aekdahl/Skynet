// ─── Preview source resolution ────────────────────────────────────────────
// Where does an agent's branch live so we can build it? In priority order:
//   1. a real per-branch git WORKTREE cut from the integration repo (the true
//      "sandboxed per-branch" source) — checked out detached, cleaned up after;
//   2. a per-agent directory under SKYNET_PREVIEW_SOURCE_ROOT/<agentId>;
//   3. a single shared SKYNET_PREVIEW_SOURCE_DIR (handy for local demos).
// Returns null when none apply (the builder then publishes a "no source" page).

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { previewConfig } from "./config.js";

const exec = promisify(execFile);

export interface ResolvedSource {
  dir: string;
  kind: "worktree" | "root" | "shared";
  cleanup: () => Promise<void>;
}

const noop = async () => {};

/** Materialize the agent's branch as a buildable directory, or null. */
export async function resolveSource(agentId: string, branch: string): Promise<ResolvedSource | null> {
  // 1. Real per-branch worktree from the integration repo.
  const repo = config.integrationRepo;
  if (repo) {
    try {
      // Only proceed if the branch actually exists in the repo.
      await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `${branch}^{commit}`], { timeout: 10_000 });
      const dir = mkdtempSync(join(tmpdir(), `skynet-preview-${agentId}-`));
      await exec("git", ["-C", repo, "worktree", "add", "--detach", "--force", dir, branch], { timeout: 30_000 });
      return {
        dir,
        kind: "worktree",
        cleanup: async () => {
          try {
            await exec("git", ["-C", repo, "worktree", "remove", "--force", dir], { timeout: 15_000 });
          } catch {
            await rm(dir, { recursive: true, force: true });
          }
        },
      };
    } catch {
      // Branch missing / git unavailable → fall through to directory sources.
    }
  }

  // 2. Per-agent source directory.
  if (previewConfig.sourceRoot) {
    const dir = join(previewConfig.sourceRoot, agentId);
    if (existsSync(dir)) return { dir, kind: "root", cleanup: noop };
  }

  // 3. Single shared source directory (demo/static).
  if (previewConfig.sourceDir && existsSync(previewConfig.sourceDir)) {
    return { dir: previewConfig.sourceDir, kind: "shared", cleanup: noop };
  }

  return null;
}
