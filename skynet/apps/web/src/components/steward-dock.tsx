import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import type { AuditRecordWithActor, Project, SourceRef, StewardActionOutcome, TaskRun } from "@skynet/shared";
import { classifyOperatorId } from "@skynet/shared";
import { Markdown } from "./markdown";
import { DiffView } from "./diff-view";
import { resolveSourceChips } from "../lib/source-chips";

// Steward as a right-hand dock available on every page. Workspace-wide by default;
// when a project is in focus (the page you're on) it's the full project assistant
// — repo-aware, proposes confirm-first task/project actions. The thread is kept in
// module scope so it survives navigating between pages within a session (a reload
// starts fresh — matching the project chat).

// One confirm-first action Steward proposed, with its own accept/dismiss state —
// a single message can carry several (Steward's "action budget"), each resolved
// independently or all at once.
type ProposedAction = { action: api.AssistantAction; state: "pending" | "done" | "dismissed" };
type Msg = {
  role: "user" | "assistant";
  content: string;
  actions?: ProposedAction[];
  // Which project the proposed actions target (captured at propose time, so
  // confirming later runs against the right project even after you navigate).
  actionProjectId?: string | null;
  // TASK 21 — "no claim without a chip": what backs up a specific claim in
  // this reply (a run, its commit, a breaker event). Resolved into an
  // actual href/label at render time (source-chips.ts) against whatever the
  // store currently holds — never stale, since a run/project can be renamed
  // or gone by the time this message scrolls back into view.
  sources?: SourceRef[];
};

let thread: Msg[] = [];
let draftCache = "";

// TASK 21 — "no claim without a chip": ghost-pill links closing out an
// answer, one per source citation. Plain <a href="#/..."> for an in-app hash
// route (same convention as repo-picker.tsx) — the router's own hashchange
// listener (App.tsx) picks it up, no special Link component needed here.
function SourceChips({
  sources,
  runs,
  projects,
}: {
  sources: SourceRef[];
  runs: TaskRun[];
  projects: Project[];
}) {
  const chips = resolveSourceChips(sources, runs, projects);
  if (chips.length === 0) return null;
  return (
    <div className="asst-sources" aria-label="Sources">
      {chips.map((c, i) => (
        <a
          key={i}
          className="asst-source-chip"
          href={c.href}
          target={c.external ? "_blank" : undefined}
          rel={c.external ? "noreferrer" : undefined}
        >
          {c.label}
        </a>
      ))}
    </div>
  );
}

const SUGGESTIONS = [
  "What's running right now?",
  "Any approvals waiting on me?",
  "Which projects need attention?",
];

export function StewardDock({
  focusProjectId,
  focusProjectName,
  onClose,
  seedText,
  seedNonce,
  onOpenTask,
}: {
  focusProjectId: string | null;
  focusProjectName: string | null;
  onClose: () => void;
  // A caller (e.g. "discuss this task" on a kanban card) can drop text into the
  // input box from outside the dock — bump `seedNonce` each time `seedText`
  // should be (re-)applied, since setting the same text twice in a row wouldn't
  // otherwise re-trigger the effect.
  seedText?: string;
  seedNonce?: number;
  // TASK 21 — navigate to a run's detail page: a source-chip click through
  // App.tsx's own openTask (same handler every other view uses), and the
  // audit footer's own rows.
  onOpenTask: (id: string) => void;
}) {
  const { projects, runs, createTask, transitionTask, updateTask, deleteTask, archiveTask, moveTask, requestReview, resyncProjectSource, updateProject, createFeature, createMilestone, updateFeature } = useStore();
  const [msgs, setMsgs] = useState<Msg[]>(thread);
  const [input, setInput] = useState(draftCache);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [crystallizing, setCrystallizing] = useState(false);
  // From the workspace view Steward can resolve + focus a project from the chat
  // itself; remember it so the header, placeholder, and action-targeting reflect
  // the project it's now working on (a page focus, when present, always wins).
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (seedNonce == null) return;
    setInput(seedText ?? "");
    inputRef.current?.focus();
  }, [seedNonce]); // eslint-disable-line react-hooks/exhaustive-deps -- re-apply only on a fresh seed, not every seedText identity change
  const effFocusId = focusProjectId ?? resolvedId;
  const effFocusName = focusProjectName ?? projects.find((p) => p.id === resolvedId)?.name ?? null;

  useEffect(() => { thread = msgs; }, [msgs]);
  useEffect(() => { draftCache = input; }, [input]);
  useEffect(() => { threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight }); }, [msgs, busy]);

  // Execute a confirmed action via the SAME guarded store methods the board uses.

/** The action minus the display-only fields the endpoint's schema doesn't take. */
function stripSummary(a: api.AssistantAction): Record<string, unknown> {
  const { summary: _s, ...rest } = a as unknown as Record<string, unknown> & { summary?: string };
  return rest;
}

/** Say what actually happened. `resolveExecutable` decides per task whether it
 *  can run, so a composite routinely does less than it looks like it will —
 *  reporting only "done" would hide exactly the part the operator needs. */
function describeOutcome(kind: string, o: StewardActionOutcome): string {
  const reason: Record<string, string> = {
    unclear: "never triaged clear",
    "already-running": "already running",
    done: "already done",
    "over-budget": "no budget left today",
    "not-in-scope": "not in scope",
  };
  const bits: string[] = [];
  if (o.started.length) bits.push(`started ${o.started.length}`);
  if (o.queued.length) bits.push(`queued ${o.queued.length}`);
  if (!bits.length) bits.push("nothing to start");
  const grouped = new Map<string, number>();
  for (const e of o.excluded) grouped.set(e.reason, (grouped.get(e.reason) ?? 0) + 1);
  const skipped = [...grouped].map(([r, n]) => `${n} ${reason[r] ?? r}`).join(", ");
  return (
    `**${kind.replace(/_/g, " ")}** — ${bits.join(", ")}` +
    (skipped ? `; skipped ${skipped}` : "") +
    (o.autonomyEnabled ? ". Autonomy was off, so I turned it on — queued work needs it to run." : ".")
  );
}

  // `projectId` is the project the action targets (captured with the message).
  const runAction = async (a: api.AssistantAction, projectId: string): Promise<void> => {
    switch (a.kind) {
      case "add_task": return createTask(projectId, a.text ?? "", a.description);
      case "move_task": return transitionTask(projectId, a.taskId!, a.to!);
      case "rename_task": return updateTask(projectId, a.taskId!, { text: a.text });
      case "set_task_desc": return updateTask(projectId, a.taskId!, { description: a.description });
      case "remove_task": return deleteTask(projectId, a.taskId!);
      case "archive_task": return archiveTask(projectId, a.taskId!, true);
      case "request_review": return requestReview(projectId, a.taskId!);
      case "resync_source": return resyncProjectSource(projectId);
      case "reorder_task": return moveTask(projectId, a.taskId!, a.direction!);
      case "rename_project": return updateProject(projectId, { name: a.name });
      case "set_goal": return updateProject(projectId, { goal: a.goal });
      case "set_autonomy": return updateProject(projectId, { autonomy: a.autonomy });
      case "set_status": return updateProject(projectId, { status: a.status });
      // Workspace-scoped, unlike every project action here: a key is shared by
      // the whole fleet, and pausing one stops its live runs.
      case "pause_key": {
        await api.pauseCredential(a.credentialId!, a.reason!);
        return;
      }
      case "resume_key": {
        await api.resumeCredential(a.credentialId!);
        return;
      }
      case "set_schedule": {
        const patch: { estimatedDurationMs?: number | null; plannedStartAt?: number | null } = {};
        if (a.estimatedDurationMs !== undefined) patch.estimatedDurationMs = a.estimatedDurationMs;
        if (a.plannedStartAt !== undefined) patch.plannedStartAt = a.plannedStartAt;
        return updateTask(projectId, a.taskId!, patch);
      }
      case "set_assignment":
        // Agent eligibility. `agents` mode carries the pool; any/unassigned clear it.
        return updateTask(projectId, a.taskId!, {
          assignment: { mode: a.mode ?? "unassigned", agentIds: a.mode === "agents" ? (a.agentIds ?? []) : [] },
        });
      // Roadmap: create/link features + milestones via the same guarded store paths.
      case "add_feature": return createFeature(projectId, a.name ?? "", a.description, a.milestoneId ?? undefined);
      case "add_milestone": return createMilestone(projectId, a.name ?? "", a.description, a.targetAt ?? undefined);
      case "set_task_feature": return updateTask(projectId, a.taskId!, { featureId: a.featureId ?? null });
      case "set_feature_milestone": return updateFeature(a.featureId!, { milestoneId: a.milestoneId ?? null });
      case "edit_roadmap":
        // Not a store entity — the roadmap doc lives in the repo, not the DB — so
        // this commits straight to the API and lets the Roadmap tab (if mounted)
        // pick up the change itself via the event below, rather than an optimistic
        // store update.
        return api
          .commitProjectRoadmap(projectId, {
            path: a.path!,
            content: a.content!,
            baselineHash: a.baselineHash!,
            baselineSha: a.baselineSha,
          })
          .then(() => {
            window.dispatchEvent(new CustomEvent("skynet:roadmap-updated", { detail: { projectId } }));
          });
      case "set_roadmap_path":
        // A plain project field via the normal store path, but an open Roadmap
        // tab needs the same live-refetch nudge edit_roadmap gives it — it isn't
        // driven by project.roadmapPath directly, it refetches on this event.
        return updateProject(projectId, { roadmapPath: a.path ?? null }).then(() => {
          window.dispatchEvent(new CustomEvent("skynet:roadmap-updated", { detail: { projectId } }));
        });
      // ── Execution intents ────────────────────────────────────────────────
      // These START WORK rather than editing a record, so they go through the
      // execution endpoint, which resolves feasibility honestly (already
      // running, never triaged clear, over today's budget) instead of blindly
      // firing. It reports what it actually did, and we surface that: a chip
      // that says "done" after excluding four of five tasks would be a lie.
      case "start_task":
      case "queue_tasks":
      case "start_feature":
      case "process_backlog": {
        const outcome = await api.executeStewardAction(projectId, stripSummary(a));
        setMsgs((m) => [...m, { role: "assistant", content: describeOutcome(a.kind, outcome) }]);
        return;
      }
      default: {
        // Exhaustiveness guard: every ProjectActionKind Steward can propose MUST
        // have a case here. Without it a confirmed action silently no-ops (the
        // dock marks the chip "done" but nothing runs) — which is exactly how
        // archive_task slipped through. A new kind now fails to compile instead.
        const unhandled: never = a.kind;
        throw new Error(`Steward action not wired in the dock: ${String(unhandled)}`);
      }
    }
  };

  const setActionState = (mi: number, ai: number, state: ProposedAction["state"]) =>
    setMsgs((x) => x.map((mm, i) => (i === mi ? { ...mm, actions: mm.actions?.map((pa, j) => (j === ai ? { ...pa, state } : pa)) } : mm)));

  // Resolve ONE proposed action within a message.
  const resolveAction = async (mi: number, ai: number, accept: boolean) => {
    const m = msgs[mi];
    const pa = m?.actions?.[ai];
    if (!pa || pa.state !== "pending") return;
    if (!accept) { setActionState(mi, ai, "dismissed"); return; }
    const projectId = m.actionProjectId ?? effFocusId;
    if (!projectId) { setErr("Tell me which project, then I can apply this."); return; }
    try {
      await runAction(pa.action, projectId);
      setActionState(mi, ai, "done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't apply that — try again.");
    }
  };

  // Confirm every pending action in a message, in order (they may build on each
  // other), stopping at the first failure so the operator can see what broke.
  const confirmAll = async (mi: number) => {
    const m = msgs[mi];
    if (!m?.actions) return;
    const projectId = m.actionProjectId ?? effFocusId;
    if (!projectId) { setErr("Tell me which project, then I can apply this."); return; }
    for (let ai = 0; ai < m.actions.length; ai++) {
      if (m.actions[ai]!.state !== "pending") continue;
      try {
        await runAction(m.actions[ai]!.action, projectId);
        setActionState(mi, ai, "done");
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Couldn't apply that — try again.");
        return;
      }
    }
  };

  const dismissAll = (mi: number) =>
    setMsgs((x) => x.map((mm, i) => (i === mi ? { ...mm, actions: mm.actions?.map((pa) => (pa.state === "pending" ? { ...pa, state: "dismissed" } : pa)) } : mm)));

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setErr(null);
    const history = msgs.map(({ role, content }) => ({ role, content }));
    setMsgs([...msgs, { role: "user", content: question }, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    try {
      // Stream deltas into the last (assistant) bubble as they arrive.
      const onDelta = (chunk: string) =>
        setMsgs((m) => {
          const next = m.slice();
          const last = next[next.length - 1]!;
          next[next.length - 1] = { ...last, content: last.content + chunk };
          return next;
        });
      const { reply, actions, projectId, sources } = await api.streamStewardChat(
        question,
        history,
        focusProjectId ?? undefined,
        onDelta,
      );
      // Steward resolved a project from the conversation → carry that focus so the
      // header + later turns reflect the project it's now working on.
      if (!focusProjectId && projectId) setResolvedId(projectId);
      // Reconcile to the authoritative CLEAN reply (strips a trailing action/
      // sources JSON that may have streamed through) and attach any proposed
      // action + source citations (TASK 21).
      setMsgs((m) => {
        const next = m.slice();
        next[next.length - 1] = {
          role: "assistant",
          content: reply,
          ...(actions && actions.length
            ? { actions: actions.map((action) => ({ action, state: "pending" as const })), actionProjectId: projectId ?? effFocusId }
            : {}),
          ...(sources && sources.length ? { sources } : {}),
        };
        return next;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't reach Steward — try again.");
      setMsgs((m) => m.slice(0, -1)); // drop the empty assistant bubble
    } finally {
      setBusy(false);
    }
  };

  // S5 "crystallize": one action turns this conversation into a durable draft
  // SolutionBrief. Needs a resolved project (the server route is nested under
  // /api/projects/:id/briefs) and at least one real turn to draft from — the
  // button below is only shown when both hold. No brief-viewing UI exists yet
  // (S4 deferred it), so success is surfaced as a confirmation line in the
  // thread itself rather than a navigation that has nowhere to go.
  const crystallize = async () => {
    if (crystallizing || !effFocusId || msgs.length === 0) return;
    setErr(null);
    setCrystallizing(true);
    try {
      const history = msgs.map(({ role, content }) => ({ role, content })).filter((m) => m.content.trim());
      const brief = await api.crystallizeBrief(effFocusId, history);
      setMsgs((m) => [...m, { role: "assistant", content: `✓ Crystallized into a draft solution brief: **${brief.title}**` }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't crystallize this conversation — try again.");
    } finally {
      setCrystallizing(false);
    }
  };

  return (
    <aside className="steward-dock" aria-label="Steward">
      <div className="steward-head">
        <span className="steward-title mono">✦ STEWARD</span>
        <span className="steward-scope mono">{effFocusName ? `focused · ${effFocusName}` : "workspace"}</span>
        <span className="steward-spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close Steward" aria-label="Close Steward">✕</button>
      </div>
      <div className="steward-thread" ref={threadRef}>
        {msgs.length === 0 && (
          <div className="asst-welcome">
            <p>
              Ask about anything across your workspace — runs, gates, project status.
              {effFocusName ? ` You're on “${effFocusName}”, so I can also add/move tasks or change its settings (I'll confirm first).` : " Name a project and I can manage its tasks right here too (I'll confirm first)."}
            </p>
            <div className="asst-sugg">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="asst-chip" onClick={() => void ask(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={"asst-msg asst-" + m.role}>
            <span className="asst-who mono">{m.role === "user" ? "you" : "steward"}</span>
            {m.role === "assistant" ? (
              m.content === "" ? (
                <div className="asst-text asst-think">thinking…</div>
              ) : (
                <div className="asst-text asst-md"><Markdown text={m.content} /></div>
              )
            ) : (
              <div className="asst-text">{m.content}</div>
            )}
            {m.role === "assistant" && m.sources && m.sources.length > 0 && (
              <SourceChips sources={m.sources} runs={runs} projects={projects} />
            )}
            {/* TASK 21 — exactly 2 proposed actions get the redesigned confirm
                bubble (blue-bordered, numbered rows, DO BOTH / JUST #01 /
                CANCEL); 3+ keep the existing general "N changes" group below
                unchanged rather than stretching an unspecified UX to it. */}
            {m.actions && m.actions.length === 2 && (
              <div className="asst-confirm2">
                <div className="asst-confirm2-head mono">TWO ACTIONS · CONFIRM TO RUN</div>
                {m.actions.map((pa, ai) => (
                  <div className="asst-confirm2-row" key={ai}>
                    <span className="asst-confirm2-num mono">#{String(ai + 1).padStart(2, "0")}</span>
                    <div className="asst-confirm2-row-body">
                      <span className={"asst-confirm2-label" + (pa.state !== "pending" ? " asst-confirm2-label-resolved" : "")}>
                        {pa.state === "done" ? `✓ ${pa.action.summary}` : pa.state === "dismissed" ? `Dismissed: ${pa.action.summary}` : pa.action.summary}
                      </span>
                      {pa.state === "pending" && pa.action.kind === "edit_roadmap" && (
                        <DiffView patch={pa.action.patch ?? ""} add={pa.action.add ?? 0} del={pa.action.del ?? 0} defaultOpen />
                      )}
                    </div>
                  </div>
                ))}
                {m.actions.some((pa) => pa.state === "pending") && (
                  <div className="asst-confirm2-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => dismissAll(i)}>Cancel</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void resolveAction(i, 0, true)}>Just #01</button>
                    <button className="btn btn-primary btn-sm asst-confirm2-both" onClick={() => void confirmAll(i)}>Do both</button>
                  </div>
                )}
              </div>
            )}
            {m.actions && m.actions.length > 0 && (
              <div className="asst-propose-group">
                {m.actions.length > 2 && m.actions.some((pa) => pa.state === "pending") && (
                  <div className="asst-propose-all">
                    <span className="asst-propose-all-label">{m.actions.length} changes</span>
                    <span className="asst-propose-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => void confirmAll(i)}>Confirm all</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => dismissAll(i)}>Dismiss all</button>
                    </span>
                  </div>
                )}
                {m.actions.length !== 2 && m.actions.map((pa, ai) => (
                  <div className="asst-propose" key={ai}>
                    {pa.state === "done" ? (
                      <span className="asst-propose-done">✓ {pa.action.summary}</span>
                    ) : pa.state === "dismissed" ? (
                      <span className="asst-propose-done muted">Dismissed: {pa.action.summary}</span>
                    ) : (
                      <>
                        <span className="asst-propose-label">{pa.action.summary}</span>
                        {pa.action.kind === "edit_roadmap" && (
                          <DiffView patch={pa.action.patch ?? ""} add={pa.action.add ?? 0} del={pa.action.del ?? 0} defaultOpen />
                        )}
                        <span className="asst-propose-actions">
                          <button className="btn btn-primary btn-sm" onClick={() => void resolveAction(i, ai, true)}>Confirm</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => void resolveAction(i, ai, false)}>Dismiss</button>
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {err && <div className="asst-err">{err}</div>}
      {effFocusId && msgs.length > 0 && (
        <div className="asst-crystallize">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void crystallize()}
            disabled={crystallizing || busy}
            title="Turn this conversation into a durable draft solution brief"
          >
            {crystallizing ? "Crystallizing…" : "Crystallize into a solution brief →"}
          </button>
        </div>
      )}
      <form className="asst-input" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        <input
          ref={inputRef}
          className="qx-input"
          placeholder={effFocusName ? `Ask about ${effFocusName} or the workspace…` : "Ask Steward about your workspace…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>Ask</button>
      </form>
      <AuditFooter onOpenTask={onOpenTask} />
    </aside>
  );
}

const ACTOR_FILTERS = ["all", "human", "policy", "agent-review"] as const;
type ActorFilter = (typeof ACTOR_FILTERS)[number];
const ACTOR_DOT_COLOR: Record<Exclude<ActorFilter, "all">, string> = {
  policy: "var(--ak-machine)",
  human: "var(--ak-human)",
  "agent-review": "var(--ak-warn)",
};

/** One decision's plain-language sentence — the same light payload reading
 *  audit.tsx does, kept minimal here since this is a compact footer, not the
 *  full audit page (which stays the place for the diff/rationale detail). */
function auditSentence(rec: AuditRecordWithActor): string {
  const p = (rec.payload ?? {}) as { kind?: string; title?: string };
  const what = p.title || p.kind || rec.action;
  return `${rec.action} — ${what}`;
}

function fmtFooterTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** TASK 21 — compact audit trail below the chat: header + export, filters,
 *  and a short recent-decisions list — the fuller detail (diffs, rationale,
 *  archive/delete) stays on the dedicated Audit page (views/audit.tsx); this
 *  is "prove it after" surfaced right where the conversation already is. */
function AuditFooter({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { projects, runs } = useStore();
  const [records, setRecords] = useState<AuditRecordWithActor[] | null>(null);
  const [actorFilter, setActorFilter] = useState<ActorFilter>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.fetchAudit().then((r) => { if (!cancelled) setRecords(r); });
    return () => { cancelled = true; };
  }, []);

  const runProjectId = (runId: string) => runs.find((r) => r.id === runId)?.projectId ?? null;
  const kinds = Array.from(new Set((records ?? []).map((r) => r.action))).sort();
  const filtered = (records ?? [])
    .filter((r) => actorFilter === "all" || (r.actorType ?? classifyOperatorId(r.operatorId)) === actorFilter)
    .filter((r) => projectFilter === "all" || runProjectId(r.runId) === projectFilter)
    .filter((r) => kindFilter === "all" || r.action === kindFilter)
    .slice(0, 25);

  const doExport = async () => {
    setExporting(true);
    try {
      const body = await api.exportAudit();
      const blob = new Blob([body], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `skynet-audit-${new Date().toISOString().slice(0, 10)}.ndjson`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="asst-audit-footer">
      <div className="asst-audit-head">
        <span className="asst-audit-title mono">DECISION TRAIL</span>
        <button className="asst-audit-export" onClick={() => void doExport()} disabled={exporting}>
          {exporting ? "exporting…" : "export CSV"}
        </button>
      </div>
      <div className="asst-audit-filters">
        <select className="asst-audit-select" value={actorFilter} onChange={(e) => setActorFilter(e.target.value as ActorFilter)}>
          {ACTOR_FILTERS.map((a) => <option key={a} value={a}>{a === "all" ? "Any actor" : a}</option>)}
        </select>
        <select className="asst-audit-select" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="all">Any project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="asst-audit-select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
          <option value="all">Any decision</option>
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      <div className="asst-audit-rows">
        {records === null && <div className="asst-audit-empty">Loading…</div>}
        {records !== null && filtered.length === 0 && <div className="asst-audit-empty">No decisions match.</div>}
        {filtered.map((r) => (
          <button key={r.hitlId} className="asst-audit-row" onClick={() => onOpenTask(r.runId)}>
            <span className="asst-audit-time mono">{fmtFooterTime(r.at)}</span>
            <span className="asst-audit-dot" style={{ background: ACTOR_DOT_COLOR[r.actorType ?? classifyOperatorId(r.operatorId)] }} aria-hidden="true" />
            <span className="asst-audit-sentence">{auditSentence(r)}</span>
            <span className="asst-audit-actor mono">{r.operatorId}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
