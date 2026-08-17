// The opt-in OS sandbox wrapper (SKYNET_RUNNER_SANDBOX) must be a pure no-op
// when disabled, and when enabled must construct a command that still runs the
// original vendor binary while confining writes to the worktree. We assert the
// exact command shape rather than actually spawning a sandbox (which is
// platform-specific and best-effort). Also guards that "hermes" is a registered
// provider so the fleet lists it.
import { describe, it, expect, afterEach } from "vitest";
import { wrapForSandbox } from "../packages/runner-sdk/src/sandbox.js";
import { DEFAULT_PROVIDERS, ProviderId } from "@skynet/shared";

const KEY = "SKYNET_RUNNER_SANDBOX";
const original = process.env[KEY];
afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe("wrapForSandbox", () => {
  it("is a pure passthrough when the flag is off", () => {
    delete process.env[KEY];
    const w = wrapForSandbox("gemini", ["-p", "do X"], { cwd: "/work/wt" });
    expect(w.bin).toBe("gemini");
    expect(w.args).toEqual(["-p", "do X"]);
    expect(w.sandboxed).toBe(false);
    expect(w.note).toBe("");
  });

  it("when enabled, either wraps the original command or falls back with a note", () => {
    process.env[KEY] = "1";
    const cwd = "/work/wt";
    const w = wrapForSandbox("gemini", ["-p", "do X"], { cwd });
    // Always explains itself when opted in.
    expect(w.note).not.toBe("");
    if (w.sandboxed) {
      // The wrapper binary differs, but the original command is still invoked…
      expect(w.bin).not.toBe("gemini");
      expect(w.args).toContain("gemini");
      expect(w.args).toContain("-p");
      expect(w.args).toContain("do X");
      // …and the worktree is named in the confinement config (profile or bind).
      expect(w.args.some((a) => a.includes(cwd))).toBe(true);
    } else {
      // No sandbox tool on this platform → runs unsandboxed, but says so.
      expect(w.bin).toBe("gemini");
      expect(w.note.toLowerCase()).toContain("unsandboxed");
    }
  });
});

describe("hermes provider registration", () => {
  it("is a valid ProviderId and appears in the default catalog", () => {
    expect(ProviderId.safeParse("hermes").success).toBe(true);
    const entry = DEFAULT_PROVIDERS.find((p) => p.id === "hermes");
    expect(entry).toBeDefined();
    expect(entry!.models.length).toBeGreaterThan(0);
  });
});

describe("opencode provider registration", () => {
  it("is a valid ProviderId and appears in the default catalog", () => {
    expect(ProviderId.safeParse("opencode").success).toBe(true);
    const entry = DEFAULT_PROVIDERS.find((p) => p.id === "opencode");
    expect(entry).toBeDefined();
    expect(entry!.models.length).toBeGreaterThan(0);
  });

  it("the OS sandbox whitelists opencode's XDG state dir (.local/share/opencode)", () => {
    process.env[KEY] = "1";
    const w = wrapForSandbox("opencode", ["run", "--format", "json", "do X"], { cwd: "/work/wt" });
    if (w.sandboxed) {
      expect(w.args.some((a) => a.includes(".local/share/opencode") || a.includes(".local\\share\\opencode"))).toBe(true);
    }
  });
});
