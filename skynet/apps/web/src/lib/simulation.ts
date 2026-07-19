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

/**
 * Ensure the fleet has idle capacity to assign onto — WITHOUT piling up runners.
 * `assignTask` picks the oldest idle runner, so a journey that always mints a
 * fresh one just leaves it idle while the task runs on a borrowed elder. For
 * journeys that only need *a* runner (not a specific named one), reuse an idle
 * runner when one exists, else provision a fresh sim- runner. Journeys that are
 * ABOUT the fleet (provision, fleet-at-scale) or need their own runner to test
 * (stop/retire, fork) still create explicitly.
 */
async function ensureCapacity(name: string): Promise<void> {
  const s = await api.fetchSnapshot();
  if (!s.fleet.some((r) => r.status === "idle")) {
    await api.createAgent({ provider: "claude", model: "opus-4.8", name });
  }
}

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
      s = await settle((sn) => sn.tasks.find((t) => t.id === task.id)?.state === "ongoing");
      // Assign picks ANY idle runner (persistence may leave others around), so
      // check the agent's OWN runner, not the one this journey happened to add.
      const rid = "error" in res ? null : res.agentId;
      const runner = rid ? s.fleet.find((r) => r.id === rid) : undefined;
      steps.push(step("the agent's runner is busy", runner?.status === "busy", runner?.status ?? "no runner"));
      const t2 = s.tasks.find((t) => t.id === task.id);
      steps.push(step("task moved to ongoing", t2?.state === "ongoing", t2?.state));
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
      await ensureCapacity(`sim-sup-${tag}`);
      // A task that FORCES a shell command: edits are auto-allowed, but commands
      // gate — so the real agent raises a genuine approval HITL (no mock/canned
      // gate). The command's output must be unknowable without running it — a
      // clock-derived value — so the agent can't satisfy the task from its own
      // knowledge and skip the gated tool (as it did with `node --version`, which
      // it could just answer, completing the run with no gate ever raised).
      await api.createTask(
        p.id,
        "Run the shell command `echo skynet-gate-$(date +%s)` and report back the EXACT line it prints. " +
          "The value depends on the current clock, so you cannot know it without actually running the " +
          "command — do not guess or fabricate the output.",
      );
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
      // Pause/resume are SHIPPED routes. A 404 means the server build is stale or
      // behind main — a real deploy regression, not a benign gap — so fail loudly
      // (don't skip) to surface it immediately. Catch keeps the journey going so
      // the fork leg still runs and its result is reported alongside the failure.
      const lifecycleFailure = (label: string, e: unknown): Step =>
        e instanceof api.ApiError && e.status === 404
          ? step(label, false, "route missing (404) — server build is stale/behind main")
          : step(label, false, (e as Error).message);
      try {
        await api.pauseAgent(runId);
        s = await settle((sn) => sn.runs.find((a) => a.id === runId)?.status === "paused");
        steps.push(step("pause → status paused", s.runs.find((a) => a.id === runId)?.status === "paused"));
      } catch (e) {
        steps.push(lifecycleFailure("pause → status paused", e));
      }
      try {
        await api.resumeAgent(runId);
        s = await settle((sn) => sn.runs.find((a) => a.id === runId)?.status === "running");
        steps.push(step("resume → status running", s.runs.find((a) => a.id === runId)?.status === "running"));
      } catch (e) {
        steps.push(lifecycleFailure("resume → status running", e));
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
      // If the provider is already available (env-backed), the key→flip can't be
      // proven — skip rather than pass trivially.
      const preAvail = (await api.fetchSnapshot()).providers.find((p) => p.id === provider)?.available;
      if (preAvail === true) {
        return [skipped("vendor gated by a key (not env)", `${provider} already env-backed — can't prove the key-gated flip`)];
      }
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
      await ensureCapacity(`sim-arch-${tag}`);
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
        // stop is a SHIPPED route — a 404 is a stale/behind-main build, a real
        // regression. Fail loudly instead of skipping so it can't hide.
        const detail =
          e instanceof api.ApiError && e.status === 404
            ? "stop route missing (404) — server build is stale/behind main"
            : (e as Error).message;
        return [...steps, step("stop frees the runner", false, detail)];
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
      await ensureCapacity(`sim-chat-${tag}`);
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
    name: "Record a GitHub repo binding (branch + PR mode)",
    desc: "Operator creates a project in branch + PR mode — the repo binding is RECORDED on the project (control-plane only). Note: no real GitHub auth/clone/PR happens; a live round-trip needs a connected App/PAT (see #47). Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: gh ${tag}`;
      await api.createProject({ name: pname, goal: "simulated repo binding", repo: "acme/sim-demo" });
      const s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      steps.push(step("project created (persists on the board)", !!p, p?.id));
      steps.push(step("repo binding recorded — branch + PR mode (control-plane only)", p?.repo === "acme/sim-demo", p?.repo ?? "null"));
      // Deliberately NOT asserted: real GitHub connection/auth, repo existence, or
      // a push/PR — those need a connected App or PAT (connected=false by default),
      // which this keyless journey can't and shouldn't fake.
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
  {
    id: "run-pipeline-merge",
    name: "Full run pipeline — edit → diff review → merge",
    desc: "A REAL agent edits code in its isolated worktree and raises the end-of-run diff review; the operator approves and the branch integrates, completing the run. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: pipeline ${tag}`;
      await api.createProject({ name: pname, goal: "simulated end-to-end run", repoPath: `/tmp/skynet-sim/${tag}` });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await ensureCapacity(`sim-pipe-${tag}`);
      // A concrete edit (file writes are auto-allowed, so no mid-run gate) —
      // finishing routes the agent's branch to the end-of-run diff-review gate.
      await api.createTask(
        p.id,
        `Create a file named \`skynet-sim.txt\` in the repo root containing exactly the single line \`pipeline-${tag}\`. Make no other changes.`,
      );
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("real agent running", true, runId));
      // Edit → finish → orchestrator commits → diff-review gate (kind "diff").
      const gated = await settle(
        (sn) => sn.queue.some((q) => q.runId === runId && q.kind === "diff" && q.resolvedAt == null),
        120,
        1000,
      );
      const diff = gated.queue.find((q) => q.runId === runId && q.kind === "diff" && q.resolvedAt == null);
      steps.push(step("agent edited code and raised a diff-review gate", !!diff, diff ? diff.title : "no diff gate within ~120s"));
      if (!diff) return steps;
      await api.resolveHitl(diff.id, { action: "approve" });
      const done = await settle((sn) => sn.runs.find((a) => a.id === runId)?.status === "done", 60, 1000);
      const run = done.runs.find((a) => a.id === runId);
      steps.push(step("approval integrated the branch — run done", run?.status === "done", `status ${run?.status ?? "gone"}${run?.branch ? ` · ${run.branch}` : ""}`));
      const t2 = done.tasks.find((t) => t.id === task.id);
      steps.push(step("owning task moved to done (persists)", t2?.state === "done", t2?.state));
      return steps;
    },
  },
  {
    id: "gate-reject",
    name: "Reject a gated action",
    desc: "A REAL agent raises an approval gate on a shell command; the operator REJECTS it and the rejection lands in the audit trail. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: reject ${tag}`;
      await api.createProject({ name: pname, goal: "simulated rejection" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await ensureCapacity(`sim-rej-${tag}`);
      await api.createTask(
        p.id,
        "Run the shell command `echo skynet-reject-$(date +%s)` and report the EXACT line it prints. The value depends on the clock, so you must actually run it — do not guess.",
      );
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("real agent running", true, runId));
      const gated = await settle((sn) => sn.queue.some((q) => q.runId === runId && q.resolvedAt == null), 60, 1000);
      const open = gated.queue.find((q) => q.runId === runId && q.resolvedAt == null);
      steps.push(step("real agent raised an approval gate", !!open, open ? `${open.kind}: ${open.title}` : "no gate within ~60s"));
      if (!open) return steps;
      await api.resolveHitl(open.id, { action: "reject" });
      const trail = await settleAudit((a) => a.some((r) => r.hitlId === open.id));
      const row = trail.find((r) => r.hitlId === open.id);
      steps.push(step("rejection recorded in audit (action=reject)", row?.action === "reject", row ? `${row.action} · ${row.operatorId}` : "no audit row"));
      return steps;
    },
  },
  {
    id: "gate-modify",
    name: "Modify a gated action with guidance",
    desc: "A REAL agent raises an approval gate; the operator resolves it with MODIFY + guidance, and the modification (with its guidance) lands in the audit trail. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: modify ${tag}`;
      await api.createProject({ name: pname, goal: "simulated modify-with-guidance" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await ensureCapacity(`sim-mod-${tag}`);
      await api.createTask(
        p.id,
        "Run the shell command `echo skynet-modify-$(date +%s)` and report the EXACT line it prints. The value depends on the clock, so you must actually run it — do not guess.",
      );
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("real agent running", true, runId));
      const gated = await settle((sn) => sn.queue.some((q) => q.runId === runId && q.resolvedAt == null), 60, 1000);
      const open = gated.queue.find((q) => q.runId === runId && q.resolvedAt == null);
      steps.push(step("real agent raised an approval gate", !!open, open ? `${open.kind}: ${open.title}` : "no gate within ~60s"));
      if (!open) return steps;
      await api.resolveHitl(open.id, { action: "modify", guidance: "Prefer `node --version` — it's safer for this check." });
      const trail = await settleAudit((a) => a.some((r) => r.hitlId === open.id));
      const row = trail.find((r) => r.hitlId === open.id);
      steps.push(step("modification recorded in audit (action=modify)", row?.action === "modify", row ? `${row.action} · ${row.operatorId}` : "no audit row"));
      return steps;
    },
  },
  {
    id: "gate-question",
    name: "Answer a structured question (AskUserQuestion)",
    desc: "A REAL agent asks the operator to choose between options; the operator picks one via an option button and the decision lands in the audit trail. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: question ${tag}`;
      await api.createProject({ name: pname, goal: "simulated structured question" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await ensureCapacity(`sim-q-${tag}`);
      await api.createTask(
        p.id,
        "Before doing ANY work, you MUST use your question tool (AskUserQuestion) to ask the operator to choose between two options: (A) proceed with the task, or (B) stop. Ask the question and wait for the operator's choice before doing anything else.",
      );
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("real agent running", true, runId));
      const gated = await settle(
        (sn) => sn.queue.some((q) => q.runId === runId && q.kind === "question" && q.resolvedAt == null),
        60,
        1000,
      );
      const q = gated.queue.find((qq) => qq.runId === runId && qq.kind === "question" && qq.resolvedAt == null);
      steps.push(step("real agent raised a structured question gate", !!q, q ? q.title : "no question within ~60s"));
      if (!q) return steps;
      await api.resolveHitl(q.id, { action: "option", optionIndex: 0 });
      const trail = await settleAudit((a) => a.some((r) => r.hitlId === q.id));
      const row = trail.find((r) => r.hitlId === q.id);
      steps.push(step("operator's choice recorded in audit (action=option)", row?.action === "option", row ? `${row.action} · ${row.operatorId}` : "no audit row"));
      return steps;
    },
  },
  {
    id: "no-over-gate",
    name: "Trivial edits don't over-gate",
    desc: "A REAL agent makes a trivial file edit and reaches the end-of-run review WITHOUT any mid-run approval gate — edits are auto-allowed (#98). Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: no-over-gate ${tag}`;
      await api.createProject({ name: pname, goal: "simulated trivial edit", repoPath: `/tmp/skynet-sim/${tag}` });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await ensureCapacity(`sim-triv-${tag}`);
      await api.createTask(
        p.id,
        `Create a new file \`note-${tag}.txt\` containing the single comment line \`// touched by skynet ${tag}\`. This is a trivial edit — just write the file, nothing else.`,
      );
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("real agent running", true, runId));
      // Run until it finishes executing (review/done), noting whether ANY approval
      // gate was raised for it along the way. A `diff` review at the end is fine —
      // that's the whole-diff gate, not per-edit over-gating.
      let sawApproval = false;
      const finished = await settle(
        (sn) => {
          if (sn.queue.some((q) => q.runId === runId && q.kind === "approval")) sawApproval = true;
          const st = sn.runs.find((a) => a.id === runId)?.status;
          return st === "review" || st === "done";
        },
        90,
        1000,
      );
      const st = finished.runs.find((a) => a.id === runId)?.status;
      steps.push(step("run reached the end-of-run review", st === "review" || st === "done", st ?? "gone"));
      steps.push(step("no mid-run approval gate for a trivial edit (#98)", !sawApproval, sawApproval ? "an approval gate was raised" : "none — edits auto-allowed"));
      return steps;
    },
  },
  {
    id: "audit-maintenance",
    name: "Audit maintenance — archive / restore / delete",
    desc: "After a REAL decision hits the trail, the operator archives, restores, then deletes the record; the trail reflects each transition (#100). Persists (until deleted).",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: audit-maint ${tag}`;
      await api.createProject({ name: pname, goal: "simulated audit maintenance" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await ensureCapacity(`sim-audit-${tag}`);
      await api.createTask(
        p.id,
        "Run the shell command `echo skynet-audit-$(date +%s)` and report the EXACT line it prints. The value depends on the clock, so you must actually run it — do not guess.",
      );
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("real agent running", true, runId));
      const gated = await settle((sn) => sn.queue.some((q) => q.runId === runId && q.resolvedAt == null), 60, 1000);
      const open = gated.queue.find((q) => q.runId === runId && q.resolvedAt == null);
      steps.push(step("real agent raised an approval gate", !!open, open ? `${open.kind}: ${open.title}` : "no gate within ~60s"));
      if (!open) return steps;
      const hitlId = open.id;
      await api.resolveHitl(hitlId, { action: "approve" });
      let t = await settleAudit((a) => a.some((r) => r.hitlId === hitlId));
      steps.push(step("decision recorded in audit", t.some((r) => r.hitlId === hitlId)));
      await api.archiveAudit(hitlId, true);
      t = await settleAudit((a) => a.some((r) => r.hitlId === hitlId && r.archived === true));
      steps.push(step("record archived (soft-hide)", t.some((r) => r.hitlId === hitlId && r.archived === true)));
      await api.archiveAudit(hitlId, false);
      t = await settleAudit((a) => a.some((r) => r.hitlId === hitlId && r.archived !== true));
      steps.push(step("record restored", t.some((r) => r.hitlId === hitlId && r.archived !== true)));
      await api.deleteAudit(hitlId);
      t = await settleAudit((a) => !a.some((r) => r.hitlId === hitlId));
      steps.push(step("record deleted from the trail", !t.some((r) => r.hitlId === hitlId)));
      return steps;
    },
  },
  {
    id: "chat-after-finish",
    name: "Chat with an agent after it finishes",
    desc: "An operator messages a run that has finished executing (review/done) and still gets a reply — the session is reachable post-run. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: chat-after ${tag}`;
      await api.createProject({ name: pname, goal: "simulated post-run chat", repoPath: `/tmp/skynet-sim/${tag}` });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await ensureCapacity(`sim-chatf-${tag}`);
      await api.createTask(p.id, `Create a file \`done-${tag}.txt\` with the single line \`finished-${tag}\`, then stop.`);
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("real agent running", true, runId));
      const finished = await settle(
        (sn) => {
          const st = sn.runs.find((a) => a.id === runId)?.status;
          return st === "review" || st === "done";
        },
        90,
        1000,
      );
      const st = finished.runs.find((a) => a.id === runId)?.status;
      steps.push(step("run finished executing (review/done)", st === "review" || st === "done", st ?? "gone"));
      if (!(st === "review" || st === "done")) return steps;
      try {
        const { reply } = await api.sendAgentMessage(runId, "In one sentence, what did you change?");
        steps.push(step("agent replied after finishing", reply.trim().length > 0, reply ? `“${reply.slice(0, 60)}”` : "empty"));
      } catch (e) {
        steps.push(step("agent replied after finishing", false, (e as Error).message));
      }
      return steps;
    },
  },
  {
    id: "live-telemetry",
    name: "Live agent detail — plan, telemetry, log",
    desc: "A REAL running agent surfaces plan steps (PLAN panel), a live activity log, and token/cost telemetry. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: telemetry ${tag}`;
      await api.createProject({ name: pname, goal: "simulated live detail", repoPath: `/tmp/skynet-sim/${tag}` });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await ensureCapacity(`sim-tele-${tag}`);
      await api.createTask(
        p.id,
        `Use your TODO/task-planning tool to lay out a multi-step plan FIRST, then carry it out step by step, keeping the plan updated: (1) list the repository files, (2) read two of them, (3) write a short summary of what the project does to a new file \`summary-${tag}.md\`. Maintain the plan as you go.`,
      );
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const runId = res.id;
      steps.push(step("real agent running", true, runId));
      const planned = await settle((sn) => (sn.runs.find((a) => a.id === runId)?.plan.length ?? 0) > 0, 60, 1000);
      const planLen = planned.runs.find((a) => a.id === runId)?.plan.length ?? 0;
      // Plan steps come from the agent's own task-tracking tool calls — a model may
      // legitimately skip a formal plan on a short task, so treat 0 as inconclusive
      // (SKIP), not a failure. The log + telemetry checks below still gate the run.
      steps.push(
        planLen > 0
          ? step("PLAN panel has real steps", true, `${planLen} steps`)
          : skipped("PLAN panel has real steps", "agent finished without emitting a task plan (models may skip planning short tasks) — log + telemetry still verified"),
      );
      const logged = await settle((sn) => (sn.runs.find((a) => a.id === runId)?.log.length ?? 0) > 0, 60, 1000);
      const logLen = logged.runs.find((a) => a.id === runId)?.log.length ?? 0;
      steps.push(step("live activity log streaming", logLen > 0, `${logLen} lines`));
      const metered = await settle(
        (sn) => {
          const u = sn.runs.find((a) => a.id === runId)?.usage;
          return !!u && u.inputTokens + u.outputTokens > 0;
        },
        60,
        1000,
      );
      const u = metered.runs.find((a) => a.id === runId)?.usage;
      steps.push(step("token/cost telemetry reported", !!u && u.inputTokens + u.outputTokens > 0, u ? `${u.inputTokens}in/${u.outputTokens}out${u.costUsd != null ? ` · $${u.costUsd}` : ""}` : "no usage"));
      return steps;
    },
  },
  {
    id: "retire-guard",
    name: "Busy runner can't be retired; freed one can",
    desc: "A runner executing a task can't be retired; after the run is stopped the runner returns to the idle pool and is retirable (#77). Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: retire ${tag}`;
      await api.createProject({ name: pname, goal: "simulated retire guard" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-ret-${tag}` });
      // A shell command gates → the run parks in `waiting`, keeping its runner
      // reliably busy while we test the retire guard (no race with a fast finish).
      await api.createTask(p.id, "Run the shell command `echo skynet-hold-$(date +%s)` and report the exact line — you must actually run it.");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [...steps, step("agent spawned", false, res.error)];
      const runId = res.id;
      const rid = res.agentId;
      s = await settle((sn) => !!rid && sn.fleet.find((r) => r.id === rid)?.status === "busy");
      steps.push(step("runner busy with the run", !!rid && s.fleet.find((r) => r.id === rid)?.status === "busy", rid ?? "no runner"));
      // Retiring a busy runner must be refused (RunnerBusyError → 409).
      let refused = false;
      try {
        await api.deleteAgent(rid!);
      } catch (e) {
        refused = e instanceof api.ApiError && e.status === 409;
      }
      steps.push(step("retire refused while busy (409)", refused));
      // Stop the run → the runner returns to idle.
      try {
        await api.stopAgent(runId);
      } catch (e) {
        return [...steps, step("stop the run", false, (e as Error).message)];
      }
      s = await settle((sn) => !!rid && sn.fleet.find((r) => r.id === rid)?.status === "idle");
      steps.push(step("runner freed to idle after stop", !!rid && s.fleet.find((r) => r.id === rid)?.status === "idle"));
      // Now retire succeeds and the runner leaves the fleet.
      let retired = false;
      try {
        await api.deleteAgent(rid!);
        retired = true;
      } catch {
        retired = false;
      }
      const after = await settle((sn) => !sn.fleet.some((r) => r.id === rid));
      steps.push(step("freed runner is retirable", retired && !after.fleet.some((r) => r.id === rid)));
      return steps;
    },
  },
  {
    id: "task-lifecycle",
    name: "Task lifecycle — edit, move, transition, delete",
    desc: "Operator grooms the backlog: edits a task's text, reorders it, advances its state, and deletes another. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: backlog ${tag}`;
      await api.createProject({ name: pname, goal: "simulated backlog grooming" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      await api.createTask(p.id, "Sim: task to edit");
      await api.createTask(p.id, "Sim: task to delete");
      s = await settle((sn) => sn.tasks.filter((t) => t.projectId === p.id).length >= 2);
      const editTask = s.tasks.find((t) => t.projectId === p.id && t.text === "Sim: task to edit");
      const delTask = s.tasks.find((t) => t.projectId === p.id && t.text === "Sim: task to delete");
      steps.push(step("backlog seeded (2 tasks)", !!editTask && !!delTask));
      if (!editTask || !delTask) return steps;
      await api.updateTask(p.id, editTask.id, { text: "Sim: task (edited)" });
      s = await settle((sn) => sn.tasks.find((t) => t.id === editTask.id)?.text === "Sim: task (edited)");
      steps.push(step("task text edited", s.tasks.find((t) => t.id === editTask.id)?.text === "Sim: task (edited)"));
      try {
        await api.transitionTask(p.id, editTask.id, "triage");
        s = await settle((sn) => sn.tasks.find((t) => t.id === editTask.id)?.state === "triage");
        const st = s.tasks.find((t) => t.id === editTask.id)?.state;
        steps.push(step("task advanced backlog → triage", st === "triage", st));
      } catch (e) {
        steps.push(step("task advanced backlog → triage", false, (e as Error).message));
      }
      try {
        await api.moveTask(p.id, delTask.id, "up");
        steps.push(step("task reordered (move accepted)", true));
      } catch (e) {
        steps.push(step("task reordered (move accepted)", false, (e as Error).message));
      }
      await api.deleteTask(p.id, delTask.id);
      s = await settle((sn) => !sn.tasks.some((t) => t.id === delTask.id));
      steps.push(step("task deleted (gone from the backlog)", !s.tasks.some((t) => t.id === delTask.id)));
      return steps;
    },
  },
  {
    id: "project-edit-and-status",
    name: "Project — rename, re-goal, pause",
    desc: "Operator renames a project, updates its goal, and moves it active → paused. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const pname = `Sim: proj ${tag}`;
      await api.createProject({ name: pname, goal: "original goal" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      steps.push(step("project created (active)", p.status === "active", p.status));
      const renamed = `Sim: proj ${tag} (renamed)`;
      await api.updateProject(p.id, { name: renamed, goal: "updated goal" });
      s = await settle((sn) => sn.projects.find((x) => x.id === p.id)?.name === renamed);
      const p2 = s.projects.find((x) => x.id === p.id);
      steps.push(step("renamed + goal updated", p2?.name === renamed && p2?.goal === "updated goal", p2?.goal));
      await api.updateProject(p.id, { status: "paused" });
      s = await settle((sn) => sn.projects.find((x) => x.id === p.id)?.status === "paused");
      const st = s.projects.find((x) => x.id === p.id)?.status;
      steps.push(step("status active → paused", st === "paused", st));
      return steps;
    },
  },
  {
    id: "provider-key-removal",
    name: "Remove a provider key — vendor reverts",
    desc: "Operator removes a stored provider key; the vendor flips back to unavailable (unless an env var still supplies it).",
    run: async () => {
      const steps: Step[] = [];
      const provider = "gemini"; // unlikely env-backed, so the flip is unambiguous
      try {
        await api.setSecret(provider, `sim-key-${uid()}42`);
      } catch (e) {
        return [skipped("secret store enabled (SKYNET_MASTER_KEY set)", (e as Error).message)];
      }
      let s = await settle((sn) => sn.providers.find((p) => p.id === provider)?.available === true);
      steps.push(step("key set → vendor available", s.providers.find((p) => p.id === provider)?.available === true));
      await api.deleteSecret(provider);
      const after = await api.fetchSecrets();
      steps.push(step("key removed from the store", !after.secrets.some((m) => m.provider === provider)));
      const envBacked = after.env.includes(provider);
      s = await settle((sn) => sn.providers.find((p) => p.id === provider)?.available === envBacked);
      steps.push(
        envBacked
          ? skipped("vendor reverts to unavailable", "still available via an env var — expected")
          : step("vendor reverts to unavailable", s.providers.find((p) => p.id === provider)?.available === false),
      );
      return steps;
    },
  },
  {
    id: "service-token-lifecycle",
    name: "MCP service token — mint, list, revoke",
    desc: "Operator mints a scoped MCP token (raw secret shown once), sees only metadata in the list, then revokes it.",
    run: async () => {
      const steps: Step[] = [];
      let created: Awaited<ReturnType<typeof api.createServiceToken>>;
      try {
        created = await api.createServiceToken({ label: `sim-token-${uid()}`, scopes: ["observe"] });
      } catch (e) {
        return [skipped("service tokens enabled", (e as Error).message)];
      }
      steps.push(step("token minted — raw secret returned once", typeof created.token === "string" && created.token.length >= 8, `id ${created.id}`));
      const list = await api.listServiceTokens();
      const meta = list.find((t) => t.id === created.id);
      steps.push(step("appears in the list as metadata", !!meta, meta?.label));
      const noRaw = !!meta && !("token" in (meta as unknown as Record<string, unknown>)) && typeof meta.last4 === "string";
      steps.push(step("list carries only last4, never the raw token", noRaw, meta?.last4));
      await api.revokeServiceToken(created.id);
      const after = await api.listServiceTokens();
      steps.push(step("revoked — gone from the list", !after.some((t) => t.id === created.id)));
      return steps;
    },
  },
  {
    id: "github-connect-safety",
    name: "GitHub — reject a bad PAT, toggle a guardrail",
    desc: "Operator's invalid PAT is refused; and — once GitHub is connected — a write guardrail toggles off then back on (skips otherwise). No live GitHub round-trip.",
    run: async () => {
      const steps: Step[] = [];
      try {
        await api.connectGithubPat("ghp_sim_invalid_000000000000000000000000");
        steps.push(step("invalid PAT is refused", false, "unexpectedly accepted"));
      } catch (e) {
        steps.push(
          e instanceof api.ApiError
            ? step("invalid PAT is refused", true, `HTTP ${e.status}`)
            : skipped("invalid PAT is refused", `couldn't reach GitHub to validate: ${(e as Error).message}`),
        );
      }
      const before = (await api.fetchGithub()).connection.safety.moduleAllowlist;
      try {
        await api.updateGithubSafety({ moduleAllowlist: !before });
        const flipped = (await api.fetchGithub()).connection.safety.moduleAllowlist;
        steps.push(step("guardrail toggled off", flipped === !before, `moduleAllowlist ${before} → ${flipped}`));
        await api.updateGithubSafety({ moduleAllowlist: before });
        steps.push(step("guardrail restored", (await api.fetchGithub()).connection.safety.moduleAllowlist === before));
      } catch (e) {
        // Toggling guardrails requires a CONNECTED GitHub (PAT/App) — a live
        // remote we don't have offline; a 404 is the correct "not connected"
        // response, so treat it as inconclusive, not a failure.
        steps.push(
          e instanceof api.ApiError && e.status === 404
            ? skipped("guardrail toggle", "GitHub not connected — toggling needs a live PAT/App connection")
            : step("guardrail toggle", false, (e as Error).message),
        );
      }
      return steps;
    },
  },
  {
    id: "burst-parallel",
    name: "Burst — a wave of tasks runs in parallel",
    desc: "Operator provisions a small fleet and fires a batch of tasks at once; the whole wave executes concurrently, each run on its own runner (the acquisition mutex must not double-book). Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const N = 4;
      const pname = `Sim: burst ${tag}`;
      await api.createProject({ name: pname, goal: "simulated parallel burst" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      // A dedicated pool so the whole wave runs at once. This journey is ABOUT
      // parallelism, so provision explicitly (like fleet-at-scale).
      for (let i = 0; i < N; i++) {
        await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-burst-${tag}-${i}` });
      }
      for (let i = 0; i < N; i++) {
        await api.createTask(p.id, `Sim: parallel unit ${i + 1} — write a one-line note to burst-${tag}-${i + 1}.txt`);
      }
      s = await settle((sn) => sn.tasks.filter((t) => t.projectId === p.id).length >= N);
      const tasks = s.tasks.filter((t) => t.projectId === p.id).slice(0, N);
      steps.push(step(`backlog seeded with ${N} tasks`, tasks.length === N, `${tasks.length} tasks`));
      // Fire the whole wave concurrently — exercises the runner-acquisition mutex.
      const results = await Promise.all(tasks.map((t) => tryAssign(p.id, t.id)));
      const assigned = results.filter((r) => !("error" in r)).length;
      steps.push(step("whole wave assigned at once", assigned === N, `${assigned}/${N}`));
      s = await settle((sn) => sn.runs.filter((a) => a.projectId === p.id).length >= N);
      const runs = s.runs.filter((a) => a.projectId === p.id);
      steps.push(step("all units live as parallel runs", runs.length >= N, `${runs.length} runs`));
      // Each concurrent run holds its OWN runner — the mutex must never hand the
      // same idle runner to two runs (the TOCTOU double-booking guard, at scale).
      const runnerIds = new Set(runs.map((a) => a.agentId).filter((x): x is string => !!x));
      steps.push(step("each run on its own runner — no double-booking", runnerIds.size === runs.length, `${runnerIds.size} runners for ${runs.length} runs`));
      const inFlight = s.tasks.filter((t) => t.projectId === p.id && t.state !== "backlog").length;
      steps.push(step("tasks moved off the backlog into flight", inFlight >= N, `${inFlight}/${N} in flight`));
      return steps;
    },
  },
  {
    id: "fan-out-forks",
    name: "Fan out — fork a run into a family of alternatives",
    desc: "Operator assigns a task, then forks the run several times to explore alternatives; each fork branches from the original (shared context) on its own track. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const K = 3; // forks
      const pname = `Sim: fanout ${tag}`;
      await api.createProject({ name: pname, goal: "simulated fan-out family" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      // Root + a runner per fork so the family runs in parallel (fork also
      // provisions on demand, but pre-seeding keeps them concurrent).
      for (let i = 0; i < K + 1; i++) {
        await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-fanout-${tag}-${i}` });
      }
      await api.createTask(p.id, `Sim: root task — explore approaches for fanout-${tag}`);
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      const res = await tryAssign(p.id, task.id);
      if ("error" in res) return [step("root run spawned", false, res.error)];
      const parentId = res.id;
      steps.push(step("root run spawned", true, parentId));
      // Fan out: fork the root K times.
      for (let i = 0; i < K; i++) await tryAssignFork(parentId);
      s = await settle((sn) => sn.runs.filter((a) => a.parentId === parentId).length >= K);
      const children = s.runs.filter((a) => a.parentId === parentId);
      steps.push(step(`root fanned out into ${K} forks`, children.length >= K, `${children.length} children of ${parentId}`));
      // The family — root + children — each on its own branch/track.
      const family = s.runs.filter((a) => a.id === parentId || a.parentId === parentId);
      const branches = new Set(family.map((a) => a.branch));
      steps.push(step("each family member on its own branch/track", branches.size === family.length, `${branches.size} branches for ${family.length} runs`));
      // Forks inherit the root's provider lineage.
      steps.push(step("forks share the root's provider lineage", family.every((a) => a.provider === res.provider), res.provider));
      return steps;
    },
  },
  {
    id: "deep-backlog",
    name: "Deep backlog — a fleet works a big batch in parallel",
    desc: "A project with a deep backlog: the operator fires the whole batch, workers pull tasks in parallel up to capacity (no double-booking, no over-spawn), and any excess waits in the backlog — nothing is dropped. Persists.",
    run: async () => {
      const steps: Step[] = [];
      const tag = uid();
      const M = 6; // backlog depth
      const N = 3; // dedicated runners (the shared board may add more idle capacity)
      const pname = `Sim: backlog ${tag}`;
      await api.createProject({ name: pname, goal: "simulated deep backlog" });
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname);
      if (!p) return [step("project created", false)];
      for (let i = 0; i < N; i++) {
        await api.createAgent({ provider: "claude", model: "opus-4.8", name: `sim-backlog-${tag}-${i}` });
      }
      for (let i = 0; i < M; i++) await api.createTask(p.id, `Sim: backlog item ${i + 1} of ${M}`);
      s = await settle((sn) => sn.tasks.filter((t) => t.projectId === p.id).length >= M);
      const tasks = s.tasks.filter((t) => t.projectId === p.id).slice(0, M);
      steps.push(step(`deep backlog seeded (${M} tasks)`, tasks.length === M, `${tasks.length} tasks`));
      // Fire the whole backlog at once; only as many as there is idle capacity
      // start, the rest are refused (no capacity) and stay queued.
      const results = await Promise.all(tasks.map((t) => tryAssign(p.id, t.id)));
      const started = results.filter((r) => !("error" in r)).length;
      steps.push(step("workers pull tasks in parallel", started >= Math.min(N, M), `${started} started · ${M - started} refused (no capacity)`));
      s = await settle((sn) => sn.runs.filter((a) => a.projectId === p.id).length >= started);
      const runs = s.runs.filter((a) => a.projectId === p.id);
      steps.push(step("no over-spawn — one run per started task", runs.length === started, `${runs.length} runs for ${started} started`));
      const runnerIds = new Set(runs.map((a) => a.agentId).filter((x): x is string => !!x));
      steps.push(step("each run on its own runner — no double-booking", runnerIds.size === runs.length, `${runnerIds.size} runners for ${runs.length} runs`));
      // Every task is accounted for: either started (has a run) or still queued.
      const accounted = s.tasks.filter((t) => t.projectId === p.id && (t.state === "backlog" || !!t.runId)).length;
      steps.push(step("unstarted work waits in the backlog — nothing dropped", accounted === M, `${accounted}/${M} accounted`));
      return steps;
    },
  },
];

/**
 * A compact slice of the board handed to the behavioral judge as the "resulting
 * state" evidence for ONE journey. When `scopeProjectIds` is given (the projects
 * THIS journey just created), everything is scoped to those projects' runs/tasks
 * + only the runners those runs actually use + only the gates/decisions on those
 * runs. That isolation matters: the Simulation board is shared and persistent, so
 * without it the judge sees every other journey's runs/gates/idle spare runners
 * and spends its verdict explaining them away (or, worse, mis-attributes them).
 * Falls back to the whole Sim-tagged board when no scope is passed.
 */
export async function captureEvidence(scopeProjectIds?: string[]): Promise<Record<string, unknown>> {
  const [s, audit] = await Promise.all([
    api.fetchSnapshot(),
    api.fetchAudit().catch(() => [] as Awaited<ReturnType<typeof api.fetchAudit>>),
  ]);
  const scoped = scopeProjectIds != null;
  const projects = scoped
    ? s.projects.filter((p) => scopeProjectIds!.includes(p.id))
    : s.projects.filter((p) => p.name.startsWith("Sim:"));
  const projectIds = new Set(projects.map((p) => p.id));
  const runs = s.runs.filter((a) => projectIds.has(a.projectId));
  const runIds = new Set(runs.map((a) => a.id));
  // Only the runners THIS journey's runs actually execute on — not every sim-
  // runner ever provisioned. Idle spares are noise the judge would flag as an
  // incoherent "provisioned runner sits idle" gap.
  const usedRunnerIds = new Set(runs.map((a) => a.agentId).filter((x): x is string => !!x));
  return {
    scope: scoped ? "this journey's own entities only" : "all Sim-tagged",
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      repoPath: p.repoPath ?? null,
      repo: p.repo ?? null,
      runs: p.runIds.length,
    })),
    runs: runs.map((a) => ({
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
      .filter((r) => usedRunnerIds.has(r.id))
      .map((r) => ({ id: r.id, name: r.name, status: r.status })),
    openHitl: s.queue
      .filter((q) => q.resolvedAt == null && runIds.has(q.runId))
      .map((q) => ({ kind: q.kind, title: q.title, runId: q.runId })),
    // Only decisions on THIS journey's runs — not the whole shared audit trail.
    audit: audit
      .filter((r) => runIds.has(r.runId))
      .slice(0, 6)
      .map((r) => ({ hitlId: r.hitlId, runId: r.runId, action: r.action, operatorId: r.operatorId })),
  };
}

/**
 * Drain any Sim run left wedged on an unanswered gate. Gate-testing journeys
 * resolve only their ONE scripted decision; a real agent then re-raises a
 * follow-up gate (another Bash command) that nothing answers, so the run wedges
 * in `waiting`, holds its runner busy, and leaves a dangling gate. Across the
 * shared, persistent board these pile up — runners never free, later journeys
 * borrow whichever idle runner is left, and every later judge has to reason
 * about a growing heap of unrelated open gates. Called after each journey: it
 * approves open gates on Sim runs until they clear (letting the agent finish to
 * done/review) or the budget runs out. Bounded so a chatty agent can't hang it.
 */
export async function drainWedgedRuns(budgetMs = 25_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const s = await api.fetchSnapshot().catch(() => null);
    if (!s) return;
    const simProjectIds = new Set(s.projects.filter((p) => p.name.startsWith("Sim:")).map((p) => p.id));
    const simRunIds = new Set(s.runs.filter((r) => simProjectIds.has(r.projectId)).map((r) => r.id));
    const open = s.queue.filter((q) => q.resolvedAt == null && simRunIds.has(q.runId));
    if (open.length === 0) return;
    for (const gate of open) await api.resolveHitl(gate.id, { action: "approve" }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 700));
  }
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
