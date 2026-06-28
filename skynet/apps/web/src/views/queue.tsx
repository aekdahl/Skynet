import { useState } from "react";
import type { Agent, HitlItem } from "@skynet/shared";
import { useStore } from "../lib/store";
import { fmtClock, fmtWait, KIND_META, openQueue, waitedSecs } from "../lib/derive";

export function QueueCard({
  item,
  agent,
  now,
  selected,
  onOpen,
}: {
  item: HitlItem;
  agent: Agent | undefined;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const { resolveHitl, sendAgentMessage } = useStore();
  const k = KIND_META[item.kind];
  const [mode, setMode] = useState<null | "modify" | "chat">(null);
  const [draft, setDraft] = useState("");
  const [msgs, setMsgs] = useState<Array<{ who: "you" | "agent"; text: string }>>([]);
  const agentName = agent?.name ?? item.agentId;

  const send = async () => {
    if (!draft.trim() || !agent) return;
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

  const resolved = item.resolvedAt != null;

  return (
    <article
      className={
        "qcard" + (selected ? " sel" : "") + (resolved ? " leaving" : "")
      }
    >
      <div className="qcard-head">
        <span className="kind-chip" style={{ color: k.color, borderColor: k.color }}>
          {k.label}
        </span>
        <button className="qcard-agent" onClick={onOpen}>
          {agentName}
        </button>
        <span className="qcard-wait">{fmtWait(waitedSecs(item, now))}</span>
      </div>
      <h3 className="qcard-title">{item.title}</h3>
      <p className="qcard-why">{item.why}</p>

      {item.command && <pre className="qcard-code">$ {item.command}</pre>}

      {item.steps && (
        <ol className="qcard-steps">
          {item.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}

      {item.diff && (
        <div className="qcard-diff">
          <span className="diff-add">+{item.diff.add}</span>
          <span className="diff-del">−{item.diff.del}</span>
          <span className="diff-files">{item.diff.modules.join("  ·  ")}</span>
        </div>
      )}

      {item.options ? (
        <div className="qcard-actions">
          {item.options.map((opt, i) => (
            <button
              key={i}
              className={"btn" + (i === item.recommended ? " btn-primary" : "")}
              onClick={() => resolveHitl(item.id, "option", { optionIndex: i })}
            >
              “{opt}”
              {i === item.recommended && <span className="rec">rec</span>}
            </button>
          ))}
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
          <button className="btn btn-ghost" onClick={onOpen}>
            Open agent
          </button>
        </div>
      ) : (
        <div className="qcard-actions">
          <button
            className="btn btn-primary"
            onClick={() => resolveHitl(item.id, "approve")}
          >
            Approve
          </button>
          <button
            className="btn btn-danger"
            onClick={() => resolveHitl(item.id, "reject")}
          >
            Reject
          </button>
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
          <button className="btn btn-ghost" onClick={onOpen}>
            Open agent
          </button>
        </div>
      )}

      {mode === "modify" && (
        <div className="qx">
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
              onClick={() =>
                resolveHitl(item.id, "modify", { guidance: draft.trim() })
              }
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
        <div className="qx">
          <div className="qx-thread">
            <div className="qx-msg qx-agent">
              <span className="qx-who mono">{agentName}</span>
              {item.why}
            </div>
            {msgs.map((m, i) => (
              <div
                key={i}
                className={"qx-msg " + (m.who === "you" ? "qx-you" : "qx-agent")}
              >
                <span className="qx-who mono">
                  {m.who === "you" ? "you" : agentName}
                </span>
                {m.text}
              </div>
            ))}
          </div>
          <div className="qx-row">
            <input
              className="qx-input qx-line"
              placeholder="Ask or instruct…"
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
    </article>
  );
}

export function QueueView({
  selectedIdx,
  onOpen,
  now,
}: {
  selectedIdx: number;
  onOpen: (id: string) => void;
  now: number;
}) {
  const { queue, agents } = useStore();
  const open = openQueue(queue).sort(
    (a, b) => waitedSecs(b, now) - waitedSecs(a, now),
  );
  const total = open.reduce((n, it) => n + waitedSecs(it, now), 0);
  const resolvedCount = queue.filter((q) => q.resolvedAt != null).length;

  return (
    <section className="queue">
      <div className="queue-readout">
        <div className="readout-block">
          <span className="readout-num">{open.length}</span>
          <span className="readout-label">
            agents waiting
            <br />
            on you
          </span>
        </div>
        <div className="readout-block">
          <span className="readout-num readout-warn">{fmtClock(total)}</span>
          <span className="readout-label">
            cumulative
            <br />
            wait time
          </span>
        </div>
        <div className="readout-block">
          <span className="readout-num readout-ok">{resolvedCount}</span>
          <span className="readout-label">
            resolved
            <br />
            this session
          </span>
        </div>
      </div>
      {open.length === 0 ? (
        <div className="queue-empty">
          <span className="queue-empty-mark">✓</span>
          <p>Queue clear — no human override required.</p>
        </div>
      ) : (
        <div className="queue-list">
          {open.map((it, i) => (
            <QueueCard
              key={it.id}
              item={it}
              agent={agents.find((a) => a.id === it.agentId)}
              now={now}
              selected={i === selectedIdx}
              onOpen={() => onOpen(it.agentId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
