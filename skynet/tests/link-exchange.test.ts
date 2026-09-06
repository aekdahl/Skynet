// Chat → canvas handoff (ROADMAP.md, hosted-only) — the short-lived,
// single-use exchange token minted alongside a Telegram notification's link.
// Pure unit tests of the Map-based store; no HTTP involved (see
// tests/handoff-route.test.ts for the route that consumes this).
import { describe, it, expect, afterEach } from "vitest";
import { createLinkExchange, consumeLinkExchange } from "../apps/server/src/auth/link-exchange.js";
import { config } from "../apps/server/src/config.js";

const PRINCIPAL = { workspaceId: "cyberdyne", operatorId: "telegram:123" };
const ORIG_TTL = config.handoffTtlMs;

afterEach(() => {
  config.handoffTtlMs = ORIG_TTL;
});

describe("createLinkExchange / consumeLinkExchange", () => {
  it("round-trips the principal and target hash", () => {
    const token = createLinkExchange(PRINCIPAL, "#/agent/r-123");
    const hit = consumeLinkExchange(token);
    expect(hit).toEqual({ principal: PRINCIPAL, hash: "#/agent/r-123" });
  });

  it("is single-use: a second consume of the same token returns undefined", () => {
    const token = createLinkExchange(PRINCIPAL, "#/agent/r-123");
    expect(consumeLinkExchange(token)).toBeDefined();
    expect(consumeLinkExchange(token)).toBeUndefined();
  });

  it("returns undefined for a token that was never minted", () => {
    expect(consumeLinkExchange("not-a-real-token")).toBeUndefined();
  });

  it("returns undefined once the TTL has elapsed — and still consumes it (single-use even when expired)", async () => {
    config.handoffTtlMs = 5; // 5ms — expires almost immediately
    const token = createLinkExchange(PRINCIPAL, "#/agent/r-123");
    await new Promise((r) => setTimeout(r, 20));
    expect(consumeLinkExchange(token)).toBeUndefined();
    // Re-consuming (had it somehow not expired) also fails — proves it was deleted, not just expiry-checked.
    config.handoffTtlMs = ORIG_TTL;
    expect(consumeLinkExchange(token)).toBeUndefined();
  });

  it("two tokens for different principals don't collide", () => {
    const a = createLinkExchange({ workspaceId: "w1", operatorId: "telegram:1" }, "#/agent/a");
    const b = createLinkExchange({ workspaceId: "w2", operatorId: "telegram:2" }, "#/agent/b");
    expect(consumeLinkExchange(a)).toEqual({ principal: { workspaceId: "w1", operatorId: "telegram:1" }, hash: "#/agent/a" });
    expect(consumeLinkExchange(b)).toEqual({ principal: { workspaceId: "w2", operatorId: "telegram:2" }, hash: "#/agent/b" });
  });
});
