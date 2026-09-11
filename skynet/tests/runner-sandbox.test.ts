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

  // `force` — the live-preview/Fly-deploy install-build step (preview/worktree.ts's
  // runToCompletion) opts out of the SKYNET_RUNNER_SANDBOX gate entirely: it must
  // not be able to run attacker-controlled shell unsandboxed just because the
  // fleet-wide flag happens to be off.
  describe("force", () => {
    it("is a pure passthrough with the flag OFF and force NOT set — unchanged from today", () => {
      delete process.env[KEY];
      const w = wrapForSandbox("/bin/sh", ["-c", "npm install"], { cwd: "/work/wt" });
      expect(w.bin).toBe("/bin/sh");
      expect(w.sandboxed).toBe(false);
      expect(w.note).toBe("");
    });

    it("with the flag OFF, force:true still attempts sandboxing (or explains why it can't)", () => {
      delete process.env[KEY];
      const cwd = "/work/wt";
      const w = wrapForSandbox("/bin/sh", ["-c", "npm install"], { cwd, force: true });
      // Same behavior as the flag being on — force bypasses only the opt-in gate,
      // the confinement logic itself (or the honest unsandboxed fallback) is identical.
      expect(w.note).not.toBe("");
      if (w.sandboxed) {
        expect(w.bin).not.toBe("/bin/sh");
        expect(w.args).toContain("/bin/sh");
        expect(w.args).toContain("-c");
        expect(w.args).toContain("npm install");
        expect(w.args.some((a) => a.includes(cwd))).toBe(true);
      } else {
        expect(w.bin).toBe("/bin/sh");
        expect(w.note.toLowerCase()).toContain("unsandboxed");
      }
    });

    it("force:true and the flag both on behaves exactly like the flag alone", () => {
      process.env[KEY] = "1";
      const cwd = "/work/wt";
      const withFlagOnly = wrapForSandbox("/bin/sh", ["-c", "npm install"], { cwd });
      const withBoth = wrapForSandbox("/bin/sh", ["-c", "npm install"], { cwd, force: true });
      expect(withBoth).toEqual(withFlagOnly);
    });
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

describe("kimi provider registration", () => {
  it("is a valid ProviderId and appears in the default catalog", () => {
    expect(ProviderId.safeParse("kimi").success).toBe(true);
    const entry = DEFAULT_PROVIDERS.find((p) => p.id === "kimi");
    expect(entry).toBeDefined();
    expect(entry!.models.length).toBeGreaterThan(0);
  });

  it("the OS sandbox whitelists kimi-code's dot-dir (~/.kimi-code, a single top-level dir like Claude/Codex)", () => {
    process.env[KEY] = "1";
    const w = wrapForSandbox("kimi", ["-p", "do X", "--output-format", "stream-json"], { cwd: "/work/wt" });
    if (w.sandboxed) {
      expect(w.args.some((a) => a.includes(".kimi-code"))).toBe(true);
    }
  });
});

describe("aider provider registration", () => {
  it("is a valid ProviderId and appears in the default catalog", () => {
    expect(ProviderId.safeParse("aider").success).toBe(true);
    const entry = DEFAULT_PROVIDERS.find((p) => p.id === "aider");
    expect(entry).toBeDefined();
    expect(entry!.models.length).toBeGreaterThan(0);
  });

  // No dot-dir sandbox assertion here (unlike kimi's ~/.kimi-code above) —
  // Aider's home-level footprint (a single ~/.aider.conf.yml, plus whatever
  // litellm caches under ~/.cache) isn't confirmed live; it isn't asserted as
  // whitelisted rather than guessed. See aider.ts's file header.
});
