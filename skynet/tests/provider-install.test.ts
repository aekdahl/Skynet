// Provider CLI installer — spawns the fixed per-provider install command and
// streams stdout/stderr as `line` events. The command is chosen by the server
// from a table indexed on provider id — never derived from the client — so
// there's no injection surface. These tests exercise the real spawn/stream/
// exit-code path by mocking `provider-requirements.js`'s `installCommandFor`
// to return a harmless `node -e ...` command for the "codex" id (via
// `vi.importActual`, so `probeBinOnPath`/`providerBin` stay real) — this way
// we cover the actual child_process plumbing without ever running `npm i -g`.
import { describe, it, expect, vi } from "vitest";
import { installProviderCli } from "../apps/server/src/provider-install.js";
import { installCommandFor } from "../apps/server/src/provider-requirements.js";

const mockState = vi.hoisted(() => ({
  command: undefined as { packageManager: "npm"; command: string } | null | undefined,
}));

vi.mock("../apps/server/src/provider-requirements.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../apps/server/src/provider-requirements.js")>();
  return {
    ...actual,
    // Only override "codex" when a test has armed mockState.command; every
    // other provider id (and "codex" when unarmed) falls through to the real
    // table so installCommandFor's normal behavior stays covered too.
    installCommandFor: (id: string) =>
      id === "codex" && mockState.command !== undefined ? mockState.command : actual.installCommandFor(id),
  };
});

describe("provider-install", () => {
  it("refuses providers without a scriptable install (returns an error event)", async () => {
    // `claude` runs in-process (no CLI). Its install entry is null.
    expect(installCommandFor("claude")).toBeNull();
    const events: { kind: string; text?: string }[] = [];
    for await (const ev of installProviderCli("claude")) events.push({ kind: ev.kind, text: ev.text });
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events.find((e) => e.kind === "error")?.text).toMatch(/no auto-install/i);
    expect(events.some((e) => e.kind === "done")).toBe(false);
  });

  it("exposes the expected fixed commands for scriptable providers", () => {
    expect(installCommandFor("codex")).toEqual({ packageManager: "npm", command: "npm install -g @openai/codex" });
    expect(installCommandFor("gemini")).toEqual({ packageManager: "npm", command: "npm install -g @google/gemini-cli" });
    expect(installCommandFor("copilot")).toEqual({ packageManager: "npm", command: "npm install -g @github/copilot" });
    expect(installCommandFor("opencode")).toEqual({ packageManager: "npm", command: "npm install -g opencode-ai" });
    expect(installCommandFor("cursor")).toBeNull();
    expect(installCommandFor("hermes")).toBeNull();
    expect(installCommandFor("kimi")).toBeNull();
  });

  it("streams stdout+stderr lines and reports a non-zero exit code on failure", async () => {
    // No spaces inside the script: installProviderCli parses argv with a plain
    // whitespace split (no shell, no quote-handling), so a quoted multi-word
    // -e script would get mangled into a literal-quoted no-op string.
    mockState.command = {
      packageManager: "npm",
      command: `node -e console.log('hi');console.error('oops');process.exitCode=3`,
    };
    try {
      const events: { kind: string; text?: string; exitCode?: number | null; binOnPath?: boolean }[] = [];
      for await (const ev of installProviderCli("codex" as any)) {
        events.push({ kind: ev.kind, text: ev.text, exitCode: ev.exitCode, binOnPath: ev.binOnPath });
      }

      // The echoed command is always the first event.
      expect(events[0]).toMatchObject({ kind: "line", text: `$ ${mockState.command.command}` });

      const lineTexts = events.filter((e) => e.kind === "line").map((e) => e.text);
      expect(lineTexts).toContain("hi");
      expect(lineTexts).toContain("oops");

      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      expect(done?.exitCode).toBe(3);
      expect(typeof done?.binOnPath).toBe("boolean");

      // No error event on a clean (if non-zero) exit — only "done" reports it.
      expect(events.some((e) => e.kind === "error")).toBe(false);
    } finally {
      mockState.command = undefined;
    }
  });

  it("reports exitCode 0 on success, and preserves line order within a single stream", async () => {
    mockState.command = {
      packageManager: "npm",
      command: `node -e console.log('line1');console.log('line2');console.log('line3')`,
    };
    try {
      const events: { kind: string; text?: string; exitCode?: number | null; binOnPath?: boolean }[] = [];
      for await (const ev of installProviderCli("codex" as any)) {
        events.push({ kind: ev.kind, text: ev.text, exitCode: ev.exitCode, binOnPath: ev.binOnPath });
      }

      const lineTexts = events.filter((e) => e.kind === "line").map((e) => e.text);
      // Order within the single (stdout) stream is preserved.
      expect(lineTexts).toEqual([`$ ${mockState.command.command}`, "line1", "line2", "line3"]);

      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();
      expect(done?.exitCode).toBe(0);
      expect(typeof done?.binOnPath).toBe("boolean");
    } finally {
      mockState.command = undefined;
    }
  });
});
