// ─── Mock runner ──────────────────────────────────────────────────────────
// Phase 0 stand-in: a canned 4-step plan with simulated log lines, a heartbeat,
// and one HITL gate (approval) — mirroring the prototype's fake activity loop.
// Replace with real provider runners in Phase 1; the orchestrator is unchanged.

import type { PlanStep, ProviderId, Resolution } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "./types.js";

const LOG_POOL = [
  "reading project context",
  "drafting approach",
  "running test suite — green",
  "refactoring module boundaries",
  "updating fixtures",
  "type-check clean",
];

const CANNED_PLAN: PlanStep[] = [
  { text: "Survey the affected modules", state: "now" },
  { text: "Implement the change", state: "todo" },
  { text: "Run the test suite", state: "todo" },
  { text: "Open PR with rollout notes", state: "todo" },
];

class MockRunnerHandle implements RunnerHandle {
  readonly agentId: string;
  readonly provider: ProviderId = "claude";
  private plan: PlanStep[] = CANNED_PLAN.map((s) => ({ ...s }));
  private progress = 0;
  private step = 0;
  private paused = false;
  private done = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private tick?: ReturnType<typeof setInterval>;

  constructor(private spec: StartSpec, private events: RunnerEvents) {
    this.agentId = spec.agentId;
    this.events.onStatus(this.agentId, "running");
    this.heartbeat = setInterval(() => this.events.onHeartbeat(this.agentId), 5_000);
    this.tick = setInterval(() => this.advance(), 2_500);
    this.events.onLog(this.agentId, `picked up "${spec.task}" on ${spec.branch}`);
  }

  private advance() {
    if (this.paused || this.done) return;
    this.events.onLog(this.agentId, LOG_POOL[Math.floor(this.progress * LOG_POOL.length) % LOG_POOL.length]!);
    this.progress = Math.min(0.95, this.progress + 0.12);

    // Advance the plan checklist roughly in step with progress.
    const target = Math.min(this.plan.length - 1, Math.floor(this.progress * this.plan.length));
    if (target > this.step) {
      this.plan[this.step]!.state = "done";
      this.step = target;
      this.plan[this.step]!.state = "now";
    }
    this.events.onProgress(this.agentId, this.progress, this.plan);

    // Around the midpoint, block on a human (approval gate).
    if (this.progress >= 0.45 && this.progress < 0.6) {
      this.paused = true;
      this.events.onStatus(this.agentId, "waiting");
      this.events.onHitl(this.agentId, {
        kind: "approval",
        title: `Approve: ${this.spec.task}`,
        why: "Wants to run a potentially destructive command before continuing.",
        risk: "medium",
        command: "pnpm db:migrate --env staging",
        options: null,
        recommended: null,
        steps: null,
        diff: null,
      });
    }
  }

  async pause() {
    this.paused = true;
    this.events.onStatus(this.agentId, "waiting");
  }

  async resume(decision?: Resolution) {
    if (this.done) return;
    this.paused = false;
    if (decision?.action === "reject") {
      this.events.onLog(this.agentId, "decision: rejected — revising approach");
      this.progress = Math.max(0.3, this.progress - 0.1);
    } else if (decision?.action === "modify") {
      this.events.onLog(this.agentId, `decision: modify — "${decision.guidance ?? ""}"`);
    } else {
      this.events.onLog(this.agentId, "decision: approved — continuing");
    }
    this.events.onStatus(this.agentId, "running");
    // Drive to completion shortly after resume.
    setTimeout(() => this.finish(), 6_000);
  }

  async message(text: string) {
    this.events.onChatReply(this.agentId, `re: "${text}" — noted, factoring it in.`);
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    this.plan.forEach((s) => (s.state = "done"));
    this.events.onProgress(this.agentId, 1, this.plan);
    this.events.onStatus(this.agentId, "done");
    this.events.onCompleted(this.agentId, this.spec.branch);
    this.teardown();
  }

  async stop() {
    this.done = true;
    this.teardown();
  }

  private teardown() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.tick) clearInterval(this.tick);
  }
}

export class MockRunnerProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    return new MockRunnerHandle(spec, events);
  }
}
