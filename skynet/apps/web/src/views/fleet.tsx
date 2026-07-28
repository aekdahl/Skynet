import { useEffect, useState } from "react";
import type { ProviderId, ProviderInfo, Agent, SecretMeta } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { providerInfo, providerReadiness, runnerIdleLabel, runnerIsBusy } from "../lib/derive";

export function ConfigForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Agent;
  onSave: (r: { name: string; provider: ProviderId; model: string; credentialId?: string }) => void;
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
  // Named credentials for the picker (default + any "duplicates" of the provider).
  const [creds, setCreds] = useState<SecretMeta[]>([]);
  const [credentialId, setCredentialId] = useState<string>(initial?.credentialId ?? "");

  useEffect(() => {
    void api.fetchSecrets().then((r) => setCreds(r.secrets)).catch(() => setCreds([]));
  }, []);

  useEffect(() => {
    if (!models.includes(model)) setModel(models[0] ?? "");
    setCredentialId(""); // a credential belongs to one provider — reset on switch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // Named credentials for the selected provider (the default is the "" option).
  const namedCreds = creds.filter((c) => c.provider === provider && !c.isDefault);

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
      {namedCreds.length > 0 && (
        <div className="cfg-row">
          <label className="cfg-label">Credential</label>
          <select
            className="qx-input cfg-cred"
            value={credentialId}
            onChange={(e) => setCredentialId(e.target.value)}
          >
            <option value="">Default {selected.name} key</option>
            {namedCreds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ····{c.last4}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="qx-row">
        <button
          className="btn btn-primary"
          onClick={() => onSave({ name: name.trim(), provider, model, credentialId: credentialId || undefined })}
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

export function FleetView({
  onOpenTask,
  onOpenAgent,
}: {
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
}) {
  const { fleet, runs, providers, createAgent, updateAgent, deleteAgent } =
    useStore();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const now = Date.now();

  const taskCountOf = (r: Agent) => runs.filter((a) => a.agentId === r.id).length;

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
              createAgent(r.provider, r.model, r.name || undefined, r.credentialId);
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
                    const count = taskCountOf(r);
                    return (
                      <>
                        <button
                          className="fleet-cardhead"
                          title="Open this agent's detail & task history"
                          onClick={() => onOpenAgent(r.id)}
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
                            <span className="fleet-caret" aria-hidden="true">›</span>
                          </div>
                          <div className="fleet-meta">
                            <span className="fleet-pname">{p.name}</span>
                            <span className="fleet-model mono">{r.model}</span>
                            <span className="fleet-histcount">
                              {count} task{count === 1 ? "" : "s"}
                            </span>
                          </div>
                        </button>

                        {/* Busy: keep the current task glanceable + one-click into it. */}
                        {busy && (
                          <button
                            className="fleet-task fleet-task-link"
                            onClick={() => onOpenTask(busy.id)}
                            title="Open this agent's live activity"
                          >
                            <span className="fleet-task-name">▸ {busy.name}</span>
                            <span className="fleet-task-cta">activity →</span>
                          </button>
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
