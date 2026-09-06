import { useState } from "react";
import { createPortal } from "react-dom";
import type { Module } from "@skynet/shared";

// Start-as-manager picker — modeled on BakeoffPicker (same portal-to-body +
// confirm-overlay/confirm-card reuse, needed for the same reason: the trigger
// button lives inside a draggable TaskCard).
//
// A manager is just an agent with role:"manager" plus a scope
// (docs/agent-hierarchy.md, docs/ux-agent-organization.md Job B): scope is
// either an AREA (a set of modules it owns) or a ROLE/function (Review, QA,
// Security, …) with no module restriction at all. Same backend call either
// way — Operations.assignManager(ws, projectId, taskId, area) — an empty
// `area` is the documented "unrestricted, role manager" shape, not a
// different code path. A Role-scoped manager's function comes from the
// task's own text (e.g. a task titled "Review manager"), not a separate name
// field here.
export function ManagerPicker({
  modules,
  onStart,
  onCancel,
}: {
  modules: Module[];
  onStart: (area: string[]) => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState<"area" | "role">(modules.length > 0 ? "area" : "role");
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
          Start as a manager
        </h2>
        <div className="confirm-body">
          <p>
            A manager doesn't edit code itself — it decomposes the work and delegates to worker
            agents it spawns, each in its own worktree with its own review gates. Low-risk worker
            decisions are handled by the manager automatically; anything riskier still comes to you.
          </p>
          <div className="mp-scope-toggle" role="radiogroup" aria-label="Manager scope">
            <button
              type="button"
              className={"mp-scope-btn" + (scope === "area" ? " mp-scope-btn-active" : "")}
              aria-pressed={scope === "area"}
              onClick={() => setScope("area")}
            >
              Area
            </button>
            <button
              type="button"
              className={"mp-scope-btn" + (scope === "role" ? " mp-scope-btn-active" : "")}
              aria-pressed={scope === "role"}
              onClick={() => setScope("role")}
            >
              Role
            </button>
          </div>
          {scope === "area" ? (
            modules.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
                {modules.map((m) => (
                  <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                    {m.name}
                  </label>
                ))}
              </div>
            ) : (
              <p className="mp-hint">No modules defined for this project yet — add one, or start this as a Role manager instead.</p>
            )
          ) : (
            <p className="mp-hint">
              No module restriction — this manager can delegate across the whole project. Its
              function comes from the task itself (e.g. name the task "Review manager").
            </p>
          )}
        </div>
        <div className="confirm-actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={scope === "area" && selected.size === 0}
            onClick={() => onStart(scope === "area" ? Array.from(selected) : [])}
          >
            Start manager →
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
