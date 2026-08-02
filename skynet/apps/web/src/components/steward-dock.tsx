import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { Markdown } from "./markdown";

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
};

let thread: Msg[] = [];
let draftCache = "";

const SUGGESTIONS = [
  "What's running right now?",
  "Any approvals waiting on me?",
  "Which projects need attention?",
];

export function StewardDock({
  focusProjectId,
  focusProjectName,
  onClose,
}: {
  focusProjectId: string | null;
  focusProjectName: string | null;
  onClose: () => void;
}) {
  const { projects, createTask, transitionTask, updateTask, deleteTask, moveTask, updateProject } = useStore();
  const [msgs, setMsgs] = useState<Msg[]>(thread);
  const [input, setInput] = useState(draftCache);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // From the workspace view Steward can resolve + focus a project from the chat
  // itself; remember it so the header, placeholder, and action-targeting reflect
  // the project it's now working on (a page focus, when present, always wins).
  const [resolvedId, setResolvedId] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
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

  return (
    <aside className="steward-dock" aria-label="Steward">
      <div className="steward-head">
        <span className="steward-title mono">✦ STEWARD</span>
        <span className="steward-scope mono">{effFocusName ? `focused · ${effFocusName}` : "workspace"}</span>
        <span className="steward-spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close Steward">✕</button>
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
                {m.actions.length > 1 && m.actions.some((pa) => pa.state === "pending") && (
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
                      <span className="asst-propose-done">✓ {pa.action.summary}</span>
                    ) : pa.state === "dismissed" ? (
                      <span className="asst-propose-done muted">Dismissed: {pa.action.summary}</span>
                    ) : (
                      <>
                        <span className="asst-propose-label">{pa.action.summary}</span>
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
      <form className="asst-input" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        <input
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
