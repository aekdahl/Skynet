// Keys & Budget panel (TASK 20) — Operations.addApprovalRule, the "+ add
// pattern" direct-add path. Exercises the full Operations path against a real
// MemoryStore + Hub. TASK 16's "ALWAYS FOR THIS PROJECT" trust-widening
// action and this panel's direct-add both read/write the IDENTICAL
// Project.approvalRules field (see rememberApproval in operations.ts) — this
// suite proves addApprovalRule's own contract; approval-policy.test.ts proves
// decideAutoApproval reads whatever lands there identically regardless of
// which path wrote it.
import { describe, it, expect } from "vitest";
import type { ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { CommandNotRememberableError, NotFoundError, Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: { ws: string; event: ServerEvent }[] = [];
  publish(ws: string, event: ServerEvent): void { this.events.push({ ws, event }); }
  subscribe(): () => void { return () => {}; }
}

class NoopProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const setup = () => {
  const store = new MemoryStore();
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator });
  return { store, hub, bus, ops };
};

const mkProject = async (ops: Operations) => ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "ship" });

describe("Operations.addApprovalRule", () => {
  it("adds a standing rule with a SERVER-derived risk cap, publishing project.upserted", async () => {
    const { ops, bus } = setup();
    const project = await mkProject(ops);
    const upsertsBefore = bus.events.filter((e) => e.event.type === "project.upserted").length; // createProject itself publishes one
    const updated = await ops.addApprovalRule(DEFAULT_WORKSPACE, project.id, "npm test", "alex");
    expect(updated.approvalRules).toHaveLength(1);
    // "npm test" matches no allow/gate rule, so it falls to the policy's
    // defaultRisk ("medium") — see command-safety.ts's DEFAULT_COMMAND_POLICY.
    expect(updated.approvalRules[0]).toMatchObject({ command: "npm test", riskCap: "medium", createdBy: "alex" });
    const upserts = bus.events.filter((e) => e.event.type === "project.upserted");
    expect(upserts).toHaveLength(upsertsBefore + 1);
  });

  it("normalizes whitespace the same way the HITL 'remember' path does", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    const updated = await ops.addApprovalRule(DEFAULT_WORKSPACE, project.id, "  npm   test\n", "alex");
    expect(updated.approvalRules[0]!.command).toBe("npm test");
  });

  it("is idempotent — re-adding an already-standing command doesn't duplicate it", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    await ops.addApprovalRule(DEFAULT_WORKSPACE, project.id, "npm test", "alex");
    const again = await ops.addApprovalRule(DEFAULT_WORKSPACE, project.id, "npm   test", "sam");
    expect(again.approvalRules).toHaveLength(1);
    expect(again.approvalRules[0]!.createdBy).toBe("alex"); // untouched by the second call
  });

  it("throws — never silently gates — for a high-risk command that can never be remembered", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    await expect(ops.addApprovalRule(DEFAULT_WORKSPACE, project.id, "git push origin main", "alex")).rejects.toThrow(CommandNotRememberableError);
    const fresh = await ops.getProject(DEFAULT_WORKSPACE, project.id);
    expect(fresh.approvalRules).toHaveLength(0); // nothing recorded on the failed attempt
  });

  it("throws — never silently gates — for a hard-denied command", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    await expect(ops.addApprovalRule(DEFAULT_WORKSPACE, project.id, "rm -rf /", "alex")).rejects.toThrow(CommandNotRememberableError);
  });

  it("404s for an unknown or cross-workspace project", async () => {
    const { ops } = setup();
    await expect(ops.addApprovalRule(DEFAULT_WORKSPACE, "nope", "npm test", "alex")).rejects.toThrow(NotFoundError);
    const project = await mkProject(ops);
    await expect(ops.addApprovalRule("other-ws", project.id, "npm test", "alex")).rejects.toThrow(NotFoundError);
  });
});
