import { useEffect, useState } from "react";
import type { ProviderId, Runner } from "@skynet/shared";
import { useStore } from "../lib/store";
import { providerInfo, runnerIdleLabel, runnerIsBusy } from "../lib/derive";

function ConfigForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Runner;
  onSave: (r: { name: string; provider: ProviderId; model: string }) => void;
  onCancel: () => void;
}) {
  const { providers } = useStore();
  const [name, setName] = useState(initial ? initial.name : "");
  const [provider, setProvider] = useState<ProviderId>(
    initial ? initial.provider : (providers[0]?.id ?? "claude"),
  );
  const models = providerInfo(providers, provider).models;
  const [model, setModel] = useState(initial ? initial.model : (models[0] ?? ""));

  useEffect(() => {
    if (!models.includes(model)) setModel(models[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  return (
    <div className="cfg">
      <div className="cfg-row">
        <label className="cfg-label">Runner name</label>
        <input
          className="qx-input"
          value={name}
          placeholder="runner-10"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="cfg-row">
        <label className="cfg-label">Provider</label>
        <div className="cfg-prov">
          {providers.map((p) => (
            <button
              key={p.id}
              className={"cfg-prov-btn" + (provider === p.id ? " on" : "")}
              style={provider === p.id ? { borderColor: p.color, color: p.color } : undefined}
              onClick={() => setProvider(p.id)}
            >
              <span style={{ color: p.color }}>{p.glyph}</span> {p.name}
            </button>
          ))}
        </div>
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

export function FleetView() {
  const { fleet, agents, providers, createRunner, updateRunner, deleteRunner } =
    useStore();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const now = Date.now();

  const busyOf = (r: Runner) =>
    agents.find((a) => a.status !== "done" && a.runnerId === r.id);

  return (
    <section className="vw">
      <div className="fleet-head">
        <div className="vw-head">
          <h1>Agent fleet</h1>
          <p>
            {fleet.length} runners configured · Claude, Codex, Gemini, Cursor, Copilot
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
              createRunner(r.provider, r.model, r.name || undefined);
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
                    updateRunner(r.id, { model: u.model, name: u.name || undefined });
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <>
                  <div className="fleet-top">
                    <span className="fleet-prov" style={{ color: p.color }}>
                      {p.glyph}
                    </span>
                    <span className="fleet-rn mono">{r.name}</span>
                    {busy || runnerIsBusy(r, agents) ? (
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
                  </div>
                  <div className="fleet-meta">
                    <span className="fleet-pname">{p.name}</span>
                    <span className="fleet-model mono">{r.model}</span>
                  </div>
                  {busy && <div className="fleet-task">▸ {busy.name}</div>}
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
                      onClick={() => deleteRunner(r.id)}
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
