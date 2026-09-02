// ─── Escape-key layering (Phase 30 hardening) ────────────────────────────────
// A shared LIFO stack so exactly ONE open UI layer responds to Escape —
// whichever was activated most recently (innermost: a popover opened from
// within an already-open drill-in, opened from within an already-open
// palette) — never all of them at once.
//
// Before this, every modal/popover/breadcrumb independently added its own
// `window.addEventListener("keydown", ...)` Escape check with no
// coordination between components. That was a real bug, not just a spec
// gap: opening a task's detail modal from inside a project page and
// pressing Escape fired BOTH the modal's own close (project.tsx's TaskCard)
// AND the project breadcrumb's "leave the project" handler (project.tsx's
// top-level component) in the same keypress — two independent listeners,
// each with no idea the other existed. The breadcrumb's own handler even
// says as much in its comment ("that overlay's own Escape handling should
// win instead") but could only guard against overlays IN THE SAME
// component via a hand-maintained flag list — it structurally could not
// know about TaskCard's local `detail` state. A shared stack fixes that
// class of bug for free: whichever layer's `useEscapeLayer` effect mounted
// last is on top, regardless of which component it lives in.
import { useEffect, useRef } from "react";

let stack: symbol[] = [];
const handlers = new Map<symbol, () => void>();

function handleGlobalEscape(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (top == null) return;
  const handler = handlers.get(top);
  if (!handler) return;
  e.preventDefault();
  handler();
}

let listenerAttached = false;
function ensureListener(): void {
  if (listenerAttached) return;
  window.addEventListener("keydown", handleGlobalEscape);
  listenerAttached = true;
}

/**
 * Register `onEscape` as this layer's Escape handler while `active` is true.
 * Layers nest by ACTIVATION order — the most recently activated one is the
 * one that responds; deactivating (or unmounting) pops it back off,
 * restoring whichever layer was open before it. `onEscape` is read from a
 * ref internally, so passing a fresh closure every render never re-registers
 * the layer or reorders the stack.
 */
export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const idRef = useRef<symbol | undefined>(undefined);
  if (!idRef.current) idRef.current = Symbol("escape-layer");
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    ensureListener();
    const id = idRef.current!;
    stack.push(id);
    handlers.set(id, () => onEscapeRef.current());
    return () => {
      stack = stack.filter((s) => s !== id);
      handlers.delete(id);
    };
  }, [active]);
}
