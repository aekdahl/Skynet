import { useCallback, useEffect, useState } from "react";
import type {
  EndpointSmokeResult,
  SecretMeta,
  WorkspaceSettings,
  UpdateWorkspaceSettingsRequest,
  CommandPolicy,
  PolicyRule,
  PolicyVersion,
  PolicyDryRunResult,
  PolicyDecision,
  PolicyRuleKind,
  Risk,
} from "@skynet/shared";
import { COMPATIBLE_VENDORS } from "@skynet/shared";
import { useStore } from "../lib/store";
import { toast } from "../components/toast";
import * as api from "../lib/client";
import type { McpScope, ServiceTokenMeta } from "../lib/client";
import { InstallControls } from "../components/install-controls";
import { Blocked } from "../components/empty";
import { fmtWait, providerReadiness } from "../lib/derive";

// A key's live-verify result, keyed by credential id (provider id for a
// default credential, `cred-…` for a named one). "Guided provider connect"'s
// missing half: key entry already worked, this proves the key actually
// authenticates instead of just being present.
export type VerifyState = { status: "verifying" } | { status: "ok"; message?: string } | { status: "fail"; message?: string };

/**
 * Results of a real probe run against a credential's endpoint. Renders the
 * checks rather than a single verdict, because "it works" is the wrong shape of
 * answer here: a vendor can authenticate fine and still never emit a tool call,
 * which would leave every approval, question and escalation silently dead.
 * Non-critical gaps are shown but don't fail the run.
 */
function SmokeResults({ result }: { result: EndpointSmokeResult }) {
  const mark = (s: string) => (s === "pass" ? "✓" : s === "fail" ? "✕" : "–");
  return (
    <div className={"smoke" + (result.ok ? "" : " smoke-bad")}>
      <div className="smoke-head">
        <span className={"smoke-verdict " + (result.ok ? "ok" : "bad")}>
          {result.ok ? "Usable" : "Not usable"}
        </span>
        <span className="smoke-sub mono">
          {result.vendor ?? "Anthropic"} · {result.model} · {(result.durationMs / 1000).toFixed(1)}s
          {result.costUsd != null && ` · $${result.costUsd.toFixed(4)}`}
        </span>
      </div>
      <ul className="smoke-checks">
        {result.checks.map((c) => (
          <li key={c.id} className={"smoke-check smoke-" + c.status}>
            <span className="smoke-mark">{mark(c.status)}</span>
            <span className="smoke-label">
              {c.label}
              {c.status === "fail" && c.critical && <span className="smoke-req"> required</span>}
              {c.detail && <span className="smoke-detail"> — {c.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      {result.caveat && <p className="smoke-caveat">⚠ {result.caveat}</p>}
    </div>
  );
}

export function VerifyBadge({ state, onDismiss }: { state: VerifyState | undefined; onDismiss?: () => void }) {
  if (!state) return null;
  if (state.status === "verifying") {
    return <span className="settings-verify settings-verify-pending mono">⟳ verifying…</span>;
  }
  if (state.status === "ok") {
    return <span className="settings-verify settings-verify-ok mono">✓ {state.message ?? "verified"}</span>;
  }
  return (
    <span className="settings-verify settings-verify-fail mono">
      ✕ {state.message ?? "verification failed"}
      {onDismiss && (
        <button type="button" className="settings-verify-dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </span>
  );
}

// Provider keys live in the encrypted secret store, scoped to this workspace.
// A vendor's runners are only selectable in create-agent once its key is set
// (the snapshot recomputes provider availability from the secret store).
export function SettingsView({ onRerunSetup }: { onRerunSetup?: () => void }) {
  const { providers, retry, setProviderAvailable, readOnly, elevatedUntil } = useStore();
  // Installer modal state — one at a time; the panel below the provider card
  // renders its live log while running, and locks to that provider until done.
  const [installFor, setInstallFor] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<string>("");
  const [installing, setInstalling] = useState(false);
  const [metas, setMetas] = useState<SecretMeta[] | null>(null);
  const [envSet, setEnvSet] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  // Live-verify result per credential id — cleared on remove, replaced on the
  // next save/rotate for that same id.
  const [verify, setVerify] = useState<Record<string, VerifyState>>({});
  const runVerify = useCallback(async (id: string) => {
    setVerify((v) => ({ ...v, [id]: { status: "verifying" } }));
    try {
      const result = await api.verifyCredential(id);
      setVerify((v) => ({ ...v, [id]: { status: result.ok ? "ok" : "fail", message: result.message } }));
    } catch (e) {
      setVerify((v) => ({ ...v, [id]: { status: "fail", message: (e as Error).message } }));
    }
  }, []);
  // Smoke test — a REAL (tiny) agent run on this credential. Separate from
  // verify on purpose: verify is automatic and free, this costs money and is
  // only ever started by a click.
  const [smoke, setSmoke] = useState<Record<string, { running: boolean; result?: EndpointSmokeResult; error?: string }>>({});
  // Pause/resume a credential. Pausing stops the runs already on it, so it asks
  // for a reason — a benched key with no explanation is unactionable to whoever
  // finds it next week, which is usually not the person who benched it.
  const [busyPause, setBusyPause] = useState<string | null>(null);
  const togglePause = useCallback(async (c: SecretMeta) => {
    setBusyPause(c.id);
    try {
      if (c.paused) {
        await api.resumeCredential(c.id);
        toast(`Resumed — runners on this key can pick up work again.`);
      } else {
        const reason = window.prompt("Why is this key being paused? (shown wherever the pause surfaces)");
        if (!reason?.trim()) return;
        const res = await api.pauseCredential(c.id, reason.trim());
        toast(
          res.haltedRunIds.length
            ? `Paused — stopped ${res.haltedRunIds.length} run${res.haltedRunIds.length === 1 ? "" : "s"} and released their tasks.`
            : "Paused — no runs were active on this key.",
        );
      }
      await load();
    } catch (e) {
      toast(`Couldn't change the pause state: ${(e as Error).message}`);
    } finally {
      setBusyPause(null);
    }
  }, []);
  const runSmoke = useCallback(async (id: string) => {
    setSmoke((s) => ({ ...s, [id]: { running: true } }));
    try {
      const result = await api.smokeTestCredential(id);
      setSmoke((s) => ({ ...s, [id]: { running: false, result } }));
    } catch (e) {
      setSmoke((s) => ({ ...s, [id]: { running: false, error: (e as Error).message } }));
    }
  }, []);
  const dismissVerify = (id: string) =>
    setVerify((v) => {
      if (!(id in v)) return v;
      const next = { ...v };
      delete next[id];
      return next;
    });

  const load = useCallback(async () => {
    try {
      const { secrets, env } = await api.fetchSecrets();
      setMetas(secrets);
      setEnvSet(new Set(env));
    } catch {
      setMetas([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // The DEFAULT credential per provider (id === provider) drives the main card;
  // any extra named credentials (a second key/account) are listed below it.
  const configured = new Map((metas ?? []).filter((m) => m.isDefault).map((m) => [m.provider, m]));
  const extrasFor = (providerId: string) => (metas ?? []).filter((m) => m.provider === providerId && !m.isDefault);

  // Rotate / remove a NAMED credential by its id. Unlike the provider default,
  // these never touch provider availability (the default key still stands).
  const rotateCredential = async (id: string) => {
    const key = (drafts[id] ?? "").trim();
    if (!key) return;
    setBusy(id);
    setErr(null);
    try {
      await api.setSecret(id, key);
      setDrafts((d) => ({ ...d, [id]: "" }));
      await load();
      void runVerify(id);
    } catch (e) {
      setErr(`Couldn't rotate the key: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const removeCredential = async (id: string) => {
    setBusy(id);
    setErr(null);
    try {
      await api.deleteSecret(id);
      dismissVerify(id);
      await load();
    } catch (e) {
      setErr(`Couldn't remove the key: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const save = async (id: string) => {
    const key = (drafts[id] ?? "").trim();
    if (!key) return;
    setBusy(id);
    setErr(null);
    try {
      await api.setSecret(id, key);
      setDrafts((d) => ({ ...d, [id]: "" }));
      setProviderAvailable(id, true);
      await load();
      void runVerify(id);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 501) setDisabled(true);
      else setErr(`Couldn't save the key: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setErr(null);
    try {
      await api.deleteSecret(id);
      dismissVerify(id);
      // Removing the stored key falls back to the env var, if one exists.
      setProviderAvailable(id, envSet.has(id));
      await load();
    } catch (e) {
      setErr(`Couldn't remove the key: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="vw settings">
      <div className="vw-head">
        <h1>Settings</h1>
        <p>
          Provider API keys, stored encrypted on this machine and never shown again.
          A vendor's runs become selectable once its key is set. A key set here
          overrides one from an environment variable; the env key is used as a
          fallback when nothing is set here.
        </p>
        <p>
          Tip: set a spend limit on your key in the provider's console — a safety
          net with autonomy or remote (Telegram) control.
        </p>
      </div>

      {readOnly && (
        <div className="settings-warn">
          You're signed in as a viewer — settings are read-only. Changes below won't save.
        </div>
      )}
      {disabled && (
        <div className="settings-warn">
          The secret store is disabled — no master key is configured. Restart the
          desktop app (it sets one automatically), or set <code>SKYNET_MASTER_KEY</code>
          on a self-hosted server.
        </div>
      )}
      {err && <div className="settings-warn">{err}</div>}

      <div className="settings-list">
        {providers.map((p) => {
          const meta = configured.get(p.id);
          const envBacked = envSet.has(p.id);
          const draft = drafts[p.id] ?? "";
          const req = p.requirements;
          // Drive the readiness badge from the freshly-fetched secret store (this
          // view re-fetches on mount) rather than the snapshot's `available`, so
          // the badge can never contradict the "via Settings ····" pill above it
          // for a key that's actually set. Until secrets load (`metas === null`),
          // fall back to the snapshot.
          const credentialSet = metas ? Boolean(meta) || envBacked : undefined;
          const rd = providerReadiness(p, credentialSet);
          return (
            <div className="settings-row" key={p.id}>
              <div className="settings-prov">
                <span className="settings-glyph" style={{ color: p.color }}>
                  {p.glyph}
                </span>
                <span className="settings-name">{p.name}</span>
                {meta ? (
                  <span className="settings-ok mono">via Settings ····{meta.last4}</span>
                ) : envBacked ? (
                  <span className="settings-env mono">via environment</span>
                ) : (
                  <span className="settings-off mono">not set</span>
                )}
              </div>
              <div className="settings-key">
                <input
                  type="password"
                  className="settings-input"
                  autoComplete="off"
                  placeholder={
                    meta ? "Replace key…" : envBacked ? "Override env key…" : "Paste API key…"
                  }
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && save(p.id)}
                />
                <Blocked disabled={!draft.trim()} reason={!draft.trim() ? "Paste a key to continue." : undefined}>
                  <button
                    className="btn btn-primary"
                    disabled={busy === p.id || !draft.trim()}
                    onClick={() => save(p.id)}
                  >
                    {meta ? "Replace" : envBacked ? "Override" : "Save"}
                  </button>
                </Blocked>
                {meta && (
                  <button
                    className="btn btn-ghost"
                    disabled={busy === p.id}
                    onClick={() => remove(p.id)}
                  >
                    Remove
                  </button>
                )}
              </div>
              <VerifyBadge state={verify[p.id]} onDismiss={() => dismissVerify(p.id)} />
              {req && (
                <div className="settings-req">
                  <span className={"settings-badge " + (rd.ready ? "ok" : "warn")}>
                    {rd.ready ? "Ready to run" : `Needs ${rd.missing.join(" and ")}`}
                  </span>
                  <span className="settings-req-detail">
                    {req.runtime === "cli" ? (
                      <>
                        Runtime: <code>{req.bin}</code> CLI
                        {p.binOnPath === true ? " — ✓ found on PATH" : " — not found on PATH"}
                      </>
                    ) : (
                      // SDK providers run the agent as a Node import (no
                      // subprocess) — that's the desired state, not a
                      // limitation. Read as "all good", complete with a
                      // checkmark so it doesn't look like something's missing.
                      <>Runtime: SDK — ✓ runs in-process (no CLI needed)</>
                    )}
                    {" · "}
                    {req.cliLogin ? (
                      <>Auth: CLI login or a key</>
                    ) : req.authEnvVars.length > 0 ? (
                      <>
                        Auth: <code>{req.authEnvVars.slice(0, 3).join(" / ")}</code>
                      </>
                    ) : (
                      <>Auth: —</>
                    )}
                  </span>
                  {req.installHint && (
                    <span className="settings-req-hint">
                      {req.installHint}
                      {req.docsUrl && (
                        <>
                          {" "}
                          <a href={req.docsUrl} target="_blank" rel="noreferrer">
                            Docs ↗
                          </a>
                        </>
                      )}
                    </span>
                  )}
                  {/* Install-from-app: only when the CLI runtime is expected,
                      the binary isn't on PATH, and the provider has a
                      scriptable install command (npm today). The button shows
                      the EXACT command it will run so nothing runs silently. */}
                  {req.runtime === "cli" && p.binOnPath === false && req.install && (
                    installFor === p.id ? (
                      <div className="settings-install-live">
                        <pre className="settings-install-log">{installLog || "starting…"}</pre>
                        {!installing && (
                          <div className="settings-install-actions">
                            <button className="btn btn-ghost btn-sm" onClick={() => { setInstallFor(null); setInstallLog(""); }}>
                              Close
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="settings-install-cta">
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={installing}
                          title={`Runs: ${req.install.command}`}
                          onClick={async () => {
                            setInstallFor(p.id);
                            setInstallLog("");
                            setInstalling(true);
                            try {
                              await api.streamInstallProvider(p.id, (chunk) => setInstallLog((s) => s + chunk));
                            } catch (e) {
                              setInstallLog((s) => s + `\n[error] ${(e as Error).message}\n`);
                            } finally {
                              setInstalling(false);
                              // Re-pull the snapshot so the re-probed binOnPath lands
                              // and the readiness badge updates automatically.
                              retry();
                            }
                          }}
                        >
                          ↓ Install CLI
                        </button>
                        <code className="settings-install-cmd">{req.install.command}</code>
                      </div>
                    )
                  )}
                </div>
              )}

              {/* Extra named credentials — a second key for this provider (e.g.
                  another account). Each rotates / removes independently; agents
                  pick one in the Configure-agent form. */}
              {extrasFor(p.id).map((c) => (
                <div className="settings-cred" key={c.id}>
                  <span className="settings-cred-name">
                    {c.name || "key"} <span className="mono settings-cred-last4">····{c.last4}</span>
                    {/* Where this credential's traffic actually goes. Shown in
                        plain text on purpose — "which model am I billing" must
                        be answerable without opening anything. */}
                    {c.baseUrl && <> · <span className="settings-cred-ep" title={c.baseUrl}>{c.baseUrl.replace(/^https?:\/\//, "")}</span></>}
                    {c.paused && (
                      <span className="settings-cred-paused" title={`Paused by ${c.paused.by}: ${c.paused.reason}`}>
                        ⏸ paused — {c.paused.reason}
                      </span>
                    )}
                  </span>
                  <div className="settings-key">
                    <input
                      type="password"
                      className="settings-input"
                      autoComplete="off"
                      placeholder="Rotate this key…"
                      value={drafts[c.id] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                      onKeyDown={(e) => e.key === "Enter" && rotateCredential(c.id)}
                    />
                    <Blocked disabled={!(drafts[c.id] ?? "").trim()} reason={!(drafts[c.id] ?? "").trim() ? "Paste a new key to continue." : undefined}>
                      <button className="btn btn-primary" disabled={busy === c.id || !(drafts[c.id] ?? "").trim()} onClick={() => rotateCredential(c.id)}>
                        Rotate
                      </button>
                    </Blocked>
                    <button
                      className="btn btn-ghost"
                      title="Run one tiny real task on this credential and report what the endpoint actually supports. Costs a fraction of a cent."
                      disabled={smoke[c.id]?.running}
                      onClick={() => runSmoke(c.id)}
                    >
                      {smoke[c.id]?.running ? "Testing…" : "Test"}
                    </button>
                    <button
                      className={"btn btn-ghost" + (c.paused ? " btn-lit" : "")}
                      title={
                        c.paused
                          ? "Put this key back to work — its runners become eligible for new tasks again."
                          : "Bench this key: stop every run using it (their tasks return to To do) and give it no new work until resumed."
                      }
                      disabled={busyPause === c.id}
                      onClick={() => togglePause(c)}
                    >
                      {busyPause === c.id ? "…" : c.paused ? "Resume" : "Pause"}
                    </button>
                    <button className="btn btn-ghost" disabled={busy === c.id} onClick={() => removeCredential(c.id)}>
                      Remove
                    </button>
                  </div>
                  <VerifyBadge state={verify[c.id]} onDismiss={() => dismissVerify(c.id)} />
                  {smoke[c.id]?.error && <div className="settings-warn">Couldn't run the test: {smoke[c.id]!.error}</div>}
                  {smoke[c.id]?.result && <SmokeResults result={smoke[c.id]!.result!} />}
                </div>
              ))}
              <AddCredentialForm provider={p.id} providerName={p.name} onAdded={load} onVerify={runVerify} />
            </div>
          );
        })}
      </div>

      <FleetAutomationSection />
      <CommandPolicySection />
      <McpAccessSection />
      {/* A genuine base admin only — never a currently-elevated viewer (their
          scopes look identical, but the server independently enforces the
          real check on the grant route too; this is just UX, not the gate). */}
      {!readOnly && !elevatedUntil && <AdminPromotionSection />}
      <TelegramSetup />
      <AdvancedSettingsSection />
      <div className="settings-setup">
        <div className="settings-setup-text">
          <div className="settings-setup-title">App</div>
          <div className="settings-setup-sub">
            Install Skynet as an app and get Inbox alerts when an agent needs you.
          </div>
        </div>
        <InstallControls />
      </div>

      {onRerunSetup && (
        <div className="settings-setup">
          <div className="settings-setup-text">
            <div className="settings-setup-title">First-time setup</div>
            <div className="settings-setup-sub">
              Re-run the onboarding wizard (name the workspace, add a fleet runner).
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onRerunSetup}>
            Run setup again
          </button>
        </div>
      )}
    </section>
  );
}

// "Add another key" for a provider — a named credential (a second account/key).
// Collapsed to a link until used, so the provider card stays tidy when there's
// just the one key. On success it re-fetches the secret list (onAdded).
function AddCredentialForm({
  provider,
  providerName,
  onAdded,
  onVerify,
}: {
  provider: string;
  providerName: string;
  onAdded: () => Promise<void>;
  // Kicks off the same live verify as the main provider row; the new
  // credential's row (rendered from the reloaded list below) picks up its
  // spinner → pass/fail via the shared verify state, so the form itself
  // doesn't need to track it.
  onVerify: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  // Vendor preset drives the endpoint. "" = Anthropic's own API (the default),
  // "custom" = type any URL. These base URLs are genuinely easy to get wrong —
  // Z.ai doubles the `api` segment, MiniMax splits .io/.com by region — so
  // picking beats typing.
  const [vendorId, setVendorId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const vendor = COMPATIBLE_VENDORS.find((v) => v.id === vendorId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Only the Claude runner acts on a compatible endpoint — it's the one path
  // that drives the Agent SDK, and so the one that keeps the full agent loop
  // (tool gating, question/escalation HITL, per-model cost metering) when
  // pointed at a cheaper model. Offering the field for a CLI-backed provider
  // would promise something that silently does nothing.
  const supportsEndpoint = provider === "claude";

  // A preset supplies its own URL; only "custom" reads the free-text box.
  const effectiveEndpoint = () => (vendorId === "custom" ? endpoint.trim() : (vendor?.baseUrl ?? ""));

  const add = async () => {
    if (!name.trim() || !key.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { secret } = await api.createCredential(provider, name.trim(), key.trim(), effectiveEndpoint() || null);
      setName("");
      setKey("");
      setVendorId("");
      setEndpoint("");
      setOpen(false);
      await onAdded();
      onVerify(secret.id);
    } catch (e) {
      setErr(e instanceof api.ApiError && e.status === 501 ? "The secret store is disabled — no master key configured." : `Couldn't add the key: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn-ghost btn-sm settings-cred-add" onClick={() => setOpen(true)}>
        + Add another {providerName} key
      </button>
    );
  }
  return (
    <div className="settings-cred settings-cred-new">
      <input
        className="settings-input settings-cred-nameinput"
        placeholder="Name — e.g. personal, work-org"
        maxLength={60}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {supportsEndpoint && (
        <>
          <select
            className="settings-input settings-cred-vendor"
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
          >
            <option value="">Anthropic — the standard API</option>
            {COMPATIBLE_VENDORS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
            <option value="custom">Custom endpoint…</option>
          </select>
          {vendorId === "custom" && (
            <input
              className="settings-input settings-cred-endpoint mono"
              placeholder="https://… — any Claude-compatible endpoint"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          )}
          {vendor && (
            <div className="settings-vendor">
              <div className="settings-vendor-url mono">{vendor.baseUrl}</div>
              {/* Rates are the reason to be here, so they're shown before the
                  operator commits — including where a "cheap" option isn't. */}
              <table className="settings-rates">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Cache read</th>
                  </tr>
                </thead>
                <tbody>
                  {vendor.models.map((m) => (
                    <tr key={m.id}>
                      <td className="mono">
                        {m.id}
                        {m.note && <span className="settings-rate-note"> — {m.note}</span>}
                      </td>
                      <td>{m.rates ? `$${m.rates.inputPerMTok}` : "—"}</td>
                      <td>{m.rates ? `$${m.rates.outputPerMTok}` : "—"}</td>
                      <td>{m.rates?.cacheReadPerMTok != null ? `$${m.rates.cacheReadPerMTok}` : "—"}</td>
                    </tr>
                  ))}
                  <tr className="settings-rate-base">
                    <td className="mono">Anthropic Sonnet — today's baseline</td>
                    <td>$3</td>
                    <td>$15</td>
                    <td>$0.30</td>
                  </tr>
                </tbody>
              </table>
              <p className="settings-rate-foot">Per million tokens, list price as of Aug 2026. Verify against the vendor before relying on them.</p>
              {vendor.caveat && <p className="settings-vendor-caveat">⚠ {vendor.caveat}</p>}
            </div>
          )}
          <p className="settings-hint">
            A key on a compatible endpoint runs the <em>full</em> agent loop — tool gating, questions and
            escalations, real cost metering. Set the runner's model to one of the ids above in Fleet, then pin
            it to this credential to mix cheap and expensive models across one fleet.
          </p>
        </>
      )}
      <div className="settings-key">
        <input
          type="password"
          className="settings-input"
          autoComplete="off"
          placeholder="API key…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <Blocked
          disabled={!name.trim() || !key.trim()}
          reason={!name.trim() ? "Name the key to continue." : !key.trim() ? "Paste the key to continue." : undefined}
        >
          <button className="btn btn-primary" disabled={busy || !name.trim() || !key.trim()} onClick={add}>
            Add key
          </button>
        </Blocked>
        <button className="btn btn-ghost" disabled={busy} onClick={() => { setOpen(false); setName(""); setKey(""); setVendorId(""); setEndpoint(""); setErr(null); }}>
          Cancel
        </button>
      </div>
      {err && <div className="settings-warn">{err}</div>}
    </div>
  );
}

// ─── Remote control · Telegram ──────────────────────────────────────────────
// In-app setup guide for the outbound-only Telegram bridge (BYO bot). Config
// lives in the desktop app's <userData>/skynet.env, so this is instructional —
// it doesn't hold the token. Collapsed by default to keep Settings tidy.
function TelegramSetup() {
  const [open, setOpen] = useState(false);
  return (
    <div className="settings-setup tg-setup">
      <button className="tg-setup-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="tg-caret">{open ? "▾" : "▸"}</span>
        <div className="settings-setup-text">
          <div className="settings-setup-title">Remote control · Telegram</div>
          <div className="settings-setup-sub">
            Get gate alerts and control the fleet from your phone — including a remote kill switch.
            Uses your own Telegram bot; the app connects out (no hosting, no open ports).
          </div>
        </div>
      </button>
      {open && (
        <div className="tg-guide">
          <ol className="tg-steps">
            <li>
              <strong>Create a bot.</strong> In Telegram, message <code>@BotFather</code> →{" "}
              <code>/newbot</code> → follow the prompts, then copy the token it gives you.
            </li>
            <li>
              <strong>Get your chat id.</strong> Send your new bot any message, then message{" "}
              <code>@userinfobot</code> — it replies with your numeric id.
            </li>
            <li>
              <strong>Add three lines to <code>skynet.env</code></strong> in the app's data folder
              (<code>~/Library/Application&nbsp;Support/Skynet/</code> on macOS,{" "}
              <code>%APPDATA%\Skynet\</code> on Windows):
              <pre className="tg-env">{`SKYNET_TELEGRAM_BOT_TOKEN=123456:AA…your-token
SKYNET_TELEGRAM_OWNER_CHAT_ID=987654321
SKYNET_TELEGRAM_CONTROL=true   # optional — approve / commands`}</pre>
              The first two enable notifications + the kill switch.{" "}
              <code>SKYNET_TELEGRAM_CONTROL=true</code> also allows approving gates and issuing
              commands from chat (off by default).
            </li>
            <li>
              <strong>Restart Skynet</strong> so it re-reads <code>skynet.env</code>, then message
              your bot <code>/status</code> to confirm it's live.
            </li>
          </ol>

          <div className="tg-cmds">
            <div className="settings-setup-title">Commands</div>
            <ul>
              <li>
                <code>/status</code> · <code>/gates</code> — what's running / open gates
              </li>
              <li>
                <code>/stop</code> — halt all runs + pause autonomy · <code>/resume</code> — re-enable
              </li>
              <li>
                <code>/quit</code> — stop everything and close the app <em>(kill switch)</em>
              </li>
              <li>
                <code>/approve &lt;id&gt;</code> · <code>/reject &lt;id&gt;</code>, or just chat
                naturally (e.g. “approve the payments gate”) — needs control on; every action asks you
                to confirm first
              </li>
            </ul>
          </div>

          <div className="tg-safety">
            <strong>Safety:</strong> only your chat id is honored, and the kill switch never needs the
            control flag. As a passive backstop, set a spend limit on your API key in the provider's
            console.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Fleet auto-scale ───────────────────────────────────────────────────────
// The live workspace fleet policy: auto-provision a runner when a task has none
// free (cloned from a busy one on an allowed key), bounded by a hard cap so it
// can't run away. Live (no restart); the cap applies to EVERY creation path.
function FleetAutomationSection() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A save here is silent by nature (no navigation, no dialog), so without an
  // explicit acknowledgement a successful write is indistinguishable from one
  // that never fired — which is exactly how the blur-only commit below read as
  // "nothing happens when entering it". Flashes briefly after each save.
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    api.fetchWorkspaceSettings().then(setSettings).catch(() => setErr("Couldn't load fleet settings."));
  }, []);
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(0), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  const save = async (patch: UpdateWorkspaceSettingsRequest) => {
    setBusy(true);
    setErr(null);
    try {
      setSettings(await api.updateWorkspaceSettings(patch));
      setSavedAt(Date.now());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const clampMax = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  // These commit on blur. Enter is what an operator actually reaches for after
  // typing a number, and without this it silently did nothing — blurring here
  // routes Enter through the SAME onBlur save rather than duplicating it.
  const commitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  return (
    <div className="settings-setup">
      <div className="settings-setup-text">
        <div className="settings-setup-title">Fleet auto-scale</div>
        <div className="settings-setup-sub">
          Add a runner automatically when a task needs one and none is free — cloned from a busy runner on a key the
          project is allowed to use. <b>Max runners</b> caps how many work <em>at once</em> (default 100; 0 = no cap) —
          it never stops you adding agents to the fleet, and idle ones don’t count against it. Past the cap, tasks
          simply queue until a runner frees up; the Fleet page says so when your roster is larger. Auto-created runners
          are retired again once they’ve sat idle past the timeout below — operator-added runners are never touched.
        </div>
        {err && <div className="settings-warn">{err}</div>}
        {!err && savedAt > 0 && <div className="settings-saved">Saved</div>}
        {settings && (
          <div className="fleet-auto">
            <label className="proj-autonomy" title="When a task needs a runner and none is idle, auto-provision one (up to the max).">
              <input
                type="checkbox"
                className="proj-autonomy-cb"
                checked={settings.autoProvisionRunners}
                disabled={busy}
                onChange={(e) => void save({ autoProvisionRunners: e.target.checked })}
              />
              <span className="proj-autonomy-switch" aria-hidden="true" />
              <span className="proj-autonomy-label">Auto-create runners when needed</span>
            </label>
            <label className="fleet-auto-max" title="Hard ceiling on total fleet size. 0 = no cap.">
              <span className="fleet-auto-max-label">Max runners</span>
              <input
                type="number"
                min={0}
                className="qx-input fleet-auto-max-input"
                value={settings.maxRunners}
                disabled={busy}
                onChange={(e) => setSettings({ ...settings, maxRunners: clampMax(e.target.value) })}
                onBlur={(e) => void save({ maxRunners: clampMax(e.target.value) })}
                onKeyDown={commitOnEnter}
              />
              <span className="fleet-auto-max-hint mono">0 = no cap</span>
            </label>
            <label className="fleet-auto-max" title="Retire an auto-created runner once it has sat idle this long. Operator-added runners are never auto-retired. 0 = never.">
              <span className="fleet-auto-max-label">Retire idle after</span>
              <input
                type="number"
                min={0}
                className="qx-input fleet-auto-max-input"
                value={settings.retireIdleRunnersAfterMinutes}
                disabled={busy}
                onChange={(e) => setSettings({ ...settings, retireIdleRunnersAfterMinutes: clampMax(e.target.value) })}
                onBlur={(e) => void save({ retireIdleRunnersAfterMinutes: clampMax(e.target.value) })}
                onKeyDown={commitOnEnter}
              />
              <span className="fleet-auto-max-hint mono">min · 0 = never</span>
            </label>
            {/* Pre-work exploration has no run or agent to inherit a model
                from, so it used to be hardcoded — and hardcoded to Opus, which
                kept an expensive model in the loop no matter what the fleet was
                set to. Free-text like every other model field: the catalog is
                advisory, so a model released after this build still works. */}
            <label className="fleet-auto-max">
              <span className="fleet-auto-max-label">Exploration model</span>
              <input
                className="qx-input fleet-auto-model-input mono"
                value={settings.exploreModel}
                disabled={busy}
                placeholder="sonnet-5"
                onChange={(e) => setSettings({ ...settings, exploreModel: e.target.value })}
                onBlur={(e) => void save({ exploreModel: e.target.value.trim() || "sonnet-5" })}
                onKeyDown={commitOnEnter}
              />
              <span className="fleet-auto-max-hint mono">reads the repo to ground a draft plan — doesn't need your best model</span>
            </label>
            <label
              className="proj-autonomy"
              title="Give agents a real browser (a Playwright/Chrome MCP server) so they can reproduce a bug, verify a UI change, or read live docs. Browser actions still gate for approval. Off by default. Works for Claude, Codex, Gemini, Cursor, and Copilot runners; not Hermes."
            >
              <input
                type="checkbox"
                className="proj-autonomy-cb"
                checked={settings.browserTools}
                disabled={busy}
                onChange={(e) => void save({ browserTools: e.target.checked })}
              />
              <span className="proj-autonomy-switch" aria-hidden="true" />
              <span className="proj-autonomy-label">Give agents a browser (Playwright MCP)</span>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Command policy ─────────────────────────────────────────────────────────
// The versioned, per-workspace command-safety classifier (ROADMAP.md "policy
// as code"). Replaces trust in the compiled-in classifier with a rule set an
// operator can see, edit, dry-run against real history, and version — a
// workspace that never saves a custom version keeps running the shipped
// default untouched (fetchCommandPolicy() returns it either way).
const POLICY_DECISIONS: PolicyDecision[] = ["allow", "gate", "deny"];
const POLICY_RULE_KINDS: PolicyRuleKind[] = ["deny", "gate", "allow-leader"];
const POLICY_RISKS: Risk[] = ["low", "medium", "high"];

function newPolicyRule(kind: PolicyRuleKind): PolicyRule {
  return { id: `rule-${Math.random().toString(36).slice(2, 9)}`, kind, pattern: "", risk: "medium", reason: "", enabled: true };
}

function CommandPolicySection() {
  const [draft, setDraft] = useState<CommandPolicy | null>(null);
  const [versions, setVersions] = useState<PolicyVersion[]>([]);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dryRun, setDryRun] = useState<PolicyDryRunResult | null>(null);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [dryRunErr, setDryRunErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.fetchCommandPolicy(), api.fetchCommandPolicyVersions()])
      .then(([policy, vs]) => {
        setDraft(policy);
        setVersions(vs);
      })
      .catch(() => setErr("Couldn't load the command policy."));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);

  const patchRule = (id: string, patch: Partial<PolicyRule>) => {
    setDraft((d) => (d ? { ...d, rules: d.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : d));
  };
  const removeRule = (id: string) => {
    setDraft((d) => (d ? { ...d, rules: d.rules.filter((r) => r.id !== id) } : d));
  };
  const addRule = (kind: PolicyRuleKind) => {
    setDraft((d) => (d ? { ...d, rules: [...d.rules, newPolicyRule(kind)] } : d));
  };

  const runDryRun = async () => {
    if (!draft) return;
    setDryRunBusy(true);
    setDryRunErr(null);
    try {
      setDryRun(await api.dryRunCommandPolicy(draft));
    } catch (e) {
      setDryRunErr((e as Error).message);
    } finally {
      setDryRunBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api.saveCommandPolicyVersion(draft, label.trim() || null);
      setLabel("");
      setDryRun(null);
      setSaved(true);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadVersion = (v: PolicyVersion) => {
    setDraft(v.policy);
    setDryRun(null);
    setSaved(false);
  };

  return (
    <div className="settings-setup policy-toggle-row">
      <div className="settings-setup-text">
        <div className="adv-toggle" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}>
          <div className="settings-setup-title">Command policy {open ? "▾" : "▸"}</div>
          <div className="settings-setup-sub">
            The rules that decide whether an agent's command runs automatically, needs your approval, or is refused
            outright. Edit the rules, dry-run the change against this workspace's real command history to see exactly
            what would flip, then save — the previous version stays on record. No custom version saved yet = the
            shipped default classifier, unchanged.
          </div>
        </div>
        {open && (
          <div className="policy-panel">
            {err && <div className="settings-warn">{err}</div>}
            {!draft ? (
              <div className="settings-setup-sub">Loading…</div>
            ) : (
              <>
                <div className="policy-rules">
                  {POLICY_RULE_KINDS.map((kind) => (
                    <div className="policy-rule-group" key={kind}>
                      <div className="policy-rule-group-head">
                        <span className={`risk-chip ${kind === "deny" ? "risk-high" : kind === "gate" ? "risk-medium" : "risk-low"}`}>
                          {kind}
                        </span>
                        <span className="settings-setup-sub">
                          {kind === "deny"
                            ? "Matches here NEVER run, even if approved."
                            : kind === "gate"
                              ? "Matches here require human approval."
                              : "Every segment of a command must match one of these for it to run unattended."}
                        </span>
                        <button className="btn btn-ghost btn-sm" onClick={() => addRule(kind)}>+ rule</button>
                      </div>
                      {draft.rules.filter((r) => r.kind === kind).length === 0 && (
                        <div className="settings-setup-sub">No rules.</div>
                      )}
                      {draft.rules.filter((r) => r.kind === kind).map((r) => (
                        <div className="policy-rule-row" key={r.id}>
                          <input
                            type="checkbox"
                            checked={r.enabled}
                            title="Enabled"
                            onChange={(e) => patchRule(r.id, { enabled: e.target.checked })}
                          />
                          <input
                            className="settings-input policy-rule-pattern"
                            placeholder="regex pattern"
                            value={r.pattern}
                            onChange={(e) => patchRule(r.id, { pattern: e.target.value })}
                          />
                          {kind !== "allow-leader" && (
                            <select className="qx-input policy-rule-risk" value={r.risk} onChange={(e) => patchRule(r.id, { risk: e.target.value as Risk })}>
                              {POLICY_RISKS.map((risk) => (
                                <option key={risk} value={risk}>{risk}</option>
                              ))}
                            </select>
                          )}
                          <input
                            className="settings-input policy-rule-reason"
                            placeholder="reason (shown on the gate)"
                            value={r.reason}
                            onChange={(e) => patchRule(r.id, { reason: e.target.value })}
                          />
                          <button className="btn btn-ghost btn-sm" onClick={() => removeRule(r.id)}>Remove</button>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                <div className="policy-defaults">
                  <span className="settings-setup-sub">Command matching no rule above:</span>
                  <select className="qx-input" value={draft.defaultDecision} onChange={(e) => setDraft({ ...draft, defaultDecision: e.target.value as PolicyDecision })}>
                    {POLICY_DECISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <select className="qx-input" value={draft.defaultRisk} onChange={(e) => setDraft({ ...draft, defaultRisk: e.target.value as Risk })}>
                    {POLICY_RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <label className="proj-autonomy" title="Block `allow` whenever the command contains $(...), backticks, eval, or a redirect — even if every segment otherwise matches an allow-leader.">
                    <input
                      type="checkbox"
                      className="proj-autonomy-cb"
                      checked={draft.unsafeCompositionBlocksAllow}
                      onChange={(e) => setDraft({ ...draft, unsafeCompositionBlocksAllow: e.target.checked })}
                    />
                    <span className="proj-autonomy-switch" aria-hidden="true" />
                    <span className="proj-autonomy-label">Block substitution/eval composition from ever auto-allowing</span>
                  </label>
                </div>

                <div className="policy-inert">
                  <div className="settings-setup-sub">
                    Recorded for visibility only — no runtime enforcement exists for these yet.
                  </div>
                  <label className="fleet-auto-max">
                    <span className="fleet-auto-max-label">Max wall-clock (ms)</span>
                    <input
                      type="number"
                      min={0}
                      className="qx-input fleet-auto-max-input"
                      value={draft.resourceCaps.maxWallClockMs ?? ""}
                      placeholder="unset"
                      onChange={(e) => setDraft({ ...draft, resourceCaps: { ...draft.resourceCaps, maxWallClockMs: e.target.value ? Number(e.target.value) : null } })}
                    />
                  </label>
                  <label className="fleet-auto-max">
                    <span className="fleet-auto-max-label">Max token budget</span>
                    <input
                      type="number"
                      min={0}
                      className="qx-input fleet-auto-max-input"
                      value={draft.resourceCaps.maxTokenBudget ?? ""}
                      placeholder="unset"
                      onChange={(e) => setDraft({ ...draft, resourceCaps: { ...draft.resourceCaps, maxTokenBudget: e.target.value ? Number(e.target.value) : null } })}
                    />
                  </label>
                  <label className="proj-autonomy" title="No network-egress enforcement mechanism exists yet — this only records intent for when it does.">
                    <input
                      type="checkbox"
                      className="proj-autonomy-cb"
                      checked={draft.networkEgress.enabled}
                      onChange={(e) => setDraft({ ...draft, networkEgress: { ...draft.networkEgress, enabled: e.target.checked } })}
                    />
                    <span className="proj-autonomy-switch" aria-hidden="true" />
                    <span className="proj-autonomy-label">Network-egress allowlist (inert)</span>
                  </label>
                </div>

                <div className="policy-actions">
                  <button className="btn btn-ghost" disabled={dryRunBusy} onClick={() => void runDryRun()}>
                    {dryRunBusy ? "Dry-running…" : "Dry-run against history"}
                  </button>
                  <input
                    className="settings-input policy-label-input"
                    placeholder="Version label (optional)"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                  <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
                    {busy ? "Saving…" : "Save as new active version"}
                  </button>
                  {saved && <span className="settings-setup-sub">Saved.</span>}
                </div>

                {dryRunErr && <div className="settings-warn">{dryRunErr}</div>}
                {dryRun && (
                  <div className="policy-dryrun">
                    <div className="settings-setup-sub">
                      {dryRun.uniqueCommands} distinct commands replayed ({dryRun.sampledRecords} historical records) —{" "}
                      {dryRun.changed.length} would change, {dryRun.unchanged} unchanged.
                    </div>
                    {dryRun.changed.length > 0 && (
                      <div className="policy-dryrun-list">
                        {dryRun.changed.map((c) => (
                          <div className="policy-dryrun-row" key={c.command}>
                            <span className="mono policy-dryrun-cmd">{c.command}</span>
                            <span className="policy-dryrun-verdict">
                              <span className={`risk-chip risk-${c.before.risk}`}>{c.before.decision}</span>
                              <span aria-hidden="true"> → </span>
                              <span className={`risk-chip risk-${c.after.risk}`}>{c.after.decision}</span>
                            </span>
                            <span className="settings-setup-sub">×{c.occurrences}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="policy-history">
                  <div className="settings-setup-sub">Version history</div>
                  {versions.length === 0 && <div className="settings-setup-sub">No saved versions — running the shipped default.</div>}
                  {versions.map((v) => (
                    <div className="policy-history-row" key={v.id}>
                      <span className="mono">v{v.version}</span>
                      {v.active && <span className="chip chip-idle">active</span>}
                      <span className="settings-setup-sub">{v.label || "(no label)"}</span>
                      <span className="settings-setup-sub">{v.createdBy} · {new Date(v.createdAt).toLocaleString()}</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => loadVersion(v)}>Load into editor</button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MCP access ─────────────────────────────────────────────────────────────
// Mint scoped tokens that let runs drive Skynet over MCP. The raw token is
// shown once, right after minting, alongside ready-to-paste client config.
const SCOPE_INFO: { id: McpScope; label: string; hint: string }[] = [
  { id: "observe", label: "Observe", hint: "read projects, runs, fleet, and the HITL queue" },
  { id: "author", label: "Author", hint: "create & assign tasks, drive runs, manage agents" },
  { id: "approver", label: "Approver", hint: "resolve HITL — approve diffs & pushes without a human" },
];

// ─── Advanced (env) settings ────────────────────────────────────────────────
// A curated whitelist of operator env knobs (the server owns the list). In the
// desktop app these stage to the userData env file and apply when the engine
// restarts; elsewhere the panel is read-only with a note. Collapsed by default.
function AdvancedSettingsSection() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ writable: boolean; fields: api.EnvSettingField[] } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [staged, setStaged] = useState(false); // saved, awaiting restart
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(() => {
    api.fetchEnvSettings().then(setData).catch(() => setErr("Couldn't load advanced settings."));
  }, []);
  useEffect(() => {
    if (open && data === null) load();
  }, [open, data, load]);

  if (!open) {
    return (
      <div
        className="settings-setup adv-toggle"
        onClick={() => setOpen(true)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(true))}
        role="button"
        tabIndex={0}
      >
        <div className="settings-setup-text">
          <div className="settings-setup-title">Advanced</div>
          <div className="settings-setup-sub">
            Telegram, runner safety limits, pre-merge checks, and vendor CLI paths.
          </div>
        </div>
        <span className="adv-caret mono">▸ show</span>
      </div>
    );
  }

  const dirty = Object.keys(drafts);
  const groups = data ? [...new Set(data.fields.map((f) => f.group))] : [];

  const save = async () => {
    if (dirty.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await api.saveEnvSettings(drafts);
      setDrafts({});
      setStaged(true);
      setData(null); // refetch to reflect stored state (masked secrets, `set`)
      load();
    } catch (e) {
      setErr(e instanceof api.ApiError ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    setRestarting(true);
    try {
      await api.restartEngine();
      // The socket drops while the engine relaunches; App's ConnectingShell
      // handles the reconnect. Clear the banner optimistically.
      setStaged(false);
    } catch {
      /* the disconnect itself often races the response — treat as in-progress */
    }
  };

  return (
    <div className="adv-sec">
      <button className="adv-head" onClick={() => setOpen(false)}>
        <div className="settings-setup-text">
          <div className="settings-setup-title">Advanced</div>
          <div className="settings-setup-sub">Operator env settings — applied on engine restart.</div>
        </div>
        <span className="adv-caret mono">▾ hide</span>
      </button>

      {err && <div className="settings-warn">{err}</div>}
      {data && !data.writable && (
        <div className="adv-note mono">
          Read-only here — these apply in the packaged desktop app, where changes are staged and the
          engine restarts to apply them.
        </div>
      )}

      {data &&
        groups.map((g) => (
          <div className="adv-group" key={g}>
            <div className="adv-group-title mono">{g}</div>
            {data.fields
              .filter((f) => f.group === g)
              .map((f) => {
                const draftVal = drafts[f.key];
                const val = draftVal ?? f.value;
                const set = (v: string) => setDrafts((d) => ({ ...d, [f.key]: v }));
                return (
                  <div className="adv-field" key={f.key}>
                    <label className="adv-field-label">
                      {f.label}
                      {f.unit && <span className="adv-unit mono"> ({f.unit})</span>}
                      <code className="adv-key">{f.key}</code>
                    </label>
                    {f.type === "toggle" ? (
                      <input
                        type="checkbox"
                        className="adv-check"
                        disabled={!data.writable}
                        checked={/^(1|true|yes|on)$/i.test(val)}
                        onChange={(e) => set(e.target.checked ? "true" : " ")}
                      />
                    ) : (
                      <input
                        className="adv-input"
                        type={f.type === "secret" ? "password" : f.type === "number" ? "number" : "text"}
                        autoComplete="off"
                        disabled={!data.writable}
                        placeholder={f.type === "secret" && f.set ? "•••• stored — leave blank to keep" : f.placeholder}
                        value={draftVal ?? (f.type === "secret" ? "" : f.value)}
                        onChange={(e) => set(e.target.value)}
                      />
                    )}
                    <div className="adv-hint">{f.hint}</div>
                  </div>
                );
              })}
          </div>
        ))}

      {data?.writable && (
        <div className="adv-actions">
          <button className="btn btn-primary" disabled={busy || dirty.length === 0} onClick={save}>
            {busy ? "Saving…" : dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? "" : "s"}` : "Saved"}
          </button>
          {staged && (
            <div className="adv-restart">
              <span className="adv-restart-msg">Saved — restart the engine to apply.</span>
              <button className="btn btn-ghost" disabled={restarting} onClick={restart}>
                {restarting ? "Restarting…" : "Restart engine"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Relative "3m ago" / "in 2h" from an epoch-ms timestamp, using the single-unit
// duration rule the rest of the app follows.
const rel = (ms: number): string => {
  const deltaSec = (ms - Date.now()) / 1000;
  return deltaSec >= 0 ? `in ${fmtWait(deltaSec)}` : `${fmtWait(-deltaSec)} ago`;
};

function McpAccessSection() {
  const { projects } = useStore();
  const [tokens, setTokens] = useState<ServiceTokenMeta[] | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Record<McpScope, boolean>>({ observe: true, author: true, approver: false, admin: false });
  // Project confinement. Empty = workspace-wide (every project); a non-empty set
  // restricts the token — both its reads and its writes — to just those projects.
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [minted, setMinted] = useState<{ token: string; label: string } | null>(null);
  // The id of the token minted this session — highlighted in the index so it's
  // obvious the token still exists after the one-time secret reveal is dismissed.
  const [justId, setJustId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTokens(await api.listServiceTokens());
    } catch {
      setTokens([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const selected = SCOPE_INFO.map((s) => s.id).filter((id) => scopes[id]);
  const origin = typeof location !== "undefined" ? location.origin : "http://127.0.0.1:8080";

  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };

  const mint = async () => {
    if (!label.trim() || selected.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await api.createServiceToken({ label: label.trim(), scopes: selected, projectIds });
      setMinted({ token: created.token, label: created.label });
      setJustId(created.id);
      setLabel("");
      setProjectIds([]);
      await load();
    } catch (e) {
      setErr(`Couldn't mint the token: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.revokeServiceToken(id);
      await load();
    } catch (e) {
      setErr(`Couldn't revoke the token: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // The raw token can't be re-shown (only a hash is stored), so "copy it again"
  // means minting a FRESH key with the same label + scopes + project confinement
  // and revoking the old one — the reveal above shows & copies it once. Preserves
  // a still-valid expiry.
  const regenerate = async (t: ServiceTokenMeta) => {
    setBusy(true);
    setErr(null);
    try {
      const ttlMs = t.expiresAt != null && t.expiresAt > Date.now() ? t.expiresAt - Date.now() : undefined;
      const created = await api.createServiceToken({ label: t.label, scopes: t.scopes, projectIds: t.projectIds, ttlMs });
      await api.revokeServiceToken(t.id);
      setMinted({ token: created.token, label: created.label });
      setJustId(created.id);
      await load();
    } catch (e) {
      setErr(`Couldn't regenerate the token: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const httpSnippet = (token: string) =>
    `claude mcp add --transport http skynet ${origin}/mcp --header "Authorization: Bearer ${token}"`;
  const stdioSnippet = (token: string) =>
    JSON.stringify(
      { mcpServers: { skynet: { command: "skynet-mcp", env: { SKYNET_MCP_URL: `${origin}/mcp`, SKYNET_MCP_TOKEN: token } } } },
      null,
      2,
    );

  return (
    <div className="mcp-access">
      <div className="settings-setup-title">MCP access</div>
      <div className="settings-setup-sub">
        Scoped tokens let runs drive this workspace over MCP — the same tools you use, gated by scope.
        Grant <span className="mono">approver</span> only to a token you trust to resolve gates without a human.
        Confine a token to specific projects and it can neither see nor touch anything outside them.
      </div>

      {err && <div className="settings-warn">{err}</div>}

      <div className="settings-row mcp-mint">
        <div className="mcp-mint-line">
          <input
            className="settings-input"
            placeholder="Token label, e.g. research-agent"
            value={label}
            maxLength={48}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void mint()}
          />
          <Blocked
            disabled={!label.trim() || selected.length === 0}
            reason={!label.trim() ? "Label the token to continue." : selected.length === 0 ? "Select at least one scope." : undefined}
          >
            <button className="btn btn-primary" disabled={busy || !label.trim() || selected.length === 0} onClick={() => void mint()}>
              Mint token
            </button>
          </Blocked>
        </div>
        <div className="mcp-scopes">
          {SCOPE_INFO.map((s) => (
            <label key={s.id} className={`mcp-scope${s.id === "approver" && scopes.approver ? " mcp-scope-warn" : ""}`}>
              <input type="checkbox" checked={scopes[s.id]} onChange={(e) => setScopes((v) => ({ ...v, [s.id]: e.target.checked }))} />
              <span className="mcp-scope-name">{s.label}</span>
              <span className="mcp-scope-hint">{s.hint}</span>
            </label>
          ))}
        </div>
        {projects.length > 0 && (
          <div className="mcp-projects">
            <div className="mcp-projects-head">
              <span className="mcp-projects-title">Projects</span>
              <span className="mcp-projects-hint">
                {projectIds.length === 0
                  ? "All projects — this token can see & act across the whole workspace."
                  : `Confined to ${projectIds.length} project${projectIds.length === 1 ? "" : "s"} — it can neither see nor touch the others.`}
              </span>
            </div>
            <div className="mcp-project-list">
              {projects.map((p) => {
                const on = projectIds.includes(p.id);
                return (
                  <label key={p.id} className={`mcp-project${on ? " mcp-project-on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        setProjectIds((v) => (e.target.checked ? [...v, p.id] : v.filter((id) => id !== p.id)))
                      }
                    />
                    <span className="mcp-project-name">{p.name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {minted && (
        <div className="mcp-reveal">
          <div className="mcp-reveal-head">
            <span className="detail-result-label">New token · {minted.label} · shown once</span>
            <button className="btn btn-ghost" onClick={() => setMinted(null)}>
              Done
            </button>
          </div>
          <div className="mcp-token-line">
            <code className="mcp-token mono">{minted.token}</code>
            <button className="btn btn-ghost" onClick={() => copy("tok", minted.token)}>
              {copied === "tok" ? "Copied" : "Copy"}
            </button>
          </div>
          <SnippetBlock title="Claude Code (remote HTTP)" text={httpSnippet(minted.token)} copied={copied === "http"} onCopy={() => copy("http", httpSnippet(minted.token))} />
          <SnippetBlock title="Local stdio (mcp.json) — needs the skynet-mcp binary" text={stdioSnippet(minted.token)} copied={copied === "stdio"} onCopy={() => copy("stdio", stdioSnippet(minted.token))} />
          <div className="mcp-reveal-note">
            Copy it now — the secret is shown only once. The token stays active and listed below (as <span className="mono">····{minted.token.slice(-4)}</span>); dismissing this doesn’t revoke it.
          </div>
        </div>
      )}

      <div className="mcp-tok-index">
        <div className="mcp-tok-index-head">
          <span className="settings-setup-title">Active tokens</span>
          {tokens && tokens.length > 0 && <span className="mcp-tok-count mono">{tokens.length}</span>}
        </div>
        {tokens === null ? (
          <div className="settings-setup-sub">Loading…</div>
        ) : tokens.length === 0 ? (
          <div className="settings-setup-sub">No tokens yet — mint one above to connect a run over MCP.</div>
        ) : (
          <div className="settings-list mcp-tok-list">
            {tokens.map((t) => (
              <div className={`mcp-tok-row${t.id === justId ? " mcp-tok-new" : ""}`} key={t.id}>
                <div className="mcp-tok-main">
                  <div className="mcp-tok-top">
                    <span className="settings-name">{t.label}</span>
                    {t.id === justId && <span className="mcp-tok-tag mono">just created</span>}
                    <span className="mcp-tok-scopes">
                      {t.scopes.map((s) => (
                        <span className="mcp-badge mono" key={s}>
                          {s}
                        </span>
                      ))}
                    </span>
                  </div>
                  <div className="mcp-tok-projects">
                    {t.projectIds.length === 0 ? (
                      <span className="mcp-badge mcp-badge-ws mono">all projects</span>
                    ) : (
                      t.projectIds.map((id) => (
                        <span className="mcp-badge mcp-badge-proj mono" key={id}>
                          {projects.find((p) => p.id === id)?.name ?? id}
                        </span>
                      ))
                    )}
                  </div>
                  <div className="mcp-tok-meta mono">
                    <span className="mcp-tok-fp">····{t.last4}</span>
                    <span>created {rel(t.createdAt)}</span>
                    <span>{t.lastUsedAt ? `used ${rel(t.lastUsedAt)}` : "never used"}</span>
                    {t.expiresAt != null && (
                      <span className={t.expiresAt <= Date.now() ? "mcp-tok-expired" : undefined}>
                        {t.expiresAt <= Date.now() ? "expired" : `expires ${rel(t.expiresAt)}`}
                      </span>
                    )}
                  </div>
                </div>
                <div className="mcp-tok-actions">
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    title="Get a copyable key: mints a fresh token with the same label & scopes, then revokes this one (the old key stops working)."
                    onClick={() => void regenerate(t)}
                  >
                    Regenerate
                  </button>
                  <button className="btn btn-ghost" disabled={busy} onClick={() => void revoke(t.id)}>
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Time-limited admin promotion (ROADMAP.md) — ADMIN-granted, never
// self-service: pick a viewer, grant a bounded full-authority window (the
// server-configured default TTL — no custom-duration picker here, kept
// deliberately minimal per the roadmap's "granting/viewing active
// promotions" scope, nothing more). Shown only to a genuine base admin (see
// the readOnly/elevatedUntil gate at the call site) — the server enforces
// this independently via the caller's PERSISTED role either way.
function AdminPromotionSection() {
  const { promoteOperator, fetchOperators, fetchElevations } = useStore();
  const [viewers, setViewers] = useState<api.OperatorSummary[] | null>(null);
  const [picked, setPicked] = useState("");
  const [events, setEvents] = useState<api.ElevationEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Login verification (MFA) toggle — a separate fetch/save from the
  // promotion state above (a different backing record, WorkspaceSettings),
  // same local-state pattern FleetAutomationSection uses for the same type.
  const [mfaSettings, setMfaSettings] = useState<WorkspaceSettings | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaErr, setMfaErr] = useState<string | null>(null);
  useEffect(() => {
    api.fetchWorkspaceSettings().then(setMfaSettings).catch(() => setMfaErr("Couldn't load the login setting."));
  }, []);
  const saveMfa = async (patch: UpdateWorkspaceSettingsRequest) => {
    setMfaBusy(true);
    setMfaErr(null);
    try {
      setMfaSettings(await api.updateWorkspaceSettings(patch));
    } catch (e) {
      setMfaErr((e as Error).message);
    } finally {
      setMfaBusy(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const [ops, evs] = await Promise.all([fetchOperators(), fetchElevations()]);
      setViewers(ops.filter((o) => o.role === "viewer"));
      setEvents(evs);
    } catch (e) {
      setErr(`Couldn't load the operator roster: ${(e as Error).message}`);
    }
  }, [fetchOperators, fetchElevations]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!picked && viewers && viewers.length > 0) setPicked(viewers[0]!.operatorId);
  }, [viewers, picked]);

  const promote = async () => {
    if (!picked || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await promoteOperator(picked);
      await load();
    } catch (e) {
      setErr(`Couldn't promote — ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-promo">
      <div className="settings-setup-title">Access</div>
      <div className="settings-setup-sub">
        Time-limited admin promotion — grant a viewer a bounded full-authority window (break-glass /
        sudo-style). It reverts on its own once the window lapses; every grant and expiry is audited below.
      </div>

      {mfaErr && <div className="settings-warn">{mfaErr}</div>}
      {mfaSettings && (
        <label
          className="proj-autonomy"
          title="Require a one-time verification code (sent via Telegram, or a recovery code) after the password, before a session is issued. A server-wide SKYNET_MFA=true env flag can also force this on regardless of this toggle."
        >
          <input
            type="checkbox"
            className="proj-autonomy-cb"
            checked={mfaSettings.requireLoginVerification}
            disabled={mfaBusy}
            onChange={(e) => void saveMfa({ requireLoginVerification: e.target.checked })}
          />
          <span className="proj-autonomy-switch" aria-hidden="true" />
          <span className="proj-autonomy-label">Require a verification code on login</span>
        </label>
      )}

      {err && <div className="settings-warn">{err}</div>}

      {viewers && viewers.length === 0 ? (
        <div className="settings-setup-sub">No viewer accounts in this workspace to promote.</div>
      ) : (
        <div className="settings-row admin-promo-grant">
          <select className="settings-input" value={picked} onChange={(e) => setPicked(e.target.value)} disabled={!viewers || busy}>
            {(viewers ?? []).map((v) => (
              <option key={v.operatorId} value={v.operatorId}>
                {v.email}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={!picked || busy} onClick={() => void promote()}>
            Promote
          </button>
        </div>
      )}

      <div className="admin-promo-log">
        <div className="settings-setup-title">Promotion history</div>
        {events === null ? (
          <div className="settings-setup-sub">Loading…</div>
        ) : events.length === 0 ? (
          <div className="settings-setup-sub">No promotions granted yet.</div>
        ) : (
          <div className="settings-list admin-promo-events">
            {events.map((ev, i) => (
              <div className="admin-promo-event mono" key={i}>
                {ev.kind === "grant" ? (
                  <>
                    <span className="admin-promo-badge admin-promo-grant-badge">GRANT</span>
                    <span>{ev.operatorId}</span>
                    <span className="admin-promo-dim">by {ev.grantedBy}</span>
                    <span className="admin-promo-dim">{rel(ev.at)}</span>
                    <span className="admin-promo-dim">expires {rel(ev.expiresAt)}</span>
                  </>
                ) : (
                  <>
                    <span className="admin-promo-badge admin-promo-expiry-badge">EXPIRED</span>
                    <span>{ev.operatorId}</span>
                    <span className="admin-promo-dim">{rel(ev.at)}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SnippetBlock({ title, text, copied, onCopy }: { title: string; text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="mcp-snippet">
      <div className="mcp-snippet-head">
        <span className="mcp-snippet-title">{title}</span>
        <button className="btn btn-ghost" onClick={onCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="mcp-snippet-body mono">{text}</pre>
    </div>
  );
}
