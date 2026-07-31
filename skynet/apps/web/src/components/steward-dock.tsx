import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { Markdown } from "./markdown";

// Steward as a right-hand dock available on every page. Workspace-wide by default;
// when a project is in focus (the page you're on) it's the full project assistant
// — repo-aware, proposes confirm-first task/project actions. The thread is kept in
// module scope so it survives navigating between pages within a session (a reload
// starts fresh — matching the project chat).

type Msg = {
  role: "user" | "assistant";
  content: string;
  action?: api.AssistantAction;
  // Which project a proposed action targets (captured at propose time, so
  // confirming later runs against the right project even after you navigate).
  actionProjectId?: string | null;
  actionState?: "pending" | "done" | "dismissed";
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
      case "add_tasks": {
        // Batch add — create each in list order so the board keeps the order the
        // operator (or the roadmap) listed them.
        for (const t of a.tasks ?? []) await createTask(projectId, t.text, t.description);
        return;
      }
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
    }
  };

  const resolveAction = async (idx: number, accept: boolean) => {
    const m = msgs[idx];
    if (!m?.action || m.actionState !== "pending") return;
    if (!accept) {
      setMsgs((x) => x.map((mm, i) => (i === idx ? { ...mm, actionState: "dismissed" } : mm)));
      return;
    }
    const projectId = m.actionProjectId ?? effFocusId;
    if (!projectId) { setErr("Tell me which project, then I can apply this."); return; }
    try {
      await runAction(m.action, projectId);
      setMsgs((x) => x.map((mm, i) => (i === idx ? { ...mm, actionState: "done" } : mm)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't apply that — try again.");
    }
  };

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setErr(null);
    const history = msgs.map(({ role, content }) => ({ role, content }));
    setMsgs([...msgs, { role: "user", content: question }, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    try {
      const { reply, action, projectId } = await api.stewardChat(question, history, focusProjectId ?? undefined);
      // Steward resolved a project from the conversation → carry that focus so the
      // header + later turns reflect the project it's now working on.
      if (!focusProjectId && projectId) setResolvedId(projectId);
      setMsgs((m) => {
        const next = m.slice();
        next[next.length - 1] = {
          role: "assistant",
          content: reply,
          ...(action ? { action, actionProjectId: projectId ?? effFocusId, actionState: "pending" as const } : {}),
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
            {m.action && (
              <div className="asst-propose">
                {m.actionState === "done" ? (
                  <span className="asst-propose-done">✓ {m.action.summary}</span>
                ) : m.actionState === "dismissed" ? (
                  <span className="asst-propose-done muted">Dismissed: {m.action.summary}</span>
                ) : (
                  <>
                    <span className="asst-propose-label">{m.action.summary}</span>
                    <span className="asst-propose-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => void resolveAction(i, true)}>Confirm</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => void resolveAction(i, false)}>Dismiss</button>
                    </span>
                  </>
                )}
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
