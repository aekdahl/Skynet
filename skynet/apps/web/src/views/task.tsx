import { useEffect, useRef, useState } from "react";
import type { TaskRun } from "@skynet/shared";
import { useStore } from "../lib/store";
import {
  conflictModulesForAgent,
  fmtElapsed,
  fmtWait,
  heartbeatSecs,
  KIND_META,
  modName,
  openQueue,
  planDone,
  runnerName,
  STATUS_META,
  waitedSecs,
} from "../lib/derive";
import { StatusDot } from "../components/common";
import { Markdown } from "../components/markdown";
import { PreviewFor } from "../components/preview";
import { HitlContext, RiskChip } from "../components/hitl-context";
import { LivePreviewModal } from "./project";

// Cheap guard: does this text actually contain markdown worth rendering (bold,
// inline code, a bullet/number/heading line, or a link)? Agent prose does; plain
// telemetry ("3m elapsed", "installing dependencies…") doesn't — so we only route
// the former through <Markdown/> and leave everything else rendering verbatim.
const looksMarkdown = (t: string): boolean =>
  /\*\*|`|\[[^\]]+\]\([^)]+\)|(^|\n)\s*(?:[-*]\s|\d+\.\s|#{1,4}\s)/.test(t);

// A log line is either a conversation turn (the orchestrator records chat as
// `you: …` and the agent's reply as `↳ …`) or plain telemetry. Classifying here
// lets the LIVE LOG render as one chronological conversation+telemetry stream.
function chatTurn(line: string): { who: "you" | "agent"; text: string } | null {
  if (line.startsWith("you: ")) return { who: "you", text: line.slice(5) };
  if (line.startsWith("↳ ")) return { who: "agent", text: line.slice(2) };
  return null;
}

// The runner logs its final prose answer as a plain log line (no ▸/↳/marker).
// For a finished agent, surface the last such line as a headline result —
// otherwise a question task's answer stays buried in the live log.
const LOG_MARKERS = ["▸", "↳", "✓", "⏸", "⚠", "❑", "●", "$"];
function finalAnswer(agent: TaskRun): string | null {
  if (agent.status !== "done") return null;
  for (let i = agent.log.length - 1; i >= 0; i--) {
    const line = (agent.log[i]?.line ?? "").trim();
    if (!line) continue;
    if (LOG_MARKERS.some((m) => line.startsWith(m))) continue;
    // Skip chat noise (your questions, decision records) — they come after the
    // task's own answer, which is what we want to surface.
    if (/^(picked up|worktree|runner error|commit|no changes|re: "|you:|decision delivered)/i.test(line)) continue;
    return line;
  }
  return null;
}

// Compact token/cost summary for the detail header, when the runner reported it.
function fmtUsage(u: TaskRun["usage"]): string | null {
  if (!u) return null;
  const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const parts = [`${tok(u.inputTokens)}→${tok(u.outputTokens)} tok`];
  if (u.costUsd != null) parts.push(`$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}`);
  if (u.turns) parts.push(`${u.turns} turns`);
  return parts.join(" · ");
}

export function TaskDetail({
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
  const {
    queue,
    runs,
    tasks,
    fleet,
    modules,
    projects,
    resolveHitl,
    forkAgent,
    streamAgentMessage,
    pauseAgent,
    resumeAgent,
    stopAgent,
    archiveAgent,
  } = useStore();
  const project = projects.find((p) => p.id === agent.projectId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const q = openQueue(queue).find((it) => it.runId === agent.id);
  // The backing task's longer description (the run's name is the short task text).
  const taskDesc = tasks.find((t) => t.runId === agent.id)?.description ?? null;
  const doneCount = planDone(agent);
  const [draft, setDraft] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  // In-flight assistant reply for the chat path — streamed here so it types in
  // live, then dropped once the persisted `↳` line lands in the log (below).
  const [streaming, setStreaming] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const conflictMods = conflictModulesForAgent(agent, runs);
  const conflictMod = conflictMods[0];
  const answer = finalAnswer(agent);

  // Keep the conversation pinned to the newest entry as it grows / streams.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [agent.log, streaming]);

  // Once the streamed reply is persisted to the log, drop the transient bubble
  // so it isn't shown twice.
  useEffect(() => {
    if (streaming == null) return;
    for (let i = agent.log.length - 1; i >= 0; i--) {
      const t = chatTurn(agent.log[i]?.line ?? "");
      if (t?.who === "agent") {
        if (t.text.trim() === streaming.trim()) setStreaming(null);
        break;
      }
    }
  }, [agent.log, streaming]);

  // The single composer. When the agent is waiting on a decision (q), the reply
  // is delivered as guidance that RESUMES the same agent (the actionable path).
  // Otherwise it's a chat message — relayed live to a running agent, or answered
  // from the log for a finished one.
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (q) {
      resolveHitl(q.id, "modify", { guidance: text });
      setDraft("");
      return;
    }
    setDraft("");
    setStreaming("");
    try {
      await streamAgentMessage(agent.id, text, (chunk) => setStreaming((s) => (s ?? "") + chunk));
    } catch {
      setStreaming((s) => (s ?? "") + " (couldn't get a reply)");
    }
  };

  const parent = agent.parentId
    ? runs.find((a) => a.id === agent.parentId)
    : undefined;

  return (
    <section className="detail">
      <div className="detail-head">
        <button className="btn btn-ghost btn-back" onClick={onBack}>
          ← {backLabel || "Back"}
        </button>
        <div className="detail-title">
          <StatusDot status={agent.status} />
          <h2>{agent.name}</h2>
          <span className="status-word" style={{ color: STATUS_META[agent.status].color }}>
            {STATUS_META[agent.status].label}
          </span>
          <button
            className="btn btn-ghost btn-fork"
            disabled={fleet.length === 0}
            title={
              fleet.length === 0
                ? "Configure an agent in Fleet before forking runs."
                : "Duplicate this run with the same context to work on something else"
            }
            onClick={() => forkAgent(agent.id)}
          >
            ⑂ Fork run
          </button>

          {/* Pre-merge preview: run this change's branch and see it before it
              merges. Needs a local project folder to spin a worktree from. */}
          {project?.repoPath && !agent.archived && (
            <button
              className="btn btn-ghost"
              title="Run this change on its own branch and preview it live — before it merges"
              onClick={() => setPreviewOpen(true)}
            >
              ▶ Preview this change
            </button>
          )}

          {/* Lifecycle controls */}
          {agent.status === "paused" ? (
            <button
              className="btn btn-ghost"
              title="Resume this agent"
              onClick={() => resumeAgent(agent.id)}
            >
              ▶ Resume
            </button>
          ) : (
            agent.status !== "done" && (
              <button
                className="btn btn-ghost"
                title="Pause this run; resume later"
                onClick={() => pauseAgent(agent.id)}
              >
                ⏸ Pause
              </button>
            )
          )}
          {agent.status !== "done" && (
            <button
              className="btn btn-ghost btn-stop"
              title="Stop this run — halts execution and frees its agent"
              onClick={() => {
                if (confirm(`Stop “${agent.name}”? This frees its agent; the run won't resume.`))
                  void stopAgent(agent.id);
              }}
            >
              ◼ Stop run
            </button>
          )}
          <button
            className="btn btn-ghost"
            title={agent.archived ? "Restore to the board" : "Archive — hide from the board (kept in history)"}
            onClick={() => archiveAgent(agent.id, !agent.archived)}
          >
            {agent.archived ? "⊕ Unarchive" : "⊘ Archive"}
          </button>
        </div>
        <div className="detail-meta">
          <span className="mono">{agent.branch}</span>
          <span>{agent.model}</span>
          <span>{fmtElapsed(agent, now)}</span>
          {fmtUsage(agent.usage) && <span className="usage-chip mono" title="Tokens · cost · turns reported by the agent">{fmtUsage(agent.usage)}</span>}
          {agent.status === "done" ? (
            <span className="hb hb-done">♥ finished</span>
          ) : (
            <span className="hb">
              ♥ heartbeat{" "}
              {q
                ? fmtWait(waitedSecs(q, now))
                : Math.floor(heartbeatSecs(agent, now)) + "s"}{" "}
              ago
            </span>
          )}
          {agent.parentId && (
            <span className="fork-tag">
              ⑂ fork of {parent ? runnerName(parent, fleet) : agent.parentId} — shared
              context
            </span>
          )}
        </div>
      </div>

      {taskDesc && (
        <div className="detail-desc">
          <div className="detail-desc-label mono">BRIEF</div>
          <p className="detail-desc-body">{taskDesc}</p>
        </div>
      )}

      {answer && (
        <div className="detail-result">
          <div className="detail-result-label mono">ANSWER</div>
          {looksMarkdown(answer) ? (
            <div className="detail-result-body log-md"><Markdown text={answer} /></div>
          ) : (
            <div className="detail-result-body">{answer}</div>
          )}
        </div>
      )}

      {conflictMod && (
        <div className="detail-conflict">
          ⚠ Overlap in <b>{modName(modules, conflictMod)}</b> — also being modified by{" "}
          {runs
            .filter(
              (a) =>
                a.id !== agent.id &&
                a.status !== "done" &&
                a.modules.includes(conflictMod),
            )
            .map((a) => a.name)
            .join(", ")}
          . Coordinate before merge.
        </div>
      )}

      <div className="detail-cols">
        <div className="panel">
          <div className="panel-head">
            PLAN{" "}
            <span className="panel-sub">
              {doneCount}/{agent.plan.length}
            </span>
          </div>
          <ol className="plan">
            {agent.plan.map((p, i) => (
              <li key={i} className={"plan-step " + p.state}>
                <span className="plan-mark">
                  {p.state === "done" ? "✓" : p.state === "now" ? "▸" : "·"}
                </span>
                {p.text}
              </li>
            ))}
          </ol>
          <div className="panel-head">
            MODIFIED MODULES <span className="panel-sub">{agent.modules.length}</span>
          </div>
          <div className="modlist">
            {agent.modules.map((ar, i) => (
              <span
                key={i}
                className={"modchip" + (conflictMods.includes(ar) ? " modchip-conflict" : "")}
              >
                {modName(modules, ar)}
                {conflictMods.includes(ar) && " ⚠"}
              </span>
            ))}
          </div>
        </div>
        <div className="detail-right">
          {agent.visual && (
            <div className="panel panel-preview">
              <div className="panel-head">
                LIVE PREVIEW{" "}
                <span className="panel-sub">what's actually built right now</span>
              </div>
              <PreviewFor agent={agent} />
            </div>
          )}
          <div className="panel panel-log">
            <div className="panel-head">
              LIVE LOG <span className="panel-sub">activity + conversation — reply below</span>
            </div>
            <div className="log" ref={logRef}>
              {agent.log.map((l, i) => {
                // Conversation turns render as chat bubbles; everything else is
                // telemetry (with foldable tool detail).
                const turn = chatTurn(l.line);
                if (turn) {
                  return (
                    <div key={i} className={"log-turn log-turn-" + turn.who}>
                      <span className="log-who mono">{turn.who === "you" ? "you" : agent.name}</span>
                      {looksMarkdown(turn.text) ? (
                        <div className="log-turn-text log-md"><Markdown text={turn.text} /></div>
                      ) : (
                        <span className="log-turn-text">{turn.text}</span>
                      )}
                    </div>
                  );
                }
                const cls =
                  "log-line" +
                  (l.line.includes("⏸")
                    ? " log-hitl"
                    : l.line.includes("⚠")
                      ? " log-warn"
                      : "");
                // Entries with detail (tool input/output) fold open on click.
                return l.detail ? (
                  <details key={i} className={cls + " log-foldable"}>
                    <summary>{l.line}</summary>
                    <pre className="log-detail">{l.detail}</pre>
                  </details>
                ) : looksMarkdown(l.line) ? (
                  // Marker-less agent prose (e.g. the final answer) — render its
                  // markdown instead of showing raw **bold**/`code`/- bullets.
                  <div key={i} className="log-prose log-md">
                    <Markdown text={l.line} />
                  </div>
                ) : (
                  <div key={i} className={cls}>
                    {l.line}
                  </div>
                );
              })}
              {streaming != null && (
                <div className="log-turn log-turn-agent">
                  <span className="log-who mono">{agent.name}</span>
                  <span className="log-turn-text">{streaming}<span className="log-cursor">▌</span></span>
                </div>
              )}
              {agent.status === "running" && streaming == null && <div className="log-line log-cursor">▌</div>}
            </div>

            {/* The one place to respond: quick decision buttons when the agent is
                waiting, plus a composer that resumes it (when waiting) or chats. */}
            <div className={"log-compose" + (q ? " log-compose-blocked" : "")}>
              {q && (
                <div className="log-decision">
                  <span
                    className="kind-chip"
                    style={{ color: KIND_META[q.kind].color, borderColor: KIND_META[q.kind].color }}
                  >
                    {KIND_META[q.kind].label}
                  </span>
                  <span className="log-decision-title">{q.title}</span>
                  <RiskChip risk={q.risk} />
                  <span className="qcard-wait">{fmtWait(waitedSecs(q, now))}</span>
                  <span className="log-decision-actions">
                    {q.kind === "escalation" ? (
                      // The agent (or a guard) halted this run and asked for help.
                      // There's nothing to "approve": the operator either hands it
                      // to a fresh runner, stops it, or types guidance below and
                      // resumes (the composer's "Send & resume" = the modify action).
                      <>
                        <button
                          className="btn btn-sm"
                          title="Hand this run to a different runner to retry fresh (with your guidance below, if any)"
                          onClick={() => resolveHitl(q.id, "reassign", { guidance: draft.trim() })}
                        >
                          Reassign
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => resolveHitl(q.id, "reject")}>
                          Stop run
                        </button>
                      </>
                    ) : q.options ? (
                      q.options.map((opt, i) => (
                        <button
                          key={i}
                          className={"btn btn-sm" + (i === q.recommended ? " btn-primary" : "")}
                          onClick={() => resolveHitl(q.id, "option", { optionIndex: i })}
                        >
                          “{opt}”
                        </button>
                      ))
                    ) : (
                      <>
                        <button className="btn btn-sm btn-primary" onClick={() => resolveHitl(q.id, "approve")}>
                          Approve
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => resolveHitl(q.id, "reject")}>
                          Reject
                        </button>
                      </>
                    )}
                    <button className="btn btn-sm btn-ghost" onClick={() => setShowDiff((v) => !v)}>
                      {showDiff ? "Hide details" : "Details"}
                    </button>
                  </span>
                </div>
              )}
              {q && showDiff && <HitlContext q={q} runName={agent.name} openDiff />}
              <div className="qx-row log-composer">
                <input
                  className="qx-input qx-line"
                  placeholder={
                    q
                      ? "Reply and resume — e.g. “yes, commit and open a PR”…"
                      : agent.status === "done"
                        ? "Ask about what shipped…"
                        : "Message the agent — it keeps working…"
                  }
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                />
                <button className={"btn" + (q ? " btn-primary" : "")} onClick={send} disabled={!draft.trim()}>
                  {q ? "Send & resume" : "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {previewOpen && (
        <LivePreviewModal
          id={agent.id}
          kind="run"
          title={"Preview change · " + agent.name}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </section>
  );
}
