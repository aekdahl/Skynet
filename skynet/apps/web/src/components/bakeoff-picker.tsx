import { useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderId, ProviderInfo } from "@skynet/shared";

// Multi-select provider picker for a cross-vendor bake-off — modeled on
// project.tsx's AgentPreference, but a checklist (2+) instead of a single
// pick. Reuses the confirm dialog's own overlay/card styling so this needs no
// new CSS beyond the checklist layout itself.
//
// Rendered via a portal to document.body — the trigger button lives inside a
// draggable TaskCard, and a fixed-position overlay nested under a transformed
// drag ancestor (kanban dnd applies a CSS transform while dragging, and some
// browsers/animation libs establish one even at rest) stops being viewport-
// fixed and instead anchors to that ancestor. ConfirmProvider's own dialog
// avoids this the same way — mounted once at the app root, never inside a
// card.
export function BakeoffPicker({
  providers,
  onStart,
  onCancel,
}: {
  // Already filtered to providers with a configured fleet agent — see
  // project.tsx's bakeoffProviders.
  providers: ProviderInfo[];
  onStart: (providerIds: ProviderId[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<ProviderId>>(new Set());
  const toggle = (id: ProviderId) =>
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
        aria-labelledby="bakeoff-picker-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="bakeoff-picker-title" className="confirm-title">
          Bake-off — pick 2 or more providers
        </h2>
        <div className="confirm-body">
          <p>
            Each picked provider gets its own worktree, cut from the same base commit, working the
            same task in parallel. Once they finish, you compare their diffs side by side and pick a
            winner — the rest retire automatically.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
            {providers.map((p) => (
              <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                {p.name}
              </label>
            ))}
          </div>
        </div>
        <div className="confirm-actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={selected.size < 2}
            onClick={() => onStart(Array.from(selected))}
          >
            Start bake-off →
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
