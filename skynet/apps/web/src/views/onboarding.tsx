// ─── First-run setup ──────────────────────────────────────────────────────
// Shown once for a fresh, empty workspace (App gates on it). Sets the workspace
// up against the REAL backend: name it (local), review the module map (read-only
// — it's defined by .skynet/modules.json in the repo), and configure the fleet
// (creates runners → /api/fleet/runners). No workspace-create API is needed.
// GitHub is deliberately NOT a wizard step — Integrations owns that connect flow
// post-onboarding, so a first-run user never meets it mid-wizard.

import { useEffect, useState } from "react";
import type { ProviderInfo } from "@skynet/shared";
import { useStore } from "../lib/store";
import { operatorHandle, setOnboarded, setOperatorHandle, setWorkspaceName, workspaceName } from "../lib/firstrun";
import { PrimaryButton } from "../components/empty";

const STEPS = ["Workspace", "Module map", "Fleet"];

// Right-column context for each step — the "why" and what happens next, so the
// form column stays focused on the single input the step asks for.
const STEP_NOTES = [
  "Name your team's mission control. Every project, agent, and decision lives under it — you can rename it later.",
  "Read-only here. The map comes from .skynet/modules.json in your repo and powers conflict detection and the allowlist.",
  "Each row becomes an agent you can assign work to — same provider on different models is fine. Agents are auto-named; add, retire, rename, or retune the fleet anytime.",
];

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
  // Prefill from anything a previous setup already saved, so re-running the
  // wizard shows the current values rather than blank fields.
  const [workspace, setWorkspace] = useState(() => workspaceName());
  const [operator, setOperator] = useState(() => operatorHandle());
  // The fleet to stand up: one row per agent (provider + model). Multiple rows
  // may share a provider on different models. Seeded with one row on the first
  // credentialed provider once the catalog is available.
  const [fleetRows, setFleetRows] = useState<{ provider: string; model: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const firstReadyProvider = (): ProviderInfo | undefined =>
    store.providers.find((p) => p.available !== false) ?? store.providers[0];

  // Seed a first agent row once the provider catalog has loaded (onboarding only
  // renders when the store is loaded, so this normally fires on mount).
  useEffect(() => {
    if (fleetRows.length > 0) return;
    const p = firstReadyProvider();
    if (p) setFleetRows([{ provider: p.id, model: p.models[0] ?? "" }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.providers]);

  const valid = [
    workspace.trim().length > 0,
    true,
    fleetRows.length > 0 && fleetRows.every((r) => r.model),
  ];
  const last = step === STEPS.length - 1;
  const canNext = valid[step];

  const finish = async () => {
    setBusy(true);
    try {
      setWorkspaceName(workspace.trim());
      setOperatorHandle(operator.trim());
      // Stand up the fleet: one runner per row. Names are auto-assigned
      // server-side (<provider>-<name>); the operator renames later in Fleet.
      for (const row of fleetRows) {
        if (row.model) await store.createAgent(row.provider, row.model);
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
  const patchRow = (i: number, patch: Partial<{ provider: string; model: string }>) =>
    setFleetRows((rows) =>
      rows.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r, ...patch };
        // Switching provider resets the model to that provider's first offering.
        if (patch.provider && patch.provider !== r.provider) {
          next.model = store.providers.find((p) => p.id === patch.provider)?.models[0] ?? "";
        }
        return next;
      }),
    );
  const addRow = () => {
    const p = firstReadyProvider();
    if (p) setFleetRows((rows) => [...rows, { provider: p.id, model: p.models[0] ?? "" }]);
  };
  const removeRow = (i: number) => setFleetRows((rows) => rows.filter((_, j) => j !== i));

  const skip = () => {
    setOnboarded();
    onDone();
  };

  // Blocked-CTA reason for the current step — shown directly beneath the primary
  // button at readable contrast, never a faint hint parked elsewhere.
  const blockReason = !canNext
    ? step === 0
      ? "Enter a workspace name to continue."
      : step === STEPS.length - 1
        ? "Select at least one provider to start your fleet."
        : undefined
    : undefined;

  return (
    <div className="ob">
      <div className="ob-layout">
        <aside className="ob-aside">
          <Mark />
          <div className="ob-aside-title">Set up Skynet</div>
          <ol className="ob-steplist">
            {STEPS.map((s, i) => (
              <li
                key={s}
                className={"ob-steplist-item" + (i === step ? " on" : i < step ? " done" : "")}
              >
                <span className="ob-steplist-num">{i < step ? "✓" : i + 1}</span>
                <span className="ob-steplist-label">{s}</span>
              </li>
            ))}
          </ol>
          <p className="ob-aside-note">{STEP_NOTES[step]}</p>
        </aside>
        <div className="ob-card">
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

        {step === 2 && (
          <>
            <h1 className="ob-h">Configure your fleet</h1>
            <p className="ob-sub">Add the agents Skynet can spin up — a provider and model each. Add several (even the same provider on different models); rename, retire, or tune them anytime in Fleet.</p>
            <div className="ob-fleet-rows">
              {fleetRows.map((row, i) => {
                const info = store.providers.find((p) => p.id === row.provider);
                const models = info?.models ?? [];
                return (
                  <div key={i} className="ob-fleet-row">
                    <span className="ob-fleet-glyph" style={{ color: info?.color }}>{info?.glyph ?? "◆"}</span>
                    <select className="ob-fleet-select" value={row.provider} onChange={(e) => patchRow(i, { provider: e.target.value })}>
                      {store.providers.map((p) => (
                        <option key={p.id} value={p.id} disabled={p.available === false}>
                          {p.name}{p.available === false ? " — no credential" : ""}
                        </option>
                      ))}
                    </select>
                    <select className="ob-fleet-select" value={row.model} onChange={(e) => patchRow(i, { model: e.target.value })} disabled={models.length === 0}>
                      {models.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <button className="ob-fleet-del" title="Remove agent" onClick={() => removeRow(i)}>×</button>
                  </div>
                );
              })}
              <button className="ob-fleet-add" onClick={addRow} disabled={!firstReadyProvider()}>+ Add agent</button>
            </div>
            {fleetRows.length > 0 && (
              <div className="ob-hint" style={{ textAlign: "center" }}>
                Starts your fleet with {fleetRows.length} agent{fleetRows.length === 1 ? "" : "s"} · auto-named like claude-ada (rename anytime in Fleet).
              </div>
            )}
          </>
        )}

        <div className="ob-nav">
          {step > 0 && <button className="btn btn-ghost" onClick={() => setStep((s) => Math.max(0, s - 1))}>← Back</button>}
          <span className="ob-spacer" />
          <PrimaryButton align="end" disabled={!canNext || busy} reason={blockReason} onClick={next}>
            {last ? (busy ? "Setting up…" : "Enter Skynet →") : "Continue →"}
          </PrimaryButton>
        </div>
        {step === 0 && <button className="ob-skip" onClick={skip}>Skip setup</button>}
        </div>
      </div>
    </div>
  );
}
