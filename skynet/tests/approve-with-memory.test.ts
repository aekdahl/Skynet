// Approve-with-memory (roadmap: "the Inbox becomes how policy/memory get
// authored") — an operator can attach a durable-preference note to an approval
// in-flow. This is PLUMBING ONLY: Memory v0 (the actual fact store/injection)
// hasn't landed yet, so nothing reads this back — these tests cover exactly
// what exists today: the note is captured, trimmed, gated to `approve` only,
// and lands on both the resolution and the audit trail so the intent isn't
// lost. See Resolution.memoryNote (contracts.ts) and Operations.resolveHitl.
import { describe, it, expect } from "vitest";
import type { HitlItem, ProviderId } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

function setup() {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, new RunningProvider());
  const ops = new Operations({ store, hub, orchestrator });
  return { store, hub, ops };
}

const gate = (id: string, overrides: Partial<HitlItem> = {}): HitlItem => ({
  id, workspaceId: DEFAULT_WORKSPACE, runId: "a1", kind: "approval",
  title: "Run migration?", why: "schema change", risk: "medium",
  raisedAt: 0, resolvedAt: null, resolution: null,
  command: "migrate", options: null, recommended: null, steps: null, diff: null,
  ...overrides,
});

describe("approve-with-memory — in-flow note capture", () => {
  it("captures a trimmed memory note alongside an approve, on both the resolution and the audit trail", async () => {
    const { hub, ops, store } = setup();
    await hub.raiseHitl(gate("q1"));

    const resolved = await ops.resolveHitl(
      DEFAULT_WORKSPACE, "q1",
      { action: "approve", memoryNote: "  this project prefers snake_case for Python files  " },
      "jordan",
    );
    expect(resolved.resolution?.memoryNote).toBe("this project prefers snake_case for Python files");

    const audit = await store.listAudit(DEFAULT_WORKSPACE);
    const rec = audit.find((a) => a.hitlId === "q1");
    expect((rec?.payload as { memoryNote?: string })?.memoryNote).toBe(
      "this project prefers snake_case for Python files",
    );
  });

  it("drops the note on a non-approve action — a rejection has nothing to generalize", async () => {
    const { hub, ops } = setup();
    await hub.raiseHitl(gate("q2"));
    const resolved = await ops.resolveHitl(
      DEFAULT_WORKSPACE, "q2",
      { action: "reject", memoryNote: "should never be stored" },
      "jordan",
    );
    expect(resolved.resolution?.memoryNote).toBeNull();
  });

  it("treats a whitespace-only note as no note at all", async () => {
    const { hub, ops } = setup();
    await hub.raiseHitl(gate("q3"));
    const resolved = await ops.resolveHitl(DEFAULT_WORKSPACE, "q3", { action: "approve", memoryNote: "   " }, "jordan");
    expect(resolved.resolution?.memoryNote).toBeNull();
  });

  it("defaults to null when no note is sent at all — the ordinary approve path is unchanged", async () => {
    const { hub, ops } = setup();
    await hub.raiseHitl(gate("q4"));
    const resolved = await ops.resolveHitl(DEFAULT_WORKSPACE, "q4", { action: "approve" }, "jordan");
    expect(resolved.resolution?.memoryNote).toBeNull();
  });

  it("a diff-kind gate can carry a memory note too — not limited to command approvals (that's the exact-command 'Always allow' rule's job)", async () => {
    const { hub, ops, store } = setup();
    await hub.raiseHitl(gate("q5", {
      kind: "diff", command: null,
      diff: { add: 3, del: 1, modules: ["api"], files: ["a.ts"], walkthrough: null },
    }));
    const resolved = await ops.resolveHitl(DEFAULT_WORKSPACE, "q5", { action: "approve", memoryNote: "this project reviews API changes closely" }, "jordan");
    expect(resolved.resolution?.memoryNote).toBe("this project reviews API changes closely");
    const rec = (await store.listAudit(DEFAULT_WORKSPACE)).find((a) => a.hitlId === "q5");
    expect((rec?.payload as { memoryNote?: string })?.memoryNote).toBe("this project reviews API changes closely");
  });
});
