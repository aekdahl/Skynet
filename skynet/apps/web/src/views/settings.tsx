import { useCallback, useEffect, useState } from "react";
import type { SecretMeta, WorkspaceSettings, UpdateWorkspaceSettingsRequest } from "@skynet/shared";
import { useStore } from "../lib/store";
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
  const { providers, retry, setProviderAvailable } = useStore();
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
                    <button className="btn btn-ghost" disabled={busy === c.id} onClick={() => removeCredential(c.id)}>
                      Remove
                    </button>
                  </div>
                  <VerifyBadge state={verify[c.id]} onDismiss={() => dismissVerify(c.id)} />
                </div>
              ))}
              <AddCredentialForm provider={p.id} providerName={p.name} onAdded={load} onVerify={runVerify} />
            </div>
          );
        })}
      </div>

      <FleetAutomationSection />
      <McpAccessSection />
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!name.trim() || !key.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { secret } = await api.createCredential(provider, name.trim(), key.trim());
      setName("");
      setKey("");
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
        <button className="btn btn-ghost" disabled={busy} onClick={() => { setOpen(false); setName(""); setKey(""); setErr(null); }}>
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

  useEffect(() => {
    api.fetchWorkspaceSettings().then(setSettings).catch(() => setErr("Couldn't load fleet settings."));
  }, []);

  const save = async (patch: UpdateWorkspaceSettingsRequest) => {
    setBusy(true);
    setErr(null);
    try {
      setSettings(await api.updateWorkspaceSettings(patch));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const clampMax = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

  return (
    <div className="settings-setup">
      <div className="settings-setup-text">
        <div className="settings-setup-title">Fleet auto-scale</div>
        <div className="settings-setup-sub">
          Add a runner automatically when a task needs one and none is free — cloned from a busy runner on a key the
          project is allowed to use. The max is the safety valve so auto-creation can’t run away (default 100; 0 = no
          cap); it caps every way runners get created, including MCP tokens. Auto-created runners are retired again once
          they’ve sat idle past the timeout below — operator-added runners are never touched.
        </div>
        {err && <div className="settings-warn">{err}</div>}
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
              />
              <span className="fleet-auto-max-hint mono">min · 0 = never</span>
            </label>
            <label
              className="proj-autonomy"
              title="Give Claude runners a real browser (a Playwright/Chrome MCP server) so an agent can reproduce a bug, verify a UI change, or read live docs. Browser actions still gate for approval. Off by default; Claude runners only for now."
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
