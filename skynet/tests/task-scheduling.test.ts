// Task scheduling — the triage LLM's duration estimate tag + the Steward
// `set_schedule` action that lets the operator set `estimatedDurationMs` and
// `plannedStartAt` (or clear either). Pure logic — no LLM / no store needed.
import { describe, it, expect } from "vitest";
import { splitEstMinutesTag } from "../apps/server/src/orchestrator.js";
import { validateProjectAction, type ProjectActionContext } from "../apps/server/src/steward/assistant.js";

describe("splitEstMinutesTag — triage duration tag", () => {
  it("returns null estimate when the reply has no JSON tail", () => {
    const r = splitEstMinutesTag("Clear ask, small effort. No risks.");
    expect(r.estMinutes).toBeNull();
    expect(r.body).toBe("Clear ask, small effort. No risks.");
  });

  it("peels a trailing {estMinutes: N} tag off the body", () => {
    const raw = "Clear ask; medium effort; API-change risk.\n{\"estMinutes\": 45}";
    const r = splitEstMinutesTag(raw);
    expect(r.estMinutes).toBe(45);
    expect(r.body).toBe("Clear ask; medium effort; API-change risk.");
  });

  it("tolerates a code-fenced JSON tail", () => {
    const raw = "S — quick tweak.\n```json\n{\"estMinutes\": 10}\n```";
    const r = splitEstMinutesTag(raw);
    expect(r.estMinutes).toBe(10);
    expect(r.body).toBe("S — quick tweak.");
  });

  it("ignores non-positive / non-numeric / malformed estimates (no fabricated 0)", () => {
    expect(splitEstMinutesTag('body.\n{"estMinutes": 0}').estMinutes).toBeNull();
    expect(splitEstMinutesTag('body.\n{"estMinutes": -30}').estMinutes).toBeNull();
    expect(splitEstMinutesTag('body.\n{"estMinutes": "twenty"}').estMinutes).toBeNull();
    expect(splitEstMinutesTag('body.\n{ broken').estMinutes).toBeNull();
  });

  it("rounds fractional estimates to a whole minute", () => {
    expect(splitEstMinutesTag('body.\n{"estMinutes": 12.7}').estMinutes).toBe(13);
  });

  it("parses `clarity` alongside estMinutes (drives auto-promote triage→todo)", () => {
    const r = splitEstMinutesTag('Clear scope.\n{"estMinutes":15,"clarity":"clear"}');
    expect(r.estMinutes).toBe(15);
    expect(r.clarity).toBe("clear");
    expect(r.body).toBe("Clear scope.");
  });

  it("clarity works independently — missing estMinutes doesn't drop clarity", () => {
    const r = splitEstMinutesTag('Ambiguous ask.\n{"clarity":"unclear"}');
    expect(r.estMinutes).toBeNull();
    expect(r.clarity).toBe("unclear");
    expect(r.body).toBe("Ambiguous ask.");
  });

  it("bogus clarity values are dropped (never fabricated)", () => {
    expect(splitEstMinutesTag('body.\n{"clarity":"maybe"}').clarity).toBeNull();
    expect(splitEstMinutesTag('body.\n{"clarity":true}').clarity).toBeNull();
    expect(splitEstMinutesTag('body.\n{"estMinutes":30,"clarity":42}').clarity).toBeNull();
    // …but a valid estMinutes still survives a bogus clarity.
    expect(splitEstMinutesTag('body.\n{"estMinutes":30,"clarity":42}').estMinutes).toBe(30);
  });

  it("returns nulls all the way down when neither field parses (no false positive)", () => {
    const r = splitEstMinutesTag('The config looks like {"port": 8080} in the file.');
    expect(r.estMinutes).toBeNull();
    expect(r.clarity).toBeNull();
    // Body left untouched — we didn't recognize the tail as our tag.
    expect(r.body).toContain('{"port": 8080}');
  });
});

const ctx: ProjectActionContext = {
  project: { id: "p-1", name: "Takeoff" },
  tasks: [{ id: "t-1", text: "fix login redirect", state: "backlog" }],
  features: [],
  milestones: [],
};

describe("validateProjectAction — set_schedule", () => {
  it("accepts a duration-only patch", () => {
    const a = validateProjectAction(
      { kind: "set_schedule", taskId: "t-1", estimatedDurationMs: 30 * 60_000 },
      ctx,
    );
    expect(a).toMatchObject({ kind: "set_schedule", taskId: "t-1", estimatedDurationMs: 1_800_000 });
    expect(a?.plannedStartAt).toBeUndefined(); // not touched
    expect(a?.summary).toContain("30m");
  });

  it("accepts a start-only patch", () => {
    const t0 = 1_700_000_000_000;
    const a = validateProjectAction(
      { kind: "set_schedule", taskId: "t-1", plannedStartAt: t0 },
      ctx,
    );
    expect(a?.plannedStartAt).toBe(t0);
    expect(a?.estimatedDurationMs).toBeUndefined();
  });

  it("accepts both together", () => {
    const a = validateProjectAction(
      { kind: "set_schedule", taskId: "t-1", estimatedDurationMs: 60_000, plannedStartAt: 1_700_000_000_000 },
      ctx,
    );
    expect(a?.estimatedDurationMs).toBe(60_000);
    expect(a?.plannedStartAt).toBe(1_700_000_000_000);
  });

  it("null explicitly clears (an operator can undo a schedule)", () => {
    const a = validateProjectAction(
      { kind: "set_schedule", taskId: "t-1", estimatedDurationMs: null, plannedStartAt: null },
      ctx,
    );
    expect(a?.estimatedDurationMs).toBeNull();
    expect(a?.plannedStartAt).toBeNull();
    expect(a?.summary).toMatch(/clear/);
  });

  it("caps ludicrous durations to 24h (a runaway LLM guess doesn't blow out the timeline)", () => {
    const a = validateProjectAction(
      { kind: "set_schedule", taskId: "t-1", estimatedDurationMs: 999 * 24 * 60 * 60_000 },
      ctx,
    );
    expect(a?.estimatedDurationMs).toBe(24 * 60 * 60 * 1000);
  });

  it("rejects zero / negative durations", () => {
    expect(validateProjectAction({ kind: "set_schedule", taskId: "t-1", estimatedDurationMs: 0 }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "set_schedule", taskId: "t-1", estimatedDurationMs: -60_000 }, ctx)).toBeNull();
  });

  it("rejects a set_schedule against an unknown task id (project-scoped ids only)", () => {
    expect(
      validateProjectAction({ kind: "set_schedule", taskId: "t-999", estimatedDurationMs: 60_000 }, ctx),
    ).toBeNull();
  });

  it("rejects a patch with neither field set (no-op)", () => {
    expect(validateProjectAction({ kind: "set_schedule", taskId: "t-1" }, ctx)).toBeNull();
  });

  it("carries a human summary suitable for the confirm chip", () => {
    const a = validateProjectAction(
      { kind: "set_schedule", taskId: "t-1", estimatedDurationMs: 30 * 60_000 },
      ctx,
    );
    expect(a?.summary).toContain("fix login redirect");
    expect(a?.summary).toContain("30m");
  });
});
