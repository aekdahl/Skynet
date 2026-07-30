// The MCP tool core is a second front-end onto Operations, gated by the calling
// token's scopes. These drive it through a real in-memory MCP client so the
// wiring — tool registration, scope enforcement, delegation to Operations — is
// exercised end to end, plus the bus-backed wait primitive in isolation.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { HitlItem, ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Principal } from "../apps/server/src/auth.js";
import { InProcessBus } from "../apps/server/src/bus.js";
import { Hub } from "../apps/server/src/hub.js";
import { Operations } from "../apps/server/src/operations.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { buildMcpServer } from "../apps/server/src/mcp/tools.js";
import { waitForEvent } from "../apps/server/src/mcp/watch.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

/** Wire a real Operations over a memory store + bus, then connect an MCP client. */
async function connect(principal: Principal) {
  const store = new MemoryStore({ seed: false });
  const bus = new InProcessBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new RunningProvider());
  const operations = new Operations({ store, hub, orchestrator });
  const server = buildMcpServer(principal, { operations, bus });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, store, hub, bus, operations };
}

const author: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:author", scopes: ["observe", "author"] };
const approver: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:approver", scopes: ["observe", "author", "approver"] };

const text = (res: { content: unknown }) => (res.content as { type: string; text: string }[])[0].text;
const json = (res: { content: unknown }) => JSON.parse(text(res));

describe("MCP tool core", () => {
  it("exposes the tool surface and drives the create → assign flow", async () => {
    const { client, store } = await connect(author);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_snapshot", "create_project", "assign_task", "resolve_hitl", "wait_for_hitl", "wait_for_agent"]));

    const project = json(await client.callTool({ name: "create_project", arguments: { name: "Proj", goal: "ship" } }));
    const task = json(await client.callTool({ name: "create_task", arguments: { projectId: project.id, text: "do it" } }));
    const agent = json(await client.callTool({ name: "assign_task", arguments: { projectId: project.id, taskId: task.id } }));

    expect(agent.id).toBeTruthy();
    const snapshot = json(await client.callTool({ name: "get_snapshot", arguments: {} }));
    expect(snapshot.runs.map((a: { id: string }) => a.id)).toContain(agent.id);
  });

  it("enforces scopes: an author token cannot resolve_hitl, an approver can", async () => {
    const item: HitlItem = {
      id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "a1", kind: "approval",
      title: "Approve?", why: "because", risk: "medium",
      raisedAt: 0, resolvedAt: null, resolution: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    };

    const asAuthor = await connect(author);
    await asAuthor.hub.raiseHitl(item);
    const denied = await asAuthor.client.callTool({ name: "resolve_hitl", arguments: { hitlId: "q1", action: "approve" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/approver/);
    // The gate is untouched — the author token could not resolve it.
    expect((await asAuthor.store.getHitl("q1"))?.resolution).toBeNull();

    const asApprover = await connect(approver);
    await asApprover.hub.raiseHitl(item);
    const resolved = json(await asApprover.client.callTool({ name: "resolve_hitl", arguments: { hitlId: "q1", action: "approve" } }));
    expect(resolved.resolution.by).toBe("mcp:approver");
  });

  it("exposes the snapshot resource and the operate_skynet prompt", async () => {
    const { client, store } = await connect(author);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });

    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources).toContain("skynet://snapshot");
    const read = await client.readResource({ uri: "skynet://snapshot" });
    const snap = JSON.parse((read.contents[0] as { text: string }).text);
    expect(snap.fleet.map((r: { id: string }) => r.id)).toContain("r1");

    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toContain("operate_skynet");
    const prompt = await client.getPrompt({ name: "operate_skynet" });
    expect((prompt.messages[0].content as { text: string }).text).toMatch(/skynet:\/\/snapshot/);
  });

  it("wait_for_hitl returns an already-open item immediately", async () => {
    const { client, hub } = await connect(author);
    await hub.raiseHitl({
      id: "q9", workspaceId: DEFAULT_WORKSPACE, runId: "a9", kind: "question",
      title: "Which?", why: "fork in the road", risk: "low",
      raisedAt: 0, resolvedAt: null, resolution: null,
      command: null, options: ["a", "b"], recommended: 0, steps: null, diff: null,
    });
    const res = json(await client.callTool({ name: "wait_for_hitl", arguments: { timeoutMs: 1000 } }));
    expect(res.waited).toBe(false);
    expect(res.hitl.id).toBe("q9");
  });
});

describe("waitForEvent", () => {
  it("resolves with the first matching event and ignores non-matches", async () => {
    const bus = new InProcessBus();
    const p = waitForEvent(bus, DEFAULT_WORKSPACE, (e) => e.type === "hitl.raised", 1000);
    bus.publish(DEFAULT_WORKSPACE, { type: "run.heartbeat", runId: "a1", at: 1 }); // ignored
    bus.publish("other-ws", { type: "hitl.raised", item: {} as HitlItem }); // wrong workspace
    bus.publish(DEFAULT_WORKSPACE, { type: "hitl.raised", item: { id: "hit" } as HitlItem });
    const event = (await p) as Extract<ServerEvent, { type: "hitl.raised" }>;
    expect(event.type).toBe("hitl.raised");
    expect(event.item.id).toBe("hit");
  });

  it("resolves to null on timeout", async () => {
    const bus = new InProcessBus();
    expect(await waitForEvent(bus, DEFAULT_WORKSPACE, () => true, 20)).toBeNull();
  });
});

// Push notifications: an idle MCP client (one not currently inside a
// wait_for_hitl call) should still receive a `notifications/message` the
// moment a HITL gate is raised. Uses the MCP SDK's `LoggingMessageNotification`
// handler on the client side + bus.publish on the server side, so the whole
// subscribe → sendLoggingMessage → client-receives path is exercised.
describe("MCP push notifications", () => {
  it("pushes notifications/message on hitl.raised (approver hint included when scoped)", async () => {
    const { client, bus } = await connect(approver);
    // Ask the client to route MCP loggingMessage notifications through logs[].
    const logs: Array<{ level: string; logger?: string; data: unknown }> = [];
    // The MCP SDK exposes a typed setLoggingLevel + `notification` route; we
    // hook the underlying transport by listening for the SDK's client-side
    // logging event. Fall back to the low-level notification handler if it's
    // available on this SDK version.
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      logs.push({ level: n.params.level, logger: n.params.logger, data: n.params.data });
    });

    // Publish a hitl.raised as if the orchestrator raised it — the server's
    // bus subscription (buildMcpServer) turns it into a push notification.
    const item: HitlItem = {
      id: "q-42",
      workspaceId: DEFAULT_WORKSPACE,
      runId: "run-1",
      kind: "approval",
      title: "Run: rm -rf node_modules",
      why: "the agent wants to run a shell command",
      raisedAt: 100,
      risk: "high",
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: "rm -rf node_modules",
      options: null,
      recommended: null,
      steps: null,
      diff: null,
      flags: [],
    };
    bus.publish(DEFAULT_WORKSPACE, { type: "hitl.raised", item });
    // Give the async pipeline a tick to deliver.
    await new Promise((r) => setTimeout(r, 50));

    expect(logs.length).toBeGreaterThan(0);
    const push = logs.find((l) => l.logger === "skynet.hitl")!;
    expect(push).toBeDefined();
    expect(push.level).toBe("warning"); // high risk → warning
    const data = push.data as Record<string, unknown>;
    expect(data.hitlId).toBe("q-42");
    expect(data.runId).toBe("run-1");
    expect(data.kind).toBe("approval");
    expect(data.risk).toBe("high");
    expect(data.title).toContain("rm -rf");
    // Approver-scoped principal gets the one-click hint; a non-scoped one wouldn't.
    expect(data.approverHint).toEqual({ tool: "resolve_hitl", args: { hitlId: "q-42" } });
  });

  it("does NOT push on resolved gates (already-answered noise stays out)", async () => {
    const { client, bus } = await connect(approver);
    const logs: Array<{ logger?: string }> = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      logs.push({ logger: n.params.logger });
    });
    const resolvedItem: HitlItem = {
      id: "q-already",
      workspaceId: DEFAULT_WORKSPACE,
      runId: "run-1",
      kind: "approval",
      title: "irrelevant",
      why: "",
      raisedAt: 0,
      risk: "low",
      expiresAt: null,
      resolvedAt: 100,
      resolution: { action: "approve", optionIndex: null, guidance: null, by: "op-1", at: 100 },
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: null,
      flags: [],
    };
    bus.publish(DEFAULT_WORKSPACE, { type: "hitl.raised", item: resolvedItem });
    await new Promise((r) => setTimeout(r, 50));
    // No skynet.hitl push should have arrived — the item was already resolved.
    expect(logs.filter((l) => l.logger === "skynet.hitl")).toEqual([]);
  });
});
