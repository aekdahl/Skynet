/**
 * LLM-driven, non-deterministic E2E for Skynet.
 *
 * A Claude "driver" is given a persona + goal and a set of Skynet API tools, and
 * decides for itself how to exercise the running system (no fixed script — the
 * action sequence varies run to run). A separate Claude "judge" then reads the
 * transcript + the final server state and returns a structured verdict against
 * the scenario's acceptance criteria. This complements the deterministic Vitest
 * suite: deterministic tests catch regressions on known paths; the LLM explorer
 * finds the things nobody wrote an assertion for.
 *
 * Zero dependencies — talks HTTP to the server and to the Anthropic Messages API
 * via global fetch (Node ≥ 18/22).
 *
 * Run (against an already-running seeded server):
 *   STORE=memory BUS=memory SESSIONS=memory AUTH_REQUIRED=true SKYNET_SEED=true \
 *     PORT=8093 pnpm --filter @skynet/server dev &
 *   ANTHROPIC_API_KEY=sk-... BASE=http://localhost:8093 \
 *     pnpm tsx docs/qa/llm-e2e/run.ts
 *
 * Exit code: 0 if every scenario's judge PASSes with no High/Med defects; 1 otherwise.
 * Skips (exit 0) with a message if ANTHROPIC_API_KEY is unset, so CI stays green
 * until wired into a credentialed nightly job.
 */

import { SCENARIOS, type Scenario } from "./scenarios.js";

const BASE = process.env.BASE ?? "http://localhost:8093";
const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const DRIVER_MODEL = process.env.LLM_E2E_DRIVER_MODEL ?? "claude-sonnet-4-6";
const JUDGE_MODEL = process.env.LLM_E2E_JUDGE_MODEL ?? "claude-opus-4-8";
const MAX_TURNS = Number(process.env.LLM_E2E_MAX_TURNS ?? 24);
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// ─── Skynet API tools the driver may call ──────────────────────────────────
// A small domain tool-set keeps the agent on-task while leaving the *sequence*
// entirely up to it. `raw_request` is the escape hatch for edge/negative probing.

type Json = Record<string, unknown>;
const tool = (name: string, description: string, properties: Json, required: string[] = []) => ({
  name,
  description,
  input_schema: { type: "object", properties, required },
});

const TOOLS = [
  tool("get_snapshot", "Full workspace snapshot: agents, queue (HITL), projects, tasks, fleet, providers.", {}),
  tool("get_audit", "The decision audit trail (resolved HITL decisions, newest first).", {}),
  tool("list_providers", "Providers + models + availability.", {}),
  tool("resolve_hitl", "Resolve a HITL queue item.", {
    hitlId: { type: "string" },
    action: { type: "string", enum: ["approve", "reject", "modify", "option"] },
    optionIndex: { type: "number" },
    guidance: { type: "string" },
  }, ["hitlId", "action"]),
  tool("chat_agent", "Send a message to an agent.", { agentId: { type: "string" }, text: { type: "string" } }, ["agentId", "text"]),
  tool("fork_agent", "Fork an agent.", { agentId: { type: "string" } }, ["agentId"]),
  tool("create_project", "Create a project. Optionally bind it to a local folder (repoPath, absolute path) and/or a connected GitHub repo (repo, 'owner/repo').", { name: { type: "string" }, goal: { type: "string" }, repoPath: { type: "string" }, repo: { type: "string" } }, ["name"]),
  tool("add_task", "Add a task to a project.", { projectId: { type: "string" }, text: { type: "string" } }, ["projectId", "text"]),
  tool("assign_task", "Assign a task (spins up an agent on an idle runner).", { projectId: { type: "string" }, taskId: { type: "string" } }, ["projectId", "taskId"]),
  tool("add_runner", "Add a fleet runner.", { provider: { type: "string" }, model: { type: "string" }, name: { type: "string" } }, ["provider", "model"]),
  tool("archive_agent", "Archive (hide from the board) or restore an agent.", { agentId: { type: "string" }, archived: { type: "boolean" } }, ["agentId", "archived"]),
  tool("get_github", "GitHub connection + safety policy + whether the App/broker are configured.", {}),
  tool("set_secret", "Store a provider API key (write-only — only last4 is ever returned).", { provider: { type: "string" }, apiKey: { type: "string" } }, ["provider", "apiKey"]),
  tool("list_secrets", "Configured provider keys (metadata only — provider + last4, never the key) + env-backed providers.", {}),
  tool("delete_secret", "Remove a stored provider key.", { provider: { type: "string" } }, ["provider"]),
  tool("login", "POST /api/auth/login for a session token.", { email: { type: "string" }, password: { type: "string" } }, ["email", "password"]),
  tool("logout", "Invalidate the current session token.", {}),
  tool("raw_request", "Escape hatch: any HTTP request to the API (for negative/edge probing). body is a JSON string. Optional token overrides the current auth token — e.g. pass 'dev-resistance' to probe cross-tenant access.", {
    method: { type: "string" }, path: { type: "string" }, body: { type: "string" }, token: { type: "string" },
  }, ["method", "path"]),
  tool("finish", "Call when done; summarize what you exercised and anything suspicious.", { summary: { type: "string" } }, ["summary"]),
];

async function apiFetch(method: string, path: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed };
}

/** Execute one driver tool call against the live API. `state.token` is mutable (login/logout). */
async function execTool(name: string, input: Json, state: { token: string }): Promise<unknown> {
  const t = state.token;
  switch (name) {
    case "get_snapshot": return apiFetch("GET", "/api/snapshot", t);
    case "get_audit": return apiFetch("GET", "/api/audit", t);
    case "list_providers": return apiFetch("GET", "/api/providers", t);
    case "resolve_hitl": {
      const b: Json = { action: input.action };
      if (input.optionIndex !== undefined) b.optionIndex = input.optionIndex;
      if (input.guidance !== undefined) b.guidance = input.guidance;
      return apiFetch("POST", `/api/hitl/${input.hitlId}/resolve`, t, b);
    }
    case "chat_agent": return apiFetch("POST", `/api/agents/${input.agentId}/messages`, t, { text: input.text });
    case "fork_agent": return apiFetch("POST", `/api/agents/${input.agentId}/fork`, t);
    case "create_project": {
      const b: Json = { name: input.name, goal: input.goal ?? "" };
      if (input.repoPath !== undefined) b.repoPath = input.repoPath;
      if (input.repo !== undefined) b.repo = input.repo;
      return apiFetch("POST", "/api/projects", t, b);
    }
    case "add_task": return apiFetch("POST", `/api/projects/${input.projectId}/tasks`, t, { text: input.text });
    case "assign_task": return apiFetch("POST", `/api/projects/${input.projectId}/tasks/${input.taskId}/assign`, t);
    case "add_runner": return apiFetch("POST", "/api/fleet/runners", t, { provider: input.provider, model: input.model, name: input.name });
    case "archive_agent": return apiFetch("POST", `/api/agents/${input.agentId}/archive`, t, { archived: input.archived });
    case "get_github": return apiFetch("GET", "/api/github", t);
    case "set_secret": return apiFetch("PUT", `/api/secrets/${input.provider}`, t, { apiKey: input.apiKey });
    case "list_secrets": return apiFetch("GET", "/api/secrets", t);
    case "delete_secret": return apiFetch("DELETE", `/api/secrets/${input.provider}`, t);
    case "login": {
      const r = await apiFetch("POST", "/api/auth/login", t, { email: input.email, password: input.password });
      const tok = (r.body as { token?: string })?.token;
      if (tok) state.token = tok;
      return r;
    }
    case "logout": return apiFetch("POST", "/api/auth/logout", t);
    case "raw_request": {
      let body: unknown;
      if (typeof input.body === "string" && input.body) { try { body = JSON.parse(input.body); } catch { body = input.body; } }
      const tok = typeof input.token === "string" && input.token ? input.token : t;
      return apiFetch(String(input.method).toUpperCase(), String(input.path), tok, body);
    }
    default: return { error: `unknown tool ${name}` };
  }
}

// ─── Anthropic Messages API (fetch, no SDK) ─────────────────────────────────

interface AnthropicMessage { role: "user" | "assistant"; content: unknown }

async function callClaude(model: string, system: string, messages: AnthropicMessage[], tools?: unknown[]) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 2048, system, messages, ...(tools ? { tools } : {}) }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{ stop_reason: string; content: Array<Json> }>;
}

// ─── Driver loop ────────────────────────────────────────────────────────────

interface RunLog { scenario: string; turns: number; finished: string | null; toolCalls: Array<{ name: string; input: Json; result: unknown }> }

async function driveScenario(s: Scenario): Promise<RunLog> {
  const state = { token: s.token };
  const system =
    `You are an autonomous end-to-end tester of the Skynet control-plane API. Persona: ${s.persona}. ` +
    `Goal: ${s.goal} Act like a real user with intent — vary your actions, verify results, and probe edge cases you think of. ` +
    `Use the provided tools only. When you have thoroughly exercised the goal (or hit something broken), call finish with a summary.`;
  const messages: AnthropicMessage[] = [{ role: "user", content: "Begin. Explore the system toward your goal." }];
  const toolCalls: RunLog["toolCalls"] = [];
  let finished: string | null = null;

  for (let turn = 0; turn < MAX_TURNS && finished === null; turn++) {
    const resp = await callClaude(DRIVER_MODEL, system, messages, TOOLS);
    messages.push({ role: "assistant", content: resp.content });
    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) break; // model spoke without acting — nudge or stop
    const results: Json[] = [];
    for (const tu of toolUses) {
      const name = tu.name as string;
      const input = (tu.input ?? {}) as Json;
      if (name === "finish") { finished = String(input.summary ?? ""); results.push({ type: "tool_result", tool_use_id: tu.id, content: "ack" }); continue; }
      const result = await execTool(name, input, state);
      toolCalls.push({ name, input, result });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result).slice(0, 4000) });
    }
    messages.push({ role: "user", content: results });
  }
  return { scenario: s.name, turns: toolCalls.length, finished, toolCalls };
}

// ─── Judge ──────────────────────────────────────────────────────────────────

interface Verdict { passed: boolean; defects: Array<{ severity: string; summary: string; evidence: string }>; notes: string }

async function judge(s: Scenario, log: RunLog, finalState: unknown): Promise<Verdict> {
  const system =
    "You are a strict QA judge. Given an autonomous tester's tool-call transcript against the Skynet API, the scenario's " +
    "acceptance criteria, and the final server state, decide if the system behaved correctly. A 500 on any request, a 4xx where " +
    "success was expected (or 2xx where rejection was expected), cross-workspace data leakage, lost writes, or broken invariants " +
    "are defects. Reply with ONLY a JSON object: " +
    `{"passed": boolean, "defects": [{"severity":"High|Med|Low","summary":string,"evidence":string}], "notes": string}.`;
  const user =
    `ACCEPTANCE CRITERIA:\n${s.acceptance}\n\n` +
    `TOOL-CALL TRANSCRIPT (name, input, {status,body}):\n${JSON.stringify(log.toolCalls).slice(0, 40000)}\n\n` +
    `DRIVER'S FINAL SUMMARY: ${log.finished ?? "(did not call finish)"}\n\n` +
    `FINAL /api/snapshot + /api/audit:\n${JSON.stringify(finalState).slice(0, 12000)}`;
  const resp = await callClaude(JUDGE_MODEL, system, [{ role: "user", content: user }]);
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text as string).join("");
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text) as Verdict; }
  catch { return { passed: false, defects: [{ severity: "Low", summary: "judge output unparseable", evidence: text.slice(0, 300) }], notes: "" }; }
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function main() {
  if (!API_KEY) {
    console.log("⏭  LLM-E2E skipped: set ANTHROPIC_API_KEY to run. (Deterministic Vitest suite covers regressions.)");
    process.exit(0);
  }
  console.log(`LLM-E2E · driver=${DRIVER_MODEL} judge=${JUDGE_MODEL} · target=${BASE}\n`);
  // Optional focus: SCENARIO=<name substring> runs a subset (default: all).
  const only = process.env.SCENARIO;
  const scenarios = only ? SCENARIOS.filter((s) => s.name.includes(only)) : SCENARIOS;
  if (only && scenarios.length === 0) {
    console.error(`No scenario matches SCENARIO=${only}. Available: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
  let failed = 0;
  for (const s of scenarios) {
    process.stdout.write(`▶ ${s.name} … `);
    const log = await driveScenario(s);
    const finalState = {
      snapshot: (await apiFetch("GET", "/api/snapshot", s.token)).body,
      audit: (await apiFetch("GET", "/api/audit", s.token)).body,
    };
    const v = await judge(s, log, finalState);
    const bad = v.defects.filter((d) => d.severity !== "Low");
    const ok = v.passed && bad.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} (${log.turns} actions)`);
    for (const d of v.defects) console.log(`    [${d.severity}] ${d.summary} — ${d.evidence}`);
    if (v.notes) console.log(`    notes: ${v.notes}`);
  }
  console.log(`\n${failed === 0 ? `✅ all ${scenarios.length} scenario(s) passed` : `❌ ${failed}/${scenarios.length} scenario(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
