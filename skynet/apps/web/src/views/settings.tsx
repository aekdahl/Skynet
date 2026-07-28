import { useCallback, useEffect, useState } from "react";
import type { SecretMeta } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import type { McpScope, ServiceTokenMeta } from "../lib/client";
import { InstallControls } from "../components/install-controls";
import { providerReadiness } from "../lib/derive";

// Provider keys live in the encrypted secret store, scoped to this workspace.
// A vendor's runners are only selectable in create-agent once its key is set
// (the snapshot recomputes provider availability from the secret store).
export function SettingsView({ onRerunSetup }: { onRerunSetup?: () => void }) {
  const { providers, setProviderAvailable } = useStore();
  const [metas, setMetas] = useState<SecretMeta[] | null>(null);
  const [envSet, setEnvSet] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  // "Duplicate a provider" — a named second key. Keyed by provider id.
  const [dupOpen, setDupOpen] = useState<string | null>(null);
  const [dupName, setDupName] = useState("");
  const [dupKey, setDupKey] = useState("");

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

  const duplicate = async (provider: string) => {
    const name = dupName.trim();
    const key = dupKey.trim();
    if (!name || !key) return;
    setBusy(`dup:${provider}`);
    setErr(null);
    try {
      await api.createCredential({ provider, name, apiKey: key });
      setDupOpen(null);
      setDupName("");
      setDupKey("");
      await load();
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 501) setDisabled(true);
      else setErr(`Couldn't add the credential: ${(e as Error).message}`);
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
          // The default credential (id === provider) is this row's main key; any
          // named "duplicates" of the provider list beneath it.
          const meta = (metas ?? []).find((m) => m.provider === p.id && m.isDefault);
          const named = (metas ?? []).filter((m) => m.provider === p.id && !m.isDefault);
          const envBacked = envSet.has(p.id);
          const draft = drafts[p.id] ?? "";
          const req = p.requirements;
          const rd = providerReadiness(p);
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
                <button
                  className="btn btn-primary"
                  disabled={busy === p.id || !draft.trim()}
                  onClick={() => save(p.id)}
                >
                  {meta ? "Replace" : envBacked ? "Override" : "Save"}
                </button>
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
              {req && (
                <div className="settings-req">
                  <span className={"settings-badge " + (rd.ready ? "ok" : "warn")}>
                    {rd.ready ? "Ready to run" : `Needs ${rd.missing.join(" and ")}`}
                  </span>
                  <span className="settings-req-detail">
                    {req.runtime === "cli" ? (
                      <>
                        Runtime: <code>{req.bin}</code> CLI
                        {p.binOnPath === true ? " — found on PATH" : " — not found on PATH"}
                      </>
                    ) : (
                      <>Runtime: in-process (no CLI to install)</>
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
                </div>
              )}

              {/* Named credentials ("duplicates") for this provider + add-another. */}
              {named.map((c) => (
                <div className="settings-cred" key={c.id}>
                  <span className="settings-cred-name">
                    {c.name} <span className="settings-ok mono">····{c.last4}</span>
                  </span>
                  <input
                    type="password"
                    className="settings-input"
                    autoComplete="off"
                    placeholder="Rotate key…"
                    value={drafts[c.id] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && save(c.id)}
                  />
                  <button className="btn btn-ghost" disabled={busy === c.id || !(drafts[c.id] ?? "").trim()} onClick={() => save(c.id)}>
                    Rotate
                  </button>
                  <button className="btn btn-ghost btn-retire" disabled={busy === c.id} onClick={() => remove(c.id)}>
                    Remove
                  </button>
                </div>
              ))}
              <div className="settings-dup">
                {dupOpen === p.id ? (
                  <>
                    <input
                      className="settings-input"
                      placeholder={`Name (e.g. ${p.name} for Business)`}
                      value={dupName}
                      onChange={(e) => setDupName(e.target.value)}
                    />
                    <input
                      type="password"
                      className="settings-input"
                      autoComplete="off"
                      placeholder="API key"
                      value={dupKey}
                      onChange={(e) => setDupKey(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && duplicate(p.id)}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={busy === `dup:${p.id}` || !dupName.trim() || !dupKey.trim()}
                      onClick={() => duplicate(p.id)}
                    >
                      Add credential
                    </button>
                    <button className="btn btn-ghost" onClick={() => { setDupOpen(null); setDupName(""); setDupKey(""); }}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="settings-dup-add"
                    onClick={() => { setDupOpen(p.id); setDupName(""); setDupKey(""); }}
                  >
                    + Duplicate — add another {p.name} key (e.g. a work account)
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

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
              Re-run the onboarding wizard (connect GitHub, add a fleet runner).
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
      <div className="settings-setup adv-toggle" onClick={() => setOpen(true)} role="button" tabIndex={0}>
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

function McpAccessSection() {
  const [tokens, setTokens] = useState<ServiceTokenMeta[] | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Record<McpScope, boolean>>({ observe: true, author: true, approver: false, admin: false });
  const [minted, setMinted] = useState<{ token: string; label: string } | null>(null);
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
      const created = await api.createServiceToken({ label: label.trim(), scopes: selected });
      setMinted({ token: created.token, label: created.label });
      setLabel("");
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
          <button className="btn btn-primary" disabled={busy || !label.trim() || selected.length === 0} onClick={() => void mint()}>
            Mint token
          </button>
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
        </div>
      )}

      <div className="settings-list mcp-tok-list">
        {tokens?.length === 0 && <div className="settings-setup-sub">No tokens yet.</div>}
        {tokens?.map((t) => (
          <div className="mcp-tok-row" key={t.id}>
            <span className="settings-name">{t.label}</span>
            <span className="mcp-tok-scopes">
              {t.scopes.map((s) => (
                <span className="mcp-badge mono" key={s}>
                  {s}
                </span>
              ))}
            </span>
            <span className="mcp-tok-meta mono">····{t.last4}</span>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void revoke(t.id)}>
              Revoke
            </button>
          </div>
        ))}
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
