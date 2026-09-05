import {
  AuditRecordWithActor,
  GithubConnection,
  Snapshot,
  WsMessage,
  type Checkpoint,
  type TaskRun,
  type TaskAssignment,
  type ProviderId,
  type GithubInstallation,
  type GithubOwner,
  type GithubRepo,
  type ResolveAction,
  type SafetyPolicy,
  type SecretMeta,
  type SecretAuditEntry,
  type Project,
  type ProjectCharter,
  type ProjectContextEntry,
  type CreateProjectContextEntryRequest,
  type WorkspaceSettings,
  type UpdateWorkspaceSettingsRequest,
  type VerifyCredentialResult,
  type EndpointSmokeResult,
  type StewardActionOutcome,
  type PauseCredentialResult,
  type CommandPolicy,
  type PolicyVersion,
  type PolicyDryRunResult,
  type PrChecksStatus,
  SignedComplianceReport,
  type SolutionBrief,
  type Task,
  type ProjectQualityResult,
  type Transition,
  type Rule,
  type RuleCondition,
  type RuleAction,
  type RuleSafety,
  type RuleLifecycleState,
  type PendingRuleAction,
  type PendingRuleActionStatus,
  type Proposal,
  type AutonomyDetent,
  type AutonomyDetentState,
  type AutonomyOverride,
  type SourceRef,
  type Decision,
  type RoadmapDoc,
  type RoadmapLineClaim,
  type RoadmapProposal,
  type HitlItem,
  type RoadmapConflictResolveRequest,
  type ProposeRoadmapChangeRequest,
  type CommitRoadmapLineEditRequest,
  type RoadmapWorkspaceRollup,
  type MemoryFactSummary,
  type CreateMemoryFactRequest,
} from "@skynet/shared";
import { parseStewardStream, type StewardReply } from "./steward-stream";
import { toast } from "../components/toast";

// ─── auth ───────────────────────────────────────────────────────────────────
// The session token drives both REST (Bearer) and the WS (?token=). It's set by
// login() below; the "dev-cyberdyne" fallback only resolves in a dev server
// (production disables dev tokens, so there the login screen is required).
const TOKEN_KEY = "skynet_token";
const token = () =>
  (typeof localStorage !== "undefined" && localStorage.getItem(TOKEN_KEY)) || "dev-cyberdyne";

// The current session's principal, mirrored from `GET /api/auth/me` — a
// human login carries no `scopes` (full authority) UNLESS it's a viewer
// account (server: auth/operators.ts maps role "viewer" → scopes: ["observe"]
// at login). `Principal` isn't a shared type (it's server-only, apps/server/
// src/auth.ts) so this mirrors just the shape the client needs, by hand — same
// pattern as AssistantAction's kind union below.
export interface Principal {
  workspaceId: string;
  operatorId: string;
  scopes?: string[];
  // Set only while a time-limited admin promotion is active on this session
  // (server: auth/sessions.ts's resolve()) — the timestamp it auto-reverts at.
  elevatedUntil?: number;
}

let readOnly = false;
/** Set once per boot (StoreProvider, after `GET /api/auth/me` resolves) — the
 *  client-side half of the viewer gate. The REAL gate is server-side (every
 *  mutation route 403s a scoped-without-author principal — see auth-guard.ts's
 *  requiredScope); this just stops the request before it leaves the browser,
 *  with a message that explains why, instead of a bare 403 surfacing wherever
 *  the call happened to be made from. */
export function setReadOnly(v: boolean): void {
  readOnly = v;
}
export function isReadOnly(): boolean {
  return readOnly;
}

// Mirrors auth-guard.ts's requiredScope() exemptions (a personal auth action,
// and the dry-run/judge endpoints that only read + call an LLM) — so a viewer
// isn't blocked client-side from something the server would actually allow.
// Kept in sync by hand; drifting just means an occasional needless toast (the
// server 403 never fires the other way, since it's the authoritative check).
const READONLY_EXEMPT = new Set([
  "/api/auth/logout",
  "/api/telegram/simulate",
  "/api/simulation/grade",
  "/api/simulation/judge",
  "/api/steward/chat",
  "/api/steward/chat/stream",
]);

/**
 * Exchange operator credentials for a session token (the one public route,
 * /api/auth/login) and persist it. On success the stored token authorizes both
 * REST and the WebSocket; callers reload so the app re-connects with it.
 */
export type LoginResult = { mfaRequired: false } | { mfaRequired: true; challengeId: string };

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("Invalid email or password.");
    const text = await res.text().catch(() => "");
    throw new Error(text || `Login failed (${res.status}).`);
  }
  const data = (await res.json()) as { token?: string; mfaRequired?: boolean; challengeId?: string };
  // MFA on: the password was correct but no session yet — a code went to Telegram.
  if (data.mfaRequired && data.challengeId) return { mfaRequired: true, challengeId: data.challengeId };
  if (typeof localStorage !== "undefined" && data.token) localStorage.setItem(TOKEN_KEY, data.token);
  return { mfaRequired: false };
}

/** Second factor: exchange the challenge + the Telegram code (or a recovery
 *  code) for a session token. */
export async function verifyMfa(challengeId: string, code: string): Promise<void> {
  const res = await fetch("/api/auth/mfa", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId, code }),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("That code is invalid or expired.");
    const text = await res.text().catch(() => "");
    throw new Error(text || `Verification failed (${res.status}).`);
  }
  const data = (await res.json()) as { token: string };
  if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, data.token);
}

// ─── REST helpers ─────────────────────────────────────────────────────────

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (readOnly && method !== "GET" && !READONLY_EXEMPT.has(path)) {
    toast("You're signed in as a viewer — read-only.");
    throw new ApiError(403, "Viewer sessions are read-only.");
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token()}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Who am I? — resolves the current token's principal. Called once at boot
 *  (StoreProvider) so the app knows whether this session is read-only before
 *  anything tries to mutate. GET, so it's never itself blocked by the guard
 *  above. */
export async function fetchMe(): Promise<Principal> {
  const { principal } = await req<{ principal: Principal }>("GET", "/api/auth/me");
  return principal;
}

/** A viewer session (Principal.scopes set, and "author" not among them) —
 *  mirrors the server's hasScope() semantics: undefined scopes = full
 *  authority, so only an EXPLICITLY scoped-without-author principal reads as
 *  read-only. */
export function isReadOnlyPrincipal(principal: Principal): boolean {
  return principal.scopes !== undefined && !principal.scopes.includes("author");
}

/** A workspace operator, as a non-secret summary (admin-promotion picker). */
export interface OperatorSummary {
  operatorId: string;
  email: string;
  role: "admin" | "viewer";
}

/** This workspace's roster — admin-only (see GET /api/operators). */
export async function fetchOperators(): Promise<OperatorSummary[]> {
  return req("GET", "/api/operators");
}

/** Time-limited admin promotion (ROADMAP.md) — ADMIN-granted, never
 *  self-service: promote a named viewer to a bounded full-authority window.
 *  Only an admin's session can call this (the server checks the caller's
 *  PERSISTED role, not just their current scopes). */
export async function promoteOperator(operatorId: string, ttlMs?: number): Promise<{ operatorId: string; expiresAt: number }> {
  return req("POST", `/api/operators/${encodeURIComponent(operatorId)}/promote`, ttlMs ? { ttlMs } : {});
}

export type ElevationEvent =
  | { kind: "grant"; workspaceId: string; operatorId: string; grantedBy: string; at: number; expiresAt: number; ttlMs: number }
  | { kind: "expiry"; workspaceId: string; operatorId: string; at: number; expiresAt: number };

/** The elevation audit trail (grants AND observed expiries) — newest first,
 *  append-only server-side. */
export async function fetchElevations(): Promise<ElevationEvent[]> {
  return req("GET", "/api/auth/elevations");
}

export async function fetchSnapshot(): Promise<Snapshot> {
  const raw = await req<unknown>("GET", "/api/snapshot");
  return Snapshot.parse(raw);
}

// Decision audit trail — resolved HITL decisions, newest first (W8).
//
// Parses each row INDEPENDENTLY (safeParse) and drops any that don't match the
// current schema. A `.array().parse()` throws on the first bad row and blanks
// the entire audit page — so one legacy record from an older schema (or from a
// half-applied migration) makes it look like every approval was lost. Per-row
// parse keeps the good rows visible; drops are logged so we can diagnose.
export async function fetchAudit(): Promise<AuditRecordWithActor[]> {
  const raw = await req<unknown>("GET", "/api/audit");
  if (!Array.isArray(raw)) return [];
  const out: AuditRecordWithActor[] = [];
  for (const row of raw) {
    const parsed = AuditRecordWithActor.safeParse(row);
    if (parsed.success) out.push(parsed.data);
    else {
      const id = row && typeof row === "object" ? (row as { hitlId?: unknown }).hitlId : undefined;
      const paths = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      console.warn(`[audit] dropped invalid record ${String(id ?? "(no id)")}: ${paths}`);
    }
  }
  return out;
}
// TASK 21 — the audit trail export (NDJSON, for SIEM ingestion — see
// api.ts's /api/audit/export). Bearer-token auth means a plain `<a href>`
// download won't authenticate (browsers don't attach a custom Authorization
// header to a link click), so this fetches the text through the same
// authenticated path `req()` uses and hands the caller the raw body to
// download as a Blob (see compliance-export.tsx's downloadFile for the
// same pattern with the compliance report).
export async function exportAudit(): Promise<string> {
  const res = await fetch("/api/audit/export", { headers: { authorization: `Bearer ${token()}` } });
  if (!res.ok) throw new ApiError(res.status, (await res.text().catch(() => "")) || res.statusText);
  return res.text();
}
// Audit maintenance — archive/restore + delete, per-record and bulk.
export function archiveAudit(hitlId: string, archived: boolean) {
  return req<unknown>("POST", `/api/audit/${hitlId}/archive`, { archived });
}
export function deleteAudit(hitlId: string) {
  return req<unknown>("DELETE", `/api/audit/${hitlId}`);
}
export function archiveAllAudit() {
  return req<unknown>("POST", "/api/audit/archive-all");
}
export function clearAudit() {
  return req<unknown>("DELETE", "/api/audit");
}

// One-click signed "AI change report" (ROADMAP: Compliance evidence pack).
// Scope is all-optional query params — omit everything for the whole
// workspace. Parsed defensively like fetchAudit: a malformed response (a
// server predating this route, or a future breaking change) throws a clear
// error rather than handing the caller a half-shaped object to render.
export async function fetchComplianceReport(scope: {
  projectId?: string | null;
  runId?: string | null;
  from?: number | null;
  to?: number | null;
}): Promise<SignedComplianceReport> {
  const params = new URLSearchParams();
  if (scope.projectId) params.set("projectId", scope.projectId);
  if (scope.runId) params.set("runId", scope.runId);
  if (scope.from != null) params.set("from", String(scope.from));
  if (scope.to != null) params.set("to", String(scope.to));
  const qs = params.toString();
  const raw = await req<unknown>("GET", `/api/compliance/report${qs ? `?${qs}` : ""}`);
  const parsed = SignedComplianceReport.safeParse(raw);
  if (!parsed.success) throw new Error("The compliance report the server returned didn't match the expected shape.");
  return parsed.data;
}

// HITL
export function resolveHitl(
  id: string,
  body: { action: ResolveAction; optionIndex?: number; guidance?: string; remember?: boolean; targetBranch?: string; memoryNote?: string; resetWork?: boolean },
) {
  return req<unknown>("POST", `/api/hitl/${id}/resolve`, body);
}

// TaskRun chat / fork
export function sendAgentMessage(id: string, text: string) {
  return req<{ reply: string }>("POST", `/api/runs/${id}/messages`, { text });
}

// `inform` — mass-select runs (explicit ids and/or a whole project's live
// runs) + a note that rides each one's next prompt, no extra turn.
export function informRuns(body: { note: string; runIds?: string[]; projectId?: string }) {
  return req<{ informed: string[]; skipped: Array<{ runId: string; reason: string }> }>(
    "POST",
    "/api/runs/inform",
    body,
  );
}

/**
 * Streaming chat: POST the question and read the text/plain reply as it streams,
 * calling `onDelta` with each chunk. Resolves with the full reply. Falls back to
 * the non-streaming endpoint if the browser/response can't stream (older
 * runtime, or the body isn't readable) so the caller always gets an answer.
 */
export async function streamAgentMessage(
  id: string,
  text: string,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const res = await fetch(`/api/runs/${encodeURIComponent(id)}/messages/stream`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || res.statusText);
  }
  if (!res.body) {
    // No readable stream — fall back to the whole reply, delivered as one chunk.
    const { reply } = await sendAgentMessage(id, text);
    onDelta(reply);
    return reply;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) {
      full += chunk;
      onDelta(chunk);
    }
  }
  return full;
}

// Telegram conversational assistant — DRY-RUN. Runs the assistant pipeline
// (helpful reply + optional whitelisted action) WITHOUT executing anything, so
// the Simulation section can exercise it repeatably. `error: "no-llm"` means no
// consult-capable key is available.
export interface ConversationalResult {
  reply: string | null;
  action: { kind: string } | null;
  error?: string;
}
export function simulateConversational(text: string) {
  return req<ConversationalResult>("POST", "/api/telegram/simulate", { text });
}

// Simulation step grading — LLM-as-judge. Given the operator `prompt`, an
// `expectation`, and the assistant's `actual` response, a second LLM decides
// whether the response acceptably met the expectation. `pass: null` with
// `error: "no-llm"` means no consult-capable key is available (the caller then
// soft-skips), consistent with the conversational dry-run endpoint.
export interface GradeResult {
  pass: boolean | null;
  reason: string;
  error?: string;
}
export function simulationGrade(prompt: string, expectation: string, actual: string) {
  return req<GradeResult>("POST", "/api/simulation/grade", { prompt, expectation, actual });
}
export function forkAgent(id: string) {
  return req<unknown>("POST", `/api/runs/${id}/fork`);
}
export function createCheckpoint(runId: string, label?: string) {
  return req<Checkpoint>("POST", `/api/runs/${runId}/checkpoints`, label ? { label } : {});
}
/** A run's checkpoints — lazily fetched (like the diff) rather than riding the snapshot. */
export function fetchCheckpoints(runId: string) {
  return req<Checkpoint[]>("GET", `/api/runs/${runId}/checkpoints`);
}
export function restoreCheckpoint(runId: string, checkpointId: string) {
  return req<TaskRun>("POST", `/api/runs/${runId}/checkpoints/${checkpointId}/restore`);
}
export interface RunDiff {
  patch: string;
  add: number;
  del: number;
  files: string[];
}
/** The real unified diff of a run's branch — lazily fetched for the review UI. */
export function fetchRunDiff(id: string) {
  return req<RunDiff>("GET", `/api/runs/${encodeURIComponent(id)}/diff`);
}
export function stopAgent(id: string) {
  return req<TaskRun>("POST", `/api/runs/${id}/stop`);
}
export function archiveAgent(id: string, archived: boolean) {
  return req<unknown>("POST", `/api/runs/${id}/archive`, { archived });
}
// ── Ready-to-merge PR actions ──────────────────────────────────────────────
export function mergePr(runId: string, method: "merge" | "squash" | "rebase" = "squash") {
  return req<{ merged: boolean; reason?: string; blocked?: "conflict" | "checks" | "protection" }>("POST", `/api/merges/${runId}/merge`, { method });
}
export function updatePrBranch(runId: string) {
  return req<{ updated: boolean; conflicts?: string[] }>("POST", `/api/merges/${runId}/update-branch`);
}
export function reworkPr(runId: string, guidance: string, comment?: string) {
  return req<unknown>("POST", `/api/merges/${runId}/rework`, { guidance, comment });
}
export function dismissPr(runId: string) {
  return req<unknown>("POST", `/api/merges/${runId}/dismiss`);
}
/** Live GitHub check-run status for a ready PR — a real API call the card
 *  makes on its own (not part of the polled snapshot). null = unknown. */
export function fetchPrChecks(runId: string) {
  return req<PrChecksStatus | null>("GET", `/api/merges/${runId}/checks`);
}
// Feature-scoped branch batching's aggregate PR — one per completed Feature
// (see orchestrator.ts's checkFeatureCompletion), not per task. Only merge +
// dismiss are supported — no rework/update-branch for a batch.
export function mergeFeaturePr(featureId: string, method: "merge" | "squash" | "rebase" = "squash") {
  return req<{ merged: boolean; reason?: string; blocked?: "conflict" | "checks" | "protection" }>("POST", `/api/features/${featureId}/pr/merge`, { method });
}
export function dismissFeaturePr(featureId: string) {
  return req<unknown>("POST", `/api/features/${featureId}/pr/dismiss`);
}
export function fetchFeaturePrChecks(featureId: string) {
  return req<PrChecksStatus | null>("GET", `/api/features/${featureId}/pr/checks`);
}
// Review & Merge (Phase 15) — the project's LOCAL merge queue (apps/server/src/merge.ts),
// distinct from the GitHub-PR-flow "Ready to merge" list above.
export interface MergeQueueEntry {
  runId: string;
  position: number;
  mode: "human" | "auto";
  reason: string | null;
}
export function fetchMergeQueue(projectId: string) {
  return req<MergeQueueEntry[]>("GET", `/api/projects/${projectId}/merge-queue`);
}
export function pauseAgent(id: string) {
  return req<unknown>("POST", `/api/runs/${id}/pause`);
}
export function resumeAgent(id: string) {
  return req<unknown>("POST", `/api/runs/${id}/resume`);
}

/** The product roadmap (ROADMAP.md), rendered in Settings. */
export function fetchRoadmap() {
  return req<{ markdown: string }>("GET", "/api/roadmap");
}

// ─── Decision Inbox (TASK 16) ───────────────────────────────────────────────
// Every open HITL across every project in the workspace, joined with the
// project/task it belongs to and sorted by cost-of-waiting server-side (see
// Operations.listDecisions, TASK 15).
export function fetchDecisions() {
  return req<Decision[]>("GET", "/api/decisions");
}

// ─── Depleted provider keys (TASK 23 hardening) ────────────────────────────
// The ONE fleet-level source for "a provider key is out of credits/quota" —
// backs a single banner instead of a duplicated per-run billing escalation
// being the operator's only signal.
export type DepletedKey = { credentialId: string; reason: string; at: number };
export function fetchDepletedKeys() {
  return req<DepletedKey[]>("GET", "/api/depleted-keys");
}

// TASK 24 — the command palette's destructive "Pause the whole fleet"
// action. Same kill switch Telegram's /stop already exposes to the operator.
export function stopAllRuns() {
  return req<{ stopped: number }>("POST", "/api/fleet/stop-all");
}

// ─── Project roadmap doc (ROADMAP.md, read from the project's bound repo) ──
export type ProjectRoadmapResult =
  | { state: "ok"; path: string; content: string; source: "local" | "github"; sha?: string }
  | { state: "unbound" }
  | { state: "missing_local_repo" }
  | { state: "not_found" }
  | { state: "github_error"; message: string };

/** Scenario coverage for a project's checked-out branch — which of the
 *  codebase's enumerable behaviour sets the tests exercise at all. */
export function fetchProjectQuality(projectId: string) {
  return req<ProjectQualityResult>("GET", `/api/projects/${projectId}/quality`);
}

export function fetchProjectRoadmap(projectId: string) {
  return req<ProjectRoadmapResult>("GET", `/api/projects/${projectId}/roadmap`);
}

export function commitProjectRoadmap(
  projectId: string,
  body: { path: string; content: string; baselineHash: string; baselineSha?: string },
) {
  return req<ProjectRoadmapResult>("POST", `/api/projects/${projectId}/roadmap`, body);
}

// ─── Roadmap document view (Phase 26 — TASK 29) ─────────────────────────────
// The parsed RoadmapDoc (real per-line state, blame-derived provenance,
// "claim as mine" overrides already applied server-side) — distinct from
// fetchProjectRoadmap above, which only ever returns raw markdown text.
export function fetchProjectRoadmapDoc(projectId: string) {
  return req<RoadmapDoc>("GET", `/api/projects/${projectId}/roadmap/doc`);
}

export function fetchRoadmapProposals(projectId: string) {
  return req<RoadmapProposal[]>("GET", `/api/projects/${projectId}/roadmap/proposals`);
}

/** Open a new governed roadmap proposal — the Drift dashboard's ORPHANS
 *  panel ("propose N roadmap lines to cover these"), riding the exact same
 *  agent-proposal path (Operations.proposeRoadmapChange) an autonomous
 *  agent's own proposal uses. */
export function proposeRoadmapChange(projectId: string, body: ProposeRoadmapChangeRequest) {
  return req<RoadmapProposal>("POST", `/api/projects/${projectId}/roadmap/proposals`, body);
}

export function applyRoadmapProposal(projectId: string, proposalId: string) {
  return req<{ proposal: RoadmapProposal; committed: boolean; sha?: string }>(
    "POST",
    `/api/projects/${projectId}/roadmap/proposals/${proposalId}/apply`,
  );
}

/** "KEEP · CLAIM AS MINE" on an agent-added line — see RoadmapLineClaim's own
 *  doc comment: a display-layer override, never a git operation. */
export function claimRoadmapLine(projectId: string, lineId: string) {
  return req<RoadmapLineClaim>("POST", `/api/projects/${projectId}/roadmap/lines/${lineId}/claim`);
}

/** "REVERT THE COMMIT" on an agent-added line — a real `git revert` of
 *  whatever commit git-blame attributes that line to. Local-repo-bound
 *  projects only; throws with a clear message otherwise. */
export function revertRoadmapLine(projectId: string, lineId: string) {
  return req<{ committed: boolean; sha?: string }>("POST", `/api/projects/${projectId}/roadmap/lines/${lineId}/revert`);
}

export interface RoadmapHistoryEntry {
  sha: string;
  authorName: string;
  authorEmail: string;
  at: number;
  subject: string;
}
export function fetchRoadmapHistory(projectId: string, opts?: { limit?: number }) {
  const qs = opts?.limit != null ? `?limit=${opts.limit}` : "";
  return req<RoadmapHistoryEntry[]>("GET", `/api/projects/${projectId}/roadmap/history${qs}`);
}

/** The Drift dashboard's ONE DECISION panel ("MOVE IT TO Q4"/"KEEP AND
 *  RE-DATE Q3") — a single-line edit the operator decided directly, committed
 *  through TASK 28's attributed-commit path with no proposal/HITL detour. */
export function commitRoadmapLineEdit(projectId: string, body: CommitRoadmapLineEditRequest) {
  return req<{ committed: boolean; sha?: string }>("POST", `/api/projects/${projectId}/roadmap/commit-edit`, body);
}

// ── Memory v0, phase 1 (operator-authored facts) ──────────────────────────
export function fetchProjectMemory(projectId: string) {
  return req<MemoryFactSummary[]>("GET", `/api/projects/${projectId}/memory`);
}
export function addMemoryFact(projectId: string, body: CreateMemoryFactRequest) {
  return req<MemoryFactSummary>("POST", `/api/projects/${projectId}/memory`, body);
}

/** "Without a file there is no roadmap — create one from the board." */
export function scaffoldProjectRoadmap(projectId: string) {
  return req<RoadmapDoc>("POST", `/api/projects/${projectId}/roadmap/scaffold`);
}

// ── workspace roadmap roll-up (Phase 29 — TASK 32) ────────────────────────
// "Six repos, one quarter" — scoped server-side to the caller's own project
// access; every project in the response is one this operator can already see.
export function fetchWorkspaceRoadmapRollup() {
  return req<RoadmapWorkspaceRollup>("GET", "/api/roadmap-rollup");
}

// ── roadmap proposal governance (TASK 30) ────────────────────────────────
// A roadmap_edit HITL's plain approve/reject rides the existing resolveHitl
// above (Operations.resolveHitl branches on kind itself) — no dedicated
// function for it. The Inbox/conflict card fetches the LIVE proposal here
// rather than trusting the HITL's own (Telegram-only) title/why snapshot, so
// a Rule 1 join or Rule 3 supersede that happens after the card was raised
// shows up the moment it's opened.
export function fetchRoadmapProposal(projectId: string, proposalId: string) {
  return req<RoadmapProposal>("GET", `/api/projects/${projectId}/roadmap-proposals/${proposalId}`);
}

export function resolveRoadmapConflict(hitlId: string, body: RoadmapConflictResolveRequest) {
  return req<HitlItem>("POST", `/api/hitl/${hitlId}/roadmap-conflict-resolve`, body);
}

// ─── Momentum Board (Phase 4) — transitions ─────────────────────────────────
// Rules/Proposals ride the Snapshot + WS deltas (see store.tsx); Transition[]
// doesn't (it's an append-only feed, not current state), so the board fetches
// it directly and stays live via the `transition.created` WS event instead.
export function fetchProjectTransitions(projectId: string, opts?: { since?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (opts?.since != null) qs.set("since", String(opts.since));
  if (opts?.limit != null) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return req<Transition[]>("GET", `/api/projects/${projectId}/transitions${q ? `?${q}` : ""}`);
}

// ─── Home rebuild (Phase 22) — workspace-wide transitions ──────────────────
// Same fetch-once-then-merge-live pattern as BoardHealth, just not scoped to
// one project — Home's automation-rate/stalled-count stats span every
// project in the workspace.
export function fetchTransitions(opts?: { since?: number; limit?: number }) {
  const qs = new URLSearchParams();
  if (opts?.since != null) qs.set("since", String(opts.since));
  if (opts?.limit != null) qs.set("limit", String(opts.limit));
  const q = qs.toString();
  return req<Transition[]>("GET", `/api/transitions${q ? `?${q}` : ""}`);
}

// ─── Momentum Board (Phase 5) — task detail: trail + suggested subtasks ────
export function fetchTaskTransitions(taskId: string) {
  return req<Transition[]>("GET", `/api/tasks/${taskId}/transitions`);
}

/** Accept ONE suggested subtask Proposal — creates the real Task (parentTaskId
 *  set) and flips the Proposal to accepted; see Operations.acceptSubtask. */
export function acceptSubtask(taskId: string, proposalId: string) {
  return req<Task>("POST", `/api/tasks/${taskId}/subtasks/accept`, { proposalId });
}

/** Accept every PENDING suggested_subtask Proposal for this task in one call. */
export function acceptAllSubtasks(taskId: string) {
  return req<Task[]>("POST", `/api/tasks/${taskId}/subtasks/accept-all`);
}

// ─── Momentum Board (Phase 6a) — rules (Automation Builder) ─────────────────
// Reads ride the Snapshot + `rule.upserted`/`rule.deleted` WS deltas (see
// store.tsx) — no fetchRules() here, same as features/milestones. Mutations
// + the live backtest replay (a pure read with no state to keep in sync,
// called directly by the component like fetchProjectTransitions above) are
// the REST surface this file owns.
export interface CreateRuleBody {
  name: string;
  when: string;
  conditions: RuleCondition[];
  actions: RuleAction[];
  safety?: RuleSafety;
  state?: RuleLifecycleState;
}
export function createRule(projectId: string, body: CreateRuleBody) {
  return req<Rule>("POST", `/api/projects/${projectId}/rules`, body);
}
export interface UpdateRuleBody {
  name?: string;
  when?: string;
  conditions?: RuleCondition[];
  actions?: RuleAction[];
  safety?: RuleSafety;
  state?: RuleLifecycleState;
  archived?: boolean;
}
export function updateRule(projectId: string, ruleId: string, body: UpdateRuleBody) {
  return req<Rule>("PATCH", `/api/projects/${projectId}/rules/${ruleId}`, body);
}
export function deleteRule(projectId: string, ruleId: string) {
  return req<unknown>("DELETE", `/api/projects/${projectId}/rules/${ruleId}`);
}
export interface BacktestResult {
  wouldHaveMoved: number;
  sample: Transition[];
}
/** Replay a DRAFT (not-yet-saved) rule's conditions against this project's
 *  historical Transition log — the Automation Builder's live backtest card.
 *  `actions`/`safety` ride along for a forward-compatible request shape but
 *  the backtest itself only ever checks `conditions` (see the server's own
 *  doc comment on BacktestRuleRequest). */
export function backtestRule(projectId: string, body: { conditions: RuleCondition[]; actions?: RuleAction[]; safety?: RuleSafety }) {
  return req<BacktestResult>("POST", `/api/projects/${projectId}/rules/backtest`, body);
}
/** Rail Graph's "pause rules" action (Phase 11, TASK 12) — bulk-pauses every
 *  live rule for this project in one call. Returns exactly the rules that
 *  were actually paused (watch/already-paused rules are left untouched). */
export function pauseAllRules(projectId: string) {
  return req<Rule[]>("POST", `/api/projects/${projectId}/rules/pause-all`);
}

// ─── Activity Feed (Phase 6b) — undo window ─────────────────────────────────
// Which rule-engine actions are still cancellable, and the undo call itself.
// No WS event exists for a PendingRuleAction's own lifecycle (only the
// Transition it eventually produces is live) — the feed refetches this
// periodically and updates the acted-on row optimistically on a successful undo.
export function fetchPendingActions(projectId: string, opts?: { status?: PendingRuleActionStatus }) {
  const qs = opts?.status ? `?status=${opts.status}` : "";
  return req<PendingRuleAction[]>("GET", `/api/projects/${projectId}/pending-actions${qs}`);
}

export function undoRuleAction(pendingId: string) {
  return req<PendingRuleAction>("POST", `/api/pending-actions/${pendingId}/undo`);
}

/** TASK 13 hardening — the Activity Feed's "retry" action on a
 *  `status:"failed"` row: re-runs the rule's current dispatch for this task. */
export function retryRuleAction(ruleId: string, taskId: string) {
  return req<Task>("POST", `/api/rules/${ruleId}/retry`, { taskId });
}

// ─── Proposals (Momentum Rollout Phase 1c) — accept / dismiss ──────────────
// Generic across every ProposalKind; TASK 10's "pattern spotted" card is the
// first UI to actually call these (`stall_nudge` stays read-only elsewhere —
// see board.tsx). `activate` only affects a `suggested_rule` proposal (the
// onboarding card's "TURN IT ON" vs "WATCH FIRST") and is ignored server-side
// for every other kind.
export function acceptProposal(projectId: string, proposalId: string, opts?: { activate?: boolean }) {
  return req<Proposal>("POST", `/api/projects/${projectId}/proposals/${proposalId}/accept`, opts?.activate ? { activate: true } : undefined);
}
export function dismissProposal(projectId: string, proposalId: string) {
  return req<Proposal>("POST", `/api/projects/${projectId}/proposals/${proposalId}/dismiss`);
}

// ─── Advanced env settings (desktop) ───────────────────────────────────────
export type EnvFieldType = "text" | "number" | "toggle" | "secret";
export interface EnvSettingField {
  key: string;
  group: string;
  label: string;
  hint: string;
  type: EnvFieldType;
  placeholder?: string;
  unit?: string;
  value: string; // empty for secrets + unset keys
  set: boolean;
}
/** Read the Advanced settings whitelist + current staged values. */
export function fetchEnvSettings() {
  return req<{ writable: boolean; fields: EnvSettingField[] }>("GET", "/api/settings/env");
}
/** Stage env changes to the desktop overrides file (applied on restart). */
export function saveEnvSettings(updates: Record<string, string>) {
  return req<{ ok: true; restartRequired: boolean }>("PUT", "/api/settings/env", { updates });
}
/** Ask the desktop shell to relaunch the local engine so staged changes apply. */
export function restartEngine() {
  return req<{ restarting: boolean }>("POST", "/api/settings/restart");
}
/** Read the live workspace fleet policy (auto-scale + cap). */
export function fetchWorkspaceSettings() {
  return req<WorkspaceSettings>("GET", "/api/settings/fleet");
}
/** Update the live workspace fleet policy. */
export function updateWorkspaceSettings(patch: UpdateWorkspaceSettingsRequest) {
  return req<WorkspaceSettings>("PATCH", "/api/settings/fleet", patch);
}

// Command policy: the versioned, per-workspace command-safety classifier.
/** The active policy — the shipped default if no custom version was ever saved. */
export function fetchCommandPolicy() {
  return req<CommandPolicy>("GET", "/api/settings/command-policy");
}
/** Version history, newest first. Empty = still on the shipped default. */
export function fetchCommandPolicyVersions() {
  return req<PolicyVersion[]>("GET", "/api/settings/command-policy/versions");
}
/** Replay history through an unsaved, proposed policy — what would change. */
export function dryRunCommandPolicy(policy: CommandPolicy, limit?: number) {
  return req<PolicyDryRunResult>("POST", "/api/settings/command-policy/dry-run", { policy, limit });
}
/** Save a new active policy version (previous version stays inspectable). */
export function saveCommandPolicyVersion(policy: CommandPolicy, label: string | null) {
  return req<PolicyVersion>("POST", "/api/settings/command-policy/versions", { policy, label });
}

// Provider secrets (Settings). `env` = providers a server env var supplies a
// key for (a stored key overrides it).
export function fetchSecrets() {
  return req<{ secrets: SecretMeta[]; env: string[] }>("GET", "/api/secrets");
}
// Set or rotate a credential's key by id — a provider id targets that provider's
// DEFAULT credential; a `cred-…` id rotates an existing named one.
// `baseUrl` omitted = leave the stored endpoint alone (a plain rotation); null
// clears it back to the vendor's own API. See SecretMeta.baseUrl.
export function setSecret(id: string, apiKey: string, baseUrl?: string | null) {
  return req<{ secret: SecretMeta }>("PUT", `/api/secrets/${id}`, baseUrl === undefined ? { apiKey } : { apiKey, baseUrl });
}
export function deleteSecret(id: string) {
  return req<unknown>("DELETE", `/api/secrets/${id}`);
}
// Create a NAMED credential — a second key for a provider that already has one
// ("Claude on another account"). Agents can then be pinned to it via credentialId.
export function createCredential(provider: string, name: string, apiKey: string, baseUrl?: string | null) {
  return req<{ secret: SecretMeta }>("POST", "/api/credentials", { provider, name, apiKey, baseUrl: baseUrl ?? null });
}
// Live-verify a credential's key against its vendor — a real, cheap call
// (never a generation) confirming it actually authenticates. Never blocks the
// save that already happened; this is UI feedback only.
export function verifyCredential(id: string) {
  return req<VerifyCredentialResult>("POST", `/api/credentials/${id}/verify`);
}
// Smoke-test a credential: runs ONE tiny real task through the agent loop on it
// and reports what the endpoint actually supported. Verify proves the key
// authenticates; this proves the endpoint can drive Skynet. Costs a fraction of
// a cent, so it is only ever triggered by the operator.
// Bench a credential: no runner on it gets new work, and every run already on
// it is stopped and its task released back to `todo`. Returns which runs were
// stopped, so the UI can say what the pause actually did.
export function pauseCredential(id: string, reason: string) {
  return req<PauseCredentialResult>("POST", `/api/credentials/${id}/pause`, { reason });
}
export function resumeCredential(id: string) {
  return req<{ secret: SecretMeta }>("POST", `/api/credentials/${id}/resume`);
}
export function smokeTestCredential(id: string, model?: string) {
  return req<EndpointSmokeResult>("POST", `/api/credentials/${id}/smoke`, model ? { model } : {});
}
// Governance flag: is this key the workspace's own, or a personal key running
// agent work? An operator's explicit correction — never auto-detected. See
// SecretMeta.orgOwned.
export function setCredentialOrgOwned(id: string, orgOwned: boolean) {
  return req<{ secret: SecretMeta }>("POST", `/api/credentials/${id}/org-owned`, { orgOwned });
}
// Credential lifecycle log (created/rotated/removed, who + when — never the
// key) — answers "why did this provider suddenly show not connected".
export function fetchSecretAudit() {
  return req<{ audit: SecretAuditEntry[] }>("GET", "/api/secrets/audit");
}

// ─── Service tokens (MCP / programmatic access) ────────────────────────────
// Scoped API tokens for runs driving Skynet over MCP. The raw token is
// returned ONCE at creation; list only ever yields non-secret metadata.
export type McpScope = "observe" | "author" | "approver" | "admin";

export interface ServiceTokenMeta {
  id: string;
  label: string;
  scopes: McpScope[];
  // Empty = every project in the workspace; a non-empty list = the projects this
  // token is confined to (both its reads and its writes).
  projectIds: string[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  last4: string;
}

export function listServiceTokens() {
  return req<ServiceTokenMeta[]>("GET", "/api/service-tokens");
}
export function createServiceToken(body: { label: string; scopes: McpScope[]; projectIds?: string[]; ttlMs?: number | null }) {
  return req<{ token: string; id: string; scopes: McpScope[]; projectIds: string[]; label: string; expiresAt: number | null }>(
    "POST",
    "/api/service-tokens",
    body,
  );
}
export function revokeServiceToken(id: string) {
  return req<unknown>("DELETE", `/api/service-tokens/${id}`);
}

// ─── Local folder browser (connect-a-folder picker) ────────────────────────
export interface FsEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}
export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  exists: boolean;
  isGitRepo: boolean;
}
/** List subfolders of `path` (default: home) on the server machine. */
export function browseFolder(path?: string) {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  return req<FsListing>("GET", `/api/fs/list${q}`);
}

// Projects

/** Draft a Project Charter from the operator's raw goal (Gate G-1). One cheap
 *  LLM call on the workspace's own key; returns a structured charter the
 *  operator edits/approves before the project is created. */
export function draftCharter(goal: string) {
  return req<ProjectCharter>("POST", "/api/projects/draft-charter", { goal });
}

export function createProject(body: {
  name: string;
  goal: string;
  repoPath?: string;
  repo?: string;
  createRepo?: { name: string; private: boolean; owner?: string };
  autonomy?: boolean;
  approvalLevel?: string;
  instructions?: string;
  baseBranch?: string;
  importGithubIssues?: boolean;
  charter?: ProjectCharter;
  // Pin the project to a specific GitHub account (a credential added in
  // Integrations); omit → the workspace default connection.
  githubCredentialId?: string;
}) {
  return req<Project>("POST", "/api/projects", body);
}
export function updateProject(
  id: string,
  body: {
    name?: string;
    goal?: string;
    status?: string;
    autonomy?: boolean;
    // A daily USD ceiling on known spend; null clears back to "no limit".
    dailyBudgetUsd?: number | null;
    // Spread the daily budget across a working window instead of committing
    // it all in the first tick. Ignored unless dailyBudgetUsd is also set.
    budgetPacing?: boolean;
    approvalLevel?: string;
    planModeGate?: boolean;
    // Tool names to block for this project's agents; null clears the restriction.
    disallowedTools?: string[] | null;
    repoPath?: string | null;
    // null clears the field back to "no project rules".
    instructions?: string | null;
    githubCredentialId?: string | null;
    flyCredentialId?: string | null;
    // Which provider keys the project may run on (credential ids; empty = all).
    enabledRunnerCredentialIds?: string[];
    syncSourceStatus?: boolean;
    // Branch to stack runs/PRs onto; null clears back to the global default.
    baseBranch?: string | null;
    // Where the Roadmap tab reads its doc from; null clears back to the
    // default ROADMAP.md/docs/ROADMAP.md candidates.
    roadmapPath?: string | null;
    // Verifier gate command; null clears back to the global default.
    checkCmd?: string | null;
    deepReview?: boolean;
    breakerReview?: boolean;
    // Momentum Board opt-in; see Project.newBoardEnabled.
    newBoardEnabled?: boolean;
    // Momentum Board's Queued-column WIP limit; null clears back to no limit.
    queuedWipLimit?: number | null;
    // Exact commands that must ALWAYS gate for a human — see Project.alwaysGateCommands.
    alwaysGateCommands?: string[];
    // Project-level default for a NEW automation rule's safety rails — see
    // Project.ruleSafetyDefaults.
    ruleSafetyDefaults?: RuleSafety;
  },
) {
  return req<Project>("PATCH", `/api/projects/${id}`, body);
}
/** Add a standing "approve always" rule directly (Keys & Budget panel's
 *  "+ add pattern" — the risk cap is derived server-side). */
export function addApprovalRule(projectId: string, command: string) {
  return req<Project>("POST", `/api/projects/${projectId}/approval-rules`, { command });
}
/** Revoke one standing "approve always" rule from a project's approval policy. */
export function removeApprovalRule(projectId: string, ruleId: string) {
  return req<unknown>("DELETE", `/api/projects/${projectId}/approval-rules/${ruleId}`);
}
export function deleteProject(id: string) {
  return req<unknown>("DELETE", `/api/projects/${id}`);
}
/** Clone a GitHub-connected project's repo into a local checkout on the server
 *  (headless/GCP), so agents can work on it. Sets repoPath + gitBacked. */
export function cloneProjectRepo(id: string) {
  return req<unknown>("POST", `/api/projects/${id}/clone`);
}
// TASK 19 — autonomy dial: composite notch + persisted breaker/override state.
export function getAutonomyDetent(projectId: string) {
  return req<AutonomyDetentState>("GET", `/api/projects/${projectId}/autonomy-detent`);
}
export function setAutonomyDetent(projectId: string, detent: AutonomyDetent) {
  return req<Project>("POST", `/api/projects/${projectId}/autonomy-detent`, { detent });
}
/** "OVERRIDE — I'LL WATCH IT": bypass a tripped breaker for a bounded window. */
export function createAutonomyOverride(projectId: string) {
  return req<AutonomyOverride>("POST", `/api/projects/${projectId}/autonomy-override`);
}
// Import the project's open GitHub issues as tasks (linked back via Task.source).
export function importGithubIssues(projectId: string) {
  return req<{ imported: number; skipped: number }>("POST", `/api/projects/${projectId}/import/github-issues`);
}
// Import a repo file's open checklist items as tasks (linked back to the file+item).
export function importRepoFile(projectId: string, path: string) {
  return req<{ imported: number; skipped: number }>("POST", `/api/projects/${projectId}/import/repo-file`, { path });
}
// Manual "Re-sync": pull new/drifted GitHub issues + repo-file checklist items,
// and push any Skynet-side task state that never made it back to the source.
export function resyncProjectSource(projectId: string) {
  return req<{ imported: number; updated: number; pushed: number }>("POST", `/api/projects/${projectId}/resync-source`);
}

// Tasks
export function createTask(projectId: string, text: string, description?: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks`, {
    text,
    ...(description ? { description } : {}),
  });
}
export function updateTask(
  projectId: string,
  taskId: string,
  body: {
    text?: string;
    description?: string | null;
    autoPick?: boolean;
    assignment?: TaskAssignment;
    // Scheduling — null clears the field on the task.
    estimatedDurationMs?: number | null;
    plannedStartAt?: number | null;
    // Grouping — null clears the linkage.
    featureId?: string | null;
    milestoneId?: string | null;
    // Start-picker preference — null clears it back to plain auto-pick.
    preferredProvider?: ProviderId | null;
    preferredModel?: string | null;
  },
) {
  return req<unknown>("PATCH", `/api/projects/${projectId}/tasks/${taskId}`, body);
}
export function deleteTask(projectId: string, taskId: string) {
  return req<unknown>("DELETE", `/api/projects/${projectId}/tasks/${taskId}`);
}
// Reversible soft-hide: an archived task leaves the kanban but stays in the store
// (recoverable, still read by Steward). Un-archive with archived=false.
export function archiveTask(projectId: string, taskId: string, archived = true) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/archive`, { archived });
}
export function assignTask(projectId: string, taskId: string) {
  return req<TaskRun>("POST", `/api/projects/${projectId}/tasks/${taskId}/assign`);
}
/** Cross-vendor consensus run: fire the task at 2+ providers in parallel,
 *  each in its own worktree off the same base commit. Picking a winner is
 *  just approving that sibling's own diff HITL — see resolveHitl. */
export function startBakeoff(projectId: string, taskId: string, providerIds: ProviderId[]) {
  return req<TaskRun[]>("POST", `/api/projects/${projectId}/tasks/${taskId}/bakeoff`, { providerIds });
}
/** The bake-off sibling of `requestReview`: force the N-way comparison pass
 *  now instead of waiting for a periodic tick to find every sibling finished
 *  and an eligible judge idle at the same moment. Throws (ApiError 409) with
 *  an honest, specific reason — not every sibling finished yet / already
 *  judged / no judge free right now — for the caller to surface. */
export function requestBakeoffJudgment(projectId: string, taskId: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/request-bakeoff-review`);
}
/** Answer triage's clarifying questions — appends the operator's own words to
 *  the task description and returns it to backlog for re-triage. */
export function answerClarification(projectId: string, taskId: string, answer: string) {
  return req<Task>("POST", `/api/projects/${projectId}/tasks/${taskId}/clarify`, { answer });
}

export function dismissTaskLint(projectId: string, taskId: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/lint/dismiss`);
}

// Features (task grouping)
export function createFeature(projectId: string, body: { name: string; description?: string; milestoneId?: string | null }) {
  return req<unknown>("POST", `/api/projects/${projectId}/features`, body);
}
export function updateFeature(
  featureId: string,
  body: {
    name?: string;
    description?: string | null;
    status?: "active" | "paused" | "shipped";
    milestoneId?: string | null;
    archived?: boolean;
  },
) {
  return req<unknown>("PATCH", `/api/features/${featureId}`, body);
}
export function deleteFeature(featureId: string) {
  return req<unknown>("DELETE", `/api/features/${featureId}`);
}

// Milestones (roadmap)
export function createMilestone(projectId: string, body: { name: string; description?: string; targetAt?: number | null }) {
  return req<unknown>("POST", `/api/projects/${projectId}/milestones`, body);
}
export function updateMilestone(
  milestoneId: string,
  body: {
    name?: string;
    description?: string | null;
    targetAt?: number | null;
    status?: "planned" | "in-progress" | "shipped";
    archived?: boolean;
  },
) {
  return req<unknown>("PATCH", `/api/milestones/${milestoneId}`, body);
}
export function deleteMilestone(milestoneId: string) {
  return req<unknown>("DELETE", `/api/milestones/${milestoneId}`);
}
// A project/task action the assistant proposes (confirm-first). Kept in sync with
// AssistantAction in apps/server/src/project-assistant.ts; `summary` is the label.
export interface AssistantAction {
  kind:
    | "add_task"
    | "move_task"
    | "rename_task"
    | "set_task_desc"
    | "remove_task"
    | "archive_task"
    | "reorder_task"
    | "request_review"
    | "resync_source"
    | "rename_project"
    | "set_goal"
    | "set_autonomy"
    | "set_status"
    | "set_schedule"
    | "set_assignment"
    | "add_feature"
    | "add_milestone"
    | "set_task_feature"
    | "set_feature_milestone"
    | "edit_roadmap"
    | "set_roadmap_path"
    // Execution intents — these RUN work rather than editing records, so they
    // go through the dedicated endpoint (executeStewardAction), not the plain
    // task/project mutations every other kind uses.
    | "start_task"
    | "queue_tasks"
    | "start_feature"
    | "process_backlog"
    | "pause_key"
    | "resume_key";
  summary: string;
  taskId?: string;
  text?: string;
  description?: string;
  to?: string;
  direction?: "up" | "down";
  name?: string;
  goal?: string;
  autonomy?: boolean;
  status?: string;
  estimatedDurationMs?: number | null;
  plannedStartAt?: number | null;
  // Agent eligibility (set_assignment): `mode` = who may take the task, `agentIds`
  // = the pool for `agents` mode (empty otherwise).
  mode?: "any" | "agents" | "unassigned";
  agentIds?: string[];
  // Credential pause/resume — workspace-scoped, unlike every project action above.
  credentialId?: string;
  reason?: string;
  // Roadmap linkage (add_feature / add_milestone / set_task_feature /
  // set_feature_milestone). `null` clears the respective link.
  featureId?: string | null;
  milestoneId?: string | null;
  targetAt?: number | null;
  // Execution intents. `taskIds` for queue_tasks; `execMode` picks assign-now vs
  // queue-for-the-tick; `feasibleOnly` drops tasks never triaged clear.
  taskIds?: string[];
  execMode?: "queue" | "start_now";
  feasibleOnly?: boolean;
  // edit_roadmap: the diff to show in the confirm chip, and the baseline it was
  // drafted against (needed by commitProjectRoadmap to detect a concurrent edit).
  path?: string;
  content?: string;
  patch?: string;
  add?: number;
  del?: number;
  baselineHash?: string;
  baselineSha?: string;
}
// Global Steward chat (the sidebar dock). `projectId` focuses the page you're on
// (full project assistant + actions); omit it for a workspace-wide answer. The
// response echoes which project the action (if any) targets.
export function stewardChat(
  question: string,
  history: { role: "user" | "assistant"; content: string }[],
  projectId?: string,
) {
  return req<{ reply: string; actions?: AssistantAction[]; projectId?: string | null; sources?: SourceRef[] }>(
    "POST",
    "/api/steward/chat",
    { question, history, projectId },
  );
}

/**
 * Streaming Steward chat: reads the reply as text/plain deltas (calling `onDelta`
 * with each), then a final RS-sentinel (\x1e) control frame carrying the CLEAN
 * reply + any action + resolved project. Resolves with that authoritative reply
 * (the caller reconciles its streamed text to it, so a trailing action JSON that
 * streamed through is cleaned up). Falls back to non-streaming stewardChat.
 */
export async function streamStewardChat(
  question: string,
  history: { role: "user" | "assistant"; content: string }[],
  projectId: string | undefined,
  onDelta: (chunk: string) => void,
): Promise<StewardReply> {
  const res = await fetch("/api/steward/chat/stream", {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({ question, history, projectId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || res.statusText);
  }
  if (!res.body) {
    const r = await stewardChat(question, history, projectId);
    onDelta(r.reply);
    return r;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = (async function* () {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) yield chunk;
    }
  })();
  return parseStewardStream(chunks, onDelta);
}

/** S5 "crystallize": turn a Steward conversation into a draft SolutionBrief.
 *  `history` is the transcript the caller already holds (the dock's own chat
 *  state) — same shape/convention as streamStewardChat's history param. On a
 *  model reply that still can't be read after a server-side retry, this
 *  rejects with an ApiError(422); the caller shows that message and the
 *  thread is left untouched (no brief was created). */
// Run a Steward EXECUTION intent (start_task / queue_tasks / start_feature /
// process_backlog). Unlike every other Steward action these start real work, so
// they run through their own endpoint, which resolves feasibility honestly and
// reports what it actually did — see Operations.executeStewardAction.
// Undo a merged run. One click, because reversibility is what lets an operator
// stop pre-clearing every merge — see Operations.revertRun.
export function revertRun(runId: string) {
  return req<TaskRun>("POST", `/api/runs/${runId}/revert`);
}
// `onlyIndices` — TASK 21's "JUST #01"-style partial acceptance: 0-indexed
// positions into the action's own batch (see ExecuteStewardActionRequest).
export function executeStewardAction(projectId: string, action: unknown, dryRun?: boolean, onlyIndices?: number[]) {
  return req<StewardActionOutcome>("POST", `/api/projects/${projectId}/steward/actions`, {
    action,
    ...(dryRun ? { dryRun } : {}),
    ...(onlyIndices && onlyIndices.length > 0 ? { onlyIndices } : {}),
  });
}
export function crystallizeBrief(
  projectId: string,
  history: { role: "user" | "assistant"; content: string }[],
) {
  return req<SolutionBrief>("POST", `/api/projects/${projectId}/briefs/crystallize`, { history });
}

// ─── Project context (meeting notes, emails, pasted/uploaded docs) ──────────
// Raw entries the operator feeds in — see the "Context" tab. `Project.
// contextSummary` (already on the snapshot's Project record) is the condensed
// digest actually used for grounding; these are the source material behind it.

export function listContextEntries(projectId: string) {
  return req<ProjectContextEntry[]>("GET", `/api/projects/${projectId}/context`);
}

export function addContextEntry(projectId: string, body: CreateProjectContextEntryRequest) {
  return req<ProjectContextEntry>("POST", `/api/projects/${projectId}/context`, body);
}

/** Multipart upload — bypasses the JSON `req()` helper (the file itself is the
 *  payload; the browser sets its own multipart boundary, so no content-type
 *  header here). */
export async function uploadContextEntry(projectId: string, file: File): Promise<ProjectContextEntry> {
  if (readOnly) {
    toast("You're signed in as a viewer — read-only.");
    throw new ApiError(403, "Viewer sessions are read-only.");
  }
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`/api/projects/${projectId}/context/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  return (await res.json()) as ProjectContextEntry;
}

export function deleteContextEntry(projectId: string, entryId: string) {
  return req<{ ok: true }>("DELETE", `/api/projects/${projectId}/context/${entryId}`);
}

/** Manually re-run condensation (e.g. the operator wants a fresh read without
 *  adding/removing anything) — returns the updated Project. */
export function refreshProjectContext(projectId: string) {
  return req<Project>("POST", `/api/projects/${projectId}/context/refresh`);
}

// ─── Live preview (Phase-1: web/sites) ──────────────────────────────────────
export type PreviewSource = "main" | "merged" | "latest";
// "service" (Phase 2) rebuilds/restarts automatically when the fleet merges,
// instead of relying on the dev server's own HMR — see docs/live-preview.md.
export type PreviewKind = "web" | "service";
export interface PreviewState {
  status: "idle" | "starting" | "live" | "failed" | "stopped";
  url: string | null;
  port: number | null;
  recipe: { cmd: string; source: string } | null;
  error: string | null;
  logs: string[];
  startedAt: number | null;
  source: PreviewSource;
  combined: { total: number; included: number; skipped: number } | null;
  kind: PreviewKind;
}
export function previewStatus(projectId: string) {
  return req<PreviewState>("GET", `/api/projects/${projectId}/preview`);
}
export function previewStart(projectId: string, source?: PreviewSource) {
  return req<PreviewState>("POST", `/api/projects/${projectId}/preview/start`, source ? { source } : undefined);
}
export function previewStop(projectId: string) {
  return req<PreviewState>("POST", `/api/projects/${projectId}/preview/stop`);
}
export function previewRestart(projectId: string) {
  return req<PreviewState>("POST", `/api/projects/${projectId}/preview/restart`);
}
export function previewRefresh(projectId: string) {
  return req<PreviewState>("POST", `/api/projects/${projectId}/preview/refresh`);
}

// Per-run "Preview this change" — the run's own branch, pinned, pre-merge.
export function previewRunStatus(runId: string) {
  return req<PreviewState>("GET", `/api/runs/${runId}/preview`);
}
export function previewRunStart(runId: string) {
  return req<PreviewState>("POST", `/api/runs/${runId}/preview/start`);
}
export function previewRunStop(runId: string) {
  return req<PreviewState>("POST", `/api/runs/${runId}/preview/stop`);
}
export function previewRunRestart(runId: string) {
  return req<PreviewState>("POST", `/api/runs/${runId}/preview/restart`);
}

// ─── Deploy to Fly.io (persistent, human-triggered) ─────────────────────────
// A REAL, shareable URL that survives independent of the local Skynet process
// — distinct from the ephemeral local preview above. Explicit operator action
// only (a button in the UI); never auto-started or auto-torn-down. Two
// targets: a project's integration branch, or a single run's own branch (for
// pre-merge verification) — same shape, different endpoint prefix.
export interface FlyDeployState {
  status: "idle" | "deploying" | "live" | "failed" | "stopped";
  appName: string | null;
  region: string | null;
  url: string | null;
  branch: string | null;
  sha: string | null;
  error: string | null;
  logs: string[];
  deployedAt: number | null;
}
export function flyDeployStatus(projectId: string) {
  return req<FlyDeployState>("GET", `/api/projects/${projectId}/fly-deploy`);
}
export function flyDeployStart(projectId: string) {
  return req<FlyDeployState>("POST", `/api/projects/${projectId}/fly-deploy/start`);
}
export function flyDeployStop(projectId: string) {
  return req<FlyDeployState>("POST", `/api/projects/${projectId}/fly-deploy/stop`);
}
export function flyDeployRunStatus(runId: string) {
  return req<FlyDeployState>("GET", `/api/runs/${runId}/fly-deploy`);
}
export function flyDeployRunStart(runId: string) {
  return req<FlyDeployState>("POST", `/api/runs/${runId}/fly-deploy/start`);
}
export function flyDeployRunStop(runId: string) {
  return req<FlyDeployState>("POST", `/api/runs/${runId}/fly-deploy/stop`);
}

// Provider CLI installer — POSTs to /api/providers/:id/install and streams the
// npm output as text/plain deltas so the Settings modal can render live. On
// completion the caller re-fetches the snapshot to pick up the re-probed
// `binOnPath`. Falls back to a synchronous body read when the response isn't
// streamable (older runtime); the whole body is delivered as one onDelta call.
export async function streamInstallProvider(
  providerId: string,
  onDelta: (chunk: string) => void,
): Promise<void> {
  const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/install`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, body || res.statusText);
  }
  if (!res.body) {
    onDelta(await res.text().catch(() => ""));
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) onDelta(chunk);
  }
}

// Guarded kanban move (backlog→triage, triage→todo, review→done, demote, …).
// `preserve` (ongoing/review→todo only) pauses the run instead of discarding
// it — see Orchestrator.pauseRun.
export function transitionTask(projectId: string, taskId: string, to: string, preserve?: boolean) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/state`, { to, preserve });
}
// Escape hatch — force a task to `done` bypassing HUMAN_TRANSITIONS, and always
// sync the linked run's status. For when the normal review → done path fails.
export function forceTaskDone(projectId: string, taskId: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/force-done`);
}
// Steward-driven board tidy: priority-sort every non-done column, suggest
// any-agent eligibility for unassigned backlog tasks, archive everything in
// Done. See Operations.organizeBoard's doc comment.
export function organizeBoard(projectId: string) {
  return req<{ reordered: number; archived: number; assigned: number }>("POST", `/api/projects/${projectId}/organize`);
}
// Manual "Request review" — force a review pass now instead of waiting for a
// periodic tick to find an idle reviewer on its own. Throws (ApiError 409)
// with an honest, specific reason — already reviewed / no open gate / no
// reviewer free right now — for the caller to surface.
export function requestReview(projectId: string, taskId: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/request-review`);
}
// Manual "Request re-triage" — force a fresh triage pass on a task already
// parked in `triage` now, instead of waiting for it to cycle back through
// Backlog on its own. Throws (ApiError 409) with an honest, specific reason
// — not in triage / no agent idle right now — for the caller to surface.
export function requestRetriage(projectId: string, taskId: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/request-retriage`);
}
// Manual "Force to review" — pull a still-ongoing task's live run up for
// review right now instead of waiting for the agent to finish its own turn.
// Throws (ApiError 409) with an honest, specific reason — not ongoing / run
// not live / nothing changed yet — for the caller to surface.
export function forceReview(projectId: string, taskId: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/force-review`);
}
// Manual "Switch agent" — move a still-ongoing task's live run to a specific
// idle agent, keeping the same worktree/branch/committed work. Throws
// (ApiError 400) with an honest, specific reason — not ongoing / agent not
// found/busy/unusable — for the caller to surface; the live run is left
// untouched on failure.
export function reassignTaskAgent(projectId: string, taskId: string, agentId: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/reassign-agent`, { agentId });
}
export function moveTask(projectId: string, taskId: string, direction: "up" | "down") {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/move`, { direction });
}
/** Drag-reorder a task to sit before `beforeId` in its lane (null = end). */
export function reorderTask(projectId: string, taskId: string, beforeId: string | null) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/reorder`, { beforeId });
}

// Fleet
export function createAgent(body: { provider: string; model: string; name?: string; credentialId?: string; label?: string | null }) {
  return req<unknown>("POST", "/api/fleet/runners", body);
}
export function updateAgent(id: string, body: { model?: string; name?: string; canReview?: boolean; label?: string | null; credentialId?: string | null }) {
  return req<unknown>("PATCH", `/api/fleet/runners/${id}`, body);
}
export function deleteAgent(id: string) {
  return req<unknown>("DELETE", `/api/fleet/runners/${id}`);
}

// GitHub integration (connection + safety policy). Non-secret; the App key lives
// server-side only. See docs/github-integration.md.
export async function fetchGithub(): Promise<{ connection: GithubConnection; appConfigured: boolean; brokerConfigured: boolean }> {
  const raw = await req<{ connection: unknown; appConfigured: boolean; brokerConfigured?: boolean }>("GET", "/api/github");
  return { connection: GithubConnection.parse(raw.connection), appConfigured: !!raw.appConfigured, brokerConfigured: !!raw.brokerConfigured };
}

// Broker mode (GitHub App via cloud token-broker): device-flow login + pickers.
export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}
export function startGithubDevice() {
  return req<DeviceCode>("POST", "/api/github/device/start");
}
export function pollGithubDevice(deviceCode: string) {
  return req<{ authorized: boolean }>("POST", "/api/github/device/poll", { device_code: deviceCode });
}
// `credentialId` lists THAT pinned GitHub account's owners (business/personal —
// same selector as fetchGithubRepos); omit for the workspace default connection.
export async function fetchGithubOwners(credentialId?: string): Promise<GithubOwner[]> {
  const q = credentialId ? `?credentialId=${encodeURIComponent(credentialId)}` : "";
  const raw = await req<{ owners: GithubOwner[] }>("GET", `/api/github/owners${q}`);
  return raw.owners;
}
export async function fetchGithubInstallations(): Promise<GithubInstallation[]> {
  const raw = await req<{ installations: GithubInstallation[] }>("GET", "/api/github/installations");
  return raw.installations;
}
export async function fetchGithubInstallationRepos(installationId: number): Promise<GithubRepo[]> {
  const raw = await req<{ repos: GithubRepo[] }>("GET", `/api/github/installations/${installationId}/repos`);
  return raw.repos;
}
/** The repos the connection can currently bind — fetched live (a PAT connection
 *  re-lists all of its repos), so the picker isn't limited to a stale snapshot. */
export async function fetchGithubRepos(credentialId?: string): Promise<GithubRepo[]> {
  // A credentialId lists that GitHub account's repos (business/personal); omit for
  // the workspace's default connection.
  const q = credentialId ? `?credentialId=${encodeURIComponent(credentialId)}` : "";
  const raw = await req<{ repos: GithubRepo[] }>("GET", `/api/github/repos${q}`);
  return raw.repos;
}
export async function connectGithub(body: {
  installation: GithubInstallation;
  repos: GithubRepo[];
}): Promise<GithubConnection> {
  const raw = await req<{ connection: unknown }>("PUT", "/api/github", body);
  return GithubConnection.parse(raw.connection);
}
export async function connectGithubPat(token: string): Promise<GithubConnection> {
  const raw = await req<{ connection: unknown }>("PUT", "/api/github/pat", { token });
  return GithubConnection.parse(raw.connection);
}
export async function updateGithubSafety(patch: Partial<SafetyPolicy>): Promise<GithubConnection> {
  const raw = await req<{ connection: unknown }>("PUT", "/api/github/safety", patch);
  return GithubConnection.parse(raw.connection);
}
export async function disconnectGithub(): Promise<void> {
  await req<unknown>("DELETE", "/api/github");
}

// ─── WebSocket with auto-reconnect ─────────────────────────────────────────

// The live connection lifecycle, surfaced so the UI can show a real
// connect→connected state (and a retry affordance) instead of a dead-end
// "Connecting…" message. "connecting" = socket opening or backing off to
// retry; "open" = connected; "closed" = dropped, a reconnect is scheduled;
// "unauthorized" = the server rejected our token (1008) — show the login screen,
// don't reconnect (retrying the same bad token is futile).
export type WsPhase = "connecting" | "open" | "closed" | "unauthorized";

export interface Connection {
  /** Tear down for good (component unmount). */
  disconnect(): void;
  /** Force an immediate reconnect now, resetting backoff — the Retry button. */
  reconnect(): void;
}

export function connect(
  onMessage: (msg: WsMessage) => void,
  onPhase?: (phase: WsPhase) => void,
): Connection {
  let socket: WebSocket | null = null;
  let closed = false;
  let backoff = 500;
  let attempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  // Give up auto-reconnecting after this many consecutive failures and fall back
  // to the manual Retry button. A backend that isn't coming back (or a transport
  // that keeps dropping the socket) must not spin reconnects — and flood a
  // fragile tunnel — forever.
  const MAX_ATTEMPTS = 30;

  const phase = (p: WsPhase) => onPhase?.(p);

  const wsUrl = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws?token=${encodeURIComponent(token())}`;
  };

  const open = () => {
    if (closed) return;
    phase("connecting");
    const ws = new WebSocket(wsUrl());
    socket = ws;

    ws.onopen = () => {
      phase("open");
      // Only treat the connection as healthy — resetting the backoff + attempt
      // budget — once it has STAYED open a few seconds. Resetting eagerly here
      // means a flapping socket (opens, then drops mid-snapshot) never backs
      // off: it reconnects every 500ms forever, hammering the transport and
      // never finishing the initial snapshot.
      stableTimer = setTimeout(() => {
        backoff = 500;
        attempts = 0;
      }, 3_000);
    };
    ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      const result = WsMessage.safeParse(parsed);
      if (result.success) onMessage(result.data);
    };
    ws.onclose = (ev) => {
      if (closed) return;
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      // 1008 = the server rejected our token. Retrying with the same token is
      // futile, so surface an explicit "unauthorized" (→ login screen) instead
      // of spinning reconnects.
      if (ev.code === 1008) {
        phase("unauthorized");
        return;
      }
      phase("closed");
      attempts += 1;
      if (attempts >= MAX_ATTEMPTS) return; // stop; the Retry button revives it
      reconnectTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };
    ws.onerror = () => {
      ws.close();
    };
  };

  open();

  return {
    disconnect: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (stableTimer) clearTimeout(stableTimer);
      socket?.close();
    },
    reconnect: () => {
      if (closed) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      backoff = 500;
      attempts = 0; // a manual Retry restores the full auto-retry budget
      // Closing triggers onclose → schedules open(); short-circuit that and open
      // right away for a snappy Retry. If already open, this is a no-op reset.
      if (socket && socket.readyState === WebSocket.OPEN) return;
      open();
    },
  };
}

// ─── LLM-judged acceptance evals ───────────────────────────────────────────
// The standalone evals/ suite surfaced in the Acceptance view. Unlike the
// deterministic checks (client-side, instant), these are REAL runs the server
// spawns as a subprocess: a live agent + an LLM judge, minutes per scenario. So
// the flow is start → poll the job until it finishes.

export interface EvalRubric {
  dimension: string;
  question: string;
}
export interface EvalScenarioMeta {
  id: string;
  title: string;
  category: string;
  task: string;
  setup: string | null;
  rubric: EvalRubric[];
}
export interface EvalDimScore {
  dimension: string;
  score: number; // 0–5
  pass: boolean;
  rationale: string;
}
export interface EvalVerdict {
  pass: boolean;
  overall: number; // 0–5
  dimensions: EvalDimScore[];
  summary: string;
}
export interface EvalArtifacts {
  diff?: string;
  log?: string[];
  hitl?: { kind: string; title: string; why?: string; resolvedWith?: string }[];
  prOpened?: boolean;
  finalStatus?: string;
  turns?: number;
  tokens?: number;
  wallMs?: number;
  notes?: string;
}
export type EvalPhase = "queued" | "executing" | "judging" | "done" | "error";
export interface EvalJob {
  id: string;
  scenarioId: string;
  phase: EvalPhase;
  logs: string[];
  result?: { scenario: EvalScenarioMeta; artifacts: EvalArtifacts; verdict: EvalVerdict };
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export async function fetchEvals(): Promise<{
  scenarios: EvalScenarioMeta[];
  keyPresent: boolean;
  available: boolean;
  error?: string;
}> {
  return req("GET", "/api/evals");
}

export async function runEval(id: string): Promise<{ jobId: string }> {
  return req("POST", `/api/evals/${encodeURIComponent(id)}/run`);
}

export async function fetchEvalJob(jobId: string): Promise<EvalJob> {
  return req("GET", `/api/evals/jobs/${encodeURIComponent(jobId)}`);
}

// ─── Simulation behavioral judge ────────────────────────────────────────────
export interface SimStepEvidence {
  label: string;
  ok: boolean;
  skip?: boolean;
  detail?: string;
}
export interface SimJudgeEvidence {
  id: string;
  name: string;
  goal: string;
  steps: SimStepEvidence[];
  board: unknown;
}
export interface SimVerdict {
  pass: boolean;
  score: number;
  summary: string;
  findings: string[];
}
/** Ask the server's LLM judge to review a simulation journey's evidence. 503 if
 *  no Claude credential is configured (surfaced to the caller as an ApiError). */
export async function judgeSimulation(evidence: SimJudgeEvidence): Promise<SimVerdict> {
  return req("POST", "/api/simulation/judge", evidence);
}
