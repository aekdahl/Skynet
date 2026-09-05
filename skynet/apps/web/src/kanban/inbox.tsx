// ─── Decision Inbox (Phase 13 — Fleet Governance Rollout, TASK 16) ──────────
// The global decision queue: every point an agent needs a human call, across
// every project, rendered as the same card shape in one place. Built on TASK
// 15's GET /api/decisions (cross-project HitlItem join + cost-of-waiting).
//
// This is a NEW screen, additive alongside the existing per-project Inbox
// (views/queue.tsx, still mounted at view==="queue", untouched) — same
// relationship Rail Graph had to Momentum/Gravity. It reuses the SAME
// decision-shaping logic queue.tsx/hitl-context.tsx already established
// (which fields mean what per HitlKind, which resolveHitl action shape each
// button call maps to) rather than rederiving it, but renders new markup in
// the --ak-* token system (this epic's design language) since the mockup's
// card anatomy (fixed content order, specific copy/labels) doesn't match the
// legacy queue card's look.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Decision, Project, RoadmapProposal, Task, TaskRun } from "@skynet/shared";
import { dayWindow } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { fmtWait, needsReviewConfirm } from "../lib/derive";
import { isTypingTarget } from "../lib/keys";
import { useChoice, useConfirm } from "../components/confirm";
import { useEscapeLayer } from "../lib/escape-stack";
import { groupBatchableDecisions, type GateBatch } from "./gate-batching";

// Minimal Store slice used by FleetRail — avoids importing the whole Store
// interface just for a type annotation on one destructured prop.
type Store = ReturnType<typeof useStore>;

// ── kind → card variant ──────────────────────────────────────────────────
// plan/verifier render with the approval card's anatomy (both are
// fundamentally "confirm to proceed", per the task spec). A `merge` item
// only gets the CONFLICT treatment when it carries TASK 15's "file_collision"
// flag — a plain merge-ready item (no textual collision, e.g. a non-conflict
// git failure) renders diff-shaped instead, same as the spec calls for.
export type CardVariant = "approval" | "question" | "diff" | "conflict" | "escalation" | "roadmap" | "roadmap_conflict";

// Exported so Home's "first three things" (Phase 22) can reuse the exact
// same escalation/conflict classification — same left-border language,
// never drifting from what the Inbox itself calls urgent.
export function cardVariant(item: Decision): CardVariant {
  switch (item.kind) {
    case "question":
      return "question";
    case "escalation":
      return "escalation";
    case "diff":
      return "diff";
    case "merge":
      return item.flags.includes("file_collision") ? "conflict" : "diff";
    case "roadmap_edit":
      // The plain-vs-conflict split for a roadmap_edit item depends on the
      // LIVE proposal's state (Rule 4 can flip it after this card was
      // raised — see roadmapProposalId's own doc comment), which this pure,
      // Decision-only function can't know. RoadmapEditCardBody re-derives
      // its own conflict styling once its live fetch resolves; this default
      // only shapes the outer shell before that (never conflict-red).
      return "roadmap";
    default: // approval, plan, verifier
      return "approval";
  }
}

function provenanceLabel(item: Decision): string {
  switch (item.kind) {
    case "approval":
      return item.command ? "APPROVAL · SHELL COMMAND" : "APPROVAL";
    case "plan":
      return "APPROVAL · PLAN REVIEW";
    case "verifier":
      return "APPROVAL · CHECKS FAILED";
    case "question":
      return "DECISION · CHOOSE ONE";
    case "diff":
      return "DIFF · REVIEW";
    case "merge":
      return item.flags.includes("file_collision") ? "CONFLICT · MERGE" : "DIFF · MERGE READY";
    case "escalation":
      return item.flags.includes("stuck-review") ? "ESCALATION · AWAITING REVIEW" : "ESCALATION · NEEDS HELP";
    case "roadmap_edit":
      return "ROADMAP EDIT · NEEDS YOUR YES";
  }
}

// ── right rail: today's spend ────────────────────────────────────────────
// Workspace-wide today's spend — reuses budget.ts's own `dayWindow` (the one
// place "today" is defined, shared with the server's autonomy gate) rather
// than reinventing a day boundary; sums across every project the same way,
// just without computeDailySpend's per-project filter.
function todaysSpend(runs: TaskRun[], now: number): { spentUsd: number; unknownCostRuns: number } {
  const { start, end } = dayWindow(now);
  let spentUsd = 0;
  let unknownCostRuns = 0;
  for (const r of runs) {
    if (r.startedAt < start || r.startedAt >= end) continue;
    const cost = r.usage?.costUsd;
    if (cost != null) spentUsd += cost;
    else unknownCostRuns++;
  }
  return { spentUsd, unknownCostRuns };
}

// 4-segment notch mapped straight from the real ApprovalLevel ordinal — TASK
// 19's composed detent (shadow/assisted/earned/unattended) hasn't landed
// (confirmed: no "detent" field anywhere in packages/shared/apps/server as of
// this task), so this reads today's real autonomy+approvalLevel instead of
// fabricating a detent history. No "dialled down Xh ago" line either — that
// needs a changed-at timestamp Project doesn't carry; showing a fake one
// would be worse than omitting it.
const LEVEL_NOTCH: Record<Project["approvalLevel"], number> = { manual: 1, assisted: 2, trusted: 3, full: 4 };
const LEVEL_LABEL: Record<Project["approvalLevel"], string> = { manual: "Manual", assisted: "Assisted", trusted: "Trusted", full: "Full autonomy" };

function DecisionInboxTopBar({
  waitingCount,
  oldestWaitSec,
  agentsRunning,
  onOpenShortcuts,
}: {
  waitingCount: number;
  oldestWaitSec: number | null;
  agentsRunning: number;
  onOpenShortcuts: () => void;
}) {
  return (
    <header className="di-topbar">
      <div className="di-brand">
        <span className="di-logo" aria-hidden="true">S</span>
        <span className="di-brand-name">Skynet · Decisions</span>
      </div>
      <div className="di-pills">
        <span className="di-pill di-pill-human">
          <span className="di-pill-dot" aria-hidden="true" />
          {/* Text carries the count independently of the dot's color — a
              screen reader (or a colorblind operator) gets the same number
              either way. */}
          <span aria-live="polite">{waitingCount} WAITING ON YOU{oldestWaitSec != null ? ` · OLDEST ${fmtWait(oldestWaitSec)}` : ""}</span>
        </span>
        <span className="di-pill di-pill-machine">FLEET: {agentsRunning} AGENTS RUNNING</span>
        {/* Phase 30 hardening — dropped this screen's own "silent fleet vs.
            disconnected" pill; the shared status strip (shell.tsx's
            OpStatusBar) is the ONE place a disconnect shows now. */}
        <button type="button" className="di-pill di-pill-ghost" onClick={onOpenShortcuts} title="Keyboard shortcuts (press ?)">
          j/k · y approve · n reject · ?
        </button>
      </div>
    </header>
  );
}

const SHORTCUTS: { key: string; desc: string }[] = [
  { key: "j / k", desc: "Move the selection down / up" },
  { key: "y", desc: "Approve the selected decision (or accept its recommended option)" },
  { key: "n", desc: "Reject the selected decision" },
  { key: "Enter", desc: "Open the selected decision's run" },
  { key: "1–9", desc: "Choose that numbered option on a question" },
  { key: "a", desc: "Approve and always allow this exact command for the project" },
  { key: "?", desc: "Show this shortcut map" },
];

function ShortcutMapOverlay({ onClose }: { onClose: () => void }) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  // Escape rides the shared escape-stack (lib/escape-stack.ts); "?" toggles
  // it too (same key that opened it), handled locally since that's not a
  // layering concern.
  useEscapeLayer(true, onClose);
  useEffect(() => {
    // Same "focus the primary control on open" convention components/confirm.tsx
    // already uses — moves focus off whatever triggered this (the header pill)
    // and into the dialog, so Tab acts on the dialog, not the page behind it.
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="di-shortcuts-backdrop" role="presentation" onClick={onClose}>
      <div
        className="di-shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="di-shortcuts-head">
          <h3>Keyboard shortcuts</h3>
          <button type="button" ref={closeBtn} className="di-hintbar-dismiss" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <dl className="di-shortcuts-list">
          {SHORTCUTS.map((s) => (
            <div key={s.key} className="di-shortcuts-row">
              <dt><kbd>{s.key}</kbd></dt>
              <dd>{s.desc}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function FleetRail({ fleet, runs, now }: { fleet: Store["fleet"]; runs: TaskRun[]; now: number }) {
  return (
    <div className="di-side-card">
      <h3 className="di-side-head">Fleet · right now</h3>
      {fleet.length === 0 && <p className="di-side-empty">No agents configured.</p>}
      <ul className="di-fleet-list">
        {fleet.map((a) => {
          const run = a.status === "busy" ? runs.find((r) => r.agentId === a.id && r.status !== "done") : undefined;
          const step = run?.plan.find((p) => p.state === "now")?.text ?? (run ? "working" : null);
          return (
            <li key={a.id} className="di-fleet-row">
              <span className={"di-dot" + (a.status === "busy" ? " di-dot-busy" : " di-dot-idle")} aria-hidden="true" />
              <span className="di-fleet-name">{a.name}</span>
              <span className="di-fleet-model mono">{a.model}</span>
              <span className={"di-fleet-activity" + (step ? " di-fleet-activity-live" : "")}>{step ?? "idle"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AutonomyRail({ projects }: { projects: Project[] }) {
  const live = projects.filter((p) => p.status !== "done");
  return (
    <div className="di-side-card">
      <h3 className="di-side-head">Autonomy</h3>
      {live.length === 0 && <p className="di-side-empty">No active projects.</p>}
      <ul className="di-autonomy-list">
        {live.map((p) => (
          <li key={p.id} className="di-autonomy-row">
            <span className="di-autonomy-name">{p.name}</span>
            <span className="di-notches" aria-hidden="true">
              {[1, 2, 3, 4].map((n) => (
                <span key={n} className={"di-notch" + (p.autonomy && n <= LEVEL_NOTCH[p.approvalLevel] ? " on" : "")} />
              ))}
            </span>
            <span className="di-autonomy-label">{p.autonomy ? LEVEL_LABEL[p.approvalLevel] : "Autonomy off"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SpendRail({ runs, now }: { runs: TaskRun[]; now: number }) {
  const { spentUsd, unknownCostRuns } = useMemo(() => todaysSpend(runs, now), [runs, now]);
  return (
    <div className="di-side-card">
      <h3 className="di-side-head">Today&apos;s spend</h3>
      <p className="di-spend-num">${spentUsd.toFixed(2)}</p>
      {unknownCostRuns > 0 && (
        <p className="di-side-hint">+{unknownCostRuns} run{unknownCostRuns === 1 ? "" : "s"} with unreported cost</p>
      )}
    </div>
  );
}

// ── roadmap_edit card (TASK 30) ──────────────────────────────────────────
// A machine changing the roadmap becomes a governed Inbox decision — its own
// body anatomy (a real diff, the agent's-own-words reasoning, two evidence
// panels) since nothing else in the Inbox needs that shape, plus a
// held_conflict variant (Rule 4) with its own two-sided compare. Neither
// variant trusts the HITL item's own title/why snapshot for its rich
// content (that's a Telegram-only concession, see HitlItem.roadmapProposalId's
// doc comment) — both live-fetch the real RoadmapProposal.

/** The literal markdown diff: context lines faint, removed lines struck +
 *  warn-tinted, added lines machine-green-tinted, full-bleed row highlights.
 *  `diff.context` is the section's ENTIRE raw text as drafted against (not
 *  just the touched lines), so this walks every line and reclassifies it by
 *  whether it's in `removed` — the untouched context around the edit still
 *  renders, same as the literal diff a human reviewing this would see. */
function RoadmapDiffView({ diff }: { diff: RoadmapProposal["diff"] }) {
  const removedSet = new Set(diff.removed);
  return (
    <div className="di-diff mono">
      {diff.context.split("\n").map((line, i) => (
        <div key={`c${i}`} className={"di-diff-line" + (removedSet.has(line) ? " di-diff-del" : " di-diff-ctx")}>
          {removedSet.has(line) ? "− " : "  "}
          {line || " "}
        </div>
      ))}
      {diff.added.map((line, i) => (
        <div key={`a${i}`} className="di-diff-line di-diff-add">
          {"+ "}
          {line || " "}
        </div>
      ))}
    </div>
  );
}

/** "IF YOU SAY YES" (impact) / "WHAT IT DIDN'T TOUCH" (respectedBoundaries) —
 *  the two evidence panels the card spec calls for, straight off the
 *  proposal's own fields. */
function ImpactBoundaryPanels({ proposal }: { proposal: RoadmapProposal }) {
  const impactRows = [
    ...proposal.impact.tasksCreated.map((t) => `Task created: ${t}`),
    ...proposal.impact.questionsResolved.map((q) => `Resolves: ${q}`),
    ...proposal.impact.dependencies.map((d) => `Depends on: ${d}`),
  ];
  return (
    <div className="di-panels">
      <div className="di-panel">
        <p className="di-panel-title">If you say yes</p>
        {impactRows.length > 0 ? (
          <ul className="di-panel-list">
            {impactRows.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="di-panel-empty">No further downstream effects noted.</p>
        )}
      </div>
      <div className="di-panel">
        <p className="di-panel-title">What it didn't touch</p>
        {proposal.respectedBoundaries.length > 0 ? (
          <ul className="di-panel-list">
            {proposal.respectedBoundaries.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        ) : (
          <p className="di-panel-empty">Nothing specifically called out.</p>
        )}
      </div>
    </div>
  );
}

// TASK 28's four concurrency rules, restated for the conflict card's neutral
// panel — lime dots = the system already enforces this on its own, blue dots
// = a human call is structurally required, no autonomy setting bypasses it.
const CONCURRENCY_RULES: { text: string; machine: boolean }[] = [
  { text: "One open proposal per section — a compatible second proposal joins it, never forks a new row.", machine: true },
  { text: "A deletion or a promised-date change always needs a human — at ANY autonomy detent.", machine: false },
  { text: "The repo wins — a human's direct edit supersedes a stale proposal automatically.", machine: true },
  { text: "Contradictory proposals are held for you — further agent work on the section locks until you decide.", machine: false },
];

function RoadmapConcurrencyRules() {
  return (
    <div className="di-rules-panel">
      {CONCURRENCY_RULES.map((r, i) => (
        <div key={i} className="di-rule-row">
          <span className={"di-rule-dot " + (r.machine ? "di-rule-dot-machine" : "di-rule-dot-human")} />
          <span>{r.text}</span>
        </div>
      ))}
    </div>
  );
}

function RoadmapEditCard({
  item,
  selected,
  leaving,
  now,
  onOpen,
  onResolve,
}: {
  item: Decision;
  selected: boolean;
  leaving: boolean;
  now: number;
  onOpen: () => void;
  onResolve: (action: "approve" | "reject" | "modify" | "option" | "reassign", extra?: { optionIndex?: number; guidance?: string; resetWork?: boolean; remember?: boolean }) => void;
}) {
  const [proposal, setProposal] = useState<RoadmapProposal | null>(null);
  const [other, setOther] = useState<RoadmapProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const idleSec = Math.max(0, (now - item.raisedAt) / 1000);
  const idleUrgent = idleSec > 15 * 60;

  useEffect(() => {
    let cancelled = false;
    if (!item.projectId || !item.roadmapProposalId) {
      setLoading(false);
      return;
    }
    api
      .fetchRoadmapProposal(item.projectId, item.roadmapProposalId)
      .then(async (p) => {
        if (cancelled) return;
        setProposal(p);
        // held_conflict — fetch the other side of the pair too, so the
        // conflict card can show both without a second round trip later.
        if (p.state === "held_conflict" && p.conflictsWith[0]) {
          const o = await api.fetchRoadmapProposal(item.projectId!, p.conflictsWith[0]).catch(() => null);
          if (!cancelled) setOther(o);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.projectId, item.roadmapProposalId]);

  const conflict = proposal?.state === "held_conflict";

  // The conflict actions call the dedicated route directly (its shape
  // doesn't fit the generic approve/reject `onResolve`), then still call
  // `onResolve` — Hub.resolveHitl is first-writer-wins, so this redundant
  // second resolve is a harmless no-op — purely to reuse the parent's
  // existing collapse/leaving animation instead of duplicating it here.
  const choose = async (chosenProposalId: string) => {
    if (!item.projectId) return;
    await api.resolveRoadmapConflict(item.id, { action: "choose", chosenProposalId }).catch(() => undefined);
    onResolve("approve");
  };
  const writeOwn = async () => {
    await api.resolveRoadmapConflict(item.id, { action: "write_own" }).catch(() => undefined);
    onResolve("reject");
  };

  return (
    <article className={"di-card" + (selected ? " sel" : "") + (leaving ? " leaving" : "") + (conflict ? " di-card-conflict" : "")}>
      <div className="di-card-head">
        <span className="di-kind-label mono">{conflict ? "ROADMAP CONFLICT · NEEDS YOUR CALL" : "ROADMAP EDIT · NEEDS YOUR YES"}</span>
        <span className="di-meta">{item.projectName}</span>
        <span className={"di-idle" + (idleUrgent ? " urgent" : "")}>{fmtWait(idleSec)}</span>
      </div>

      {loading ? (
        <p className="di-panel-empty">Loading the proposal…</p>
      ) : !proposal ? (
        <p className="di-panel-empty">This proposal is no longer available — it may already be resolved elsewhere.</p>
      ) : conflict ? (
        <>
          <p className="di-verdict">Both are reasonable and they cancel out — pick one, or write it yourself.</p>
          <div className="di-conflict-pair">
            <div className="di-conflict-side">
              <p className="di-conflict-side-label">Proposal A</p>
              <p className="di-conflict-side-headline">{proposal.headline}</p>
              <p className="di-conflict-side-evidence">{proposal.reasoning}</p>
            </div>
            {other && (
              <div className="di-conflict-side">
                <p className="di-conflict-side-label">Proposal B</p>
                <p className="di-conflict-side-headline">{other.headline}</p>
                <p className="di-conflict-side-evidence">{other.reasoning}</p>
              </div>
            )}
          </div>
          <div className="di-actions">
            <button className="di-btn di-btn-primary" onClick={() => choose(proposal.id)}>
              TAKE A'S
            </button>
            {other && (
              <button className="di-btn di-btn-secondary" onClick={() => choose(other.id)}>
                TAKE B'S
              </button>
            )}
            <button className="di-btn di-btn-ghost" onClick={writeOwn}>
              WRITE MY OWN
            </button>
          </div>
          <RoadmapConcurrencyRules />
        </>
      ) : (
        <>
          <p className="di-verdict">{proposal.headline}</p>
          <div className="di-roadmap-body">
            <RoadmapDiffView diff={proposal.diff} />
            <p className="di-why-label">Why, in its own words</p>
            <p className="di-why-body">“{proposal.reasoning}”</p>
            <ImpactBoundaryPanels proposal={proposal} />
          </div>
          <div className="di-actions">
            <button className="di-btn di-btn-primary" onClick={() => onResolve("approve")}>
              APPROVE & COMMIT
            </button>
            <button
              className="di-btn di-btn-secondary"
              title="Opens the wording for editing before it commits. Full inline editing lands with the roadmap SOURCE editor — for now this opens the project so you can adjust ROADMAP.md directly."
              onClick={onOpen}
            >
              EDIT THE WORDING FIRST
            </button>
            <button className="di-btn di-btn-ghost" onClick={() => onResolve("reject")}>
              REJECT
            </button>
          </div>
        </>
      )}

      <p className="di-footnote">also on Telegram</p>
      <button className="di-open-link" onClick={onOpen} title="Open the project">
        Open →
      </button>
    </article>
  );
}

// Policy-driven gate batching — several identical command-approval gates
// (same normalized command, raised across different runs) as ONE decision
// instead of N. Deliberately a much simpler action set than DecisionCard's
// (approve/reject only, no option/modify/reassign/remember/guided-merge —
// none of those make sense applied identically to N different runs at
// once); a member the operator wants to handle differently is still a
// normal card once expanded, since batching never removes it from the
// underlying decision list, only groups its DISPLAY.
function BatchedDecisionCard({
  batch,
  now,
  onResolve,
}: {
  batch: GateBatch;
  now: number;
  onResolve: (action: "approve" | "reject") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const n = batch.items.length;
  const oldestIdleSec = Math.max(...batch.items.map((it) => Math.max(0, (now - it.raisedAt) / 1000)));
  const projectNames = [...new Set(batch.items.map((it) => it.projectName))];

  return (
    <article className="di-card di-batch-card">
      <div className="di-card-head">
        <span className="di-kind-label mono">BATCHED APPROVAL</span>
        <span className="di-batch-count mono">{n} gates</span>
        <span className="di-meta">{projectNames.length === 1 ? projectNames[0] : `${projectNames.length} projects`}</span>
        <span className="di-idle">{fmtWait(oldestIdleSec)}</span>
      </div>

      <p className="di-verdict">The exact same command is waiting on {n} runs.</p>

      <div className="di-evidence">
        <pre className="di-code mono">$ {batch.command}</pre>
      </div>

      <button className="di-batch-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        {expanded ? "Hide" : "Show"} the {n} gates {expanded ? "▴" : "▾"}
      </button>
      {expanded && (
        <ul className="di-batch-members">
          {batch.items.map((it) => (
            <li key={it.id} className="di-batch-member">
              <span className="di-batch-member-project">{it.projectName}</span>
              <span className="di-batch-member-task">{it.taskTitle ?? it.runId}</span>
              <span className="di-batch-member-wait mono">{fmtWait(Math.max(0, (now - it.raisedAt) / 1000))}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="di-actions">
        <button className="di-btn di-btn-primary" onClick={() => onResolve("approve")}>APPROVE ALL {n}</button>
        <button className="di-btn di-btn-ghost" onClick={() => onResolve("reject")}>REJECT ALL {n}</button>
      </div>
      <p className="di-footnote">resolves all {n} individually — same effect as approving each one by hand</p>
    </article>
  );
}

function DecisionCard({
  item,
  selected,
  leaving,
  now,
  onOpen,
  onResolve,
  runs,
  tasks,
  fleet,
}: {
  item: Decision;
  selected: boolean;
  leaving: boolean;
  now: number;
  onOpen: () => void;
  onResolve: (action: "approve" | "reject" | "modify" | "option" | "reassign", extra?: { optionIndex?: number; guidance?: string; resetWork?: boolean; remember?: boolean }) => void;
  runs: TaskRun[];
  tasks: Task[];
  fleet: Store["fleet"];
}) {
  const variant = cardVariant(item);
  const choice = useChoice();
  const confirm = useConfirm();
  const [takeOverDraft, setTakeOverDraft] = useState("");
  const [showTakeOver, setShowTakeOver] = useState(false);
  const run = runs.find((r) => r.id === item.runId);
  // TaskRun.name is the TASK's name copied onto the run (see contracts.ts),
  // not an agent nickname — the agent's own display name needs its own
  // lookup into the fleet roster by run.agentId.
  const agentName = fleet.find((a) => a.id === run?.agentId)?.name ?? item.runId;
  const idleSec = Math.max(0, (now - item.raisedAt) / 1000);
  const idleUrgent = idleSec > 15 * 60; // amber once it's genuinely been sitting a while

  const approve = () => onResolve("approve");
  const reject = () => onResolve("reject");

  const giveItTheKey = async () => {
    const picked = await choice({
      title: "Reassign to a different runner",
      body: "How should the new runner pick this up?",
      options: [
        { value: "continue", label: "Continue in this worktree", hint: "Picks up the branch's committed work where the last runner left off.", primary: true },
        { value: "reset", label: "Start clean", hint: "Discards this worktree's work — starts fresh on a new branch.", danger: true },
      ],
    });
    if (picked) onResolve("reassign", { resetWork: picked === "reset" });
  };

  return (
    <article className={"di-card" + (selected ? " sel" : "") + (leaving ? " leaving" : "") + (variant === "escalation" ? " di-card-escalation" : "") + (variant === "conflict" ? " di-card-conflict" : "")}>
      <div className="di-card-head">
        <span className="di-kind-label mono">{provenanceLabel(item)}</span>
        {run && <span className="di-meta">{agentName}</span>}
        <span className="di-meta">{item.projectName}</span>
        {item.taskTitle && <span className="di-meta">{item.taskTitle}</span>}
        <span className={"di-idle" + (idleUrgent ? " urgent" : "")}>{fmtWait(idleSec)}</span>
      </div>

      <p className="di-verdict">{item.title}</p>

      <div className="di-evidence">
        {item.command && <pre className="di-code mono">$ {item.command}</pre>}
        {variant === "approval" && item.why && <p className="di-consequence">{item.why}</p>}

        {variant === "question" &&
          item.options?.map((opt, i) => (
            <div key={i} className={"di-option" + (i === item.recommended ? " rec" : "")}>
              <span className="di-option-letter mono">{String.fromCharCode(65 + i)}</span>
              <span className="di-option-text">{opt}</span>
              {i === item.recommended && <span className="di-option-rec">recommended</span>}
            </div>
          ))}

        {(variant === "diff" || variant === "conflict") && item.diff && (
          <div className="di-meta-strip mono">
            {item.diff.modules.length > 0 && <span>{item.diff.modules.join(", ")}</span>}
            <span>+{item.diff.add} -{item.diff.del}</span>
          </div>
        )}
        {variant === "conflict" &&
          item.flags.filter((f) => f !== "file_collision").map((f, i) => (
            <span key={i} className="di-file-chip mono">{f}</span>
          ))}

        {variant === "escalation" && item.rationale && <p className="di-escalation-read">{item.rationale}</p>}
        {variant === "escalation" && run && (
          <p className="di-burn mono">
            Active {fmtWait((now - run.startedAt) / 1000)}
            {run.usage?.costUsd != null ? ` · $${run.usage.costUsd.toFixed(2)} spent` : ""}
          </p>
        )}

        {item.kind === "verifier" && item.output && <pre className="di-code di-code-output mono">{item.output}</pre>}
        {item.steps && (
          <ol className="di-steps">
            {item.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        )}
      </div>

      {variant === "escalation" ? (
        <div className="di-actions">
          {!showTakeOver ? (
            <button className="di-btn di-btn-primary" onClick={() => setShowTakeOver(true)}>TAKE IT OVER</button>
          ) : (
            <div className="di-takeover">
              <input
                className="di-input"
                autoFocus
                placeholder="Guidance for the agent…"
                value={takeOverDraft}
                onChange={(e) => setTakeOverDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { onResolve("modify", { guidance: takeOverDraft.trim() }); setShowTakeOver(false); }
                }}
              />
              <button className="di-btn di-btn-primary" onClick={() => { onResolve("modify", { guidance: takeOverDraft.trim() }); setShowTakeOver(false); }}>Send</button>
            </div>
          )}
          <button className="di-btn di-btn-secondary" onClick={giveItTheKey}>GIVE IT THE KEY</button>
          <button className="di-btn di-btn-ghost" onClick={reject}>RETURN TO BACKLOG</button>
        </div>
      ) : variant === "question" ? (
        <div className="di-actions">
          {item.options?.map((opt, i) => (
            <button key={i} className={"di-btn" + (i === item.recommended ? " di-btn-primary" : " di-btn-secondary")} onClick={() => onResolve("option", { optionIndex: i })}>
              {opt}
            </button>
          ))}
          <button className="di-btn di-btn-ghost" onClick={reject}>REJECT</button>
        </div>
      ) : (
        <div className="di-actions">
          <button
            className="di-btn di-btn-primary"
            onClick={async () => {
              if (
                needsReviewConfirm(item, tasks) &&
                !(await confirm({
                  title: "Merge without a review?",
                  body: "No other agent has reviewed this yet — you'd be the first (and only) look at it before it merges.",
                  confirmLabel: "Merge anyway",
                  danger: true,
                }))
              )
                return;
              approve();
            }}
          >
            APPROVE ONCE
          </button>
          {item.kind === "approval" && (
            <button
              className="di-btn di-btn-secondary"
              title="Approves once and remembers this exact command as a standing allowance for the project (same rule TASK 20's Keys & Budget panel and Telegram's 'Always allow' write to)."
              onClick={() => onResolve("approve", { remember: true })}
            >
              ALWAYS FOR THIS PROJECT
            </button>
          )}
          <button className="di-btn di-btn-ghost" onClick={reject}>REJECT</button>
        </div>
      )}

      <p className="di-footnote">also sent to Telegram</p>
      <button className="di-open-link" onClick={onOpen} title="Open the full run">Open →</button>
    </article>
  );
}

const EMPTY_HINTS_KEY = "skynet.decisionInboxHintsDismissed";

// Below this width the fixed 372px right rail has nowhere to go — same
// width-gated conditional-render shape gravity.tsx's own useViewportWidth
// uses for its Momentum fallback, duplicated locally rather than shared
// (this epic's convention: token-driven duplication, not a shared component,
// per rules.css/board.css/etc.'s own header comments).
const DI_SIDE_COLLAPSE_WIDTH = 1080;
function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : DI_SIDE_COLLAPSE_WIDTH));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

export function DecisionInboxView({
  onOpenTask,
  onOpenProject,
  onOpenAudit,
  now,
}: {
  onOpenTask: (runId: string) => void;
  // TASK 30 — a roadmap_edit item has no run to open (see roadmapProposalId's
  // own doc comment); its "Open" goes to the project instead.
  onOpenProject: (projectId: string) => void;
  onOpenAudit: () => void;
  now: number;
}) {
  const store = useStore();
  const { queue, runs, tasks, projects, fleet, resolveHitl, resolveHitlBatch } = store;
  const [items, setItems] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupByProject, setGroupByProject] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [leavingIds, setLeavingIds] = useState<Set<string>>(new Set());
  const [showShortcuts, setShowShortcuts] = useState(false);
  // > not >= — matches the CSS's own `@media (max-width: 1080px)` boundary
  // exactly (that query already fires AT 1080px), so the two never disagree.
  const wide = useViewportWidth() > DI_SIDE_COLLAPSE_WIDTH;
  const [hintsDismissed, setHintsDismissed] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(EMPTY_HINTS_KEY) === "1",
  );

  // Fetch once, then refresh whenever the live workspace queue changes — the
  // same "fetch-once + refresh-on-live-signal" shape Rail Graph/Feed use for
  // Transition history, just triggered by `queue` (already live via WS)
  // instead of a raw hitl.raised/resolved subscription. Cheap and simple:
  // HITL volume is low, so a full refetch per queue change is fine — no need
  // to duplicate the server's join/cost-of-waiting math client-side.
  useEffect(() => {
    let cancelled = false;
    api.fetchDecisions().then((d) => {
      if (!cancelled) { setItems(d); setLoading(false); }
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [queue]);

  // Drop an item once its collapse animation has played (or immediately if it
  // was resolved by another channel — Telegram, the old per-project Inbox —
  // without ever passing through THIS card's own resolve handler).
  const visible = useMemo(() => items.filter((it) => !leavingIds.has(it.id)), [items, leavingIds]);

  // Gate batching — several identical command-approval gates across N runs
  // collapse into one card (batches) instead of N (see gate-batching.ts).
  // `singles` (everything NOT folded into a batch) is what the rest of this
  // view's existing project-grouping/keyboard-nav logic operates on below,
  // unchanged — a batch is a separate section, never part of displayOrder.
  const { batches, singles } = useMemo(() => groupBatchableDecisions(visible), [visible]);

  const grouped = useMemo(() => {
    if (!groupByProject) return [{ projectName: null as string | null, rows: singles }];
    const byProject = new Map<string, Decision[]>();
    for (const it of singles) byProject.set(it.projectId, [...(byProject.get(it.projectId) ?? []), it]);
    // Preserve the server's cost-of-waiting order for which GROUP comes
    // first — the group containing the current most-urgent item leads.
    return [...byProject.entries()]
      .sort(([, a], [, b]) => b[0]!.costOfWaiting - a[0]!.costOfWaiting)
      .map(([, rows]) => ({ projectName: rows[0]!.projectName, rows }));
  }, [singles, groupByProject]);

  // The order j/k/y/n/Enter actually walk — MUST match what's on screen, so
  // toggling "Group by project" doesn't leave keyboard nav jumping to a
  // different part of the page than what's visually selected (found live:
  // with grouping on, `visible`'s flat cost-of-waiting order no longer
  // matched the grouped render order at all). Identical to `visible` when
  // ungrouped (one group, same order).
  const displayOrder = useMemo(() => grouped.flatMap((g) => g.rows), [grouped]);

  useEffect(() => {
    if (selectedIdx > displayOrder.length - 1) setSelectedIdx(Math.max(0, displayOrder.length - 1));
  }, [displayOrder.length, selectedIdx]);

  const resolveAndCollapse = (
    item: Decision,
    action: "approve" | "reject" | "modify" | "option" | "reassign",
    extra?: { optionIndex?: number; guidance?: string; resetWork?: boolean; remember?: boolean },
  ) => {
    setLeavingIds((s) => new Set(s).add(item.id));
    void resolveHitl(item.id, action, extra);
    // Real, observable 160ms collapse — decoupled from how fast the live
    // queue array actually drops the item, so the animation always plays
    // instead of the DOM node vanishing on the very next store update.
    setTimeout(() => {
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setLeavingIds((s) => { const n = new Set(s); n.delete(item.id); return n; });
    }, 170);
  };

  // Same shape as resolveAndCollapse, batched: one API call for every member
  // id, then every card in the batch collapses together.
  const resolveBatchAndCollapse = (batch: GateBatch, action: "approve" | "reject") => {
    const ids = batch.items.map((it) => it.id);
    setLeavingIds((s) => { const n = new Set(s); for (const id of ids) n.add(id); return n; });
    void resolveHitlBatch(ids, action);
    setTimeout(() => {
      const idSet = new Set(ids);
      setItems((prev) => prev.filter((i) => !idSet.has(i.id)));
      setLeavingIds((s) => { const n = new Set(s); for (const id of ids) n.delete(id); return n; });
    }, 170);
  };

  // j/k move, y/n resolve, Enter opens (falls back to today's run view — TASK
  // 17's full pane doesn't exist yet), a widens trust (the same TASK-20 stub
  // the card's own button triggers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      // "?" (the shortcut map) is discoverable even with nothing in the
      // inbox — every other shortcut below needs a selected item to act on.
      if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts(true);
        return;
      }
      if (displayOrder.length === 0) return;
      const it = displayOrder[selectedIdx];
      switch (e.key) {
        case "j":
          e.preventDefault();
          setSelectedIdx((i) => Math.min(i + 1, displayOrder.length - 1));
          break;
        case "k":
          e.preventDefault();
          setSelectedIdx((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          if (!it) return;
          e.preventDefault();
          if (it.kind === "roadmap_edit") onOpenProject(it.projectId);
          else onOpenTask(it.runId);
          break;
        case "y":
          if (!it) return;
          e.preventDefault();
          if (it.kind === "question") resolveAndCollapse(it, "option", { optionIndex: it.recommended ?? 0 });
          else if (it.kind !== "escalation") resolveAndCollapse(it, "approve");
          break;
        case "n":
          if (!it) return;
          e.preventDefault();
          resolveAndCollapse(it, "reject");
          break;
        case "a":
          if (!it || it.kind !== "approval") return;
          e.preventDefault();
          resolveAndCollapse(it, "approve", { remember: true });
          break;
        default: {
          // 1/2/3… choose a question's option by position — same action the
          // per-option button already sends, matching the answer's on-screen
          // letter (A/B/C…) which is 1-indexed on the keyboard for reachability.
          if (it?.kind === "question" && it.options?.length && /^[1-9]$/.test(e.key)) {
            const idx = Number(e.key) - 1;
            if (idx < it.options.length) {
              e.preventDefault();
              resolveAndCollapse(it, "option", { optionIndex: idx });
            }
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveAndCollapse closes over items/leavingIds via setState updaters, stable across renders
  }, [displayOrder, selectedIdx, onOpenTask]);

  const oldestWaitSec = visible.length > 0 ? Math.max(...visible.map((it) => (now - it.raisedAt) / 1000)) : null;
  const agentsRunning = fleet.filter((a) => a.status === "busy").length;

  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const handledByPolicyToday = queue.filter(
    (q) => q.resolvedAt != null && q.resolvedAt >= startOfToday && q.resolution?.by?.startsWith("policy:"),
  ).length;

  const dismissHints = () => {
    localStorage.setItem(EMPTY_HINTS_KEY, "1");
    setHintsDismissed(true);
  };

  return (
    <div className="di-wrap">
      <DecisionInboxTopBar
        waitingCount={visible.length}
        oldestWaitSec={oldestWaitSec}
        agentsRunning={agentsRunning}
        onOpenShortcuts={() => setShowShortcuts(true)}
      />
      {showShortcuts && <ShortcutMapOverlay onClose={() => setShowShortcuts(false)} />}
      <div className="di-grid">
        <div className="di-left">
          <div className="di-section-row">
            <h2 className="di-section-rule">Needs a person · {visible.length}</h2>
            <label className="di-group-toggle">
              <input
                type="checkbox"
                checked={groupByProject}
                onChange={(e) => {
                  setGroupByProject(e.target.checked);
                  // A focused <input> (any type — isTypingTarget doesn't
                  // distinguish a checkbox from a text field) silently kills
                  // every j/k/y/n/a shortcut below until focus moves away.
                  // Found live: toggling this by mouse left every shortcut
                  // dead with no visible sign why. Blur it immediately so
                  // the keyboard-first Inbox stays keyboard-first.
                  e.target.blur();
                }}
              />
              Group by project
            </label>
          </div>
          {!hintsDismissed && visible.length > 0 && (
            <div className="di-hintbar" role="note">
              <span><kbd>j</kbd><kbd>k</kbd> move</span>
              <span><kbd>y</kbd> approve</span>
              <span><kbd>n</kbd> reject</span>
              <span><kbd>↵</kbd> open</span>
              <span><kbd>a</kbd> widen trust</span>
              <button className="di-hintbar-dismiss" onClick={dismissHints} aria-label="Dismiss">✕</button>
            </div>
          )}

          {batches.length > 0 && (
            <div className="di-group di-batch-group">
              <div className="di-cards">
                {batches.map((b) => (
                  <BatchedDecisionCard key={b.key} batch={b} now={now} onResolve={(action) => resolveBatchAndCollapse(b, action)} />
                ))}
              </div>
            </div>
          )}

          {loading ? (
            <div className="di-skel">
              <div className="ak-skel-row" /><div className="ak-skel-row" /><div className="ak-skel-row" />
            </div>
          ) : visible.length === 0 ? (
            <div className="di-empty">
              <p>Nothing waiting.</p>
              <p className="di-empty-sub">{handledByPolicyToday} gate{handledByPolicyToday === 1 ? "" : "s"} handled by policy today.</p>
            </div>
          ) : (
            grouped.map((g, gi) => (
              <div key={g.projectName ?? gi} className="di-group">
                {g.projectName && <h3 className="di-group-head">{g.projectName}</h3>}
                <div className="di-cards">
                  {g.rows.map((it) => {
                    const flatIdx = displayOrder.findIndex((v) => v.id === it.id);
                    // TASK 30 — a roadmap_edit item is a genuinely different
                    // shape (no run, no fleet agent behind it) — a separate
                    // component, not a branch inside DecisionCard, so its
                    // own hooks (the live proposal fetch) never have to
                    // coexist with DecisionCard's hooks conditionally.
                    if (it.kind === "roadmap_edit") {
                      return (
                        <RoadmapEditCard
                          key={it.id}
                          item={it}
                          selected={flatIdx === selectedIdx}
                          leaving={leavingIds.has(it.id)}
                          now={now}
                          onOpen={() => onOpenProject(it.projectId)}
                          onResolve={(action, extra) => resolveAndCollapse(it, action, extra)}
                        />
                      );
                    }
                    return (
                      <DecisionCard
                        key={it.id}
                        item={it}
                        selected={flatIdx === selectedIdx}
                        leaving={leavingIds.has(it.id)}
                        now={now}
                        onOpen={() => onOpenTask(it.runId)}
                        onResolve={(action, extra) => resolveAndCollapse(it, action, extra)}
                        runs={runs}
                        tasks={tasks}
                        fleet={fleet}
                      />
                    );
                  })}
                </div>
              </div>
            ))
          )}

          <h2 className="di-section-rule di-section-rule-lime">Handled without you · {handledByPolicyToday} today</h2>
          <p className="di-audit-link">
            {handledByPolicyToday} gate{handledByPolicyToday === 1 ? "" : "s"} auto-approved by policy today.{" "}
            <button className="di-link-btn" onClick={onOpenAudit}>
              View the audit trail →
            </button>
          </p>
        </div>
        {wide ? (
          <div className="di-side">
            <FleetRail fleet={fleet} runs={runs} now={now} />
            <AutonomyRail projects={projects} />
            <SpendRail runs={runs} now={now} />
          </div>
        ) : (
          // Below ~1080px the fixed 372px rail has nowhere to go — collapse
          // it into a native <details> strip (free keyboard/AT toggle
          // semantics) placed above the card list via CSS `order`, not a
          // separate narrow-only layout to maintain.
          <details className="di-side di-side-strip">
            <summary className="di-side-strip-summary">Fleet · Autonomy · Spend</summary>
            <div className="di-side-strip-body">
              <FleetRail fleet={fleet} runs={runs} now={now} />
              <AutonomyRail projects={projects} />
              <SpendRail runs={runs} now={now} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
