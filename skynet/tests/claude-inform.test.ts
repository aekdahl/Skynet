// `inform` on the Claude runner: a note queued via handle.inform() must be
// pushed into the SDK's streaming-input session with `shouldQuery: false` —
// the Agent SDK's own documented contract for "append to the transcript
// without triggering an assistant turn; merge into whichever real turn comes
// next" (packages/runner-sdk/node_modules/@anthropic-ai/claude-agent-sdk/
// sdk.d.ts, SDKUserMessage.shouldQuery). We assert on the CONSTRUCTED message
// object pulled straight off the captured input stream — not just that the
// call resolved — so a regression that silently drops the flag (and turns
// `inform` into a real extra turn, defeating the whole point) fails loudly.
//
// Same test-hook seam as claude-runner-retry.test.ts: pnpm gives runner-sdk
// its own copy of the SDK, so a plain vi.mock wouldn't reach claude.ts's
// import — __setClaudeTestHooks swaps the query() implementation instead.
import { describe, it, expect, afterEach, vi } from "vitest";
import { ClaudeRunnerProvider, __setClaudeTestHooks } from "../packages/runner-sdk/src/claude.js";
import type { RunnerEvents } from "../packages/runner-sdk/src/types.js";

function fakeEvents(): RunnerEvents {
  return {
    onLog: () => {},
    onProgress: () => {},
    onHeartbeat: () => {},
    onStatus: () => {},
    onHitl: () => {},
    onCompleted: () => {},
    onFailed: () => {},
    onChatReply: () => {},
    onUsage: () => {},
  };
}

const spec = {
  runId: "a1", projectId: "p1", task: "make it faster",
  model: "sonnet-4.6", branch: "agent/a1", apiKey: "test-key",
};

afterEach(() => __setClaudeTestHooks(null));

describe("ClaudeRunnerHandle.inform", () => {
  it("pushes shouldQuery:false — never a real turn — and rides the SAME stream a real chat message uses", async () => {
    // A query() stand-in that captures the streaming-input prompt and then
    // hangs (never yields a `result`) — the session stays live for the whole
    // test, exactly the state `inform()` (and `message()`) are meant for.
    let capturedPrompt: AsyncIterable<Record<string, unknown>> | undefined;
    const queryCalls: unknown[] = [];
    const queryFn = (args: { prompt: AsyncIterable<Record<string, unknown>> }) => {
      queryCalls.push(args);
      capturedPrompt = args.prompt;
      async function* gen(): AsyncGenerator<Record<string, unknown>> {
        yield { type: "system", session_id: "s1" };
        await new Promise(() => {}); // never resolves — the session stays open
      }
      return Object.assign(gen(), { interrupt: async () => undefined });
    };
    __setClaudeTestHooks({ query: queryFn as never });

    const provider = new ClaudeRunnerProvider();
    const handle = await provider.start(spec, fakeEvents());
    expect(handle.inform).toBeTypeOf("function");

    // start() now returns before query() is actually called — the main run
    // is gated behind an async repo-hook scan (launch() awaits scanRepoHooks()
    // before calling queryImpl(), fire-and-forget from the constructor; see
    // claude.ts). Wait for the real call, same pattern as
    // claude-runner-hooks.test.ts, rather than assuming it's synchronous with
    // start() resolving.
    await vi.waitFor(() => expect(queryCalls.length).toBeGreaterThan(0), { timeout: 2000, interval: 20 });

    // Drain the input stream we captured — one shared iterator, pulled in
    // order, exactly like the real query() would consume it.
    const iter = capturedPrompt![Symbol.asyncIterator]();

    // 1) The kickoff message (pushed synchronously in the constructor): a
    //    real turn, no shouldQuery flag.
    const kickoff = await iter.next();
    expect(kickoff.done).toBe(false);
    expect((kickoff.value as { shouldQuery?: boolean }).shouldQuery).toBeUndefined();

    // 2) inform() queues a note — shouldQuery:false, carrying the note text.
    await handle.inform!("heads up: the shared auth module moved to packages/auth");
    const informed = await iter.next();
    expect(informed.done).toBe(false);
    const informedMsg = informed.value as { shouldQuery?: boolean; message: { content: string } };
    expect(informedMsg.shouldQuery).toBe(false);
    expect(informedMsg.message.content).toContain("heads up: the shared auth module moved to packages/auth");

    // 3) A real chat message (message()) pushed onto the SAME stream carries
    //    NO shouldQuery flag — it's a genuine turn, unlike the note above.
    await handle.message("what's the status?");
    const chatted = await iter.next();
    expect(chatted.done).toBe(false);
    const chattedMsg = chatted.value as { shouldQuery?: boolean; message: { content: string } };
    expect(chattedMsg.shouldQuery).toBeUndefined();
    expect(chattedMsg.message.content).toContain("what's the status?");

    // query() (the SDK's own API call) was invoked exactly ONCE for the whole
    // session — informing (or chatting) never spins up a second live query;
    // every message, note or turn alike, rides the ONE open session.
    expect(queryCalls.length).toBe(1);

    await handle.stop(); // clear timers so the test process exits cleanly
  });

  it("drops a queued note once the session has finished — nothing left to ride", async () => {
    const queryFn = () => {
      async function* gen(): AsyncGenerator<Record<string, unknown>> {
        yield { type: "system", session_id: "s1" };
        yield { type: "result", subtype: "success", is_error: false, num_turns: 1 };
      }
      return Object.assign(gen(), { interrupt: async () => undefined });
    };
    __setClaudeTestHooks({ query: queryFn as never });

    const provider = new ClaudeRunnerProvider();
    const handle = await provider.start(spec, fakeEvents());
    // Let the finish() path run (the generator above completes immediately).
    await new Promise((r) => setTimeout(r, 20));

    // No throw, no hang — a finished session just has nothing left to attach to.
    await expect(handle.inform!("too late")).resolves.toBeUndefined();
  });
});
