import { useState } from "react";
import { createPortal } from "react-dom";
import type { Module } from "@skynet/shared";

// "Start a manager" — the real UI for what was previously only reachable as
// a raw assignManager({area}) API call (docs/agent-hierarchy.md). Modeled
// directly on BakeoffPicker: same overlay/card/portal, a checklist instead of
// a single pick. Area is OPTIONAL — role-managers and area-managers need no
// schema split (both are just a manager run with a task brief and an
// optional module scope), so leaving every module unchecked starts an
// unscoped role-manager rather than blocking the picker.
//
// Rendered via a portal to document.body for the same reason BakeoffPicker
// is — the trigger button lives inside a draggable TaskCard.
export function ManagerAreaPicker({
  modules,
  onStart,
  onCancel,
}: {
  modules: Module[];
  onStart: (area: string[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return createPortal(
    <div className="confirm-overlay" onMouseDown={onCancel} role="presentation">
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="manager-picker-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="manager-picker-title" className="confirm-title">
          Start a manager
        </h2>
        <div className="confirm-body">
          <p>
            Gets a real <code>spawn_worker</code> tool — it can provision its own worker agents (own
            runner, worktree, branch, HITL, and merge) to carry out this task instead of doing every
            step alone. A worker's low-risk questions and plans auto-resolve against this manager
            instead of paging you.
          </p>
          {modules.length > 0 && (
            <>
              <p style={{ color: "var(--muted)", fontSize: "var(--fz-12-5)" }}>
                Optionally scope it to one or more modules — leave all unchecked for an unscoped
                manager free to work anywhere.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0", maxHeight: 220, overflowY: "auto" }}>
                {modules.map((m) => (
                  <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                    {m.name}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="confirm-actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onStart(Array.from(selected))}>
            Start manager →
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
