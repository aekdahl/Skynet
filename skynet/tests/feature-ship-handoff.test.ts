// startFeatureShipHandoff's own transition-detection logic — mirrors
// task-sync.test.ts's own approach: a real InProcessBus (so publish/subscribe
// actually round-trips), a minimal store stub (just getProject), and a spy in
// place of the real Orchestrator (dispatchFeatureHandoff itself is covered at
// the orchestrator level in feature-handoff-dispatch.test.ts). This suite is
// only about WHEN dispatch fires, not what it does once it fires.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Feature, Project } from "@skynet/shared";
import { InProcessBus } from "../apps/server/src/bus.js";
import { startFeatureShipHandoff } from "../apps/server/src/feature-ship-handoff.js";

const ROLE_AGENTS = { changeManager: "a-cm", docsWriter: null, releaseComms: null };

function mkFeature(over: Partial<Feature> = {}): Feature {
  return {
    id: "f1",
    workspaceId: DEFAULT_WORKSPACE,
    projectId: "p1",
    name: "Cross-vendor bake-offs",
    description: "Peer review lands.",
    status: "active",
    milestoneId: null,
    archived: false,
    createdAt: 0,
    pr: null,
    ...over,
  };
}

function mkProject(over: Partial<Project> = {}): Project {
  return { id: "p1", workspaceId: DEFAULT_WORKSPACE, roleAgents: ROLE_AGENTS, ...over } as Project;
}

describe("startFeatureShipHandoff", () => {
  let bus: InProcessBus;
  let dispatchFeatureHandoff: ReturnType<typeof vi.fn>;
  let getProject: ReturnType<typeof vi.fn>;
  let unsubscribe: () => void;

  beforeEach(() => {
    bus = new InProcessBus();
    dispatchFeatureHandoff = vi.fn().mockResolvedValue(undefined);
    getProject = vi.fn().mockResolvedValue(mkProject());
    unsubscribe = startFeatureShipHandoff(bus, {
      store: { getProject } as unknown as Parameters<typeof startFeatureShipHandoff>[1]["store"],
      orchestrator: { dispatchFeatureHandoff } as unknown as Parameters<typeof startFeatureShipHandoff>[1]["orchestrator"],
    });
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("dispatches every configured role on a genuine active -> shipped transition", async () => {
    bus.publish(DEFAULT_WORKSPACE, { type: "feature.upserted", feature: mkFeature({ status: "active" }) });
    await flush();
    bus.publish(DEFAULT_WORKSPACE, { type: "feature.upserted", feature: mkFeature({ status: "shipped" }) });
    await flush();
    expect(dispatchFeatureHandoff).toHaveBeenCalledTimes(1);
    expect(dispatchFeatureHandoff).toHaveBeenCalledWith(
      DEFAULT_WORKSPACE,
      expect.objectContaining({ id: "p1" }),
      "feature",
      "f1",
      "Cross-vendor bake-offs",
      "Peer review lands.",
      "change-manager",
      "a-cm",
    );
  });

  it("does NOT dispatch on first sighting already-shipped (no seed replay on restart)", async () => {
    bus.publish(DEFAULT_WORKSPACE, { type: "feature.upserted", feature: mkFeature({ status: "shipped" }) });
    await flush();
    expect(dispatchFeatureHandoff).not.toHaveBeenCalled();
  });

  it("does NOT re-dispatch on a later upsert of an already-shipped feature", async () => {
    bus.publish(DEFAULT_WORKSPACE, { type: "feature.upserted", feature: mkFeature({ status: "active" }) });
    await flush();
    bus.publish(DEFAULT_WORKSPACE, { type: "feature.upserted", feature: mkFeature({ status: "shipped" }) });
    await flush();
    bus.publish(DEFAULT_WORKSPACE, { type: "feature.upserted", feature: mkFeature({ status: "shipped", description: "edited later" }) });
    await flush();
    expect(dispatchFeatureHandoff).toHaveBeenCalledTimes(1);
  });

  it("skips roles the project hasn't configured (all off by default)", async () => {
    getProject.mockResolvedValue(mkProject({ roleAgents: { changeManager: null, docsWriter: null, releaseComms: null } } as Partial<Project>));
    bus.publish(DEFAULT_WORKSPACE, { type: "feature.upserted", feature: mkFeature({ status: "active" }) });
    await flush();
    bus.publish(DEFAULT_WORKSPACE, { type: "feature.upserted", feature: mkFeature({ status: "shipped" }) });
    await flush();
    expect(dispatchFeatureHandoff).not.toHaveBeenCalled();
  });

  it("ignores unrelated events entirely", async () => {
    bus.publish(DEFAULT_WORKSPACE, { type: "task.upserted", task: { id: "t1" } } as never);
    await flush();
    expect(dispatchFeatureHandoff).not.toHaveBeenCalled();
    unsubscribe();
  });
});
