// The live-preview reverse proxy makes a loopback dev server reachable at
// /p/<token>/ on Skynet's public origin — and, crucially, forwards with the Host
// rewritten to loopback so Vite's allowedHosts accepts it. These pin the pure
// bits: token extraction from the path, and public-origin learning (env wins;
// loopback ignored).
import { describe, it, expect, beforeEach } from "vitest";
import { previewTokenOf } from "../apps/server/src/preview/preview-proxy.js";
import { recordPublicOrigin, publicOrigin, __resetPublicOrigin } from "../apps/server/src/preview/public-origin.js";

describe("previewTokenOf", () => {
  it("extracts the token from a /p/<token>/… path", () => {
    expect(previewTokenOf("/p/abc123/")).toBe("abc123");
    expect(previewTokenOf("/p/abc123/@vite/client")).toBe("abc123");
    expect(previewTokenOf("/p/abc-_.9/index.html?x=1")).toBe("abc-_.9");
    expect(previewTokenOf("/p/tok")).toBe("tok");
  });
  it("returns null for non-preview paths", () => {
    expect(previewTokenOf("/api/snapshot")).toBeNull();
    expect(previewTokenOf("/p/")).toBeNull();
    expect(previewTokenOf("/")).toBeNull();
  });
});

describe("public origin learning", () => {
  beforeEach(() => {
    delete process.env.SKYNET_PUBLIC_URL;
    delete process.env.SKYNET_PREVIEW_BASE_URL;
    __resetPublicOrigin();
  });

  it("learns from forwarded proto+host, ignoring loopback", () => {
    recordPublicOrigin("https", "skynet.example.com");
    expect(publicOrigin()).toBe("https://skynet.example.com");
  });

  it("ignores loopback/local hosts (desktop stays loopback-only)", () => {
    recordPublicOrigin("http", "localhost:8080");
    recordPublicOrigin("http", "127.0.0.1:8080");
    expect(publicOrigin()).toBeUndefined();
  });

  it("takes the first value from a comma-joined forwarded header", () => {
    recordPublicOrigin("https,http", "skynet.example.com, internal", undefined);
    expect(publicOrigin()).toBe("https://skynet.example.com");
  });

  it("an explicit env origin wins over the learned one", () => {
    recordPublicOrigin("https", "learned.example.com");
    process.env.SKYNET_PUBLIC_URL = "https://pinned.example.com/";
    expect(publicOrigin()).toBe("https://pinned.example.com"); // trailing slash trimmed
  });

  it("falls back to Host when no forwarded host is present", () => {
    recordPublicOrigin(undefined, undefined, "app.example.com");
    expect(publicOrigin()).toBe("https://app.example.com"); // defaults to https
  });
});
