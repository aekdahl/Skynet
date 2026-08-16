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
  // add a second named credential for a provider — needs a real key + the secret
  // store (master key), so no offline journey; the route is guarded server-side
  // and the set/delete-by-id paths it shares ARE journey-covered.
  "createCredential",
  // live-verify a credential against its real vendor API (Anthropic/OpenAI/
  // Google/Cursor/GitHub/OpenRouter) — needs a real key AND makes a genuine
  // outbound call, so it can't run in an offline journey; covered server-side
  // by secrets-verify.test.ts (mocked fetch, both the ok and failing paths).
  "verifyCredential",
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
  // escape hatch — bypasses HUMAN_TRANSITIONS to force a task done; parse +
  // sync-run behavior covered by task-transitions.test.ts (server side).
  // No happy-path journey exercises it because the normal review → done path
  // is the intended path; this is only reached when that path is stuck.
  "forceTaskDone",
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
