import { useEffect, useRef, useState } from "react";
import type { TaskRun } from "@skynet/shared";
import { useStore } from "../lib/store";
import { Markdown } from "./markdown";

// ─── Agent chat, as a dock panel ───────────────────────────────────────────
// The same conversation the run-detail page shows, in a surface that FOLLOWS
// the operator around. Losing a half-typed reply because you clicked through to
// check something the agent just asked about is a bad enough trade that people
// stop asking agents things — which is the opposite of what the chat is for.
//
// Deliberately the CONVERSATION only, not the run's full live log. The dock is
// narrow, and tool/telemetry lines are the part you go to the run page for; a
// dock tab is for talking. `chatTurn`'s classification (mirrored from
// views/task.tsx, where the orchestrator's `you: …` / `↳ …` log convention is
// documented) is what separates the two.

function chatTurn(line: string): { who: "you" | "agent"; text: string } | null {
  if (line.startsWith("you: ")) return { who: "you", text: line.slice(5) };
  if (line.startsWith("↳ ")) return { who: "agent", text: line.slice(2) };
  return null;
}

/** Is this run waiting on a human right now? Surfaced on the tab so a blocked
 *  agent is visible from wherever the operator happens to be. */
export function runNeedsYou(run: TaskRun | undefined, queueRunIds: Set<string>): boolean {
  return !!run && (run.status === "waiting" || queueRunIds.has(run.id));
}

export function AgentChatPanel({ runId }: { runId: string }) {
  const { runs, queue, streamAgentMessage } = useStore();
  const run = runs.find((r) => r.id === runId);
  const [draft, setDraft] = useState("");
  // In-flight reply, streamed in so it types rather than appearing whole. Held
  // here and dropped once the persisted `↳` line lands in the run's log.
  const [streaming, setStreaming] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const turns = (run?.log ?? []).map((l) => chatTurn(l.line)).filter((t): t is NonNullable<typeof t> => !!t);

  // Stick to the bottom as turns arrive — a chat that doesn't follow its own
  // newest message makes you scroll to read what you just asked for.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, streaming]);

  if (!run) {
    return <div className="dock-empty">This run is no longer available — it may have been archived.</div>;
  }

  const send = async () => {
    const text = draft.trim();
    if (!text || streaming != null) return;
    setDraft("");
    setErr(null);
    setStreaming("");
    try {
      await streamAgentMessage(run.id, text, (chunk) => setStreaming((s) => (s ?? "") + chunk));
    } catch (e) {
      setErr((e as Error).message || "Couldn't reach the agent.");
    } finally {
      setStreaming(null);
    }
  };

  const waiting = runNeedsYou(run, new Set(queue.filter((q) => !q.resolvedAt).map((q) => q.runId)));

  return (
    <>
      {waiting && (
        // The decision itself stays where it can be rendered properly (the run
        // page and the Inbox) — repeating an approve/reject control here would
        // mean two places to keep correct. This just makes sure a blocked agent
        // isn't invisible while you're talking to it.
        <div className="dock-needsyou">This agent is waiting on a decision — open the run or the Inbox to answer it.</div>
      )}
      <div className="steward-thread" ref={threadRef}>
        {turns.length === 0 && streaming == null && (
          <div className="dock-empty">
            No conversation yet. Ask this agent about what it's doing — it keeps working while you talk.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={"asst-msg asst-" + (t.who === "you" ? "user" : "assistant")}>
            <span className="asst-who mono">{t.who === "you" ? "you" : run.name}</span>
            {t.who === "agent" ? (
              <div className="asst-text asst-md"><Markdown text={t.text} /></div>
            ) : (
              <div className="asst-text">{t.text}</div>
            )}
          </div>
        ))}
        {streaming != null && (
          <div className="asst-msg asst-assistant">
            <span className="asst-who mono">{run.name}</span>
            <div className="asst-text asst-md">
              {streaming ? <Markdown text={streaming} /> : <span className="asst-think">thinking…</span>}
            </div>
          </div>
        )}
      </div>
      {err && <div className="asst-err">{err}</div>}
      <form
        className="asst-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={run.status === "done" ? "Ask about what it shipped…" : "Message the agent — it keeps working…"}
          aria-label={`Message ${run.name}`}
        />
        <button className="btn btn-primary btn-sm" disabled={!draft.trim() || streaming != null}>
          Send
        </button>
      </form>
    </>
  );
}
