import type { ReactNode } from "react";

// ─── Shared empty state ──────────────────────────────────────────────────────
// One consistent shape for a primary empty state: a title, a one-line
// mental-model hint (what this surface is for / what would fill it), and at most
// ONE primary call-to-action. `compact` is for empties that sit inside a card or
// a lane rather than owning a whole view.
export function EmptyState({
  title,
  hint,
  cta,
  compact,
}: {
  title: string;
  hint?: ReactNode;
  cta?: { label: string; onClick: () => void };
  compact?: boolean;
}) {
  return (
    <div className={"empty-state" + (compact ? " empty-state-compact" : "")}>
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {cta && (
        <button className="btn btn-primary empty-state-cta" onClick={cta.onClick}>
          {cta.label}
        </button>
      )}
    </div>
  );
}

// ─── Blocked-CTA pattern ─────────────────────────────────────────────────────
// A primary button that, when blocked, stays visually solid-but-inert and shows
// its reason directly beneath at readable contrast — never a dim-amber button
// with a faint hint parked somewhere else. Pass `reason` describing what's
// missing; it renders only while `disabled` is true.
export function PrimaryButton({
  disabled,
  reason,
  onClick,
  children,
  className,
  align = "start",
}: {
  disabled?: boolean;
  reason?: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  align?: "start" | "end" | "center";
}) {
  return (
    <div className={"pb-wrap pb-" + align}>
      <button
        className={"btn btn-primary" + (className ? " " + className : "")}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
      {disabled && reason && <div className="btn-reason">{reason}</div>}
    </div>
  );
}
