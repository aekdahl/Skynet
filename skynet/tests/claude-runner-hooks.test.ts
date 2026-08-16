// Options.settingSources controls which filesystem config the SDK loads for a
// session; omitting it (the SDK's own default) loads EVERYTHING, including a
// repo's own `.claude/settings.json` — whose `hooks` block runs real shell
// commands, NOT gated by canUseTool. claude.ts now sets settingSources on
// every query() explicitly, and gates the main run behind a repo-hook scan
// before the session (and any hooks it would load) can start. See the
// "Filesystem settings sources" block and scanRepoHooks()/launch() in
// packages/runner-sdk/src/claude.ts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeRunnerProvider,
  __setClaudeTestHooks,
} from "../packages/runner-sdk/src/claude.js";
import type { RunnerEvents } from "../packages/runner-sdk/src/types.js";

// Same scripted stand-in as claude-runner-retry.test.ts (pnpm gives runner-sdk
// its own copy of the SDK, so a plain vi.mock wouldn't reach claude.ts's import).
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

const sys = { type: "system", session_id: "s1" };
const ok = { type: "result", subtype: "success", is_error: false, num_turns: 1 };

const dirs: string[] = [];
function fixtureRepo(withHook: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "skynet-hook-fixture-"));
  dirs.push(dir);
  if (withHook) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo pwned >> /tmp/skynet-hook-marker" }] },
          ],
        },
      }),
    );
  }
  return dir;
}

afterEach(() => {
  __setClaudeTestHooks(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Claude runner: filesystem settingSources", () => {
  it("passes settingSources: ['project'] to query() for the main run", async () => {
    const cwd = fixtureRepo(false); // no .claude/settings.json — nothing to gate on
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([sys, ok]);
    const events = fakeEvents();

    await new ClaudeRunnerProvider().start(
      { runId: "a1", projectId: "p1", task: "t", model: "sonnet-4.6", branch: "agent/a1", apiKey: "k", cwd },
      events,
    );
    await vi.waitFor(() => expect(q.fn).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 20 });

    const options = q.fn.mock.calls[0]![0]!.options as { settingSources?: string[] };
    expect(options.settingSources).toEqual(["project"]);
  });

  it("a repo with no lifecycle hooks starts immediately — no gate raised", async () => {
    const cwd = fixtureRepo(false);
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([sys, ok]);
    const events = fakeEvents();

    await new ClaudeRunnerProvider().start(
      { runId: "a1", projectId: "p1", task: "t", model: "sonnet-4.6", branch: "agent/a1", apiKey: "k", cwd },
      events,
    );
    await vi.waitFor(() => expect(events.onCompleted).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onHitl).not.toHaveBeenCalled();
  });
});

describe("Claude runner: repo-hook gate", () => {
  it("a repo-defined lifecycle hook pauses on an approval HITL BEFORE the session starts", async () => {
    const cwd = fixtureRepo(true);
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([sys, ok]); // would run if/when approved — never consumed here
    const events = fakeEvents();

    await new ClaudeRunnerProvider().start(
      { runId: "a1", projectId: "p1", task: "t", model: "sonnet-4.6", branch: "agent/a1", apiKey: "k", cwd },
      events,
    );
    await vi.waitFor(() => expect(events.onHitl).toHaveBeenCalled(), { timeout: 2000, interval: 20 });

    expect(events.onStatus).toHaveBeenCalledWith("a1", "waiting");
    const raise = events.onHitl.mock.calls[0]![1] as { kind: string; risk: string; command: string | null };
    expect(raise.kind).toBe("approval");
    expect(raise.risk).toBe("high");
    expect(raise.command).toContain("echo pwned >> /tmp/skynet-hook-marker");
    // The gated session must NOT have started — the hook hasn't been reviewed yet.
    expect(q.fn).not.toHaveBeenCalled();
    expect(events.onCompleted).not.toHaveBeenCalled();
  });

  it("rejecting the hook gate fails the run — the session never starts", async () => {
    const cwd = fixtureRepo(true);
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([sys, ok]);
    const events = fakeEvents();

    const handle = await new ClaudeRunnerProvider().start(
      { runId: "a1", projectId: "p1", task: "t", model: "sonnet-4.6", branch: "agent/a1", apiKey: "k", cwd },
      events,
    );
    await vi.waitFor(() => expect(events.onHitl).toHaveBeenCalled(), { timeout: 2000, interval: 20 });

    await handle.resume({ action: "reject", optionIndex: null, guidance: null, by: "op-1", at: 1 });

    await vi.waitFor(() => expect(events.onFailed).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onFailed).toHaveBeenCalledWith("a1", expect.stringContaining("did not approve"));
    expect(events.onCompleted).not.toHaveBeenCalled();
    expect(q.fn).not.toHaveBeenCalled(); // never reached the SDK at all
  });

  it("approving the hook gate starts the session (with settingSources: ['project'] intact)", async () => {
    const cwd = fixtureRepo(true);
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([sys, ok]);
    const events = fakeEvents();

    const handle = await new ClaudeRunnerProvider().start(
      { runId: "a1", projectId: "p1", task: "t", model: "sonnet-4.6", branch: "agent/a1", apiKey: "k", cwd },
      events,
    );
    await vi.waitFor(() => expect(events.onHitl).toHaveBeenCalled(), { timeout: 2000, interval: 20 });

    await handle.resume({ action: "approve", optionIndex: null, guidance: null, by: "op-1", at: 1 });

    await vi.waitFor(() => expect(events.onCompleted).toHaveBeenCalled(), { timeout: 2000, interval: 20 });
    expect(events.onFailed).not.toHaveBeenCalled();
    expect(q.fn).toHaveBeenCalledTimes(1);
    const options = q.fn.mock.calls[0]![0]!.options as { settingSources?: string[] };
    expect(options.settingSources).toEqual(["project"]);
  });
});
