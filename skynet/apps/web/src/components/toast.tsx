// Lightweight global toasts — a themed replacement for the browser's native
// alert(), usable from NON-React code (the store fires these from async
// callbacks, so a hook won't do). Emit from anywhere with `toast(msg)`; mount
// <ToastHost /> once at the root to render the stack.
import { useEffect, useState } from "react";

export type ToastKind = "error" | "info" | "success";
export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<(t: ToastItem[]) => void>();
const emit = () => {
  for (const l of listeners) l(items);
};

/** Show a toast. Returns its id. Auto-dismisses after `ttlMs` (0 = sticky). */
export function toast(message: string, kind: ToastKind = "error", ttlMs = 6000): number {
  const id = ++seq;
  items = [...items, { id, kind, message }];
  emit();
  if (ttlMs > 0) setTimeout(() => dismissToast(id), ttlMs);
  return id;
}

export function dismissToast(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Renders the toast stack. Reads module state (not context), so it can live
 *  anywhere in the tree and still show toasts emitted by non-React code. */
export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    setList(items); // sync anything emitted before mount
    return () => {
      listeners.delete(setList);
    };
  }, []);
  if (!list.length) return null;
  return (
    <div className="toast-stack" role="region" aria-live="assertive" aria-label="Notifications">
      {list.map((t) => (
        <div key={t.id} className={"toast toast-" + t.kind} role="status">
          <span className="toast-msg">{t.message}</span>
          <button className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
