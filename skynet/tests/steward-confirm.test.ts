// Conversational + batch confirmation for Steward. `parseConfirmation` is the
// shared vocabulary both surfaces use to read a "yes" / "accept all" reply;
// `splitProposedActions` peels a batch of confirm-first actions off an answer so
// the operator can accept several at once. Pure guarantees the UIs rely on.
import { describe, it, expect } from "vitest";
import { parseConfirmation } from "@skynet/shared";
import {
  splitProposedActions,
  type ProjectActionContext,
} from "../apps/server/src/steward/assistant.js";

describe("parseConfirmation — shared confirm vocabulary", () => {
  it('reads plain affirmatives as "one"', () => {
    for (const t of ["yes", "y", "ok", "okay", "sure", "confirm", "do it", "go ahead", "approve", "Yes.", "  YEP  "]) {
      expect(parseConfirmation(t)).toBe("one");
    }
  });

  it('reads "accept all" and friends as "all"', () => {
    for (const t of ["accept all", "yes to all", "approve all", "confirm all", "do them all", "all of them", "all", "run all", "Accept all!"]) {
      expect(parseConfirmation(t)).toBe("all");
    }
  });

  it('treats "all …" prefixes as batch but a longer sentence as "no"', () => {
    expect(parseConfirmation("all of them please")).toBe("all");
    // Not a confirmation — a fresh instruction, must not auto-run anything.
    expect(parseConfirmation("add another task about billing")).toBe("no");
    expect(parseConfirmation("no")).toBe("no");
    expect(parseConfirmation("")).toBe("no");
  });
});

const ctx: ProjectActionContext = {
  project: { id: "p-1", name: "Takeoff" },
  tasks: [
    { id: "t-1", text: "fix login redirect", state: "review" },
    { id: "t-2", text: "add metrics", state: "backlog" },
  ],
};

describe("splitProposedActions — batch of confirm-first actions", () => {
  it("returns an empty list when there is no action tail (pure chat)", () => {
    const r = splitProposedActions("The roadmap has 3 open items.", ctx);
    expect(r.actions).toEqual([]);
    expect(r.reply).toBe("The roadmap has 3 open items.");
  });

  it("parses multiple proposed actions and strips the JSON tail", () => {
    const raw =
      'Adding both tasks.\n{"proposeActions":[{"kind":"add_task","text":"write docs"},{"kind":"add_task","text":"add tests"}]}';
    const r = splitProposedActions(raw, ctx);
    expect(r.reply).toBe("Adding both tasks.");
    expect(r.actions.map((a) => a.kind)).toEqual(["add_task", "add_task"]);
    expect(r.actions.map((a) => a.text)).toEqual(["write docs", "add tests"]);
  });

  it("drops invalid actions but keeps the valid ones", () => {
    const raw =
      '{"proposeActions":[{"kind":"add_task","text":"ok"},{"kind":"move_task","taskId":"nope","to":"done"}]}';
    const r = splitProposedActions(raw, ctx);
    // The move references an id not on THIS board → dropped; the add survives.
    expect(r.actions.map((a) => a.kind)).toEqual(["add_task"]);
  });

  it("accepts a single {proposeAction} object as a one-element batch (back-compat)", () => {
    const r = splitProposedActions('{"proposeAction":{"kind":"add_task","text":"x"}}', ctx);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.kind).toBe("add_task");
  });

  it("synthesizes a group reply when the model gives no prose", () => {
    const r = splitProposedActions(
      '{"proposeActions":[{"kind":"add_task","text":"a"},{"kind":"add_task","text":"b"}]}',
      ctx,
    );
    expect(r.reply).toMatch(/2 changes/);
  });
});
