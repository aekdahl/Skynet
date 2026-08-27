// An escalating agent has still ASKED something. The operator saw only a
// generic "Agent is blocked — needs a human" banner: the question itself was
// reachable only by expanding Details, and the concrete options the agent had
// already written down were discarded at the raise, so a human had to retype
// an answer that already existed.
//
// This pins the RAISE side of that fix (the UI renders `why` on the bar and
// turns `options` into one-click guidance — see apps/web/src/views/task.tsx):
// an escalation must carry the agent's question as `why` and its choices as
// `options`, and must not duplicate the same paragraph into `rationale`.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeRunnerProvider, __setClaudeTestHooks } from "../packages/runner-sdk/src/claude.js";
import type { RunnerEvents } from "../packages/runner-sdk/src/types.js";

function scriptedQuery() {
  const scripts: Array<Array<Record<string, unknown>>> = [];
  const fn = vi.fn(() => {
    const msgs = scripts.shift() ?? [];
    async function* gen() {
      for (const m of msgs) yield m;
    }
    return Object.assign(gen(), { interrupt: async () => undefined });
  });
  return { fn, push: (s: Array<Record<string, unknown>>) => scripts.push(s) };
}

const fakeEvents = () =>
  ({
    onLog: vi.fn(),
    onProgress: vi.fn(),
    onHeartbeat: vi.fn(),
    onStatus: vi.fn(),
    onHitl: vi.fn(),
    onCompleted: vi.fn(),
    onFailed: vi.fn(),
    onChatReply: vi.fn(),
    onUsage: vi.fn(),
  }) satisfies RunnerEvents;

const sys = { type: "system", session_id: "s1" };
const ok = { type: "result", subtype: "success", is_error: false, num_turns: 1 };

const dirs: string[] = [];
afterEach(() => {
  __setClaudeTestHooks(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Raise = {
  kind: string;
  title: string;
  why: string;
  options: string[] | null;
  rationale: string | null;
  command: string | null;
};

/** Start a run, then drive its canUseTool with one AskUserQuestion payload. */
async function raiseFor(input: Record<string, unknown>): Promise<{ raise: Raise; events: ReturnType<typeof fakeEvents> }> {
  const cwd = mkdtempSync(join(tmpdir(), "skynet-escalation-"));
  dirs.push(cwd);
  const q = scriptedQuery();
  __setClaudeTestHooks({ query: q.fn as never });
  q.push([sys, ok]);
  const events = fakeEvents();
  await new ClaudeRunnerProvider().start(
    { runId: "a1", projectId: "p1", task: "t", model: "sonnet-4.6", branch: "agent/a1", apiKey: "k", cwd },
    events,
  );
  await vi.waitFor(() => expect(q.fn).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
  const options = q.fn.mock.calls[0]![0]!.options as {
    canUseTool: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  void options.canUseTool("AskUserQuestion", input); // never resolves — it's a gate
  await vi.waitFor(() => expect(events.onHitl).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
  return { raise: events.onHitl.mock.calls[0]![1] as Raise, events };
}

// The real payload shape from the live incident: the agent searched, found no
// adapter to test, and asked how to proceed — with options — under an ESCALATE
// header. All of it was thrown away except the header.
const KIMI = {
  questions: [
    {
      header: "ESCALATE",
      question:
        "I searched this worktree for a Kimi adapter and found none — no kimi.ts in packages/runner-sdk/src. There is no 'new Kimi adapter' present in this branch to test. How should I proceed?",
      options: [
        { label: "Test the adapter from branch oss-v1", description: "Cherry-pick it here first" },
        { label: "Close this as already done" },
        { label: "Stop — I'll re-scope it" },
      ],
    },
  ],
};

describe("an escalating agent's question reaches the operator", () => {
  it("carries the agent's question as `why`, not just a generic title", async () => {
    const { raise } = await raiseFor(KIMI);
    expect(raise.kind).toBe("escalation");
    expect(raise.title).toBe("Agent is blocked — needs a human");
    // The regression: this was the ONLY place the question lived, and the UI
    // never rendered it on the bar.
    expect(raise.why).toContain("no 'new Kimi adapter' present in this branch");
    expect(raise.why).toContain("How should I proceed?");
  });

  it("keeps the choices the agent offered instead of discarding them", async () => {
    const { raise } = await raiseFor(KIMI);
    expect(raise.options).toEqual([
      "Test the adapter from branch oss-v1",
      "Close this as already done",
      "Stop — I'll re-scope it",
    ]);
  });

  it("carries option descriptions into the detail box", async () => {
    const { raise } = await raiseFor(KIMI);
    expect(raise.command).toContain("Cherry-pick it here first");
  });

  it("does not repeat the same paragraph as both `why` and `rationale`", async () => {
    // Setting both rendered the identical text twice in the detail panel,
    // under "Agent's account" and again under "What happened".
    const { raise } = await raiseFor(KIMI);
    expect(raise.rationale).toBeNull();
  });

  it("keeps a non-ESCALATE hand-off header as the card's title", async () => {
    const { raise } = await raiseFor({
      questions: [{ header: "BLOCKED on credentials", question: "Which key should I use?", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(raise.kind).toBe("escalation");
    expect(raise.title).toBe("BLOCKED on credentials");
    expect(raise.why).toBe("Which key should I use?");
  });

  it("still treats an ordinary question as a question, not an escalation", async () => {
    const { raise } = await raiseFor({
      questions: [{ header: "Approach", question: "Which approach?", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(raise.kind).toBe("question");
    expect(raise.why).toBe("Which approach?");
    expect(raise.options).toEqual(["A", "B"]);
  });
});
