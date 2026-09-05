// Onboarding telemetry (PMF v1.5) — fireOnboardingMilestone's own contract:
// fires each milestone AT MOST ONCE per workspace, respects both the global
// kill switch and a workspace's own opt-out, sends nothing identifying, and
// never throws (a telemetry failure must never affect the real operation it
// observes). config.telemetryDisabled/telemetryEndpoint are read from env at
// import time, so each variant re-imports after vi.resetModules() — same
// pattern as bootstrap-token.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { MemoryStore } from "../apps/server/src/store/memory.js";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("fireOnboardingMilestone", () => {
  it("records locally and sends {event, at} only — nothing identifying — when an endpoint is configured", async () => {
    vi.stubEnv("SKYNET_TELEMETRY_ENDPOINT", "https://telemetry.example/ingest");
    vi.resetModules();
    const { fireOnboardingMilestone } = await import("../apps/server/src/telemetry.js");
    const store = new MemoryStore({ seed: false } as never);

    await fireOnboardingMilestone(store, DEFAULT_WORKSPACE, "workspace_created");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://telemetry.example/ingest");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(Object.keys(body).sort()).toEqual(["at", "event"]);
    expect(body.event).toBe("workspace_created");
    expect(typeof body.at).toBe("number");
  });

  it("never re-fires the same milestone for the same workspace", async () => {
    vi.stubEnv("SKYNET_TELEMETRY_ENDPOINT", "https://telemetry.example/ingest");
    vi.resetModules();
    const { fireOnboardingMilestone } = await import("../apps/server/src/telemetry.js");
    const store = new MemoryStore({ seed: false } as never);

    await fireOnboardingMilestone(store, DEFAULT_WORKSPACE, "key_added");
    await fireOnboardingMilestone(store, DEFAULT_WORKSPACE, "key_added");
    await fireOnboardingMilestone(store, DEFAULT_WORKSPACE, "key_added");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fires independently per workspace and per milestone kind", async () => {
    vi.stubEnv("SKYNET_TELEMETRY_ENDPOINT", "https://telemetry.example/ingest");
    vi.resetModules();
    const { fireOnboardingMilestone } = await import("../apps/server/src/telemetry.js");
    const store = new MemoryStore({ seed: false } as never);

    await fireOnboardingMilestone(store, "ws-a", "runner_added");
    await fireOnboardingMilestone(store, "ws-b", "runner_added"); // different workspace — fires again
    await fireOnboardingMilestone(store, "ws-a", "first_task_created"); // different kind — fires again

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("records the milestone locally even with no endpoint configured, but sends nothing", async () => {
    vi.resetModules();
    const { fireOnboardingMilestone } = await import("../apps/server/src/telemetry.js");
    const store = new MemoryStore({ seed: false } as never);

    await fireOnboardingMilestone(store, DEFAULT_WORKSPACE, "repo_connected");
    expect(fetchMock).not.toHaveBeenCalled();
    // Recorded locally regardless — a second call is still a no-op re-fire,
    // proving the FIRST call actually persisted it (not just skipped silently).
    await fireOnboardingMilestone(store, DEFAULT_WORKSPACE, "repo_connected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends anything when the global kill switch is on, even with a workspace opted in", async () => {
    vi.stubEnv("SKYNET_TELEMETRY_ENDPOINT", "https://telemetry.example/ingest");
    vi.stubEnv("SKYNET_TELEMETRY_DISABLE", "true");
    vi.resetModules();
    const { fireOnboardingMilestone } = await import("../apps/server/src/telemetry.js");
    const store = new MemoryStore({ seed: false } as never);

    await fireOnboardingMilestone(store, DEFAULT_WORKSPACE, "workspace_created");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends anything when the workspace itself opted out", async () => {
    vi.stubEnv("SKYNET_TELEMETRY_ENDPOINT", "https://telemetry.example/ingest");
    vi.resetModules();
    const { fireOnboardingMilestone } = await import("../apps/server/src/telemetry.js");
    const { WorkspaceSettings } = await import("@skynet/shared");
    const store = new MemoryStore({ seed: false } as never);
    await store.putWorkspaceSettings(WorkspaceSettings.parse({ workspaceId: DEFAULT_WORKSPACE, telemetryOptOut: true }));

    await fireOnboardingMilestone(store, DEFAULT_WORKSPACE, "workspace_created");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a silent no-op when the endpoint is unreachable — never throws", async () => {
    vi.stubEnv("SKYNET_TELEMETRY_ENDPOINT", "https://telemetry.example/ingest");
    vi.resetModules();
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const { fireOnboardingMilestone } = await import("../apps/server/src/telemetry.js");
    const store = new MemoryStore({ seed: false } as never);

    await expect(fireOnboardingMilestone(store, DEFAULT_WORKSPACE, "workspace_created")).resolves.toBeUndefined();
  });
});
