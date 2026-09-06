// tests/project-instructions.test.ts already proves the orchestrator prefixes
// Project.instructions onto StartSpec.task (via withInstructions) for both
// assignTask and forkAgent. This file closes the LAST link — per vendor,
// does StartSpec.task actually reach what the runner's process/SDK receives,
// unmodified? StartSpec.task is vendor-neutral (the orchestrator builds it
// once, before provider.start()), so a single project-instructions-shaped
// marker string flowing through spec.task and landing verbatim in each
// vendor's argv/stdin/prompt is sufficient proof — no vendor-specific
// instructions plumbing exists (or is needed).
import { describe, it, expect, vi, afterEach } from "vitest";
import { codex } from "../packages/runner-sdk/src/codex.js";
import { gemini } from "../packages/runner-sdk/src/gemini.js";
import { hermes } from "../packages/runner-sdk/src/hermes.js";
import { aider } from "../packages/runner-sdk/src/aider.js";
import { ClaudeRunnerProvider, __setClaudeTestHooks } from "../packages/runner-sdk/src/claude.js";
import type { RunnerEvents, StartSpec } from "../packages/runner-sdk/src/types.js";

const INSTRUCTIONS_MARKER =
  "=== PROJECT INSTRUCTIONS (apply to every task in this project) ===\nAlways use tabs, never semicolons.\n\n=== TASK ===\nAdd a health check endpoint";

const baseSpec: StartSpec = {
  runId: "a1",
  projectId: "p1",
  task: INSTRUCTIONS_MARKER,
  model: "sonnet-4.6",
  branch: "agent/a1",
};

describe("CLI vendors: spec.task (with instructions already prefixed) reaches the launch command verbatim", () => {
  it("codex: buildArgs embeds spec.task unmodified", () => {
    expect(codex.buildArgs(baseSpec)).toContain(INSTRUCTIONS_MARKER);
  });

  it("gemini: buildArgs embeds spec.task unmodified", () => {
    expect(gemini.buildArgs(baseSpec)).toContain(INSTRUCTIONS_MARKER);
  });

  it("hermes: buildArgs embeds spec.task unmodified", () => {
    expect(hermes.buildArgs(baseSpec)).toContain(INSTRUCTIONS_MARKER);
  });

  it("aider: buildArgs embeds spec.task unmodified", () => {
    expect(aider.buildArgs(baseSpec)).toContain(INSTRUCTIONS_MARKER);
  });
});

// Claude: the SDK query() call takes a streaming `prompt` (an async iterable of
// user messages, not a plain string — see createInputStream in claude.ts). The
// runner's constructor pushes its initialPrompt (which embeds spec.task) onto
// that stream BEFORE calling query(), so we capture the mocked query() call and
// read the first message actually queued.
function scriptedQuery() {
  const fn = vi.fn(() => {
    async function* gen() {
      /* never yields — the test only inspects the call args, not a run to completion */
    }
    return Object.assign(gen(), { interrupt: async () => undefined });
  });
  return fn;
}

function fakeEvents(): RunnerEvents {
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
  };
}

afterEach(() => __setClaudeTestHooks(null));

describe("Claude: spec.task (with instructions already prefixed) reaches the SDK's initial prompt", () => {
  it("the first message pushed to query()'s streaming prompt contains the instructions banner", async () => {
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q as never });

    await new ClaudeRunnerProvider().start({ ...baseSpec, apiKey: "test-key" }, fakeEvents());
    // start() returns before query() is actually called — the main run is
    // gated behind an async repo-hook scan (launch() awaits scanRepoHooks()
    // before calling queryImpl(), fire-and-forget from the constructor; see
    // claude.ts). Wait for the real call rather than assuming it's
    // synchronous with start() resolving.
    await vi.waitFor(() => expect(q).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 20 });
    const call = q.mock.calls[0]![0] as { prompt: AsyncIterable<{ message: { content: string } }> };
    const iter = call.prompt[Symbol.asyncIterator]();
    const { value: firstMessage } = await iter.next();
    expect(firstMessage.message.content).toContain(INSTRUCTIONS_MARKER);
  });
});
