import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { Markdown } from "./markdown";

// Steward as a right-hand dock available on every page. Workspace-wide by default;
// when a project is in focus (the page you're on) it's the full project assistant
// — repo-aware, proposes confirm-first task/project actions. The thread is kept in
// module scope so it survives navigating between pages within a session (a reload
// starts fresh — matching the project chat).

// One proposed action + its own run state, so a batch shows ✓/✗ per item as it
// applies. Steward can propose SEVERAL at once ("add these five tasks") and the
// operator approves the whole batch with one tap — no per-item confirmation.
type ActItem = { action: api.AssistantAction; state: "pending" | "done" | "failed" };
type Msg = {
  role: "user" | "assistant";
  content: string;
  acts?: ActItem[];
  // Which project the actions target (captured at propose time, so confirming
  // later runs against the right project even after you navigate).
  actionProjectId?: string | null;
  // The whole batch was dismissed without running.
  dismissed?: boolean;
};

let thread: Msg[] = [];
let draftCache = "";
// Session-scoped focus so Steward can KEEP working a project while you roam the
// app (multitasking). `pinnedId` is an explicit lock that overrides the page —
// Steward stays on it even when you open another project. `lastFocusId` is a
// softer memory: when you land on a page with NO project (Home, Fleet, Settings),
// the dock keeps the last project it was on so the conversation doesn't reset.
let pinnedId: string | null = null;
let lastFocusId: string | null = null;

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
  const [pinned, setPinned] = useState<string | null>(pinnedId);
  const threadRef = useRef<HTMLDivElement>(null);

  // The project the current PAGE (or a chat-resolved reference) is about.
  const pageFocusId = focusProjectId ?? resolvedId;
  // Remember the last real project focus, so leaving to a project-less page
  // (Home/Fleet/Settings) keeps Steward on it rather than dropping to workspace.
  useEffect(() => { if (pageFocusId) lastFocusId = pageFocusId; }, [pageFocusId]);
  useEffect(() => { pinnedId = pinned; }, [pinned]);

  // Effective focus: an explicit pin wins over everything; otherwise the page (or
  // resolved) project; otherwise the last one we were on.
  const effFocusId = pinned ?? pageFocusId ?? lastFocusId;
  const nameOf = (id: string | null): string | null =>
    id ? (id === focusProjectId ? focusProjectName : null) ?? projects.find((p) => p.id === id)?.name ?? null : null;
  const effFocusName = nameOf(effFocusId);
  // The page has a DIFFERENT project than what Steward is pinned to → offer to move.
  const pageDiffers = !!pinned && !!focusProjectId && focusProjectId !== pinned;

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

  // Approve the whole batch at once: apply every still-pending action in order,
  // marking each ✓/✗ as it lands. A failure doesn't halt the rest — the operator
  // sees which succeeded and which didn't, and can retry the failures.
  const confirmBatch = async (idx: number) => {
    const m = msgs[idx];
    if (!m?.acts?.length) return;
    const projectId = m.actionProjectId ?? effFocusId;
    if (!projectId) { setErr("Tell me which project, then I can apply these."); return; }
    setErr(null);
    let anyFailed = false;
    for (let j = 0; j < m.acts.length; j++) {
      if (m.acts[j]!.state !== "pending") continue;
      try {
        await runAction(m.acts[j]!.action, projectId);
        setMsgs((x) => x.map((mm, i) => (i === idx ? { ...mm, acts: mm.acts?.map((it, k) => (k === j ? { ...it, state: "done" } : it)) } : mm)));
      } catch {
        anyFailed = true;
        setMsgs((x) => x.map((mm, i) => (i === idx ? { ...mm, acts: mm.acts?.map((it, k) => (k === j ? { ...it, state: "failed" } : it)) } : mm)));
      }
    }
    if (anyFailed) setErr("Some changes couldn't be applied — see the ✗ items above.");
  };

  const dismissBatch = (idx: number) =>
    setMsgs((x) => x.map((mm, i) => (i === idx ? { ...mm, dismissed: true } : mm)));

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setErr(null);
    const history = msgs.map(({ role, content }) => ({ role, content }));
    setMsgs([...msgs, { role: "user", content: question }, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    try {
      // Target the EFFECTIVE focus (pin > page > last), so a pinned project keeps
      // getting the work even while you're viewing another page.
      const { reply, action, actions, projectId } = await api.stewardChat(question, history, effFocusId ?? undefined);
      // Steward resolved a project from the conversation → carry that focus so the
      // header + later turns reflect the project it's now working on.
      if (!effFocusId && projectId) setResolvedId(projectId);
      // Prefer the full batch; fall back to a lone `action` for back-compat.
      const proposed = actions?.length ? actions : action ? [action] : [];
      setMsgs((m) => {
        const next = m.slice();
        next[next.length - 1] = {
          role: "assistant",
          content: reply,
          ...(proposed.length
            ? {
                acts: proposed.map((a) => ({ action: a, state: "pending" as const })),
                actionProjectId: projectId ?? effFocusId,
              }
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
        {effFocusId ? (
          <button
            className={"steward-pin mono" + (pinned ? " on" : "")}
            onClick={() => setPinned(pinned ? null : effFocusId)}
            title={
              pinned
                ? `Pinned to ${effFocusName ?? "this project"} — Steward stays here as you navigate. Click to unpin (follow the page).`
                : `Pin Steward to ${effFocusName ?? "this project"} so it keeps working here while you go elsewhere.`
            }
          >
            {pinned ? "📌" : "○"} {effFocusName ?? "project"}
          </button>
        ) : (
          <span className="steward-scope mono">workspace</span>
        )}
        {pageDiffers && (
          <button
            className="steward-pin-switch mono"
            onClick={() => setPinned(focusProjectId)}
            title={`Move Steward to ${focusProjectName ?? "this page's project"}`}
          >
            ↪ {focusProjectName ?? "this page"}
          </button>
        )}
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
            {m.acts?.length ? (
              <div className="asst-propose">
                {/* One row per proposed change, each showing its own state. */}
                <ul className="asst-propose-list">
                  {m.acts.map((it, k) => (
                    <li key={k} className={"asst-propose-item asst-act-" + it.state}>
                      <span className="asst-act-mark" aria-hidden="true">
                        {it.state === "done" ? "✓" : it.state === "failed" ? "✗" : "○"}
                      </span>
                      <span className="asst-act-label">{it.action.summary}</span>
                    </li>
                  ))}
                </ul>
                {(() => {
                  const pending = m.acts.filter((it) => it.state === "pending").length;
                  if (m.dismissed) return <span className="asst-propose-done muted">Dismissed.</span>;
                  if (pending === 0) return <span className="asst-propose-done">✓ Applied.</span>;
                  const n = m.acts.length;
                  return (
                    <span className="asst-propose-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => void confirmBatch(i)}>
                        {n > 1 ? `Confirm all ${n}` : "Confirm"}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => dismissBatch(i)}>Dismiss</button>
                    </span>
                  );
                })()}
              </div>
            ) : null}
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
