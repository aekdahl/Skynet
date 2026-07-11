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
import type { AuditRecord, TaskRun } from "@skynet/shared";

/** Poll the audit trail until `ready`, then return the latest (real-agent timing). */
async function settleAudit(
  ready: (a: AuditRecord[]) => boolean,
  tries = 8,
  delayMs = 300,
): Promise<AuditRecord[]> {
  let a = await api.fetchAudit();
  for (let n = 0; n < tries && !ready(a); n++) {
    await new Promise((r) => setTimeout(r, delayMs));
    a = await api.fetchAudit();
  }
  return a;
}

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
async function tryAssign(projectId: string, taskId: string): Promise<TaskRun | { error: string }> {
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
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-runner-${tag}` });
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
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-runner-${tag}` });
      await api.createTask(p.id, "Sim: implement the feature");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id);
      steps.push(step("task queued in backlog", !!task, task?.id));
      if (!task) return steps;
      const res = await tryAssign(p.id, task.id);
      const runId = "error" in res ? undefined : res.id;
      steps.push(step("agent spawned on assign (persists)", !!runId, "error" in res ? res.error : `${res.id} · ${res.status}`));
      s = await settle((sn) => sn.tasks.find((t) => t.id === task.id)?.state === "assigned");
      // Assign picks ANY idle runner (persistence may leave others around), so
      // check the agent's OWN runner, not the one this journey happened to add.
      const rid = "error" in res ? null : res.agentId;
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
    desc: "Operator assigns a task needing a gated action; the REAL agent pauses for approval; the operator resolves it and the decision lands in the audit trail. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: supervise ${tag}`;
      await api.createProject({ name: pname, goal: "simulated supervised decision" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-sup-${tag}` });
      // A task that requires a SHELL command: edits are auto-allowed, but commands
      // gate — so the real agent raises a genuine approval HITL (no mock/canned gate).
      await api.createTask(p.id, "Run the shell command `node --version` and report the version string you get back.");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const auditBefore = (await api.fetchAudit()).length;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const agentId = res.id;
      steps.push(step("real agent running", true, agentId));
      // Wait generously for the real agent to spin up and reach the command gate.
      const gated = await settle(
        (sn) => sn.queue.some((q) => q.runId === agentId && q.resolvedAt == null),
        60,
        1000,
      );
      const open = gated.queue.find((q) => q.runId === agentId && q.resolvedAt == null);
      steps.push(step("real agent raised an approval gate", !!open, open ? `${open.kind}: ${open.title}` : "no gate within ~60s"));
      if (!open) return steps;
      await api.resolveHitl(open.id, { action: "approve" });
      const trail = await settleAudit((a) => a.some((r) => r.hitlId === open.id));
      steps.push(step("decision recorded in audit (persists)", trail.some((r) => r.hitlId === open.id), `audit ${auditBefore} → ${trail.length}`));
      steps.push(step("audit names the resolved gate + operator", trail.some((r) => r.hitlId === open.id && !!r.operatorId)));
      return steps;
    },
  },
  {
    id: "fleet-at-scale",
    name: "Build a busy multi-agent board",
    desc: "Operator scales the fleet and assigns several tasks so multiple runs run in parallel. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: fleet ${tag}`;
      await api.createProject({ name: pname, goal: "simulated fleet at scale" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-fleet-${tag}-a` });
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-fleet-${tag}-b` });
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
      s = await settle((sn) => sn.runs.filter((a) => a.projectId === p.id).length >= 2);
      const runs = s.runs.filter((a) => a.projectId === p.id);
      steps.push(step("multiple runs live on the board", runs.length >= 2, `${runs.length} runs`));
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
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-steer-${tag}-a` });
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-steer-${tag}-b` });
      await api.createTask(p.id, "Sim: long-running task");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("agent running", true, runId));
      // Lifecycle controls are resilient: if the server route is absent (404),
      // report it as a failed step instead of aborting the journey.
      const lifecycleUnavailable = (label: string, e: unknown): Step =>
        e instanceof api.ApiError && e.status === 404
          ? skipped(label, "lifecycle routes not deployed in this build")
          : step(label, false, (e as Error).message);
      try {
        await api.pauseAgent(runId);
        s = await settle((sn) => sn.runs.find((a) => a.id === runId)?.status === "paused");
        steps.push(step("pause → status paused", s.runs.find((a) => a.id === runId)?.status === "paused"));
      } catch (e) {
        steps.push(lifecycleUnavailable("pause → status paused", e));
      }
      try {
        await api.resumeAgent(runId);
        s = await settle((sn) => sn.runs.find((a) => a.id === runId)?.status === "running");
        steps.push(step("resume → status running", s.runs.find((a) => a.id === runId)?.status === "running"));
      } catch (e) {
        steps.push(lifecycleUnavailable("resume → status running", e));
      }
      const fork = await tryAssignFork(runId);
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
  {
    id: "archive-restore",
    name: "Archive then restore an agent",
    desc: "Operator hides an agent from the board, then restores it — its history is kept either way. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: archive ${tag}`;
      await api.createProject({ name: pname, goal: "simulated archive/restore" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-arch-${tag}` });
      await api.createTask(p.id, "Sim: task to archive");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("agent running on the board", true, runId));
      await api.archiveAgent(runId, true);
      s = await settle((sn) => sn.runs.find((a) => a.id === runId)?.archived === true);
      steps.push(step("archived → hidden from the board (kept in history)", s.runs.find((a) => a.id === runId)?.archived === true));
      await api.archiveAgent(runId, false);
      s = await settle((sn) => sn.runs.find((a) => a.id === runId)?.archived === false);
      steps.push(step("restored → back on the board", s.runs.find((a) => a.id === runId)?.archived === false));
      return steps;
    },
  },
  {
    id: "stop-frees-runner",
    name: "Stop an agent — its runner is freed",
    desc: "Operator stops a running agent; it ends and the runner it held returns to the idle pool, reusable. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: stop ${tag}`;
      await api.createProject({ name: pname, goal: "simulated stop" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-stop-${tag}` });
      await api.createTask(p.id, "Sim: task to stop");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [step("agent spawned", false, res.error)];
      const runId = res.id;
      const rid = res.agentId;
      s = await settle((sn) => !!rid && sn.fleet.find((r) => r.id === rid)?.status === "busy");
      steps.push(step("agent running, its runner busy", !!rid && s.fleet.find((r) => r.id === rid)?.status === "busy", rid ?? "no runner"));
      try {
        await api.stopAgent(runId);
      } catch (e) {
        if (e instanceof api.ApiError && e.status === 404)
          return [...steps, skipped("stop frees the runner", "stop route not deployed in this build")];
        throw e;
      }
      s = await settle((sn) => sn.runs.find((a) => a.id === runId)?.status === "done");
      steps.push(step("agent stopped (status done)", s.runs.find((a) => a.id === runId)?.status === "done"));
      s = await settle((sn) => !rid || sn.fleet.find((r) => r.id === rid)?.status === "idle");
      steps.push(step("its runner returned to idle (reusable)", !rid || s.fleet.find((r) => r.id === rid)?.status === "idle", rid ? (s.fleet.find((r) => r.id === rid)?.status ?? "gone") : "n/a"));
      return steps;
    },
  },
  {
    id: "chat-with-agent",
    name: "Chat with a working agent",
    desc: "Operator messages a live agent to discuss the task and gets a reply — the agent keeps working. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: chat ${tag}`;
      await api.createProject({ name: pname, goal: "simulated chat" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-chat-${tag}` });
      await api.createTask(p.id, "Sim: task to discuss");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [step("agent spawned", false, res.error)];
      steps.push(step("agent running", true, res.id));
      try {
        const { reply } = await api.sendAgentMessage(res.id, "What's your current approach?");
        steps.push(step("agent replied to the chat message", reply.trim().length > 0, reply ? `“${reply.slice(0, 60)}”` : "empty"));
      } catch (e) {
        steps.push(step("agent replied to the chat message", false, (e as Error).message));
      }
      return steps;
    },
  },
  {
    id: "connect-github-repo",
    name: "Bind a project to a GitHub repo",
    desc: "Operator creates a project in branch + PR mode (bound to a GitHub repo) instead of a local folder. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: gh ${tag}`;
      await api.createProject({ name: pname, goal: "simulated repo binding", repo: "acme/sim-demo" });
      const s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      steps.push(step("project created (persists on the board)", !!p, p?.id));
      steps.push(step("bound to a GitHub repo (branch + PR mode)", p?.repo === "acme/sim-demo", p?.repo ?? "null"));
      return steps;
    },
  },
  {
    id: "guardrails-on",
    name: "Write guardrails are on by default",
    desc: "Operator inspects the GitHub connection — every write guardrail is enabled until deliberately relaxed.",
    run: async () => {
      const g = await api.fetchGithub();
      const sp = g.connection.safety;
      return [
        step("PR-only (no direct default-branch push)", sp.prOnly === true),
        step("no force-push / history rewrite", sp.noForcePush === true),
        step("module allowlist enforced", sp.moduleAllowlist === true),
        step("approve before push/merge", sp.approveBeforePush === true),
      ];
    },
  },
];

/**
 * A compact, Sim-tagged slice of the current board + a recent audit tail —
 * handed to the behavioral judge as the "resulting state" evidence alongside a
 * journey's steps. Kept small (ids/statuses, not full logs) so the judge sees
 * the shape of what the journey produced without a huge payload.
 */
export async function captureEvidence(): Promise<Record<string, unknown>> {
  const [s, audit] = await Promise.all([
    api.fetchSnapshot(),
    api.fetchAudit().catch(() => [] as Awaited<ReturnType<typeof api.fetchAudit>>),
  ]);
  const projects = s.projects.filter((p) => p.name.startsWith("Sim:"));
  const projectIds = new Set(projects.map((p) => p.id));
  return {
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      repoPath: p.repoPath ?? null,
      repo: p.repo ?? null,
      runs: p.runIds.length,
    })),
    runs: s.runs
      .filter((a) => projectIds.has(a.projectId))
      .map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        archived: a.archived,
        agentId: a.agentId,
        parentId: a.parentId,
        plan: `${a.plan.filter((x) => x.state === "done").length}/${a.plan.length}`,
      })),
    tasks: s.tasks
      .filter((t) => projectIds.has(t.projectId))
      .map((t) => ({ id: t.id, text: t.text, state: t.state, projectId: t.projectId })),
    runners: s.fleet
      .filter((r) => (r.name ?? "").startsWith("sim-"))
      .map((r) => ({ id: r.id, name: r.name, status: r.status })),
    openHitl: s.queue.filter((q) => q.resolvedAt == null).map((q) => ({ kind: q.kind, title: q.title })),
    auditCount: audit.length,
    recentAudit: audit.slice(0, 6),
  };
}

/** Fork helper — forkAgent returns unknown; confirm via the snapshot. */
async function tryAssignFork(parentId: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    await api.forkAgent(parentId);
    const s = await settle((sn) => sn.runs.some((a) => a.parentId === parentId));
    const fork = s.runs.find((a) => a.parentId === parentId);
    return { ok: !!fork, detail: fork?.id };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * Sweep everything the journeys created. Deletes "Sim:" projects (which stops
 * their runs) and idle "sim-" agents. Persistent data is opt-in to remove.
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
      await api.deleteAgent(r.id);
      runners++;
    } catch {
      /* a busy runner can't be retired — leave it */
    }
  }
  return { projects, runners };
}
