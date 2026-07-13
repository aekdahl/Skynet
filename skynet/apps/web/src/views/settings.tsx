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

  const configured = new Map((metas ?? []).map((m) => [m.provider, m]));

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
            </div>
          );
        })}
      </div>

      <McpAccessSection />
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

// ─── MCP access ─────────────────────────────────────────────────────────────
// Mint scoped tokens that let runs drive Skynet over MCP. The raw token is
// shown once, right after minting, alongside ready-to-paste client config.
const SCOPE_INFO: { id: McpScope; label: string; hint: string }[] = [
  { id: "observe", label: "Observe", hint: "read projects, runs, fleet, and the HITL queue" },
  { id: "author", label: "Author", hint: "create & assign tasks, drive runs, manage agents" },
  { id: "approver", label: "Approver", hint: "resolve HITL — approve diffs & pushes without a human" },
];

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
