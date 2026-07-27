// Friendly fleet-agent names: new agents get `<provider>-<name>` (e.g.
// claude-ada) instead of an opaque `runner-<id>`, the name is unique within the
// workspace, and the id is a stable opaque handle decoupled from the name (so a
// rename never moves it and two agents can share a display name safely).
import { describe, it, expect } from "vitest";
import type { ProviderId } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { AGENT_NAME_POOL, generateAgentName } from "../apps/server/src/fleet-names.js";
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
  const ops = new Operations({ store, hub, orchestrator: new Orchestrator(store, hub, new RunningProvider()) });
  return { store, ops };
}

describe("generateAgentName", () => {
  it("returns <provider>-<name> from the pool, skipping taken ones", () => {
    expect(generateAgentName("claude", [])).toBe(`claude-${AGENT_NAME_POOL[0]}`);
    expect(generateAgentName("claude", [`claude-${AGENT_NAME_POOL[0]}`])).toBe(`claude-${AGENT_NAME_POOL[1]}`);
  });

  it("is per-provider — another provider isn't blocked by claude's names", () => {
    expect(generateAgentName("codex", [`claude-${AGENT_NAME_POOL[0]}`])).toBe(`codex-${AGENT_NAME_POOL[0]}`);
  });

  it("appends a numeric suffix once the pool is exhausted", () => {
    const taken = AGENT_NAME_POOL.map((n) => `claude-${n}`);
    expect(generateAgentName("claude", taken)).toBe(`claude-${AGENT_NAME_POOL[0]}-2`);
  });
});

describe("configureRunner naming", () => {
  it("auto-names uniquely and mints a stable opaque id (not the name)", async () => {
    const { ops } = setup();
    const a = await ops.configureRunner(DEFAULT_WORKSPACE, { provider: "claude", model: "opus-4.8" });
    expect(a.name).toBe(`claude-${AGENT_NAME_POOL[0]}`);
    expect(a.id).toMatch(/^runner-/);
    expect(a.id).not.toBe(a.name);

    // A second claude agent (different model) gets the next free name, not a dup.
    const b = await ops.configureRunner(DEFAULT_WORKSPACE, { provider: "claude", model: "sonnet-4.6" });
    expect(b.name).toBe(`claude-${AGENT_NAME_POOL[1]}`);
    expect(b.id).not.toBe(a.id);
  });

  it("honors an explicit name but still mints an opaque id; rename never moves the id", async () => {
    const { ops } = setup();
    const a = await ops.configureRunner(DEFAULT_WORKSPACE, { provider: "claude", model: "opus-4.8", name: "backend-bot" });
    expect(a.name).toBe("backend-bot");
    expect(a.id).not.toBe("backend-bot");

    const renamed = await ops.updateAgent(DEFAULT_WORKSPACE, a.id, { name: "frontend-bot" });
    expect(renamed.name).toBe("frontend-bot");
    expect(renamed.id).toBe(a.id); // id stable across rename
  });
});
