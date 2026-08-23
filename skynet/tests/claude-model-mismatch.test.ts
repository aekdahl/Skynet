// mapModel() collapses a versioned Fleet catalog slug ("sonnet-5") to the SDK's
// bare CLI alias ("sonnet") and trusts the bundled CLI to resolve it to the
// CURRENT model in that family. That trust broke once already: a stale bundled
// CLI silently resolved "sonnet" to Sonnet 4.6 instead of Sonnet 5, and nothing
// surfaced it. These tests cover the fix: comparing the operator's catalog
// selection against what the system/init message reports the CLI actually
// resolved to, and raising a non-blocking `notice` when they diverge.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  ClaudeRunnerProvider,
  parseModelVersion,
  modelMismatchWarning,
  __setClaudeTestHooks,
} from "../packages/runner-sdk/src/claude.js";
import type { RunnerEvents, HitlRaise } from "../packages/runner-sdk/src/types.js";

describe("parseModelVersion", () => {
  it("parses a Fleet catalog slug into family + normalized version", () => {
    expect(parseModelVersion("sonnet-5")).toEqual({ family: "sonnet", version: "5" });
    expect(parseModelVersion("opus-4.8")).toEqual({ family: "opus", version: "4-8" });
    expect(parseModelVersion("haiku-4.5")).toEqual({ family: "haiku", version: "4-5" });
    expect(parseModelVersion("fable-5")).toEqual({ family: "fable", version: "5" });
  });
  it("parses a resolved model id, stripping the claude- prefix and a trailing dated suffix", () => {
    expect(parseModelVersion("claude-sonnet-5")).toEqual({ family: "sonnet", version: "5" });
    expect(parseModelVersion("claude-sonnet-4-6")).toEqual({ family: "sonnet", version: "4-6" });
    expect(parseModelVersion("claude-haiku-4-5-20251001")).toEqual({ family: "haiku", version: "4-5" });
  });
  it("returns null for anything that isn't a versioned opus/sonnet/haiku/fable slug", () => {
    expect(parseModelVersion("gpt-5.2-codex")).toBeNull();
    expect(parseModelVersion("composer-2")).toBeNull();
    expect(parseModelVersion("")).toBeNull();
  });
});

describe("modelMismatchWarning", () => {
  it("is silent when the resolved model matches the requested family + version", () => {
    expect(modelMismatchWarning("sonnet-5", "claude-sonnet-5")).toBeNull();
    expect(modelMismatchWarning("opus-5", "claude-opus-5")).toBeNull();
    // A dated suffix on the resolved id doesn't itself count as a mismatch.
    expect(modelMismatchWarning("haiku-4.5", "claude-haiku-4-5-20251001")).toBeNull();
  });
  it("warns when the resolved model is a different version in the SAME family — the actual bug", () => {
    const warning = modelMismatchWarning("sonnet-5", "claude-sonnet-4-6");
    expect(warning).toContain("sonnet-5");
    expect(warning).toContain("claude-sonnet-4-6");
  });
  it("warns when the resolved model is a different family entirely", () => {
    expect(modelMismatchWarning("sonnet-5", "claude-opus-5")).not.toBeNull();
  });
  it("never fires for a custom/passthrough model on either side — nothing to check it against", () => {
    expect(modelMismatchWarning("claude-opus-4-9-preview", "claude-opus-4-9-preview")).toBeNull();
    expect(modelMismatchWarning("some-bedrock-arn", "claude-sonnet-5")).toBeNull();
    expect(modelMismatchWarning("sonnet-5", "some-bedrock-arn")).toBeNull();
  });
});

// ─── Integration: wired into the live message-drain loop ──────────────────
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

function fakeEvents() {
  return {
    onLog: vi.fn(),
    onProgress: vi.fn(),
    onHeartbeat: vi.fn(),
    onStatus: vi.fn(),
    onHitl: vi.fn(),
    onCompleted: vi.fn(),
    onFailed: vi.fn(),
    onChatReply: vi.fn(),
    onUsage: vi.fn(),
  } satisfies RunnerEvents;
}

const spec = {
  runId: "a1", projectId: "p1", task: "make it faster",
  model: "sonnet-5", branch: "agent/a1", apiKey: "test-key",
};
const ok = { type: "result", subtype: "success", is_error: false, num_turns: 1 };

describe("ClaudeRunner model-mismatch wiring", () => {
  let q: ReturnType<typeof scriptedQuery>;
  beforeEach(() => {
    q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
  });
  afterEach(() => __setClaudeTestHooks(null));

  it("raises a non-blocking notice AND logs a warning when the CLI resolved a different model — the run still completes", async () => {
    q.push([{ type: "system", session_id: "s1", subtype: "init", model: "claude-sonnet-4-6" }, ok]);
    const events = fakeEvents();
    await new ClaudeRunnerProvider().start(spec, events);

    await vi.waitFor(() => expect(events.onCompleted).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onFailed).not.toHaveBeenCalled();

    expect(events.onLog).toHaveBeenCalledWith("a1", expect.stringContaining("⚠ model mismatch"));
    expect(events.onHitl).toHaveBeenCalledWith(
      "a1",
      expect.objectContaining({ kind: "notice" } satisfies Partial<HitlRaise>),
    );
    // Non-blocking: nothing ever parks the run on "waiting" for this notice
    // (unlike a real gate — see ExitPlanMode/canUseTool — which always does).
    expect(events.onStatus).not.toHaveBeenCalledWith("a1", "waiting");
  });

  it("stays silent when the resolved model matches what was requested", async () => {
    q.push([{ type: "system", session_id: "s1", subtype: "init", model: "claude-sonnet-5" }, ok]);
    const events = fakeEvents();
    await new ClaudeRunnerProvider().start(spec, events);

    await vi.waitFor(() => expect(events.onCompleted).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onHitl).not.toHaveBeenCalledWith("a1", expect.objectContaining({ kind: "notice" }));
    expect(events.onLog.mock.calls.some((c) => typeof c[1] === "string" && c[1].includes("model mismatch"))).toBe(false);
  });

  it("fires at most once per run even if multiple system messages arrive", async () => {
    q.push([
      { type: "system", session_id: "s1", subtype: "init", model: "claude-sonnet-4-6" },
      { type: "system", session_id: "s1", subtype: "init", model: "claude-sonnet-4-6" },
      ok,
    ]);
    const events = fakeEvents();
    await new ClaudeRunnerProvider().start(spec, events);

    await vi.waitFor(() => expect(events.onCompleted).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    const notices = events.onHitl.mock.calls.filter((c) => (c[1] as HitlRaise).kind === "notice");
    expect(notices).toHaveLength(1);
  });
});
