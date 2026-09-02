// Three defects that compound into the expensive loop behind this deployment's
// own measured "only ~19% of spend reached a merge":
//
//   1. An agent parked on a HUMAN gate was force-failed after 8 minutes,
//      because the stall watchdog only resets on SDK messages and none flow
//      while canUseTool is parked — while the product's own default is to wait
//      for a human indefinitely (hitlQuestionTimeoutMs = 0).
//   2. The resume then started a FRESH session, throwing away the conversation.
//   3. …so the replacement re-read the repo to re-derive what was already known.
//
// The waiting was never the cost. The kill turning a paused, resumable run into
// a dead one was.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeRunnerProvider, __setClaudeTestHooks } from "../packages/runner-sdk/src/claude.js";
import { buildAgentContext } from "../apps/server/src/agent-context.js";
import type { RunnerEvents } from "../packages/runner-sdk/src/types.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// ── 1. the watchdog ────────────────────────────────────────────────────────
describe("a run parked on a human is not 'stalled'", () => {
  it("pauses the idle watchdog when a gate opens", () => {
    const src = read("../packages/runner-sdk/src/claude.ts");
    // Both gate-registration sites must pause it — one of them covers
    // AskUserQuestion, the other every remaining approval.
    expect(src.match(/this\.pauseIdle\(\);/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(src).toContain("private pauseIdle()");
  });

  it("re-arms it on resume, so a run that wedges after resuming is still caught", () => {
    const src = read("../packages/runner-sdk/src/claude.ts");
    const resume = src.slice(src.indexOf("async resume(decision"), src.indexOf("async resume(decision") + 1200);
    expect(resume).toContain("this.bumpIdle()");
  });

  it("leaves the TOTAL-runtime cap armed — a genuinely wedged run must still die", () => {
    const src = read("../packages/runner-sdk/src/claude.ts");
    expect(src).toContain("runtimeCapMs");
    // pauseIdle must clear only the idle timer, never the outer cap.
    const fn = src.slice(src.indexOf("private pauseIdle()"), src.indexOf("private bumpIdle()"));
    expect(fn).toContain("this.idle");
    expect(fn).not.toContain("this.cap");
  });
});

// ── 2. the resume ──────────────────────────────────────────────────────────
describe("escalation-resume reuses the session", () => {
  it("passes parentId so the runner can resume this run's own session", () => {
    const src = read("../apps/server/src/orchestrator.ts");
    // Bounded by the function's own extent rather than a character window —
    // relaunchEscalated is ~11k chars and a fixed window silently missed it.
    const start = src.indexOf("private async relaunchEscalated");
    const end = src.indexOf("\n  private ", start + 40);
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, end)).toContain("parentId: runId");
  });

  it("a deliberate reset still gets a clean slate", () => {
    // reassign + resetWork short-circuits BEFORE relaunchEscalated, so resuming
    // by default must not have quietly removed the operator's clean-slate option.
    const src = read("../apps/server/src/orchestrator.ts");
    expect(src).toContain('if (resolution.action === "reassign" && resolution.resetWork)');
  });

  it("the runner falls back to a fresh session when there is nothing to resume", () => {
    // The session map is in-memory, so a server restart loses it. That must
    // degrade gracefully — and is exactly why the handoff exists.
    const src = read("../packages/runner-sdk/src/claude.ts");
    expect(src).toContain("spec.resumeSessionId ?? (spec.parentId ? this.getSession(spec.parentId) : undefined)");
  });
});

// ── 3. the handoff ─────────────────────────────────────────────────────────
describe("the handoff summary", () => {
  it("appears in the prompt, before the task, when present", () => {
    const out = buildAgentContext({ body: "do the thing", handoff: "Why it stopped: needed a credential" });
    expect(out).toContain("WHERE THIS RUN LEFT OFF");
    expect(out).toContain("needed a credential");
    expect(out.indexOf("WHERE THIS RUN LEFT OFF")).toBeLessThan(out.indexOf("=== TASK ==="));
  });

  it("is absent entirely on a first run — no empty scaffolding", () => {
    expect(buildAgentContext({ body: "do the thing" })).not.toContain("WHERE THIS RUN LEFT OFF");
    expect(buildAgentContext({ body: "x", handoff: "   " })).not.toContain("WHERE THIS RUN LEFT OFF");
  });

  it("is capped — orientation, not a transcript", () => {
    // It exists to SHRINK what a relaunch pays for. An uncapped one would
    // re-bloat the prompt it was added to reduce.
    const out = buildAgentContext({ body: "t", handoff: "x".repeat(50_000) });
    expect(out.length).toBeLessThan(10_000);
  });

  it("tells the agent to verify it rather than trust it blindly", () => {
    const out = buildAgentContext({ body: "t", handoff: "something" });
    expect(out).toMatch(/verify before relying on it/i);
  });

  it("is composed WITHOUT a model call", () => {
    // The agent's escalation reason is already its own account of what blocked
    // it. Paying a model to summarise text we already have, on the very code
    // path that exists to stop paying twice for context, would be self-defeating.
    const src = read("../apps/server/src/orchestrator.ts");
    const fn = src.slice(src.indexOf("private composeHandoffFor"), src.indexOf("private async escalate("));
    expect(fn).not.toMatch(/oneShot|consult|assessTask/);
    expect(fn).toContain("run.log");
  });

  it("drops tool/telemetry chatter, which a fresh agent can see for itself", () => {
    const src = read("../apps/server/src/orchestrator.ts");
    const fn = src.slice(src.indexOf("private composeHandoffFor"), src.indexOf("private async escalate("));
    expect(fn).toContain("NOISE");
  });
});
