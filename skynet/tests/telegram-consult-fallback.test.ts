// Regression: the Telegram conversational bridge's BYOK intent-parse
// (orchestrator.consult) must find a consult-capable provider key even when NO
// fleet agent is configured yet. The original bug only iterated fleet agents, so
// a Claude key set in .env/skynet.env was ignored until a Claude *agent* existed
// — the operator saw "No provider key available" despite having a key.
import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type {
  RunnerProvider,
  RunnerEvents,
  RunnerHandle,
  StartSpec,
  ConsultSpec,
} from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// An injected provider with a `.consult` — echoes the model + key it was given so
// the test can prove the env key was resolved and passed through.
const provider: RunnerProvider = {
  id: "claude",
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: "claude", async pause() {}, async resume() {}, async message() {}, async stop() {} };
  },
  async consult(spec: ConsultSpec): Promise<string> {
    return `CONSULTED model=${spec.model} key=${spec.apiKey}`;
  },
};

const prev = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prev;
});

describe("orchestrator.consult — fleet-independent BYOK fallback", () => {
  it("uses a Claude key from the env even with NO fleet agent configured", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    const store = new MemoryStore();
    const orch = new Orchestrator(store, new Hub(store, new NullBus()), provider);
    // Deliberately no agents in the fleet.
    const reply = await orch.consult(DEFAULT_WORKSPACE, "classify this message");
    expect(reply).toContain("CONSULTED");
    expect(reply).toContain("sk-test-key"); // the env key was resolved + passed through
  });

  it("returns null when no consult-capable key is available anywhere", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const store = new MemoryStore();
    const orch = new Orchestrator(store, new Hub(store, new NullBus()), provider);
    expect(await orch.consult(DEFAULT_WORKSPACE, "x")).toBeNull();
  });
});
