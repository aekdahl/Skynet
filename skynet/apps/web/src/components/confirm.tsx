// A themed, promise-based confirm dialog — replaces the browser's native
// window.confirm (the "ugly" OS chrome) with an in-app modal that matches the
// app. Mount <ConfirmProvider> once near the root; anywhere below, call
//   const confirm = useConfirm();
//   if (await confirm({ title, body, danger })) …
// It resolves true on confirm, false on cancel / Esc / backdrop click.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

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

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

/** Returns `confirm(opts) => Promise<boolean>`. Throws if used outside the provider. */
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...opts, resolve })),
    [],
  );

  // Resolve the outstanding promise and close. Guarded so a double-invoke
  // (e.g. Enter + click) can't resolve twice.
  const close = useCallback((ok: boolean) => {
    setPending((p) => {
      p?.resolve(ok);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    confirmBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        close(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        // mousedown (not click) so a text-selection drag ending on the backdrop
        // doesn't dismiss it; the card stops propagation to keep clicks inside.
        <div className="confirm-overlay" onMouseDown={() => close(false)} role="presentation">
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
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
