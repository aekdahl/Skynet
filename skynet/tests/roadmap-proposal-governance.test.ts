// Phase 25 (TASK 28) — the concurrency/ownership rules that make a shared,
// machine-writable ROADMAP.md safe once more than one agent can propose an
// edit to it, plus real commit attribution for an applied proposal. One
// integration test per rule (Operations + Store + the pure governance
// helpers in apps/server/src/roadmap/proposals.ts, wired together exactly as
// production does), plus a dedicated attribution test that parses the
// actual git commit object rather than trusting the return value.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Agent, DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations, RoadmapProposalNeedsHumanApprovalError } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { sectionRawText, lockedSectionIds, taskBlockedByRoadmapLock } from "../apps/server/src/roadmap/proposals.js";
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

/** Syncs the fixture repo and returns Phase 1's section id + its exact
 *  drafted-against raw text — the baseline every proposal in these tests
 *  targets. */
async function phase1Baseline(ops: Operations) {
  const doc = await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "sha0" });
  const section = doc.sections.find((s) => s.heading === "Phase 1")!;
  const context = sectionRawText(doc.ast, section.id);
  return { doc, sectionId: section.id, context };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-roadmap-gov-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "ROADMAP.md"), ROADMAP);
  git("add", "-A");
  git("commit", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("Rule 1 — one open proposal per section", () => {
  it("a second agent's compatible proposal joins the section's existing open one instead of creating a second row", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);

    const first = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a",
      section: sectionId,
      headline: "Add a note to Phase 1",
      diff: { added: ["- [ ] Added by A"], removed: [], context },
      reasoning: "A's reasoning",
    });
    expect(first.state).toBe("open");

    const second = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-b",
      section: sectionId,
      headline: "Add another note",
      diff: { added: ["- [ ] Added by B"], removed: [], context },
      reasoning: "B's reasoning",
    });

    // Same row amended, not a second proposal.
    expect(second.id).toBe(first.id);
    const all = await store.listRoadmapProposalsForProject("p1");
    expect(all).toHaveLength(1);
    expect(all[0]!.diff.added).toEqual(expect.arrayContaining(["- [ ] Added by A", "- [ ] Added by B"]));
    expect(all[0]!.agentId).toBe("agent-a"); // original proposer retained
    expect(all[0]!.reasoning).toContain("agent-b");
    expect(all[0]!.state).toBe("open");
  });
});

describe("Rule 2 — deletions and date-moves always need a human", () => {
  it("a diff that removes a line is refused for an autonomous apply at ANY detent, including Unattended — checked before autonomy is even read", async () => {
    // approvalLevel "full" + autonomy true composes to the "unattended" detent
    // (packages/shared/src/autonomy.ts's detentFor) — the ONE notch where an
    // agent's own diff otherwise auto-merges with no human at all.
    const { store, ops } = await setup({ autonomy: true, approvalLevel: "full" });
    const { sectionId, context } = await phase1Baseline(ops);

    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a",
      section: sectionId,
      headline: "Remove First item",
      diff: { added: [], removed: ["- [ ] First item"], context },
      reasoning: "no longer needed",
    });

    // No operatorId = an autonomous/system attempt — refused unconditionally,
    // even though this project sits at Unattended.
    await expect(ops.applyRoadmapProposal(DEFAULT_WORKSPACE, "p1", proposal.id, {})).rejects.toThrow(RoadmapProposalNeedsHumanApprovalError);
    const stillOpen = await store.getRoadmapProposal(proposal.id);
    expect(stillOpen?.state).toBe("open");
    expect(readFileSync(join(repo, "ROADMAP.md"), "utf8")).toContain("First item"); // never committed

    // An explicit human approval, though, is exactly the routing this rule
    // demands — and it succeeds.
    const result = await ops.applyRoadmapProposal(DEFAULT_WORKSPACE, "p1", proposal.id, { operatorId: "jordan" });
    expect(result.committed).toBe(true);
    expect(result.proposal.state).toBe("approved");
    expect(readFileSync(join(repo, "ROADMAP.md"), "utf8")).not.toContain("First item");
  });

  it("a diff that touches a promised date is refused the same way, even for a plain content addition", async () => {
    const { store, ops } = await setup({ autonomy: true, approvalLevel: "full" });
    const { sectionId, context } = await phase1Baseline(ops);

    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a",
      section: sectionId,
      headline: "Add a promised date",
      diff: { added: ["- [ ] Ship by 2026-12-01"], removed: [], context },
      reasoning: "committing to a date",
    });

    await expect(ops.applyRoadmapProposal(DEFAULT_WORKSPACE, "p1", proposal.id, {})).rejects.toThrow(RoadmapProposalNeedsHumanApprovalError);
    expect((await store.getRoadmapProposal(proposal.id))?.state).toBe("open");
  });
});

describe("Rule 3 — the repo wins", () => {
  it("a human's direct repo edit supersedes an open proposal targeting the same section, on the next re-parse", async () => {
    const { store, ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);

    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a",
      section: sectionId,
      headline: "Add a note",
      diff: { added: ["- [ ] Added by A"], removed: [], context },
      reasoning: "worth tracking",
    });
    expect(proposal.state).toBe("open");

    // A human edits Phase 1 directly and pushes — the exact trigger TASK 27's
    // push-webhook handler resolves to a syncProjectRoadmap call.
    writeFileSync(join(repo, "ROADMAP.md"), ROADMAP.replace("First item", "First item (renamed by a human)"));
    git("add", "-A");
    git("commit", "-m", "human edit");
    await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "sha-human" });

    const superseded = await store.getRoadmapProposal(proposal.id);
    expect(superseded?.state).toBe("superseded");

    // A re-parse that DOESN'T touch Phase 1 at all must leave an otherwise
    // still-open proposal alone — supersede is targeted, not a blanket wipe.
    const second = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-b",
      section: sectionId,
      headline: "Another Phase 1 note",
      diff: { added: ["- [ ] Added by B"], removed: [], context: sectionRawText((await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "sha-human2" })).ast, sectionId) },
      reasoning: "...",
    });
    writeFileSync(join(repo, "ROADMAP.md"), readFileSync(join(repo, "ROADMAP.md"), "utf8") + "\n<!-- unrelated trailing comment -->\n");
    git("add", "-A");
    git("commit", "-m", "unrelated trailing edit");
    await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "sha-human3" });
    expect((await store.getRoadmapProposal(second.id))?.state).toBe("open");
  });
});

describe("Rule 4 — contradictory proposals held", () => {
  it("two incompatible proposals for the same section are both held for a human, cross-linked, and lock further roadmap-tied work on that section", async () => {
    const { store, ops } = await setup();
    const { doc, sectionId, context } = await phase1Baseline(ops);

    const a = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a",
      section: sectionId,
      headline: "Drop First item, add X",
      diff: { added: ["- [ ] X"], removed: ["- [ ] First item"], context },
      reasoning: "X supersedes it",
    });
    expect(a.state).toBe("open"); // pre-conflict snapshot — refetched below

    const b = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-b",
      section: sectionId,
      headline: "Drop First item, add Y instead (conflicts with A's proposal)",
      diff: { added: ["- [ ] Y"], removed: ["- [ ] First item"], context },
      reasoning: "Y is the right call, not X",
    });

    const freshA = await store.getRoadmapProposal(a.id);
    expect(freshA?.state).toBe("held_conflict");
    expect(b.state).toBe("held_conflict");
    expect(freshA?.conflictsWith).toContain(b.id);
    expect(b.conflictsWith).toContain(a.id);
    // Still exactly two rows — Rule 4 forks instead of ever silently merging
    // an incompatible pair into one.
    expect(await store.listRoadmapProposalsForProject("p1")).toHaveLength(2);

    // The lightweight lock: derive it exactly as the orchestrator's auto-pick
    // filter does, and confirm a task linked (via a roadmap line's taskIds)
    // to the locked section reads as blocked, while an unrelated task doesn't.
    const lineId = doc.ast.find((n) => n.type === "checklistItem" && n.text === "First item")!.id;
    const lockedDoc = {
      ...doc,
      ast: doc.ast.map((n) => (n.type === "checklistItem" && n.id === lineId ? { ...n, taskIds: ["t1"] } : n)),
    };
    await store.putRoadmapDoc(lockedDoc);

    const held = await store.listRoadmapProposalsForProject("p1", { state: "held_conflict" });
    const locked = lockedSectionIds(held);
    expect(locked.has(sectionId)).toBe(true);
    expect(taskBlockedByRoadmapLock(lockedDoc, locked, "t1")).toBe(true);
    expect(taskBlockedByRoadmapLock(lockedDoc, locked, "unrelated-task")).toBe(false);

    // A third agent proposing against the now-locked section is queued, not
    // given a third proposal row.
    const c = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a", // reusing an existing agent id — a distinct one isn't needed for this check
      section: sectionId,
      headline: "Yet another Phase 1 change",
      diff: { added: ["- [ ] Z"], removed: [], context },
      reasoning: "...",
    });
    expect(c.state).toBe("held_conflict");
    expect(await store.listRoadmapProposalsForProject("p1")).toHaveLength(2); // still 2 — queued, not a 3rd row
  });
});

describe("Commit attribution (TASK 28)", () => {
  it("an approved proposal's commit has the approving human as AUTHOR and the proposing agent as a Co-authored-by trailer — verified by parsing the real git commit object", async () => {
    const { ops } = await setup();
    const { sectionId, context } = await phase1Baseline(ops);

    const proposal = await ops.proposeRoadmapChange(DEFAULT_WORKSPACE, "p1", {
      agentId: "agent-a",
      section: sectionId,
      headline: "Add a note to Phase 1",
      diff: { added: ["- [ ] Added by A"], removed: [], context },
      reasoning: "worth tracking",
    });

    const result = await ops.applyRoadmapProposal(DEFAULT_WORKSPACE, "p1", proposal.id, { operatorId: "jordan" });
    expect(result.committed).toBe(true);
    expect(result.sha).toBeTruthy();

    // Parse the ACTUAL git commit object rather than trusting the return value.
    const raw = git("cat-file", "commit", result.sha!);
    const authorLine = raw.split("\n").find((l) => l.startsWith("author "))!;
    expect(authorLine).toContain("jordan <jordan@operators.skynet.local>");

    // Committer stays the Skynet service identity — only AUTHOR reflects the
    // approving human (see local-repo-write.ts's own doc comment on why).
    const committerLine = raw.split("\n").find((l) => l.startsWith("committer "))!;
    expect(committerLine).toContain("Skynet <skynet@local>");

    // A well-formed Co-authored-by trailer for the proposing agent.
    expect(raw).toContain("Co-authored-by: Agent A <agent-a@agents.skynet.local>");

    // And the file on disk actually carries the change.
    expect(readFileSync(join(repo, "ROADMAP.md"), "utf8")).toContain("Added by A");
  });
});
