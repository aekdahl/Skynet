import { useEffect, useState } from "react";
import type { ProviderId, ProviderInfo, Agent } from "@skynet/shared";
import { useStore } from "../lib/store";
import { fmtWait, providerInfo, providerReadiness, runnerIdleLabel, runnerIsBusy, STATUS_META } from "../lib/derive";
import { StatusDot } from "../components/common";

function ConfigForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Agent;
  onSave: (r: { name: string; provider: ProviderId; model: string }) => void;
  onCancel: () => void;
}) {
  const { providers } = useStore();
  const isConfigured = (p: ProviderInfo) => providerReadiness(p).ready;
  const [name, setName] = useState(initial ? initial.name : "");
  const [provider, setProvider] = useState<ProviderId>(
    initial
      ? initial.provider
      : (providers.find(isConfigured)?.id ?? providers[0]?.id ?? "claude"),
  );
  const selected = providerInfo(providers, provider);
  const selectedReq = selected.requirements;
  const models = selected.models;
  const [model, setModel] = useState(initial ? initial.model : (models[0] ?? ""));

  useEffect(() => {
    if (!models.includes(model)) setModel(models[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  return (
    <div className="cfg">
      <div className="cfg-row">
        <label className="cfg-label">Agent name</label>
        <input
          className="qx-input"
          value={name}
          placeholder="agent-10"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="cfg-row">
        <label className="cfg-label">Provider</label>
        <div className="cfg-prov">
          {providers.map((p) => {
            const rd = providerReadiness(p);
            return (
              <button
                key={p.id}
                className={"cfg-prov-btn" + (provider === p.id ? " on" : "")}
                style={
                  provider === p.id
                    ? { borderColor: p.color, color: p.color }
                    : rd.ready
                      ? undefined
                      : { opacity: 0.4, cursor: "not-allowed" }
                }
                disabled={!rd.ready}
                title={rd.ready ? undefined : `${p.name} needs ${rd.missing.join(" and ")}`}
                onClick={() => setProvider(p.id)}
              >
                <span style={{ color: p.color }}>{p.glyph}</span> {p.name}
                {!rd.ready && " · needs setup"}
              </button>
            );
          })}
        </div>
        {selectedReq && (
          <p className="cfg-prov-req">
            {selectedReq.runtime === "cli"
              ? `Runs the ${selectedReq.bin} CLI on the server — must be installed on PATH.`
              : "Runs in-process — no CLI to install."}{" "}
            {selectedReq.cliLogin
              ? "Auth via its CLI login or a key."
              : selectedReq.authEnvVars.length > 0
                ? `Auth: ${selectedReq.authEnvVars.slice(0, 3).join(" / ")}.`
                : ""}{" "}
            {selectedReq.installHint}
            {selectedReq.docsUrl && (
              <>
                {" "}
                <a href={selectedReq.docsUrl} target="_blank" rel="noreferrer">
                  Setup docs ↗
                </a>
              </>
            )}
          </p>
        )}
      </div>
      <div className="cfg-row">
        <label className="cfg-label">Model</label>
        <div className="cfg-models">
          {models.map((m) => (
            <button
              key={m}
              className={"cfg-model-btn" + (model === m ? " on" : "")}
              onClick={() => setModel(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <div className="qx-row">
        <button
          className="btn btn-primary"
          onClick={() => onSave({ name: name.trim(), provider, model })}
        >
          {initial ? "Save changes" : "Add to fleet"}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function FleetView({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { fleet, runs, providers, createAgent, updateAgent, deleteAgent } =
    useStore();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [openRunner, setOpenRunner] = useState<string | null>(null);
  const now = Date.now();

  // Every agent this runner has executed (live + finished), newest first — a
  // completed agent keeps its agentId, so this is the runner's full work log.
  const historyOf = (r: Agent) =>
    runs.filter((a) => a.agentId === r.id).sort((a, b) => b.startedAt - a.startedAt);

  const busyOf = (r: Agent) =>
    runs.find((a) => a.status !== "done" && a.agentId === r.id);

  return (
    <section className="vw">

      <div className="fleet-head">
        <div className="vw-head">
          <h1>Agent fleet</h1>
          <p>
            {fleet.length} agents configured · Claude, Codex, Gemini, Cursor, Copilot
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setAdding(true);
            setEditing(null);
          }}
        >
          + Configure agent
        </button>
      </div>
      {adding && (
        <div className="panel cfg-panel">
          <div className="panel-head">NEW AGENT</div>
          <ConfigForm
            onSave={(r) => {
              createAgent(r.provider, r.model, r.name || undefined);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
      <div className="fleet-grid">
        {fleet.map((r) => {
          const busy = busyOf(r);
          const p = providerInfo(providers, r.provider);
          const isEditing = editing === r.id;
          return (
            <div key={r.id} className={"fleet-card" + (busy ? " fleet-busy" : "")}>
              {isEditing ? (
                <ConfigForm
                  initial={r}
                  onSave={(u) => {
                    updateAgent(r.id, { model: u.model, name: u.name || undefined });
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <>
                  {(() => {
                    const history = historyOf(r);
                    const open = openRunner === r.id;
                    return (
                      <>
                        <button
                          className="fleet-cardhead"
                          aria-expanded={open}
                          title={history.length ? "Show this agent's task history" : "No task history yet"}
                          onClick={() => setOpenRunner(open ? null : r.id)}
                        >
                          <div className="fleet-top">
                            <span className="fleet-prov" style={{ color: p.color }}>
                              {p.glyph}
                            </span>
                            <span className="fleet-rn mono">{r.name}</span>
                            {busy || runnerIsBusy(r, runs) ? (
                              <span className="fleet-state fleet-state-busy">
                                <span className="dot dot-running" />
                                busy
                              </span>
                            ) : (
                              <span className="fleet-state fleet-state-idle">
                                <span className="dot dot-idle" />
                                idle {runnerIdleLabel(r, now)}
                              </span>
                            )}
                            <span className="fleet-caret">{open ? "▾" : "▸"}</span>
                          </div>
                          <div className="fleet-meta">
                            <span className="fleet-pname">{p.name}</span>
                            <span className="fleet-model mono">{r.model}</span>
                            <span className="fleet-histcount">
                              {history.length} task{history.length === 1 ? "" : "s"}
                            </span>
                          </div>
                        </button>

                        {/* Collapsed + busy: keep the current task glanceable. */}
                        {busy && !open && (
                          <button
                            className="fleet-task fleet-task-link"
                            onClick={() => onOpenTask(busy.id)}
                            title="Open this agent's live activity"
                          >
                            <span className="fleet-task-name">▸ {busy.name}</span>
                            <span className="fleet-task-cta">activity →</span>
                          </button>
                        )}

                        {/* Expanded: the runner's full task history, each row → that agent. */}
                        {open && (
                          <div className="fleet-hist">
                            {history.length === 0 ? (
                              <div className="fleet-hist-empty">
                                No tasks yet — assign one to this fleet from a project.
                              </div>
                            ) : (
                              history.map((a) => (
                                <button
                                  key={a.id}
                                  className="fleet-hist-row"
                                  onClick={() => onOpenTask(a.id)}
                                  title="Open this agent's activity & history"
                                >
                                  <StatusDot status={a.status} />
                                  <span className="fleet-hist-name">{a.name}</span>
                                  <span
                                    className="fleet-hist-state mono"
                                    style={{ color: STATUS_META[a.status].color }}
                                  >
                                    {STATUS_META[a.status].label}
                                  </span>
                                  <span className="fleet-hist-time mono">
                                    {fmtWait(Math.max(0, (now - a.startedAt) / 1000))} ago
                                  </span>
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}
                  <div className="fleet-actions">
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setEditing(r.id);
                        setAdding(false);
                      }}
                    >
                      Configure
                    </button>
                    <button
                      className="btn btn-ghost btn-retire"
                      disabled={!!busy}
                      title={
                        busy
                          ? "Finish or reassign its task before retiring"
                          : "Retire this agent"
                      }
                      onClick={() => deleteAgent(r.id)}
                    >
                      Retire
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
