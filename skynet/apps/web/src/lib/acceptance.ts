// In-app acceptance checks: each scenario drives the REAL API and asserts on the
// resulting state, so you can run them from within Skynet and watch the control
// plane behave (temp "UAT:" projects/agents flash on the board, then clean up).
//
// These verify the control plane + state transitions deterministically — no
// provider keys needed. Deep runner behavior (real Claude edit→merge) is covered
// by docs/qa/llm-e2e. Each scenario is independent and cleans up after itself.

import * as api from "./client";

export interface Step {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface Scenario {
  id: string;
  name: string;
  desc: string;
  run: () => Promise<Step[]>;
}

const uid = () => Math.random().toString(36).slice(2, 7);
const step = (label: string, ok: boolean, detail?: string): Step => ({ label, ok, detail });
const swallow = (p: Promise<unknown>) => p.catch(() => undefined);

export const SCENARIOS: Scenario[] = [
  {
    id: "control-plane",
    name: "Control plane reachable",
    desc: "The API answers and returns a seeded workspace snapshot.",
    run: async () => {
      const s = await api.fetchSnapshot();
      return [
        step("GET /api/snapshot returns a snapshot", Array.isArray(s.agents), `${s.agents.length} agents`),
        step("provider catalog present", s.providers.length > 0, `${s.providers.length} providers`),
        step("fleet + projects arrays present", Array.isArray(s.fleet) && Array.isArray(s.projects)),
      ];
    },
  },
  {
    id: "project-crud",
    name: "Project create → visible → delete",
    desc: "A project round-trips through the store and the snapshot.",
    run: async () => {
      const name = `UAT: project ${uid()}`;
      const steps: Step[] = [];
      await api.createProject({ name, goal: "acceptance check" });
      let s = await api.fetchSnapshot();
      const p = s.projects.find((x) => x.name === name);
      steps.push(step("project created + in snapshot", !!p, p?.id));
      if (p) {
        await api.deleteProject(p.id);
        s = await api.fetchSnapshot();
        steps.push(step("project deleted", !s.projects.some((x) => x.id === p.id)));
      }
      return steps;
    },
  },
  {
    id: "runner-crud",
    name: "Fleet runner add → idle → remove",
    desc: "A runner joins the fleet as idle and can be retired.",
    run: async () => {
      const steps: Step[] = [];
      const before = new Set((await api.fetchSnapshot()).fleet.map((r) => r.id));
      await api.createRunner({ provider: "claude", model: "opus-4.8" });
      const s = await api.fetchSnapshot();
      const added = s.fleet.find((r) => !before.has(r.id));
      steps.push(step("runner added to fleet", !!added, added?.id));
      steps.push(step("new runner is idle", added?.status === "idle", added?.status));
      if (added) {
        await swallow(api.deleteRunner(added.id));
        const s2 = await api.fetchSnapshot();
        steps.push(step("runner removed (or busy)", !s2.fleet.some((r) => r.id === added.id), "best-effort"));
      }
      return steps;
    },
  },
  {
    id: "agent-lifecycle",
    name: "Task → agent → archive → restore",
    desc: "Assigning a task creates an agent; it can be archived and restored.",
    run: async () => {
      const steps: Step[] = [];
      const pname = `UAT: agent ${uid()}`;
      await api.createProject({ name: pname, goal: "acceptance" });
      let s = await api.fetchSnapshot();
      const p = s.projects.find((x) => x.name === pname)!;
      await api.createRunner({ provider: "claude", model: "opus-4.8" }); // ensure capacity
      await api.createTask(p.id, "acceptance: say hello");
      s = await api.fetchSnapshot();
      const task = s.tasks.find((t) => t.projectId === p.id);
      steps.push(step("task created in project", !!task, task?.id));
      let agentId: string | undefined;
      if (task) {
        await swallow(api.assignTask(p.id, task.id));
        s = await api.fetchSnapshot();
        const agent = s.agents.find((a) => a.projectId === p.id);
        agentId = agent?.id;
        steps.push(step("assign created an agent", !!agent, agent && `${agent.id} · ${agent.status}`));
      }
      if (agentId) {
        await api.archiveAgent(agentId, true);
        s = await api.fetchSnapshot();
        steps.push(step("agent archived (hidden from board)", s.agents.find((a) => a.id === agentId)?.archived === true));
        await api.archiveAgent(agentId, false);
        s = await api.fetchSnapshot();
        steps.push(step("agent restored", s.agents.find((a) => a.id === agentId)?.archived === false));
        await swallow(api.archiveAgent(agentId, true)); // tidy: hide the temp agent
      }
      await swallow(api.deleteProject(p.id)); // cleanup
      return steps;
    },
  },
  {
    id: "secrets-gating",
    name: "Provider key gates the vendor",
    desc: "Setting a key makes the vendor available; removing it reverts.",
    run: async () => {
      const steps: Step[] = [];
      const provider = "gemini"; // unlikely to be env-backed, so the flip is unambiguous
      try {
        await api.setSecret(provider, `uat-key-${uid()}90`);
      } catch (e) {
        return [step("secret store enabled (SKYNET_MASTER_KEY set)", false, (e as Error).message)];
      }
      const { secrets } = await api.fetchSecrets();
      steps.push(step("key stored (metadata only)", secrets.some((m) => m.provider === provider)));
      const s = await api.fetchSnapshot();
      steps.push(step("vendor becomes available", s.providers.find((p) => p.id === provider)?.available === true));
      await swallow(api.deleteSecret(provider));
      const after = await api.fetchSecrets();
      steps.push(step("key removed", !after.secrets.some((m) => m.provider === provider)));
      return steps;
    },
  },
  {
    id: "hitl-audit",
    name: "HITL resolve is audited",
    desc: "Resolving an open approval records a decision in the audit trail.",
    run: async () => {
      const steps: Step[] = [];
      const s = await api.fetchSnapshot();
      const open = s.queue.find((q) => q.resolvedAt == null);
      if (!open) {
        steps.push(step("an open HITL item exists to resolve", false, "none open — seed data or a running agent needed; inconclusive"));
        return steps;
      }
      const before = (await api.fetchAudit()).length;
      await api.resolveHitl(open.id, { action: "approve" });
      const trail = await api.fetchAudit();
      steps.push(step("decision recorded in audit", trail.length > before, `${before} → ${trail.length}`));
      steps.push(step("audit row names the resolved item", trail.some((r) => r.hitlId === open.id)));
      return steps;
    },
  },
  {
    id: "github-reachable",
    name: "GitHub connection endpoint",
    desc: "The GitHub connection state loads (App/broker/PAT config surfaced).",
    run: async () => {
      const g = await api.fetchGithub();
      return [
        step("GET /api/github returns a connection", typeof g.connection.connected === "boolean", `connected=${g.connection.connected}, auth=${g.connection.auth}`),
        step("server capabilities surfaced", typeof g.appConfigured === "boolean" && typeof g.brokerConfigured === "boolean", `app=${g.appConfigured} broker=${g.brokerConfigured}`),
      ];
    },
  },
];
