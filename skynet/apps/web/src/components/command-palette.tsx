// ⌘K / Ctrl+K command palette — a small, real verb set rather than an
// exhaustive one: jump to a view, open a project by name, or resolve
// whatever HITL gate has been waiting longest. Mounted once at the App
// level; App.tsx owns the open/close keydown (see the ⌘. TweaksPanel /
// ⌘↵ composer for the same "global shortcut lives near the root" pattern).
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { openQueue } from "../lib/derive";
import { toast } from "./toast";
import type { ViewName } from "../App";

const NAV_TARGETS: { view: ViewName; label: string; icon: string }[] = [
  { view: "home", label: "Home", icon: "⌂" },
  { view: "queue", label: "Inbox", icon: "⊙" },
  { view: "audit", label: "Audit", icon: "❑" },
  { view: "projects", label: "Projects", icon: "▤" },
  { view: "fleet", label: "Fleet", icon: "◇" },
  { view: "integrations", label: "Integrations", icon: "⑂" },
  { view: "merges", label: "Ready to merge", icon: "⇲" },
  { view: "roadmap", label: "Roadmap", icon: "◈" },
  { view: "settings", label: "Settings", icon: "⚙" },
];

interface Action {
  id: string;
  label: string;
  hint?: string;
  group: "Navigate" | "Projects" | "Actions";
  icon: string;
  disabled?: boolean;
  run: () => void;
}

/** Case-insensitive fuzzy subsequence match — every query char must appear in
 *  order in the target. A plain substring match ranks above a scattered one. */
function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx;
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return -1;
    ti++;
  }
  return 1;
}

export function CommandPalette({
  open,
  onClose,
  setView,
  onOpenProject,
}: {
  open: boolean;
  onClose: () => void;
  setView: (v: ViewName) => void;
  onOpenProject: (id: string) => void;
}) {
  const { projects, queue, resolveHitl } = useStore();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    // Autofocus after the modal has mounted (it's conditionally rendered).
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const latestGate = useMemo(
    () => openQueue(queue).sort((a, b) => b.raisedAt - a.raisedAt)[0],
    [queue],
  );

  const actions = useMemo<Action[]>(() => {
    const nav: Action[] = NAV_TARGETS.map((n) => ({
      id: `nav:${n.view}`,
      label: `Go to ${n.label}`,
      group: "Navigate",
      icon: n.icon,
      run: () => {
        setView(n.view);
        onClose();
      },
    }));
    const openProjects: Action[] = projects.map((p) => ({
      id: `project:${p.id}`,
      label: p.name,
      hint: "Open project",
      group: "Projects",
      icon: "▤",
      run: () => {
        onOpenProject(p.id);
        onClose();
      },
    }));
    const approveLatest: Action = {
      id: "action:approve-latest",
      label: latestGate ? `Approve latest gate — ${latestGate.title}` : "Approve latest gate",
      hint: latestGate ? undefined : "No gate waiting",
      group: "Actions",
      icon: "✓",
      disabled: !latestGate,
      run: () => {
        if (!latestGate) return;
        resolveHitl(latestGate.id, "approve")
          .then(() => toast("Approved.", "success"))
          .catch(() => toast("Couldn't approve — it may already be resolved."));
        setView("queue");
        onClose();
      },
    };
    return [approveLatest, ...nav, ...openProjects];
  }, [projects, latestGate, setView, onOpenProject, onClose, resolveHitl]);

  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    return actions
      .map((a) => ({ a, score: fuzzyScore(a.label, query) }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a);
  }, [actions, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [filtered.length, query]);

  if (!open) return null;

  const runActive = () => {
    const a = filtered[activeIdx];
    if (a && !a.disabled) a.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runActive();
    }
  };

  let lastGroup: string | null = null;

  return (
    <div className="cmdk-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="cmdk-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Go to a view, open a project, approve the latest gate…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="cmdk-list" role="listbox">
          {filtered.length === 0 && <div className="cmdk-empty">No matches</div>}
          {filtered.map((a, i) => {
            const showGroup = a.group !== lastGroup;
            lastGroup = a.group;
            return (
              <div key={a.id}>
                {showGroup && <div className="cmdk-group">{a.group}</div>}
                <button
                  className={"cmdk-item" + (i === activeIdx ? " sel" : "") + (a.disabled ? " disabled" : "")}
                  disabled={a.disabled}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => !a.disabled && a.run()}
                >
                  <span className="cmdk-item-icon">{a.icon}</span>
                  <span className="cmdk-item-label">{a.label}</span>
                  {a.hint && <span className="cmdk-item-hint">{a.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
          <span><kbd>↵</kbd> go</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
