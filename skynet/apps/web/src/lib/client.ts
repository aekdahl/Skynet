import {
  AuditRecord,
  GithubConnection,
  Snapshot,
  WsMessage,
  type Agent,
  type GithubInstallation,
  type GithubRepo,
  type ResolveAction,
  type SafetyPolicy,
  type SecretMeta,
} from "@skynet/shared";

// ─── auth ───────────────────────────────────────────────────────────────────
// Dev token; swap via localStorage.setItem('skynet_token', '…'). Real auth later.
const token = () =>
  (typeof localStorage !== "undefined" && localStorage.getItem("skynet_token")) || "dev-cyberdyne";

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
export async function fetchAudit(): Promise<AuditRecord[]> {
  const raw = await req<unknown>("GET", "/api/audit");
  return AuditRecord.array().parse(raw);
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
  body: { action: ResolveAction; optionIndex?: number; guidance?: string },
) {
  return req<unknown>("POST", `/api/hitl/${id}/resolve`, body);
}

// Agent chat / fork
export function sendAgentMessage(id: string, text: string) {
  return req<{ reply: string }>("POST", `/api/agents/${id}/messages`, { text });
}
export function forkAgent(id: string) {
  return req<unknown>("POST", `/api/agents/${id}/fork`);
}
export function stopAgent(id: string) {
  return req<Agent>("POST", `/api/agents/${id}/stop`);
}
export function archiveAgent(id: string, archived: boolean) {
  return req<unknown>("POST", `/api/agents/${id}/archive`, { archived });
}
export function pauseAgent(id: string) {
  return req<unknown>("POST", `/api/agents/${id}/pause`);
}
export function resumeAgent(id: string) {
  return req<unknown>("POST", `/api/agents/${id}/resume`);
}

// Provider secrets (Settings). `env` = providers a server env var supplies a
// key for (a stored key overrides it).
export function fetchSecrets() {
  return req<{ secrets: SecretMeta[]; env: string[] }>("GET", "/api/secrets");
}
export function setSecret(provider: string, apiKey: string) {
  return req<{ secret: SecretMeta }>("PUT", `/api/secrets/${provider}`, { apiKey });
}
export function deleteSecret(provider: string) {
  return req<unknown>("DELETE", `/api/secrets/${provider}`);
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
}
/** List subfolders of `path` (default: home) on the server machine. */
export function browseFolder(path?: string) {
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  return req<FsListing>("GET", `/api/fs/list${q}`);
}

// Projects
export function createProject(body: { name: string; goal: string; repoPath?: string; repo?: string }) {
  return req<unknown>("POST", "/api/projects", body);
}
export function updateProject(
  id: string,
  body: { name?: string; goal?: string; status?: string; repoPath?: string | null },
) {
  return req<unknown>("PATCH", `/api/projects/${id}`, body);
}
export function deleteProject(id: string) {
  return req<unknown>("DELETE", `/api/projects/${id}`);
}

// Tasks
export function createTask(projectId: string, text: string) {
  return req<unknown>("POST", `/api/projects/${projectId}/tasks`, { text });
}
export function updateTask(
  projectId: string,
  taskId: string,
  body: { text?: string; state?: string },
) {
  return req<unknown>("PATCH", `/api/projects/${projectId}/tasks/${taskId}`, body);
}
export function deleteTask(projectId: string, taskId: string) {
  return req<unknown>("DELETE", `/api/projects/${projectId}/tasks/${taskId}`);
}
export function assignTask(projectId: string, taskId: string) {
  return req<Agent>("POST", `/api/projects/${projectId}/tasks/${taskId}/assign`);
}

// Fleet
export function createRunner(body: { provider: string; model: string; name?: string }) {
  return req<unknown>("POST", "/api/fleet/runners", body);
}
export function updateRunner(id: string, body: { model?: string; name?: string }) {
  return req<unknown>("PATCH", `/api/fleet/runners/${id}`, body);
}
export function deleteRunner(id: string) {
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

export function connect(onMessage: (msg: WsMessage) => void): () => void {
  let socket: WebSocket | null = null;
  let closed = false;
  let backoff = 500;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const wsUrl = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws?token=${encodeURIComponent(token())}`;
  };

  const open = () => {
    if (closed) return;
    const ws = new WebSocket(wsUrl());
    socket = ws;

    ws.onopen = () => {
      backoff = 500;
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
    ws.onclose = () => {
      if (closed) return;
      reconnectTimer = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };
    ws.onerror = () => {
      ws.close();
    };
  };

  open();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
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
