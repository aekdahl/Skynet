// Coverage guard: every user-facing client API should be exercised by an in-app
// QA surface (a Simulation journey or an Acceptance check) — OR be explicitly
// allowlisted with a reason. This turns "did we forget to cover the new endpoint?"
// from a manual diff into a failing test. When you add a client fn, you either
// reference it from simulation.ts / acceptance.ts or add it to ALLOW below.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const client = read("../apps/web/src/lib/client.ts");
const exported = [...client.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]!);

// Both QA surfaces import `* as api`, so references read as `api.<name>`.
const surfaces = ["../apps/web/src/lib/simulation.ts", "../apps/web/src/lib/acceptance.ts"]
  .map(read)
  .join("\n");
const referenced = new Set([...surfaces.matchAll(/api\.(\w+)/g)].map((m) => m[1]!));

// Exports NOT expected to have a journey/acceptance check. Keep this SHORT and
// justified — each entry is a deliberate "won't cover here" decision.
const ALLOW = new Set<string>([
  // transport / plumbing
  "connect", // raw WebSocket
  "login", // real email/password → session; journeys use the dev-token path, so there's no offline flow to exercise it
  "fetchEvals", "runEval", "fetchEvalJob", "judgeSimulation", // eval + judge machinery
  // needs a live GitHub remote / OS dialog — can't run offline in a journey
  "browseFolder",
  "startGithubDevice", "pollGithubDevice", "fetchGithubInstallations",
  "fetchGithubInstallationRepos", "connectGithub", "disconnectGithub",
  "fetchGithubOwners", // lists org/user owners for repo creation — needs a live remote
  "fetchGithubRepos", // live repo list for the project-creation picker — needs a live remote
  "cloneProjectRepo", // clones a connected GitHub repo — needs a live remote + token
  "importGithubIssues", // imports a repo's issues as tasks — needs a live GitHub repo + token; the pure write-back mapping is covered by task-sync.test.ts
  "importRepoFile", // imports a repo file's checklist items as tasks — needs a live GitHub repo + token; pure parse/flip covered by checklist.test.ts
  "removeApprovalRule", // revokes a standing approval rule — needs a run that raised + remembered a command gate; no offline journey (covered by approval-policy.test.ts + the server route)
  // destructive bulk variants (the per-record paths ARE covered)
  "archiveAllAudit", "clearAudit",
  // low-value control-plane (runner rename/model tweak)
  "updateAgent",
  // TASK 30 — roadmap_edit decision-card actions. proposeRoadmapChange (the
  // only thing that ever creates a RoadmapProposal) has no agent-facing
  // trigger yet — no MCP tool, no chat action — so no offline journey can
  // produce a proposal for a Simulation/Acceptance click-through to act on.
  // The full server-side round trip (raise → live-fetch → resolve → real
  // commit with attribution, plus the held_conflict choose/write_own path)
  // is covered by tests/roadmap-decision-cards.test.ts instead.
  "fetchRoadmapProposal", "resolveRoadmapConflict",
  // TASK 32 — workspace roadmap roll-up + "create one from the board". Both
  // need a project genuinely bound to a real git repo (scaffold additionally
  // needs one with NO roadmap file yet) — no offline journey has that
  // fixture. The full round trip (access scoping, the dashed no-roadmap row,
  // a real scaffolded+attributed commit, cross-repo milestone grouping) is
  // covered server-side by tests/roadmap-workspace-rollup.test.ts instead.
  "fetchWorkspaceRoadmapRollup", "scaffoldProjectRoadmap",
  // add a second named credential for a provider — needs a real key + the secret
  // store (master key), so no offline journey; the route is guarded server-side
  // and the set/delete-by-id paths it shares ARE journey-covered.
  "createCredential",
  // credential lifecycle log (created/rotated/removed) — a read-only Settings/
  // Integrations panel with no state-changing journey step; the underlying
  // record/list behavior is covered server-side by secrets-audit.test.ts and
  // secrets-file-store.test.ts (durability across a restart).
  "fetchSecretAudit",
  // live-verify a credential against its real vendor API (Anthropic/OpenAI/
  // Google/Cursor/GitHub/OpenRouter) — needs a real key AND makes a genuine
  // outbound call, so it can't run in an offline journey; covered server-side
  // by secrets-verify.test.ts (mocked fetch, both the ok and failing paths).
  "verifyCredential",
  // Endpoint smoke test — runs a REAL (if tiny) agent task against a live
  // vendor to prove the endpoint can drive the agent loop. It costs money and
  // needs a working credential, so it can't run in an offline journey; the
  // probe's own result-shaping is covered by endpoint-smoke.test.ts, which
  // scripts a vendor that authenticates but never emits a tool call.
  "smokeTestCredential",
  // Steward execution intents (start_task / queue_tasks / start_feature /
  // process_backlog). These START AGENTS — real runs, real spend — so no
  // offline journey exercises them. Covered server-side end-to-end by
  // execution-intents.test.ts (the resolver's exclusion reasons and the
  // executor through a real Operations + Orchestrator), and the dock/client
  // wiring is pinned by steward-execution-wiring.test.ts.
  "executeStewardAction",
  // Undo a merged run — needs a real git backend and an actually-merged commit,
  // so no offline journey can exercise it. The revert itself is covered against
  // REAL repos in merge.test.ts (revert commit not rewrite, double-revert
  // refused, conflicting revert reported honestly).
  "revertRun",
  // Bench / un-bench a credential. Pausing STOPS live runs and releases their
  // tasks — a fleet-wide, destructive-ish action that needs a real credential
  // and real runs to mean anything, so no offline journey exercises it. The
  // behaviour (halt + release, refuse new work, survive rotation, clear the
  // quota breaker on resume) is covered server-side by credential-pause.test.ts.
  "pauseCredential", "resumeCredential",
  // streaming variant of sendAgentMessage (which IS journey-covered) — same
  // chat surface, just delta-rendered; no separate journey needed.
  "streamAgentMessage",
  // one-click provider CLI installer — spawns a real `npm i -g …` server-side
  // and streams the output; not runnable in an offline journey. The runner
  // + fixed-command guarantees are covered by provider-install.test.ts.
  "streamInstallProvider",
  // live preview (Phase-1 v0) — spawns a real dev server + iframes it; a
  // stateful UI control surface with no offline journey (needs a repo + toolchain).
  "previewStatus", "previewStart", "previewStop", "previewRestart", "previewRefresh",
  // per-run "Preview this change" (docs/live-preview.md) — same stateful,
  // real-dev-server control surface as the project preview above, just keyed
  // to a run's own branch; no offline journey exercises it either. The
  // Operations wrapper is covered by preview-run-ops.test.ts; the underlying
  // manager's startRun/restartRun/stop by deep-review.test.ts and
  // breaker-review.test.ts.
  "previewRunStatus", "previewRunStart", "previewRunStop", "previewRunRestart",
  // Deploy to Fly.io — a REAL, persistent deployment (docs/live-preview.md);
  // needs a real Fly.io account, network, and the flyctl binary, so no offline
  // journey can exercise it. The descriptor/app-naming/collision-retry logic is
  // unit-tested (fly-descriptor.test.ts) and the manager's full orchestration is
  // exercised end-to-end against a real git repo + a fake flyctl binary
  // (fly-deploy-static.test.ts); the credential round-trip is covered by
  // credentials.test.ts and the live-verify call by secrets-verify.test.ts.
  "flyDeployStatus", "flyDeployStart", "flyDeployStop",
  "flyDeployRunStatus", "flyDeployRunStart", "flyDeployRunStop",
  // auth primitive (POST /api/auth/login) — the local/desktop build runs
  // open-auth (dev tokens), so no fleet journey signs in; auth is guarded by
  // auth-hardening.test.ts, not an operator journey.
  "login",
  // read-only doc render for the Roadmap page — no operator journey to exercise
  "fetchRoadmap",
  // global Steward dock chat (workspace-wide / focused-project) — needs a live
  // provider key + a real repo to ground against, so no offline journey exercises
  // it; the project-chat parse contract is covered by project-assistant.test.ts.
  "stewardChat",
  "streamStewardChat", // streaming variant of stewardChat — same live-key requirement
  // S5 "crystallize" — turns a Steward conversation into a draft SolutionBrief
  // via one real LLM call; same live-provider-key requirement as stewardChat
  // above, so no offline journey exercises it. The retry/parse contract and
  // the full Operations path (a real store, a real created brief, the
  // no-brief-on-failure guarantee) are covered with a stubbed model reply in
  // crystallize-brief.test.ts; the HTTP route (body validation, 400/422
  // mapping) in crystallize-brief-routes.test.ts.
  "crystallizeBrief",
  // Draft a Project Charter from the operator's raw goal (Gate G-1, new-project
  // creation) — a real LLM call on the workspace's own key, same "needs a live
  // provider" shape as stewardChat above; no offline journey drafts one.
  "draftCharter",
  // Steward-driven board tidy (priority-sort every non-done column + archive
  // Done) — one real LLM call per column on the workspace's own key, same
  // "needs a live provider" shape as stewardChat/crystallizeBrief/draftCharter
  // above; no offline journey exercises it. The full Operations path (reorder
  // via an injected reply, archive-Done, degrade-to-unchanged on an unreadable
  // reply, the one retry, and repairing a reply that drops/duplicates/invents
  // ids) is exercised with a stubbed `organizeAsk` in organize-board.test.ts.
  "organizeBoard",
  // auth handshake — needs live operator credentials + a session token exchange,
  // so it can't run in an offline journey (the login screen exercises it live)
  "login",
  // MFA challenge exchange (POST /api/auth/mfa) — an auth primitive like `login`;
  // needs a live challenge id + code, so no offline journey exercises it (the
  // login screen drives it live).
  "verifyMfa",
  // desktop Advanced settings (env editor + engine restart) — a desktop-only
  // control-plane surface with no in-app operator journey
  "fetchEnvSettings", "saveEnvSettings", "restartEngine",
  // workspace fleet policy (auto-scale + cap) — a settings control-plane surface
  // covered server-side by fleet-autoscale.test.ts + mcp.test.ts; no offline
  // operator journey drives the Settings toggle.
  "fetchWorkspaceSettings", "updateWorkspaceSettings",
  // command policy (versioned, per-workspace command-safety classifier) — a
  // settings control-plane surface like the fleet policy above; covered
  // server-side by command-policy.test.ts (default/override/dry-run/versioning).
  // No offline operator journey edits the Settings rule editor.
  "fetchCommandPolicy", "fetchCommandPolicyVersions", "dryRunCommandPolicy", "saveCommandPolicyVersion",
  // escape hatch — bypasses HUMAN_TRANSITIONS to force a task done; parse +
  // sync-run behavior covered by task-transitions.test.ts (server side).
  // No happy-path journey exercises it because the normal review → done path
  // is the intended path; this is only reached when that path is stuck.
  "forceTaskDone",
  // manual "Request review" — needs a genuinely idle, review-eligible SECOND
  // agent to exist at the moment it's called; no offline journey shape
  // reproduces that fleet state. Full success/failure-mode coverage (already
  // reviewed / no open gate / no reviewer free) is server-side in
  // request-review.test.ts, driving the real Orchestrator/Operations.
  "requestReview",
  // manual "Re-triage" — needs a task genuinely parked in `triage` plus an
  // idle agent at the moment it's called; no offline journey shape reproduces
  // that fleet state. Full success/failure-mode coverage (clear/unclear
  // outcomes, not-in-triage, no idle agent) is server-side in
  // request-retriage.test.ts, driving the real Orchestrator/Operations.
  "requestRetriage",
  // manual "Force to review" — needs a genuinely live, still-`ongoing` run at
  // the moment it's called; no offline journey shape reproduces that fleet
  // state. Full success/failure-mode coverage (commits + stops + raises a
  // real diff review, not-ongoing, nothing-changed-yet) is server-side in
  // force-review.test.ts, driving the real Orchestrator/Operations against a
  // real throwaway git repo.
  "forceReview",
  // manual "Switch agent" — needs a genuinely live, still-`ongoing` run PLUS a
  // second idle agent to switch to at the moment it's called; no offline
  // journey shape reproduces that fleet state. Full success/failure-mode
  // coverage (stops + resumes on the target agent in the SAME worktree,
  // target busy/missing, not-ongoing) is server-side in
  // reassign-task-agent.test.ts, driving the real Orchestrator/Operations
  // against a real throwaway git repo.
  "reassignTaskAgent",
  // manual "Re-sync" — needs a real GitHub-bound project + a live GitHub API,
  // so no offline journey exercises it. Full pull/push behavior (new issues,
  // drifted title/description, new checklist items, push-drift with sync on/
  // off) is server-side in resync-source.test.ts, driving the real Operations
  // with a stubbed GitHub service.
  "resyncProjectSource",
  // Feature + milestone CRUD (task grouping + roadmap) — exercised by the
  // features-and-roadmap tests (features-roadmap.test.ts) which drive the
  // full Operations path with real store + hub. No fleet journey shape uses
  // them yet (there's no run started by "create a feature"), so they're
  // allowlisted here rather than dropped into a Simulation journey.
  "createFeature", "updateFeature", "deleteFeature",
  "createMilestone", "updateMilestone", "deleteMilestone",
  // Ready-to-merge PR actions — exercised by ready-merge.test.ts against the real
  // Operations/Orchestrator path (with a stub GitHub service). No end-to-end
  // fleet journey opens a real PR, so they're allowlisted rather than simulated.
  "mergePr", "updatePrBranch", "reworkPr", "dismissPr",
  // Feature-scoped branch batching's aggregate PR (one per completed Feature,
  // not per task) — same stub-GitHub Operations/Orchestrator harness, in
  // ready-merge.test.ts's "feature-scoped batches" suite; the underlying
  // git-merge tiers (task → feature branch → project base) are covered end to
  // end with real repos in merge.test.ts. No fleet journey completes an entire
  // multi-task feature batch, so allowlisted like the per-run actions above.
  "mergeFeaturePr", "dismissFeaturePr",
  // Live GitHub check-run status for the ready-to-merge card — a real API call
  // the card makes on mount, not a state-changing action a journey would drive.
  // Covered server-side by ready-merge.test.ts's prChecksForRun/ForFeature tests.
  "fetchPrChecks", "fetchFeaturePrChecks",
  // Review & Merge's READY TO MERGE panel — a real API call the screen makes
  // on mount, not a state-changing action a journey would drive. Covered
  // server-side by merge-queue.test.ts's Orchestrator.mergeQueueSnapshot tests
  // (real approvals through a real merge queue) and merge.test.ts's
  // MergeEngine.queueFor test (the underlying position bookkeeping).
  "fetchMergeQueue",
  // Checkpoint / snapshot-restore — creates a real git commit + pinned ref and,
  // on restore, stops the live handle and relaunches the provider with a
  // resumed SDK session. No offline journey can exercise the worktree
  // rewind + provider relaunch; verified manually against a live run (real
  // dev server + repo, confirmed the worktree actually rewinds to the
  // checkpoint's sha) — see the PR that landed this for the full trace.
  "createCheckpoint", "fetchCheckpoints", "restoreCheckpoint",
  // Task linter v0 (assistive) — dismisses a lint hint produced by a background
  // LLM consult (task-linter.ts). The consult itself needs a live provider key
  // (no offline journey can produce a real hint to dismiss); the Operations
  // wiring — background lint on create/edit, clear-on-relint, dismiss —  is
  // exercised against a real store + hub in task-linter-ops.test.ts, and the
  // model's structured-output parsing in task-linter.test.ts.
  "dismissTaskLint",
  // Compliance evidence pack (ROADMAP: one-click signed "AI change report") —
  // needs real resolved HITL history + a live server-side Ed25519 signing key
  // to produce anything meaningful; no offline journey can synthesize an
  // audit trail worth exporting. Report generation, scoping (project/run/date
  // range), approver classification, and signature tamper-detection are all
  // exercised server-side against a real Store in compliance-report.test.ts;
  // verified manually against a live run's real audit trail (see the PR that
  // landed this for the trace).
  "fetchComplianceReport",
  // Viewer-role session plumbing (fetchMe + the readOnly flag it derives) —
  // called once at boot (StoreProvider), not from a user action a journey would
  // drive. The role → scopes mapping is covered server-side by
  // operator-seed.test.ts; the REST mutation gate it feeds by
  // viewer-role-routes.test.ts. isReadOnlyPrincipal is a pure predicate over
  // that shape, exercised directly wherever it's used (store.tsx), not via a
  // journey.
  "fetchMe", "setReadOnly", "isReadOnly", "isReadOnlyPrincipal",
  // Time-limited admin promotion (ROADMAP.md) — ADMIN-granted: promoting a
  // viewer needs a real second operator + a real persisted-role check, so no
  // offline journey exercises it (there's no "am I an admin" fixture a
  // journey can assume); covered server-side by admin-promotion.test.ts (the
  // promote route, the persisted-role gate, TTL clamp, an already-elevated
  // viewer can't re-grant). fetchOperators/fetchElevations read the roster
  // and the append-only audit trail those same routes write — no operator
  // journey drives either.
  "fetchOperators", "promoteOperator", "fetchElevations",
  // `inform` — mass-select runs (explicit ids and/or a whole project's live
  // runs) and attach a note that rides each one's next prompt, no extra turn
  // (a third interaction type alongside chat + resolve). Exercising it for
  // real needs a LIVE run on a real provider (a note only means anything once
  // it rides an actual next turn) — no offline journey can produce that. The
  // Operations/Orchestrator wiring (multi-run, project targeting, union
  // dedup, skip-when-not-live) is exercised against a real store + hub in
  // inform.test.ts; the delivery mechanics (Claude's shouldQuery:false, the
  // CLI buffer+prepend) in claude-inform.test.ts / cli-inform.test.ts.
  "informRuns",
  // Project context (meeting notes/emails/pasted or uploaded docs): every
  // mutating call (add/upload/delete) triggers a real LLM condensation pass
  // server-side (steward/context.ts) on the workspace's own provider key —
  // same "needs a live key" shape as stewardChat/crystallizeBrief above, so no
  // offline journey exercises them. listContextEntries is a plain read with no
  // LLM dependency, allowlisted alongside its mutating siblings since a
  // journey has nothing to list without them. The full Operations path (raw
  // entries kept verbatim, condense-on-add/upload/delete, clears to null when
  // the last entry is removed) is exercised with a stubbed model reply in
  // project-context.test.ts; extraction (.txt/.md/unsupported-type) likewise.
  "listContextEntries", "addContextEntry", "uploadContextEntry", "deleteContextEntry", "refreshProjectContext",
  // Triage clarifying questions — answering one needs a task that TRIAGE parked
  // as unclear WITH questions, which only a real LLM triage pass produces; no
  // offline journey can synthesize that state. The full Operations path (append
  // the operator's words without replacing the brief, clear the ask, re-triage,
  // and the refusal when nothing is open) is covered server-side in
  // triage-clarification.test.ts, and the round trip was verified live.
  "answerClarification",
  // Automation Builder (Momentum Rollout Phase 6a, TASK 07) — rule CRUD +
  // live backtest. No offline journey builds/edits a rule (there's no
  // fleet-journey shape for "author an automation"), so these are
  // allowlisted here rather than dropped into a Simulation journey. The full
  // HTTP surface (create/update/delete, backtest against real Transition
  // history, workspace scoping) is exercised directly against a real
  // Fastify app + store in tests/kanban-api-surface.test.ts's "rules CRUD" /
  // "rules/backtest" suites, and the engine semantics they wrap
  // (matchCondition/applyAction, the undo→auto-pause breaker) in
  // tests/rule-engine.test.ts. Verified live end-to-end too: a rule built
  // through the Automation Builder UI matched a real triggered signal and
  // moved the task, and 3 real undos auto-paused it with the live rules
  // list reflecting "Paused" with no reload.
  // createRule is exercised directly by the "hardening-retry-rule-action"
  // acceptance scenario now (TASK 13) — dropped from this list.
  "updateRule", "deleteRule", "backtestRule",
  // Keys & Budget panel (TASK 20) — org-owned governance flag and the panel's
  // direct "+ add pattern" write. No offline journey sets a credential's
  // provenance or hand-adds a standing rule outside the HITL "remember"
  // checkbox flow; both are exercised against a real store + hub in
  // secrets-audit.test.ts's "SecretService orgOwned" suite and
  // approval-rules-ops.test.ts respectively.
  "setCredentialOrgOwned", "addApprovalRule",
  // TASK 23 hardening — the fleet-level depleted-key banner (App.tsx's
  // DepletedKeyBanner) polls this directly on a fixed interval, not from a
  // journey-driven user action. Server-side covered by
  // orchestrator-depleted-keys.test.ts.
  "fetchDepletedKeys",
  // TASK 24 — the command palette's destructive "Pause the whole fleet"
  // action. No offline journey triggers a real fleet-wide kill switch (it
  // stops every run and pauses autonomy workspace-wide); the route/
  // Operations wrapper is covered server-side by fleet-stop-all-route.test.ts,
  // and orchestrator.stopAll itself by orchestrator-stopall.test.ts.
  "stopAllRuns",
  // Phase 26 (TASK 29) — the roadmap doc view's actions that need a REAL
  // local git checkout to mean anything (a real blamed commit to revert, a
  // real commit log to read) — acceptance.ts runs against whatever project
  // state already exists via the live REST API only, with no filesystem
  // access to stand up a throwaway repo the way a server-side vitest test
  // can (see tests/roadmap-blame.test.ts / roadmap-doc-view-routes.test.ts,
  // which do exactly that, real git end to end). fetchProjectRoadmapDoc/
  // fetchRoadmapProposals/applyRoadmapProposal ARE covered by the
  // "roadmap-doc-view" acceptance check above (control-plane shape, no repo
  // needed for those three).
  "claimRoadmapLine", "revertRoadmapLine", "fetchRoadmapHistory",
  // Phase 28 (TASK 31) — the Drift dashboard's two write actions, same "needs
  // a real local git checkout" reasoning as the roadmap-doc-view actions
  // just above: proposeRoadmapChange needs a real fleet agent + section id to
  // mean anything, commitRoadmapLineEdit needs a real commit to verify
  // against. Both exercised end to end (real Fastify app + real repo, real
  // attributed commit parsed back out of the git object) in
  // tests/roadmap-drift.test.ts.
  "proposeRoadmapChange", "commitRoadmapLineEdit",
]);

describe("client API coverage", () => {
  it("every exported client API is exercised by a journey/acceptance check (or allowlisted)", () => {
    const uncovered = exported.filter((n) => !referenced.has(n) && !ALLOW.has(n));
    expect(
      uncovered,
      `Unexercised client APIs — add a Simulation journey / Acceptance check, or allowlist with a reason:\n  ${uncovered.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (every allowlisted name still exists + is still unreferenced)", () => {
    const stale = [...ALLOW].filter((n) => !exported.includes(n) || referenced.has(n));
    expect(stale, `Stale ALLOW entries (now covered or removed) — drop them:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
