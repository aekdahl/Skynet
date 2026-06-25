import { useCallback, useEffect, useState } from "react";
import type { SecretMeta } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";

// Provider keys live in the encrypted secret store, scoped to this workspace.
// A vendor's runners are only selectable in create-agent once its key is set
// (the snapshot recomputes provider availability from the secret store).
export function SettingsView() {
  const { providers, setProviderAvailable } = useStore();
  const [metas, setMetas] = useState<SecretMeta[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);

  const load = useCallback(async () => {
    try {
      const { secrets } = await api.fetchSecrets();
      setMetas(secrets);
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
      setProviderAvailable(id, false);
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
          A vendor's agents become selectable only once its key is set.
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
          const draft = drafts[p.id] ?? "";
          return (
            <div className="settings-row" key={p.id}>
              <div className="settings-prov">
                <span className="settings-glyph" style={{ color: p.color }}>
                  {p.glyph}
                </span>
                <span className="settings-name">{p.name}</span>
                {meta ? (
                  <span className="settings-ok mono">key set ····{meta.last4}</span>
                ) : (
                  <span className="settings-off mono">not set</span>
                )}
              </div>
              <div className="settings-key">
                <input
                  type="password"
                  className="settings-input"
                  autoComplete="off"
                  placeholder={meta ? "Replace key…" : "Paste API key…"}
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && save(p.id)}
                />
                <button
                  className="btn btn-primary"
                  disabled={busy === p.id || !draft.trim()}
                  onClick={() => save(p.id)}
                >
                  {meta ? "Replace" : "Save"}
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
            </div>
          );
        })}
      </div>
    </section>
  );
}
