import {
  AuditRecord,
  GithubConnection,
  Snapshot,
  WsMessage,
  type TaskRun,
  type TaskAssignment,
  type GithubInstallation,
  type GithubOwner,
  type GithubRepo,
  type ResolveAction,
  type SafetyPolicy,
  type SecretMeta,
} from "@skynet/shared";

// ─── auth ───────────────────────────────────────────────────────────────────
// The session token drives both REST (Bearer) and the WS (?token=). It's set by
// login() below; the "dev-cyberdyne" fallback only resolves in a dev server
// (production disables dev tokens, so there the login screen is required).
const TOKEN_KEY = "skynet_token";
const token = () =>
  (typeof localStorage !== "undefined" && localStorage.getItem(TOKEN_KEY)) || "dev-cyberdyne";

/**
 * Exchange operator credentials for a session token (the one public route,
 * /api/auth/login) and persist it. On success the stored token authorizes both
 * REST and the WebSocket; callers reload so the app re-connects with it.
 */
export async function login(email: string, password: string): Promise<void> {
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
  const data = (await res.json()) as { token: string };
  if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, data.token);
}

// ─── REST helpers ─────────────────────────────────────────────────────────

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
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
export async function fetchAudit(): Promise<AuditRecord[]> {
  const raw = await req<unknown>("GET", "/api/audit");
  if (!Array.isArray(raw)) return [];
  const out: AuditRecord[] = [];
  for (const row of raw) {
    const parsed = AuditRecord.safeParse(row);
    if (parsed.success) out.push(parsed.data);
    else {
      const id = row && typeof row === "object" ? (row as { hitlId?: unknown }).hitlId : undefined;
      const paths = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      console.warn(`[audit] dropped invalid record ${String(id ?? "(no id)")}: ${paths}`);
    }
  }
  return out;
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

// HITL
export function resolveHitl(
  id: string,
  body: { action: ResolveAction; optionIndex?: number; guidance?: string; remember?: boolean },
) {
  return req<unknown>("POST", `/api/hitl/${id}/resolve`, body);
}

// TaskRun chat / fork
export function sendAgentMessage(id: string, text: string) {
  return req<{ reply: string }>("POST", `/api/runs/${id}/messages`, { text });
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

// Provider secrets (Settings). `env` = providers a server env var supplies a
// key for (a stored key overrides it).
export function fetchSecrets() {
  return req<{ secrets: SecretMeta[]; env: string[] }>("GET", "/api/secrets");
}
// Set or rotate a credential's key by id — a provider id targets that provider's
// DEFAULT credential; a `cred-…` id rotates an existing named one.
export function setSecret(id: string, apiKey: string) {
  return req<{ secret: SecretMeta }>("PUT", `/api/secrets/${id}`, { apiKey });
}
export function deleteSecret(id: string) {
  return req<unknown>("DELETE", `/api/secrets/${id}`);
}
// Create a NAMED credential — a second key for a provider that already has one
// ("Claude on another account"). Agents can then be pinned to it via credentialId.
export function createCredential(provider: string, name: string, apiKey: string) {
  return req<{ secret: SecretMeta }>("POST", "/api/credentials", { provider, name, apiKey });
}

// ─── Service tokens (MCP / programmatic access) ────────────────────────────
// Scoped API tokens for runs driving Skynet over MCP. The raw token is
// returned ONCE at creation; list only ever yields non-secret metadata.
export type McpScope = "observe" | "author" | "approver" | "admin";

export interface ServiceTokenMeta {
  id: string;
  label: string;
  scopes: McpScope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  last4: string;
}

export function listServiceTokens() {
  return req<ServiceTokenMeta[]>("GET", "/api/service-tokens");
}
export function createServiceToken(body: { label: string; scopes: McpScope[]; ttlMs?: number | null }) {
  return req<{ token: string; id: string; scopes: McpScope[]; label: string; expiresAt: number | null }>(
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
export function createProject(body: {
  name: string;
  goal: string;
  repoPath?: string;
  repo?: string;
  createRepo?: { name: string; private: boolean; owner?: string };
  autonomy?: boolean;
  approvalLevel?: string;
}) {
  return req<unknown>("POST", "/api/projects", body);
}
export function updateProject(
  id: string,
  body: { name?: string; goal?: string; status?: string; autonomy?: boolean; approvalLevel?: string; repoPath?: string | null },
) {
  return req<unknown>("PATCH", `/api/projects/${id}`, body);
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
    | "rename_project"
    | "set_goal"
    | "set_autonomy"
    | "set_status"
    | "set_schedule"
    | "set_assignment";
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
}
// Global Steward chat (the sidebar dock). `projectId` focuses the page you're on
// (full project assistant + actions); omit it for a workspace-wide answer. The
// response echoes which project the action (if any) targets.
export function stewardChat(
  question: string,
  history: { role: "user" | "assistant"; content: string }[],
  projectId?: string,
) {
  return req<{ reply: string; action?: AssistantAction | null; actions?: AssistantAction[]; projectId?: string | null }>(
    "POST",
    "/api/steward/chat",
    { question, history, projectId },
  );
}

// ─── Live preview (Phase-1: web/sites) ──────────────────────────────────────
export interface PreviewState {
  status: "idle" | "starting" | "live" | "failed" | "stopped";
  url: string | null;
  port: number | null;
  recipe: { cmd: string; source: string } | null;
  error: string | null;
  logs: string[];
  startedAt: number | null;
}
export function previewStatus(projectId: string) {
  return req<PreviewState>("GET", `/api/projects/${projectId}/preview`);
}
export function previewStart(projectId: string) {
  return req<PreviewState>("POST", `/api/projects/${projectId}/preview/start`);
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
export function transitionTask(projectId: string, taskId: string, to: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/state`, { to });
}
// Escape hatch — force a task to `done` bypassing HUMAN_TRANSITIONS, and always
// sync the linked run's status. For when the normal review → done path fails.
export function forceTaskDone(projectId: string, taskId: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/force-done`);
}
export function moveTask(projectId: string, taskId: string, direction: "up" | "down") {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/move`, { direction });
}
/** Drag-reorder a task to sit before `beforeId` in its lane (null = end). */
export function reorderTask(projectId: string, taskId: string, beforeId: string | null) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks/${taskId}/reorder`, { beforeId });
}

// Fleet
export function createAgent(body: { provider: string; model: string; name?: string; credentialId?: string }) {
  return req<unknown>("POST", "/api/fleet/runners", body);
}
export function updateAgent(id: string, body: { model?: string; name?: string }) {
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
export async function fetchGithubOwners(): Promise<GithubOwner[]> {
  const raw = await req<{ owners: GithubOwner[] }>("GET", "/api/github/owners");
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
