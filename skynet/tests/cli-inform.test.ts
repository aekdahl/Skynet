// `inform` on the shared CLI runner base (cli-runner.ts — covers Codex, Gemini,
// Hermes): unlike Claude's live SDK session, these vendors are one-shot CLI
// processes with no "append to transcript, no extra turn" primitive — so a
// queued note is BUFFERED and PREPENDED to the next real stdin write the run
// would make anyway (a chat message or resumed guidance), never written on its
// own. We drive a REAL child process (Node itself, echoing stdin line-by-line —
// same "spawn something real, observe real stdout" style as
// runner-runtime-cap.test.ts) rather than mocking child_process, so this
// exercises the actual stdin-write path, not a stand-in for it.
import { describe, it, expect, vi } from "vitest";
import type { ProviderId } from "@skynet/shared";
import { CliRunnerProvider, type CliVendor } from "../packages/runner-sdk/src/cli-runner.js";
import type { RunnerEvents, StartSpec } from "../packages/runner-sdk/src/types.js";

// Echoes each stdin line back on stdout, unbuffered, as soon as it arrives —
// so a write we make is observable via onLog almost immediately, with no libc
// block-buffering ambiguity (plain `cat` piped to a non-tty can withhold
// output for a while, which would make this test flaky).
const ECHO_SCRIPT =
  "require('readline').createInterface({input:process.stdin,terminal:false})" +
  ".on('line',l=>process.stdout.write(l+'\\n'))";

class EchoProvider extends CliRunnerProvider {
  readonly id: ProviderId = "gemini"; // any registered CLI provider id
  protected vendor(): CliVendor {
    return {
      id: "gemini",
      bin: process.execPath, // node itself — always present, always the same binary
      installHint: "n/a",
      buildArgs: () => ["-e", ECHO_SCRIPT],
      parseLine: (line) => ({ kind: "log", line }),
      encodeMessage: (text) => text,
      encodeDecision: (decision) => decision?.guidance ?? null,
    };
  }
}

function collectLogs() {
  const logs: string[] = [];
  const ev: RunnerEvents = {
    onLog: (_id, line) => logs.push(line),
    onProgress: () => {},
    onHeartbeat: () => {},
    onStatus: () => {},
    onHitl: () => {},
    onChatReply: () => {},
    onCompleted: () => {},
    onFailed: () => {},
    onUsage: () => {},
  };
  return { logs, ev };
}

const spec = (): StartSpec => ({
  runId: "r-inform", projectId: "p", task: "echo", model: "m", branch: "agent/r-inform", cwd: process.cwd(),
});

describe("CliRunnerHandle.inform", () => {
  it("queues a note silently, then prepends it to the NEXT real stdin write — never writes on its own", async () => {
    const { logs, ev } = collectLogs();
    const handle = await new EchoProvider().start(spec(), ev);
    expect(handle.inform).toBeTypeOf("function");

    await handle.inform!("heads up: the shared auth module moved to packages/auth");
    // Give the child a beat to prove it — nothing should be on stdout yet,
    // since queuing a note never writes to stdin by itself.
    await new Promise((r) => setTimeout(r, 150));
    expect(logs.some((l) => l.includes("heads up"))).toBe(false);

    await handle.message("keep going");
    await vi.waitFor(() => expect(logs.some((l) => l.includes("keep going"))).toBe(true), {
      timeout: 3000,
      interval: 20,
    });

    // The note rode the SAME write as the chat message, landing as its own
    // (earlier) line — prepended, not appended, and not merged into one line.
    const noteIdx = logs.findIndex((l) => l.includes("heads up: the shared auth module moved to packages/auth"));
    const chatIdx = logs.findIndex((l) => l === "keep going");
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(chatIdx).toBeGreaterThan(noteIdx);

    await handle.stop();
  }, 10_000);

  it("a message with no queued note behaves exactly as before — no note line, no prefix", async () => {
    const { logs, ev } = collectLogs();
    const handle = await new EchoProvider().start(spec(), ev);

    await handle.message("just chat, nothing queued");
    await vi.waitFor(() => expect(logs).toContain("just chat, nothing queued"), { timeout: 3000, interval: 20 });

    // Exactly the chat text on stdout — no note line, no prefix, no extra echo.
    expect(logs.filter((l) => !l.startsWith("picked up"))).toEqual(["just chat, nothing queued"]);

    await handle.stop();
  }, 10_000);

  it("multiple queued notes before any write all ride the same next write, each on its own line", async () => {
    const { logs, ev } = collectLogs();
    const handle = await new EchoProvider().start(spec(), ev);

    await handle.inform!("note one");
    await handle.inform!("note two");
    await handle.message("go");
    await vi.waitFor(() => expect(logs.some((l) => l === "go")).toBe(true), { timeout: 3000, interval: 20 });

    expect(logs.some((l) => l.includes("note one"))).toBe(true);
    expect(logs.some((l) => l.includes("note two"))).toBe(true);
    expect(logs.at(-1)).toBe("go"); // the real message always lands last

    await handle.stop();
  }, 10_000);

  it("a finished run drops a queued note — nothing left to ride, no throw", async () => {
    const { ev } = collectLogs();
    const handle = await new EchoProvider().start(spec(), ev);
    await handle.stop();

    await expect(handle.inform!("too late")).resolves.toBeUndefined();
  }, 10_000);
});
