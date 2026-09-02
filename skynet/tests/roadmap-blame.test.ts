// Momentum Rollout Phase 26 (TASK 29) — real git blame/log against a
// throwaway repo (same mkdtemp+execFileSync harness as api-fs-list-route.test.ts),
// not mocked: the porcelain parser and the line-number computation are
// exactly the kind of thing a mock would hide a real bug in.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blameFile, commitMessage } from "../apps/server/src/roadmap/blame.js";
import { roadmapHistory } from "../apps/server/src/roadmap/history.js";
import { classifyBlameEmail, enrichRoadmapDocWithBlame } from "../apps/server/src/roadmap/enrich.js";
import { parseRoadmapAst } from "../apps/server/src/roadmap/ast.js";
import { assignLineIdentity } from "../apps/server/src/roadmap/identity.js";
import type { RoadmapDoc } from "@skynet/shared";

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}
function commit(content: string, author: { name: string; email: string }, message: string, coAuthor?: string): void {
  writeFileSync(join(repo, "ROADMAP.md"), content);
  git("add", "ROADMAP.md");
  const fullMessage = coAuthor ? `${message}\n\nCo-authored-by: ${coAuthor}` : message;
  git("-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-q", "-m", fullMessage);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-roadmap-blame-"));
  execFileSync("git", ["init", "-q", repo]);

  // Line 1 — a human operator's own SOURCE-mode edit (real attribution, per
  // attribution.ts's operatorGitIdentity convention).
  commit("- [ ] Human-typed line\n", { name: "jordan", email: "jordan@operators.skynet.local" }, "roadmap: add line");

  // Line 2 appended — an ORDINARY agent-task commit, no attribution (the
  // flat identity local-repo-write.ts's commitLocalRepoFile always falls
  // back to when no `attribution` is passed).
  commit(
    "- [ ] Human-typed line\n- [ ] Ordinary agent commit, no attribution\n",
    { name: "Skynet", email: "skynet@local" },
    "Skynet: agent task work",
  );

  // Line 3 appended — a roadmap-proposal-apply commit: flat Skynet author
  // (autonomous case is separate — see line 4) but WITH a real
  // Co-authored-by trailer naming the proposing agent (agentCoAuthor's
  // convention, attribution.ts).
  commit(
    "- [ ] Human-typed line\n- [ ] Ordinary agent commit, no attribution\n- [ ] Proposal apply, agent co-author\n",
    { name: "jordan", email: "jordan@operators.skynet.local" },
    "Skynet: roadmap proposal applied",
    "Agent Ada <a1@agents.skynet.local>",
  );

  // Line 4 appended — a fully autonomous apply (AUTONOMOUS_APPLY_IDENTITY).
  commit(
    "- [ ] Human-typed line\n- [ ] Ordinary agent commit, no attribution\n- [ ] Proposal apply, agent co-author\n- [ ] Autonomous apply\n",
    { name: "Skynet Autonomy", email: "autonomy@skynet.local" },
    "Skynet: autonomous roadmap apply",
  );
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("blameFile", () => {
  it("attributes each line to the commit that actually introduced it — a hand-checked blame", async () => {
    const blame = await blameFile(repo, "ROADMAP.md");
    expect(blame.size).toBe(4);
    expect(blame.get(1)!.authorEmail).toBe("jordan@operators.skynet.local");
    expect(blame.get(2)!.authorEmail).toBe("skynet@local");
    // Line 3's commit author is jordan (per commit() above — the PR-apply
    // author identity is the approving human, not the flat Skynet identity;
    // the agent shows up only in the co-author trailer, checked separately).
    expect(blame.get(3)!.authorEmail).toBe("jordan@operators.skynet.local");
    expect(blame.get(4)!.authorEmail).toBe("autonomy@skynet.local");
  });

  it("returns an empty map, never throws, for a path with no history / not a repo", async () => {
    expect((await blameFile(repo, "does-not-exist.md")).size).toBe(0);
    expect((await blameFile("/definitely/not/a/repo", "x.md")).size).toBe(0);
  });
});

describe("commitMessage / Co-authored-by trailer", () => {
  it("the proposal-apply commit's message carries the agent co-author trailer", async () => {
    const blame = await blameFile(repo, "ROADMAP.md");
    const sha = blame.get(3)!.sha;
    const message = await commitMessage(repo, sha);
    expect(message).toContain("Co-authored-by: Agent Ada <a1@agents.skynet.local>");
  });
});

describe("classifyBlameEmail", () => {
  it("an operator email classifies as human, named by operatorId", () => {
    expect(classifyBlameEmail("jordan@operators.skynet.local")).toEqual({ author: "jordan", authorRef: "jordan", isAgent: false });
  });
  it("the autonomy identity classifies as machine", () => {
    expect(classifyBlameEmail("autonomy@skynet.local")).toEqual({ author: "Skynet Autonomy", authorRef: "autonomy", isAgent: true });
  });
  it("an agent co-author-shaped email (if it ever IS the primary author) classifies as that agent", () => {
    expect(classifyBlameEmail("a1@agents.skynet.local")).toEqual({ author: "a1", authorRef: "a1", isAgent: true });
  });
  it("the flat default identity classifies as the generic machine identity", () => {
    expect(classifyBlameEmail("skynet@local")).toEqual({ author: "skynet", authorRef: "skynet", isAgent: true });
  });
});

describe("enrichRoadmapDocWithBlame", () => {
  it("fills author/authorRef/addedAt/blameSha per line, recovering the real agent name from a co-author trailer where one exists", async () => {
    const raw = git("show", "HEAD:ROADMAP.md");
    const ast = assignLineIdentity(parseRoadmapAst(raw), null);
    const doc: RoadmapDoc = {
      workspaceId: "w", projectId: "p", path: "ROADMAP.md", commitSha: git("rev-parse", "HEAD"),
      syncedAt: Date.now(), syncState: "in_sync", raw, ast, sections: [],
    };
    const enriched = await enrichRoadmapDocWithBlame(doc, repo);
    const items = enriched.ast.filter((n) => n.type === "checklistItem");
    expect(items).toHaveLength(4);

    expect(items[0]).toMatchObject({ author: "jordan", authorRef: "jordan", claimedByHuman: true });
    expect(items[0]!.addedAt).toBeGreaterThan(0);
    expect(items[0]!.blameSha).toMatch(/^[0-9a-f]{40}$/);

    expect(items[1]).toMatchObject({ author: "skynet", authorRef: "skynet", claimedByHuman: false });

    // The proposal-apply line: author is jordan (the git AUTHOR field), NOT
    // recovered as "Agent Ada" — the co-author lookup only fires for the
    // flat skynet@local case (see enrich.ts's own comment: a real --author
    // override always wins, the trailer is only consulted when there's no
    // other identity to show). A real human authored (approved/applied) the
    // commit, so it's claimed, same as any other human-authored line.
    expect(items[2]).toMatchObject({ author: "jordan", authorRef: "jordan", claimedByHuman: true });

    expect(items[3]).toMatchObject({ author: "Skynet Autonomy", authorRef: "autonomy", claimedByHuman: false });
  });

  it("a co-author trailer DOES surface the real agent name when the commit's own author is the flat skynet@local identity", async () => {
    // A fresh line whose commit is flat-Skynet-authored but carries a
    // co-author trailer — the case classifyBlameEmail alone can't resolve
    // (authorRef === "skynet"), which is exactly what resolveAgentCoAuthor
    // exists for.
    commit(
      "- [ ] Human-typed line\n- [ ] Ordinary agent commit, no attribution\n- [ ] Proposal apply, agent co-author\n- [ ] Autonomous apply\n- [ ] Flat-author but co-authored\n",
      { name: "Skynet", email: "skynet@local" },
      "Skynet: agent work, trailer only",
      "Agent Bea <a2@agents.skynet.local>",
    );
    const raw = git("show", "HEAD:ROADMAP.md");
    const ast = assignLineIdentity(parseRoadmapAst(raw), null);
    const doc: RoadmapDoc = {
      workspaceId: "w", projectId: "p", path: "ROADMAP.md", commitSha: git("rev-parse", "HEAD"),
      syncedAt: Date.now(), syncState: "in_sync", raw, ast, sections: [],
    };
    const enriched = await enrichRoadmapDocWithBlame(doc, repo);
    const items = enriched.ast.filter((n) => n.type === "checklistItem");
    expect(items[4]).toMatchObject({ author: "Agent Bea", authorRef: "Agent Bea", claimedByHuman: false });
  });

  it("returns the doc UNCHANGED (no throw) when blame finds nothing — e.g. an untracked path", async () => {
    const doc: RoadmapDoc = {
      workspaceId: "w", projectId: "p", path: "NOPE.md", commitSha: null,
      syncedAt: Date.now(), syncState: "in_sync", raw: "", ast: [], sections: [],
    };
    const enriched = await enrichRoadmapDocWithBlame(doc, repo);
    expect(enriched).toBe(doc); // same reference — the empty-blame fast path
  });
});

describe("roadmapHistory", () => {
  it("returns newest-first real commits touching the file — a hand count", async () => {
    const history = await roadmapHistory(repo, "ROADMAP.md", 50);
    expect(history.length).toBeGreaterThanOrEqual(4);
    expect(history[0]!.subject).toContain("agent work, trailer only");
    // Oldest entry (last in the newest-first list) is the very first commit.
    expect(history[history.length - 1]!.subject).toBe("roadmap: add line");
    expect(history[0]!.authorEmail).toBe("skynet@local");
  });

  it("respects the limit", async () => {
    const history = await roadmapHistory(repo, "ROADMAP.md", 2);
    expect(history).toHaveLength(2);
  });

  it("an empty array, never a throw, for a non-repo path", async () => {
    expect(await roadmapHistory("/definitely/not/a/repo", "x.md")).toEqual([]);
  });
});
