// Compliance evidence pack (ROADMAP: one-click signed "AI change report").
// Two layers: report generation (accurate + complete for the requested scope,
// built entirely from the existing AuditRecord trail + Task/TaskRun/Project
// context) and signing (a signature over the exported document, so tampering
// with it after export is detectable — the whole point of an evidentiary
// artifact an auditor might rely on).
//
// The signing module persists a keypair to disk on first use (see
// compliance/signing.ts) — SKYNET_COMPLIANCE_KEY_PATH is pointed at a
// throwaway temp file here (config is read once at import time) so the suite
// never writes a real key file into the repo, and everything server-side is
// imported dynamically AFTER that env var is set.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { AuditRecord, Project, ServerEvent, Task, TaskRun } from "@skynet/shared";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let buildComplianceReport: typeof import("../apps/server/src/compliance/report.js").buildComplianceReport;
let canonicalJson: typeof import("../apps/server/src/compliance/signing.js").canonicalJson;
let getSigningKeypair: typeof import("../apps/server/src/compliance/signing.js").getSigningKeypair;
let signComplianceReport: typeof import("../apps/server/src/compliance/signing.js").signComplianceReport;
let verifyComplianceReport: typeof import("../apps/server/src/compliance/signing.js").verifyComplianceReport;
let generateSignedComplianceReport: typeof import("../apps/server/src/compliance/index.js").generateSignedComplianceReport;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;

let keyDir: string;

beforeAll(async () => {
  keyDir = mkdtempSync(join(tmpdir(), "skynet-compliance-key-"));
  process.env.SKYNET_COMPLIANCE_KEY_PATH = join(keyDir, "signing-key.json");
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
  ({ buildComplianceReport } = await import("../apps/server/src/compliance/report.js"));
  ({ canonicalJson, getSigningKeypair, signComplianceReport, verifyComplianceReport } = await import(
    "../apps/server/src/compliance/signing.js"
  ));
  ({ generateSignedComplianceReport } = await import("../apps/server/src/compliance/index.js"));
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
});
afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}
const nullProvider: RunnerProvider = {
  id: "claude",
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: "claude", async pause() {}, async resume() {}, async message() {}, async stop() {} };
  },
};

const mkProject = (id: string, name: string): Project =>
  ({ id, workspaceId: DEFAULT_WORKSPACE, name, goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false, repo: null } as Project);
const mkRun = (id: string, projectId: string, branch: string): TaskRun =>
  ({
    id, workspaceId: DEFAULT_WORKSPACE, projectId, name: `run ${id}`, status: "done", agentId: "a1", provider: "claude",
    credentialId: null, model: "opus-4.8", branch, modules: [], progress: 1, plan: [], usage: null, modifiedFiles: [],
    log: [], startedAt: 0, lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
    branchFromStep: null, archived: false, pr: null,
  } as TaskRun);
const mkTask = (id: string, projectId: string, runId: string, text: string, reviewVerdict: Task["reviewVerdict"] = null): Task =>
  ({ id, workspaceId: DEFAULT_WORKSPACE, projectId, text, state: "done", runId, featureId: null, reviewVerdict } as Task);

const diffPayload = (over: Record<string, unknown> = {}) => ({
  kind: "diff",
  title: "Review diff — 10+/2− (2 files)",
  why: "Finished on agent/x — 10+/2− across 2 file(s).",
  risk: "medium",
  diff: { add: 10, del: 2, files: ["a.ts", "b.ts"] },
  files: ["a.ts", "b.ts"],
  guidance: null,
  rationale: null,
  ...over,
});

const mkAudit = (over: Partial<AuditRecord> & Pick<AuditRecord, "hitlId" | "runId" | "operatorId" | "at">): AuditRecord => ({
  workspaceId: DEFAULT_WORKSPACE,
  action: "approve",
  payload: diffPayload(),
  ...over,
});

describe("Compliance evidence pack — report generation", () => {
  let store: InstanceType<typeof MemoryStore>;

  beforeEach(async () => {
    store = new MemoryStore({ seed: false });
    await store.putProject(mkProject("p1", "Payments"));
    await store.putProject(mkProject("p2", "Onboarding"));
    await store.putRun(mkRun("r-human", "p1", "agent/human"));
    await store.putRun(mkRun("r-policy", "p1", "agent/policy"));
    await store.putRun(mkRun("r-agent", "p2", "agent/reviewed"));
    await store.putRun(mkRun("r-rejected", "p1", "agent/rejected"));
    await store.putTask(mkTask("t-human", "p1", "r-human", "Fix billing bug"));
    await store.putTask(mkTask("t-policy", "p1", "r-policy", "Bump a dep"));
    await store.putTask(
      mkTask("t-agent", "p2", "r-agent", "Add onboarding step", { decision: "approve", reason: "tests pass, matches the task", by: "reviewer-bot", at: 2000 }),
    );
    await store.putTask(mkTask("t-rejected", "p1", "r-rejected", "Risky rewrite"));

    // Human-approved diff.
    await store.recordAudit(mkAudit({ hitlId: "h1", runId: "r-human", operatorId: "alex", at: 1000 }));
    // Policy-auto-approved diff (full-autonomy style).
    await store.recordAudit(mkAudit({ hitlId: "h2", runId: "r-policy", operatorId: "policy:full-autonomy", at: 1500, payload: diffPayload({ risk: "low" }) }));
    // Agent-review-approved diff — operatorId is the generic "autonomy" marker;
    // the real reviewer + reason live on the task's reviewVerdict.
    await store.recordAudit(mkAudit({ hitlId: "h3", runId: "r-agent", operatorId: "autonomy", at: 2000, payload: diffPayload({ risk: "high" }) }));
    // A REJECTED diff — never merged, must NOT appear as an "AI-authored change".
    await store.recordAudit(mkAudit({ hitlId: "h4", runId: "r-rejected", operatorId: "alex", at: 2500, action: "reject" }));
    // An unrelated command APPROVAL — not a diff/merge, must NOT appear either.
    await store.recordAudit(
      mkAudit({ hitlId: "h5", runId: "r-human", operatorId: "alex", at: 2600, payload: { kind: "approval", command: "npm test", title: "Run tests", why: "..." } }),
    );
  });

  it("includes only approved diff/merge decisions — excludes rejections and command approvals", async () => {
    const report = await buildComplianceReport(store, { workspaceId: DEFAULT_WORKSPACE, generatedBy: "op1", scope: {} });
    expect(report.entries.map((e) => e.hitlId).sort()).toEqual(["h1", "h2", "h3"]);
    expect(report.summary.totalChanges).toBe(3);
  });

  it("classifies each approver correctly and attributes agent-review to the real reviewer", async () => {
    const report = await buildComplianceReport(store, { workspaceId: DEFAULT_WORKSPACE, generatedBy: "op1", scope: {} });
    const byId = new Map(report.entries.map((e) => [e.hitlId, e]));

    const human = byId.get("h1")!;
    expect(human.approverType).toBe("human");
    expect(human.approvedBy).toBe("alex");
    expect(human.policyDetail).toBeNull();

    const policy = byId.get("h2")!;
    expect(policy.approverType).toBe("policy");
    expect(policy.approvedBy).toBe("policy:full-autonomy");
    expect(policy.policyDetail).toBe("policy:full-autonomy");

    const agentReview = byId.get("h3")!;
    expect(agentReview.approverType).toBe("agent-review");
    expect(agentReview.approvedBy).toBe("autonomy"); // the raw audit record — not informative alone
    expect(agentReview.policyDetail).toContain("reviewer-bot"); // resolved from Task.reviewVerdict
    expect(agentReview.reason).toBe("tests pass, matches the task");
  });

  it("carries project/task/branch/diff context alongside each entry", async () => {
    const report = await buildComplianceReport(store, { workspaceId: DEFAULT_WORKSPACE, generatedBy: "op1", scope: {} });
    const h1 = report.entries.find((e) => e.hitlId === "h1")!;
    expect(h1.projectId).toBe("p1");
    expect(h1.projectName).toBe("Payments");
    expect(h1.taskId).toBe("t-human");
    expect(h1.taskText).toBe("Fix billing bug");
    expect(h1.branch).toBe("agent/human");
    expect(h1.diffAdd).toBe(10);
    expect(h1.diffDel).toBe(2);
    expect(h1.diffFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("scopes to a single project", async () => {
    const report = await buildComplianceReport(store, { workspaceId: DEFAULT_WORKSPACE, generatedBy: "op1", scope: { projectId: "p2" } });
    expect(report.entries.map((e) => e.hitlId)).toEqual(["h3"]);
    expect(report.scope.projectId).toBe("p2");
    expect(report.scope.projectName).toBe("Onboarding");
  });

  it("scopes to a date range (inclusive)", async () => {
    const report = await buildComplianceReport(store, { workspaceId: DEFAULT_WORKSPACE, generatedBy: "op1", scope: { from: 1200, to: 1999 } });
    expect(report.entries.map((e) => e.hitlId)).toEqual(["h2"]);
  });

  it("scopes to a single run", async () => {
    const report = await buildComplianceReport(store, { workspaceId: DEFAULT_WORKSPACE, generatedBy: "op1", scope: { runId: "r-policy" } });
    expect(report.entries.map((e) => e.hitlId)).toEqual(["h2"]);
  });

  it("computes summary counts and risk/date bounds correctly", async () => {
    const report = await buildComplianceReport(store, { workspaceId: DEFAULT_WORKSPACE, generatedBy: "op1", scope: {} });
    expect(report.summary).toMatchObject({
      totalChanges: 3,
      humanApproved: 1,
      policyAutoApproved: 1,
      agentReviewApproved: 1,
      highRisk: 1, // h3
      earliestDecisionAt: 1000,
      latestDecisionAt: 2000,
    });
  });

  it("an empty scope (no matching changes) still produces a valid, honest report", async () => {
    const report = await buildComplianceReport(store, { workspaceId: DEFAULT_WORKSPACE, generatedBy: "op1", scope: { projectId: "p1", from: 9_000_000 } });
    expect(report.entries).toEqual([]);
    expect(report.summary.totalChanges).toBe(0);
    expect(report.summary.earliestDecisionAt).toBeNull();
  });
});

describe("Compliance evidence pack — signing", () => {
  it("a freshly signed report verifies as valid", async () => {
    const store = new MemoryStore({ seed: false });
    await store.putProject(mkProject("p1", "Payments"));
    await store.putRun(mkRun("r1", "p1", "agent/x"));
    await store.recordAudit(mkAudit({ hitlId: "h1", runId: "r1", operatorId: "alex", at: 1000 }));

    const signed = await generateSignedComplianceReport(store, DEFAULT_WORKSPACE, "op1", {});
    expect(verifyComplianceReport(signed)).toEqual({ valid: true });
    expect(signed.algorithm).toBe("ed25519");
    expect(signed.publicKey.length).toBeGreaterThan(0);
  });

  it("detects tampering with the report content (hash mismatch)", async () => {
    const store = new MemoryStore({ seed: false });
    await store.putProject(mkProject("p1", "Payments"));
    await store.putRun(mkRun("r1", "p1", "agent/x"));
    await store.recordAudit(mkAudit({ hitlId: "h1", runId: "r1", operatorId: "alex", at: 1000 }));
    const signed = await generateSignedComplianceReport(store, DEFAULT_WORKSPACE, "op1", {});

    const tampered = { ...signed, report: { ...signed.report, entries: [{ ...signed.report.entries[0]!, approvedBy: "someone-else" }] } };
    const result = verifyComplianceReport(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/content hash/i);
  });

  it("detects a forged signature even when the content hash is left consistent", async () => {
    const store = new MemoryStore({ seed: false });
    await store.putProject(mkProject("p1", "Payments"));
    await store.putRun(mkRun("r1", "p1", "agent/x"));
    await store.recordAudit(mkAudit({ hitlId: "h1", runId: "r1", operatorId: "alex", at: 1000 }));
    const signed = await generateSignedComplianceReport(store, DEFAULT_WORKSPACE, "op1", {});

    // Forge: swap in a signature that decodes fine but wasn't produced by the
    // real private key over this content hash.
    const forged = { ...signed, signature: Buffer.from("not-a-real-signature").toString("base64") };
    const result = verifyComplianceReport(forged);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature/i);
  });

  it("canonicalJson is stable regardless of key insertion order", () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it("the signing keypair persists across calls within a process (cached, not regenerated)", () => {
    const first = getSigningKeypair().publicKeyB64;
    const second = getSigningKeypair().publicKeyB64;
    expect(first).toBe(second);
  });

  it("a report signed directly with signComplianceReport verifies the same way", async () => {
    const store = new MemoryStore({ seed: false });
    await store.putProject(mkProject("p1", "Payments"));
    await store.putRun(mkRun("r1", "p1", "agent/x"));
    await store.recordAudit(mkAudit({ hitlId: "h1", runId: "r1", operatorId: "alex", at: 1000 }));
    const report = await buildComplianceReport(store, { workspaceId: DEFAULT_WORKSPACE, generatedBy: "op1", scope: {} });
    const signed = signComplianceReport(report);
    expect(verifyComplianceReport(signed).valid).toBe(true);
  });
});

describe("Compliance evidence pack — Operations wiring", () => {
  let store: InstanceType<typeof MemoryStore>;
  let ops: InstanceType<typeof Operations>;

  beforeEach(() => {
    store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, nullProvider);
    ops = new Operations({ store, hub, orchestrator });
  });

  it("rejects an unknown project scope", async () => {
    await expect(ops.generateComplianceReport(DEFAULT_WORKSPACE, "op1", { projectId: "nope" })).rejects.toThrow(/project/i);
  });

  it("rejects an unknown run scope", async () => {
    await expect(ops.generateComplianceReport(DEFAULT_WORKSPACE, "op1", { runId: "nope" })).rejects.toThrow(/run/i);
  });

  it("refuses a project/run from a different workspace", async () => {
    await store.putProject(mkProject("other-ws-p", "Other"));
    const foreign = await store.getProject("other-ws-p");
    await store.putProject({ ...foreign!, workspaceId: "someone-elses-workspace" });
    await expect(ops.generateComplianceReport(DEFAULT_WORKSPACE, "op1", { projectId: "other-ws-p" })).rejects.toThrow(/project/i);
  });

  it("generates a signed report end-to-end for a valid scope", async () => {
    await store.putProject(mkProject("p1", "Payments"));
    const signed = await ops.generateComplianceReport(DEFAULT_WORKSPACE, "op1", { projectId: "p1" });
    expect(signed.report.generatedBy).toBe("op1");
    expect(signed.report.scope.projectId).toBe("p1");
    expect(verifyComplianceReport(signed).valid).toBe(true);
  });
});
