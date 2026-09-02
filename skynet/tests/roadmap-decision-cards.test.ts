// Phase 27 (TASK 30) — a machine changing the roadmap becomes a governed
// Inbox decision, replacing today's dock-only confirm for anything an agent
// proposes on its own. Reuses TASK 28's fixture pattern (roadmap-proposal-
// governance.test.ts) — same repo/project/agent setup, extended with the
// Inbox/resolve wiring: an agent-initiated proposal raises a `roadmap_edit`
// HITL, "APPROVE & COMMIT" runs the real TASK 28 attribution path (verified
// by parsing the actual git commit object, not the return value), a
// held_conflict pair dismisses the stale card and raises exactly one new
// one, and Rule 3's supersede dismisses its open card too. The operator's
// OWN direct Steward-dock request never reaches proposeRoadmapChange at all
// (a completely separate commit path — updateProjectRoadmap) — confirmed
// here as "no roadmap_edit HITL from that path", not re-derived by an actor
// check inside proposeRoadmapChange itself.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Agent, DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations, RoadmapProposalNotOpenError } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { sectionRawText } from "../apps/server/src/roadmap/proposals.js";
import { contentHash } from "../apps/server/src/steward/docs.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
const provider = {} as RunnerProvider;

const ROADMAP = `# Roadmap

## Phase 1

- [ ] First item
- [ ] Second item

## Phase 2

- [ ] Third item
`;

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", repoPath: repo, gitBacked: true, repo: "acme/app", syncSourceStatus: true, roadmapPath: null,
    autonomy: true, approvalLevel: "trusted",
    ...over,
  }) as Project;

async function setup(projectOver: Partial<Project> = {}) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(mkProject(projectOver));
  await store.putAgent(Agent.parse({ id: "agent-a", workspaceId: DEFAULT_WORKSPACE, name: "Agent A", provider: "claude", model: "sonnet", status: "idle" }));
  await store.putAgent(Agent.parse({ id: "agent-b", workspaceId: DEFAULT_WORKSPACE, name: "Agent B", provider: "claude", model: "sonnet", status: "idle" }));
  return { store, ops };
}

async function phase1Baseline(ops: Operations) {
  const doc = await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "sha0" });
  const section = doc.sections.find((s) => s.heading === "Phase 1")!;
  const context = sectionRawText(doc.ast, section.id);
  return { doc, sectionId: section.id, context };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-roadmap-cards-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "ROADMAP.md"), ROADMAP);
  git("add", "-A");
  git("commit", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("Inbox integration — an agent-initiated proposal is a governed decision", () => {
  it("raises a roadmap_edit HITL that appears in listDecisions, with a real projectId + roadmapProposalId (no run behind it)", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);

    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a",
      section: sectionId,
      headline: "Add a note to Phase 1",
      diff: { added: ["- [ ] Added by A"], removed: [], context },
      reasoning: "worth tracking",
    });

    const queue = await store.listQueue(DEFAULT_WORKSPACE);
    const item = queue.find((q) => q.kind === "roadmap_edit" && q.roadmapProposalId === proposal.id);
    expect(item).toBeTruthy();
    expect(item?.projectId).toBe("p1");
    expect(item?.resolvedAt).toBeNull();
    expect(item?.title).toBe("Add a note to Phase 1");

    const decisions = await ops.listDecisions(DEFAULT_WORKSPACE);
    const decision = decisions.find((d) => d.id === item!.id);
    expect(decision).toBeTruthy();
    expect(decision?.projectId).toBe("p1");
    expect(decision?.projectName).toBe("P");
  });

  it("'APPROVE & COMMIT' (resolveHitl approve) actually commits via TASK 28's attribution path — verified by parsing the real git commit object", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);

    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a",
      section: sectionId,
      headline: "Add a note to Phase 1",
      diff: { added: ["- [ ] Added by A"], removed: [], context },
      reasoning: "worth tracking",
    });
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === proposal.id)!;

    // The SAME generic resolve path every other HITL kind uses — never a
    // dedicated route for the plain case (Operations.resolveHitl branches on
    // kind itself).
    const resolved = await ops.resolveHitl(DEFAULT_WORKSPACE, item.id, { action: "approve" }, "jordan");
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolution?.action).toBe("approve");
    expect(resolved.resolution?.by).toBe("jordan");

    const applied = await store.getRoadmapProposal(proposal.id);
    expect(applied?.state).toBe("approved");

    // Parse the ACTUAL commit object — same discipline as TASK 28's own test.
    const sha = git("rev-parse", "HEAD");
    const raw = git("cat-file", "commit", sha);
    expect(raw.split("\n").find((l) => l.startsWith("author "))).toContain("jordan <jordan@operators.skynet.local>");
    expect(raw).toContain("Co-authored-by: Agent A <agent-a@agents.skynet.local>");
    expect(readFileSync(join(repo, "ROADMAP.md"), "utf8")).toContain("Added by A");

    // Gone from the open decision list.
    expect((await ops.listDecisions(DEFAULT_WORKSPACE)).find((d) => d.id === item.id)).toBeUndefined();
  });

  it("REJECT marks the proposal rejected and resolves the HITL, without touching the repo", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Add a note", diff: { added: ["- [ ] X"], removed: [], context }, reasoning: "r",
    });
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === proposal.id)!;

    const resolved = await ops.resolveHitl(DEFAULT_WORKSPACE, item.id, { action: "reject" }, "jordan");
    expect(resolved.resolution?.action).toBe("reject");
    expect((await store.getRoadmapProposal(proposal.id))?.state).toBe("rejected");
    expect(readFileSync(join(repo, "ROADMAP.md"), "utf8")).not.toContain("- [ ] X");
  });

  it("never routes through Orchestrator.deliver() — approving/rejecting a roadmap_edit item never throws even though its runId is a placeholder matching no real run", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "X", diff: { added: ["- [ ] X"], removed: [], context }, reasoning: "r",
    });
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === proposal.id)!;
    expect(item.runId).toBe(`roadmap:${proposal.id}`);
    expect(await store.getRun(item.runId)).toBeUndefined(); // genuinely no run behind it

    await expect(ops.resolveHitl(DEFAULT_WORKSPACE, item.id, { action: "approve" }, "jordan")).resolves.toBeTruthy();
  });

  it("the operator's OWN direct Steward-dock edit (updateProjectRoadmap) never raises a roadmap_edit HITL — a completely separate path", async () => {
    const { store, ops } = await setup();
    const doc = await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "sha0" });
    await ops.updateProjectRoadmap(DEFAULT_WORKSPACE, "p1", {
      path: doc.path,
      content: doc.raw + "\n- [ ] Added by the operator directly\n",
      baselineHash: contentHash(doc.raw),
    });
    const queue = await store.listQueue(DEFAULT_WORKSPACE);
    expect(queue.filter((q) => q.kind === "roadmap_edit")).toHaveLength(0);
    expect(readFileSync(join(repo, "ROADMAP.md"), "utf8")).toContain("Added by the operator directly");
  });
});

describe("Phase 30 hardening — the Telegram no-approve-button flag matches Rule 2's real scope, not just literal deletions", () => {
  it("a plain single-line deletion (non-conflict) sets has_deletion", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Remove First item",
      diff: { added: [], removed: ["- [ ] First item"], context }, reasoning: "no longer needed",
    });
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === proposal.id)!;
    expect(item.flags).toContain("has_deletion");
    expect(item.risk).toBe("medium");
  });

  it("a multi-line deletion sets has_deletion", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Remove both items",
      diff: { added: [], removed: ["- [ ] First item", "- [ ] Second item"], context }, reasoning: "cutting this scope",
    });
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === proposal.id)!;
    expect(item.flags).toContain("has_deletion");
  });

  it("a date-only ADDITION (no removed lines at all) ALSO sets has_deletion — Rule 2 treats a promised-date touch the same as a deletion, and Telegram must too", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Add a promised date",
      diff: { added: ["- [ ] Ship by 2026-12-01"], removed: [], context }, reasoning: "committing to a date",
    });
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === proposal.id)!;
    expect(item.flags).toContain("has_deletion");
    expect(item.risk).toBe("medium");
  });

  it("a plain addition touching neither a removal nor a date leaves flags empty — regression guard against over-flagging everything", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Add a plain note",
      diff: { added: ["- [ ] Just a note, no date"], removed: [], context }, reasoning: "worth tracking",
    });
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === proposal.id)!;
    expect(item.flags).toEqual([]);
    expect(item.risk).toBe("low");
  });

  it("a held_conflict pair (always carries a deletion per Rule 4's own design) sets has_deletion on its card", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Drop First item, add X",
      diff: { added: ["- [ ] X"], removed: ["- [ ] First item"], context }, reasoning: "X supersedes it",
    });
    const b = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-b", section: sectionId, headline: "Drop First item, add Y instead",
      diff: { added: ["- [ ] Y"], removed: ["- [ ] First item"], context }, reasoning: "Y is the right call",
    });
    expect(b.state).toBe("held_conflict");
    const openItem = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "roadmap_edit" && !q.resolvedAt)!;
    expect(openItem.flags).toContain("has_deletion");
  });
});

describe("Rule 4 conflict card — held_conflict raises exactly one new HITL, dismissing the stale one", () => {
  it("dismisses proposal A's plain open card and raises ONE conflict card when B forces a hold", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);

    const a = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Drop First item, add X",
      diff: { added: ["- [ ] X"], removed: ["- [ ] First item"], context }, reasoning: "X supersedes it",
    });
    const aItem = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === a.id)!;
    expect(aItem.resolvedAt).toBeNull();

    const b = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-b", section: sectionId, headline: "Drop First item, add Y instead",
      diff: { added: ["- [ ] Y"], removed: ["- [ ] First item"], context }, reasoning: "Y is the right call",
    });
    expect(b.state).toBe("held_conflict");

    // A's original card is dismissed — it's no longer a plain "approve this".
    const aItemAfter = await store.getHitl(aItem.id);
    expect(aItemAfter?.resolvedAt).not.toBeNull();
    expect(aItemAfter?.resolution?.action).toBe("dismiss");

    // Exactly ONE open roadmap_edit item for this pair — not two, not zero.
    const openRoadmapItems = (await store.listQueue(DEFAULT_WORKSPACE)).filter((q) => q.kind === "roadmap_edit" && !q.resolvedAt);
    expect(openRoadmapItems).toHaveLength(1);
    expect(openRoadmapItems[0]!.flags).toContain("has_deletion");

    // The live-fetch anchor: fetching it returns the held_conflict proposal,
    // and its conflictsWith resolves the other side — exactly what the web
    // card's own live-fetch does to render both sides of the pair.
    const anchor = await ops.getRoadmapProposal(DEFAULT_WORKSPACE, "p1", openRoadmapItems[0]!.roadmapProposalId!);
    expect(anchor.state).toBe("held_conflict");
    const otherId = anchor.id === a.id ? b.id : a.id;
    expect(anchor.conflictsWith).toContain(otherId);
  });

  it("resolveRoadmapConflict 'choose' applies the picked side (real commit) and rejects the other", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const a = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Drop First item, add X",
      diff: { added: ["- [ ] X"], removed: ["- [ ] First item"], context }, reasoning: "r",
    });
    const b = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-b", section: sectionId, headline: "Drop First item, add Y",
      diff: { added: ["- [ ] Y"], removed: ["- [ ] First item"], context }, reasoning: "r",
    });
    const conflictItem = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "roadmap_edit" && !q.resolvedAt)!;

    const resolved = await ops.resolveRoadmapConflict(DEFAULT_WORKSPACE, conflictItem.id, { action: "choose", chosenProposalId: a.id }, "jordan");
    expect(resolved.resolution?.action).toBe("approve");

    expect((await store.getRoadmapProposal(a.id))?.state).toBe("approved");
    expect((await store.getRoadmapProposal(b.id))?.state).toBe("rejected");
    expect(readFileSync(join(repo, "ROADMAP.md"), "utf8")).toContain("- [ ] X");
    expect(readFileSync(join(repo, "ROADMAP.md"), "utf8")).not.toContain("- [ ] Y");

    const sha = git("rev-parse", "HEAD");
    expect(git("cat-file", "commit", sha)).toContain("jordan <jordan@operators.skynet.local>");
  });

  it("resolveRoadmapConflict 'write_own' rejects both sides and touches nothing in the repo", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const a = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Drop First item, add X",
      diff: { added: ["- [ ] X"], removed: ["- [ ] First item"], context }, reasoning: "r",
    });
    const b = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-b", section: sectionId, headline: "Drop First item, add Y",
      diff: { added: ["- [ ] Y"], removed: ["- [ ] First item"], context }, reasoning: "r",
    });
    const conflictItem = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "roadmap_edit" && !q.resolvedAt)!;
    const shaBefore = git("rev-parse", "HEAD");

    const resolved = await ops.resolveRoadmapConflict(DEFAULT_WORKSPACE, conflictItem.id, { action: "write_own" }, "jordan");
    expect(resolved.resolution?.action).toBe("reject");
    expect((await store.getRoadmapProposal(a.id))?.state).toBe("rejected");
    expect((await store.getRoadmapProposal(b.id))?.state).toBe("rejected");
    expect(git("rev-parse", "HEAD")).toBe(shaBefore); // no new commit
  });

  it("resolveRoadmapConflict refuses a non-held_conflict proposal (RoadmapProposalNotOpenError)", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "X", diff: { added: ["- [ ] X"], removed: [], context }, reasoning: "r",
    });
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === proposal.id)!;
    await expect(
      ops.resolveRoadmapConflict(DEFAULT_WORKSPACE, item.id, { action: "choose", chosenProposalId: proposal.id }, "jordan"),
    ).rejects.toThrow(RoadmapProposalNotOpenError);
  });
});

describe("Rule 3 supersede dismisses its open card too", () => {
  it("a human's direct repo edit that supersedes an open proposal on re-parse also dismisses its roadmap_edit HITL", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);
    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", section: sectionId, headline: "Add a note", diff: { added: ["- [ ] Added by A"], removed: [], context }, reasoning: "r",
    });
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.roadmapProposalId === proposal.id)!;
    expect(item.resolvedAt).toBeNull();

    writeFileSync(join(repo, "ROADMAP.md"), ROADMAP.replace("First item", "First item (renamed by a human)"));
    git("add", "-A");
    git("commit", "-m", "human edit");
    await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "sha-human" });

    expect((await store.getRoadmapProposal(proposal.id))?.state).toBe("superseded");
    const itemAfter = await store.getHitl(item.id);
    expect(itemAfter?.resolvedAt).not.toBeNull();
    expect(itemAfter?.resolution?.action).toBe("dismiss");
  });
});
