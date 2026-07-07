import { useState } from "react";
import type { Agent } from "@skynet/shared";
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
import { PreviewFor } from "../components/preview";

function AgentChat({ agent }: { agent: Agent }) {
  const { sendAgentMessage } = useStore();
  const now = agent.plan.find((p) => p.state === "now");
  const [msgs, setMsgs] = useState<Array<{ who: "you" | "agent"; text: string }>>([]);
  const [draft, setDraft] = useState("");
  const send = async () => {
    if (!draft.trim()) return;
    const text = draft.trim();
    setMsgs((m) => [...m, { who: "you", text }]);
    setDraft("");
    try {
      const reply = await sendAgentMessage(agent.id, text);
      setMsgs((m) => [...m, { who: "agent", text: reply }]);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="panel panel-chat">
      <div className="panel-head">
        CHAT <span className="panel-sub">discuss the task — agent keeps working</span>
      </div>
      <div className="qx-thread">
        <div className="qx-msg qx-agent">
          <span className="qx-who mono">{agent.name}</span>
          {agent.status === "done"
            ? "This task is merged. Ask me anything about what shipped."
            : 'Currently on “' +
              (now ? now.text : "…") +
              '”. Ask about my approach or redirect me — I’ll keep working meanwhile.'}
        </div>
        {msgs.map((m, i) => (
          <div key={i} className={"qx-msg " + (m.who === "you" ? "qx-you" : "qx-agent")}>
            <span className="qx-who mono">{m.who === "you" ? "you" : agent.name}</span>
            {m.text}
          </div>
        ))}
      </div>
      <div className="qx-row">
        <input
          className="qx-input qx-line"
          placeholder="Message the agent…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button className="btn" onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}

// The runner logs its final prose answer as a plain log line (no ▸/↳/marker).
// For a finished agent, surface the last such line as a headline result —
// otherwise a question task's answer stays buried in the live log.
const LOG_MARKERS = ["▸", "↳", "✓", "⏸", "⚠", "❑", "●", "$"];
function finalAnswer(agent: Agent): string | null {
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

export function AgentDetail({
  agent,
  now,
  onBack,
  backLabel,
}: {
  agent: Agent;
  now: number;
  onBack: () => void;
  backLabel: string;
}) {
  const { queue, agents, fleet, modules, resolveHitl, forkAgent, stopAgent, sendAgentMessage } =
    useStore();
  const q = openQueue(queue).find((it) => it.agentId === agent.id);
  const doneCount = planDone(agent);
  const [mode, setMode] = useState<null | "modify" | "chat">(null);
  const [draft, setDraft] = useState("");
  const [msgs, setMsgs] = useState<Array<{ who: "you" | "agent"; text: string }>>([]);

  const conflictMods = conflictModulesForAgent(agent, agents);
  const conflictMod = conflictMods[0];
  const answer = finalAnswer(agent);

  const send = async () => {
    if (!draft.trim()) return;
    const text = draft.trim();
    setMsgs((m) => [...m, { who: "you", text }]);
    setDraft("");
    try {
      const reply = await sendAgentMessage(agent.id, text);
      setMsgs((m) => [...m, { who: "agent", text: reply }]);
    } catch {
      /* ignore */
    }
  };

  const parent = agent.parentId
    ? agents.find((a) => a.id === agent.parentId)
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
                ? "Configure a runner in Fleet before forking agents."
                : "Duplicate this agent with the same context to work on something else"
            }
            onClick={() => forkAgent(agent.id)}
          >
            ⑂ Fork agent
          </button>
          {agent.status !== "done" && (
            <button
              className="btn btn-ghost btn-stop"
              title="Terminate this agent and free the runner it holds"
              onClick={() => {
                if (confirm(`Stop "${agent.name}"? This frees its runner; the agent won't resume.`)) {
                  void stopAgent(agent.id);
                }
              }}
            >
              ◼ Stop agent
            </button>
          )}
        </div>
        <div className="detail-meta">
          <span className="mono">{agent.branch}</span>
          <span>{agent.model}</span>
          <span>{fmtElapsed(agent, now)}</span>
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

      {answer && (
        <div className="detail-result">
          <div className="detail-result-label mono">ANSWER</div>
          <div className="detail-result-body">{answer}</div>
        </div>
      )}

      {q && (
        <div className="detail-blocked-wrap">
          <div className="detail-blocked">
            <span
              className="kind-chip"
              style={{
                color: KIND_META[q.kind].color,
                borderColor: KIND_META[q.kind].color,
              }}
            >
              {KIND_META[q.kind].label}
            </span>
            <span className="detail-blocked-title">{q.title}</span>
            <span className="qcard-wait">{fmtWait(waitedSecs(q, now))}</span>
            {q.options ? (
              q.options.map((opt, i) => (
                <button
                  key={i}
                  className={"btn" + (i === q.recommended ? " btn-primary" : "")}
                  onClick={() => resolveHitl(q.id, "option", { optionIndex: i })}
                >
                  “{opt}”
                </button>
              ))
            ) : (
              <>
                <button
                  className="btn btn-primary"
                  onClick={() => resolveHitl(q.id, "approve")}
                >
                  Approve
                </button>
                <button
                  className="btn btn-danger"
                  onClick={() => resolveHitl(q.id, "reject")}
                >
                  Reject
                </button>
              </>
            )}
            <button
              className={"btn btn-ghost" + (mode === "modify" ? " btn-lit" : "")}
              onClick={() => setMode(mode === "modify" ? null : "modify")}
            >
              Modify
            </button>
            <button
              className={"btn btn-ghost" + (mode === "chat" ? " btn-lit" : "")}
              onClick={() => setMode(mode === "chat" ? null : "chat")}
            >
              Chat
            </button>
          </div>
          {mode === "modify" && (
            <div className="qx detail-modify">
              <textarea
                className="qx-input"
                rows={3}
                autoFocus
                placeholder="Adjust the instruction — the agent resumes with this guidance…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="qx-row">
                <button
                  className="btn btn-primary"
                  onClick={() => resolveHitl(q.id, "modify", { guidance: draft.trim() })}
                >
                  Send &amp; resume
                </button>
                <button className="btn btn-ghost" onClick={() => setMode(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {mode === "chat" && (
            <div className="qx detail-modify">
              <div className="qx-thread">
                <div className="qx-msg qx-agent">
                  <span className="qx-who mono">{agent.name}</span>
                  {q.why}
                </div>
                {msgs.map((m, i) => (
                  <div
                    key={i}
                    className={"qx-msg " + (m.who === "you" ? "qx-you" : "qx-agent")}
                  >
                    <span className="qx-who mono">
                      {m.who === "you" ? "you" : agent.name}
                    </span>
                    {m.text}
                  </div>
                ))}
              </div>
              <div className="qx-row">
                <input
                  className="qx-input qx-line"
                  placeholder="Discuss before deciding…"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                />
                <button className="btn" onClick={send}>
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {conflictMod && (
        <div className="detail-conflict">
          ⚠ Overlap in <b>{modName(modules, conflictMod)}</b> — also being modified by{" "}
          {agents
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
          <AgentChat agent={agent} />
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
            <div className="panel-head">LIVE LOG</div>
            <div className="log">
              {agent.log.map((l, i) => {
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
                ) : (
                  <div key={i} className={cls}>
                    {l.line}
                  </div>
                );
              })}
              {agent.status === "running" && <div className="log-line log-cursor">▌</div>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
