// settingsContext() is the LIVE, secret-safe settings grounding Steward now gets
// so it can answer "is autonomy on?", "which approval level is the default?",
// "is Telegram control on?" from real runtime config instead of the committed repo
// docs. These tests pin the two invariants that make it safe to drop into the
// assistant prompt: real knobs are surfaced, and secret VALUES never are.
import { describe, it, expect } from "vitest";
import { settingsContext } from "../apps/server/src/settings/env-settings.js";

describe("settingsContext — live, secret-safe settings grounding", () => {
  it("surfaces runtime config knobs and non-secret env values", async () => {
    process.env.CODEX_BIN = "/opt/bin/codex";
    try {
      const s = await settingsContext();
      // Read-only runtime knobs come straight from live config.
      expect(s).toContain("Default approval level");
      expect(s).toContain("Autonomy loop");
      expect(s).toContain("MCP bootstrap token");
      expect(s).toContain("Backends:");
      // A non-secret whitelisted env value is surfaced verbatim.
      expect(s).toContain("/opt/bin/codex");
    } finally {
      delete process.env.CODEX_BIN;
    }
  });

  it("shows a set secret as 'set' and NEVER leaks its value", async () => {
    process.env.SKYNET_TELEGRAM_BOT_TOKEN = "123456:SUPERSECRET-token";
    try {
      const s = await settingsContext();
      expect(s).toMatch(/Bot token: set/);
      expect(s).not.toContain("SUPERSECRET");
      expect(s).not.toContain("123456:");
    } finally {
      delete process.env.SKYNET_TELEGRAM_BOT_TOKEN;
    }
  });

  it("shows an unset secret as 'not set'", async () => {
    delete process.env.SKYNET_TELEGRAM_BOT_TOKEN;
    const s = await settingsContext();
    expect(s).toMatch(/Bot token: not set/);
  });
});
