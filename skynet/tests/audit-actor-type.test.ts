// TASK 21 — GET /api/audit (Operations.listAudit) attaches `actorType`
// (human/policy/agent-review) to every row at response time, computed from
// the stored operatorId via compliance/report.ts's classifyApprover — the
// SAME classifier the compliance evidence pack already used, not a second
// one. No schema change to the persisted AuditRecord itself.
import { describe, it, expect } from "vitest";
import type { ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE, classifyOperatorId } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}
class NoopProvider implements RunnerProvider {
  readonly id = "claude" as const;
  async start(): Promise<never> { throw new Error("not used"); }
}

function setup() {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator: orch });
  return { store, ops };
}

describe("Operations.listAudit — actorType", () => {
  it("classifies a policy: operatorId as 'policy'", async () => {
    const { store, ops } = setup();
    await store.recordAudit({
      workspaceId: DEFAULT_WORKSPACE, hitlId: "h1", runId: "r1", action: "approve",
      operatorId: "policy:trusted", at: 1000, payload: {},
    });
    const [row] = await ops.listAudit(DEFAULT_WORKSPACE);
    expect(row!.actorType).toBe("policy");
  });

  it("classifies operatorId 'autonomy' as 'agent-review'", async () => {
    const { store, ops } = setup();
    await store.recordAudit({
      workspaceId: DEFAULT_WORKSPACE, hitlId: "h2", runId: "r2", action: "approve",
      operatorId: "autonomy", at: 1000, payload: {},
    });
    const [row] = await ops.listAudit(DEFAULT_WORKSPACE);
    expect(row!.actorType).toBe("agent-review");
  });

  it("classifies a real operator id as 'human'", async () => {
    const { store, ops } = setup();
    await store.recordAudit({
      workspaceId: DEFAULT_WORKSPACE, hitlId: "h3", runId: "r3", action: "approve",
      operatorId: "jordan@example.com", at: 1000, payload: {},
    });
    const [row] = await ops.listAudit(DEFAULT_WORKSPACE);
    expect(row!.actorType).toBe("human");
  });

  it("every row gets a classification, matching the shared bare classifier 1:1", async () => {
    const { store, ops } = setup();
    const rows = [
      { hitlId: "h1", operatorId: "policy:full-autonomy" },
      { hitlId: "h2", operatorId: "autonomy" },
      { hitlId: "h3", operatorId: "op-abc" },
    ];
    for (const r of rows) {
      await store.recordAudit({ workspaceId: DEFAULT_WORKSPACE, hitlId: r.hitlId, runId: "r1", action: "approve", operatorId: r.operatorId, at: 1000, payload: {} });
    }
    const listed = await ops.listAudit(DEFAULT_WORKSPACE);
    for (const row of listed) {
      expect(row.actorType).toBe(classifyOperatorId(row.operatorId));
    }
  });
});
