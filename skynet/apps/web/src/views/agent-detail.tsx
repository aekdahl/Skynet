import { useState } from "react";
import { useStore } from "../lib/store";
import { fmtWait, providerInfo, runnerIdleLabel, runnerIsBusy, STATUS_META } from "../lib/derive";
import { StatusDot } from "../components/common";
import { ConfigForm } from "./fleet";

// Detail view for one fleet AGENT (a configured runner) — its identity, a stats
// roll-up across every run it has executed, inline configure/retire, and the full
// task history (each row → that run's activity). Reached by clicking an agent in
// the Fleet grid.
export function AgentDetailView({
  agentId,
  now,
  onBack,
  onOpenTask,
}: {
  agentId: string;
  now: number;
  onBack: () => void;
  onOpenTask: (id: string) => void;
}) {
  const { fleet, runs, providers, updateAgent, deleteAgent } = useStore();
  const [editing, setEditing] = useState(false);
  const agent = fleet.find((a) => a.id === agentId);

  if (!agent) {
    return (
      <section className="vw agent-detail">
        <button className="btn btn-ghost btn-back" onClick={onBack}>
          ← Fleet
        </button>
        <div className="kb-empty">
          This agent was retired.{" "}
          <button className="kb-assign" onClick={onBack}>
            Back to fleet →
          </button>
        </div>
      </section>
    );
  }

  const p = providerInfo(providers, agent.provider);
  const history = runs
    .filter((a) => a.agentId === agent.id)
    .sort((a, b) => b.startedAt - a.startedAt);
  const doneCount = history.filter((a) => a.status === "done").length;
  const activeCount = history.length - doneCount;
  const isBusy = runnerIsBusy(agent, runs);
  const tokens = history.reduce((s, a) => s + (a.usage ? a.usage.inputTokens + a.usage.outputTokens : 0), 0);
  const cost = history.reduce((s, a) => s + (a.usage?.costUsd ?? 0), 0);

  return (
    <section className="vw agent-detail">
      <button className="btn btn-ghost btn-back" onClick={onBack}>
        ← Fleet
      </button>

      <header className="ad-head">
        <span className="ad-glyph" style={{ color: p.color }}>
          {p.glyph}
        </span>
        <div className="ad-id">
          <h1 className="ad-name mono">{agent.name}</h1>
          <div className="ad-sub">
            <span className="ad-prov">{p.name}</span>
            <span className="ad-model mono">{agent.model}</span>
            {isBusy ? (
              <span className="ad-state ad-state-busy">
                <span className="dot dot-running" /> busy
              </span>
            ) : (
              <span className="ad-state ad-state-idle">
                <span className="dot dot-idle" /> idle {runnerIdleLabel(agent, now)}
              </span>
            )}
          </div>
        </div>
        <div className="ad-actions">
          <button className="btn btn-ghost" onClick={() => setEditing((e) => !e)}>
            {editing ? "Cancel" : "Configure"}
          </button>
          <button
            className="btn btn-ghost btn-retire"
            disabled={isBusy}
            title={isBusy ? "Finish or reassign its task before retiring" : "Retire this agent"}
            onClick={() => {
              deleteAgent(agent.id);
              onBack();
            }}
          >
            Retire
          </button>
        </div>
      </header>

      {editing && (
        <div className="panel cfg-panel">
          <div className="panel-head">CONFIGURE AGENT</div>
          <ConfigForm
            initial={agent}
            onSave={(u) => {
              updateAgent(agent.id, { model: u.model, name: u.name || undefined });
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      <div className="ad-stats">
        <div className="ad-stat">
          <b>{history.length}</b>
          <span>task{history.length === 1 ? "" : "s"}</span>
        </div>
        <div className="ad-stat">
          <b>{doneCount}</b>
          <span>done</span>
        </div>
        <div className="ad-stat">
          <b>{activeCount}</b>
          <span>active</span>
        </div>
        {tokens > 0 && (
          <div className="ad-stat">
            <b>{tokens.toLocaleString()}</b>
            <span>tokens</span>
          </div>
        )}
        {cost > 0 && (
          <div className="ad-stat">
            <b>${cost.toFixed(2)}</b>
            <span>cost</span>
          </div>
        )}
      </div>

      <h2 className="ad-h2">Task history</h2>
      <div className="ad-hist">
        {history.length === 0 ? (
          <div className="ad-hist-empty">No tasks yet — assign one to this agent from a project.</div>
        ) : (
          history.map((a) => (
            <button
              key={a.id}
              className="ad-hist-row"
              onClick={() => onOpenTask(a.id)}
              title="Open this run's activity & history"
            >
              <StatusDot status={a.status} />
              <span className="ad-hist-name">{a.name}</span>
              <span className="ad-hist-state mono" style={{ color: STATUS_META[a.status].color }}>
                {STATUS_META[a.status].label}
              </span>
              <span className="ad-hist-time mono">{fmtWait(Math.max(0, (now - a.startedAt) / 1000))} ago</span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
