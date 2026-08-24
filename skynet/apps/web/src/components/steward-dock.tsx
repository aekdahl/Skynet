import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { Markdown } from "./markdown";
import { DiffView } from "./diff-view";

// Steward as a right-hand dock available on every page. Workspace-wide by default;
// when a project is in focus (the page you're on) it's the full project assistant
// — repo-aware, proposes confirm-first task/project actions. The thread is kept in
// module scope so it survives navigating between pages within a session (a reload
// starts fresh — matching the project chat).

// One confirm-first action Steward proposed, with its own accept/dismiss state —
// a single message can carry several (Steward's "action budget"), each resolved
// independently or all at once.
//
// Execution-intent kinds (queue_tasks/start_feature/process_backlog — see
// PREVIEW_KINDS below) route through three EXTRA states before "done": a
// dry-run fires automatically the moment the chip renders ("previewing"),
// resolves to a feasibility summary the operator reviews BEFORE confirming
// ("previewed", carrying `preview`), and only THEN does Confirm actually
// execute (recorded as `outcome`). `start_task` — the direct single-task
// kind — skips straight from "pending" to "done" like every non-execution-
// intent kind, since there's nothing composite to preview.
type ProposedAction = {
  action: api.AssistantAction;
  state: "pending" | "previewing" | "previewed" | "done" | "dismissed" | "error";
  preview?: api.StewardActionOutcome;
  outcome?: api.StewardActionOutcome;
  error?: string;
};
type Msg = {
  role: "user" | "assistant";
  content: string;
  actions?: ProposedAction[];
  // Which project the proposed actions target (captured at propose time, so
  // confirming later runs against the right project even after you navigate).
  actionProjectId?: string | null;
};

let thread: Msg[] = [];
let draftCache = "";

const SUGGESTIONS = [
  "What's running right now?",
  "Any approvals waiting on me?",
  "Which projects need attention?",
];

// The three composite kinds that always preview before they run. `start_task`
// (a direct, explicit single-task start) is NOT here — it executes straight
// through, same as every other confirm-first action.
const PREVIEW_KINDS = new Set<api.AssistantAction["kind"]>(["queue_tasks", "start_feature", "process_backlog"]);

/** Narrow an `AssistantAction` down to the strict shape the S10 execute
 *  endpoint accepts — only called for the four execution-intent kinds
 *  (guarded by the caller), so the `!`s below mirror the server's own
 *  already-validated `AssistantAction` fields, not a fresh assumption. */
function toExecutionAction(a: api.AssistantAction): api.StewardExecutionAction {
  switch (a.kind) {
    case "start_task":
      return { kind: "start_task", taskId: a.taskId! };
    case "queue_tasks":
      return { kind: "queue_tasks", taskIds: a.taskIds ?? [] };
    case "start_feature":
      return { kind: "start_feature", featureId: a.featureId!, execMode: a.execMode ?? "queue", feasibleOnly: a.feasibleOnly ?? true };
    case "process_backlog":
      return { kind: "process_backlog", feasibleOnly: a.feasibleOnly ?? true };
    default:
      throw new Error(`${a.kind} isn't an execution intent`);
  }
}

const EXCLUDE_REASON_LABEL: Record<string, string> = {
  unclear: "not yet triaged clear",
  "already-running": "already running",
  done: "already done",
  "over-budget": "over today's budget",
  "not-in-scope": "not in scope",
};

// A dry-run's preview line AND a confirmed outcome's summary line share this —
// "3 starting, 2 queued, 1 excluded · ~$4.50" either way; the only difference
// is tense, handled by the caller (a leading "would " word).
function summarizeOutcome(o: api.StewardActionOutcome): string {
  const parts: string[] = [];
  if (o.started.length) parts.push(`${o.started.length} starting`);
  if (o.queued.length) parts.push(`${o.queued.length} queued`);
  if (o.excluded.length) parts.push(`${o.excluded.length} excluded`);
  if (!parts.length) parts.push("nothing to do");
  if (o.estimatedCostUsd > 0) parts.push(`~$${o.estimatedCostUsd.toFixed(2)}`);
  return parts.join(" · ");
}

// One line per distinct exclusion reason, e.g. "2 already running · 1 over today's budget".
function excludedBreakdown(o: api.StewardActionOutcome): string {
  const counts = new Map<string, number>();
  for (const e of o.excluded) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} ${EXCLUDE_REASON_LABEL[reason] ?? reason}`).join(" · ");
}

export function StewardDock({
  focusProjectId,
  focusProjectName,
  onClose,
  seedText,
  seedNonce,
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
}) {
  const { projects, createTask, transitionTask, updateTask, deleteTask, archiveTask, moveTask, updateProject, createFeature, createMilestone, updateFeature } = useStore();
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
  // `projectId` is the project the action targets (captured with the message).
  const runAction = async (a: api.AssistantAction, projectId: string): Promise<void> => {
    switch (a.kind) {
      case "add_task": return createTask(projectId, a.text ?? "", a.description);
      case "move_task": return transitionTask(projectId, a.taskId!, a.to!);
      case "rename_task": return updateTask(projectId, a.taskId!, { text: a.text });
      case "set_task_desc": return updateTask(projectId, a.taskId!, { description: a.description });
      case "remove_task": return deleteTask(projectId, a.taskId!);
      case "archive_task": return archiveTask(projectId, a.taskId!, true);
      case "reorder_task": return moveTask(projectId, a.taskId!, a.direction!);
      case "rename_project": return updateProject(projectId, { name: a.name });
      case "set_goal": return updateProject(projectId, { goal: a.goal });
      case "set_autonomy": return updateProject(projectId, { autonomy: a.autonomy });
      case "set_status": return updateProject(projectId, { status: a.status });
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
      // Execution intents (S10/S11). `start_task` is direct — no preview, same
      // as every kind above. The other three are composites that ALWAYS
      // preview first (see PREVIEW_KINDS + the dry-run effect below) — the
      // chip's own Confirm never calls runAction for them; only
      // confirmPreviewed does, once a dry-run is in hand. Reaching one of
      // those three here would mean that gating broke, so it throws loudly
      // rather than silently running an unreviewed composite.
      case "start_task":
        return api.executeStewardAction(projectId, toExecutionAction(a), false).then(() => undefined);
      case "queue_tasks":
      case "start_feature":
      case "process_backlog":
        throw new Error(`${a.kind} requires a dry-run preview first — not reachable via a plain Confirm`);
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

  // `guardState`, when given, only applies `patch` if the action is STILL in
  // that state — protects an in-flight dry-run/execute callback from
  // clobbering a chip the operator already dismissed while it was loading.
  const updateAction = (mi: number, ai: number, patch: Partial<ProposedAction>, guardState?: ProposedAction["state"]) =>
    setMsgs((x) =>
      x.map((mm, i) =>
        i === mi
          ? { ...mm, actions: mm.actions?.map((pa, j) => (j === ai && (!guardState || pa.state === guardState) ? { ...pa, ...patch } : pa)) }
          : mm,
      ),
    );

  // Resolve ONE proposed action within a message — the plain confirm-first
  // path every non-execution-intent kind uses (and start_task, which never
  // reaches "previewing"/"previewed"). A PREVIEW_KINDS action's own Confirm
  // button calls confirmPreviewed instead, never this.
  const resolveAction = async (mi: number, ai: number, accept: boolean) => {
    const m = msgs[mi];
    const pa = m?.actions?.[ai];
    if (!pa || pa.state !== "pending") return;
    if (!accept) { updateAction(mi, ai, { state: "dismissed" }); return; }
    const projectId = m.actionProjectId ?? effFocusId;
    if (!projectId) { setErr("Tell me which project, then I can apply this."); return; }
    try {
      await runAction(pa.action, projectId);
      updateAction(mi, ai, { state: "done" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't apply that — try again.");
    }
  };

  // Shared by confirmPreviewed and confirmAll: actually execute a
  // dry-run-reviewed composite (or start_task, which skips straight here from
  // "pending"), recording the real outcome (not just a checkmark) so the
  // thread shows what happened. Returns whether it succeeded, so confirmAll
  // knows to stop the batch on a failure the same way the plain path does.
  const runExecutionIntent = async (mi: number, ai: number, projectId: string, action: api.AssistantAction): Promise<boolean> => {
    try {
      const outcome = await api.executeStewardAction(projectId, toExecutionAction(action), false);
      updateAction(mi, ai, { state: "done", outcome });
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't run that — try again.");
      return false;
    }
  };

  // Confirm ONE previewed composite — the dry-run summary is already in hand
  // (`pa.preview`); this is the actual execute call.
  const confirmPreviewed = async (mi: number, ai: number) => {
    const m = msgs[mi];
    const pa = m?.actions?.[ai];
    if (!pa || pa.state !== "previewed") return;
    const projectId = m.actionProjectId ?? effFocusId;
    if (!projectId) { setErr("Tell me which project, then I can apply this."); return; }
    await runExecutionIntent(mi, ai, projectId, pa.action);
  };

  const dismissAction = (mi: number, ai: number) => updateAction(mi, ai, { state: "dismissed" });

  // Confirm every pending/previewed action in a message, in order (they may
  // build on each other), stopping at the first failure so the operator can
  // see what broke. A composite still mid-preview (or one whose preview
  // failed) is left for the operator to confirm/retry individually once it
  // resolves — in practice this never matters, since the preview effect below
  // fires the instant the chip renders and finishes well before a human
  // reads the message and clicks "Confirm all".
  const confirmAll = async (mi: number) => {
    const m = msgs[mi];
    if (!m?.actions) return;
    const projectId = m.actionProjectId ?? effFocusId;
    if (!projectId) { setErr("Tell me which project, then I can apply this."); return; }
    for (let ai = 0; ai < m.actions.length; ai++) {
      const pa = m.actions[ai]!;
      if (pa.state === "previewed") {
        if (!(await runExecutionIntent(mi, ai, projectId, pa.action))) return;
        continue;
      }
      if (pa.state !== "pending" || PREVIEW_KINDS.has(pa.action.kind)) continue;
      try {
        await runAction(pa.action, projectId);
        updateAction(mi, ai, { state: "done" });
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Couldn't apply that — try again.");
        return;
      }
    }
  };

  const dismissAll = (mi: number) =>
    setMsgs((x) =>
      x.map((mm, i) =>
        i === mi
          ? { ...mm, actions: mm.actions?.map((pa) => (pa.state === "done" || pa.state === "dismissed" ? pa : { ...pa, state: "dismissed" as const })) }
          : mm,
      ),
    );

  // Dry-run preview, fired automatically the instant a PREVIEW_KINDS chip
  // renders — the operator never sees a bare "Confirm" for one of these
  // without first seeing what it would actually do. Scans `msgs` rather than
  // keying off one action so a message with several composites (rare, but
  // Steward can propose a batch) previews all of them independently. Each
  // matched action flips OUT of "pending" synchronously in the same pass, so
  // re-running this effect (it depends on `msgs`, which its own updates
  // change) never re-fires the same chip twice.
  useEffect(() => {
    msgs.forEach((m, mi) => {
      m.actions?.forEach((pa, ai) => {
        if (pa.state !== "pending" || !PREVIEW_KINDS.has(pa.action.kind)) return;
        const projectId = m.actionProjectId ?? effFocusId;
        if (!projectId) {
          updateAction(mi, ai, { state: "error", error: "Tell me which project, then I can preview this." });
          return;
        }
        updateAction(mi, ai, { state: "previewing" });
        void api
          .executeStewardAction(projectId, toExecutionAction(pa.action), true)
          .then((preview) => updateAction(mi, ai, { state: "previewed", preview }, "previewing"))
          .catch((e) =>
            updateAction(mi, ai, { state: "error", error: e instanceof Error ? e.message : "Couldn't preview this — try again." }, "previewing"),
          );
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scans msgs itself each run; effFocusId is read at trigger time only, not a reactive dep (a focus change mid-preview shouldn't re-fire one already in flight/resolved)
  }, [msgs]);

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
      const { reply, actions, projectId } = await api.streamStewardChat(
        question,
        history,
        focusProjectId ?? undefined,
        onDelta,
      );
      // Steward resolved a project from the conversation → carry that focus so the
      // header + later turns reflect the project it's now working on.
      if (!focusProjectId && projectId) setResolvedId(projectId);
      // Reconcile to the authoritative CLEAN reply (strips a trailing action JSON
      // that may have streamed through) and attach any proposed action.
      setMsgs((m) => {
        const next = m.slice();
        next[next.length - 1] = {
          role: "assistant",
          content: reply,
          ...(actions && actions.length
            ? { actions: actions.map((action) => ({ action, state: "pending" as const })), actionProjectId: projectId ?? effFocusId }
            : {}),
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
            {m.actions && m.actions.length > 0 && (
              <div className="asst-propose-group">
                {m.actions.length > 1 && m.actions.some((pa) => pa.state === "pending" || pa.state === "previewed") && (
                  <div className="asst-propose-all">
                    <span className="asst-propose-all-label">{m.actions.length} changes</span>
                    <span className="asst-propose-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => void confirmAll(i)}>Confirm all</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => dismissAll(i)}>Dismiss all</button>
                    </span>
                  </div>
                )}
                {m.actions.map((pa, ai) => (
                  <div className="asst-propose" key={ai}>
                    {pa.state === "done" ? (
                      <span className="asst-propose-done">✓ {pa.outcome ? summarizeOutcome(pa.outcome) : pa.action.summary}</span>
                    ) : pa.state === "dismissed" ? (
                      <span className="asst-propose-done muted">Dismissed: {pa.action.summary}</span>
                    ) : pa.state === "error" ? (
                      <>
                        <span className="asst-propose-label">{pa.action.summary}</span>
                        <span className="asst-preview-error">{pa.error}</span>
                        <span className="asst-propose-actions">
                          <button className="btn btn-ghost btn-sm" onClick={() => updateAction(i, ai, { state: "pending", error: undefined })}>Retry</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => dismissAction(i, ai)}>Dismiss</button>
                        </span>
                      </>
                    ) : pa.state === "previewing" || (pa.state === "pending" && PREVIEW_KINDS.has(pa.action.kind)) ? (
                      <>
                        <span className="asst-propose-label">{pa.action.summary}</span>
                        <span className="asst-preview-loading">Checking what's feasible…</span>
                        <span className="asst-propose-actions">
                          <button className="btn btn-ghost btn-sm" onClick={() => dismissAction(i, ai)}>Dismiss</button>
                        </span>
                      </>
                    ) : pa.state === "previewed" ? (
                      <>
                        <span className="asst-propose-label">{pa.action.summary}</span>
                        <div className="asst-preview">
                          <div className="asst-preview-summary">would {summarizeOutcome(pa.preview!)}</div>
                          {pa.preview!.excluded.length > 0 && <div className="asst-preview-excluded">{excludedBreakdown(pa.preview!)}</div>}
                          {pa.preview!.autonomyEnabled && <div className="asst-preview-note">This also turns autonomy on — nothing would ever pick the work up otherwise.</div>}
                        </div>
                        <span className="asst-propose-actions">
                          <button className="btn btn-primary btn-sm" onClick={() => void confirmPreviewed(i, ai)}>Confirm</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => dismissAction(i, ai)}>Dismiss</button>
                        </span>
                      </>
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
    </aside>
  );
}
