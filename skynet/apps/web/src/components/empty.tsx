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
  cta?: { label: string; onClick: () => void; disabled?: boolean };
  compact?: boolean;
}) {
  return (
    <div className={"empty-state" + (compact ? " empty-state-compact" : "")}>
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {cta && (
        <button className="btn btn-primary empty-state-cta" disabled={cta.disabled} onClick={cta.onClick}>
          {cta.label}
        </button>
      )}
    </div>
  );
}

// ─── Blocked-CTA pattern ─────────────────────────────────────────────────────
// Wrap any button in this and, when blocked, its reason renders directly
// beneath at readable contrast — never a dim button with a faint hint parked
// somewhere else (a hover-only `title` doesn't count: it's invisible until you
// happen to hover). Pass `reason` describing what's missing; it renders only
// while `disabled` is true. Shared by every button style (primary/ghost/danger)
// so the reason markup is never hand-duplicated at a call site.
export function Blocked({
  disabled,
  reason,
  align = "start",
  children,
}: {
  disabled?: boolean;
  reason?: string;
  align?: "start" | "end" | "center";
  children: ReactNode;
}) {
  return (
    <div className={"pb-wrap pb-" + align}>
      {children}
      {disabled && reason && <div className="btn-reason">{reason}</div>}
    </div>
  );
}

// The primary (amber) CTA — the common case of `Blocked` wrapping a
// `btn btn-primary`. Non-primary blocked buttons (ghost, danger/Retire, etc.)
// use `Blocked` directly around their own `<button>`.
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
    <Blocked disabled={disabled} reason={reason} align={align}>
      <button
        className={"btn btn-primary" + (className ? " " + className : "")}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </Blocked>
  );
}
