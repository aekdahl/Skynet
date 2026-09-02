// ─── Compliance evidence pack — report generation ──────────────────────────
// Builds a ComplianceReport for a chosen scope entirely from data that
// already exists — the tamper-evident AuditRecord trail (hub.ts's
// recordAudit), TaskRun/Task/Project lookups for context, and Task.reviewVerdict
// for auto-review attribution. No new decision-recording path: this reads
// history, it never writes it.

import type {
  AuditRecord,
  ComplianceApproverType,
  ComplianceReport,
  ComplianceReportEntry,
  GenerateComplianceReportRequest,
  Task,
  TaskRun,
} from "@skynet/shared";
import { now } from "../config.js";
import type { Store } from "../store/store.js";

/** AuditRecord.payload's known shape (best-effort narrowing — see hub.ts's
 *  recordAudit call sites for what's actually written; unknown fields read as
 *  null/undefined rather than throwing, matching audit.tsx's own `payloadOf`). */
interface AuditPayload {
  guidance?: string | null;
  kind?: string | null;
  title?: string | null;
  why?: string | null;
  rationale?: string | null;
  risk?: string | null;
  diff?: { add?: number; del?: number; files?: string[] } | null;
  files?: string[] | null;
}

function payloadOf(p: unknown): AuditPayload {
  return (p ?? {}) as AuditPayload;
}

/** Only these HITL kinds represent an actual AI-authored CHANGE landing
 *  somewhere (as opposed to a command approval, a plan sign-off, a question,
 *  or an escalation) — everything the compliance report is about. Matched
 *  generically by kind name rather than an enum import, so a future merge-gate
 *  kind (e.g. a Feature-branch merge-up gate) is covered without an update here. */
function isChangeKind(kind: string | null | undefined): boolean {
  return kind === "diff" || kind === "merge" || (kind?.endsWith("-merge") ?? false);
}

/** Classify who/what actually approved something, from the raw `operatorId`
 *  an AuditRecord carries — TASK 21 also exposes this on `GET /api/audit`
 *  (see operations.ts#listAudit), not just the compliance evidence pack. */
export function classifyApprover(
  operatorId: string,
  task: Task | undefined,
): { approverType: ComplianceApproverType; policyDetail: string | null; reasonFromReviewer: string | null } {
  if (operatorId.startsWith("policy:")) {
    return { approverType: "policy", policyDetail: operatorId, reasonFromReviewer: null };
  }
  if (operatorId === "autonomy") {
    // The auto-review path resolves with by:"autonomy" and stashes the real
    // reviewer + reason on the task (orchestrator.ts#autoReview) — the audit
    // record alone can't tell you WHICH agent reviewed it or WHY.
    const v = task?.reviewVerdict;
    return {
      approverType: "agent-review",
      policyDetail: v ? `reviewed by ${v.by}` : "fleet agent auto-review",
      reasonFromReviewer: v?.reason ?? null,
    };
  }
  return { approverType: "human", policyDetail: null, reasonFromReviewer: null };
}

export interface BuildReportArgs {
  workspaceId: string;
  generatedBy: string;
  scope: GenerateComplianceReportRequest;
}

export async function buildComplianceReport(store: Store, args: BuildReportArgs): Promise<ComplianceReport> {
  const { workspaceId, generatedBy, scope } = args;
  const [audit, runs, tasks, projects] = await Promise.all([
    store.listAudit(workspaceId),
    store.listRuns(workspaceId),
    store.listTasks(workspaceId),
    store.listProjects(workspaceId),
  ]);
  const runById = new Map<string, TaskRun>(runs.map((r) => [r.id, r]));
  const taskByRunId = new Map<string, Task>(tasks.filter((t) => t.runId).map((t) => [t.runId as string, t]));
  const projectById = new Map(projects.map((p) => [p.id, p]));

  const scopeProject = scope.projectId ? projectById.get(scope.projectId) : undefined;

  const entries: ComplianceReportEntry[] = [];
  for (const rec of audit as AuditRecord[]) {
    if (rec.action !== "approve") continue; // "AI-authored change" = one that actually landed
    const payload = payloadOf(rec.payload);
    if (!isChangeKind(payload.kind)) continue;
    if (scope.runId && rec.runId !== scope.runId) continue;
    if (scope.from != null && rec.at < scope.from) continue;
    if (scope.to != null && rec.at > scope.to) continue;

    const run = runById.get(rec.runId);
    if (scope.projectId && run?.projectId !== scope.projectId) continue;

    const task = taskByRunId.get(rec.runId);
    const project = run?.projectId ? projectById.get(run.projectId) : undefined;
    const { approverType, policyDetail, reasonFromReviewer } = classifyApprover(rec.operatorId, task);
    const diff = payload.diff ?? null;
    const risk = payload.risk === "low" || payload.risk === "medium" || payload.risk === "high" ? payload.risk : null;

    entries.push({
      hitlId: rec.hitlId,
      runId: rec.runId,
      taskId: task?.id ?? null,
      taskText: task?.text ?? run?.name ?? null,
      projectId: run?.projectId ?? null,
      projectName: project?.name ?? null,
      branch: run?.branch ?? null,
      kind: payload.kind ?? "unknown",
      title: payload.title ?? rec.hitlId,
      why: payload.why ?? null,
      risk,
      decidedAt: rec.at,
      action: rec.action,
      approvedBy: rec.operatorId,
      approverType,
      policyDetail,
      reason: payload.guidance ?? payload.rationale ?? reasonFromReviewer ?? null,
      diffAdd: diff?.add ?? null,
      diffDel: diff?.del ?? null,
      diffFiles: payload.files ?? diff?.files ?? [],
    });
  }
  entries.sort((a, b) => a.decidedAt - b.decidedAt);

  const summary = {
    totalChanges: entries.length,
    humanApproved: entries.filter((e) => e.approverType === "human").length,
    policyAutoApproved: entries.filter((e) => e.approverType === "policy").length,
    agentReviewApproved: entries.filter((e) => e.approverType === "agent-review").length,
    highRisk: entries.filter((e) => e.risk === "high").length,
    earliestDecisionAt: entries.length ? entries[0]!.decidedAt : null,
    latestDecisionAt: entries.length ? entries[entries.length - 1]!.decidedAt : null,
  };

  return {
    id: `compliance-${now()}-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId,
    generatedAt: now(),
    generatedBy,
    scope: {
      projectId: scope.projectId ?? null,
      projectName: scopeProject?.name ?? null,
      runId: scope.runId ?? null,
      from: scope.from ?? null,
      to: scope.to ?? null,
    },
    summary,
    entries,
  };
}
