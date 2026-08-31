// ─── "Automated Kanban" shared primitives (Momentum Rollout Phase 3) ──────
// The visual language from an external design handoff, built once as reusable
// components before any real screen exists. Every component here is PURE:
// props in, markup out — no data fetching, no store/context reads. Styles
// live in kanban.css (imported once from main.tsx); tokens in styles.css's
// :root (--ak-*).
import type { ReactElement } from "react";
import { GithubIcon, SentryIcon, SlackIcon } from "./icons";

// ── Chip ─────────────────────────────────────────────────────────────────
export type ChipTone = "neutral" | "machine" | "machine-deep" | "human" | "warn" | "epic";

export function Chip({ label, tone = "neutral" }: { label: string; tone?: ChipTone }) {
  const toneClass = tone === "neutral" ? "" : ` ak-chip-${tone}`;
  return <span className={"ak-chip" + toneClass}>{label}</span>;
}

// ── ProvenanceBadge ──────────────────────────────────────────────────────
// A source icon + label — Slack/GitHub/Sentry only (see icons.tsx). Falls
// back to a plain mono-label badge for any other source, so a caller never
// has to guard against an unrecognized value.
export type ProvenanceSource = "slack" | "github" | "sentry";

const PROVENANCE_ICON: Record<ProvenanceSource, (p: { className?: string }) => ReactElement> = {
  slack: SlackIcon,
  github: GithubIcon,
  sentry: SentryIcon,
};

export function ProvenanceBadge({ source, label }: { source: ProvenanceSource | string; label: string }) {
  const Icon = PROVENANCE_ICON[source as ProvenanceSource];
  if (!Icon) {
    return (
      <span className="ak-provenance-badge ak-provenance-badge-text-only">
        <span className="ak-provenance-label">{label}</span>
      </span>
    );
  }
  return (
    <span className="ak-provenance-badge">
      <Icon className="ak-provenance-icon" />
      <span className="ak-provenance-label">{label}</span>
    </span>
  );
}

// ── CheckpointRail ───────────────────────────────────────────────────────
// A 5-node horizontal rail: branch · pr · review · merge · deploy.
export type CheckpointState = "done" | "active" | "blocked" | "pending";
export interface CheckpointStep {
  key: string;
  label: string;
  state: CheckpointState;
}
export const CHECKPOINT_RAIL_KEYS = ["branch", "pr", "review", "merge", "deploy"] as const;

export function CheckpointRail({ steps }: { steps: CheckpointStep[] }) {
  return (
    <div className="ak-checkpoint-rail" role="list" aria-label="Checkpoints">
      {steps.map((step, i) => (
        <div className={"ak-checkpoint-step ak-checkpoint-step-" + step.state} role="listitem" key={step.key}>
          <span
            className={
              "ak-checkpoint-node ak-checkpoint-node-" +
              step.state +
              (step.state === "active" || step.state === "blocked" ? " ak-pulse-dot" : "")
            }
            tabIndex={0}
            aria-label={`${step.label}: ${step.state}`}
          />
          <span className="ak-checkpoint-label">{step.label}</span>
          {i < steps.length - 1 && (
            <span className={"ak-checkpoint-track" + (step.state === "done" ? " ak-checkpoint-track-done" : "")} aria-hidden="true" />
          )}
        </div>
      ))}
    </div>
  );
}

// ── TrailRow ─────────────────────────────────────────────────────────────
// One row of a transition: actor + action + timestamp. Machine actor renders
// bold lime; human actor renders plain text-primary.
export type ActorType = "machine" | "human";

export function TrailRow({
  actor,
  actorType,
  action,
  timestamp,
}: {
  actor: string;
  actorType: ActorType;
  action: string;
  timestamp: string;
}) {
  return (
    <div className="ak-trail-row">
      <span className={"ak-trail-actor" + (actorType === "machine" ? " ak-trail-actor-machine" : "")}>{actor}</span>
      <span className="ak-trail-action">{action}</span>
      <span className="ak-trail-time">{timestamp}</span>
    </div>
  );
}
