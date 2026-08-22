// Crystallize (S5): a Steward conversation → a draft SolutionBrief. Two layers:
// the PURE retry/parse contract (draftBriefFromConversation/parseDraftBrief —
// no LLM, a stub `ask`), and the Operations-layer integration (crystallizeBrief,
// injecting the same stub via OperationsDeps.crystallizeAsk so the full
// create-a-real-brief path is provable without a real model call or API key).
// HTTP-boundary behavior (the 400/422 mapping at the real Fastify route) is
// covered separately in crystallize-brief-routes.test.ts.
import { describe, it, expect } from "vitest";
import type { ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import {
  buildCrystallizePrompt,
  CrystallizeParseError,
  draftBriefFromConversation,
  parseDraftBrief,
} from "../apps/server/src/steward/crystallize.js";
import type { ChatTurn } from "../apps/server/src/steward/assistant.js";
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

const VALID_REPLY = JSON.stringify({
  title: "Reconcile Stripe webhooks",
  problem: "Retries can double-post a charge.",
  approach: "Idempotency key on the ledger insert.",
  optionsConsidered: [{ name: "DB unique constraint", verdict: "chosen", why: "cheapest" }],
  risks: ["migration must land before the flag flips"],
  acceptanceCriteria: ["a replayed webhook never double-posts"],
  openQuestions: ["backfill existing duplicates?"],
});

const history: ChatTurn[] = [
  { role: "user", content: "webhooks are double-posting on retry" },
  { role: "assistant", content: "we could use an idempotency key on the ledger insert" },
  { role: "user", content: "yeah let's do that, DB constraint not a queue" },
];

describe("parseDraftBrief", () => {
  it("reads a valid structured reply", () => {
    const result = parseDraftBrief(VALID_REPLY);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.title).toBe("Reconcile Stripe webhooks");
    expect(result.data.optionsConsidered).toHaveLength(1);
    expect(result.data.risks).toEqual(["migration must land before the flag flips"]);
  });

  it("defaults omitted arrays to empty", () => {
    const result = parseDraftBrief(JSON.stringify({ title: "T", problem: "p", approach: "a" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.optionsConsidered).toEqual([]);
    expect(result.data.risks).toEqual([]);
    expect(result.data.acceptanceCriteria).toEqual([]);
    expect(result.data.openQuestions).toEqual([]);
  });

  it("reports a readable error for non-JSON prose", () => {
    const result = parseDraftBrief("Sure! Here's a summary of what we discussed...");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/not a readable JSON object/);
  });

  it("reports a field-specific error for missing required fields", () => {
    const result = parseDraftBrief(JSON.stringify({ title: "T" })); // missing problem/approach
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/problem/);
    expect(result.error).toMatch(/approach/);
  });

  it("tolerates a ```json fence around the object (extractJsonObject already handles this)", () => {
    const fenced = "```json\n" + VALID_REPLY + "\n```";
    expect(parseDraftBrief(fenced).ok).toBe(true);
  });
});

describe("draftBriefFromConversation — the retry contract", () => {
  it("returns immediately on a valid first reply — ask called exactly once", async () => {
    const calls: string[] = [];
    const ask = async (prompt: string) => { calls.push(prompt); return VALID_REPLY; };
    const draft = await draftBriefFromConversation(ask, "P", history);
    expect(draft.title).toBe("Reconcile Stripe webhooks");
    expect(calls).toHaveLength(1);
  });

  it("retries ONCE on an invalid first reply, succeeds on the second — the retry prompt carries the validation error", async () => {
    const calls: string[] = [];
    let n = 0;
    const ask = async (prompt: string) => {
      calls.push(prompt);
      n++;
      return n === 1 ? "not json at all" : VALID_REPLY;
    };
    const draft = await draftBriefFromConversation(ask, "P", history);
    expect(draft.title).toBe("Reconcile Stripe webhooks");
    expect(calls).toHaveLength(2);
    // The SECOND prompt must carry the first failure's reason, so the model
    // can self-correct — not just a blind identical retry.
    expect(calls[1]).toContain("could not be read as valid JSON");
    expect(calls[1]).toContain("not a readable JSON object");
  });

  it("throws CrystallizeParseError after a SECOND bad reply — never a third try", async () => {
    const calls: string[] = [];
    const ask = async (prompt: string) => { calls.push(prompt); return "still not json"; };
    await expect(draftBriefFromConversation(ask, "P", history)).rejects.toThrow(CrystallizeParseError);
    expect(calls).toHaveLength(2); // exactly one retry, not a loop
  });

  it("a structurally-invalid-but-JSON reply (fails zod) also gets the retry, with a field-level error", async () => {
    const calls: string[] = [];
    let n = 0;
    const ask = async (prompt: string) => {
      calls.push(prompt);
      n++;
      return n === 1 ? JSON.stringify({ title: "" }) : VALID_REPLY; // empty title fails min(1)
    };
    const draft = await draftBriefFromConversation(ask, "P", history);
    expect(draft.title).toBe("Reconcile Stripe webhooks");
    expect(calls[1]).toContain("title");
  });
});

describe("buildCrystallizePrompt", () => {
  it("grounds the prompt in the project name and the conversation turns", () => {
    const prompt = buildCrystallizePrompt("Billing", history);
    expect(prompt).toContain("Project: Billing");
    expect(prompt).toContain("Operator: webhooks are double-posting on retry");
    expect(prompt).toContain("Assistant: we could use an idempotency key");
  });

  it("appends the retry error only when one is given", () => {
    const fresh = buildCrystallizePrompt("Billing", history);
    expect(fresh).not.toContain("Your previous reply");
    const retry = buildCrystallizePrompt("Billing", history, "title: Required");
    expect(retry).toContain("Your previous reply");
    expect(retry).toContain("title: Required");
  });
});

// ── Operations-layer integration: a real store, a real createBrief call ────
const setup = (crystallizeAsk?: (prompt: string) => Promise<string>) => {
  const store = new MemoryStore();
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator, crystallizeAsk });
  return { store, hub, bus, ops };
};

const mkProject = async (ops: Operations) => ops.createProject(DEFAULT_WORKSPACE, { name: "Billing", goal: "ship" });

describe("Operations.crystallizeBrief", () => {
  it("lands a real draft brief with ALL fields, sourceConversation set, and the standard system fields filled", async () => {
    const { ops, bus } = setup(async () => VALID_REPLY);
    const project = await mkProject(ops);
    const brief = await ops.crystallizeBrief(DEFAULT_WORKSPACE, project.id, history);

    expect(brief.projectId).toBe(project.id);
    expect(brief.title).toBe("Reconcile Stripe webhooks");
    expect(brief.problem).toBe("Retries can double-post a charge.");
    expect(brief.approach).toBe("Idempotency key on the ledger insert.");
    expect(brief.optionsConsidered).toEqual([{ name: "DB unique constraint", verdict: "chosen", why: "cheapest" }]);
    expect(brief.risks).toEqual(["migration must land before the flag flips"]);
    expect(brief.acceptanceCriteria).toEqual(["a replayed webhook never double-posts"]);
    expect(brief.openQuestions).toEqual(["backfill existing duplicates?"]);
    // System-owned fields — never asked of the model, filled exactly like a
    // plain createBrief call (S4).
    expect(brief.status).toBe("draft");
    expect(brief.featureId).toBeNull();
    expect(brief.approvedAt).toBeNull();
    expect(brief.approvedBy).toBeNull();
    expect(brief.createdAt).toBe(brief.updatedAt);
    // Provenance: the conversation that produced it.
    expect(brief.sourceConversation).toContain("webhooks are double-posting");
    // A real, live-synced record — same event contract as plain createBrief.
    expect(bus.events.some((e) => e.event.type === "solutionBrief.upserted")).toBe(true);
    expect((await ops.listBriefs(DEFAULT_WORKSPACE)).map((b) => b.id)).toContain(brief.id);
  });

  it("404s for a foreign-workspace / nonexistent project — no brief created", async () => {
    const { ops } = setup(async () => VALID_REPLY);
    await expect(ops.crystallizeBrief(DEFAULT_WORKSPACE, "no-such-project", history)).rejects.toThrow(NotFoundError);
    expect(await ops.listBriefs(DEFAULT_WORKSPACE)).toEqual([]);
  });

  it("invalid model output on both tries → CrystallizeParseError, NO brief created", async () => {
    const { ops, store } = setup(async () => "not json, ever");
    const project = await mkProject(ops);
    await expect(ops.crystallizeBrief(DEFAULT_WORKSPACE, project.id, history)).rejects.toThrow(CrystallizeParseError);
    expect(await store.listSolutionBriefs(DEFAULT_WORKSPACE)).toEqual([]);
  });

  it("a bad first reply that's fixed on retry still lands a real brief", async () => {
    let n = 0;
    const { ops } = setup(async () => { n++; return n === 1 ? "garbage" : VALID_REPLY; });
    const project = await mkProject(ops);
    const brief = await ops.crystallizeBrief(DEFAULT_WORKSPACE, project.id, history);
    expect(brief.title).toBe("Reconcile Stripe webhooks");
    expect(n).toBe(2);
  });
});
