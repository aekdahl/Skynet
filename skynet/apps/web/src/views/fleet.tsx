import { useEffect, useRef, useState } from "react";
import type { ProviderId, ProviderInfo, Agent, SecretMeta } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { providerInfo, providerReadiness, runnerIdleLabel, runnerIsBusy } from "../lib/derive";

export function ConfigForm({
  initial,
  onSave,
  onCancel,
  submitLabel,
}: {
  initial?: Agent;
  onSave: (r: { name: string; provider: ProviderId; model: string; credentialId?: string }) => void;
  onCancel: () => void;
  // Overrides the submit label. Defaults by mode: editing → "Save changes",
  // new → "Add to fleet". Cloning passes its own (it creates, not edits).
  submitLabel?: string;
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
  // Custom-model mode: the operator typed a model id not in the suggestions —
  // e.g. one released after this catalog. Starts on when editing an agent whose
  // model isn't a known suggestion, or when a provider offers none.
  const [custom, setCustom] = useState(
    initial ? !models.includes(initial.model) : models.length === 0,
  );

  // Which credential a NEW agent authenticates with. Only offered at create time
  // (an existing agent's credential is fixed); undefined → the provider's default
  // key. We fetch the credential list so a provider with a second ("another
  // account") key can be picked here.
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [credentialId, setCredentialId] = useState<string | undefined>(undefined);
  useEffect(() => {
    api.fetchSecrets().then((r) => setSecrets(r.secrets)).catch(() => setSecrets([]));
  }, []);
  const extraCreds = secrets.filter((s) => s.provider === provider && !s.isDefault);

  // Reset the model to the new provider's default when the provider CHANGES (but
  // never on first mount — that would clobber an existing agent's model).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setModel(models[0] ?? "");
    setCustom(models.length === 0);
    setCredentialId(undefined); // a new provider → back to its default key
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
              className={"cfg-model-btn" + (!custom && model === m ? " on" : "")}
              onClick={() => {
                setCustom(false);
                setModel(m);
              }}
            >
              {m}
            </button>
          ))}
          <button
            className={"cfg-model-btn" + (custom ? " on" : "")}
            title="Use a model that isn't listed yet — e.g. one released after this build. The provider's CLI/SDK validates it."
            onClick={() => {
              setCustom(true);
              setModel("");
            }}
          >
            + Custom…
          </button>
        </div>
        {custom && (
          <input
            className="qx-input cfg-model-custom"
            autoFocus
            placeholder="model id — e.g. claude-opus-4-9 · gpt-5.3-codex · gemini-3-ultra"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
        {custom && model.trim() && !models.includes(model.trim()) && (
          <p className="cfg-model-note">
            Custom model — Skynet won’t verify this; {selected.name} accepts it or the run fails loudly.
          </p>
        )}
      </div>
      {/* Credential picker — only when creating and the provider has more than
          its default key (a second account/key added in Settings). */}
      {!initial && extraCreds.length > 0 && (
        <div className="cfg-row">
          <label className="cfg-label">Key</label>
          <select
            className="qx-input cfg-cred-select"
            value={credentialId ?? ""}
            onChange={(e) => setCredentialId(e.target.value || undefined)}
          >
            <option value="">Default {selected.name} key</option>
            {extraCreds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || "key"} · ····{c.last4}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="qx-row">
        <button
          className="btn btn-primary"
          disabled={!model.trim()}
          onClick={() => onSave({ name: name.trim(), provider, model: model.trim(), credentialId })}
        >
          {submitLabel ?? (initial ? "Save changes" : "Add to fleet")}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Suggest a fresh name for a cloned agent: bump a trailing number
// ("claude-agent-01" → "claude-agent-02"), else append "-copy", skipping names
// already taken so the duplicate reads as its own agent at a glance.
export function suggestCloneName(base: string, taken: Set<string>): string {
  const m = base.match(/^(.*?)(\d+)$/);
  if (m) {
    const prefix = m[1]!;
    const width = m[2]!.length;
    for (let n = parseInt(m[2]!, 10) + 1; n < 100000; n++) {
      const cand = prefix + String(n).padStart(width, "0");
      if (!taken.has(cand)) return cand;
    }
  }
  let cand = `${base}-copy`;
  for (let i = 2; taken.has(cand); i++) cand = `${base}-copy-${i}`;
  return cand;
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
  // The agent being duplicated: opens the same form pre-filled with its provider
  // + model + credential (no history), so the operator only names the copy.
  const [cloneFrom, setCloneFrom] = useState<Agent | null>(null);
  const now = Date.now();
  const takenNames = new Set(fleet.map((a) => a.name));

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
            setCloneFrom(null);
          }}
        >
          + Configure agent
        </button>
      </div>
      {(adding || cloneFrom) && (
        <div className="panel cfg-panel">
          <div className="panel-head">{cloneFrom ? `DUPLICATE · ${cloneFrom.name}` : "NEW AGENT"}</div>
          <ConfigForm
            // Remount when the source changes so the form re-seeds from `initial`.
            key={cloneFrom ? "clone-" + cloneFrom.id : "new"}
            initial={cloneFrom ? { ...cloneFrom, name: suggestCloneName(cloneFrom.name, takenNames) } : undefined}
            submitLabel={cloneFrom ? "Add to fleet" : undefined}
            onSave={(r) => {
              createAgent(r.provider, r.model, r.name || undefined, cloneFrom?.credentialId ?? undefined);
              setAdding(false);
              setCloneFrom(null);
            }}
            onCancel={() => {
              setAdding(false);
              setCloneFrom(null);
            }}
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
                        setCloneFrom(null);
                      }}
                    >
                      Configure
                    </button>
                    <button
                      className="btn btn-ghost"
                      title="Duplicate — create a new agent with the same provider & model (no history); you name it"
                      onClick={() => {
                        setCloneFrom(r);
                        setAdding(false);
                        setEditing(null);
                      }}
                    >
                      Duplicate
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
