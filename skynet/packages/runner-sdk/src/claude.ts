// ─── Claude Code runner ───────────────────────────────────────────────────
// A real RunnerProvider backed by @anthropic-ai/claude-agent-sdk. This is the
// Phase-A spike that validates the runner-sdk control contract against a real
// agent: streaming-input session, a blocking `canUseTool` permission callback
// mapped to a HITL approval gate, interrupt(), and session resume for fork.
//
// Selected via RUNNER=claude. The default RUNNER=mock path is untouched.

import {
  query,
  resolveSettings,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { PlanStep, ProviderId, Resolution } from "@skynet/shared";
import { fmtDuration, idleCapMs, runtimeCapMs } from "./caps.js";
import type {
  ConsultSpec,
  HitlRaise,
  RunnerEvents,
  RunnerHandle,
  RunnerProvider,
  StartSpec,
} from "./types.js";

// ─── Filesystem settings sources ───────────────────────────────────────────
// Options.settingSources controls which of the CLI's own filesystem config the
// SDK loads for a session. OMITTING it (the SDK's default) loads ALL of them —
// including a repo's own `.claude/settings.json`, whose `hooks` block runs
// arbitrary shell commands on matching lifecycle events (PreToolUse, Stop, …).
// Those hooks are NOT gated by canUseTool below — canUseTool only intercepts
// tool-call *permission*, not settings-defined hook *execution* — so leaving
// settingSources unset means every run silently trusts whatever `cwd` (an
// operator-cloned or agent-touched repo) happens to contain. This app treats
// repo-authored shell as needing review everywhere else (see command-safety.ts,
// the whole HITL-gate design); filesystem settings shouldn't be the one
// exception. So every query() in this file sets settingSources explicitly:
//
//   - Isolated (no filesystem settings at all) for every side-query that has
//     no per-action human review — the one-shot consult/repo-assistant helpers
//     below. They don't need CLAUDE.md (the repo-assistant can just Read it),
//     and there's no gate to catch a hook if one were loaded.
//   - The MAIN agent run deliberately opts back in to 'project' — see
//     PROJECT_SETTING_SOURCES below — so CLAUDE.md loads (the SDK's own doc:
//     "Must include 'project' to load CLAUDE.md files"). Confirmed empirically
//     via the SDK's resolveSettings() that 'project' is NOT separable from the
//     same repo's `.claude/settings.json` hooks in this SDK version (0.3.179):
//     asking for one loads the other. scanRepoHooks()/buildHookRaise() below
//     close that gap with a mandatory approval gate, raised BEFORE the session
//     (and any hooks) can start, whenever hooks are present.
const NO_FS_SETTINGS: SettingSource[] = [];
const PROJECT_SETTING_SOURCES: SettingSource[] = ["project"];

// A push-driven async iterable of user messages — keeps the session live so we
// can inject chat / modify-guidance mid-run (streaming input mode).
function createInputStream() {
  const buffer: SDKUserMessage[] = [];
  let waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;
  const wrap = (text: string): SDKUserMessage =>
    ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } } as SDKUserMessage);
  return {
    push(text: string) {
      if (closed) return;
      const msg = wrap(text);
      if (waiting) { waiting({ value: msg, done: false }); waiting = null; }
      else buffer.push(msg);
    },
    close() {
      closed = true;
      if (waiting) { waiting({ value: undefined as never, done: true }); waiting = null; }
    },
    async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      for (;;) {
        if (buffer.length) { yield buffer.shift()!; continue; }
        if (closed) return;
        const next = await new Promise<IteratorResult<SDKUserMessage>>((r) => (waiting = r));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

// Tools that run without a mid-run human gate. This is deliberately more than
// just read-only tools: file EDITS are included because every change the agent
// makes is captured in its own worktree and reviewed as a whole in the
// end-of-run diff-review HITL — so pausing for per-edit approval is needless
// over-gating (a one-word comment fix shouldn't block on a human). Human control
// is kept where it matters: the whole-diff review, decisions the agent raises
// (AskUserQuestion → a `question` gate), and the genuinely risky/irreversible
// surface — shell commands (Bash) and anything unrecognized still gate below.
const AUTO_ALLOW = new Set([
  // read-only
  "Read", "LS", "Glob", "Grep", "NotebookRead", "TodoWrite",
  // file edits — reviewed wholesale in the diff-review gate, not per call
  "Edit", "MultiEdit", "Write", "NotebookEdit",
]);

// While a plan-mode-gated run (see StartSpec.planModeGate) hasn't had its plan
// approved yet, ONLY these are auto-allowed — read-only investigation plus the
// agent's own TodoWrite step-tracking. Everything else, including the file
// edits AUTO_ALLOW normally lets through, is denied outright (not gated) so
// the agent stays in planning until the operator approves its ExitPlanMode
// call. Deliberately a separate, narrower set from AUTO_ALLOW rather than a
// filtered view of it — the two answer different questions (what needs no
// gate at all vs. what's allowed before a plan exists).
const PLAN_MODE_ALLOW = new Set(["Read", "LS", "Glob", "Grep", "NotebookRead", "TodoWrite"]);

/**
 * Does `toolName` run without a blocking mid-run approval? True for read-only
 * tools and file edits (edits ride the end-of-run diff review). False for the
 * risky/irreversible surface — shell commands (Bash) and anything unrecognized —
 * which raises an approval gate. (AskUserQuestion is handled separately: it's a
 * decision the agent raises, surfaced as a `question` gate, not an approval.)
 */
export function isAutoAllowed(toolName: string): boolean {
  return AUTO_ALLOW.has(toolName);
}

// Opt-in browser tooling. When a run has `browser` set (from the per-workspace
// `browserTools` setting), we hand the SDK a Playwright/Chrome MCP server so the
// agent can drive a real browser — reproduce a bug, verify a UI change, read live
// docs. We WRAP an existing server (Microsoft's @playwright/mcp) rather than build
// our own automation; the SDK spawns it over stdio and surfaces its tools as
// `mcp__browser__…`, which — being outside AUTO_ALLOW — gate through the normal
// HITL approval like any other non-read action. Runs headless + isolated so it
// works on a server with no display and leaves no persistent profile behind.
// `SKYNET_BROWSER_MCP_COMMAND` overrides the launch command (space-separated) for
// pinning a version, a private mirror, or a Chrome-channel flavour.
const BROWSER_MCP_NAME = "browser";
export function browserMcpServers(enabled: boolean): NonNullable<Options["mcpServers"]> | undefined {
  if (!enabled) return undefined;
  const override = process.env.SKYNET_BROWSER_MCP_COMMAND?.trim();
  const parts = override
    ? override.split(/\s+/).filter(Boolean)
    : ["npx", "-y", "@playwright/mcp@latest", "--headless", "--isolated"];
  const command = parts[0] ?? "npx";
  return { [BROWSER_MCP_NAME]: { command, args: parts.slice(1) } };
}

// Map a Fleet model slug to what the Claude Code SDK expects. The friendly
// catalog slugs (opus-*/sonnet-*/haiku-*/fable-*) map to the CLI aliases; ANY
// other non-empty value passes through verbatim, so a model released after our
// catalog — picked via the Fleet "custom model" option, e.g. a full id like
// "claude-opus-4-9-…" — still reaches the SDK instead of being silently dropped.
// Empty → undefined = the SDK's own default.
const mapModel = (m: string): string | undefined =>
  m.startsWith("fable") ? "claude-fable-5"
    : m.startsWith("opus") ? "opus"
    : m.startsWith("sonnet") ? "sonnet"
    : m.startsWith("haiku") ? "haiku"
    : m.trim() || undefined;

// Build the env handed to the TaskRun SDK subprocess. `Options.env` REPLACES the
// subprocess environment, so we spread the ambient env (PATH/HOME/…) and then
// drop the markers that would route a nested Claude Code child to host-managed
// OAuth — a standalone server can't satisfy that path and would 401.
//
// Accepted credentials (any one authenticates the SDK): ANTHROPIC_API_KEY, a
// subscription token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN), or a
// gateway bearer token (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL). We only
// strip the gateway credentials when a static ANTHROPIC_API_KEY would shadow
// them, or when a NESTED Claude Code session's host-managed gateway would 401 a
// standalone server. CLAUDE_CODE_OAUTH_TOKEN is a real standalone credential, so
// it is preserved while the other CLAUDE_CODE_* session markers are dropped.
export function buildRunnerEnv(): Record<string, string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // A nested Claude Code session is signalled by CLAUDE_CODE_* markers *other*
  // than a deliberately-set OAuth token; its inherited gateway creds 401.
  const nestedSession = Object.keys(process.env).some(
    (k) => k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN",
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    // Drop nested child-session markers, but keep a real OAuth token.
    if (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN") continue;
    // Drop inherited gateway auth when a static key shadows it, or when a nested
    // session's host-managed gateway would 401 standalone.
    if ((apiKey || nestedSession) && (k === "ANTHROPIC_BASE_URL" || k === "ANTHROPIC_AUTH_TOKEN")) continue;
    env[k] = v;
  }
  return env;
}

// Anthropic streaming: content_block_delta → { delta: { type:"text_delta", text } }.
// Requires `includePartialMessages: true` in the query options, else the SDK
// never emits `stream_event` messages at all. Shared by every place that reads
// token-level deltas — the one-shot streaming helpers below AND the live
// ClaudeRunnerHandle.drain() loop — so the extraction is proven in one place.
function textDeltaOf(msg: SDKMessage): string | null {
  if (msg.type !== "stream_event") return null;
  const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
  return ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text
    ? ev.delta.text
    : null;
}

/**
 * Yield an SDK query's answer as text deltas. With `includePartialMessages` the
 * SDK emits `stream_event`s carrying token-level `text_delta`s — we yield those
 * live. The final `assistant` message is a safety net: if partials didn't arrive
 * (older transport / tool turns), emit any text not already streamed. A failure
 * yields one apologetic chunk, but only if nothing was emitted yet. Shared by
 * every one-shot streaming helper below.
 */
async function* streamQueryText(q: AsyncIterable<SDKMessage>): AsyncGenerator<string> {
  let emitted = "";
  try {
    for await (const msg of q) {
      const delta = textDeltaOf(msg);
      if (delta) {
        emitted += delta;
        yield delta;
      } else if (msg.type === "assistant") {
        // Safety net: emit any final text the partial stream didn't already cover.
        // (A tool-using assistant emits a fresh text block per turn; only the
        // trailing answer extends `emitted`, so guard on the startsWith prefix.)
        const { text } = readAssistant((msg as { message: { content?: unknown } }).message);
        if (text && text.length > emitted.length && text.startsWith(emitted)) {
          const suffix = text.slice(emitted.length);
          emitted += suffix;
          yield suffix;
        } else if (text && !emitted) {
          emitted = text;
          yield text;
        }
      } else if (msg.type === "result") {
        break;
      }
    }
  } catch (err) {
    if (!emitted) yield `couldn't look into that right now (${(err as Error).message}).`;
  }
}

/** A one-shot, tool-less consult that STREAMS the answer as text deltas. */
async function* oneShotConsultStream(opts: {
  prompt: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
}): AsyncGenerator<string> {
  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      model: mapModel(opts.model),
      permissionMode: "default",
      // Deny every tool so this stays a pure text answer.
      canUseTool: () => Promise.resolve({ behavior: "deny", message: "Answer in text only; do not use tools." } as PermissionResult),
      maxTurns: 4,
      env: opts.env,
      includePartialMessages: true,
      // Isolated — see the settingSources block near the top of this file.
      settingSources: NO_FS_SETTINGS,
    },
  });
  yield* streamQueryText(q as AsyncIterable<SDKMessage>);
}

/** Accumulating (non-streaming) consult — the whole answer, or `fallback` if
 *  empty. Delegates to {@link oneShotConsultStream} so both share one query. */
async function oneShotConsult(opts: {
  prompt: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
  fallback: string;
}): Promise<string> {
  let answer = "";
  for await (const delta of oneShotConsultStream(opts)) answer += delta;
  return answer.trim() || opts.fallback;
}

/** A one-shot, tool-less text query authenticated exactly like a live runner
 *  (via {@link buildRunnerEnv} — so it works standalone AND nested inside a
 *  Claude Code session, where a raw `fetch` to the API has no egress). Used by
 *  out-of-band callers such as the eval judge. Returns the model's text. */
export async function oneShotText(opts: { prompt: string; model?: string; cwd?: string; apiKey?: string }): Promise<string> {
  let out = "";
  for await (const delta of oneShotTextStream(opts)) out += delta;
  return out;
}

/** Streaming variant of {@link oneShotText} — yields the answer as text deltas. */
export function oneShotTextStream(opts: {
  prompt: string;
  model?: string;
  cwd?: string;
  apiKey?: string;
}): AsyncIterable<string> {
  const env = buildRunnerEnv();
  if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;
  return oneShotConsultStream({
    prompt: opts.prompt,
    cwd: opts.cwd ?? process.cwd(),
    model: opts.model ?? "opus",
    env,
  });
}

// Read-only tools a repo-aware assistant may use — inspect the tree/files, never
// mutate. Everything else (Bash, Write, Edit, …) is denied.
const ASSISTANT_READ_TOOLS = new Set(["Read", "LS", "Glob", "Grep", "NotebookRead"]);

/**
 * A repo-aware one-shot assistant: same auth path as {@link oneShotText}, but it
 * can READ the repository at `cwd` (Read/LS/Glob/Grep) to ground its answer in
 * actual file content — e.g. opening ROADMAP.md — while every mutating tool is
 * denied. Bounded turns; returns the final text. Used by the project assistant.
 */
export async function oneShotRepoAssistant(opts: {
  prompt: string;
  cwd: string;
  model?: string;
  apiKey?: string;
}): Promise<string> {
  let answer = "";
  for await (const delta of oneShotRepoAssistantStream(opts)) answer += delta;
  return answer.trim() || "(no answer)";
}

/** Streaming variant of {@link oneShotRepoAssistant} — yields the answer as text
 *  deltas. Read-only tool turns (Read/Grep/…) interleave; only the model's text
 *  is yielded, so the reply appears as it's written after any file lookups. */
export function oneShotRepoAssistantStream(opts: {
  prompt: string;
  cwd: string;
  model?: string;
  apiKey?: string;
}): AsyncIterable<string> {
  const env = buildRunnerEnv();
  if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey;
  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      model: mapModel(opts.model ?? "opus"),
      permissionMode: "default",
      // The preset loads the full tool suite (so Read/Grep/Glob exist); the
      // gate narrows it to read-only.
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool: (name, input) =>
        Promise.resolve(
          ASSISTANT_READ_TOOLS.has(name)
            ? ({ behavior: "allow", updatedInput: input } as PermissionResult)
            : ({ behavior: "deny", message: "Read-only assistant — only Read/LS/Glob/Grep are allowed." } as PermissionResult),
        ),
      maxTurns: 14,
      env,
      includePartialMessages: true,
      // Isolated — see the settingSources block near the top of this file.
      // CLAUDE.md isn't auto-injected here, but the assistant can Read it like
      // any other repo file if it's relevant to the question.
      settingSources: NO_FS_SETTINGS,
    },
  });
  return streamQueryText(q as AsyncIterable<SDKMessage>);
}

// A tool call the assistant requested: its name, input args, and id (to pair
// with the later tool_result that carries its output).
type ToolCall = { name: string; input: Record<string, unknown>; id?: string };

// Extract text + tool calls (with inputs) from an assistant message.
function readAssistant(message: { content?: unknown }): { text: string; tools: ToolCall[] } {
  const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  let text = "";
  const tools: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "tool_use" && typeof b.name === "string") {
      tools.push({
        name: b.name,
        input: b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
        id: typeof b.id === "string" ? b.id : undefined,
      });
    }
  }
  return { text: text.trim(), tools };
}

const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Flatten a tool_result's content (string, or an array of text/blocks) to text.
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : typeof c === "string" ? c : JSON.stringify(c)))
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

// One-line summary for the activity log (▸ Edit README.md, ▸ Bash: pnpm test, …).
function describeTool(name: string, input: Record<string, unknown>): string {
  const fp = typeof input.file_path === "string" ? input.file_path.split("/").pop() : undefined;
  if (name === "Bash" && typeof input.command === "string") return `Bash: ${clip(input.command)}`;
  if (fp && /^(Read|Write|Edit|NotebookRead|NotebookEdit)$/.test(name)) return `${name} ${fp}`;
  if (typeof input.pattern === "string" && /^(Glob|Grep)$/.test(name)) return `${name} ${clip(String(input.pattern), 60)}`;
  return name;
}

// A specific, human title for the gate — what the operator is being asked to
// allow — instead of a generic "Approve: Bash".
function actionTitle(name: string, input: Record<string, unknown>): string {
  const fp = typeof input.file_path === "string" ? input.file_path : undefined;
  if (name === "Bash" && typeof input.command === "string") return `Run a shell command: ${clip(input.command, 70)}`;
  if (name === "Write" && fp) return `Create/overwrite ${fp}`;
  if (name === "Edit" && fp) return `Edit ${fp}`;
  if (fp) return `${name} ${fp}`;
  return `Use the ${name} tool`;
}

// A plain-language statement of what the action DOES / what it touches — the
// system's framing (the orchestrator appends any safety flag). Distinct from the
// agent's own `rationale`.
function actionImpact(name: string, input: Record<string, unknown>): string {
  const fp = typeof input.file_path === "string" ? input.file_path : undefined;
  if (name === "Bash") return "Runs a shell command in the agent's isolated worktree.";
  if (name === "Write" && fp) return `Writes ${fp} in the agent's worktree (creates it or replaces its contents).`;
  if (name === "Edit" && fp) return `Modifies ${fp} in the agent's worktree.`;
  return `Runs the ${name} tool in the agent's worktree.`;
}

// Human-readable detail shown in the approval gate (the box the operator reads).
function approvalText(name: string, input: Record<string, unknown>): string {
  if (name === "Bash" && typeof input.command === "string") return input.command;
  const fp = typeof input.file_path === "string" ? input.file_path : undefined;
  if (name === "Edit" && fp) {
    const o = String(input.old_string ?? "");
    const n = String(input.new_string ?? "");
    return (
      `Edit ${fp}\n\n` +
      o.split("\n").map((l) => `- ${l}`).join("\n") +
      "\n" +
      n.split("\n").map((l) => `+ ${l}`).join("\n")
    );
  }
  if (name === "Write" && fp) return `Write ${fp}\n\n${clip(String(input.content ?? ""), 800)}`;
  if (fp) return `${name} ${fp}`;
  return JSON.stringify(input, null, 2);
}

// The names of the agent's task-management tools. The claude_code preset gives
// TaskCreate/TaskUpdate (SDK ≥ 0.3.x, one task per call, SDK-assigned id);
// older builds use TodoWrite (whole list per call). We map either onto the
// PLAN panel so progress reflects real work, not a synthetic bump.
const PLAN_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);

const taskStatusToState = (status: string): PlanStep["state"] =>
  status === "completed" ? "done" : status === "in_progress" ? "now" : "todo";

// TodoWrite input: { todos: [{ content, status, activeForm? }] } — a full list.
function todosToPlan(input: Record<string, unknown>): PlanStep[] {
  const todos = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
  const plan: PlanStep[] = [];
  for (const t of todos) {
    const state = taskStatusToState(String(t.status ?? "pending"));
    // Prefer the present-tense form while active; fall back to the content.
    const text = String((state === "now" && t.activeForm) || t.content || t.activeForm || "").trim();
    if (text) plan.push({ text, state });
  }
  return plan;
}

// A clarifying question the agent asked via the AskUserQuestion tool, distilled
// to what the HITL model needs: a prompt + a flat list of option labels.
interface ParsedQuestion {
  header: string; // short label for the question (chip/title)
  prompt: string; // the full question text shown to the operator
  options: Array<{ label: string; description?: string }>;
}

// AskUserQuestion input: { questions: [{ question, header, options: [{label, description}] }] }.
// We surface the FIRST question (the HITL model is one question + a choice list);
// any extra questions are appended to the prompt so nothing is silently dropped.
function parseAskUserQuestion(input: Record<string, unknown>): ParsedQuestion | null {
  const questions = Array.isArray(input.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  if (!questions.length) return null;
  const q0 = questions[0] ?? {};
  const rawOpts = Array.isArray(q0.options) ? q0.options : [];
  const options = rawOpts
    .map((o) =>
      typeof o === "string"
        ? { label: o }
        : o && typeof o === "object"
          ? { label: String((o as Record<string, unknown>).label ?? ""), description: (o as Record<string, unknown>).description ? String((o as Record<string, unknown>).description) : undefined }
          : { label: "" },
    )
    .filter((o) => o.label);
  if (!options.length) return null;
  const header = String(q0.header ?? "Question").trim() || "Question";
  let prompt = String(q0.question ?? q0.header ?? "The agent needs a decision.").trim();
  if (questions.length > 1) {
    const extra = questions.slice(1).map((q) => String(q.question ?? q.header ?? "")).filter(Boolean);
    if (extra.length) prompt += `\n\n(Also asked — answer in the same reply via Modify: ${extra.join(" · ")})`;
  }
  return { header, prompt, options };
}

// Turn a parsed AskUserQuestion into a `question` HITL: the prompt + a choice
// list the UI renders as option buttons (resolved via the `option` action).
function buildQuestionRaise(q: ParsedQuestion): HitlRaise {
  const detail = q.options.some((o) => o.description)
    ? q.options.map((o) => `• ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")
    : null;
  return {
    kind: "question",
    title: q.header,
    why: q.prompt,
    risk: "low",
    command: detail, // option descriptions, if any, for the detail box
    options: q.options.map((o) => o.label),
    recommended: null, // AskUserQuestion marks no default
    rationale: null,
    steps: null,
    diff: null,
  };
}

// The agent hands off via AskUserQuestion with an escalation header ("ESCALATE",
// "BLOCKED", …). We key on the HEADER only — not the body — so an ordinary
// question that merely mentions "blocked" isn't misread as a give-up.
function isEscalation(q: ParsedQuestion): boolean {
  return /^\s*(escalate|blocked|stuck|hand.?off|give.?up|take.?over|need.*human)/i.test(q.header);
}

// Turn an escalation AskUserQuestion into an `escalation` HITL: the agent has
// stopped and needs a human (help & resume, reassign, or stop). Unlike a
// question, there's no answer that mechanically continues it — the operator's
// guidance rides the trusted operator channel on resume (see resume()).
function buildEscalationRaise(q: ParsedQuestion): HitlRaise {
  return {
    kind: "escalation",
    title: /^\s*escalate\s*$/i.test(q.header) ? "Agent is blocked — needs a human" : q.header,
    why: q.prompt,
    risk: "medium",
    rationale: q.prompt,
    command: null,
    options: null,
    recommended: null,
    steps: null,
    diff: null,
  };
}

// ExitPlanMode's `plan` field is markdown prose from the agent — not already a
// discrete step list like TodoWrite's. Split it into lines for the `steps`
// list the HITL UI renders as a numbered list (see queue.tsx); a plan with no
// line breaks becomes a single step. Not a full markdown parser — just strips
// leading bullet/number markers so a bulleted plan reads naturally as a list.
function planToSteps(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  return lines.length ? lines : [text];
}

// Turn an ExitPlanMode call into a `plan` HITL: the proposed plan, gated
// before the agent may write anything (see StartSpec.planModeGate). Approve /
// reject / modify share the same semantics as a normal approval gate — see
// resume() and decision-resume.ts.
function buildPlanRaise(input: Record<string, unknown>): HitlRaise {
  const planText = typeof input.plan === "string" ? input.plan.trim() : "";
  return {
    kind: "plan",
    title: "Review the proposed plan",
    why: "The agent wants to start implementing this plan — approve to let it begin making changes.",
    risk: "medium",
    rationale: null,
    command: null,
    options: null,
    recommended: null,
    steps: planToSteps(planText || "(the agent didn't include plan text)"),
    diff: null,
  };
}

// ─── Repo-hook gate ─────────────────────────────────────────────────────────
// The main run opts into settingSources: ['project'] (see the block near the
// top of this file) so CLAUDE.md loads — which also loads the SAME repo's
// `.claude/settings.json` `hooks`, real shell commands the SDK runs on
// matching lifecycle events with NO canUseTool gate in front of them. Before
// starting the session at all, scan for them with the SDK's own settings
// merge engine (resolveSettings — same result the session itself would see,
// no need to hand-parse JSON) and, if any exist, pause on an `approval` HITL —
// the same kind/UI a risky Bash command already uses — so the operator sees
// the exact command(s) and decides before anything can run.

/** One `type: 'command'` hook, flattened for display. */
interface HookCommandRef {
  event: string;
  matcher?: string;
  command: string;
}

function collectHookCommands(hooks: Settings["hooks"]): HookCommandRef[] {
  const out: HookCommandRef[] = [];
  for (const [event, groups] of Object.entries(hooks ?? {})) {
    for (const g of groups ?? []) {
      for (const h of g.hooks ?? []) {
        if (h.type === "command" && typeof h.command === "string") {
          out.push({ event, matcher: g.matcher, command: h.command });
        }
      }
    }
  }
  return out;
}

/**
 * Resolve what settingSources: ['project'] would actually load for `cwd` and
 * return any `type: 'command'` hooks it carries. Empty when the repo has none
 * (the common case) or its settings can't be read (the SDK will hit the same
 * problem when it loads for real — no separate failure mode to invent here).
 */
async function scanRepoHooks(cwd: string): Promise<HookCommandRef[]> {
  try {
    const resolved = await resolveSettingsImpl({ cwd, settingSources: PROJECT_SETTING_SOURCES });
    return collectHookCommands(resolved.effective.hooks);
  } catch {
    return [];
  }
}

// Turn the scanned hooks into an `approval` HITL — reject/approve semantics
// identical to any other pending-action gate (see resume()); no new kind.
function buildHookRaise(hooks: HookCommandRef[]): HitlRaise {
  const list = hooks.map((h) => `[${h.event}${h.matcher ? `:${h.matcher}` : ""}] ${h.command}`).join("\n\n");
  const n = hooks.length;
  return {
    kind: "approval",
    title: `Repo defines ${n} lifecycle hook${n === 1 ? "" : "s"} — approve before this run starts`,
    why: "This repo's .claude/settings.json declares shell-command hooks that run automatically on matching events (e.g. every tool call) — unlike a normal action, they are NOT covered by the per-action approval gate below. Approve to start the run with them active, or reject to stop before anything (including a hook) runs.",
    risk: "high",
    rationale: null,
    command: list,
    options: null,
    recommended: null,
    steps: null,
    diff: null,
  };
}

// Short human label of the chosen answer, for the activity log.
function describeAnswer(q: ParsedQuestion, decision?: Resolution): string {
  if (decision?.action === "option" && decision.optionIndex != null) {
    return q.options[decision.optionIndex]?.label ?? `option ${decision.optionIndex}`;
  }
  if (decision?.action === "modify" && decision.guidance) return decision.guidance;
  if (decision?.action === "reject") return "declined — agent's judgment";
  return "no selection";
}

// The message handed back to the model as the AskUserQuestion result. Frames it
// as the human's answer so the agent continues with the decision made for it.
function answerForQuestion(q: ParsedQuestion, decision?: Resolution): string {
  if (decision?.action === "option" && decision.optionIndex != null) {
    const opt = q.options[decision.optionIndex];
    const label = opt?.label ?? `option ${decision.optionIndex}`;
    return `The human answered your question "${q.header}": ${label}.${opt?.description ? ` (${opt.description})` : ""} Continue with this decision.`;
  }
  if (decision?.action === "modify" && decision.guidance) {
    return `The human answered your question "${q.header}": ${decision.guidance}. Continue with this.`;
  }
  // No operator answered in time (auto-resolved by the server's question
  // timeout). Do NOT invite a guess — the honest outcome is to conclude.
  if (decision?.by?.startsWith("system:")) {
    return `No operator answered your question "${q.header}" in time. Do NOT guess or make a speculative change — state plainly what you could and couldn't determine and exactly what you'd need to proceed, then stop without editing.`;
  }
  if (decision?.action === "reject") {
    return `The human declined to choose for "${q.header}" — use your best judgment and proceed.`;
  }
  return `The human acknowledged "${q.header}" without a specific choice — use your best judgment and proceed.`;
}

// ─── Transient-error retry policy ──────────────────────────────────────────
// The TaskRun SDK already retries individual HTTP calls; when even that is
// exhausted it surfaces an overload/rate-limit as either a thrown error or a
// `result` message with is_error/error subtype. Those are RETRYABLE at the
// session level: back off and resume the session, a bounded number of times.
// Anything else (or exhausting the budget) is a real failure — never a "done".

/** True for retryable API conditions: overload (429/529), rate-limit, 503. */
export function isTransientApiError(text: string): boolean {
  return /\b(429|503|529)\b|overload|rate[\s_-]?limit|too many requests|temporarily unavailable/i.test(
    text ?? "",
  );
}

/**
 * True when an API error means the key is out of money/quota — a BILLING wall,
 * not a transient rate-limit. These never recover on retry; the operator must
 * top up. Anthropic: 400 "Your credit balance is too low…"; OpenAI: 429
 * "You exceeded your current quota" / "insufficient_quota"; generic: 402 /
 * payment required. Checked BEFORE `isTransientApiError` so a quota error that
 * arrives as a 429 isn't mistaken for a recoverable rate-limit and retried in
 * vain. PURE — unit-tested.
 */
export function isCreditExhaustionError(text: string): boolean {
  return /credit balance|balance is too low|insufficient[\s_-]?quota|exceeded your current quota|out of (?:credits?|quota)|quota (?:exceeded|exhausted)|payment required|\b402\b|billing (?:hard )?limit/i.test(
    text ?? "",
  );
}

const MAX_API_RETRIES = 3;
// `error_max_turns` is NOT a failure — the SDK session is intact and the work is
// resumable; the agent just hit its per-session turn budget. Continue it (resume,
// fresh budget) up to this many times before handing off to a human. Its own
// budget, separate from API retries.
const MAX_TURN_CONTINUES = 3;
/** Exponential backoff, capped at 30s: attempt 1→2s, 2→4s, 3→8s. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** attempt);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Classify a `result` message: null = clean success, else the error + whether
 *  it's a transient (retryable) condition. */
function classifyResult(msg: Record<string, unknown>, context: string): { reason: string; transient: boolean } | null {
  const subtype = typeof msg.subtype === "string" ? msg.subtype : "";
  const isError = msg.is_error === true || (subtype !== "" && subtype !== "success");
  if (!isError) return null;
  const resultText = typeof msg.result === "string" ? msg.result : "";
  const detail = [subtype, resultText, context].join(" ");
  // A billing wall is NOT transient — never retry it. Surface the provider's
  // own message as the reason so the orchestrator can recognize it (and the
  // operator sees "credit balance is too low", not a bare subtype).
  const exhausted = isCreditExhaustionError(detail);
  return {
    reason: exhausted ? resultText || subtype || "credit/quota exhausted" : subtype || "error",
    transient: !exhausted && isTransientApiError(detail),
  };
}

// Cap on ClaudeRunnerProvider.sessions (runId → SDK session id, kept so a fork
// can resume its parent's context) — was previously unbounded, growing one
// entry per run for the server-process lifetime. Fork stays available on ANY
// run indefinitely (no completion/archival ever disables the Fork button —
// see task.tsx), so there's no lifecycle event that safely marks an entry as
// "will never be resumed again"; evicting on run completion or worktree
// retirement would silently break resume for the ordinary "fork a run I
// finished a while ago" case. A bounded LRU is the safe fix instead: it caps
// memory the way the roadmap item asks for, without guessing wrong about
// which entries are still wanted. Beyond the cap, a fork just starts a fresh
// (non-resumed) session — exactly what already happens for every run today
// after a server restart, since this cache was never persisted to begin with.
const MAX_SESSIONS = 500;

// Test seams (mirror the orchestrator's providerOverride): let tests drive the
// SDK message stream deterministically, collapse backoff, and shrink the
// session cap so LRU eviction is provable without driving 500+ runs.
// Production always uses the real query(), real exponential timing, and
// MAX_SESSIONS.
let queryImpl: typeof query = query;
let backoffMsImpl: (attempt: number) => number = retryBackoffMs;
let maxSessionsImpl = MAX_SESSIONS;
let resolveSettingsImpl: typeof resolveSettings = resolveSettings;
export function __setClaudeTestHooks(
  hooks: {
    query?: typeof query;
    backoffMs?: (n: number) => number;
    maxSessions?: number;
    resolveSettings?: typeof resolveSettings;
  } | null,
): void {
  queryImpl = hooks?.query ?? query;
  backoffMsImpl = hooks?.backoffMs ?? retryBackoffMs;
  maxSessionsImpl = hooks?.maxSessions ?? MAX_SESSIONS;
  resolveSettingsImpl = hooks?.resolveSettings ?? resolveSettings;
}

class ClaudeRunnerHandle implements RunnerHandle {
  readonly runId: string;
  readonly provider: ProviderId = "claude";
  private input = createInputStream();
  private q?: Query; // unset when we couldn't authenticate (see constructor)
  private gate: ((r: PermissionResult) => void) | null = null;
  // Original input of the gated tool call, echoed back on allow (the SDK treats
  // the allow result's `updatedInput` as the input to run — omitting it stalls
  // the session, so we always pass the tool's own input through).
  private gateInput: Record<string, unknown> | null = null;
  private gateTool: string | null = null; // name of the tool awaiting approval
  private gateQuestion: ParsedQuestion | null = null; // set when the gate is an AskUserQuestion
  private lastRationale = ""; // the agent's most recent prose (its stated reasoning)
  // Flips true once the operator approves this run's ExitPlanMode gate (see
  // StartSpec.planModeGate). Irrelevant — and stays false — for a run that
  // didn't opt into plan mode.
  private planApproved = false;
  private sdkEnv: Record<string, string> = {}; // resolved auth env, reused for side-queries
  private pendingTools = new Map<string, string>(); // tool_use id → tool name, to pair outputs
  private pendingChat = false;
  private progress = 0;
  private plan: PlanStep[] = []; // real steps, from the agent's task-tracking tools
  private planOrder: string[] = []; // task ids in creation order (TaskCreate/Update)
  private planById = new Map<string, PlanStep>();
  private finished = false;
  private hb?: ReturnType<typeof setInterval>;
  private cap?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>; // idle-stall watchdog (resets on activity)
  // Retry state (transient API overload → resume the session, bounded).
  private sessionId?: string; // this run's own SDK session, for resume-on-retry
  private baseOptions?: Options; // query options minus resume, reused per relaunch
  private initialPrompt = ""; // the kickoff message, re-sent if we retry pre-session
  private apiRetries = 0; // transient retries spent (budget MAX_API_RETRIES)
  private turnContinues = 0; // turn-budget continues spent (budget MAX_TURN_CONTINUES)
  private lastApiError = ""; // most recent overload/error text seen, for classification

  constructor(
    private spec: StartSpec,
    private events: RunnerEvents,
    private onSession: (runId: string, sessionId: string) => void,
    resumeSessionId?: string,
  ) {
    this.runId = spec.runId;
    this.events.onStatus(this.runId, "running");
    this.events.onLog(this.runId, `picked up "${spec.task}" on ${spec.branch}`);
    this.initialPrompt =
      `You are a Skynet coding agent on branch ${spec.branch} in this repository. ` +
      `Task: ${spec.task}. ` +
      `First decide what the task actually needs: if it's a question, analysis, or research request, just answer it directly — do NOT create or edit files to "record" the answer. ` +
      `Only if it requires code changes, make them and run any relevant checks. Then stop when done. ` +
      `Make code changes ONLY — do NOT run git commit, git push, or gh pr, and do NOT ask the operator whether to commit, push, or open a PR. Skynet owns that: when you finish it auto-commits your worktree, then gates the push and PR behind a separate review/approval step it controls. So never say you "didn't commit" or ask "should I open a PR?" — leave version control entirely to Skynet. Your "done" message should simply summarize what you changed and why, nothing about committing, pushing, or PRs. ` +
      `For anything beyond a one-line answer, use the TodoWrite tool to lay out your plan as concrete steps BEFORE you start, and keep it updated (mark each step in_progress, then completed) as you work — this is how your plan and progress are surfaced to the operator, so maintain it even for research/exploration tasks. ` +
      `Ask before running destructive or irreversible commands. ` +
      `Be honest when you're blocked: if you cannot reproduce a reported problem, or the task lacks information you'd need to fix it correctly (a stack trace, reproduction steps, failing logs, expected vs actual behavior), do NOT guess or make a speculative edit. Use the AskUserQuestion tool to ask the operator for exactly what you need, or if no answer is possible, report plainly what you could and couldn't determine and stop WITHOUT changing code. Asking for the missing detail is the correct, honest outcome here — a fabricated fix is a failure, not progress. ` +
      `If you have genuinely TRIED and cannot make further progress — the task is beyond what you can do here, a prerequisite is missing that you can't obtain, or you keep hitting the same failure — HAND OFF to a human instead of thrashing or churning. Call the AskUserQuestion tool with the header set to "ESCALATE" and, in the question, say what you tried, what's blocking you, and what a human could do to help or decide. This halts the run so a human can help and resume you, reassign it, or stop it. Escalating when truly stuck is the right call — far better than burning time on an approach that isn't working.`;
    this.input.push(this.initialPrompt);

    const canUseTool: CanUseTool = (toolName, input) => {
      // Plan-mode gate (StartSpec.planModeGate): ExitPlanMode is intercepted
      // and raised as its own `plan` HITL, not a generic approval, carrying
      // the agent's proposed plan. Approving it flips `planApproved` and lets
      // the SDK's own allow fall through to end plan mode normally (resume());
      // reject/modify send it back to revise, same as any approval gate.
      if (toolName === "ExitPlanMode") {
        return new Promise<PermissionResult>((resolve) => {
          this.gate = resolve;
          this.gateInput = input;
          this.gateTool = toolName;
          this.gateQuestion = null;
          this.events.onStatus(this.runId, "waiting");
          this.events.onHitl(this.runId, buildPlanRaise(input));
        });
      }
      // AskUserQuestion is the agent asking the operator a decision — surface it
      // as a `question` HITL with real option buttons, not a generic "approve".
      // Checked before the plan-mode restriction below so the agent can still
      // ask a clarifying question while it's planning, not just once approved.
      const question = toolName === "AskUserQuestion" ? parseAskUserQuestion(input) : null;
      // A question whose header signals a hand-off is an ESCALATION, not a
      // routine decision — the agent has given up and wants a human.
      const escalation = question && isEscalation(question) ? buildEscalationRaise(question) : null;
      if (!question) {
        // Until the plan above is approved, only read-only investigation + its
        // own TodoWrite tracking are auto-allowed — deny everything else
        // outright (including the edits AUTO_ALLOW normally lets through)
        // rather than opening a second gate, so the agent stays in planning.
        if (this.spec.planModeGate && !this.planApproved) {
          return Promise.resolve(
            PLAN_MODE_ALLOW.has(toolName)
              ? ({ behavior: "allow", updatedInput: input } as PermissionResult)
              : ({
                  behavior: "deny",
                  message: "Still in plan mode — read what you need, then call ExitPlanMode with your proposed plan. Do not make changes yet.",
                } as PermissionResult),
          );
        }
        if (isAutoAllowed(toolName)) return Promise.resolve({ behavior: "allow", updatedInput: input });
      }
      return new Promise<PermissionResult>((resolve) => {
        // One gate at a time — the SDK serializes tool calls in a turn.
        // Register the gate BEFORE emitting the event: a synchronous resume
        // (auto-approve policy / fast operator) can re-enter during onHitl, and
        // if the resolver isn't stored yet it would miss the gate → permanent stall.
        this.gate = resolve;
        this.gateInput = input;
        this.gateTool = toolName;
        // An escalation is NOT an answerable question: resume() delivers the
        // operator's guidance on the trusted operator channel (help & resume),
        // or the orchestrator stops/reassigns the run.
        this.gateQuestion = escalation ? null : question;
        this.events.onStatus(this.runId, "waiting");
        this.events.onHitl(
          this.runId,
          escalation ?? (question ? buildQuestionRaise(question) : this.buildRaise(toolName, input)),
        );
      });
    };

    // Auth: authenticate the nested TaskRun SDK with any accepted credential — a
    // static ANTHROPIC_API_KEY (env or per-workspace, injected as spec.apiKey), a
    // `claude setup-token` subscription token (CLAUDE_CODE_OAUTH_TOKEN), or a
    // gateway bearer token (ANTHROPIC_AUTH_TOKEN). buildRunnerEnv() has already
    // dropped the nested-session markers that would 401 a standalone server, so
    // whatever survives here is usable. Fast-fail with a clear reason rather than
    // spinning up an agent that immediately 401s.
    const env = buildRunnerEnv();
    this.sdkEnv = spec.apiKey ? { ...env, ANTHROPIC_API_KEY: spec.apiKey } : env;
    const authed =
      !!spec.apiKey ||
      !!this.sdkEnv.ANTHROPIC_API_KEY ||
      !!this.sdkEnv.CLAUDE_CODE_OAUTH_TOKEN ||
      !!this.sdkEnv.ANTHROPIC_AUTH_TOKEN;
    if (!authed) {
      this.events.onLog(
        this.runId,
        "No Claude credential found — set ANTHROPIC_API_KEY, run `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN), or configure a gateway (ANTHROPIC_AUTH_TOKEN). Without one, nothing runs.",
      );
      this.events.onStatus(this.runId, "review");
      return; // q stays unset; consume()/heartbeat never start
    }

    // Base options (reused verbatim on every relaunch/retry). Fork-resume is kept
    // OUT of the base so a retry resumes THIS run's own session, not a fork.
    const baseOptions: Options = {
      cwd: spec.cwd ?? process.cwd(),
      model: mapModel(spec.model),
      // Opt-in plan mode: the agent must propose a plan and call ExitPlanMode
      // before making any edits (intercepted in canUseTool above and raised as
      // a `plan` HITL). Off (the default) is today's behavior, unchanged.
      permissionMode: spec.planModeGate ? "plan" : "default",
      canUseTool,
      maxTurns: 60,
      // Use Claude Code's default system prompt + full tool suite. Without this a
      // bare query() gives a minimal agent that never loads TodoWrite, so the
      // agent writes plans as prose and the PLAN panel stays empty. The preset
      // makes the agent maintain a real todo list (→ our plan steps) and behave
      // like Claude Code; our canUseTool gates the risky surface (shell + unknown
      // tools), while edits ride the end-of-run diff review (see AUTO_ALLOW).
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Scrubbed env (drops the nested-session OAuth path); a per-workspace key
      // (orchestrator-injected) overrides ANTHROPIC_API_KEY for this session only.
      env: this.sdkEnv,
      // Token-level `stream_event`s (textDeltaOf, drain() below) — without this
      // the SDK only ever emits whole `assistant` messages and the log jumps in
      // full-paragraph chunks instead of typing live.
      includePartialMessages: true,
      // Deliberately re-enabled for CLAUDE.md — see the settingSources block
      // near the top of this file. Gated by scanRepoHooks()/launch() below:
      // the session (and any repo-defined hooks this also loads) doesn't start
      // until that scan has run.
      settingSources: PROJECT_SETTING_SOURCES,
      // Opt-in real browser (Playwright/Chrome MCP). Omitted unless the workspace
      // enabled it; its tools gate through canUseTool like any other non-read tool.
      ...(spec.browser ? { mcpServers: browserMcpServers(true) } : {}),
    };
    this.baseOptions = baseOptions;
    if (spec.browser) this.events.onLog(this.runId, "browser tools enabled (Playwright MCP) — browser actions gate for approval");
    if (spec.planModeGate) this.events.onLog(this.runId, "plan mode enabled — the agent will propose a plan and pause for approval before making changes");

    // A fork inherits its parent's context via resume; a fresh run doesn't.
    const firstOptions: Options = resumeSessionId
      ? { ...baseOptions, resume: resumeSessionId, forkSession: true }
      : baseOptions;

    this.hb = setInterval(() => this.events.onHeartbeat(this.runId), 5_000);
    // Wall-clock resource cap: force-fail a runaway/hung run so it can't hold
    // its slot and burn tokens forever. Armed once; survives session resume on
    // retry (the ceiling is on total run wall-clock). 0 disables (see caps.ts).
    // fail() before interrupt(): fail() early-returns once `finished` is set, so
    // it must run first to actually emit onFailed; then tear the query down.
    const capMs = runtimeCapMs();
    if (capMs > 0) {
      this.cap = setTimeout(() => {
        this.fail(`exceeded max runtime (${fmtDuration(capMs)}) — force-stopped`);
        void this.q?.interrupt().catch(() => undefined);
      }, capMs);
    }
    // Start the idle-stall watchdog now — it also covers the hook-approval
    // wait in launch() below, same as it already covers every other gate
    // (ExitPlanMode, a Bash approval, …): none of them reset it either, since
    // it only resets on a real SDK message (see bumpIdle()/drain()).
    this.bumpIdle();
    void this.launch(firstOptions);
  }

  /**
   * Start the SDK session, gated on a repo-hook scan (see scanRepoHooks). A
   * repo with no `.claude/settings.json` hooks launches immediately — the
   * common case, and today's behavior. One that has them pauses on an
   * `approval` HITL before the session (and its hooks) can run at all;
   * rejecting stops the run before anything happens, same as declining any
   * other pending action.
   */
  private async launch(firstOptions: Options): Promise<void> {
    const hooks = await scanRepoHooks(this.spec.cwd ?? process.cwd());
    if (this.finished) return; // stopped while the scan was in flight
    if (hooks.length) {
      const approved = await new Promise<boolean>((resolve) => {
        // Reuses the same gate/resume() plumbing as every other pending
        // action (see canUseTool above and resume() below) — "approve" falls
        // through to resume()'s allow branch, "reject"/"modify" both deny.
        this.gate = (r) => resolve(r.behavior === "allow");
        this.gateInput = { hooks: hooks.map((h) => h.command) };
        this.gateTool = "RepoHooks";
        this.gateQuestion = null;
        this.events.onStatus(this.runId, "waiting");
        this.events.onHitl(this.runId, buildHookRaise(hooks));
      });
      if (this.finished) return; // stopped while parked on the gate
      if (!approved) {
        this.fail("operator did not approve this repo's lifecycle hooks — stopped before the session started");
        return;
      }
      this.events.onLog(this.runId, `operator approved ${hooks.length} repo-defined lifecycle hook(s) — starting the session`);
    }
    this.q = queryImpl({ prompt: this.input, options: firstOptions });
    void this.consume();
  }

  /** (Re)arm the idle-stall watchdog. Unlike the total-runtime {@link cap} (armed
   *  once), this resets on every activity event, so it fires only after the agent
   *  has made NO progress for idleCapMs — catching a wedged/hung run fast while
   *  never interrupting one that's actively working. The 5s heartbeat is a fixed
   *  timer that keeps ticking for a hung run, so the server reaper can't catch
   *  this; this closes that gap. Force-fail → onFailed → needs-attention (review),
   *  never a silent "running" forever or a false "done". */
  private bumpIdle() {
    if (this.finished) return;
    const ms = idleCapMs();
    if (ms <= 0) return; // disabled
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.fail(`no progress for ${fmtDuration(ms)} — stalled, force-stopped`);
      void this.q?.interrupt().catch(() => undefined);
    }, ms);
  }

  private buildRaise(toolName: string, input: Record<string, unknown>): HitlRaise {
    const command = approvalText(toolName, input);
    // The agent's most recent prose IS its stated reasoning for what it's doing —
    // surface it so the operator sees intent, not just the raw action. Trim to a
    // sane length; drop it if the agent hasn't said anything yet.
    const rationale = this.lastRationale.trim() ? clip(this.lastRationale.trim(), 600) : null;
    return {
      kind: "approval",
      title: actionTitle(toolName, input),
      why: actionImpact(toolName, input),
      risk: toolName === "Bash" ? "medium" : "low", // orchestrator upgrades on a safety flag
      rationale,
      command,
      options: null,
      recommended: null,
      steps: null,
      diff: null,
    };
  }

  private bump() {
    // Once the agent maintains a real plan, that drives progress — don't let the
    // synthetic bump fight it. Only used before the first TodoWrite arrives.
    if (this.plan.length) return;
    this.progress = Math.min(0.9, this.progress + 0.08);
    this.events.onProgress(this.runId, this.progress, [] as PlanStep[]);
  }

  /**
   * Fold a task-tracking tool call into the plan. TodoWrite replaces the whole
   * list; TaskCreate appends one task (ids are SDK-assigned in creation order,
   * so we mirror that with sequential ids); TaskUpdate flips one task's state.
   */
  private applyPlanTool(name: string, input: Record<string, unknown>) {
    if (name === "TodoWrite") {
      const plan = todosToPlan(input);
      if (plan.length) {
        this.plan = plan;
        this.emitPlan();
      }
      return;
    }
    if (name === "TaskCreate") {
      const items = Array.isArray(input.tasks)
        ? (input.tasks as Array<Record<string, unknown>>)
        : [input];
      for (const it of items) {
        const text = String(it.subject || it.title || it.activeForm || it.content || "").trim();
        if (!text) continue;
        const id = String(this.planOrder.length + 1); // SDK numbers tasks 1-based
        this.planOrder.push(id);
        this.planById.set(id, { text, state: "todo" });
      }
    } else if (name === "TaskUpdate") {
      const id = String(input.taskId ?? input.task_id ?? input.id ?? "");
      const step = this.planById.get(id);
      if (step) step.state = taskStatusToState(String(input.status ?? ""));
    }
    this.plan = this.planOrder
      .map((id) => this.planById.get(id))
      .filter((s): s is PlanStep => !!s);
    if (this.plan.length) this.emitPlan();
  }

  /** Recompute progress from the real plan (done/total) and push it + the plan. */
  private emitPlan() {
    const done = this.plan.filter((p) => p.state === "done").length;
    // Keep it shy of 1 until finish() flips the agent to done.
    this.progress = Math.min(0.99, this.plan.length ? done / this.plan.length : this.progress);
    this.events.onProgress(this.runId, this.progress, this.plan);
  }

  /** Read exact token/cost totals off the SDK `result` message and report them. */
  private emitUsage(result: Record<string, unknown>) {
    const u = (result.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const input =
      n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
    const cost = typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
    const durationMs = typeof result.duration_ms === "number" ? result.duration_ms : null;
    this.events.onUsage?.(this.runId, {
      inputTokens: input,
      outputTokens: n(u.output_tokens),
      costUsd: cost,
      turns: n(result.num_turns),
      durationMs,
    });
  }

  private async consume() {
    if (!this.q) return;
    while (!this.finished) {
      const outcome = await this.drain();
      if (this.finished) return; // stopped mid-drain

      if (outcome.done) {
        this.finish();
        return;
      }

      // Ran out of turns — NOT a failure. Resume the same session (fresh turn
      // budget) and keep going, a bounded number of times. The agent picks up
      // exactly where it left off; only when it can't finish within the continue
      // budget does it hand off (→ onFailed → the orchestrator escalates it).
      if (outcome.reason === "error_max_turns" && this.turnContinues < MAX_TURN_CONTINUES) {
        this.turnContinues++;
        this.events.onLog(
          this.runId,
          `ran out of turns — continuing where it left off [${this.turnContinues}/${MAX_TURN_CONTINUES}]`,
        );
        await this.q?.interrupt().catch(() => undefined); // release the exhausted session
        if (this.finished) return;
        this.relaunch();
        continue;
      }

      // Errored. A transient overload/rate-limit is retryable: back off and
      // resume the session, up to MAX_API_RETRIES. Anything else — or exhausting
      // the budget — is a real failure. NEVER fall through to a "done".
      if (outcome.transient && this.apiRetries < MAX_API_RETRIES) {
        this.apiRetries++;
        const wait = backoffMsImpl(this.apiRetries);
        this.events.onLog(
          this.runId,
          `Claude API transient error (${outcome.reason}); retrying in ${Math.round(wait / 1000)}s [${this.apiRetries}/${MAX_API_RETRIES}]`,
        );
        await this.q?.interrupt().catch(() => undefined); // release the dead session
        await sleep(wait);
        if (this.finished) return;
        this.relaunch();
        continue;
      }

      this.fail(
        outcome.transient
          ? `Claude API still overloaded after ${MAX_API_RETRIES} retries: ${outcome.reason}`
          : outcome.reason,
      );
      return;
    }
  }

  /** Iterate the current query to its end. Returns done on a clean result (or a
   *  stream that ends without one), else the error + whether it's retryable. */
  private async drain(): Promise<{ done: true } | { done: false; reason: string; transient: boolean }> {
    if (!this.q) return { done: false, reason: "no session", transient: false };
    try {
      for await (const msg of this.q as AsyncIterable<SDKMessage>) {
        if (this.finished) return { done: true };
        this.bumpIdle(); // any SDK message (incl. stream events) = progress → reset the stall watchdog
        if (msg.type === "system" && "session_id" in msg && typeof msg.session_id === "string") {
          this.sessionId = msg.session_id; // captured for resume-on-retry
          this.onSession(this.runId, msg.session_id);
        } else if (msg.type === "stream_event") {
          // Live "typing" only — never persisted itself. The complete text still
          // lands exactly once via the `assistant` branch below (onLog/onChatReply),
          // same as before includePartialMessages; this just previews it early.
          const delta = textDeltaOf(msg);
          if (delta) this.events.onLogDelta?.(this.runId, delta);
        } else if (msg.type === "assistant") {
          const { text, tools } = readAssistant((msg as { message: { content?: unknown } }).message);
          if (text) {
            // Remember overload/rate-limit chatter so a later error result can be
            // classified as transient even if its subtype is generic.
            if (isTransientApiError(text)) this.lastApiError = text;
            if (this.pendingChat) { this.pendingChat = false; this.events.onChatReply(this.runId, text); }
            else { this.lastRationale = text; this.events.onLog(this.runId, text); }
          }
          for (const t of tools) {
            if (t.id) this.pendingTools.set(t.id, t.name);
            // The agent's task-tracking tools are its plan — feed them to the PLAN
            // panel + progress instead of logging them as tool lines / bumping the
            // synthetic bar.
            if (PLAN_TOOLS.has(t.name)) {
              this.applyPlanTool(t.name, t.input);
              continue;
            }
            // Log line carries the call's full input as expandable detail.
            this.events.onLog(this.runId, `▸ ${describeTool(t.name, t.input)}`, approvalText(t.name, t.input));
            this.bump();
          }
        } else if (msg.type === "user") {
          // Tool results come back as a user message; surface each tool's output
          // as an expandable ↳ entry paired (by id) with the call above.
          const mm = (msg as unknown as { message?: { content?: unknown } }).message;
          const blocks: Array<Record<string, unknown>> = Array.isArray(mm?.content)
            ? (mm!.content as Array<Record<string, unknown>>)
            : [];
          for (const b of blocks) {
            if (b.type !== "tool_result") continue;
            const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
            const name = (id && this.pendingTools.get(id)) || "tool";
            if (id) this.pendingTools.delete(id);
            const out = toolResultText(b.content);
            this.events.onLog(this.runId, `↳ ${name}${b.is_error ? " failed" : ""}`, clip(out, 6000) || "(no output)");
          }
        } else if (msg.type === "result") {
          // The SDK emits a result even for an errored turn (is_error / non-success
          // subtype). Treat that as a failure — not a completion (the bug: a 529
          // storm was being reported as `done` with an empty diff).
          this.emitUsage(msg as Record<string, unknown>);
          const err = classifyResult(msg as Record<string, unknown>, this.lastApiError);
          return err ? { done: false, ...err } : { done: true };
        }
      }
    } catch (err) {
      // Thrown mid-stream (network/SDK). Retryable only if it reads as overload —
      // but a billing wall (credit/quota) never recovers, so it's not transient.
      const reason = (err as Error).message || String(err);
      return { done: false, reason, transient: !isCreditExhaustionError(reason) && isTransientApiError(reason) };
    }
    // Stream ended with no explicit result message → treat as clean completion.
    return { done: true };
  }

  /** Relaunch the query after a transient failure: a fresh input stream (the old
   *  single-consumer one was abandoned by the errored query), resuming this run's
   *  session if we have one, else re-sending the kickoff prompt from scratch. */
  private relaunch() {
    this.input = createInputStream();
    const opts: Options = this.sessionId
      ? { ...(this.baseOptions as Options), resume: this.sessionId }
      : (this.baseOptions as Options);
    this.input.push(
      this.sessionId ? "Continue the task from where you left off." : this.initialPrompt,
    );
    this.q = queryImpl({ prompt: this.input, options: opts });
  }

  /** Could-not-run path: mark needs-attention, never onCompleted. */
  private fail(reason: string) {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    if (this.cap) clearTimeout(this.cap);
    if (this.idle) clearTimeout(this.idle);
    this.events.onFailed(this.runId, reason);
    this.input.close();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    if (this.cap) clearTimeout(this.cap);
    if (this.idle) clearTimeout(this.idle);
    // Keep the real plan visible on completion (all steps done), rather than
    // blanking it — the PLAN panel stays meaningful for a finished agent.
    const donePlan = this.plan.map((p) => ({ ...p, state: "done" as const }));
    this.events.onProgress(this.runId, 1, donePlan);
    // NOTE: do NOT emit onStatus("done") here. Compute is finished, but the agent
    // is not terminal until the orchestrator commits its worktree → review →
    // merge (or confirms an empty diff). Signalling "done" now would race that
    // integration and expose a premature "done" with uncommitted work. Hand off
    // via onCompleted and let the orchestrator own the terminal transition.
    this.events.onCompleted(this.runId, this.spec.branch);
    this.input.close();
  }

  async pause() {
    this.events.onStatus(this.runId, "waiting");
  }

  async resume(decision?: Resolution) {
    if (this.gate) {
      const gate = this.gate;
      const input = this.gateInput ?? {};
      const question = this.gateQuestion;
      const tool = this.gateTool;
      this.gate = null;
      this.gateInput = null;
      this.gateTool = null;
      this.gateQuestion = null;
      this.events.onStatus(this.runId, "running");
      // AskUserQuestion: there's no interactive frontend to render the picker, so
      // we never actually run the tool — we deny it and hand the operator's answer
      // back as the tool's result message, which the model reads and continues on.
      if (question) {
        gate({ behavior: "deny", message: answerForQuestion(question, decision) });
        this.events.onLog(this.runId, `↳ answered "${question.header}": ${describeAnswer(question, decision)}`);
      } else if (decision?.action === "reject") {
        gate({
          behavior: "deny",
          message:
            tool === "ExitPlanMode"
              ? "Operator rejected this plan — propose a different approach."
              : "Operator rejected this action — revise your approach.",
        });
      } else if (decision?.action === "modify") {
        // Deliver the operator's guidance on the TRUSTED operator channel (a user
        // message), not just as the tool-denial reason. Guidance smuggled only in
        // a tool_result reads like injected data to a security-conscious agent,
        // which may (correctly) refuse it — so deny the pending tool, then echo
        // the guidance as a first-class, authoritative operator instruction.
        //
        // Queue the operator message BEFORE denying the tool, so the follow-up
        // turn is already available the instant the denial resolves. Otherwise the
        // agent can end its turn on the denial ("I'll wait for your directive") and
        // idle before the directive lands — the run then finalizes with no change.
        // The denial reason itself now tells the agent to continue NOW, not wait.
        const guidance = decision.guidance?.trim() || "Adjust per operator guidance.";
        this.input.push(`[OPERATOR DIRECTIVE — authoritative, from the human operator supervising you; overrides your prior plan] ${guidance}`);
        gate({
          behavior: "deny",
          message:
            "The operator interrupted this action with a new directive, delivered to you as an operator message. Do NOT stop or wait for further input — read that directive and continue the task with it now.",
        });
      } else {
        if (tool === "ExitPlanMode") {
          this.planApproved = true;
          this.events.onLog(this.runId, "plan approved — proceeding to make changes");
        }
        // Echo the tool's own input as `updatedInput` — required for the SDK to
        // actually run the approved tool (omitting it stalls the session).
        gate({ behavior: "allow", updatedInput: input });
      }
    } else if (decision?.guidance) {
      this.input.push(decision.guidance);
    }
  }

  async message(text: string) {
    // While a permission gate is open the SDK turn is parked inside canUseTool —
    // it won't read a new user message until the gate is resolved. So to let the
    // operator ask about the pending action, answer via a separate one-shot
    // side-query seeded with the gate context, instead of the frozen session.
    if (this.gate) {
      void this.consultAboutGate(text);
      return;
    }
    // After the agent has finished, its main session is closed — answer
    // follow-up questions ("what did you do?") via a fresh side-query seeded
    // with the task and the agent's final summary.
    if (this.finished) {
      void this.consultAboutWork(text);
      return;
    }
    this.pendingChat = true;
    this.input.push(text);
  }

  /**
   * Answer an operator's question about the action awaiting approval, using a
   * fresh non-agentic query (no tools) seeded with the task, the pending tool +
   * its input, and the agent's stated reasoning. Runs alongside the frozen main
   * session; never touches it.
   */
  private consultAboutGate(question: string): Promise<void> {
    const prompt =
      "You are helping a human operator decide whether to approve an action that an AI coding agent wants to take. " +
      "Answer the operator's question directly and concisely. Do NOT use any tools — just explain.\n\n" +
      `TaskRun's task: ${this.spec.task}\n` +
      `Working directory: ${this.spec.cwd ?? process.cwd()}\n` +
      (this.lastRationale ? `TaskRun's stated reasoning: ${this.lastRationale}\n` : "") +
      `Pending action: ${this.gateTool ?? "tool"} with input:\n${JSON.stringify(this.gateInput ?? {}, null, 2)}\n\n` +
      `Operator's question: ${question}`;
    return this.runConsult(
      prompt,
      "I'm paused on the command above — Approve to run it, Reject to skip, or Modify to redirect me.",
    );
  }

  /**
   * Answer a follow-up about already-finished work. The main session is closed,
   * so this is a fresh non-agentic query seeded with the task and the agent's
   * final summary — lets the operator ask "what did you do?" after completion.
   */
  private consultAboutWork(question: string): Promise<void> {
    const prompt =
      "You are an AI coding agent that has FINISHED a task. Answer the operator's follow-up question " +
      "directly and concisely, based on what you did. Do NOT use any tools — just explain.\n\n" +
      `Task: ${this.spec.task}\n` +
      `Working directory: ${this.spec.cwd ?? process.cwd()}\n` +
      `Branch: ${this.spec.branch}\n` +
      (this.lastRationale ? `Your final summary/answer was:\n${this.lastRationale}\n` : "") +
      `\nOperator's question: ${question}`;
    return this.runConsult(prompt, "The task is complete — ask me anything about what I did.");
  }

  /** Run a one-shot, tool-less query and emit its text as a chat reply. */
  private async runConsult(prompt: string, fallback: string): Promise<void> {
    const answer = await oneShotConsult({
      prompt,
      cwd: this.spec.cwd ?? process.cwd(),
      model: this.spec.model,
      env: this.sdkEnv,
      fallback,
    });
    this.events.onChatReply(this.runId, answer);
  }

  async stop() {
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    if (this.cap) clearTimeout(this.cap);
    if (this.idle) clearTimeout(this.idle);
    // Release a parked permission/escalation gate so its canUseTool promise
    // never dangles when we tear the session down (e.g. operator stops an
    // escalated run while it's blocked in the gate).
    if (this.gate) {
      const gate = this.gate;
      this.gate = null;
      this.gateInput = null;
      this.gateTool = null;
      this.gateQuestion = null;
      gate({ behavior: "deny", message: "Run stopped by operator." });
    }
    await this.q?.interrupt().catch(() => undefined);
    this.input.close();
  }

  /** This run's own SDK session id, if one has been captured yet — for
   *  checkpointing (see {@link RunnerHandle.getSessionId}). */
  getSessionId(): string | undefined {
    return this.sessionId;
  }
}

export class ClaudeRunnerProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  // runId → SDK session id, so a fork can resume a parent's context. Bounded
  // LRU (see MAX_SESSIONS): a Map preserves insertion order, so re-inserting
  // an entry on both read and write keeps it at the "most recent" end;
  // eviction always drops the true least-recently-used entry, not just the
  // oldest-written one.
  private sessions = new Map<string, string>();

  private getSession(runId: string): string | undefined {
    const sessionId = this.sessions.get(runId);
    if (sessionId !== undefined) {
      this.sessions.delete(runId);
      this.sessions.set(runId, sessionId); // touch: move to the MRU end
    }
    return sessionId;
  }

  private setSession(runId: string, sessionId: string): void {
    this.sessions.delete(runId); // re-set below moves it to the MRU end either way
    this.sessions.set(runId, sessionId);
    if (this.sessions.size > maxSessionsImpl) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
  }

  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    // An explicit checkpoint restore takes precedence over the parentId-based
    // fork lookup — a restore isn't a fork (no parent run), just an earlier
    // session on this same run. The fork lookup goes through getSession() (not
    // a raw .get()) so it counts as a touch for the LRU cache below.
    const resumeSessionId = spec.resumeSessionId ?? (spec.parentId ? this.getSession(spec.parentId) : undefined);
    return new ClaudeRunnerHandle(
      spec,
      events,
      (runId, sessionId) => this.setSession(runId, sessionId),
      resumeSessionId,
    );
  }

  /** Answer a follow-up about a finished agent with no live handle (e.g. after a
   *  server restart) — a fresh tool-less query grounded in the agent's state. */
  async consult(spec: ConsultSpec, question: string): Promise<string> {
    const answer = await oneShotConsult({
      ...consultQuery(spec, question),
      fallback: "The task is complete — ask me anything about what I did.",
    });
    return answer;
  }

  /** Streaming variant of {@link consult} — yields the answer as text deltas. */
  consultStream(spec: ConsultSpec, question: string): AsyncIterable<string> {
    return oneShotConsultStream(consultQuery(spec, question));
  }
}

/** The shared (prompt, cwd, model, env) for a consult — used by both the
 *  accumulating and streaming paths so they ask identically. */
function consultQuery(
  spec: ConsultSpec,
  question: string,
): { prompt: string; cwd: string; model: string; env: Record<string, string> } {
  const base = buildRunnerEnv();
  const env = spec.apiKey ? { ...base, ANTHROPIC_API_KEY: spec.apiKey } : base;
  // Two framings share this function:
  //   • spec.system set  → caller owns the ROLE (e.g. Telegram intent classifier
  //     with its own "you are Skynet's assistant, return {reply, action}" prompt).
  //     `question` is the actual operator message (untrusted data — the caller's
  //     system prompt already says how to treat it); `context` is the grounding.
  //   • spec.system unset → the original use case: a FINISHED agent answering an
  //     operator follow-up about what it did. `context` is the agent's own log,
  //     `question` the operator's follow-up.
  const prompt = spec.system
    ? `${spec.system}\n\n` +
      (spec.context ? `=== GROUNDING ===\n${spec.context}\n\n` : "") +
      `=== OPERATOR MESSAGE ===\n${question}`
    : "You are an AI coding agent that has FINISHED a task. Answer the operator's follow-up " +
      "question directly and concisely, based on what you did. Do NOT use any tools — just explain.\n\n" +
      `Task: ${spec.task}\n` +
      (spec.context ? `What you did (your log / final answer):\n${spec.context}\n` : "") +
      `\nOperator's question: ${question}`;
  return { prompt, cwd: spec.cwd ?? process.cwd(), model: spec.model, env };
}
