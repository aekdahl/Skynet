// Project context (meeting notes, emails, pasted/uploaded docs): raw
// ProjectContextEntry rows are kept verbatim; condenseProjectContext (pure,
// stub-injected — mirrors crystallize's draftBriefFromConversation) turns the
// accumulated set into Project.contextSummary, the primer agent-context.ts's
// buildAgentContext and Steward's grounding both pick up automatically. Two
// layers: the pure condensation contract (no LLM, a stub `ask`), and the
// Operations-layer integration (add/upload/delete all trigger a re-condense).
import { describe, it, expect } from "vitest";
import type { ProjectContextEntry, ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { buildCondensePrompt, condenseProjectContext, MAX_SUMMARY_CHARS } from "../apps/server/src/steward/context.js";
import { extractText, UnsupportedFileTypeError } from "../apps/server/src/steward/extract.js";
import { Hub } from "../apps/server/src/hub.js";
import { NotFoundError, Operations } from "../apps/server/src/operations.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: { ws: string; event: ServerEvent }[] = [];
  publish(ws: string, event: ServerEvent): void { this.events.push({ ws, event }); }
  subscribe(): () => void { return () => {}; }
}
class NoopProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const entry = (over: Partial<ProjectContextEntry> = {}): ProjectContextEntry => ({
  id: over.id ?? "e-1",
  workspaceId: DEFAULT_WORKSPACE,
  projectId: "p-1",
  source: "paste",
  label: "Note",
  content: "we're building a billing dashboard for finance",
  filename: null,
  mimeType: null,
  createdAt: 1000,
  createdBy: "op-1",
  ...over,
});

describe("condenseProjectContext — the pure condensation contract", () => {
  it("returns null (no call) for an empty entry list", async () => {
    let called = false;
    const ask = async () => { called = true; return "anything"; };
    expect(await condenseProjectContext(ask, "P", [])).toBeNull();
    expect(called).toBe(false);
  });

  it("returns the trimmed model reply for a non-empty list", async () => {
    const summary = await condenseProjectContext(async () => "  Goal: ship the billing dashboard.  ", "P", [entry()]);
    expect(summary).toBe("Goal: ship the billing dashboard.");
  });

  it("returns null (never overwrites with blank) on an empty/whitespace-only reply", async () => {
    expect(await condenseProjectContext(async () => "   ", "P", [entry()])).toBeNull();
  });

  it("defensively truncates a reply longer than MAX_SUMMARY_CHARS", async () => {
    const long = "x".repeat(MAX_SUMMARY_CHARS + 500);
    const summary = await condenseProjectContext(async () => long, "P", [entry()]);
    expect(summary!.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS + "\n… (truncated)".length);
    expect(summary).toContain("(truncated)");
  });
});

describe("buildCondensePrompt", () => {
  it("grounds the prompt in the project name and every entry's label + content", () => {
    const prompt = buildCondensePrompt("Billing", [
      entry({ id: "e-1", label: "Kickoff call", content: "scope is invoicing only", createdAt: 2000 }),
      entry({ id: "e-2", label: "Follow-up email", content: "client confirmed Q3 deadline", createdAt: 1000 }),
    ]);
    expect(prompt).toContain("Project: Billing");
    expect(prompt).toContain("Kickoff call");
    expect(prompt).toContain("scope is invoicing only");
    expect(prompt).toContain("Follow-up email");
    expect(prompt).toContain("client confirmed Q3 deadline");
  });

  it("orders entries newest-first", () => {
    const prompt = buildCondensePrompt("P", [
      entry({ id: "e-old", label: "OLDEST", createdAt: 1000 }),
      entry({ id: "e-new", label: "NEWEST", createdAt: 9000 }),
    ]);
    expect(prompt.indexOf("NEWEST")).toBeLessThan(prompt.indexOf("OLDEST"));
  });
});

describe("extractText", () => {
  it("reads .txt / .md verbatim", async () => {
    expect(await extractText("notes.txt", "text/plain", Buffer.from("hello there"))).toBe("hello there");
    expect(await extractText("plan.md", "text/markdown", Buffer.from("# Plan\n\nships Q3"))).toBe("# Plan\n\nships Q3");
  });

  it("throws UnsupportedFileTypeError for an unrecognized extension", async () => {
    await expect(extractText("audio.mp3", "audio/mpeg", Buffer.from([1, 2, 3]))).rejects.toThrow(UnsupportedFileTypeError);
  });
});

// ── Operations-layer integration: a real store, real add/upload/delete ─────
const setup = (contextAsk?: (prompt: string) => Promise<string>) => {
  const store = new MemoryStore();
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator, contextAsk });
  return { store, hub, bus, ops };
};

const mkProject = async (ops: Operations) => ops.createProject(DEFAULT_WORKSPACE, { name: "Billing", goal: "ship" });

describe("Operations.addContextEntry / refreshProjectContext", () => {
  it("adding a paste entry stores it verbatim AND condenses a fresh Project.contextSummary", async () => {
    const { ops, bus } = setup(async () => "Condensed: ship the billing dashboard by Q3.");
    const project = await mkProject(ops);
    expect(project.contextSummary).toBeNull();

    const added = await ops.addContextEntry(DEFAULT_WORKSPACE, project.id, "op-1", { content: "kickoff notes: Q3 deadline" });
    expect(added.source).toBe("paste");
    expect(added.content).toBe("kickoff notes: Q3 deadline");
    expect(added.createdBy).toBe("op-1");

    const listed = await ops.listContextEntries(DEFAULT_WORKSPACE, project.id);
    expect(listed.map((e) => e.id)).toEqual([added.id]);

    const updated = await ops.getProject(DEFAULT_WORKSPACE, project.id);
    expect(updated.contextSummary).toBe("Condensed: ship the billing dashboard by Q3.");
    expect(updated.contextSummaryUpdatedAt).not.toBeNull();
    expect(bus.events.some((e) => e.event.type === "contextEntry.upserted")).toBe(true);
    expect(bus.events.some((e) => e.event.type === "project.upserted")).toBe(true);
  });

  it("a blank/optional label falls back to an auto-generated one, never empty", async () => {
    const { ops } = setup(async () => "summary");
    const project = await mkProject(ops);
    const added = await ops.addContextEntry(DEFAULT_WORKSPACE, project.id, "op-1", { content: "notes" });
    expect(added.label.trim().length).toBeGreaterThan(0);
  });

  it("404s for a foreign-workspace / nonexistent project — nothing created", async () => {
    const { ops } = setup(async () => "summary");
    await expect(
      ops.addContextEntry(DEFAULT_WORKSPACE, "no-such-project", "op-1", { content: "x" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("deleting the only entry clears the summary back to null (never leaves a stale one)", async () => {
    const { ops } = setup(async () => "Condensed summary.");
    const project = await mkProject(ops);
    const added = await ops.addContextEntry(DEFAULT_WORKSPACE, project.id, "op-1", { content: "notes" });
    expect((await ops.getProject(DEFAULT_WORKSPACE, project.id)).contextSummary).toBe("Condensed summary.");

    await ops.deleteContextEntry(DEFAULT_WORKSPACE, project.id, added.id);
    expect(await ops.listContextEntries(DEFAULT_WORKSPACE, project.id)).toEqual([]);
    expect((await ops.getProject(DEFAULT_WORKSPACE, project.id)).contextSummary).toBeNull();
  });

  it("uploadContextEntry extracts text from a .txt buffer and condenses it", async () => {
    const { ops } = setup(async (prompt) => (prompt.includes("roadmap doc") ? "Condensed from upload." : "n/a"));
    const project = await mkProject(ops);
    const added = await ops.uploadContextEntry(DEFAULT_WORKSPACE, project.id, "op-1", {
      filename: "roadmap doc.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("we are building a roadmap doc for Q3"),
    });
    expect(added.source).toBe("upload");
    expect(added.filename).toBe("roadmap doc.txt");
    expect(added.content).toBe("we are building a roadmap doc for Q3");
    expect((await ops.getProject(DEFAULT_WORKSPACE, project.id)).contextSummary).toBe("Condensed from upload.");
  });

  it("uploadContextEntry rejects an unsupported file type — nothing stored, no condensation call", async () => {
    let called = false;
    const { ops } = setup(async () => { called = true; return "x"; });
    const project = await mkProject(ops);
    await expect(
      ops.uploadContextEntry(DEFAULT_WORKSPACE, project.id, "op-1", {
        filename: "clip.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.from([1, 2, 3]),
      }),
    ).rejects.toThrow(UnsupportedFileTypeError);
    expect(await ops.listContextEntries(DEFAULT_WORKSPACE, project.id)).toEqual([]);
    expect(called).toBe(false);
  });

  it("refreshProjectContext re-condenses on demand without adding/removing anything", async () => {
    let calls = 0;
    const { ops } = setup(async () => { calls++; return `summary v${calls}`; });
    const project = await mkProject(ops);
    await ops.addContextEntry(DEFAULT_WORKSPACE, project.id, "op-1", { content: "notes" });
    expect((await ops.getProject(DEFAULT_WORKSPACE, project.id)).contextSummary).toBe("summary v1");

    const refreshed = await ops.refreshProjectContext(DEFAULT_WORKSPACE, project.id);
    expect(refreshed.contextSummary).toBe("summary v2");
  });
});
