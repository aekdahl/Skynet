// A themed, promise-based confirm dialog — replaces the browser's native
// window.confirm (the "ugly" OS chrome) with an in-app modal that matches the
// app. Mount <ConfirmProvider> once near the root; anywhere below, call
//   const confirm = useConfirm();
//   if (await confirm({ title, body, danger })) …
// It resolves true on confirm, false on cancel / Esc / backdrop click.
//
// useChoice() is the same idea for a 3+-way decision (e.g. "keep the work
// paused" vs "discard and start clean" vs cancel) instead of a plain yes/no:
//   const choice = useChoice();
//   const picked = await choice({ title, body, options: [...] }); // value | null
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useEscapeLayer } from "../lib/escape-stack";

export interface ConfirmOptions {
  /** Bold heading (optional). */
  title?: string;
  /** The question / consequence. String or rich node. */
  body: ReactNode;
  /** Confirm button label (default "Confirm"). */
  confirmLabel?: string;
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

/** One button in a useChoice() dialog. `value` is what the promise resolves to. */
export interface ChoiceOption {
  value: string;
  label: string;
  /** Short explainer under the label, so each option's consequence is legible
   *  without a tooltip — this dialog is for decisions with real trade-offs. */
  hint?: string;
  /** Style as destructive (red) — the option that discards/can't be undone. */
  danger?: boolean;
  /** Style as the recommended pick (accent) — at most one option should set this. */
  primary?: boolean;
}

export interface ChoiceOptions {
  title?: string;
  body: ReactNode;
  options: ChoiceOption[];
  cancelLabel?: string;
}

type PendingConfirm = ConfirmOptions & { kind: "confirm"; resolve: (ok: boolean) => void };
type PendingChoice = ChoiceOptions & { kind: "choice"; resolve: (value: string | null) => void };
type Pending = PendingConfirm | PendingChoice;

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);
const ChoiceContext = createContext<((opts: ChoiceOptions) => Promise<string | null>) | null>(null);

/** Returns `confirm(opts) => Promise<boolean>`. Throws if used outside the provider. */
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

/** Returns `choice(opts) => Promise<string | null>` — the picked option's
 *  `value`, or `null` on cancel / Esc / backdrop click. */
export function useChoice(): (opts: ChoiceOptions) => Promise<string | null> {
  const ctx = useContext(ChoiceContext);
  if (!ctx) throw new Error("useChoice must be used within <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ ...opts, kind: "confirm", resolve })),
    [],
  );
  const choice = useCallback(
    (opts: ChoiceOptions) =>
      new Promise<string | null>((resolve) => setPending({ ...opts, kind: "choice", resolve })),
    [],
  );

  // Resolve the outstanding promise and close. Guarded so a double-invoke
  // (e.g. Enter + click) can't resolve twice. `result` is the confirm bool for
  // a "confirm" dialog, or the picked value (null = cancel) for a "choice" one.
  const close = useCallback((result: boolean | string | null) => {
    setPending((p) => {
      if (p?.kind === "confirm") p.resolve(typeof result === "boolean" ? result : result != null);
      else if (p?.kind === "choice") p.resolve(typeof result === "string" ? result : null);
      return null;
    });
  }, []);

  // Escape rides the shared escape-stack (lib/escape-stack.ts) so it closes
  // whichever layer is actually innermost, not necessarily this dialog, if
  // something else opened on top of it.
  useEscapeLayer(!!pending, () => close(pending?.kind === "confirm" ? false : null));
  useEffect(() => {
    if (!pending) return;
    confirmBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && pending.kind === "confirm") {
        // Choice dialogs have no single "default" action to fire on Enter —
        // each option is a real, distinct decision — so Enter is a no-op there;
        // the operator clicks (or tabs to) the one they mean.
        e.preventDefault();
        close(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      <ChoiceContext.Provider value={choice}>
        {children}
        {pending && (
          // mousedown (not click) so a text-selection drag ending on the backdrop
          // doesn't dismiss it; the card stops propagation to keep clicks inside.
          <div
            className="confirm-overlay"
            onMouseDown={() => close(pending.kind === "confirm" ? false : null)}
            role="presentation"
          >
            <div
              className="confirm-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={pending.title ? "confirm-title" : undefined}
              aria-describedby="confirm-body"
              onMouseDown={(e) => e.stopPropagation()}
            >
              {pending.title && (
                <h2 id="confirm-title" className="confirm-title">
                  {pending.title}
                </h2>
              )}
              <div id="confirm-body" className="confirm-body">
                {pending.body}
              </div>
              {pending.kind === "confirm" ? (
                <div className="confirm-actions">
                  <button className="btn btn-ghost" onClick={() => close(false)}>
                    {pending.cancelLabel ?? "Cancel"}
                  </button>
                  <button
                    ref={confirmBtn}
                    className={"btn " + (pending.danger ? "confirm-danger" : "btn-primary")}
                    onClick={() => close(true)}
                  >
                    {pending.confirmLabel ?? "Confirm"}
                  </button>
                </div>
              ) : (
                <div className="confirm-choices">
                  {pending.options.map((o) => (
                    <button
                      key={o.value}
                      className={"confirm-choice" + (o.danger ? " confirm-choice-danger" : "") + (o.primary ? " confirm-choice-primary" : "")}
                      onClick={() => close(o.value)}
                    >
                      <span className="confirm-choice-label">{o.label}</span>
                      {o.hint && <span className="confirm-choice-hint">{o.hint}</span>}
                    </button>
                  ))}
                  <div className="confirm-actions">
                    <button className="btn btn-ghost" onClick={() => close(null)}>
                      {pending.cancelLabel ?? "Cancel"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </ChoiceContext.Provider>
    </ConfirmContext.Provider>
  );
}
