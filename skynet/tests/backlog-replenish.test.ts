// A project whose board has run dry, with no source to re-pull from, is the one
// case where it genuinely STOPS until a human thinks of the next thing. This
// proposes that instead — grounded in the project's own goal, roadmap and
// context, never invented.
//
// The safety property is the important part: what it creates cannot start
// itself. Without that this would be a perpetual work generator — invent tasks,
// run them, empty the board, invent more.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { buildReplenishPrompt, parseProposedTasks } from "../apps/server/src/steward/replenish.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}
const WS = DEFAULT_WORKSPACE;
const reply = (tasks: unknown[]) => JSON.stringify({ tasks });

describe("parseProposedTasks", () => {
  it("reads the model's fields, never prose", () => {
    const out = parseProposedTasks(reply([{ text: "Add rate limiting", description: "d", rationale: "r" }]));
    expect(out).toEqual([{ text: "Add rate limiting", description: "d", rationale: "r" }]);
  });

  it("treats an empty list as a valid answer, not a failure", () => {
    // A project whose direction isn't written down anywhere SHOULD produce
    // nothing rather than a plausible-sounding invented roadmap.
    expect(parseProposedTasks(reply([]))).toEqual([]);
  });

  it("returns null (not []) for an unreadable reply, so the caller can retry", () => {
    expect(parseProposedTasks("I think you should add caching!")).toBeNull();
  });

  it("caps the batch — three good tasks beat a padded list", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ text: `t${i}` }));
    expect(parseProposedTasks(reply(many))).toBeNull(); // over the max → schema rejects
  });
});

describe("buildReplenishPrompt", () => {
  it("shows what is already DONE — the difference between 'next' and 'the same list again'", () => {
    const p = buildReplenishPrompt({
      projectName: "P", goal: "ship billing", doneTitles: ["Add Stripe webhook"], openTitles: ["Write docs"],
    });
    expect(p).toContain("ALREADY DONE");
    expect(p).toContain("Add Stripe webhook");
    expect(p).toContain("ALREADY ON THE BOARD");
    expect(p).toContain("Write docs");
  });

  it("tells the model to propose NOTHING rather than invent a direction", () => {
    const p = buildReplenishPrompt({ projectName: "P", goal: "", doneTitles: [], openTitles: [] });
    expect(p).toMatch(/propose NOTHING/);
    expect(p).toMatch(/Never invent a plausible-sounding roadmap/);
  });
});

describe("replenishBacklog", () => {
  let ops: Operations;
  let store: MemoryStore;
  let ask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    ask = vi.fn();
    ops = new Operations({ store, hub, orchestrator: new Orchestrator(store, hub), replenishAsk: ask as never });
  });

  const project = () => ops.createProject(WS, { name: "P", goal: "ship billing" });

  it("creates proposed tasks in BACKLOG and NOT auto-pickable — they cannot start themselves", () => {
    // The safety property the whole feature rests on: auto-pick only ever
    // starts tasks flagged autoPick, so a human has to pick these up.
    return (async () => {
      const p = await project();
      ask.mockResolvedValue(reply([{ text: "Add rate limiting" }, { text: "Add audit log" }]));
      const created = await ops.replenishBacklog(WS, p.id);
      expect(created).toHaveLength(2);
      for (const t of created) {
        expect(t.state).toBe("backlog");
        expect(t.autoPick).toBe(false);
      }
    })();
  });

  it("never re-proposes something already on the board", async () => {
    const p = await project();
    await ops.createTask(WS, p.id, { text: "Add rate limiting" });
    ask.mockResolvedValue(reply([{ text: "add rate limiting." }, { text: "Add audit log" }]));
    const created = await ops.replenishBacklog(WS, p.id);
    expect(created.map((t) => t.text)).toEqual(["Add audit log"]);
  });

  it("retries ONCE on an unreadable reply, then gives up quietly", async () => {
    const p = await project();
    ask.mockResolvedValueOnce("nonsense").mockResolvedValueOnce(reply([{ text: "Add caching" }]));
    expect((await ops.replenishBacklog(WS, p.id)).map((t) => t.text)).toEqual(["Add caching"]);
    expect(ask).toHaveBeenCalledTimes(2);

    ask.mockReset();
    ask.mockResolvedValue("still nonsense");
    expect(await ops.replenishBacklog(WS, p.id)).toEqual([]);
    expect(ask).toHaveBeenCalledTimes(2); // one retry, then stop
  });

  it("creates nothing when the model correctly proposes nothing", async () => {
    const p = await project();
    ask.mockResolvedValue(reply([]));
    expect(await ops.replenishBacklog(WS, p.id)).toEqual([]);
    expect((await store.listTasks(WS)).length).toBe(0);
  });
});
