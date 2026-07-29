import { useState } from "react";
import type { TaskRun, HitlItem } from "@skynet/shared";
import { useStore } from "../lib/store";
import { fmtWait, KIND_META, openQueue, waitedSecs } from "../lib/derive";
import { RiskChip } from "../components/hitl-context";
import { DiffView } from "../components/diff-view";

export function QueueCard({
  item,
  agent,
  now,
  selected,
  onOpen,
}: {
  item: HitlItem;
  agent: TaskRun | undefined;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const { resolveHitl, streamAgentMessage } = useStore();
  const k = KIND_META[item.kind];
  const [mode, setMode] = useState<null | "modify" | "chat">(null);
  const [draft, setDraft] = useState("");
  const [msgs, setMsgs] = useState<Array<{ who: "you" | "agent"; text: string }>>([]);
  const agentName = agent?.name ?? item.runId;

  const send = async () => {
    if (!draft.trim() || !agent) return;
    const text = draft.trim();
    const runId = agent.id;
    setMsgs((m) => [...m, { who: "you", text }, { who: "agent", text: "" }]);
    setDraft("");
    const appendToLast = (chunk: string) =>
      setMsgs((m) => {
        const next = [...m];
        const last = next[next.length - 1];
        if (last && last.who === "agent") next[next.length - 1] = { who: "agent", text: last.text + chunk };
        return next;
      });
    try {
      await streamAgentMessage(runId, text, appendToLast);
    } catch {
      appendToLast("(couldn't get a reply)");
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
        <RiskChip risk={item.risk} />
        <button className="qcard-agent" onClick={onOpen}>
          {agentName}
        </button>
        <span className="qcard-wait">{fmtWait(waitedSecs(item, now))}</span>
      </div>
      <h3 className="qcard-title">{item.title}</h3>
      {item.rationale && <p className="qcard-reason">💭 {item.rationale}</p>}
      <p className="qcard-why">{item.why}</p>

      {item.command && <pre className="qcard-code">$ {item.command}</pre>}

      {item.flags && item.flags.length > 0 && (
        <div className="qcard-flags">
          <span className="qcard-flags-label mono">{item.kind === "merge" ? "Conflicts in" : "Flagged"}</span>
          {item.flags.map((f, i) => (
            <span key={i} className={"flag-chip" + (item.kind === "merge" ? " flag-file mono" : "")}>{f}</span>
          ))}
        </div>
      )}

      {item.steps && (
        <>
          <p className="qcard-plan-label mono">Proposed plan — approve before the agent writes</p>
          <ol className="qcard-steps">
            {item.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </>
      )}

      {item.diff && (item.kind === "diff" || item.kind === "merge") && (
        <DiffView runId={item.runId} add={item.diff.add} del={item.diff.del} />
      )}

      {item.kind === "escalation" ? (
        <div className="qcard-actions">
          <button
            className={"btn btn-primary" + (mode === "modify" ? " btn-lit" : "")}
            onClick={() => setMode(mode === "modify" ? null : "modify")}
          >
            Help &amp; resume
          </button>
          <button
            className="btn"
            title="Hand this run to a different runner to retry fresh"
            onClick={() => resolveHitl(item.id, "reassign", { guidance: draft.trim() })}
          >
            Reassign
          </button>
          <button className="btn btn-danger" onClick={() => resolveHitl(item.id, "reject")}>
            Stop run
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
      ) : item.options ? (
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
          {item.kind === "approval" && item.command && item.risk !== "high" && (
            <button
              className="btn btn-ghost"
              title="Approve now and always auto-approve this exact command in this project"
              onClick={() => resolveHitl(item.id, "approve", { remember: true })}
            >
              Always allow
            </button>
          )}
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
  const { queue, runs, resolveHitl } = useStore();
  const open = openQueue(queue).sort(
    (a, b) => waitedSecs(b, now) - waitedSecs(a, now),
  );
  // Resolved *today* (since local midnight) — a bounded, self-resetting momentum
  // stat. The old count was every resolved gate the store still held, so it only
  // ever grew and never reset (it was mislabeled "this session").
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const resolvedCount = queue.filter((q) => q.resolvedAt != null && q.resolvedAt >= startOfToday).length;
  // Clear-all = reject every still-open gate. Consequential (each reject bounces
  // that run), so it's a two-step: arm, then confirm.
  const [armed, setArmed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const rejectAll = async () => {
    setClearing(true);
    // Sequential, not Promise.all — each reject resumes its agent; don't stampede.
    for (const it of open) {
      try {
        await resolveHitl(it.id, "reject");
      } catch {
        /* already resolved / gone — keep going */
      }
    }
    setClearing(false);
    setArmed(false);
  };

  return (
    <section className="queue">
      <div className="queue-readout">
        <div className="readout-block">
          <span className="readout-num">{open.length}</span>
          <span className="readout-label">
            runs waiting
            <br />
            on you
          </span>
        </div>
        <div className="readout-block">
          <span className="readout-num readout-ok">{resolvedCount}</span>
          <span className="readout-label">
            resolved
            <br />
            today
          </span>
        </div>
        {open.length > 0 && (
          <div className="readout-actions">
            {armed ? (
              <>
                <span className="readout-confirm">Reject all {open.length} open?</span>
                <button className="btn btn-danger" disabled={clearing} onClick={rejectAll}>
                  {clearing ? "Rejecting…" : "Reject all"}
                </button>
                <button className="btn btn-ghost" disabled={clearing} onClick={() => setArmed(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn btn-ghost" title="Reject every still-open gate" onClick={() => setArmed(true)}>
                Clear all
              </button>
            )}
          </div>
        )}
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
              agent={runs.find((a) => a.id === it.runId)}
              now={now}
              selected={i === selectedIdx}
              onOpen={() => onOpen(it.runId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
