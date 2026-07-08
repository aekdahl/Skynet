// The Claude runner must never report an errored run as `done` (the 529 bug:
// an overload storm was surfacing as a completed agent with an empty diff), and
// it must retry transient overload/rate-limit by resuming the session, bounded.
// We drive the SDK stream via the runner's test hooks (pnpm gives runner-sdk its
// own copy of the SDK, so a plain vi.mock wouldn't reach claude.ts's import).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ClaudeRunnerProvider,
  isTransientApiError,
  retryBackoffMs,
  __setClaudeTestHooks,
} from "../packages/runner-sdk/src/claude.js";
import type { RunnerEvents } from "../packages/runner-sdk/src/types.js";

// A scripted stand-in for the Agent SDK query(): each call yields the next
// scripted message stream, and carries the interrupt() the runner calls.
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
  agentId: "a1", projectId: "p1", task: "make it faster",
  model: "sonnet-4.6", branch: "agent/a1", apiKey: "test-key",
};

const sys = { type: "system", session_id: "s1" };
const ok = { type: "result", subtype: "success", is_error: false, num_turns: 1 };
const overload = { type: "result", subtype: "error_during_execution", is_error: true, result: "Overloaded (529)" };
const nonTransient = { type: "result", subtype: "error_during_execution", is_error: true, result: "syntax error in tool" };

afterEach(() => __setClaudeTestHooks(null));

describe("classifier", () => {
  it("flags overload / rate-limit / 429 / 529 / 503 as transient", () => {
    for (const s of ["Overloaded", "overloaded_error", "429 Too Many Requests", "529", "503 Service", "rate limit exceeded"])
      expect(isTransientApiError(s)).toBe(true);
  });
  it("does not flag ordinary errors as transient", () => {
    for (const s of ["error_max_turns", "syntax error", "permission denied", ""])
      expect(isTransientApiError(s)).toBe(false);
  });
  it("backs off exponentially, capped at 30s", () => {
    expect(retryBackoffMs(1)).toBe(2_000);
    expect(retryBackoffMs(2)).toBe(4_000);
    expect(retryBackoffMs(10)).toBe(30_000);
  });
});

describe("ClaudeRunner error handling", () => {
  let q: ReturnType<typeof scriptedQuery>;
  beforeEach(() => {
    q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never, backoffMs: () => 5 }); // near-zero backoff
  });

  it("reports an errored result as FAILED, never done", async () => {
    q.push([sys, nonTransient]);
    const events = fakeEvents();
    await new ClaudeRunnerProvider().start(spec, events);

    await vi.waitFor(() => expect(events.onFailed).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onCompleted).not.toHaveBeenCalled();
    expect(events.onStatus).not.toHaveBeenCalledWith("a1", "done");
    expect(q.fn).toHaveBeenCalledTimes(1); // non-transient → no retry
  });

  it("retries a transient overload by resuming the session, then completes", async () => {
    q.push([sys, overload]); // first attempt: overloaded
    q.push([ok]); // resumed attempt: succeeds
    const events = fakeEvents();
    await new ClaudeRunnerProvider().start(spec, events);

    await vi.waitFor(() => expect(events.onCompleted).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onFailed).not.toHaveBeenCalled();
    expect(q.fn).toHaveBeenCalledTimes(2); // initial + one resume
    expect(events.onLog).toHaveBeenCalledWith("a1", expect.stringContaining("retrying"));
  });

  it("gives up after the retry budget and fails (never done)", async () => {
    for (let i = 0; i < 6; i++) q.push([sys, overload]); // always overloaded
    const events = fakeEvents();
    await new ClaudeRunnerProvider().start(spec, events);

    await vi.waitFor(() => expect(events.onFailed).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onCompleted).not.toHaveBeenCalled();
    expect(q.fn).toHaveBeenCalledTimes(4); // initial + MAX_API_RETRIES(3)
    expect(events.onFailed).toHaveBeenCalledWith("a1", expect.stringContaining("after 3 retries"));
  });
});
