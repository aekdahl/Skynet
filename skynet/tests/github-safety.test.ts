// Safety preflight: the guardrails are enforced server-side before any write
// reaches GitHub (docs/github-integration.md §5). This pins each guardrail's
// behavior — an agent/runner can't push around a rule it can't see.
import { describe, it, expect } from "vitest";
import { SAFETY_DEFAULTS, type SafetyPolicy } from "@skynet/shared";
import { evaluateSafety, requiresApproval } from "../apps/server/src/github/safety.js";
import type { PushRequest } from "../apps/server/src/github/types.js";

const push = (over: Partial<PushRequest> = {}): PushRequest => ({
  workspaceId: "cyberdyne",
  agentId: "billing-1",
  repo: "acme/monolith",
  branch: "agent/billing-1",
  baseBranch: "main",
  worktreePath: "/tmp/wt",
  changedFiles: ["api/billing/webhooks.ts"],
  modules: ["api/billing"],
  allowedModules: ["api/billing"],
  force: false,
  title: "Stripe reconciliation",
  body: "",
  ...over,
});

describe("evaluateSafety", () => {
  it("allows a clean PR-style push with all guardrails on", () => {
    expect(evaluateSafety(SAFETY_DEFAULTS, push())).toEqual([]);
  });

  it("blocks a direct write to the default branch when prOnly is on", () => {
    const v = evaluateSafety(SAFETY_DEFAULTS, push({ branch: "main" }));
    expect(v.map((x) => x.rule)).toContain("prOnly");
  });

  it("permits a default-branch write when prOnly is off", () => {
    const policy: SafetyPolicy = { ...SAFETY_DEFAULTS, prOnly: false };
    expect(evaluateSafety(policy, push({ branch: "main" }))).toEqual([]);
  });

  it("blocks a force-push when noForcePush is on", () => {
    const v = evaluateSafety(SAFETY_DEFAULTS, push({ force: true }));
    expect(v.map((x) => x.rule)).toContain("noForcePush");
  });

  it("blocks out-of-scope modules when the allowlist is on", () => {
    const v = evaluateSafety(SAFETY_DEFAULTS, push({ modules: ["api/billing", "api/auth"] }));
    expect(v.map((x) => x.rule)).toContain("moduleAllowlist");
    expect(v[0]?.message).toContain("api/auth");
  });

  it("treats an empty allowlist as unconstrained", () => {
    const v = evaluateSafety(SAFETY_DEFAULTS, push({ allowedModules: [], modules: ["api/auth", "infra/deploy"] }));
    expect(v.map((x) => x.rule)).not.toContain("moduleAllowlist");
  });

  it("reports nothing when every guardrail is off", () => {
    const off: SafetyPolicy = { prOnly: false, noForcePush: false, moduleAllowlist: false, approveBeforePush: false };
    expect(evaluateSafety(off, push({ branch: "main", force: true, modules: ["x"], allowedModules: ["y"] }))).toEqual([]);
  });

  it("accumulates multiple violations at once", () => {
    const v = evaluateSafety(SAFETY_DEFAULTS, push({ branch: "main", force: true, modules: ["nope"], allowedModules: ["api/billing"] }));
    expect(v.map((x) => x.rule).sort()).toEqual(["moduleAllowlist", "noForcePush", "prOnly"]);
  });

  it("requiresApproval reflects the approveBeforePush flag", () => {
    expect(requiresApproval(SAFETY_DEFAULTS)).toBe(true);
    expect(requiresApproval({ ...SAFETY_DEFAULTS, approveBeforePush: false })).toBe(false);
  });
});
