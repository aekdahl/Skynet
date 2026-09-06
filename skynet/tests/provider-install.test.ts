// Provider CLI installer — spawns the fixed per-provider install command and
// streams stdout/stderr as `line` events. The command is chosen by the server
// from a table indexed on provider id — never derived from the client — so
// there's no injection surface. These tests exercise the runner against a
// harmless spawnable (`node -e`) via SKYNET_TEST_INSTALL_ARGV so we don't
// actually `npm i -g` anything.
import { describe, it, expect } from "vitest";
import { installProviderCli } from "../apps/server/src/provider-install.js";
import { installCommandFor } from "../apps/server/src/provider-requirements.js";

describe("provider-install", () => {
  it("refuses providers without a scriptable install (returns an error event)", async () => {
    // `claude` runs in-process (no CLI). Its install entry is null.
    expect(installCommandFor("claude")).toBeNull();
    const events: { kind: string; text?: string }[] = [];
    for await (const ev of installProviderCli("claude")) events.push({ kind: ev.kind, text: ev.text });
    // No `line`s spawned; a single explanatory `error` is emitted.
    expect(events.some((e) => e.kind === "error")).toBe(true);
    expect(events.find((e) => e.kind === "error")?.text).toMatch(/no auto-install/i);
    // Never `done` when we didn't spawn — the caller sees no exit info to interpret.
    expect(events.some((e) => e.kind === "done")).toBe(false);
  });

  it("exposes the expected fixed commands for scriptable providers", () => {
    // Locking these command strings so a future change is a deliberate one:
    // the argv the SERVER will spawn is transparent to the operator (it's
    // shown in the UI verbatim before running).
    expect(installCommandFor("codex")).toEqual({ packageManager: "npm", command: "npm install -g @openai/codex" });
    expect(installCommandFor("gemini")).toEqual({ packageManager: "npm", command: "npm install -g @google/gemini-cli" });
    // The GitHub Copilot CLI is a standalone npm package now, so it's scriptable too.
    expect(installCommandFor("copilot")).toEqual({ packageManager: "npm", command: "npm install -g @github/copilot" });
    // OpenCode's CLI is the `opencode-ai` npm package (verified live against
    // opencode-ai@1.18.18) — also a plain npm install.
    expect(installCommandFor("opencode")).toEqual({ packageManager: "npm", command: "npm install -g opencode-ai" });
    // The rest stay null: cursor and kimi are each a `curl | bash` script,
    // hermes is a manual download, and aider is a pip/pipx install — none is a
    // plain npm install the no-shell installer will run.
    expect(installCommandFor("cursor")).toBeNull();
    expect(installCommandFor("hermes")).toBeNull();
    expect(installCommandFor("kimi")).toBeNull();
    expect(installCommandFor("aider")).toBeNull();
  });
});
