// Internal surfaces (QA & Testing, and anything else that exists for us rather
// than for the people we ship to) must be visible wherever WE operate Skynet —
// the dev server and our own deployed instance — and hidden only in a RELEASE
// build handed to someone else.
//
// The distinction is "release", not "production". Conflating them is the
// original bug: the gate keyed off `import.meta.env.DEV`, which is false for
// ANY `vite build`, so the deployed instance was treated exactly like a shipped
// app and lost its own tooling.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEV_ONLY_VIEWS, devToolsEnabled, gateView, isReleaseBuild } from "../apps/web/src/lib/dev.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function stubStorage(value: string | null) {
  vi.stubGlobal("localStorage", { getItem: () => value } as unknown as Storage);
}
afterEach(() => vi.unstubAllGlobals());

describe("release gating", () => {
  it("is NOT a release build under test/dev/deploy — internal surfaces stay on", () => {
    stubStorage(null);
    expect(isReleaseBuild()).toBe(false);
    expect(devToolsEnabled()).toBe(true);
  });

  it("localStorage '0' previews what a release looks like without building one", () => {
    stubStorage("0");
    expect(devToolsEnabled()).toBe(false);
  });

  it("localStorage '1' forces internal surfaces on, for debugging a release", () => {
    stubStorage("1");
    expect(devToolsEnabled()).toBe(true);
  });
});

describe("gateView — hiding a nav item is not a gate", () => {
  it("passes internal views through while internal tooling is on", () => {
    stubStorage(null);
    expect(gateView("acceptance")).toBe("acceptance");
  });

  it("coerces an internal view to home when it's off", () => {
    // A deep link, a stale hash, or a PWA/notification nav would otherwise
    // render the page in a shipped build even with the nav item hidden.
    stubStorage("0");
    expect(gateView("acceptance")).toBe("home");
    expect(gateView("simulation")).toBe("home");
  });

  it("never coerces an ordinary view", () => {
    stubStorage("0");
    for (const v of ["home", "fleet", "projects", "settings"] as const) expect(gateView(v)).toBe(v);
  });
});

describe("the nav gate and the route gate can't drift apart", () => {
  it("every view behind the QA nav section is also route-gated", () => {
    // The failure mode is silent: someone adds a page under QA & Testing,
    // hides the nav item, and ships a build where the page is still reachable
    // by URL. This reads the actual nav source so the two lists stay in sync.
    const shell = read("../apps/web/src/components/shell.tsx");
    const qaBlock = shell.slice(shell.indexOf("QA &amp; TESTING"), shell.indexOf('<div className="op-navsec">PROJECTS</div>'));
    const views = [...qaBlock.matchAll(/setView\("(\w+)"\)/g)].map((m) => m[1]!);
    expect(views.length).toBeGreaterThan(0);
    for (const v of views) expect(DEV_ONLY_VIEWS.has(v as never), `"${v}" is in the QA nav but not DEV_ONLY_VIEWS`).toBe(true);
  });

  it("the release flag is actually set by the packaged-app build", () => {
    // The gate defaults to ON, so a release that forgets the flag ships our
    // internal tooling. This pins the wiring rather than trusting it.
    const desktop = JSON.parse(read("../apps/desktop/package.json")) as { scripts: Record<string, string> };
    const web = JSON.parse(read("../apps/web/package.json")) as { scripts: Record<string, string> };
    expect(web.scripts["build:release"]).toContain("VITE_SKYNET_RELEASE=1");
    for (const s of ["dist", "dist:mac", "dist:win", "publish"]) {
      expect(desktop.scripts[s], `desktop "${s}" must build the web app as a release`).toContain("build:release");
    }
  });
});
