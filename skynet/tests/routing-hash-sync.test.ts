// Regression guard: the hash-sync effect must be ADDITIVE. The URL hash for a
// given view carries only THAT view's identity (`#/project/<id>` carries a
// projectId; `#/agent/<runId>` carries a runId; neither carries the other).
// Since browsers fire `hashchange` for our OWN writes, a blanket
// `setProjectId(r.projectId ?? null)` after opening a task from a project
// would clear projectId — so clicking Back would render "This project was
// removed" or bounce to the projects overview instead of returning to the
// project the operator was viewing. Fix: only apply hash fields the hash
// actually specifies (i.e. `!== undefined`).
//
// This test drives the PURE hash helpers (`parseHash` + `toHash`) to pin the
// invariant. The `undefined` (absent) vs `null` (explicitly cleared) contract
// is what the fix relies on.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

// Minimal `location` polyfill so this test runs in the default `node`
// environment (no jsdom dep). `parseHash` only reads `location.hash`; `toHash`
// doesn't touch it. Keep this tight to avoid drift with the real DOM.
beforeAll(() => {
  if (typeof (globalThis as { location?: { hash: string } }).location === "undefined") {
    (globalThis as { location: { hash: string } }).location = { hash: "" };
  }
});

// Import AFTER the polyfill in case the routing module ever reaches for it at
// import time. Today it only touches location inside functions, but future-proof.
import { parseHash, toHash } from "../apps/web/src/lib/routing.js";

beforeEach(() => {
  location.hash = "";
});

describe("parseHash", () => {
  it("returns the projectId AND leaves runId undefined for a project URL", () => {
    location.hash = "#/project/p-1";
    const r = parseHash();
    expect(r?.view).toBe("project");
    expect(r?.projectId).toBe("p-1");
    // runId is ABSENT (undefined), not null — the fix relies on this to skip
    // the state clear.
    expect(r?.runId).toBeUndefined();
    expect(r?.agentId).toBeUndefined();
  });

  it("returns the runId AND leaves projectId undefined for a task URL", () => {
    location.hash = "#/agent/r-1";
    const r = parseHash();
    expect(r?.view).toBe("task");
    expect(r?.runId).toBe("r-1");
    // projectId is ABSENT (undefined) — the OLD bug: reading `r.projectId ?? null`
    // treated absent + null identically and cleared state. The fix
    // (`if (r.projectId !== undefined)`) skips the state write here, so the
    // projectId set when we opened the project survives the round-trip to task.
    expect(r?.projectId).toBeUndefined();
    expect(r?.agentId).toBeUndefined();
  });

  it("accepts the legacy `#/task/<id>` alias so older shared links resolve", () => {
    location.hash = "#/task/r-1";
    const r = parseHash();
    expect(r?.view).toBe("task");
    expect(r?.runId).toBe("r-1");
    expect(r?.projectId).toBeUndefined();
  });

  it("returns view-only for hashes that don't identify an entity", () => {
    for (const seg of ["queue", "audit", "projects", "settings", "acceptance", "simulation", "roadmap", "integrations"]) {
      location.hash = `#/${seg}`;
      const r = parseHash();
      expect(r?.view).toBe(seg);
      expect(r?.projectId).toBeUndefined();
      expect(r?.runId).toBeUndefined();
      expect(r?.agentId).toBeUndefined();
    }
  });
});

describe("toHash", () => {
  it("writes only the current view's identity — project hash omits runId", () => {
    const h = toHash({ view: "project", lens: "subway", projectId: "p-1", runId: "r-1", agentId: null });
    expect(h).toBe("#/project/p-1"); // no runId leaked
  });

  it("writes only the current view's identity — task hash omits projectId", () => {
    // This is the ONE the bug hinged on: on a task view we write `#/agent/r-1`,
    // omitting projectId. The old hashchange listener would then null out the
    // in-memory projectId; the fix preserves it because parseHash leaves it
    // `undefined` (see the parseHash tests above).
    const h = toHash({ view: "task", lens: "subway", projectId: "p-1", runId: "r-1", agentId: null });
    expect(h).toBe("#/agent/r-1"); // no projectId leaked
  });

  it("agent hash omits runId + projectId", () => {
    const h = toHash({ view: "agentDetail", lens: "subway", projectId: "p-1", runId: "r-1", agentId: "a-1" });
    expect(h).toBe("#/fleet/a-1");
  });
});

describe("hash round-trip preserves the current view's identity", () => {
  it("project → toHash → parseHash yields the same projectId (round-trip stable)", () => {
    const written = toHash({ view: "project", lens: "subway", projectId: "p-1", runId: null, agentId: null });
    location.hash = written;
    const r = parseHash();
    expect(r?.view).toBe("project");
    expect(r?.projectId).toBe("p-1");
  });

  it("task → toHash → parseHash yields the same runId (round-trip stable)", () => {
    const written = toHash({ view: "task", lens: "subway", projectId: null, runId: "r-1", agentId: null });
    location.hash = written;
    const r = parseHash();
    expect(r?.view).toBe("task");
    expect(r?.runId).toBe("r-1");
  });
});
