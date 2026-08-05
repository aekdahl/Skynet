// Runner resource cap: a wall-clock ceiling force-fails a runaway/hung agent so
// it can't hold its fleet slot and burn tokens forever. We assert (1) the env
// parsing in caps.ts, and (2) that a real CLI runner spawning a long-lived
// subprocess (`sleep`) is force-failed with an honest reason when the cap fires,
// while a fast subprocess that exits first is NOT capped.
import { describe, it, expect, afterEach, vi } from "vitest";
import type { ProviderId } from "@skynet/shared";
import { runtimeCapMs, idleCapMs, fmtDuration } from "../packages/runner-sdk/src/caps.js";
import { CliRunnerProvider, type CliVendor } from "../packages/runner-sdk/src/cli-runner.js";
import type { RunnerEvents, StartSpec } from "../packages/runner-sdk/src/types.js";

const KEY = "SKYNET_RUNNER_MAX_RUNTIME_MS";
const IDLE_KEY = "SKYNET_RUNNER_IDLE_MS";
const original = process.env[KEY];
const originalIdle = process.env[IDLE_KEY];
const restore = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};
afterEach(() => {
  restore(KEY, original);
  restore(IDLE_KEY, originalIdle);
  vi.restoreAllMocks();
});

describe("runtimeCapMs", () => {
  it("defaults to 30 minutes when unset", () => {
    delete process.env[KEY];
    expect(runtimeCapMs()).toBe(30 * 60 * 1000);
  });
  it("honors a positive override", () => {
    process.env[KEY] = "5000";
    expect(runtimeCapMs()).toBe(5000);
  });
  it("treats 0 / negative / garbage as disabled", () => {
    for (const v of ["0", "-1", "nope"]) {
      process.env[KEY] = v;
      expect(runtimeCapMs()).toBe(0);
    }
  });
  it("formats durations for the failure message", () => {
    expect(fmtDuration(120000)).toBe("2m");
    expect(fmtDuration(4000)).toBe("4s");
  });
});

describe("idleCapMs", () => {
  it("defaults to 8 minutes when unset", () => {
    delete process.env[IDLE_KEY];
    expect(idleCapMs()).toBe(8 * 60 * 1000);
  });
  it("honors a positive override", () => {
    process.env[IDLE_KEY] = "1500";
    expect(idleCapMs()).toBe(1500);
  });
  it("treats 0 / negative / garbage as disabled", () => {
    for (const v of ["0", "-1", "nope"]) {
      process.env[IDLE_KEY] = v;
      expect(idleCapMs()).toBe(0);
    }
  });
});

// A vendor that runs a long-lived subprocess so the cap (not the process) ends
// the run. `sleep` is POSIX-ubiquitous; args are overridable for the fast case.
class SleepProvider extends CliRunnerProvider {
  readonly id: ProviderId = "gemini"; // any registered CLI provider id
  constructor(private seconds: string) {
    super();
  }
  protected vendor(): CliVendor {
    const seconds = this.seconds;
    return {
      id: "gemini",
      bin: "sleep",
      installHint: "n/a",
      buildArgs: () => [seconds],
      parseLine: (line) => ({ kind: "log", line }),
    };
  }
}

function collect() {
  const events: { failed?: string; completed?: boolean; statuses: string[] } = { statuses: [] };
  const done = { resolve: null as null | (() => void) };
  const wait = new Promise<void>((r) => (done.resolve = r));
  const ev: RunnerEvents = {
    onLog: () => {},
    onProgress: () => {},
    onHeartbeat: () => {},
    onStatus: (_id, s) => events.statuses.push(s),
    onHitl: () => {},
    onChatReply: () => {},
    onCompleted: () => { events.completed = true; done.resolve?.(); },
    onFailed: (_id, reason) => { events.failed = reason; done.resolve?.(); },
    onUsage: () => {},
  };
  return { events, ev, wait };
}

const spec = (): StartSpec => ({
  runId: "r-cap", projectId: "p", task: "sleep", model: "m", branch: "agent/r-cap", cwd: process.cwd(),
});

describe("CLI runner wall-clock cap", () => {
  it("force-fails a run that outlives the cap", async () => {
    process.env[KEY] = "250"; // 250ms ceiling
    const { events, ev, wait } = collect();
    await new SleepProvider("30").start(spec(), ev); // would sleep 30s
    await wait;
    expect(events.failed).toMatch(/exceeded max runtime/);
    expect(events.completed).toBeUndefined();
  }, 10_000);

  it("does not cap a run that finishes before the ceiling", async () => {
    process.env[KEY] = "5000"; // 5s ceiling
    const { events, ev, wait } = collect();
    await new SleepProvider("0.1").start(spec(), ev); // exits in ~100ms
    await wait;
    expect(events.completed).toBe(true);
    expect(events.failed).toBeUndefined();
  }, 10_000);

  it("force-fails a run that goes idle (no output past the idle window)", async () => {
    process.env[KEY] = "0"; // disable the total cap so the IDLE watchdog is what fires
    process.env[IDLE_KEY] = "250"; // 250ms of no output → presumed stalled
    const { events, ev, wait } = collect();
    await new SleepProvider("30").start(spec(), ev); // never prints a line → goes idle
    await wait;
    expect(events.failed).toMatch(/no progress/);
    expect(events.failed).toMatch(/stalled/);
    expect(events.completed).toBeUndefined();
  }, 10_000);
});
