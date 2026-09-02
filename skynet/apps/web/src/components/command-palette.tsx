// ⌘K / Ctrl+K command palette (TASK 24 — decision-aware). Three groups, in
// this order: DECISIONS (live, from GET /api/decisions — approve inline,
// same underlying resolveHitl every other surface uses), ACTIONS (bulk/
// policy/destructive verbs over the fleet), GO TO (jump to a view or open a
// project by name — unchanged from before this task). Mounted once at the
// App level; App.tsx owns the open/close keydown (see the ⌘. TweaksPanel /
// ⌘↵ composer for the same "global shortcut lives near the root" pattern).
import { useEffect, useMemo, useRef, useState } from "react";
import type { Decision } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { breakerPanelHref } from "../lib/routing";
import { toast } from "./toast";
import type { ViewName } from "../App";

const NAV_TARGETS: { view: ViewName; label: string; icon: string }[] = [
  { view: "home", label: "Home", icon: "⌂" },
  { view: "queue", label: "Inbox", icon: "⊙" },
  { view: "decisionInbox", label: "Decisions", icon: "◆" },
  { view: "audit", label: "Audit", icon: "❑" },
  { view: "projects", label: "Projects", icon: "▤" },
  { view: "fleet", label: "Fleet", icon: "◇" },
  { view: "integrations", label: "Integrations", icon: "⑂" },
  { view: "merges", label: "Ready to merge", icon: "⇲" },
  { view: "roadmap", label: "Roadmap", icon: "◈" },
  { view: "settings", label: "Settings", icon: "⚙" },
];

// Short, uppercase kind chip for a decision row — a local, palette-scoped
// wordlist (deliberately not imported from kanban/inbox.tsx's own longer
// provenanceLabel — same "token-driven duplication over cross-surface reuse"
// convention every kanban/*.css file already documents; this is cosmetic
// label text, not shared logic).
const KIND_CHIP: Record<Decision["kind"], string> = {
  approval: "APPROVAL",
  diff: "DIFF",
  merge: "MERGE",
  question: "QUESTION",
  plan: "PLAN",
  escalation: "ESCALATION",
  verifier: "VERIFIER",
  roadmap_edit: "ROADMAP EDIT",
};

interface Action {
  id: string;
  label: string;
  hint?: string;
  group: "Decisions" | "Actions" | "GoTo";
  icon: string;
  disabled?: boolean;
  /** Decision rows only — renders the kind chip in place of the icon. */
  kind?: Decision["kind"];
  /** Actions rows only — the 4-state-ish colored dot the sidebar also uses. */
  dot?: "lime" | "human" | "warn";
  /** Requires a SECOND explicit Enter (armed, then confirmed) before `run`
   *  actually fires — never resolves on one ↵. Cleared by any other keypress
   *  or selection change, so a later unrelated Enter can never land on a
   *  stale arm. */
  destructive?: boolean;
  /** ⌘/Ctrl+Enter on a Decisions/Actions row — navigate to see the context
   *  instead of acting on it. Absent on GO TO rows: Enter already navigates
   *  there, so there's nothing distinct for ⌘Enter to do. */
  navigate?: () => void;
  run: () => void;
  /** A project name this row belongs to — Tab on it narrows the query to
   *  that project's name (the palette's own fuzzy filter does the rest). */
  scopeName?: string;
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

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/.test(navigator.platform ?? navigator.userAgent);

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
  const { projects, resolveHitl, readOnly } = useStore();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  // Armed destructive-action id — set by a first Enter, cleared by anything
  // else. Only a SECOND Enter on the SAME row (while still armed) executes.
  const [armedId, setArmedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIdx(0);
    setArmedId(null);
    // Autofocus after the modal has mounted (it's conditionally rendered).
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Fetched fresh on every open — the palette is a brief, in-and-out
  // interaction (unlike the Decision Inbox, which stays mounted and refreshes
  // on live queue changes), so a one-shot fetch is the simplest correct thing.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .fetchDecisions()
      .then((d) => {
        if (live) setDecisions(d);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);

  const approveDecision = (d: Decision) => {
    resolveHitl(d.id, "approve")
      .then(() => toast(`Approved — ${d.title}`, "success"))
      .catch(() => toast("Couldn't approve — it may already be resolved."));
    onClose();
  };

  const actions = useMemo<Action[]>(() => {
    const decisionActions: Action[] = decisions.map((d) => ({
      id: `decision:${d.id}`,
      label: d.title,
      hint: readOnly ? "viewer" : "↵ approve",
      group: "Decisions",
      icon: "",
      kind: d.kind,
      scopeName: d.projectName,
      disabled: readOnly,
      navigate: () => {
        window.location.hash = `#/agent/${d.runId}`;
        onClose();
      },
      run: () => approveDecision(d),
    }));

    const lowRisk = decisions.filter((d) => d.kind === "approval" && d.risk === "low");
    const totalApprovals = decisions.filter((d) => d.kind === "approval").length;
    const approveAllLowRisk: Action = {
      id: "action:approve-all-low-risk",
      label: `Approve all low-risk approvals · ${lowRisk.length} of ${totalApprovals}`,
      group: "Actions",
      icon: "✓",
      dot: "lime",
      disabled: readOnly || lowRisk.length === 0,
      navigate: () => {
        setView("decisionInbox");
        onClose();
      },
      run: () => {
        Promise.allSettled(lowRisk.map((d) => resolveHitl(d.id, "approve"))).then((results) => {
          const ok = results.filter((r) => r.status === "fulfilled").length;
          toast(ok === lowRisk.length ? `Approved ${ok} low-risk gate${ok === 1 ? "" : "s"}.` : `Approved ${ok} of ${lowRisk.length} — the rest may already be resolved.`, ok > 0 ? "success" : "error");
        });
        onClose();
      },
    };

    // One row per open project — "Set autonomy · <project>" reuses TASK 21's
    // existing one-shot pre-open mechanism (`#/project/<id>/autonomy`,
    // breakerPanelHref) rather than mounting a second copy of the dial.
    const setAutonomyActions: Action[] = projects
      .filter((p) => p.status !== "done")
      .map((p) => ({
        id: `action:autonomy:${p.id}`,
        label: `Set autonomy · ${p.name}`,
        group: "Actions" as const,
        icon: "◐",
        dot: "human" as const,
        scopeName: p.name,
        navigate: () => {
          onOpenProject(p.id);
          onClose();
        },
        run: () => {
          window.location.hash = breakerPanelHref(p.id);
          onClose();
        },
      }));

    const pauseFleet: Action = {
      id: "action:pause-fleet",
      label: armedId === "action:pause-fleet" ? "Pause the whole fleet — press ↵ again to confirm" : "Pause the whole fleet",
      hint: armedId === "action:pause-fleet" ? undefined : "halts every run, pauses autonomy",
      group: "Actions",
      icon: "⏻",
      dot: "warn",
      destructive: true,
      disabled: readOnly,
      navigate: () => {
        setView("fleet");
        onClose();
      },
      run: () => {
        api
          .stopAllRuns()
          .then(({ stopped }) => toast(`Paused the fleet — stopped ${stopped} run${stopped === 1 ? "" : "s"}.`, "success"))
          .catch(() => toast("Couldn't pause the fleet."));
        onClose();
      },
    };

    const nav: Action[] = NAV_TARGETS.map((n) => ({
      id: `nav:${n.view}`,
      label: `Go to ${n.label}`,
      group: "GoTo",
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
      group: "GoTo",
      icon: "▤",
      scopeName: p.name,
      run: () => {
        onOpenProject(p.id);
        onClose();
      },
    }));

    return [...decisionActions, approveAllLowRisk, ...setAutonomyActions, pauseFleet, ...nav, ...openProjects];
    // armedId IS a real dep: pauseFleet's label reflects it ("press ↵ again to
    // confirm"). Cheap to rebuild (no re-fetch), and filtered.length staying
    // the same means the activeIdx-reset effect below doesn't fire on arm/disarm.
  }, [decisions, projects, armedId, setView, onOpenProject, onClose, resolveHitl]);

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

  const active = filtered[activeIdx];

  const runActive = () => {
    if (!active || active.disabled) return;
    if (active.destructive) {
      if (armedId !== active.id) {
        setArmedId(active.id);
        return; // first Enter only arms it — never resolves on one ↵
      }
      setArmedId(null);
    } else if (armedId) {
      setArmedId(null);
    }
    active.run();
  };

  const navigateActive = () => {
    if (!active) return;
    setArmedId(null);
    // Navigating is never a mutation, so it's reachable even on a `disabled`
    // (read-only-viewer-blocked) row — but a disabled row with no explicit
    // `navigate` has nothing safe to fall back to (falling back to `run`
    // would silently perform the very mutation `disabled` was blocking).
    if (active.navigate) active.navigate();
    else if (!active.disabled) active.run();
  };

  const scopeToActive = () => {
    if (!active?.scopeName) return;
    setQuery(active.scopeName);
    setArmedId(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setArmedId(null);
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setArmedId(null);
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Tab") {
      e.preventDefault();
      scopeToActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) navigateActive();
      else runActive();
    }
  };

  const groupLabel: Record<Action["group"], string> = { Decisions: "Decisions", Actions: "Actions", GoTo: "Go to" };
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
          placeholder="Approve a decision, jump to a view, open a project…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setArmedId(null);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="cmdk-list" role="listbox">
          {filtered.length === 0 && <div className="cmdk-empty">No matches</div>}
          {filtered.map((a, i) => {
            const showGroup = a.group !== lastGroup;
            lastGroup = a.group;
            const sel = i === activeIdx;
            const armed = armedId === a.id;
            return (
              <div key={a.id}>
                {showGroup && <div className="cmdk-group">{groupLabel[a.group]}</div>}
                <button
                  className={
                    "cmdk-item" +
                    (sel ? " sel" : "") +
                    (a.disabled ? " disabled" : "") +
                    (a.group === "Decisions" ? " cmdk-item-decision" : "") +
                    (armed ? " armed" : "")
                  }
                  disabled={a.disabled}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => runActive()}
                >
                  {a.kind ? (
                    <span className="cmdk-kind-chip">{KIND_CHIP[a.kind]}</span>
                  ) : (
                    <span className="cmdk-item-icon">
                      {a.dot && <span className={"cmdk-dot cmdk-dot-" + a.dot} aria-hidden="true" />}
                      {a.icon}
                    </span>
                  )}
                  <span className="cmdk-item-label">{a.label}</span>
                  {a.hint && <span className="cmdk-item-hint">{a.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>{isMac ? "⌘" : "ctrl"}</kbd><kbd>↵</kbd> open instead of act</span>
          <span><kbd>tab</kbd> scope to project</span>
          {readOnly && <span className="cmdk-readonly">viewer — read-only</span>}
        </div>
      </div>
    </div>
  );
}
