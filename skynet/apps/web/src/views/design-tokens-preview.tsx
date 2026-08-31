// ─── Design tokens preview (dev-only) ──────────────────────────────────────
// A lightweight visual smoke test for the "Automated Kanban" design tokens +
// primitives (Momentum Rollout Phase 3) — no Storybook in this project, so
// this is the "simple test route" fallback. Renders each primitive with
// representative props so dark-theme values can be spot-checked (computed
// colors, spacing, radii) against the handoff spec. Internal tooling only —
// gated the same way Acceptance/Simulation are (see lib/dev.ts).
import {
  CheckpointRail,
  Chip,
  ProvenanceBadge,
  TrailRow,
  type CheckpointStep,
} from "../kanban/primitives";

const CHIP_TONES = ["neutral", "machine", "machine-deep", "human", "warn", "epic"] as const;

const CHECKPOINTS: CheckpointStep[] = [
  { key: "branch", label: "Branch", state: "done" },
  { key: "pr", label: "PR", state: "done" },
  { key: "review", label: "Review", state: "active" },
  { key: "merge", label: "Merge", state: "pending" },
  { key: "deploy", label: "Deploy", state: "pending" },
];
const CHECKPOINTS_BLOCKED: CheckpointStep[] = [
  { key: "branch", label: "Branch", state: "done" },
  { key: "pr", label: "PR", state: "done" },
  { key: "review", label: "Review", state: "blocked" },
  { key: "merge", label: "Merge", state: "pending" },
  { key: "deploy", label: "Deploy", state: "pending" },
];

export function DesignTokensPreview() {
  return (
    <section className="vw" data-screen-label="Design tokens preview">
      <div className="vw-head">
        <h1>Design tokens preview</h1>
        <p>"Automated Kanban" (Momentum Rollout Phase 3) — dev-only visual smoke test.</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: 4 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 style={{ font: "600 13px var(--font-ui)", color: "var(--ak-text-secondary)" }}>Chip</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {CHIP_TONES.map((tone) => (
              <Chip key={tone} tone={tone} label={tone} />
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 style={{ font: "600 13px var(--font-ui)", color: "var(--ak-text-secondary)" }}>ProvenanceBadge</h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <ProvenanceBadge source="slack" label="#eng-alerts" />
            <ProvenanceBadge source="github" label="acme/web#4821" />
            <ProvenanceBadge source="sentry" label="SKYNET-7F2" />
            <ProvenanceBadge source="jira" label="No icon set — text fallback" />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 style={{ font: "600 13px var(--font-ui)", color: "var(--ak-text-secondary)" }}>CheckpointRail</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }}>
            <CheckpointRail steps={CHECKPOINTS} />
            <CheckpointRail steps={CHECKPOINTS_BLOCKED} />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <h2 style={{ font: "600 13px var(--font-ui)", color: "var(--ak-text-secondary)" }}>TrailRow</h2>
          <div style={{ background: "var(--ak-surface-1)", border: "1px solid var(--ak-border)", borderRadius: 9, padding: 12, maxWidth: 420 }}>
            <TrailRow actor="rule: auto-merge" actorType="machine" action="merged PR #482 into main" timestamp="2m ago" />
            <TrailRow actor="Jordan Diaz" actorType="human" action="approved the diff" timestamp="14m ago" />
            <TrailRow actor="rule: triage" actorType="machine" action="opened the task" timestamp="1h ago" />
          </div>
        </div>
      </div>
    </section>
  );
}
