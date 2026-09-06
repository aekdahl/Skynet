// In-app acceptance checks: each scenario drives the REAL API and asserts on the
// resulting state, so you can run them from within Skynet and watch the control
// plane behave (temp "UAT:" projects/runs flash on the board, then clean up).
//
// These verify the control plane + state transitions deterministically — no
// provider keys needed. Deep runner behavior (real Claude edit→merge) is covered
// by docs/qa/llm-e2e. Each scenario is independent and cleans up after itself.

import * as api from "./client";
import { settle } from "./poll";

export interface Step {
  label: string;
  ok: boolean;
  // A skipped step is a precondition that wasn't met (e.g. no open approval to
  // resolve) — inconclusive, NOT a failure. It doesn't fail the scenario.
  skip?: boolean;
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
const skipped = (label: string, detail?: string): Step => ({ label, ok: false, skip: true, detail });
const swallow = (p: Promise<unknown>) => p.catch(() => undefined);

export const SCENARIOS: Scenario[] = [
  {
    id: "control-plane",
    name: "Control plane reachable",
    desc: "The API answers and returns a seeded workspace snapshot.",
    run: async () => {
      const s = await api.fetchSnapshot();
      return [
        step("GET /api/snapshot returns a snapshot", Array.isArray(s.runs), `${s.runs.length} runs`),
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
      let s = await settle((sn) => sn.projects.some((x) => x.name === name));
      const p = s.projects.find((x) => x.name === name);
      steps.push(step("project created + in snapshot", !!p, p?.id));
      if (p) {
        await api.deleteProject(p.id);
        s = await settle((sn) => !sn.projects.some((x) => x.id === p.id));
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
      await api.createAgent({ provider: "claude", model: "opus-4.8" });
      const s = await settle((sn) => sn.fleet.some((r) => !before.has(r.id)));
      const added = s.fleet.find((r) => !before.has(r.id));
      steps.push(step("runner added to fleet", !!added, added?.id));
      steps.push(step("new runner is idle", added?.status === "idle", added?.status));
      if (added) {
        await swallow(api.deleteAgent(added.id));
        const s2 = await settle((sn) => !sn.fleet.some((r) => r.id === added.id));
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
      let s = await settle((sn) => sn.projects.some((x) => x.name === pname));
      const p = s.projects.find((x) => x.name === pname)!;
      await api.createAgent({ provider: "claude", model: "opus-4.8" }); // ensure capacity
      await api.createTask(p.id, "acceptance: say hello");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id);
      steps.push(step("task created in project", !!task, task?.id));
      let runId: string | undefined;
      if (task) {
        try {
          const run = await api.assignTask(p.id, task.id);
          runId = run.id;
          steps.push(step("assign created an agent", true, `${run.id} · ${run.status}`));
        } catch (e) {
          // Keyless (no provider credential) the orchestrator refuses to spawn —
          // RunnerNotConfigured (409). That's expected for this control-plane,
          // key-free suite; real agent spawn is covered by the Simulation suite.
          // Skip cleanly rather than failing (the mock runner that used to spawn
          // here keyless was removed in #108).
          const st = e instanceof api.ApiError ? e.status : 0;
          steps.push(
            st === 409
              ? skipped("assign created an agent", "no provider credential — agent spawn is covered by Simulation")
              : step("assign created an agent", false, (e as Error).message),
          );
        }
      }
      if (runId) {
        await api.archiveAgent(runId, true);
        s = await settle((sn) => sn.runs.find((a) => a.id === runId)?.archived === true);
        steps.push(step("agent archived (hidden from board)", s.runs.find((a) => a.id === runId)?.archived === true));
        await api.archiveAgent(runId, false);
        s = await settle((sn) => sn.runs.find((a) => a.id === runId)?.archived === false);
        steps.push(step("agent restored", s.runs.find((a) => a.id === runId)?.archived === false));
        await swallow(api.archiveAgent(runId, true)); // tidy: hide the temp agent
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
      // If the provider is ALREADY available (an env var backs it), the key→flip
      // can't be proven — "becomes available" would pass regardless. Skip so this
      // is never a false positive.
      const preAvail = (await api.fetchSnapshot()).providers.find((p) => p.id === provider)?.available;
      if (preAvail === true) {
        return [skipped("vendor gated by a key (not env)", `${provider} is already env-backed here — can't prove the key-gated flip`)];
      }
      try {
        await api.setSecret(provider, `uat-key-${uid()}90`);
      } catch (e) {
        return [skipped("secret store enabled (SKYNET_MASTER_KEY set)", (e as Error).message)];
      }
      const { secrets } = await api.fetchSecrets();
      steps.push(step("key stored (metadata only)", secrets.some((m) => m.provider === provider)));
      const s = await settle((sn) => sn.providers.find((p) => p.id === provider)?.available === true);
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
      // This keyless suite can't spawn a real agent to RAISE a gate (that needs a
      // provider credential), so it can only exercise the resolve→audit path when
      // a gate already happens to be open. The self-contained version — spawn a
      // real agent, make it raise a gate, resolve it, assert the audit — lives in
      // the Simulation suite (supervise / audit-maintenance). Skip when none open.
      const s = await api.fetchSnapshot();
      const open = s.queue.find((q) => q.resolvedAt == null);
      if (!open) {
        steps.push(skipped("an open approval to resolve", "none open (keyless) — the self-contained version is the Simulation 'Supervise' + 'Audit maintenance' journeys"));
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

  // ── GTM-claim coverage: each maps to a promotable "what's shipped" claim ───
  {
    id: "vendor-neutral",
    name: "Vendor-neutral runner catalog",
    desc: 'Backs “multi-vendor ready.” All provider runners sit behind one seam; a key gates each.',
    run: async () => {
      const s = await api.fetchSnapshot();
      const ids = new Set<string>(s.providers.map((p) => p.id));
      const want = ["claude", "codex", "gemini", "cursor", "copilot"];
      return [
        step("all vendor runners in the catalog", want.every((id) => ids.has(id)), [...ids].join(", ")),
        step("each provider advertises models", s.providers.every((p) => (p.models?.length ?? 0) > 0)),
      ];
    },
  },
  {
    id: "safety-defaults",
    name: "Guardrails on by default",
    desc: 'Backs “nothing risky without you.” Every write guardrail is on until an operator disables it.',
    run: async () => {
      const sp = (await api.fetchGithub()).connection.safety;
      return [
        step("PR-only (no direct default-branch push)", sp.prOnly === true),
        step("no force-push / history rewrite", sp.noForcePush === true),
        step("module allowlist enforced", sp.moduleAllowlist === true),
        step("approve before push/merge", sp.approveBeforePush === true),
      ];
    },
  },
  {
    id: "keys-private",
    name: "Provider keys stay private (write-only)",
    desc: 'Backs “local-first & private.” A stored key is never returned — only last4 — and the catalog carries no secret.',
    run: async () => {
      const steps: Step[] = [];
      const provider = "codex";
      try {
        await api.setSecret(provider, "uat-secret-WXYZ7788");
      } catch (e) {
        return [skipped("secret store enabled (SKYNET_MASTER_KEY set)", (e as Error).message)];
      }
      const rec = (await api.fetchSecrets()).secrets.find((m) => m.provider === provider) as
        | Record<string, unknown>
        | undefined;
      const noPlaintext = !!rec && !("apiKey" in rec) && !("key" in rec) && !("ciphertext" in rec) && !("token" in rec);
      steps.push(step("only last4 returned, no plaintext", noPlaintext && rec!.last4 === "7788", rec?.last4 as string));
      const cat = (await api.fetchSnapshot()).providers.find((p) => p.id === provider) as Record<string, unknown> | undefined;
      steps.push(step("provider catalog carries no secret", !!cat && !("apiKey" in cat) && !("key" in cat) && !("token" in cat)));
      await swallow(api.deleteSecret(provider));
      return steps;
    },
  },
  {
    id: "project-repo-binding",
    name: "Project binds to a folder or a GitHub repo",
    desc: 'Backs “point it at any local folder — or connect a GitHub repo.” Both connect modes are recorded.',
    run: async () => {
      // Control-plane only: verifies both connect modes are RECORDED on the
      // project (round-trip through the store). It does NOT exercise a real
      // worktree checkout or GitHub connection — those need a credential and are
      // covered by the Simulation suite + docs/qa/llm-e2e.
      const steps: Step[] = [];
      const localName = `UAT: local ${uid()}`;
      await api.createProject({ name: localName, goal: "acceptance", repoPath: "/tmp/uat-acceptance-repo" });
      let s = await settle((sn) => sn.projects.some((p) => p.name === localName));
      const lp = s.projects.find((p) => p.name === localName);
      steps.push(step("local folder path recorded (worktree-per-agent mode)", lp?.repoPath === "/tmp/uat-acceptance-repo", lp?.repoPath ?? "null"));
      const ghName = `UAT: gh ${uid()}`;
      await api.createProject({ name: ghName, goal: "acceptance", repo: "acme/demo" });
      s = await settle((sn) => sn.projects.some((p) => p.name === ghName));
      const gp = s.projects.find((p) => p.name === ghName);
      steps.push(step("GitHub repo recorded (branch + PR mode)", gp?.repo === "acme/demo", gp?.repo ?? "null"));
      if (lp) await swallow(api.deleteProject(lp.id));
      if (gp) await swallow(api.deleteProject(gp.id));
      return steps;
    },
  },
  {
    id: "project-roadmap-doc",
    name: "Project roadmap doc reflects the repo binding",
    desc: "The Roadmap tab's read/commit endpoints report the right state for an unbound project and one bound to a missing local path — control-plane only, no real ROADMAP.md needed.",
    run: async () => {
      const steps: Step[] = [];
      const unboundName = `UAT: roadmap unbound ${uid()}`;
      await api.createProject({ name: unboundName, goal: "acceptance" });
      let s = await settle((sn) => sn.projects.some((p) => p.name === unboundName));
      const unbound = s.projects.find((p) => p.name === unboundName)!;
      const unboundResult = await api.fetchProjectRoadmap(unbound.id);
      steps.push(step("unbound project reports state 'unbound'", unboundResult.state === "unbound", unboundResult.state));
      try {
        await api.commitProjectRoadmap(unbound.id, { path: "ROADMAP.md", content: "x", baselineHash: "x" });
        steps.push(step("commit on an unbound project is refused", false, "did not throw"));
      } catch (e) {
        const status = e instanceof api.ApiError ? e.status : 0;
        steps.push(step("commit on an unbound project is refused", status === 400, `status ${status}`));
      }

      const missingName = `UAT: roadmap missing-repo ${uid()}`;
      await api.createProject({ name: missingName, goal: "acceptance", repoPath: `/tmp/uat-roadmap-missing-${uid()}` });
      s = await settle((sn) => sn.projects.some((p) => p.name === missingName));
      const missing = s.projects.find((p) => p.name === missingName)!;
      const missingResult = await api.fetchProjectRoadmap(missing.id);
      steps.push(step("project bound to a missing local path reports 'missing_local_repo'", missingResult.state === "missing_local_repo", missingResult.state));

      await swallow(api.deleteProject(unbound.id));
      await swallow(api.deleteProject(missing.id));
      return steps;
    },
  },
  {
    id: "project-quality-scan",
    name: "Coverage tab scans the bound branch",
    desc: "The Coverage tab's scan endpoint reports the right state for an unbound project and one bound to a missing local path, and never runs the scanned repo's toolchain.",
    run: async () => {
      const steps: Step[] = [];
      const unboundName = `UAT: quality unbound ${uid()}`;
      await api.createProject({ name: unboundName, goal: "acceptance" });
      let s = await settle((sn) => sn.projects.some((p) => p.name === unboundName));
      const unbound = s.projects.find((p) => p.name === unboundName)!;
      const unboundResult = await api.fetchProjectQuality(unbound.id);
      steps.push(step("unbound project reports state 'unbound'", unboundResult.state === "unbound", unboundResult.state));

      const missingName = `UAT: quality missing-repo ${uid()}`;
      await api.createProject({ name: missingName, goal: "acceptance", repoPath: `/tmp/uat-quality-missing-${uid()}` });
      s = await settle((sn) => sn.projects.some((p) => p.name === missingName));
      const missing = s.projects.find((p) => p.name === missingName)!;
      const missingResult = await api.fetchProjectQuality(missing.id);
      steps.push(
        step(
          "project bound to a missing local path reports 'missing_local_repo'",
          missingResult.state === "missing_local_repo",
          missingResult.state,
        ),
      );
      // A scan that can't find a repo must say so — never render as a real
      // zero-gap result, which would read as "fully covered".
      steps.push(step("a failed scan never masquerades as a clean result", missingResult.state !== "ok"));

      await swallow(api.deleteProject(unbound.id));
      await swallow(api.deleteProject(missing.id));
      return steps;
    },
  },
  {
    id: "momentum-board-transitions",
    name: "Momentum Board transitions feed reads clean for a fresh project",
    desc: "A brand-new project (no kanban moves yet) reports an empty transition feed, not an error — control-plane only.",
    run: async () => {
      const steps: Step[] = [];
      const name = `UAT: momentum ${uid()}`;
      await api.createProject({ name, goal: "acceptance" });
      const s = await settle((sn) => sn.projects.some((p) => p.name === name));
      const p = s.projects.find((p2) => p2.name === name)!;
      const transitions = await api.fetchProjectTransitions(p.id, { limit: 50 });
      steps.push(step("transitions endpoint returns an array", Array.isArray(transitions), `${transitions.length} transitions`));
      steps.push(step("a fresh project has no transitions yet", transitions.length === 0));
      await swallow(api.deleteProject(p.id));
      return steps;
    },
  },
  {
    id: "home-workspace-transitions",
    name: "Home's workspace-wide transitions read (Phase 22)",
    desc: "The cross-project transitions endpoint Home's automation-rate/stalled-count stats read — control-plane only: array shape, and `since` actually filters, not just per-project scoping.",
    run: async () => {
      const steps: Step[] = [];
      const all = await api.fetchTransitions({ limit: 50 });
      steps.push(step("workspace transitions endpoint returns an array", Array.isArray(all), `${all.length} transitions`));
      // A `since` far in the future can never match anything real — proves
      // the filter is actually applied server-side, not just ignored.
      const future = await api.fetchTransitions({ since: Date.now() + 365 * 24 * 60 * 60 * 1000 });
      steps.push(step("a future `since` returns nothing", future.length === 0));
      return steps;
    },
  },
  {
    id: "roadmap-doc-view",
    name: "Roadmap document view's doc/proposals endpoints (Phase 26)",
    desc: "The parsed-doc and proposals-list reads for an unbound project (no repo — control-plane only, no local git checkout needed here), plus applying a nonexistent proposal is refused honestly.",
    run: async () => {
      const steps: Step[] = [];
      const name = `UAT: roadmap doc view ${uid()}`;
      await api.createProject({ name, goal: "acceptance" });
      const s = await settle((sn) => sn.projects.some((p) => p.name === name));
      const p = s.projects.find((p2) => p2.name === name)!;

      const doc = await api.fetchProjectRoadmapDoc(p.id);
      steps.push(step("parsed-doc endpoint returns a RoadmapDoc shape (never errors on an unbound project)", Array.isArray(doc.ast) && Array.isArray(doc.sections)));

      const proposals = await api.fetchRoadmapProposals(p.id);
      steps.push(step("proposals list returns an array", Array.isArray(proposals), `${proposals.length} proposals`));
      steps.push(step("a fresh project has no proposals yet", proposals.length === 0));

      let refused = false;
      try {
        await api.applyRoadmapProposal(p.id, "nope");
      } catch {
        refused = true;
      }
      steps.push(step("applying a proposal id that doesn't exist is refused, not silently accepted", refused));

      await swallow(api.deleteProject(p.id));
      return steps;
    },
  },
  {
    id: "plan-entity",
    name: "The living Plan — read, write, version conflict (Product Steward Phase 1)",
    desc: "A fresh project's Plan starts empty at version 0; the first write lands at version 1; a second write against the now-stale baseVersion is refused, not silently accepted — no repo needed, the Plan isn't repo-coupled.",
    run: async () => {
      const steps: Step[] = [];
      const name = `UAT: plan entity ${uid()}`;
      await api.createProject({ name, goal: "acceptance" });
      const s = await settle((sn) => sn.projects.some((p) => p.name === name));
      const p = s.projects.find((p2) => p2.name === name)!;

      const fresh = await api.fetchProjectPlan(p.id);
      steps.push(step("a fresh project's Plan starts empty at version 0", fresh.version === 0 && fresh.markdown === ""));

      const v1 = await api.updateProjectPlan(p.id, { markdown: "# UAT plan", baseVersion: 0 });
      steps.push(step("the first write lands at version 1 with the written markdown", v1.version === 1 && v1.markdown === "# UAT plan"));

      let refused = false;
      try {
        await api.updateProjectPlan(p.id, { markdown: "clobber", baseVersion: 0 });
      } catch {
        refused = true;
      }
      steps.push(step("a write against the now-stale baseVersion is refused, not silently accepted", refused));

      const v2 = await api.updateProjectPlan(p.id, { markdown: "# v2", baseVersion: v1.version });
      steps.push(step("a write against the CURRENT version succeeds and bumps it again", v2.version === 2 && v2.markdown === "# v2"));

      await swallow(api.deleteProject(p.id));
      return steps;
    },
  },
  {
    id: "task-detail-panel",
    name: "Task Detail panel's own endpoints — trail + subtask accept",
    desc: "A fresh task's transition trail is empty; accepting all (zero) suggested subtasks is a clean no-op; accepting a specific but nonexistent one is refused — control-plane only, no seeded Proposal needed.",
    run: async () => {
      const steps: Step[] = [];
      const name = `UAT: task detail ${uid()}`;
      await api.createProject({ name, goal: "acceptance" });
      let s = await settle((sn) => sn.projects.some((p) => p.name === name));
      const p = s.projects.find((p2) => p2.name === name)!;
      await api.createTask(p.id, "acceptance: subtasks + trail");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;

      const trail = await api.fetchTaskTransitions(task.id);
      steps.push(step("a fresh task's trail is empty", Array.isArray(trail) && trail.length === 0, `${trail.length} transitions`));

      const acceptedAll = await api.acceptAllSubtasks(task.id);
      steps.push(step("accept-all with nothing pending is a clean no-op", Array.isArray(acceptedAll) && acceptedAll.length === 0));

      try {
        await api.acceptSubtask(task.id, "nonexistent-proposal-id");
        steps.push(step("accepting an unknown proposal id is refused", false, "did not throw"));
      } catch (e) {
        const status = e instanceof api.ApiError ? e.status : 0;
        steps.push(step("accepting an unknown proposal id is refused", status === 404, `status ${status}`));
      }

      await swallow(api.deleteProject(p.id));
      return steps;
    },
  },
  {
    id: "activity-feed-undo",
    name: "Activity Feed's pending-actions + undo endpoints",
    desc: "A fresh project has no pending rule actions yet; undoing a nonexistent one is refused — control-plane only, no seeded rule trigger needed.",
    run: async () => {
      const steps: Step[] = [];
      const name = `UAT: activity feed ${uid()}`;
      await api.createProject({ name, goal: "acceptance" });
      const s = await settle((sn) => sn.projects.some((p) => p.name === name));
      const p = s.projects.find((p2) => p2.name === name)!;

      const pending = await api.fetchPendingActions(p.id, { status: "finalized" });
      steps.push(step("pending-actions endpoint returns an array", Array.isArray(pending), `${pending.length} pending`));
      steps.push(step("a fresh project has no pending actions yet", pending.length === 0));

      try {
        await api.undoRuleAction("nonexistent-pending-id");
        steps.push(step("undoing an unknown pending action is refused", false, "did not throw"));
      } catch (e) {
        const status = e instanceof api.ApiError ? e.status : 0;
        steps.push(step("undoing an unknown pending action is refused", status === 404, `status ${status}`));
      }

      await swallow(api.deleteProject(p.id));
      return steps;
    },
  },
  {
    id: "pattern-onboarding-accept-dismiss",
    name: "Pattern-spotted onboarding's accept/dismiss endpoints",
    desc: "Waiting for the real pattern detector to fire needs weeks of genuine manual-move history (by design — see sweepPatternDetection's own doc comment), so this exercises the generic accept/dismiss refusal path against a nonexistent proposal id — control-plane only, no seeded detector trigger needed.",
    run: async () => {
      const steps: Step[] = [];
      const name = `UAT: pattern onboarding ${uid()}`;
      await api.createProject({ name, goal: "acceptance" });
      const s = await settle((sn) => sn.projects.some((p) => p.name === name));
      const p = s.projects.find((p2) => p2.name === name)!;

      try {
        await api.acceptProposal(p.id, "nonexistent-proposal-id");
        steps.push(step("accepting an unknown proposal is refused", false, "did not throw"));
      } catch (e) {
        const status = e instanceof api.ApiError ? e.status : 0;
        steps.push(step("accepting an unknown proposal is refused", status === 404, `status ${status}`));
      }

      try {
        await api.dismissProposal(p.id, "nonexistent-proposal-id");
        steps.push(step("dismissing an unknown proposal is refused", false, "did not throw"));
      } catch (e) {
        const status = e instanceof api.ApiError ? e.status : 0;
        steps.push(step("dismissing an unknown proposal is refused", status === 404, `status ${status}`));
      }

      await swallow(api.deleteProject(p.id));
      return steps;
    },
  },
  {
    id: "hardening-retry-rule-action",
    name: "TASK 13 hardening — retry a rule action",
    desc: "Retrying re-dispatches a rule's CURRENT actions for a task, regardless of prior failure — no seeded failure needed to exercise the endpoint. Confirms a real retry moves the task, and that retrying an unknown rule/task pair is refused.",
    run: async () => {
      const steps: Step[] = [];
      const name = `UAT: retry action ${uid()}`;
      await api.createProject({ name, goal: "acceptance" });
      let s = await settle((sn) => sn.projects.some((p) => p.name === name));
      const p = s.projects.find((p2) => p2.name === name)!;

      await api.createTask(p.id, "acceptance: retry target");
      s = await settle((sn) => sn.tasks.some((t) => t.projectId === p.id));
      const task = s.tasks.find((t) => t.projectId === p.id)!;
      steps.push(step("task created in backlog", task.state === "backlog", task.state));

      const rule = await api.createRule(p.id, {
        name: "Acceptance: backlog -> triage",
        when: "WHEN task state is Backlog THEN move task to Triage",
        conditions: [{ field: "state", op: "state_equals", value: "backlog" }],
        actions: [{ type: "move_task", params: { toState: "triage" } }],
        safety: { announceBeforeActing: false, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
      });

      // retryRuleAction's whole dispatch (applyAction → recordTransition →
      // upsertTask) is one awaited chain server-side, so the Transition it
      // produces already exists by the time this call resolves — no polling.
      await api.retryRuleAction(rule.id, task.id);
      const transitions = await api.fetchTaskTransitions(task.id);
      steps.push(step("retry re-dispatched the rule and moved the task", transitions.some((t) => t.to === "triage" && t.ruleId === rule.id)));

      try {
        await api.retryRuleAction("nonexistent-rule-id", task.id);
        steps.push(step("retrying an unknown rule is refused", false, "did not throw"));
      } catch (e) {
        const status = e instanceof api.ApiError ? e.status : 0;
        steps.push(step("retrying an unknown rule is refused", status === 404, `status ${status}`));
      }

      await swallow(api.deleteProject(p.id));
      return steps;
    },
  },
  {
    id: "rail-graph-pause-all-rules",
    name: "Rail Graph's 'pause rules' bulk endpoint",
    desc: "Creates two live rules and one already-watch rule, confirms pauseAllRules pauses only the two live ones in a single call, and leaves the watch rule untouched.",
    run: async () => {
      const steps: Step[] = [];
      const name = `UAT: pause all rules ${uid()}`;
      await api.createProject({ name, goal: "acceptance" });
      const s = await settle((sn) => sn.projects.some((p) => p.name === name));
      const p = s.projects.find((p2) => p2.name === name)!;

      const ruleBody = (n: number) => ({
        name: `Acceptance rule ${n}`,
        when: "x",
        conditions: [{ field: "state" as const, op: "state_equals", value: "backlog" }],
        actions: [{ type: "move_task", params: { toState: "triage" } }],
      });
      const live1 = await api.createRule(p.id, ruleBody(1));
      const live2 = await api.createRule(p.id, ruleBody(2));
      const watch = await api.createRule(p.id, { ...ruleBody(3), state: "watch" });

      const paused = await api.pauseAllRules(p.id);
      steps.push(step("pauses exactly the 2 live rules, not the watch one", paused.length === 2 && paused.every((r) => r.state === "paused")));
      steps.push(step("the correct rule ids were paused", new Set(paused.map((r) => r.id)).size === 2 && [live1.id, live2.id].every((id) => paused.some((r) => r.id === id))));

      // A second call is a genuine no-op (nothing left in "live" to pause) —
      // confirms this isn't accidentally re-pausing/duplicating on repeat.
      const secondCall = await api.pauseAllRules(p.id);
      steps.push(step("a second call pauses nothing further — no live rules left", secondCall.length === 0));
      void watch; // its id is never in `paused` above — that IS the "left alone" evidence

      await swallow(api.deleteProject(p.id));
      return steps;
    },
  },
  {
    id: "decision-inbox-fetch",
    name: "Decision Inbox — GET /api/decisions",
    desc: "Confirms the cross-project decisions endpoint returns an array of only-open items, and — when a gate happens to already be open — that it's joined with the correct project fields.",
    run: async () => {
      const steps: Step[] = [];
      // Same keyless constraint as hitl-audit above: this suite can't spawn a
      // real agent to RAISE a gate, so it can only exercise the join/shape
      // when one already happens to be open.
      const decisions = await api.fetchDecisions();
      steps.push(step("returns an array", Array.isArray(decisions)));
      steps.push(step("every item is open — resolved ones don't leak through", decisions.every((d) => d.resolution === null)));
      const open = decisions[0];
      if (!open) {
        steps.push(skipped("an open decision to check the project/task join on", "none open (keyless) — the self-contained version needs a real agent-raised gate"));
        return steps;
      }
      steps.push(step("joined with a real projectName", typeof open.projectName === "string" && open.projectName.length > 0));
      steps.push(step("costOfWaiting reflects real idle time", open.costOfWaiting >= 0));
      return steps;
    },
  },
];
