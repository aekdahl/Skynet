// The streaming Steward reply: prose deltas, then a \x1e sentinel + a JSON control
// frame {reply, actions, projectId}. parseStewardStream must forward ONLY the prose
// to onDelta (never the sentinel/JSON), and return the authoritative clean reply +
// any proposed actions (a batch) — so an action JSON that streamed through the live
// view is reconciled away.
import { describe, it, expect } from "vitest";
import { parseStewardStream, STEWARD_SENTINEL as SEP } from "../apps/web/src/lib/steward-stream.js";

async function* chunksOf(...parts: string[]): AsyncGenerator<string> {
  for (const p of parts) yield p;
}
const sink = () => {
  const out: string[] = [];
  return { onDelta: (c: string) => out.push(c), text: () => out.join(""), calls: () => out.length };
};

describe("parseStewardStream", () => {
  it("streams pure prose incrementally when there's no control frame", async () => {
    const s = sink();
    const r = await parseStewardStream(chunksOf("Hello ", "world"), s.onDelta);
    expect(s.text()).toBe("Hello world");
    expect(s.calls()).toBe(2); // one delta per chunk
    expect(r).toEqual({ reply: "Hello world" });
  });

  it("emits only the prose and returns the clean control frame with a batch of actions", async () => {
    const s = sink();
    const ctrl = JSON.stringify({
      reply: "Added the tasks.",
      actions: [{ kind: "add_task", summary: "Add X" }, { kind: "add_task", summary: "Add Y" }],
      projectId: "p1",
    });
    const r = await parseStewardStream(chunksOf("Added the tasks." + SEP + ctrl), s.onDelta);
    expect(s.text()).toBe("Added the tasks."); // the sentinel + JSON are never shown
    expect(r.reply).toBe("Added the tasks.");
    expect(r.actions).toEqual([{ kind: "add_task", summary: "Add X" }, { kind: "add_task", summary: "Add Y" }]);
    expect(r.projectId).toBe("p1");
  });

  it("handles the control frame split across chunk boundaries", async () => {
    const s = sink();
    const r = await parseStewardStream(
      chunksOf("ok", SEP + '{"reply":"ok",', '"actions":[],"projectId":null}'),
      s.onDelta,
    );
    expect(s.text()).toBe("ok");
    expect(r.reply).toBe("ok");
    expect(r.actions).toEqual([]);
    expect(r.projectId).toBeNull();
  });

  it("reconciles to the clean reply when an action-JSON tail streamed through", async () => {
    const s = sink();
    const streamedRaw = 'Sure, adding it.\n```json\n{"proposeActions":[{"kind":"add_task"}]}\n```';
    const ctrl = JSON.stringify({ reply: "Sure, adding it.", actions: [{ kind: "add_task", summary: "Add it" }], projectId: "p2" });
    const r = await parseStewardStream(chunksOf(streamedRaw + SEP + ctrl), s.onDelta);
    expect(s.text()).toBe(streamedRaw); // the live view briefly showed the raw text…
    expect(r.reply).toBe("Sure, adding it."); // …but the authoritative reply is clean
    expect(r.actions?.[0]).toMatchObject({ kind: "add_task" });
  });

  it("falls back to the streamed prose on a malformed trailer", async () => {
    const s = sink();
    const r = await parseStewardStream(chunksOf("partial" + SEP + "{not json"), s.onDelta);
    expect(s.text()).toBe("partial");
    expect(r.reply).toBe("partial");
    expect(r.actions).toBeUndefined();
  });
});
