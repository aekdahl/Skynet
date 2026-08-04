// ─── Task ↔ source-of-truth write-back ──────────────────────────────────────
// One-way sync: when a task IMPORTED from a source of truth (Task.source) changes
// state, reflect it in the source. Driven off the `task.upserted` bus event — the
// single choke point every status-change path funnels through (human drag,
// complete/merge, the autonomy loop) — so one subscriber covers them all.
//
// Opt-in per project (Project.syncSourceStatus, off by default — writing back is
// outward-facing). Best-effort: a failure is logged, never blocks the transition.
// Phase 1 = GitHub issues; the `SyncSink` shape is the seam for repo-file /
// external adapters (see docs/task-source-sync.md).

import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Task, TaskState } from "@skynet/shared";
import type { Bus } from "./bus.js";
import type { Store } from "./store/store.js";
import { githubService } from "./github/index.js";
import { repoFileChecked, setChecklistItem } from "./tasks/checklist.js";

/** PURE: the GitHub-issue write-back for a state transition — a comment and/or an
 *  issue open/closed flip. `{}` when the transition needs nothing. Kept pure so
 *  the mapping is unit-tested without a live GitHub. */
export function githubIssuePlan(from: TaskState, to: TaskState): { comment?: string; state?: "open" | "closed" } {
  if (to === from) return {};
  if (to === "review") return { comment: "🔭 Skynet moved this to **review** — a change is up for approval." };
  if (to === "done") return { comment: "✅ Skynet marked this **done**.", state: "closed" };
  if (from === "done") return { comment: "↩️ Skynet reopened this — it moved back out of done.", state: "open" };
  return {}; // intermediate moves (backlog↔triage↔todo↔ongoing) don't touch the issue
}

export interface SyncDeps {
  store: Store;
  log?: (msg: string) => void;
}

/** Subscribe to task changes and write status back to each task's source. Returns
 *  an unsubscribe fn. Single-tenant: watches the default workspace's channel. */
export function startTaskSourceSync(bus: Bus, deps: SyncDeps): () => void {
  const lastState = new Map<string, TaskState>();
  return bus.subscribe(DEFAULT_WORKSPACE, (ev) => {
    if (ev.type !== "task.upserted") return;
    const task = ev.task;
    const prev = lastState.get(task.id);
    lastState.set(task.id, task.state);
    // Only act on a real transition of a sourced task (first sighting just seeds).
    if (prev === undefined || prev === task.state || !task.source) return;
    void writeBack(task, prev, task.state, deps).catch((e) =>
      deps.log?.(`[task-sync] ${task.id} write-back failed: ${(e as Error).message}`),
    );
  });
}

async function writeBack(task: Task, from: TaskState, to: TaskState, deps: SyncDeps): Promise<void> {
  const project = await deps.store.getProject(task.projectId);
  if (!project?.syncSourceStatus) return; // opt-in per project
  const src = task.source;
  if (!src) return;
  const cred = project.githubCredentialId; // write under the project's GitHub account

  // Phase 1 — GitHub issue: comment / close / reopen.
  if (src.kind === "github_issue") {
    const plan = githubIssuePlan(from, to);
    if (!plan.comment && !plan.state) return;
    if (plan.comment) await githubService.commentIssue(task.workspaceId, src.repo, src.number, plan.comment, cred);
    if (plan.state) await githubService.setIssueState(task.workspaceId, src.repo, src.number, plan.state, cred);
    deps.log?.(`[task-sync] ${src.repo}#${src.number} ← task ${task.id} is now ${to}`);
    return;
  }

  // Phase 2 — repo file: flip the linked `- [ ]` checklist item and commit it
  // (single-file Contents-API commit). GitHub-repo-backed projects only for now.
  if (src.kind === "repo_file") {
    const checked = repoFileChecked(from, to);
    if (checked === null) return;
    if (!project.repo) return; // needs a GitHub repo to commit the edit
    const file = await githubService.getRepoFileWithSha(task.workspaceId, project.repo, src.path, cred);
    if (!file) {
      deps.log?.(`[task-sync] ${src.path} not found — skipped`);
      return;
    }
    const next = setChecklistItem(file.content, src.anchor, checked);
    if (next === null) {
      deps.log?.(`[task-sync] ${src.path}: no checklist item "${src.anchor}" — skipped`);
      return;
    }
    await githubService.commitRepoFile(
      task.workspaceId,
      project.repo,
      src.path,
      next,
      file.sha,
      `Skynet: ${checked ? "check off" : "reopen"} "${src.anchor}"`,
      cred,
    );
    deps.log?.(`[task-sync] ${src.path} ← "${src.anchor}" ${checked ? "checked" : "unchecked"}`);
    return;
  }
}
