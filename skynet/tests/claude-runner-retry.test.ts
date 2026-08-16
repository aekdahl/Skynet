// The Claude runner must never report an errored run as `done` (the 529 bug:
// an overload storm was surfacing as a completed agent with an empty diff), and
// it must retry transient overload/rate-limit by resuming the session, bounded.
// We drive the SDK stream via the runner's test hooks (pnpm gives runner-sdk its
// own copy of the SDK, so a plain vi.mock wouldn't reach claude.ts's import).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ClaudeRunnerProvider,
  isTransientApiError,
  isCreditExhaustionError,
  retryBackoffMs,
  __setClaudeTestHooks,
} from "../packages/runner-sdk/src/claude.js";
import type { RunnerEvents } from "../packages/runner-sdk/src/types.js";

// A scripted stand-in for the TaskRun SDK query(): each call yields the next
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
  runId: "a1", projectId: "p1", task: "make it faster",
  model: "sonnet-4.6", branch: "agent/a1", apiKey: "test-key",
};

const sys = { type: "system", session_id: "s1" };
const ok = { type: "result", subtype: "success", is_error: false, num_turns: 1 };
const overload = { type: "result", subtype: "error_during_execution", is_error: true, result: "Overloaded (529)" };
const nonTransient = { type: "result", subtype: "error_during_execution", is_error: true, result: "syntax error in tool" };
const maxTurns = { type: "result", subtype: "error_max_turns", is_error: true, result: "" };

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
  it("flags credit/quota exhaustion (billing walls) — Anthropic + OpenAI phrasings", () => {
    for (const s of [
      "Your credit balance is too low to access the Anthropic API",
      "429 You exceeded your current quota, please check your plan and billing details",
      "insufficient_quota",
      "Error 402: Payment Required",
      "the account is out of credits",
    ])
      expect(isCreditExhaustionError(s)).toBe(true);
  });
  it("does NOT flag a plain rate-limit as exhaustion (so it stays retryable)", () => {
    for (const s of ["429 Too Many Requests", "rate limit exceeded", "Overloaded", "syntax error", ""])
      expect(isCreditExhaustionError(s)).toBe(false);
  });
  it("exhaustion wins over transient — a quota-429 is not retried in vain", () => {
    const quota429 = "429 You exceeded your current quota";
    expect(isTransientApiError(quota429)).toBe(true); // it looks transient (429)…
    expect(isCreditExhaustionError(quota429)).toBe(true); // …but it's really a billing wall
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

  it("ran out of turns is not a failure: resumes the session and completes", async () => {
    q.push([sys, maxTurns]); // first attempt hits the turn budget
    q.push([ok]); // continued attempt finishes
    const events = fakeEvents();
    await new ClaudeRunnerProvider().start(spec, events);

    await vi.waitFor(() => expect(events.onCompleted).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onFailed).not.toHaveBeenCalled();
    expect(q.fn).toHaveBeenCalledTimes(2); // initial + one continue (session resume)
    expect(events.onLog).toHaveBeenCalledWith("a1", expect.stringContaining("continuing where it left off"));
  });

  it("hands off after the continue budget: fails with error_max_turns (never done)", async () => {
    for (let i = 0; i < 6; i++) q.push([sys, maxTurns]); // never finishes within budget
    const events = fakeEvents();
    await new ClaudeRunnerProvider().start(spec, events);

    await vi.waitFor(() => expect(events.onFailed).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onCompleted).not.toHaveBeenCalled();
    expect(q.fn).toHaveBeenCalledTimes(4); // initial + MAX_TURN_CONTINUES(3)
    expect(events.onFailed).toHaveBeenCalledWith("a1", expect.stringContaining("error_max_turns"));
  });
});

// Regression for the "ClaudeRunnerProvider.sessions grows forever" tech-debt
// item: the cache is now a bounded LRU (runner-sdk/src/claude.ts) instead of
// unbounded, but Fork stays available on ANY run indefinitely (no completion
// event ever disables the Fork button — see apps/web/src/views/task.tsx), so
// eviction must be purely capacity-driven, never tied to a run reaching done.
// These pull each start() call's actual query options to see whether `resume`
// was passed — the ground truth for "did this fork inherit its parent's
// session", not just an indirect side effect.
function lastQueryOptions(fn: ReturnType<typeof scriptedQuery>["fn"]): { resume?: string; forkSession?: boolean } {
  const call = fn.mock.calls.at(-1) as [{ options: { resume?: string; forkSession?: boolean } }] | undefined;
  return call?.[0].options ?? {};
}

describe("ClaudeRunnerProvider session cache (fork resume)", () => {
  let q: ReturnType<typeof scriptedQuery>;
  beforeEach(() => {
    q = scriptedQuery();
  });

  it("evicts the least-recently-used session past the cap, but still resumes a recent one", async () => {
    // Cap shrunk to 2 so eviction is provable without driving 500+ runs.
    __setClaudeTestHooks({ query: q.fn as never, backoffMs: () => 5, maxSessions: 2 });
    const provider = new ClaudeRunnerProvider();

    for (const [runId, sessionId] of [["p1", "s1"], ["p2", "s2"], ["p3", "s3"]] as const) {
      q.push([{ type: "system", session_id: sessionId }, ok]);
      const events = fakeEvents();
      await provider.start({ ...spec, runId }, events);
      await vi.waitFor(() => expect(events.onCompleted).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    }
    // p1 was the least-recently-used entry when p3 pushed the cache (cap 2)
    // past its bound — it's the one that must have been evicted, not p2/p3.

    // start() itself only constructs the handle — the actual query() call now
    // happens after an async repo-hook scan (launch(), see claude.ts), so wait
    // for it to land rather than reading q.fn synchronously after start().
    let before = q.fn.mock.calls.length;
    await provider.start({ ...spec, runId: "fork-of-p1", parentId: "p1" }, fakeEvents());
    await vi.waitFor(() => expect(q.fn.mock.calls.length).toBeGreaterThan(before), { timeout: 2000, interval: 20 });
    const forkOfEvicted = lastQueryOptions(q.fn);
    expect(forkOfEvicted.resume).toBeUndefined(); // evicted — starts fresh, doesn't error
    expect(forkOfEvicted.forkSession).toBeUndefined();

    before = q.fn.mock.calls.length;
    await provider.start({ ...spec, runId: "fork-of-p3", parentId: "p3" }, fakeEvents());
    await vi.waitFor(() => expect(q.fn.mock.calls.length).toBeGreaterThan(before), { timeout: 2000, interval: 20 });
    const forkOfRecent = lastQueryOptions(q.fn);
    expect(forkOfRecent.resume).toBe("s3"); // still cached — real resume
    expect(forkOfRecent.forkSession).toBe(true);
  });
});
