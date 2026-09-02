// ─── Run Detail (Phase 14 — TASK 17) ───────────────────────────────────────
// "Watch one agent closely — its plan, its live activity, the gate that
// stopped it." A full-screen replacement for views/task.tsx's TaskDetail on
// newBoardEnabled projects (App.tsx wires the choice), built on data that
// already exists: TaskRun.plan/log/modifiedFiles/usage, live via the same WS
// deltas TaskDetail reads. The only new server-side surface it depends on is
// additive: LogLine.verb/resultKind (packages/runner-sdk/src/claude.ts) and
// PlanStep.requiresApproval (Hub.annotateApproval) — both optional, so an
// older log line or a non-Claude provider's plan just renders without them.
import { useEffect, useRef, useState } from "react";
import type { ApprovalLevel, LogLine, LogVerb, PlanStep, TaskRun } from "@skynet/shared";
import { useStore } from "../lib/store";
import {
  curStep,
  fileCollisionsForAgent,
  fmtCost,
  fmtElapsed,
  hitlFor,
  runnerName,
  stepIdx,
} from "../lib/derive";
import { useConfirm } from "../components/confirm";
import { QueueCard } from "../views/queue";

const VERB_META = {
  read: { label: "READ", glyph: "◎" },
  grep: { label: "GREP", glyph: "⌕" },
  edit: { label: "EDIT", glyph: "✎" },
  shell: { label: "SHELL", glyph: "$" },
  think: { label: "THINK", glyph: "…" },
  gate: { label: "GATE", glyph: "⛔" },
  idle: { label: "IDLE", glyph: "·" },
} as const satisfies Record<LogVerb, { label: string; glyph: string }>;

// Coarse, honest projection of the REAL gate signal (Project.approvalLevel) —
// deliberately doesn't restate command-safety.ts's actual rule table (that
// lives server-only), so this stays a summary, never a second source of truth.
const APPROVAL_BULLETS = {
  full: {
    lime: ["Reads, edits, and shell commands — all of it, unasked."],
    blue: ["Only a hard-denied command still stops for you."],
  },
  trusted: {
    lime: ["Reads, greps, edits, and read-only/reversible shell commands."],
    blue: ["An off-allowlist or high-risk command.", "A merge into the base branch."],
  },
  assisted: {
    lime: ["Reads and greps."],
    blue: ["Any edit or shell command.", "A merge into the base branch."],
  },
  manual: {
    lime: [],
    blue: ["Every tool call — nothing runs unasked."],
  },
} as const satisfies Record<ApprovalLevel, { lime: string[]; blue: string[] }>;

export function RunDetailView({
  agent,
  now,
  onBack,
  backLabel,
}: {
  agent: TaskRun;
  now: number;
  onBack: () => void;
  backLabel: string;
}) {
  const { runs, projects, fleet, queue, pauseAgent, resumeAgent, stopAgent, wsPhase } = useStore();
  const confirm = useConfirm();
  const project = projects.find((p) => p.id === agent.projectId);
  const gate = hitlFor(queue, agent.id);
  const collisions = fileCollisionsForAgent(agent, runs);
  const n = agent.plan.length;
  const i = stepIdx(agent);

  // Auto-scroll-follow, pausing on manual scroll — the log keeps typing
  // underneath but stops yanking the viewport until the operator scrolls
  // back to the bottom themselves.
  const logRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [agent.log.length, follow]);
  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const bullets = APPROVAL_BULLETS[project?.approvalLevel ?? "trusted"];
  // Below run-detail.css's 1000px breakpoint the plan column becomes an
  // off-canvas drawer (CSS-only positioning) — this just tracks open/closed.
  // Harmless above the breakpoint: the CSS drawer rules only apply under it,
  // so toggling this has no visual effect on a wide viewport.
  const [planOpen, setPlanOpen] = useState(false);

  return (
    <div className="vw rd-run-detail">
      <div className="rd-header">
        <button className="rd-back" onClick={onBack}>
          ← {backLabel}
        </button>
        <div className="rd-title-row">
          <span className={"rd-dot" + (agent.status === "running" ? " rd-dot-live" : "")} aria-hidden="true" />
          <span className="rd-title">
            run #{agent.id.slice(-6)} · {agent.name}
          </span>
          {n > 0 && (
            <button type="button" className="rd-step-chip" onClick={() => setPlanOpen(true)} title="Open the full plan">
              STEP {Math.min(i + 1, n)} OF {n} · {curStep(agent)}
            </button>
          )}
          {wsPhase !== "open" && (
            <span className="rd-disconnect-pill" role="status">⚠ RECONNECTING</span>
          )}
        </div>
        <div className="rd-meta-row">
          <span>{agent.model}</span>
          <span className="rd-meta-sep">·</span>
          <span className="rd-mono">{agent.branch}</span>
          <span className="rd-meta-sep">·</span>
          <span>{fmtElapsed(agent, now)}</span>
          <span className="rd-meta-sep">·</span>
          <span>{fmtCost(agent.usage?.costUsd ?? 0)}</span>
        </div>
        <div className="rd-header-actions">
          {agent.status === "paused" ? (
            <button className="btn btn-ghost btn-icon" onClick={() => resumeAgent(agent.id)}>
              ▶ Resume
            </button>
          ) : (
            agent.status !== "done" && (
              <button className="btn btn-ghost btn-icon" title="Pause this run; resume later" onClick={() => pauseAgent(agent.id)}>
                ⏸ Pause
              </button>
            )
          )}
          {agent.status !== "done" && (
            <button
              className="btn btn-ghost btn-icon"
              title="Stop this run so you can take over"
              onClick={async () => {
                if (
                  await confirm({
                    title: "Take over this run?",
                    body: `Stop “${agent.name}”? This frees its agent so you can take over.`,
                    confirmLabel: "Take over",
                    danger: true,
                  })
                )
                  void stopAgent(agent.id);
              }}
            >
              ⏻ Take over
            </button>
          )}
        </div>
      </div>

      <div className="rd-grid">
        {/* Below the 1000px breakpoint this same column becomes an off-canvas
            drawer (run-detail.css) — the backdrop only renders/is visible
            there (display:none above it), so it's inert on a wide viewport. */}
        {planOpen && <div className="rd-plan-backdrop" role="presentation" onClick={() => setPlanOpen(false)} />}
        <div className={"rd-col rd-plan-col" + (planOpen ? " rd-plan-col-open" : "")}>
          <button type="button" className="rd-plan-close" onClick={() => setPlanOpen(false)} aria-label="Close the plan">✕</button>
          <div className="rd-panel-title">THE PLAN IT'S FOLLOWING</div>
          <div className="rd-plan-list">
            {agent.plan.length === 0 && <div className="rd-empty">No plan yet — the agent hasn't reported its steps.</div>}
            {agent.plan.map((step, idx) => (
              <PlanRow key={idx} step={step} />
            ))}
          </div>
          <div className="rd-panel-title rd-files-title">FILES TOUCHED · {agent.modifiedFiles.length}</div>
          <div className="rd-files-list">
            {agent.modifiedFiles.length === 0 && <div className="rd-empty">Nothing changed yet.</div>}
            {agent.modifiedFiles.map((f) => (
              <div key={f} className="rd-file-row">
                {f}
              </div>
            ))}
          </div>
        </div>

        <div className="rd-col rd-log-col">
          <div className="rd-panel-title">LIVE LOG</div>
          <div className="rd-log" ref={logRef} onScroll={onLogScroll}>
            {agent.log.map((line, idx) => (
              <LogRow key={idx} line={line} />
            ))}
            <div className="rd-log-row rd-log-idle">
              <span className="rd-log-verb">{VERB_META.idle.glyph} {VERB_META.idle.label}</span>
              <span className="rd-log-line">{agent.status === "done" ? "run finished" : "waiting on the agent…"}</span>
            </div>
          </div>
          {gate && (
            <div className="rd-gate-pin">
              <QueueCard item={gate} agent={agent} now={now} selected onOpen={() => {}} />
            </div>
          )}
        </div>

        <div className="rd-col rd-side-col">
          <div className="rd-panel-title">ISOLATION</div>
          <div className="rd-kv">
            <div className="rd-kv-row">
              <span className="rd-kv-key">branch</span>
              <span className="rd-kv-val rd-mono">{agent.branch}</span>
            </div>
            <div className="rd-kv-row">
              <span className="rd-kv-key">runner</span>
              <span className="rd-kv-val">{runnerName(agent, fleet)}</span>
            </div>
            <div className="rd-kv-row">
              <span className="rd-kv-key">key</span>
              <span className="rd-kv-val rd-mono">{agent.credentialId ?? `${agent.provider} default`}</span>
            </div>
          </div>
          {collisions.length > 0 && (
            <div className="rd-collisions">
              <div className="rd-collisions-title" aria-live="polite">FILE COLLISIONS · {collisions.length}</div>
              {collisions.map((f) => (
                <div key={f} className="rd-collision-row">
                  {f}
                </div>
              ))}
            </div>
          )}

          <div className="rd-panel-title rd-unasked-title">WHAT IT MAY DO UNASKED</div>
          <div className="rd-unasked">
            {bullets.lime.map((b) => (
              <div key={b} className="rd-bullet rd-bullet-lime">
                {b}
              </div>
            ))}
            {bullets.blue.map((b) => (
              <div key={b} className="rd-bullet rd-bullet-blue">
                {b}
              </div>
            ))}
          </div>

          <div className="rd-panel-title rd-cost-title">COST</div>
          <div className="rd-kv">
            <div className="rd-kv-row">
              <span className="rd-kv-key">spend</span>
              <span className="rd-kv-val">{fmtCost(agent.usage?.costUsd ?? 0)}</span>
            </div>
            <div className="rd-kv-row">
              <span className="rd-kv-key">tokens in</span>
              <span className="rd-kv-val">{agent.usage?.inputTokens ?? 0}</span>
            </div>
            <div className="rd-kv-row">
              <span className="rd-kv-key">tokens out</span>
              <span className="rd-kv-val">{agent.usage?.outputTokens ?? 0}</span>
            </div>
            <div className="rd-kv-row">
              <span className="rd-kv-key">turns</span>
              <span className="rd-kv-val">{agent.usage?.turns ?? 0}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanRow({ step }: { step: PlanStep }) {
  const cls =
    step.state === "done" ? "rd-plan-row rd-plan-done" : step.state === "now" ? "rd-plan-row rd-plan-now" : "rd-plan-row rd-plan-todo";
  return (
    <div className={cls}>
      <span className="rd-plan-check" aria-hidden="true" />
      <span className="rd-plan-text">{step.text}</span>
      {step.state === "todo" && step.requiresApproval && <span className="rd-plan-approval">· needs approval</span>}
    </div>
  );
}

function LogRow({ line }: { line: LogLine }) {
  const meta = (line.verb && VERB_META[line.verb]) || null;
  const gated = line.verb === "gate";
  return (
    <div className={"rd-log-row" + (gated ? " rd-log-gate" : "") + (line.resultKind === "error" ? " rd-log-error" : "")}>
      <span className="rd-log-verb">{meta ? `${meta.glyph} ${meta.label}` : ""}</span>
      <span className="rd-log-line">{line.line}</span>
    </div>
  );
}
