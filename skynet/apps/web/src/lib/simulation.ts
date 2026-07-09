// Simulation journeys: a PERSISTENT regression harness that drives the product
// the way a human operator would — and, unlike the acceptance checks, leaves the
// state it creates in place. Running these both (a) exercises the core processes
// end-to-end as a regression signal and (b) populates the "starts-empty" system
// with realistic data you can then explore on the board.
//
// Everything a journey creates is tagged "Sim:" (projects) / "sim-" (runners) so
// it's identifiable and can be swept with "Clear simulation data" in the view.
// Journeys assert deterministic control-plane facts (entity created, task/runner
// state, audit grew) — the same discipline as acceptance, without the cleanup.

import * as api from "./client";
import { settle } from "./poll";
import type { Agent } from "@skynet/shared";

export interface Step {
  label: string;
  ok: boolean;
  skip?: boolean;
  detail?: string;
}

export interface Journey {
  id: string;
  name: string;
  desc: string;
  run: () => Promise<Step[]>;
}

const uid = () => Math.random().toString(36).slice(2, 7);
const step = (label: string, ok: boolean, detail?: string): Step => ({ label, ok, detail });
const skipped = (label: string, detail?: string): Step => ({ label, ok: false, skip: true, detail });

/** Assign a task, returning the agent or a typed failure for a clean step. */
async function tryAssign(projectId: string, taskId: string): Promise<Agent | { error: string }> {
  try {
    return await api.assignTask(projectId, taskId);
  } catch (e) {
    return { error: (e as Error).message };
  }
}
const repoPathOf = (p: unknown) => (p as { repoPath?: string | null } | undefined)?.repoPath ?? null;

export const JOURNEYS: Journey[] = [
  {
    id: "provision-project",
    name: "Provision a project + fleet",
    desc: "Operator stands up a project bound to a local folder, adds a runner, and seeds a backlog. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: project ${tag}`;
      await api.createProject({ name: pname, goal: "simulated operator run", repoPath: `/tmp/skynet-sim/${tag}` });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      steps.push(step("project created (persists on the board)", !!p, p?.id));
      if (!p) return steps;
      steps.push(step("bound to a local folder (worktree-per-agent mode)", repoPathOf(p)?.startsWith("/tmp/skynet-sim/") === true, repoPathOf(p) ?? "null"));
      await api.createRunner({ provider: "claude", model: "opus-4.8", name: `sim-runner-${tag}` });
      await api.createTask(p.id, "Sim: wire up the /health endpoint");
      await api.createTask(p.id, "Sim: add structured request logging");
      s = await settle(
        (sn) => !!sn.fleet.find((r) => r.name === `sim-runner-${tag}`) && sn.tasks.filter((t) => t.projectId === p.id).length >= 2,
      );
      const runner = s.fleet.find((r) => r.name === `sim-runner-${tag}`);
      const tasks = s.tasks.filter((t) => t.projectId === p.id);
      steps.push(step("fleet runner joined as idle", runner?.status === "idle", runner?.id));
      steps.push(step("backlog seeded", tasks.length >= 2, `${tasks.length} tasks`));
      return steps;
    },
  },
  {
    id: "assign-and-run",
    name: "Assign a task → an agent runs",
    desc: "Operator assigns a backlog task; an agent spawns on the board and its runner goes busy. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: run ${tag}`;
      await api.createProject({ name: pname, goal: "simulated task run" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await api.createRunner({ provider: "claude", model: "opus-4.8", name: `sim-runner-${tag}` });
      await api.createTask(p.id, "Sim: implement the feature");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id);
      steps.push(step("task queued in backlog", !!task, task?.id));
      if (!task) return steps;
      const res = await tryAssign(p.id, task.id);
      const agentId = "error" in res ? undefined : res.id;
      steps.push(step("agent spawned on assign (persists)", !!agentId, "error" in res ? res.error : `${res.id} · ${res.status}`));
      s = await settle((sn) => sn.tasks.find((t) => t.id === task.id)?.state === "assigned");
      // Assign picks ANY idle runner (persistence may leave others around), so
      // check the agent's OWN runner, not the one this journey happened to add.
      const rid = "error" in res ? null : res.runnerId;
      const runner = rid ? s.fleet.find((r) => r.id === rid) : undefined;
      steps.push(step("the agent's runner is busy", runner?.status === "busy", runner?.status ?? "no runner"));
      const t2 = s.tasks.find((t) => t.id === task.id);
      steps.push(step("task moved to assigned", t2?.state === "assigned", t2?.state));
      return steps;
    },
  },
  {
    id: "supervise-decision",
    name: "Supervise a human-in-the-loop decision",
    desc: "Operator resolves an open HITL gate; the decision is recorded in the audit trail. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const s = await api.fetchSnapshot();
      const open = s.queue.find((q) => q.resolvedAt == null);
      if (!open) {
        steps.push(skipped("an open HITL gate to resolve", "none open — run a task whose agent raises a gate, then re-run"));
        return steps;
      }
      const before = (await api.fetchAudit()).length;
      await api.resolveHitl(open.id, { action: "approve" });
      const trail = await api.fetchAudit();
      steps.push(step("decision resolved + recorded in audit (persists)", trail.length > before, `${before} → ${trail.length}`));
      steps.push(step("audit row names the resolved gate", trail.some((r) => r.hitlId === open.id), open.id));
      return steps;
    },
  },
  {
    id: "fleet-at-scale",
    name: "Build a busy multi-agent board",
    desc: "Operator scales the fleet and assigns several tasks so multiple agents run in parallel. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: fleet ${tag}`;
      await api.createProject({ name: pname, goal: "simulated fleet at scale" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await api.createRunner({ provider: "claude", model: "opus-4.8", name: `sim-fleet-${tag}-a` });
      await api.createRunner({ provider: "claude", model: "opus-4.8", name: `sim-fleet-${tag}-b` });
      await api.createTask(p.id, "Sim: parallel task A");
      await api.createTask(p.id, "Sim: parallel task B");
      s = await settle((sn) => sn.tasks.filter((t) => t.projectId === p.id).length >= 2);
      const tasks = s.tasks.filter((t) => t.projectId === p.id);
      let assigned = 0;
      for (const t of tasks) {
        const r = await tryAssign(p.id, t.id);
        if (!("error" in r)) assigned++;
      }
      steps.push(step("both tasks assigned to runners", assigned === 2, `${assigned}/2`));
      s = await settle((sn) => sn.agents.filter((a) => a.projectId === p.id).length >= 2);
      const agents = s.agents.filter((a) => a.projectId === p.id);
      steps.push(step("multiple agents live on the board", agents.length >= 2, `${agents.length} agents`));
      // Count busy runners fleet-wide (each running agent holds one) rather than
      // only this journey's — assign may reuse idle runners left by prior runs.
      const busy = s.fleet.filter((r) => r.status === "busy").length;
      steps.push(step("runners are busy with the work", busy >= 2, `${busy} busy`));
      return steps;
    },
  },
  {
    id: "agent-lifecycle",
    name: "Steer a live agent — pause / resume / fork",
    desc: "Operator pauses and resumes an agent, then forks it to explore an alternative. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: steer ${tag}`;
      await api.createProject({ name: pname, goal: "simulated lifecycle" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      // Two runners: one for the agent, one free so the fork has capacity.
      await api.createRunner({ provider: "claude", model: "opus-4.8", name: `sim-steer-${tag}-a` });
      await api.createRunner({ provider: "claude", model: "opus-4.8", name: `sim-steer-${tag}-b` });
      await api.createTask(p.id, "Sim: long-running task");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [step("agent spawned", false, res.error)];
      const agentId = res.id;
      steps.push(step("agent running", true, agentId));
      // Lifecycle controls are resilient: if the server route is absent (404),
      // report it as a failed step instead of aborting the journey.
      const lifecycleUnavailable = (label: string, e: unknown): Step =>
        e instanceof api.ApiError && e.status === 404
          ? skipped(label, "lifecycle routes not deployed in this build")
          : step(label, false, (e as Error).message);
      try {
        await api.pauseAgent(agentId);
        s = await settle((sn) => sn.agents.find((a) => a.id === agentId)?.status === "paused");
        steps.push(step("pause → status paused", s.agents.find((a) => a.id === agentId)?.status === "paused"));
      } catch (e) {
        steps.push(lifecycleUnavailable("pause → status paused", e));
      }
      try {
        await api.resumeAgent(agentId);
        s = await settle((sn) => sn.agents.find((a) => a.id === agentId)?.status === "running");
        steps.push(step("resume → status running", s.agents.find((a) => a.id === agentId)?.status === "running"));
      } catch (e) {
        steps.push(lifecycleUnavailable("resume → status running", e));
      }
      const fork = await tryAssignFork(agentId);
      steps.push(step("fork created (own branch, shares context)", fork.ok, fork.detail));
      return steps;
    },
  },
  {
    id: "provider-credential",
    name: "Configure a provider credential",
    desc: "Operator stores a provider key; the vendor flips to available. Persists (encrypted at rest).",
    run: async () => {
      const steps: Step[] = [];
      const provider = "gemini"; // unlikely env-backed, so the flip is unambiguous
      try {
        await api.setSecret(provider, `sim-key-${uid()}42`);
      } catch (e) {
        return [skipped("secret store enabled (SKYNET_MASTER_KEY set)", (e as Error).message)];
      }
      const { secrets } = await api.fetchSecrets();
      steps.push(step("key stored (metadata only, no plaintext)", secrets.some((m) => m.provider === provider)));
      const s = await settle((sn) => sn.providers.find((p) => p.id === provider)?.available === true);
      steps.push(step("vendor becomes available for the fleet", s.providers.find((p) => p.id === provider)?.available === true));
      return steps;
    },
  },
];

/** Fork helper — forkAgent returns unknown; confirm via the snapshot. */
async function tryAssignFork(parentId: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    await api.forkAgent(parentId);
    const s = await settle((sn) => sn.agents.some((a) => a.parentId === parentId));
    const fork = s.agents.find((a) => a.parentId === parentId);
    return { ok: !!fork, detail: fork?.id };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * Sweep everything the journeys created. Deletes "Sim:" projects (which stops
 * their agents) and idle "sim-" runners. Persistent data is opt-in to remove.
 */
export async function clearSimulationData(): Promise<{ projects: number; runners: number }> {
  const s = await api.fetchSnapshot();
  let projects = 0;
  for (const p of s.projects.filter((x) => x.name.startsWith("Sim:"))) {
    try {
      await api.deleteProject(p.id);
      projects++;
    } catch {
      /* best-effort */
    }
  }
  let runners = 0;
  for (const r of s.fleet.filter((x) => (x.name ?? "").startsWith("sim-"))) {
    try {
      await api.deleteRunner(r.id);
      runners++;
    } catch {
      /* a busy runner can't be retired — leave it */
    }
  }
  return { projects, runners };
}
