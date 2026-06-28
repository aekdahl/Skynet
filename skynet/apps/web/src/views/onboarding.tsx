// ─── First-run setup ──────────────────────────────────────────────────────
// Shown once for a fresh, empty workspace (App gates on it). Sets the workspace
// up against the REAL backend: name it (local), connect GitHub (reuses the
// Integrations connect flow → /api/github), review the module map (read-only —
// it's defined by .skynet/modules.json in the repo), and configure the fleet
// (creates runners → /api/fleet/runners). No workspace-create API is needed.

import { useEffect, useState } from "react";
import type { GithubConnection, GithubRepo, ProviderInfo } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { setOnboarded, setWorkspaceName } from "../lib/firstrun";
import { GithubConnect, emptyConnection } from "./integrations";

const STEPS = ["Workspace", "GitHub", "Module map", "Fleet"];

function Mark() {
  return (
    <svg className="ob-mark" width="44" height="44" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="1" y="1" width="16" height="16" rx="4" fill="var(--accent)" />
      <text x="9" y="9.6" textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-ui)" fontWeight="700" fontSize="11" fill="var(--bg)">
        S
      </text>
    </svg>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const store = useStore();
  const [step, setStep] = useState(0);
  const [workspace, setWorkspace] = useState("");
  const [operator, setOperator] = useState("");
  const [providers, setProviders] = useState<string[]>(["claude"]);
  const [github, setGithub] = useState<GithubConnection>(emptyConnection);
  const [busy, setBusy] = useState(false);

  // Load any existing GitHub connection so the connect step reflects reality.
  useEffect(() => {
    let cancelled = false;
    api.fetchGithub().then(({ connection }) => !cancelled && setGithub(connection)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const valid = [workspace.trim().length > 0, true, true, providers.length > 0];
  const last = step === STEPS.length - 1;
  const canNext = valid[step];

  const onConnected = async (installation: GithubConnection["installation"], repos: GithubRepo[]) => {
    if (!installation) return;
    setGithub(await api.connectGithub({ installation, repos }));
  };
  const onDisconnect = async () => {
    await api.disconnectGithub();
    setGithub(emptyConnection());
  };

  const finish = async () => {
    setBusy(true);
    try {
      setWorkspaceName(workspace.trim());
      // Stand up the fleet: one runner per selected provider, on its first model.
      const catalog = store.providers;
      for (const id of providers) {
        const info = catalog.find((p) => p.id === id);
        const model = info?.models[0] ?? "";
        if (model) await store.createRunner(id, model);
      }
      setOnboarded();
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (!canNext) return;
    if (last) void finish();
    else setStep((s) => s + 1);
  };
  const toggleProv = (id: string) =>
    setProviders((ps) => (ps.includes(id) ? ps.filter((p) => p !== id) : [...ps, id]));

  const skip = () => {
    setOnboarded();
    onDone();
  };

  return (
    <div className="ob">
      <div className="ob-card">
        <Mark />
        <div className="ob-progress">
          {STEPS.map((_, i) => (
            <span key={i} className={"ob-pip" + (i === step ? " on" : i < step ? " done" : "")} />
          ))}
        </div>
        <div className="ob-step-tag">
          Step {step + 1} of {STEPS.length} · {STEPS[step]}
        </div>

        {step === 0 && (
          <>
            <h1 className="ob-h">Set up your workspace</h1>
            <p className="ob-sub">This workspace is your team's mission control — every project, agent, and decision lives here.</p>
            <div className="ob-field">
              <label className="ob-label">Workspace name</label>
              <input className="qx-input" autoFocus placeholder="e.g. Acme Engineering" value={workspace}
                onChange={(e) => setWorkspace(e.target.value)} onKeyDown={(e) => e.key === "Enter" && next()} />
            </div>
            <div className="ob-field">
              <label className="ob-label">Your operator handle <span style={{ color: "var(--faint)" }}>(optional)</span></label>
              <input className="qx-input" placeholder="e.g. jordan" value={operator}
                onChange={(e) => setOperator(e.target.value)} onKeyDown={(e) => e.key === "Enter" && next()} />
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="ob-h">Connect GitHub</h1>
            <p className="ob-sub">Install the Skynet App on the repos your fleet will work in — agents branch, push, and open PRs through least-privilege tokens. You can also do this later from Integrations.</p>
            <GithubConnect github={github} onConnected={onConnected} onDisconnect={onDisconnect} />
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="ob-h">Your module map</h1>
            <p className="ob-sub">
              Skynet shows your codebase as modules, not file paths. This map is defined by{" "}
              <span className="mono">.skynet/modules.json</span> in your repo and powers conflict detection &amp; the allowlist.
            </p>
            <div className="gh-card">
              {store.modules.length > 0 ? (
                <div className="ob-mods">
                  {store.modules.map((m) => (
                    <span key={m.id} className="ob-mod-chip mono">{m.name}</span>
                  ))}
                </div>
              ) : (
                <p className="rp-note">No module map yet — Skynet falls back to a sensible default catalog until <span className="mono">.skynet/modules.json</span> is committed.</p>
              )}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1 className="ob-h">Configure your fleet</h1>
            <p className="ob-sub">Pick the agent providers Skynet can spin up. Each becomes a runner; add, retire, or tune them anytime in Fleet.</p>
            <div className="ob-prov-grid">
              {store.providers.map((p: ProviderInfo) => {
                const on = providers.includes(p.id);
                const disabled = p.available === false;
                return (
                  <button key={p.id} className={"ob-prov" + (on ? " on" : "")} disabled={disabled}
                    style={on ? { borderColor: p.color } : undefined} onClick={() => toggleProv(p.id)}>
                    <span className="ob-prov-glyph" style={{ color: p.color }}>{p.glyph}</span>
                    <span>
                      {p.name}
                      <span className="ob-prov-models">{disabled ? "no credential" : p.models[0]}</span>
                    </span>
                    <span className="ob-prov-check">✓</span>
                  </button>
                );
              })}
            </div>
            <div className="ob-hint" style={{ textAlign: "center" }}>
              {providers.length === 0 ? "Select at least one provider." : `Starts your fleet with ${providers.length} runner${providers.length === 1 ? "" : "s"}.`}
            </div>
          </>
        )}

        <div className="ob-nav">
          {step > 0 && <button className="btn btn-ghost" onClick={() => setStep((s) => Math.max(0, s - 1))}>← Back</button>}
          <span className="ob-spacer" />
          <button className="btn btn-primary" disabled={!canNext || busy} onClick={next}>
            {last ? (busy ? "Setting up…" : "Enter Skynet →") : "Continue →"}
          </button>
        </div>
        {step === 0 && <button className="ob-skip" onClick={skip}>Skip setup</button>}
      </div>
    </div>
  );
}
