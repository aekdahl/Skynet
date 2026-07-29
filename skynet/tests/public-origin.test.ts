// The public origin drives phone-reachable preview links. It's learned from
// inbound requests (X-Forwarded-* behind the GCP LB) so no env is needed there,
// with SKYNET_PUBLIC_URL as an explicit override. Loopback is ignored so an
// admin's localhost/IAP-tunnel session can't clobber a real public host.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recordPublicOrigin, publicOrigin, __resetObservedOrigin } from "../apps/server/src/public-origin.js";

describe("public origin", () => {
  const saved = process.env.SKYNET_PUBLIC_URL;
  beforeEach(() => {
    delete process.env.SKYNET_PUBLIC_URL;
    __resetObservedOrigin();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SKYNET_PUBLIC_URL;
    else process.env.SKYNET_PUBLIC_URL = saved;
  });

  it("is undefined with nothing learned and no env", () => {
    expect(publicOrigin()).toBeUndefined();
  });

  it("learns the forwarded host (the LB case) and drops a trailing slash", () => {
    recordPublicOrigin("https", "preview.example.com");
    expect(publicOrigin()).toBe("https://preview.example.com");
  });

  it("ignores loopback hosts so a localhost session never clobbers a real host", () => {
    recordPublicOrigin("https", "skynet.example.com");
    recordPublicOrigin("http", "127.0.0.1:8080");
    recordPublicOrigin("http", "localhost:8080");
    expect(publicOrigin()).toBe("https://skynet.example.com");
  });

  it("defaults a missing/odd scheme to https", () => {
    recordPublicOrigin(undefined, "app.example.com");
    expect(publicOrigin()).toBe("https://app.example.com");
  });

  it("SKYNET_PUBLIC_URL overrides the learned origin (and is trimmed)", () => {
    recordPublicOrigin("https", "learned.example.com");
    process.env.SKYNET_PUBLIC_URL = "https://override.example.com/";
    expect(publicOrigin()).toBe("https://override.example.com");
  });
});
