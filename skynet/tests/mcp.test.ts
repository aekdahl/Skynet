// The MCP tool core is a second front-end onto Operations, gated by the calling
// token's scopes. These drive it through a real in-memory MCP client so the
// wiring — tool registration, scope enforcement, delegation to Operations — is
// exercised end to end, plus the bus-backed wait primitive in isolation.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { HitlItem, ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE, Project, Task, TaskRun } from "@skynet/shared";
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

/** Wire a real Operations over a memory store + bus, then connect an MCP client.
 *  contextAsk is stubbed (never a real LLM call) so refreshProjectContext —
 *  triggered by add_memory/delete_memory/refresh_memory — stays hermetic even
 *  when a real provider key is present in the environment (see
 *  project-context.test.ts for the same stub-injection pattern). */
async function connect(principal: Principal) {
  const store = new MemoryStore({ seed: false });
  const bus = new InProcessBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new RunningProvider());
  const operations = new Operations({ store, hub, orchestrator, contextAsk: async () => "stub summary" });
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

  it("exposes task-board + roadmap + lifecycle actions, and transition_task guards illegal jumps", async () => {
    const { client } = await connect(author);
    const names = (await client.listTools()).tools.map((t) => t.name);
    // The actions that were previously missing from the MCP surface.
    expect(names).toEqual(
      expect.arrayContaining([
        "transition_task", "force_task_done", "request_review", "move_task", "reorder_task", "archive_task", "delete_task",
        "update_milestone", "delete_milestone", "delete_feature",
        "pause_agent", "resume_agent", "run_diff",
        "import_github_issues", "import_repo_file",
        "list_tasks", "get_task", "list_features", "list_milestones",
        "list_audit", "get_audit",
        "list_briefs", "get_brief", "create_brief", "update_brief",
        "list_memory", "add_memory", "delete_memory", "refresh_memory",
      ]),
    );

    const project = json(await client.callTool({ name: "create_project", arguments: { name: "P", goal: "g" } }));
    const task = json(await client.callTool({ name: "create_task", arguments: { projectId: project.id, text: "t" } }));
    expect(task.state).toBe("backlog");
    // Leaving backlog needs an agent-eligibility choice — set it via update_task first.
    await client.callTool({ name: "update_task", arguments: { taskId: task.id, assignment: { mode: "any", agentIds: [] } } });

    // A legal human move applies; list_tasks reflects it.
    const moved = json(await client.callTool({ name: "transition_task", arguments: { taskId: task.id, to: "triage" } }));
    expect(moved.state).toBe("triage");
    const tasks = json(await client.callTool({ name: "list_tasks", arguments: {} }));
    expect(tasks.items.find((t: { id: string }) => t.id === task.id).state).toBe("triage");

    // An illegal jump (triage → done) is refused, not applied.
    const bad = await client.callTool({ name: "transition_task", arguments: { taskId: task.id, to: "done" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/can't move a task/i);
  });

  it("request_review delegates to Operations and surfaces its honest failure reason on error", async () => {
    const { client } = await connect(author);
    const project = json(await client.callTool({ name: "create_project", arguments: { name: "Proj", goal: "ship" } }));
    const task = json(await client.callTool({ name: "create_task", arguments: { projectId: project.id, text: "not in review yet" } }));

    // Not in `review` — same NoOpenReviewGateError the web/Steward surfaces,
    // relayed verbatim (no bespoke MCP error mapping, unlike the HTTP route).
    const result = await client.callTool({ name: "request_review", arguments: { taskId: task.id } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no open review gate/i);
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

// SolutionBrief (S4): CRUD via MCP, plus the one rule this surface enforces
// STRUCTURALLY rather than by scope — an agent token can never approve a
// brief, because update_brief's exposed `status` field excludes "approved"
// from its enum entirely (there's no scope check to bypass; the SDK itself
// refuses the tool call before Operations is ever reached). The HTTP-side
// version of the same rule (a runtime scope check, since that route CAN see
// "approved" in its body) is covered by solution-brief-routes.test.ts.
describe("MCP solution briefs", () => {
  const observer: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:observer", scopes: ["observe"] };

  it("creates, lists, gets, and updates a brief (non-approval fields)", async () => {
    const { client } = await connect(author);
    const project = json(await client.callTool({ name: "create_project", arguments: { name: "P", goal: "g" } }));

    const created = json(
      await client.callTool({
        name: "create_brief",
        arguments: { projectId: project.id, title: "Reconcile webhooks", problem: "double-posts", risks: ["migration"] },
      }),
    );
    expect(created.projectId).toBe(project.id);
    expect(created.status).toBe("draft");
    expect(created.risks).toEqual(["migration"]);

    const listed = json(await client.callTool({ name: "list_briefs", arguments: {} }));
    expect(listed.map((b: { id: string }) => b.id)).toContain(created.id);

    const fetched = json(await client.callTool({ name: "get_brief", arguments: { briefId: created.id } }));
    expect(fetched.id).toBe(created.id);

    const updated = json(
      await client.callTool({ name: "update_brief", arguments: { briefId: created.id, title: "Renamed", status: "building" } }),
    );
    expect(updated.title).toBe("Renamed");
    expect(updated.status).toBe("building");
  });

  it("update_brief structurally refuses status: 'approved' — the SDK rejects it before the tool body ever runs", async () => {
    const { client, store } = await connect(author);
    const project = json(await client.callTool({ name: "create_project", arguments: { name: "P", goal: "g" } }));
    const brief = json(await client.callTool({ name: "create_brief", arguments: { projectId: project.id, title: "T" } }));

    let threw = false;
    let result: Awaited<ReturnType<typeof client.callTool>> | undefined;
    try {
      result = await client.callTool({ name: "update_brief", arguments: { briefId: brief.id, status: "approved" } });
    } catch {
      threw = true; // some SDK versions reject invalid tool args at the transport level
    }
    // Either the call rejected outright, or it came back as a tool error —
    // either way it must NOT have succeeded.
    if (!threw) expect(result!.isError).toBe(true);
    // The record itself was never touched.
    expect((await store.getSolutionBrief(brief.id))?.status).toBe("draft");
  });

  it("an observe-only token can list/get briefs but not create/update them", async () => {
    const { client, store } = await connect(observer);
    await store.putProject({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" });
    await store.putSolutionBrief({
      id: "brief-1", workspaceId: DEFAULT_WORKSPACE, projectId: "P", title: "Readable",
      problem: "", approach: "", optionsConsidered: [], risks: [], acceptanceCriteria: [],
      openQuestions: [], status: "draft", featureId: null, createdAt: 0, updatedAt: 0,
      approvedAt: null, approvedBy: null, sourceConversation: null,
    });

    // Reads work at "observe".
    const listed = json(await client.callTool({ name: "list_briefs", arguments: {} }));
    expect(listed.map((b: { id: string }) => b.id)).toContain("brief-1");
    const fetched = json(await client.callTool({ name: "get_brief", arguments: { briefId: "brief-1" } }));
    expect(fetched.id).toBe("brief-1");

    // Mutations are refused — the scope gate fires before any project/brief
    // lookup, so a fake projectId is enough to prove it.
    const denied = await client.callTool({ name: "create_brief", arguments: { projectId: "P", title: "nope" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/scope/i);

    const deniedUpdate = await client.callTool({ name: "update_brief", arguments: { briefId: "brief-1", title: "nope" } });
    expect(deniedUpdate.isError).toBe(true);
    expect((await store.getSolutionBrief("brief-1"))?.title).toBe("Readable"); // untouched
  });

  it("a project-scoped token's list_briefs/create_brief/update_brief are confined to its allowed projects", async () => {
    const scoped: Principal = {
      workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:scoped-briefs",
      scopes: ["observe", "author"], projectIds: ["A"],
    };
    const { client, store } = await connect(scoped);
    await store.putProject({ id: "A", workspaceId: DEFAULT_WORKSPACE, name: "A", goal: "", runIds: [], status: "active" });
    await store.putProject({ id: "B", workspaceId: DEFAULT_WORKSPACE, name: "B", goal: "", runIds: [], status: "active" });
    await store.putSolutionBrief({
      id: "brief-a", workspaceId: DEFAULT_WORKSPACE, projectId: "A", title: "In A",
      problem: "", approach: "", optionsConsidered: [], risks: [], acceptanceCriteria: [],
      openQuestions: [], status: "draft", featureId: null, createdAt: 0, updatedAt: 0,
      approvedAt: null, approvedBy: null, sourceConversation: null,
    });
    await store.putSolutionBrief({
      id: "brief-b", workspaceId: DEFAULT_WORKSPACE, projectId: "B", title: "In B",
      problem: "", approach: "", optionsConsidered: [], risks: [], acceptanceCriteria: [],
      openQuestions: [], status: "draft", featureId: null, createdAt: 0, updatedAt: 0,
      approvedAt: null, approvedBy: null, sourceConversation: null,
    });

    const listed = json(await client.callTool({ name: "list_briefs", arguments: {} }));
    expect(listed.map((b: { id: string }) => b.id)).toEqual(["brief-a"]);

    const okCreate = json(await client.callTool({ name: "create_brief", arguments: { projectId: "A", title: "new" } }));
    expect(okCreate.id).toBeTruthy();
    const deniedCreate = await client.callTool({ name: "create_brief", arguments: { projectId: "B", title: "nope" } });
    expect(deniedCreate.isError).toBe(true);
    expect(text(deniedCreate)).toMatch(/scoped to project "B"/);

    const okUpdate = json(await client.callTool({ name: "update_brief", arguments: { briefId: "brief-a", title: "renamed" } }));
    expect(okUpdate.title).toBe("renamed");
    const deniedUpdate = await client.callTool({ name: "update_brief", arguments: { briefId: "brief-b", title: "nope" } });
    expect(deniedUpdate.isError).toBe(true);
    expect(text(deniedUpdate)).toMatch(/scoped to project "B"/);
    expect((await store.getSolutionBrief("brief-b"))?.title).toBe("In B"); // untouched
  });
});

describe("MCP project memory", () => {
  const observer: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:observer", scopes: ["observe"] };

  it("adds, lists, refreshes, and deletes a project's memory entries", async () => {
    const { client } = await connect(author);
    const project = json(await client.callTool({ name: "create_project", arguments: { name: "P", goal: "g" } }));

    const added = json(
      await client.callTool({ name: "add_memory", arguments: { projectId: project.id, label: "Kickoff", content: "Q3 deadline" } }),
    );
    expect(added.projectId).toBe(project.id);
    expect(added.label).toBe("Kickoff");
    expect(added.content).toBe("Q3 deadline");

    const listed = json(await client.callTool({ name: "list_memory", arguments: { projectId: project.id } }));
    expect(listed.map((e: { id: string }) => e.id)).toEqual([added.id]);

    const refreshed = json(await client.callTool({ name: "refresh_memory", arguments: { projectId: project.id } }));
    expect(refreshed.id).toBe(project.id);
    expect(refreshed.contextSummary).toBe("stub summary");

    const deleted = json(await client.callTool({ name: "delete_memory", arguments: { projectId: project.id, entryId: added.id } }));
    expect(deleted.deleted).toBe(added.id);
    const listedAfter = json(await client.callTool({ name: "list_memory", arguments: { projectId: project.id } }));
    expect(listedAfter).toEqual([]);
  });

  it("an observe-only token can list memory but not write it", async () => {
    const { client, store } = await connect(observer);
    await store.putProject({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" });

    const listed = json(await client.callTool({ name: "list_memory", arguments: { projectId: "P" } }));
    expect(listed).toEqual([]);

    const denied = await client.callTool({ name: "add_memory", arguments: { projectId: "P", content: "nope" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/scope/i);
    expect(await store.listContextEntries(DEFAULT_WORKSPACE)).toEqual([]);
  });

  it("a project-scoped token's memory tools are confined to its allowed projects", async () => {
    const scoped: Principal = {
      workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:scoped-memory",
      scopes: ["observe", "author"], projectIds: ["A"],
    };
    const { client, store } = await connect(scoped);
    await store.putProject({ id: "A", workspaceId: DEFAULT_WORKSPACE, name: "A", goal: "", runIds: [], status: "active" });
    await store.putProject({ id: "B", workspaceId: DEFAULT_WORKSPACE, name: "B", goal: "", runIds: [], status: "active" });

    const okAdd = json(await client.callTool({ name: "add_memory", arguments: { projectId: "A", content: "in scope" } }));
    expect(okAdd.id).toBeTruthy();
    const deniedAdd = await client.callTool({ name: "add_memory", arguments: { projectId: "B", content: "out of scope" } });
    expect(deniedAdd.isError).toBe(true);
    expect(text(deniedAdd)).toMatch(/scoped to project "B"/);

    const deniedList = await client.callTool({ name: "list_memory", arguments: { projectId: "B" } });
    expect(deniedList.isError).toBe(true);
  });
});

// A service token can be confined to a subset of the workspace's projects
// (Principal.projectIds). The MCP layer must enforce that in BOTH directions:
// reads are filtered to the allowed projects and writes are gated to them.
describe("MCP project scoping", () => {
  // Token scoped to project "A" only (full capability within it).
  const scoped: Principal = {
    workspaceId: DEFAULT_WORKSPACE,
    operatorId: "mcp:scoped",
    scopes: ["observe", "author", "approver"],
    projectIds: ["A"],
  };
  const project = (id: string) => Project.parse({ id, workspaceId: DEFAULT_WORKSPACE, name: `Proj ${id}`, goal: "", runIds: [], status: "active" });
  const task = (id: string, projectId: string) => Task.parse({ id, workspaceId: DEFAULT_WORKSPACE, projectId, text: id, state: "todo" });
  // The scope filter only reads id + projectId, but summarizeRun (list_agents/
  // get_snapshot) now reads a handful more — still far short of a full
  // TaskRun.parse (~15 fields, including several with no default).
  const run = (id: string, projectId: string) =>
    ({
      id, workspaceId: DEFAULT_WORKSPACE, projectId,
      name: id, status: "running", agentId: null, provider: "claude", model: "haiku-4.5",
      progress: 0, plan: [], startedAt: 0, lastHeartbeatAt: 0, branch: `agent/${id}`,
    } as unknown as TaskRun);

  /** Seed two projects (A allowed, B not) with a task + run each, directly in the store. */
  async function seedTwoProjects(store: Awaited<ReturnType<typeof connect>>["store"]) {
    await store.putProject(project("A"));
    await store.putProject(project("B"));
    await store.putTask(task("ta", "A"));
    await store.putTask(task("tb", "B"));
    await store.putRun(run("ra", "A"));
    await store.putRun(run("rb", "B"));
  }

  it("filters reads down to the allowed projects", async () => {
    const { client, store } = await connect(scoped);
    await seedTwoProjects(store);

    const projects = json(await client.callTool({ name: "list_projects", arguments: {} }));
    expect(projects.map((p: { id: string }) => p.id)).toEqual(["A"]);

    const runs = json(await client.callTool({ name: "list_agents", arguments: {} }));
    expect(runs.items.map((r: { id: string }) => r.id)).toEqual(["ra"]);
    expect(runs.total).toBe(1);

    const snap = json(await client.callTool({ name: "get_snapshot", arguments: {} }));
    expect(snap.projects.map((p: { id: string }) => p.id)).toEqual(["A"]);
    expect(snap.runs.map((r: { id: string }) => r.id)).toEqual(["ra"]);
    expect(snap.tasks.map((t: { id: string }) => t.id)).toEqual(["ta"]);
  });

  it("filters the HITL queue by the run's project", async () => {
    const { client, store, hub } = await connect(scoped);
    await seedTwoProjects(store);
    const hitl = (id: string, runId: string): HitlItem => ({
      id, workspaceId: DEFAULT_WORKSPACE, runId, kind: "approval", title: id, why: "", risk: "low",
      raisedAt: 0, resolvedAt: null, resolution: null, command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await hub.raiseHitl(hitl("qa", "ra")); // project A → visible
    await hub.raiseHitl(hitl("qb", "rb")); // project B → hidden

    const queue = json(await client.callTool({ name: "list_hitl", arguments: {} }));
    expect(queue.map((h: { id: string }) => h.id)).toEqual(["qa"]);
  });

  it("gates writes to the allowed projects (by projectId or a resolved task id)", async () => {
    const { client, store } = await connect(scoped);
    await seedTwoProjects(store);

    // Allowed project → ok.
    const okTask = json(await client.callTool({ name: "create_task", arguments: { projectId: "A", text: "new" } }));
    expect(okTask.id).toBeTruthy();
    const okUpdate = json(await client.callTool({ name: "update_task", arguments: { taskId: "ta", text: "renamed" } }));
    expect(okUpdate.text).toBe("renamed");

    // Disallowed project, named directly…
    const deniedCreate = await client.callTool({ name: "create_task", arguments: { projectId: "B", text: "nope" } });
    expect(deniedCreate.isError).toBe(true);
    expect(text(deniedCreate)).toMatch(/scoped to project "B"/);

    // …and reached via a task that belongs to it (resolved server-side).
    const deniedUpdate = await client.callTool({ name: "update_task", arguments: { taskId: "tb", text: "nope" } });
    expect(deniedUpdate.isError).toBe(true);
    expect(text(deniedUpdate)).toMatch(/scoped to project "B"/);
    expect((await store.getTask("tb"))?.text).toBe("tb"); // untouched
  });

  it("refuses workspace-level actions a project-scoped token can't attribute", async () => {
    const { client, store } = await connect(scoped);
    await seedTwoProjects(store);

    const noProject = await client.callTool({ name: "create_project", arguments: { name: "X", goal: "" } });
    expect(noProject.isError).toBe(true);
    expect(text(noProject)).toMatch(/workspace-level/);

    // Mutating shared fleet capacity (retire) is still off-limits — it isn't
    // attributable to a project. (Creating a runner IS allowed — see below.)
    const retire = await client.callTool({ name: "retire_runner", arguments: { runnerId: "r-anything" } });
    expect(retire.isError).toBe(true);
    expect(text(retire)).toMatch(/workspace-level/);

    expect((await store.listProjects(DEFAULT_WORKSPACE)).map((p) => p.id).sort()).toEqual(["A", "B"]); // none created
  });

  it("lets a scoped token add fleet capacity, but only on its project's enabled keys", async () => {
    const { client, store } = await connect(scoped);
    // Project A is confined to the claude default key; the token is scoped to A.
    await store.putProject(
      Project.parse({ id: "A", workspaceId: DEFAULT_WORKSPACE, name: "A", goal: "", runIds: [], status: "active", enabledRunnerCredentialIds: ["claude"] }),
    );

    // An enabled key → capacity is added (no starving a project-scoped token).
    const ok = json(await client.callTool({ name: "configure_runner", arguments: { provider: "claude", model: "opus" } }));
    expect(ok.id).toBeTruthy();

    // A key the project doesn't permit → refused.
    const denied = await client.callTool({ name: "configure_runner", arguments: { provider: "gemini", model: "g" } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/permit runner key "gemini"/);
  });

  it("an UNSCOPED token still sees & acts across the whole workspace", async () => {
    const { client, store } = await connect(author); // no projectIds
    await seedTwoProjects(store);
    const projects = json(await client.callTool({ name: "list_projects", arguments: {} }));
    expect(projects.map((p: { id: string }) => p.id).sort()).toEqual(["A", "B"]);
    // And it can create a project (workspace-level) — the scoped token could not.
    const created = json(await client.callTool({ name: "create_project", arguments: { name: "C", goal: "" } }));
    expect(created.id).toBeTruthy();
  });
});

// Non-secret settings over MCP: the workspace fleet policy is readable + writable
// (writable only by a workspace-wide token — it's a workspace-level action).
describe("MCP settings", () => {
  it("reads and writes the workspace fleet policy", async () => {
    const { client } = await connect(author);
    const before = json(await client.callTool({ name: "get_settings", arguments: {} }));
    expect(before.fleet).toMatchObject({ autoProvisionRunners: false, maxRunners: 100, retireIdleRunnersAfterMinutes: 30 }); // defaults (bounded, not unlimited)
    expect(Array.isArray(before.providers)).toBe(true); // non-secret provider availability

    const updated = json(await client.callTool({ name: "update_settings", arguments: { autoProvisionRunners: true, maxRunners: 5 } }));
    expect(updated).toMatchObject({ autoProvisionRunners: true, maxRunners: 5 });

    const after = json(await client.callTool({ name: "get_settings", arguments: {} }));
    expect(after.fleet).toMatchObject({ autoProvisionRunners: true, maxRunners: 5 });
  });

  it("a project-scoped token may READ settings but not change them", async () => {
    const scoped: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:scoped", scopes: ["observe", "author"], projectIds: ["A"] };
    const { client } = await connect(scoped);
    // Non-secret workspace metadata → readable even when project-confined.
    const read = json(await client.callTool({ name: "get_settings", arguments: {} }));
    expect(read.fleet).toBeDefined();
    // Changing workspace-wide policy is a workspace-level action → denied.
    const denied = await client.callTool({ name: "update_settings", arguments: { maxRunners: 3 } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toMatch(/workspace-level/);
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
      resolution: { action: "approve", optionIndex: null, guidance: null, memoryNote: null, by: "op-1", at: 100 },
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

// Regression coverage for the response-size fix: list_agents/list_tasks/
// list_audit/get_snapshot must never leak the heavy fields (log, description,
// captured diff patch) that made them unusable at real workspace scale — and
// the get_agent/get_task/get_audit drill-in tools must still return them.
describe("MCP response shaping (summary/detail + pagination)", () => {
  const fullRun = (id: string, overrides: Partial<TaskRun> = {}): TaskRun =>
    ({
      id, workspaceId: DEFAULT_WORKSPACE, projectId: "P", name: `Run ${id}`,
      status: "running", agentId: "r1", provider: "claude", model: "sonnet-5",
      progress: 0.5, plan: [{ text: "step 1", state: "done" }, { text: "step 2", state: "now" }, { text: "step 3", state: "todo" }],
      startedAt: 1000, lastHeartbeatAt: 2000, branch: `agent/${id}`,
      log: [{ at: 1000, line: "picked up" }, { at: 1500, line: "▸ Bash: pnpm test", detail: "a".repeat(5000) }],
      usage: null, modifiedFiles: [], modules: [], visual: false, previewUrl: null,
      dependsOn: [], parentId: null, branchFromStep: null, archived: false, pr: null, mergedAt: null,
      credentialId: null,
      ...overrides,
    } as unknown as TaskRun);

  it("list_agents omits the activity log and full plan; get_agent returns them", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putRun(fullRun("r1"));

    const list = json(await client.callTool({ name: "list_agents", arguments: {} }));
    expect(list.total).toBe(1);
    const summary = list.items[0];
    expect(summary).not.toHaveProperty("log");
    expect(summary).not.toHaveProperty("plan");
    expect(summary).toMatchObject({ id: "r1", status: "running", currentStep: "step 2", planDone: 1, planTotal: 3 });

    const full = json(await client.callTool({ name: "get_agent", arguments: { runId: "r1" } }));
    expect(full.log).toHaveLength(2);
    // Per-entry detail is clipped by default (600 chars + an explicit marker);
    // logDetailChars raises it back to the runner's own per-entry cap.
    expect(full.log[1].detail).toMatch(/^a{600} …\[\+4400 chars\]$/);
    expect(full.plan).toHaveLength(3);
    const raised = json(await client.callTool({ name: "get_agent", arguments: { runId: "r1", logDetailChars: 6000 } }));
    expect(raised.log[1].detail).toHaveLength(5000);
    const linesOnly = json(await client.callTool({ name: "get_agent", arguments: { runId: "r1", logDetailChars: 0 } }));
    expect(linesOnly.log[1]).not.toHaveProperty("detail");
    expect(linesOnly.log[1].line).toBe("▸ Bash: pnpm test");
  });

  it("list_agents filters by status, paginates, and excludes archived by default", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putRun(fullRun("running-1", { status: "running", lastHeartbeatAt: 3000 }));
    await store.putRun(fullRun("done-1", { status: "done", lastHeartbeatAt: 2000 }));
    await store.putRun(fullRun("archived-1", { status: "done", archived: true, lastHeartbeatAt: 1000 }));

    const onlyRunning = json(await client.callTool({ name: "list_agents", arguments: { status: ["running"] } }));
    expect(onlyRunning.items.map((r: { id: string }) => r.id)).toEqual(["running-1"]);

    const defaultView = json(await client.callTool({ name: "list_agents", arguments: {} }));
    expect(defaultView.items.map((r: { id: string }) => r.id)).toEqual(["running-1", "done-1"]); // archived excluded, most-recent first

    const withArchived = json(await client.callTool({ name: "list_agents", arguments: { includeArchived: true, limit: 2 } }));
    expect(withArchived.total).toBe(3);
    expect(withArchived.items).toHaveLength(2);
    expect(withArchived.hasMore).toBe(true);

    const page2 = json(await client.callTool({ name: "list_agents", arguments: { includeArchived: true, limit: 2, offset: 2 } }));
    expect(page2.items.map((r: { id: string }) => r.id)).toEqual(["archived-1"]);
    expect(page2.hasMore).toBe(false);
  });

  it("get_agent's log defaults to the tail and reports the true total", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    const log = Array.from({ length: 5 }, (_, i) => ({ at: i, line: `line ${i}` }));
    await store.putRun(fullRun("r1", { log }));

    const tailed = json(await client.callTool({ name: "get_agent", arguments: { runId: "r1", logLimit: 2 } }));
    expect(tailed.log.map((l: { line: string }) => l.line)).toEqual(["line 3", "line 4"]); // tail, not head
    expect(tailed.logTotal).toBe(5);
    expect(tailed.logTruncated).toBe(true);

    const paged = json(await client.callTool({ name: "get_agent", arguments: { runId: "r1", logLimit: 2, logOffset: 0 } }));
    expect(paged.log.map((l: { line: string }) => l.line)).toEqual(["line 0", "line 1"]); // explicit offset wins over the tail default
  });

  it("list_tasks omits description/assessment/lint text; get_task returns it", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putTask(
      Task.parse({
        id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "P", text: "t1", state: "triage",
        description: "a very long brief the agent gets, but not the list view".repeat(20),
        assessmentEffort: "large",
        assessmentRisks: ["touches billing", "no tests"],
        reviewVerdict: { decision: "flag", reason: "needs another pass", by: "reviewer-1", at: 0 },
        lint: { concerns: [{ kind: "vague", note: "unclear scope" }], at: 0, dismissed: false },
      }),
    );

    const list = json(await client.callTool({ name: "list_tasks", arguments: {} }));
    const summary = list.items[0];
    expect(summary).not.toHaveProperty("description");
    expect(summary).not.toHaveProperty("assessmentRisks");
    expect(summary).toMatchObject({ id: "t1", hasDescription: true, assessmentEffort: "large", riskCount: 2, reviewDecision: "flag", lintConcernCount: 1 });

    const full = json(await client.callTool({ name: "get_task", arguments: { taskId: "t1" } }));
    expect(full.description).toContain("very long brief");
    expect(full.assessmentRisks).toEqual(["touches billing", "no tests"]);
    expect(full.lint.concerns[0].note).toBe("unclear scope");
  });

  it("list_tasks filters by state and pages", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putTask(Task.parse({ id: "t-todo", workspaceId: DEFAULT_WORKSPACE, projectId: "P", text: "t-todo", state: "todo" }));
    await store.putTask(Task.parse({ id: "t-done", workspaceId: DEFAULT_WORKSPACE, projectId: "P", text: "t-done", state: "done" }));

    const onlyTodo = json(await client.callTool({ name: "list_tasks", arguments: { state: ["todo"] } }));
    expect(onlyTodo.items.map((t: { id: string }) => t.id)).toEqual(["t-todo"]);
    expect(onlyTodo.total).toBe(1);
  });

  it("list_audit summarizes away the captured diff patch and rationale; get_audit returns them", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putRun(fullRun("r1"));
    const bigPatch = "diff --git a/big.ts b/big.ts\n" + "+ line\n".repeat(2000); // the kind of payload that made list_audit unusable
    await store.recordAudit({
      workspaceId: DEFAULT_WORKSPACE, hitlId: "h1", runId: "r1", action: "approve", operatorId: "op-1", at: 500,
      payload: {
        kind: "diff", title: "Review diff", risk: "medium", rationale: "looks safe",
        diff: { add: 12, del: 3, modules: ["api"], files: ["big.ts"] },
        files: ["big.ts"], patch: bigPatch,
      },
    });

    const list = json(await client.callTool({ name: "list_audit", arguments: {} }));
    const summary = list.items[0];
    expect(summary).not.toHaveProperty("payload");
    expect(summary).toMatchObject({ hitlId: "h1", action: "approve", kind: "diff", risk: "medium", diffFiles: 1, diffAdd: 12, diffDel: 3 });

    const full = json(await client.callTool({ name: "get_audit", arguments: { hitlId: "h1" } }));
    expect(full.payload.patch).toBe(bigPatch);
    expect(full.payload.rationale).toBe("looks safe");
  });

  it("get_snapshot embeds run/task SUMMARIES, not full records", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putRun(fullRun("r1"));
    await store.putTask(Task.parse({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "P", text: "t1", state: "todo", description: "long brief" }));

    const snap = json(await client.callTool({ name: "get_snapshot", arguments: {} }));
    expect(snap.runs[0]).not.toHaveProperty("log");
    expect(snap.tasks[0]).not.toHaveProperty("description");
    expect(snap.runsTotal).toBe(1);
    expect(snap.tasksTotal).toBe(1);
  });
});

describe("MCP token diet (second pass: hitl/briefs summaries, patch caps, compact JSON)", () => {
  const fullRun = (id: string): TaskRun =>
    ({
      id, workspaceId: DEFAULT_WORKSPACE, projectId: "P", name: `Run ${id}`,
      status: "running", agentId: "r1", provider: "claude", model: "sonnet-5",
      progress: 0.5, plan: [], startedAt: 1000, lastHeartbeatAt: 2000, branch: `agent/${id}`,
      log: [{ at: 1000, line: "picked up" }, { at: 1500, line: "▸ Bash: pnpm test", detail: "x".repeat(4000) }],
      usage: null, modifiedFiles: [], modules: [], visual: false, previewUrl: null,
      dependsOn: [], parentId: null, branchFromStep: null, archived: false, pr: null, mergedAt: null,
      credentialId: null,
    } as unknown as TaskRun);

  const fullHitl = (id: string, runId: string): HitlItem =>
    ({
      id, workspaceId: DEFAULT_WORKSPACE, runId, kind: "diff",
      title: "Review the changes", why: "the agent finished", risk: "medium",
      raisedAt: 100, expiresAt: null, resolvedAt: null, resolution: null,
      rationale: "I refactored the parser", command: "c".repeat(2000),
      options: null, recommended: null, steps: ["step one", "step two"],
      output: "FAIL src/x.test.ts\n".repeat(200),
      diff: {
        add: 10, del: 2, modules: [], files: ["src/a.ts", "src/b.ts"],
        walkthrough: { summary: "w".repeat(3000), comments: [{ file: "src/a.ts", line: 1, note: "n".repeat(500) }] },
        mergeBrief: { summary: "m".repeat(3000), filesTouched: ["src/a.ts"], risks: ["r1"], mitigations: ["m1"] },
        defaultTargetBranch: "skynet/integration/P",
      },
      flags: [], sourceBranchOverride: null,
    } as unknown as HitlItem);

  it("list_hitl and get_snapshot's queue return summaries (no walkthrough/mergeBrief/output, clipped command); get_hitl returns the full record", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putRun(fullRun("r1"));
    await store.putHitl(fullHitl("h1", "r1"));

    const list = json(await client.callTool({ name: "list_hitl", arguments: {} }));
    expect(list).toHaveLength(1);
    const s = list[0];
    expect(s).not.toHaveProperty("output");
    expect(s.command).toMatch(/…\[\+1760 chars\]$/);
    expect(s).toMatchObject({
      id: "h1", runId: "r1", kind: "diff", risk: "medium",
      outputChars: 19 * 200, stepCount: 2,
      diff: { add: 10, del: 2, fileCount: 2, defaultTargetBranch: "skynet/integration/P" },
      hasWalkthrough: true, hasMergeBrief: true,
    });
    expect(JSON.stringify(s)).not.toContain("wwww"); // no walkthrough prose leaked
    const snap = json(await client.callTool({ name: "get_snapshot", arguments: {} }));
    expect(snap.queue[0]).toMatchObject({ id: "h1", hasWalkthrough: true });
    expect(snap.queue[0]).not.toHaveProperty("output");

    const full = json(await client.callTool({ name: "get_hitl", arguments: { hitlId: "h1" } }));
    expect(full.command).toHaveLength(2000);
    expect(full.output).toContain("FAIL src/x.test.ts");
    expect(full.diff.walkthrough.summary).toHaveLength(3000);
    expect(full.diff.mergeBrief.summary).toHaveLength(3000);
  });

  it("get_hitl 404s outside the workspace", async () => {
    const { client } = await connect(author);
    const res = await client.callTool({ name: "get_hitl", arguments: { hitlId: "nope" } });
    expect(res.isError).toBe(true);
  });

  it("list_briefs and get_snapshot's briefs return summaries (title + teaser + counts); get_brief returns the full doc", async () => {
    const { client, operations } = await connect(author);
    const project = json(await client.callTool({ name: "create_project", arguments: { name: "P", goal: "g" } }));
    const brief = await operations.createBrief(DEFAULT_WORKSPACE, project.id, {
      title: "Big plan",
      problem: "p".repeat(5000),
      approach: "a".repeat(5000),
      optionsConsidered: [{ name: "opt A", verdict: "chosen", why: "simplest" }],
      risks: ["r1", "r2"],
      acceptanceCriteria: ["ac1"],
      openQuestions: [],
    });

    const list = json(await client.callTool({ name: "list_briefs", arguments: {} }));
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("approach");
    expect(list[0].problem).toMatch(/…\[\+4800 chars\]$/);
    expect(list[0]).toMatchObject({ id: brief.id, title: "Big plan", status: "draft", optionCount: 1, riskCount: 2, acceptanceCriteriaCount: 1, openQuestionCount: 0, hasExploration: false });

    const snap = json(await client.callTool({ name: "get_snapshot", arguments: {} }));
    expect(snap.solutionBriefs[0]).not.toHaveProperty("approach");

    const full = json(await client.callTool({ name: "get_brief", arguments: { briefId: brief.id } }));
    expect(full.approach).toHaveLength(5000);
    expect(full.problem).toHaveLength(5000);
  });

  it("the skynet://snapshot resource returns the SAME summarized view as get_snapshot — never raw runs with logs", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putRun(fullRun("r1"));
    await store.putHitl(fullHitl("h1", "r1"));

    const read = await client.readResource({ uri: "skynet://snapshot" });
    const text = (read.contents[0] as { text: string }).text;
    const snap = JSON.parse(text);
    expect(snap.runs[0]).not.toHaveProperty("log");
    expect(snap.runsTotal).toBe(1);
    expect(snap.queue[0]).not.toHaveProperty("output");
    expect(text).not.toContain("xxxx"); // no log detail leaked anywhere in the payload
    expect(text).not.toContain('{\n  "'); // compact JSON, not pretty-printed
  });

  it("wait_for_agent returns a run SUMMARY, not the full record with its log", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putRun(fullRun("done-1"));
    await store.putRun({ ...fullRun("done-1"), status: "done" } as TaskRun);

    const res = json(await client.callTool({ name: "wait_for_agent", arguments: { runId: "done-1" } }));
    expect(res.waited).toBe(false);
    expect(res.agent).not.toHaveProperty("log");
    expect(res.agent).toMatchObject({ id: "done-1", status: "done" });
  });

  it("run_diff clips the patch at maxPatchChars with an explicit marker and true totals", async () => {
    const { client, operations } = await connect(author);
    const bigPatch = "+line\n".repeat(10_000); // 60k chars
    const orch = (operations as unknown as { orchestrator: { runDiff: (id: string) => Promise<unknown> } }).orchestrator;
    orch.runDiff = async () => ({ patch: bigPatch, add: 10_000, del: 0, files: ["a.ts"] });
    const getRun = operations.getRun.bind(operations);
    operations.getRun = async () => ({ id: "r1" } as unknown as Awaited<ReturnType<typeof getRun>>);

    const clipped = json(await client.callTool({ name: "run_diff", arguments: { runId: "r1" } }));
    expect(clipped.patchTruncated).toBe(true);
    expect(clipped.patchChars).toBe(bigPatch.length);
    expect(clipped.patch.length).toBeLessThan(31_000);
    expect(clipped.patch).toContain("…[patch truncated: showing 30000 of 60000 chars");

    const full = json(await client.callTool({ name: "run_diff", arguments: { runId: "r1", maxPatchChars: 100_000 } }));
    expect(full.patchTruncated).toBe(false);
    expect(full.patch).toHaveLength(bigPatch.length);
  });

  it("get_audit clips an embedded captured patch the same way", async () => {
    const { client, store } = await connect(author);
    await store.putProject(Project.parse({ id: "P", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));
    await store.putRun(fullRun("r1"));
    const bigPatch = "+line\n".repeat(10_000);
    await store.recordAudit({
      workspaceId: DEFAULT_WORKSPACE, hitlId: "h1", runId: "r1", action: "approve", operatorId: "op", at: 1,
      payload: { kind: "diff", rationale: "ok", patch: bigPatch },
    });

    const clipped = json(await client.callTool({ name: "get_audit", arguments: { hitlId: "h1" } }));
    expect(clipped.payload.patchTruncated).toBe(true);
    expect(clipped.payload.patchChars).toBe(bigPatch.length);
    expect(clipped.payload.rationale).toBe("ok"); // rest of the payload intact

    const full = json(await client.callTool({ name: "get_audit", arguments: { hitlId: "h1", maxPatchChars: 100_000 } }));
    expect(full.payload.patch).toHaveLength(bigPatch.length);
  });

  it("tool results are compact JSON, not pretty-printed", async () => {
    const { client } = await connect(author);
    const res = await client.callTool({ name: "list_projects", arguments: {} });
    const raw = (res.content as { text: string }[])[0].text;
    expect(raw).not.toContain("\n");
  });
});
