import { useEffect, useRef, useState } from "react";
import type { Checkpoint, TaskRun } from "@skynet/shared";
import { useStore } from "../lib/store";
import { fetchCheckpoints } from "../lib/client";
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
import { Blocked } from "../components/empty";
import { useConfirm } from "../components/confirm";
import { Markdown } from "../components/markdown";
import { HitlContext, RiskChip } from "../components/hitl-context";

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
/** Compact duration for the TRIAGE panel-head chip: 15s / 30m / 2.5h. */
function fmtEstDur(ms: number): string {
  if (ms < 60_000) return Math.max(1, Math.round(ms / 1000)) + "s";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + "m";
  const h = ms / 3_600_000;
  return (h < 10 ? h.toFixed(1) : Math.round(h)) + "h";
}
function fmtUsage(u: TaskRun["usage"]): string | null {
  if (!u) return null;
  const tok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const parts = [`${tok(u.inputTokens)}→${tok(u.outputTokens)} tok`];
  if (u.costUsd != null) parts.push(`$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)}`);
  if (u.turns) parts.push(`${u.turns} turns`);
  return parts.join(" · ");
}

// Wall-clock HH:MM:SS for a log line's epoch-ms `at` — lets lead times between
// lines be read at a glance.
const logTime = (at: number): string => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

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
    resolveHitl,
    forkAgent,
    createCheckpoint,
    restoreCheckpoint,
    streamAgentMessage,
    pauseAgent,
    resumeAgent,
    stopAgent,
    archiveAgent,
    logDeltas,
  } = useStore();
  const confirm = useConfirm();
  const q = openQueue(queue).find((it) => it.runId === agent.id);
  // The backing task carries the operator's brief AND the autonomous triage
  // metadata (assessment note + duration estimate) — surface both here so
  // opening a run detail shows what the fleet decided during triage, not just
  // its plan.
  const backingTask = tasks.find((t) => t.runId === agent.id) ?? null;
  const taskDesc = backingTask?.description ?? null;
  const doneCount = planDone(agent);
  const [draft, setDraft] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [copied, setCopied] = useState(false);
  // Selected option for a decision (AskUserQuestion) — click to select, then
  // "Send & resume" to submit. Reset when a new/different decision arrives so a
  // stale pick can't carry over. (Immediate-resolve-on-click was confusing next
  // to the Send button — it read as select-then-send but wasn't.)
  const [picked, setPicked] = useState<number | null>(null);
  // Guided merge: an operator override for the open diff gate's merge target —
  // blank means "use the gate's own default" (q.targetBranch). Reset whenever
  // a different gate arrives, same reasoning as `picked` above.
  const [targetBranch, setTargetBranch] = useState("");
  useEffect(() => {
    setTargetBranch("");
  }, [q?.id]);
  // Copy the whole log as timestamped plain text (line + any folded detail).
  const copyLog = () => {
    const text = agent.log
      .map((l) => `[${logTime(l.at)}] ${l.line}${l.detail ? "\n" + l.detail : ""}`)
      .join("\n");
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  // In-flight assistant reply for the chat path — streamed here so it types in
  // live, then dropped once the persisted `↳` line lands in the log (below).
  const [streaming, setStreaming] = useState<string | null>(null);
  // Token-level "typing" preview of whatever the agent is currently generating
  // (its own narration, a tool-call rationale, …) — server-pushed via
  // `run.log.delta`, held in the store keyed by runId. Empty string (the
  // reducer's clear-on-flush value) reads the same as absent.
  const delta = logDeltas[agent.id] || null;
  const logRef = useRef<HTMLDivElement>(null);

  // Checkpoints aren't part of the WS-synced snapshot (per-run, like the diff) —
  // fetched lazily here and kept in local state, refreshed on a new checkpoint
  // or a switch to a different run.
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointing, setCheckpointing] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchCheckpoints(agent.id)
      .then((cps) => live && setCheckpoints(cps))
      .catch(() => live && setCheckpoints([]));
    return () => {
      live = false;
    };
  }, [agent.id]);
  const takeCheckpoint = async () => {
    setCheckpointing(true);
    try {
      const cp = await createCheckpoint(agent.id);
      if (cp) setCheckpoints((cps) => [...cps, cp]);
    } finally {
      setCheckpointing(false);
    }
  };
  const restore = async (cp: Checkpoint) => {
    const ok = await confirm({
      title: "Restore this checkpoint?",
      body: `Rewinds “${agent.name}” back to ${cp.label ? `"${cp.label}"` : cp.sha.slice(0, 7)} — any work done since is dropped from the branch (still reachable in git history, just no longer on it).`,
      confirmLabel: "Restore",
      danger: true,
    });
    if (!ok) return;
    setRestoringId(cp.id);
    try {
      await restoreCheckpoint(agent.id, cp.id);
    } finally {
      setRestoringId(null);
    }
  };

  const conflictMods = conflictModulesForAgent(agent, runs);
  const conflictMod = conflictMods[0];
  const answer = finalAnswer(agent);

  // Keep the conversation pinned to the newest entry as it grows / streams.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [agent.log, streaming, delta]);

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

  // A new/different decision → drop any pick from the previous one.
  useEffect(() => {
    setPicked(null);
  }, [q?.id]);

  // The single composer. When the agent is waiting on a decision (q), the reply
  // resumes the same agent: a typed answer is delivered as guidance (modify); a
  // selected option is delivered as that choice. Otherwise it's a chat message —
  // relayed live to a running agent, or answered from the log for a finished one.
  const send = async () => {
    const text = draft.trim();
    if (q) {
      // Typed text wins (a custom answer / changes); else the picked option.
      if (text) {
        resolveHitl(q.id, "modify", { guidance: text });
        setDraft("");
        setPicked(null);
      } else if (q.options && picked != null) {
        resolveHitl(q.id, "option", { optionIndex: picked });
        setPicked(null);
      }
      return;
    }
    if (!text) return;
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
          <div className="detail-actions">
            <Blocked disabled={fleet.length === 0} reason={fleet.length === 0 ? "Configure an agent in Fleet before forking runs." : undefined}>
              <button
                className="btn btn-ghost btn-icon btn-fork"
                disabled={fleet.length === 0}
                title={fleet.length === 0 ? undefined : "Duplicate this run with the same context to work on something else"}
                onClick={() => forkAgent(agent.id)}
              >
                <span className="btn-gly" aria-hidden="true">⑂</span> Fork
              </button>
            </Blocked>
            {agent.status !== "done" && (
              <button
                className="btn btn-ghost btn-icon"
                disabled={checkpointing}
                title="Snapshot this run's worktree + plan now, so it can be rewound here later"
                onClick={() => void takeCheckpoint()}
              >
                <span className="btn-gly" aria-hidden="true">◍</span> {checkpointing ? "Checkpointing…" : "Checkpoint"}
              </button>
            )}

            {/* Lifecycle controls */}
            {agent.status === "paused" ? (
              <button
                className="btn btn-ghost btn-icon"
                title="Resume this agent"
                onClick={() => resumeAgent(agent.id)}
              >
                <span className="btn-gly" aria-hidden="true">▶</span> Resume
              </button>
            ) : (
              agent.status !== "done" && (
                <button
                  className="btn btn-ghost btn-icon"
                  title="Pause this run; resume later"
                  onClick={() => pauseAgent(agent.id)}
                >
                  <span className="btn-gly" aria-hidden="true">⏸</span> Pause
                </button>
              )
            )}
            {agent.status !== "done" && (
              <button
                className="btn btn-ghost btn-icon btn-stop"
                title="Stop this run — halts execution and frees its agent"
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Stop this run?",
                      body: `Stop “${agent.name}”? This frees its agent; the run won't resume.`,
                      confirmLabel: "Stop",
                      danger: true,
                    })
                  )
                    void stopAgent(agent.id);
                }}
              >
                <span className="btn-gly" aria-hidden="true">◼</span> Stop
              </button>
            )}
            <button
              className="btn btn-ghost btn-icon"
              title={agent.archived ? "Restore to the board" : "Archive — hide from the board (kept in history)"}
              onClick={() => archiveAgent(agent.id, !agent.archived)}
            >
              <span className="btn-gly" aria-hidden="true">{agent.archived ? "⊕" : "⊘"}</span>{" "}
              {agent.archived ? "Unarchive" : "Archive"}
            </button>
          </div>
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
              {q ? fmtWait(waitedSecs(q, now)) : fmtWait(heartbeatSecs(agent, now))}{" "}
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
          <div className="detail-result-body log-md"><Markdown text={answer} /></div>
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
          {(backingTask?.assessment || backingTask?.estimatedDurationMs != null) && (
            <>
              <div className="panel-head">
                TRIAGE
                {backingTask?.estimatedDurationMs != null && (
                  <span className="panel-sub">est. {fmtEstDur(backingTask.estimatedDurationMs)}</span>
                )}
              </div>
              {backingTask?.assessment && <p className="task-triage-note">{backingTask.assessment}</p>}
            </>
          )}
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
          {checkpoints.length > 0 && (
            <>
              <div className="panel-head">
                CHECKPOINTS <span className="panel-sub">{checkpoints.length}</span>
              </div>
              <ul className="cp-list">
                {checkpoints.map((cp) => (
                  <li key={cp.id} className="cp-row">
                    <span className="cp-info">
                      <span className="cp-label">{cp.label || "checkpoint"}</span>
                      <span className="cp-meta mono">
                        {cp.sha.slice(0, 7)} · {Math.round(cp.progress * 100)}% · {new Date(cp.createdAt).toLocaleTimeString()}
                      </span>
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={restoringId === cp.id}
                      title="Rewind this run's worktree (and, for Claude, its conversation) back to this point"
                      onClick={() => void restore(cp)}
                    >
                      {restoringId === cp.id ? "Restoring…" : "Restore"}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="detail-right">
          <div className="panel panel-log">
            <div className="panel-head">
              <span>LIVE LOG <span className="panel-sub">activity + conversation — reply below</span></span>
              {agent.log.length > 0 && (
                <button className="log-copy" onClick={copyLog} title="Copy the full log to the clipboard">
                  {copied ? "✓ Copied" : "⧉ Copy"}
                </button>
              )}
            </div>
            <div className="log" ref={logRef}>
              {agent.log.map((l, i) => {
                // Every entry is timestamped (HH:MM:SS) so lead times are visible.
                const ts = <span className="log-time mono" title="line timestamp">{logTime(l.at)}</span>;
                // Conversation turns render as chat bubbles; everything else is
                // telemetry (with foldable tool detail).
                const turn = chatTurn(l.line);
                if (turn) {
                  return (
                    <div key={i} className={"log-turn log-turn-" + turn.who}>
                      <span className="log-who mono">{turn.who === "you" ? "you" : agent.name} {ts}</span>
                      {/* A conversation turn is always prose — render its markdown
                          unconditionally. The old looksMarkdown gate left plainer
                          replies showing raw markdown syntax instead of formatting. */}
                      <div className="log-turn-text log-md"><Markdown text={turn.text} /></div>
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
                    <summary>{ts} {l.line}</summary>
                    <pre className="log-detail">{l.detail}</pre>
                  </details>
                ) : looksMarkdown(l.line) ? (
                  // Marker-less agent prose (e.g. the final answer) — render its
                  // markdown instead of showing raw **bold**/`code`/- bullets.
                  <div key={i} className="log-prose log-md">
                    <span className="log-time-block mono">{ts}</span>
                    <Markdown text={l.line} />
                  </div>
                ) : (
                  <div key={i} className={cls}>
                    {ts} {l.line}
                  </div>
                );
              })}
              {streaming != null && (
                <div className="log-turn log-turn-agent">
                  <span className="log-who mono">{agent.name}</span>
                  {/* Render the reply as markdown while it streams, so it doesn't
                      reflow from raw text to formatted when it lands in the log. */}
                  <div className="log-turn-text log-md">
                    <Markdown text={streaming} />
                    <span className="log-cursor">▌</span>
                  </div>
                </div>
              )}
              {/* Token-level preview of whatever the agent is generating right now
                  (narration, tool rationale, …) — same markup as a finalized
                  marker-less prose line (see looksMarkdown above) so it doesn't
                  visibly reflow the instant `run.log` lands and replaces it. */}
              {streaming == null && delta && (
                <div className="log-prose log-md">
                  <Markdown text={delta} />
                  <span className="log-cursor">▌</span>
                </div>
              )}
              {agent.status === "running" && streaming == null && !delta && <div className="log-line log-cursor">▌</div>}
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
                      // Select-then-send: click highlights the choice; "Send &
                      // resume" (below) submits it. Double-clicking a choice sends
                      // it straight away (select + confirm) for the quick path.
                      q.options.map((opt, i) => (
                        <button
                          key={i}
                          className={"btn btn-sm" + (i === picked ? " btn-primary" : "")}
                          aria-pressed={i === picked}
                          onClick={() => setPicked(i)}
                          onDoubleClick={() => resolveHitl(q.id, "option", { optionIndex: i })}
                        >
                          {i === picked ? "● " : "○ "}“{opt}”
                          {i === q.recommended && <span className="rec"> rec</span>}
                        </button>
                      ))
                    ) : (
                      <>
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() =>
                            resolveHitl(q.id, "approve", targetBranch.trim() ? { targetBranch: targetBranch.trim() } : undefined)
                          }
                        >
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
              {/* Guided merge: pick a merge target other than the gate's own
                  default (shown as the placeholder) — same picker as the Inbox
                  card, see queue.tsx's QueueCard for the full rationale. */}
              {q && q.kind === "diff" && (
                <div className="qcard-target">
                  <label className="qcard-target-label mono" htmlFor={`target-${q.id}`}>Merge into</label>
                  <input
                    id={`target-${q.id}`}
                    className="qcard-target-input mono"
                    placeholder={q.targetBranch ?? "default"}
                    value={targetBranch}
                    onChange={(e) => setTargetBranch(e.target.value)}
                  />
                </div>
              )}
              {q && showDiff && <HitlContext q={q} runName={agent.name} openDiff />}
              <div className="qx-row log-composer">
                <input
                  className="qx-input qx-line"
                  placeholder={
                    q
                      ? q.options
                        ? "Pick an option above, or type a different answer…"
                        : "Reply and resume — e.g. “yes, commit and open a PR”…"
                      : agent.status === "done"
                        ? "Ask about what shipped…"
                        : "Message the agent — it keeps working…"
                  }
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                />
                <button
                  className={"btn" + (q ? " btn-primary" : "")}
                  onClick={send}
                  disabled={q ? !draft.trim() && !(q.options && picked != null) : !draft.trim()}
                >
                  {q ? "Send & resume" : "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
