// skynet:// OS-protocol deep links (desktop only — apps/desktop/main.cjs).
// The translation from a received skynet:// URL to the app's existing hash
// route is the one piece of this feature with a meaningful way to unit-test
// in this repo's current setup — it's pure and extracted into its own module
// (apps/desktop/deep-link.cjs) specifically so it can be. The rest (Electron
// event wiring: app.on("open-url"), second-instance argv, window creation) is
// covered by manual verification against the real packaged app instead — this
// repo has no harness for driving a live Electron process, and apps/desktop
// has no existing test setup to build on (see the PR that landed this).
import { describe, it, expect } from "vitest";
import { skynetUrlToHash, findSkynetUrlArg } from "../apps/desktop/deep-link.cjs";

describe("skynetUrlToHash", () => {
  it("translates each route shape verbatim onto routing.ts's hash form", () => {
    expect(skynetUrlToHash("skynet://agent/r-abc123")).toBe("#/agent/r-abc123");
    expect(skynetUrlToHash("skynet://project/p-1")).toBe("#/project/p-1");
    expect(skynetUrlToHash("skynet://fleet/agent-05")).toBe("#/fleet/agent-05");
    expect(skynetUrlToHash("skynet://queue")).toBe("#/queue");
    expect(skynetUrlToHash("skynet://home")).toBe("#/home");
  });

  it("a bare segment with no id has no trailing slash (#/fleet, not #/fleet/)", () => {
    expect(skynetUrlToHash("skynet://fleet")).toBe("#/fleet");
    expect(skynetUrlToHash("skynet://fleet/")).toBe("#/fleet");
  });

  it("returns null for a non-skynet: scheme (never routes an arbitrary URL)", () => {
    expect(skynetUrlToHash("https://example.com/agent/x")).toBeNull();
    expect(skynetUrlToHash("http://127.0.0.1:8099/#/agent/x")).toBeNull();
  });

  it("returns null for malformed input instead of throwing", () => {
    expect(skynetUrlToHash("not-a-url")).toBeNull();
    expect(skynetUrlToHash("")).toBeNull();
    expect(skynetUrlToHash("skynet://")).toBeNull();
  });

  it("an unrecognized segment still produces a hash — routing.ts's own parseHash() is what no-ops on it, not this translation (nothing to keep in sync when a route is added there)", () => {
    expect(skynetUrlToHash("skynet://not-a-real-route/x")).toBe("#/not-a-real-route/x");
  });
});

describe("findSkynetUrlArg", () => {
  it("finds a skynet:// entry anywhere in an argv-shaped array", () => {
    expect(findSkynetUrlArg(["/path/to/Skynet", "skynet://agent/xyz"])).toBe("skynet://agent/xyz");
    expect(findSkynetUrlArg(["node", "main.js", "--flag", "skynet://queue"])).toBe("skynet://queue");
  });

  it("returns undefined when there is no skynet:// entry (a plain re-open, no deep link)", () => {
    expect(findSkynetUrlArg(["/path/to/Skynet"])).toBeUndefined();
    expect(findSkynetUrlArg([])).toBeUndefined();
  });
});
