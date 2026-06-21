import {
  AuditRecord,
  Snapshot,
  WsMessage,
  type Agent,
  type ResolveAction,
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

// Projects
export function createProject(body: { name: string; goal: string }) {
  return req<unknown>("POST", "/api/projects", body);
}
export function updateProject(
  id: string,
  body: { name?: string; goal?: string; status?: string },
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
