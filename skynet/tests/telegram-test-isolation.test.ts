// A test run must never reach the real Telegram API.
//
// Found live, and genuinely alarming: the operator received
// "Skynet login code: NNNNNN" messages with nobody logging in. The cause was
// not an intrusion — tests/auth-mfa-*.test.ts deliberately force MFA on and
// POST /api/auth/login with valid credentials. On a laptop that's inert (no
// bot token configured, so the login route's `if (token && chatId)` guard
// skips the send), but the suite also runs INSIDE the production container —
// an agent working on this repo runs `pnpm test` there — where
// SKYNET_TELEGRAM_BOT_TOKEN / _OWNER_CHAT_ID are real. Those tests then sent
// genuine one-time codes to the operator's phone.
//
// The guard lives at the outbound boundary (TelegramClient) rather than in
// each test on purpose: it covers every existing AND future test, and can't be
// defeated by a new test forgetting to stub the config. These pin that.
import { describe, it, expect, vi, afterEach } from "vitest";
import { TelegramClient } from "../apps/server/src/telegram/client.js";

const client = () => new TelegramClient("fake-token-should-never-be-used");

afterEach(() => vi.unstubAllGlobals());

describe("TelegramClient — inert under test, whatever the environment holds", () => {
  it("sendMessage makes NO network call and returns a benign stub", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sent = await client().sendMessage("12345", "Skynet login code: 000000");
    // The exact failure that reached a real phone.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent).toEqual({ chatId: "12345", messageId: 0 });
  });

  it("getUpdates makes no network call and yields nothing to act on", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await client().getUpdates(0, 1)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("every other outbound method is inert too — not just the one that bit us", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const c = client();
    await c.editMessageText("1", 2, "x");
    await c.answerCallbackQuery("cb");
    await c.editMessageReplyMarkup("1", 2, null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the guard keys off the TEST environment, not on Telegram being unconfigured", async () => {
    // The original bug's shape: config IS fully populated (as in production),
    // and the code path is reached — the send must still not go out.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(process.env.VITEST !== undefined || process.env.NODE_ENV === "test").toBe(true);
    await new TelegramClient("1234567:REAL-LOOKING-TOKEN").sendMessage("999", "code");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
