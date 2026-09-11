// ─── Integrations ─────────────────────────────────────────────────────────
// Connect GitHub (App installation) and tune the safety guardrails runs
// operate under. Backed by the real /api/github endpoints (the connection
// persists in the workspace's Store). The App private key is server-side only;
// this screen never sees a secret. See docs/github-integration.md.

import { useEffect, useState, type ReactNode } from "react";
import {
  SAFETY_DEFAULTS,
  type CredentialProvider,
  type GithubConnection,
  type GithubInstallation,
  type GithubRepo,
  type SafetyPolicy,
  type SecretAuditEntry,
  type SecretMeta,
  type McpServerMeta,
  type CreateMcpServerRequest,
} from "@skynet/shared";
import * as api from "../lib/client";
import { PlaceholderNote } from "../components/common";

// Least-privilege permissions the Skynet GitHub App requests.
const APP_PERMISSIONS: { scope: string; level: string; why: string }[] = [
  { scope: "Contents", level: "Read & write", why: "branch, commit, push agent work" },
  { scope: "Pull requests", level: "Read & write", why: "open & update PRs for review" },
  { scope: "Checks", level: "Read", why: "surface CI status on the agent" },
  { scope: "Metadata", level: "Read", why: "required baseline" },
];

const SAFETY_RULES: { key: keyof SafetyPolicy; label: string; on: string; off: string }[] = [
  {
    key: "prOnly",
    label: "PR-only writes",
    on: "Agents branch and open PRs — never push to the default branch directly. Branch protection & required reviews are respected.",
    off: "Agents may push directly to the default branch. Not recommended.",
  },
  {
    key: "noForcePush",
    label: "No force-push / no rewrite",
    on: "Force-pushes and history rewrites on agent branches are blocked — commits are append-only.",
    off: "Agents may force-push and rewrite branch history.",
  },
  {
    key: "moduleAllowlist",
    label: "Module / path allowlist",
    on: "An agent may only modify files in its assigned modules (from .skynet/modules.json). Out-of-scope writes are rejected before push.",
    off: "Agents may modify any path in the repo.",
  },
  {
    key: "approveBeforePush",
    label: "Human approval before push / merge",
    on: "A push or merge is held as an Inbox decision until an operator approves it.",
    off: "Agents push and merge without an approval gate.",
  },
];

// Stand-in for the App-installation API until the install/callback redirect
// lands (docs §9): the operator picks an account + repos and we record the
// installation directly via PUT /api/github.
const MOCK_ACCOUNTS = [
  { login: "acme", type: "Organization" as const, glyph: "▣" },
  { login: "jordan-diaz", type: "User" as const, glyph: "◍" },
];
const MOCK_REPOS: Record<string, Omit<GithubRepo, "selected">[]> = {
  acme: [
    { id: 1, name: "acme/monolith", defaultBranch: "main", private: true },
    { id: 2, name: "acme/web", defaultBranch: "main", private: true },
    { id: 3, name: "acme/infra", defaultBranch: "main", private: true },
    { id: 4, name: "acme/docs", defaultBranch: "main", private: false },
  ],
  "jordan-diaz": [
    { id: 5, name: "jordan-diaz/dotfiles", defaultBranch: "main", private: false },
    { id: 6, name: "jordan-diaz/sandbox", defaultBranch: "main", private: true },
  ],
};

function Octicon() {
  return (
    <svg className="gh-octi" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function GithubConnect({
  github,
  brokerConfigured,
  onConnected,
  onChanged,
  onDisconnect,
  embedded = false,
}: {
  github: GithubConnection;
  // Cloud token-broker + Device Flow available → the real App-install path.
  brokerConfigured?: boolean;
  onConnected: (installation: GithubConnection["installation"], repos: GithubRepo[]) => void;
  // The PAT path connects server-side and returns the full connection directly.
  onChanged?: (connection: GithubConnection) => void;
  onDisconnect: () => void;
  // When rendered inside an Integration section the section header already shows
  // the "GitHub" identity + status, so suppress this card's own top head.
  embedded?: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "account" | "repos">("idle");
  const [account, setAccount] = useState<(typeof MOCK_ACCOUNTS)[number] | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  // "Edit repository access" on an EXISTING (real) connection re-lists that
  // installation's repos live — `null` while loading, distinct from `[]` (a
  // real installation with zero repos). Kept separate from the `account`/
  // MOCK_REPOS path below, which is unreachable stub scaffolding for the
  // not-yet-built App-install redirect (see docs/github-integration.md §9) —
  // editing an ALREADY-connected installation has a real id to query, no
  // account picker needed.
  const [editRepos, setEditRepos] = useState<GithubRepo[] | null>(null);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [pat, setPat] = useState("");
  const [patBusy, setPatBusy] = useState(false);
  const [patErr, setPatErr] = useState<string | null>(null);

  // ── broker mode (Device Flow → install picker → repo picker) ──────────────
  const [bphase, setBphase] = useState<null | "device" | "installs" | "brepos">(null);
  const [device, setDevice] = useState<api.DeviceCode | null>(null);
  const [installs, setInstalls] = useState<GithubInstallation[]>([]);
  const [binst, setBinst] = useState<GithubInstallation | null>(null);
  const [brepos, setBrepos] = useState<GithubRepo[]>([]);
  const [bpicked, setBpicked] = useState<Record<number, boolean>>({});
  const [berr, setBerr] = useState<string | null>(null);

  const connectPat = async () => {
    const token = pat.trim();
    if (!token) return;
    setPatBusy(true);
    setPatErr(null);
    try {
      const conn = await api.connectGithubPat(token);
      setPat("");
      onChanged?.(conn);
    } catch (e) {
      setPatErr((e as Error).message);
    } finally {
      setPatBusy(false);
    }
  };

  const beginDevice = async () => {
    setBerr(null);
    try {
      const code = await api.startGithubDevice();
      setDevice(code);
      setBphase("device");
    } catch (e) {
      setBerr((e as Error).message);
    }
  };

  // Poll for authorization while the device card is open, then load installs.
  useEffect(() => {
    if (bphase !== "device" || !device) return;
    let stop = false;
    const tick = async () => {
      try {
        const { authorized } = await api.pollGithubDevice(device.device_code);
        if (stop) return;
        if (authorized) {
          const list = await api.fetchGithubInstallations();
          if (stop) return;
          setInstalls(list);
          setBphase("installs");
        }
      } catch (e) {
        if (!stop) setBerr((e as Error).message);
      }
    };
    const id = setInterval(tick, Math.max(2, device.interval) * 1000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [bphase, device]);

  const pickInstall = async (inst: GithubInstallation) => {
    setBerr(null);
    setBinst(inst);
    try {
      const repos = await api.fetchGithubInstallationRepos(inst.id);
      setBrepos(repos);
      setBpicked({});
      setBphase("brepos");
    } catch (e) {
      setBerr((e as Error).message);
    }
  };

  const confirmBroker = () => {
    if (!binst) return;
    onConnected(binst, brepos.map((r) => ({ ...r, selected: !!bpicked[r.id] })));
    setBphase(null);
    setDevice(null);
  };

  if (github.connected && github.auth === "pat" && phase === "idle") {
    const repos = github.repos.filter((r) => r.selected);
    return (
      <div className="gh-card">
        <div className="gh-card-head">
          <Octicon />
          <span className="gh-card-title">GitHub</span>
          <span className="gh-pill gh-pill-ok">Connected</span>
        </div>
        <div className="gh-conn">
          <span className="gh-conn-glyph">◍</span>
          <div>
            <div style={{ fontWeight: 600 }}>
              Personal access token{" "}
              <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 12 }}>· ····{github.tokenLast4}</span>
            </div>
            <div className="gh-conn-meta">
              {repos.length} repo{repos.length === 1 ? "" : "s"} · stored encrypted on this machine
            </div>
          </div>
        </div>
        <div className="gh-row">
          <span className="gh-spacer" />
          <button className="btn btn-danger" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      </div>
    );
  }

  // ── broker mode: device-flow auth, then real install + repo pickers ───────
  if (bphase === "device" && device) {
    return (
      <div className="gh-card">
        <div className="gh-card-head">
          <Octicon />
          <span className="gh-card-title">Authorize on GitHub</span>
        </div>
        <p className="gh-card-sub">Open GitHub, enter this code, and approve. Waiting for authorization…</p>
        <div className="gh-device">
          <span className="gh-device-code mono">{device.user_code}</span>
          <a className="btn btn-primary" href={device.verification_uri} target="_blank" rel="noreferrer">
            Open GitHub →
          </a>
        </div>
        {berr && <div className="gh-pat-err">{berr}</div>}
        <div className="gh-row">
          <button className="gh-back" onClick={() => { setBphase(null); setDevice(null); }}>← Cancel</button>
        </div>
      </div>
    );
  }

  if (bphase === "installs") {
    return (
      <div className="gh-card">
        <div className="gh-card-head">
          <Octicon />
          <span className="gh-card-title">Choose an installation</span>
        </div>
        <p className="gh-card-sub">Where the Skynet App is installed. Don't see it? Install it on GitHub, then retry.</p>
        {installs.length === 0 && <p className="gh-card-sub">No installations found for your account.</p>}
        {installs.map((i) => (
          <button key={i.id} className="gh-acct" onClick={() => pickInstall(i)}>
            <span className="gh-acct-glyph">{i.type === "Organization" ? "▣" : "◍"}</span> {i.account}
            <span className="gh-acct-type">{i.type}</span>
          </button>
        ))}
        {berr && <div className="gh-pat-err">{berr}</div>}
        <div className="gh-row">
          <button className="gh-back" onClick={() => setBphase(null)}>← Cancel</button>
        </div>
      </div>
    );
  }

  if (bphase === "brepos") {
    const count = Object.values(bpicked).filter(Boolean).length;
    return (
      <div className="gh-card">
        <div className="gh-card-head">
          <Octicon />
          <span className="gh-card-title">Select repositories</span>
        </div>
        <p className="gh-card-sub">The repos the fleet may work in. You can change this anytime.</p>
        {brepos.length === 0 && <p className="gh-card-sub">This installation has no repositories selected on GitHub.</p>}
        {brepos.map((r) => (
          <div key={r.id} className="gh-repo" onClick={() => setBpicked((p) => ({ ...p, [r.id]: !p[r.id] }))}>
            <span className={"gh-check" + (bpicked[r.id] ? " on" : "")}>{bpicked[r.id] ? "✓" : ""}</span>
            <span className="gh-repo-name">{r.name}</span>
            <span className="gh-repo-tags">
              <span>{r.private ? "private" : "public"}</span>
              <span>{r.defaultBranch}</span>
            </span>
          </div>
        ))}
        {berr && <div className="gh-pat-err">{berr}</div>}
        <div className="gh-row">
          <button className="gh-back" onClick={() => setBphase("installs")}>← Back</button>
          <span className="gh-spacer" />
          <button className="btn btn-primary" disabled={count === 0} onClick={confirmBroker}>
            Connect {count} repo{count === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    );
  }

  if (github.connected && github.installation && phase === "idle") {
    const inst = github.installation;
    const repos = github.repos.filter((r) => r.selected);
    return (
      <div className="gh-card">
        {!embedded && (
          <div className="gh-card-head">
            <Octicon />
            <span className="gh-card-title">GitHub</span>
            <span className="gh-pill gh-pill-ok">Connected</span>
          </div>
        )}
        <div className="gh-conn">
          <span className="gh-conn-glyph">{inst.type === "Organization" ? "▣" : "◍"}</span>
          <div>
            <div style={{ fontWeight: 600 }}>
              {inst.account}{" "}
              <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 12 }}>· {inst.type}</span>
            </div>
            <div className="gh-conn-meta">
              Skynet App · installation #{inst.id} · {repos.length} repo{repos.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
        <div className="gh-token">
          <span className="dot" /> Acting via short-lived installation tokens (auto-refreshed hourly) — no long-lived secrets stored.
        </div>
        <div className="gh-row">
          <button
            className="btn btn-ghost"
            onClick={async () => {
              // Seed from the current (possibly stale) snapshot immediately so
              // the panel isn't blank while the live fetch is in flight, then
              // replace with the real list — carrying forward which repos were
              // already selected, same as the server does for the picker.
              setPicked(Object.fromEntries(github.repos.map((r) => [r.id, r.selected])));
              setEditRepos(null);
              setEditErr(null);
              setPhase("repos");
              try {
                const live = await api.fetchGithubInstallationRepos(inst.id);
                setEditRepos(live);
                setPicked((p) => Object.fromEntries(live.map((r) => [r.id, p[r.id] ?? r.selected])));
              } catch (e) {
                setEditErr((e as Error).message);
                setEditRepos(github.repos); // degrade to the stale snapshot, not a dead end
              }
            }}
          >
            Edit repository access
          </button>
          <span className="gh-spacer" />
          <button className="btn btn-danger" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
      </div>
    );
  }

  if (phase === "idle") {
    // The PAT connect — the only path that works without the cloud token broker.
    const patConnect = (
      <>
        <div className="gh-row">
          <input
            type="password"
            className="settings-input"
            autoComplete="off"
            placeholder="github_pat_… or ghp_…"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connectPat()}
          />
          <button className="btn btn-primary" disabled={patBusy || !pat.trim()} onClick={connectPat}>
            {patBusy ? "Connecting…" : "Connect token"}
          </button>
        </div>
        {patErr && <div className="gh-pat-err">{patErr}</div>}
      </>
    );

    return (
      <div className="gh-card">
        {!embedded && (
          <div className="gh-card-head">
            <Octicon />
            <span className="gh-card-title">Connect GitHub</span>
          </div>
        )}

        {/* The GitHub App install is an org-wide, cloud path that needs the token
            broker. Without it (local-only), the install can't work — so show
            ONLY the PAT path rather than a dead/simulated App button. */}
        {brokerConfigured ? (
          <>
            <p className="gh-card-sub">
              Install the Skynet GitHub App on the account that owns your repositories. Skynet acts through
              least-privilege, short-lived installation tokens — never your personal credentials.
            </p>
            <div className="gh-perm">
              {APP_PERMISSIONS.map((p) => (
                <div key={p.scope} className="gh-perm-row">
                  <span>{p.scope}</span>
                  <span className="mono">{p.level}</span>
                  <span className="gh-perm-why">{p.why}</span>
                </div>
              ))}
            </div>
            <div className="gh-row">
              <button className="btn btn-primary" onClick={beginDevice}>
                <Octicon /> &nbsp;Install Skynet GitHub App
              </button>
            </div>
            {berr && <div className="gh-pat-err">{berr}</div>}

            <div className="gh-pat">
              <div className="gh-pat-or">— or connect with a token (works locally, no cloud) —</div>
              <p className="gh-card-sub">
                Paste a GitHub fine-grained personal access token (Contents + Pull requests:
                read/write on the repos you want). Stored encrypted on this machine; never shown again.
              </p>
              {patConnect}
            </div>
          </>
        ) : (
          <div className="gh-pat gh-pat-solo">
            <p className="gh-card-sub">
              Connect with a GitHub fine-grained personal access token (Contents + Pull requests:
              read/write on the repos you want). Stored encrypted on this machine; never shown again.
            </p>
            {patConnect}
          </div>
        )}
      </div>
    );
  }

  if (phase === "account") {
    return (
      <div className="gh-card">
        <div className="gh-card-head">
          <Octicon />
          <span className="gh-card-title">Choose where to install</span>
        </div>
        <p className="gh-card-sub">Pick the organization or account to install the Skynet App on.</p>
        <PlaceholderNote>
          These GitHub accounts are sample data — not your real GitHub. The App-install
          redirect isn't wired yet; picking one records a stub connection.
        </PlaceholderNote>
        {MOCK_ACCOUNTS.map((a) => (
          <button
            key={a.login}
            className="gh-acct"
            onClick={() => {
              setAccount(a);
              setPicked({});
              setPhase("repos");
            }}
          >
            <span className="gh-acct-glyph">{a.glyph}</span> {a.login}
            <span className="gh-acct-type">{a.type}</span>
          </button>
        ))}
        <div className="gh-row">
          <button className="gh-back" onClick={() => setPhase("idle")}>
            ← Back
          </button>
        </div>
      </div>
    );
  }

  // phase === "repos" — two distinct sources: editing an EXISTING connection
  // (real, live-fetched via editRepos) vs the not-yet-built App-install
  // redirect's stand-in account picker (MOCK_REPOS, unreachable today — see
  // the editRepos state comment above).
  const editing = github.connected;
  const repos = editing ? editRepos ?? [] : account ? MOCK_REPOS[account.login] ?? [] : [];
  const pickedCount = Object.values(picked).filter(Boolean).length;
  const confirm = () => {
    const chosen: GithubRepo[] = repos.map((r) => ({ ...r, selected: !!picked[r.id] }));
    if (editing) {
      if (!github.installation) return;
      onConnected(github.installation, chosen);
    } else {
      if (!account) return;
      onConnected({ id: 42, account: account.login, type: account.type, appSlug: "skynet" }, chosen);
    }
    setPhase("idle");
  };
  return (
    <div className="gh-card">
      <div className="gh-card-head">
        <Octicon />
        <span className="gh-card-title">{editing ? "Edit repository access" : "Select repositories"}</span>
      </div>
      <p className="gh-card-sub">
        {editing
          ? "Which of this installation's repos the fleet may work in."
          : "Grant the Skynet App access to the repos the fleet will work in. You can change this anytime."}
      </p>
      {editing ? (
        <>
          {editRepos === null && <p className="gh-card-sub">Loading repositories…</p>}
          {editErr && <div className="gh-pat-err">Couldn't refresh the live list ({editErr}) — showing what was last saved.</div>}
        </>
      ) : (
        <PlaceholderNote>Sample repositories — not fetched from GitHub yet.</PlaceholderNote>
      )}
      {repos.map((r) => (
        <div key={r.id} className="gh-repo" onClick={() => setPicked((p) => ({ ...p, [r.id]: !p[r.id] }))}>
          <span className={"gh-check" + (picked[r.id] ? " on" : "")}>{picked[r.id] ? "✓" : ""}</span>
          <span className="gh-repo-name">{r.name}</span>
          <span className="gh-repo-tags">
            <span>{r.private ? "private" : "public"}</span>
            <span>{r.defaultBranch}</span>
          </span>
        </div>
      ))}
      <div className="gh-row">
        <button className="gh-back" onClick={() => setPhase(github.connected ? "idle" : "account")}>
          ← Back
        </button>
        <span className="gh-spacer" />
        <button className="btn btn-primary" disabled={pickedCount === 0 || (editing && editRepos === null)} onClick={confirm}>
          {editing ? "Save access" : `Connect ${pickedCount} repo${pickedCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}

function SafetySettings({
  safety,
  onChange,
}: {
  safety: SafetyPolicy;
  onChange: (patch: Partial<SafetyPolicy>) => void;
}) {
  return (
    <div className="gh-card">
      <div className="gh-card-head">
        <span className="gh-card-title">Safety guardrails</span>
      </div>
      <p className="gh-card-sub">
        Enforced server-side before any write reaches GitHub. All on by default — toggle off only if you know why.
      </p>
      {SAFETY_RULES.map((rule) => {
        const on = !!safety[rule.key];
        return (
          <div className="gh-rule" key={rule.key}>
            <div className="gh-rule-body">
              <div className="gh-rule-label">{rule.label}</div>
              <div className={"gh-rule-desc" + (on ? "" : " is-off")}>{on ? rule.on : rule.off}</div>
            </div>
            <button
              className={"gh-switch" + (on ? " on" : "")}
              role="switch"
              aria-checked={on}
              aria-label={rule.label}
              onClick={() => onChange({ [rule.key]: !on })}
            />
          </div>
        );
      })}
    </div>
  );
}

export const emptyConnection = (): GithubConnection => ({
  workspaceId: "",
  connected: false,
  auth: "app",
  installation: null,
  tokenLast4: null,
  repos: [],
  safety: { ...SAFETY_DEFAULTS },
});

// A collapsible integration. Collapsed by default; the header shows identity +
// status + a one-line summary; click to expand its setup + settings.
function IntegrationSection({
  icon,
  title,
  statusLabel,
  statusOk,
  summary,
  children,
}: {
  icon: ReactNode;
  title: string;
  statusLabel: string;
  statusOk: boolean;
  summary: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="gh-int">
      <button className="gh-int-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="gh-int-icon">{icon}</span>
        <span className="gh-int-title">{title}</span>
        <span className={"gh-pill " + (statusOk ? "gh-pill-ok" : "gh-pill-off")}>{statusLabel}</span>
        <span className="gh-int-spacer" />
        {!open && <span className="gh-int-summary">{summary}</span>}
        <span className={"gh-chev" + (open ? " open" : "")} aria-hidden>
          ›
        </span>
      </button>
      {open && <div className="gh-int-body">{children}</div>}
    </div>
  );
}

// Recent credential activity for one provider — answers "why did this
// suddenly show not connected" by naming who removed (or added/rotated) a
// key and when. Survives past the credential's own deletion (unlike the
// account list above, which only shows what's currently stored).
function CredentialActivity({ provider }: { provider: CredentialProvider }) {
  const [entries, setEntries] = useState<SecretAuditEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .fetchSecretAudit()
      .then(({ audit }) => { if (!cancelled) setEntries(audit.filter((e) => e.provider === provider)); })
      .catch(() => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [provider]);

  if (!entries || entries.length === 0) return null;
  return (
    <details className="gh-acct-activity">
      <summary>Recent activity ({entries.length})</summary>
      <div className="settings-list gh-acct-list">
        {entries.slice(0, 10).map((e) => (
          <div className="mcp-tok-row" key={e.id}>
            <div className="mcp-tok-main">
              <div className="mcp-tok-top">
                <span className="settings-name">
                  {e.label || "account"} {e.action}
                </span>
              </div>
              <div className="mcp-tok-meta mono">{e.operatorId} · {new Date(e.at).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

// Secondary GitHub ACCOUNTS — extra PATs beyond the default connection, so a
// project can push to / store in a specific account (e.g. work on the business
// account it pays for, personal on your own). Stored as `github` credentials in
// the secret store; a project picks one in its settings. The default connection
// above is unchanged and is the fallback for projects that pick nothing.
function GithubAccounts() {
  const [accounts, setAccounts] = useState<SecretMeta[] | null>(null);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    api.fetchSecrets()
      .then(({ secrets }) => setAccounts(secrets.filter((s) => s.provider === "github")))
      .catch(() => setAccounts([]));
  useEffect(() => { void load(); }, []);

  const add = async () => {
    if (!name.trim() || !token.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createCredential("github", name.trim(), token.trim());
      setName("");
      setToken("");
      await load();
    } catch (e) {
      setErr(e instanceof api.ApiError && e.status === 501 ? "Secret store is disabled — set SKYNET_MASTER_KEY." : `Couldn't add the account: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    setErr(null);
    try { await api.deleteSecret(id); await load(); }
    catch (e) { setErr(`Couldn't remove: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="gh-card">
      <div className="gh-card-head"><span className="gh-card-title">Additional accounts</span></div>
      <p className="gh-card-sub">
        Add another GitHub account (a fine-grained PAT) so a project can push and store under it — e.g. keep
        work repos on your business account and personal repos on your own. Pick the account per project in its settings.
      </p>
      {err && <div className="gh-warn">{err}</div>}
      {accounts && accounts.length > 0 && (
        <div className="settings-list gh-acct-list">
          {accounts.map((a) => (
            <div className="mcp-tok-row" key={a.id}>
              <div className="mcp-tok-main">
                <div className="mcp-tok-top"><span className="settings-name">{a.name || "account"}</span></div>
                <div className="mcp-tok-meta mono"><span className="mcp-tok-fp">····{a.last4}</span></div>
              </div>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void remove(a.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <CredentialActivity provider="github" />
      <div className="gh-acct-add">
        <input
          className="settings-input gh-acct-name"
          placeholder="Name — e.g. Business, Personal"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="password"
          className="settings-input"
          autoComplete="off"
          placeholder="GitHub PAT (Contents + Pull requests)…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn btn-primary" disabled={busy || !name.trim() || !token.trim()} onClick={() => void add()}>
          Add account
        </button>
      </div>
    </div>
  );
}

// Fly.io API tokens, so a project can deploy to a persistent, shareable Fly
// app — see docs/live-preview.md §"Deploy to Fly.io". Stored as `fly`
// credentials in the secret store, exactly like the additional GitHub
// accounts above; a project picks one (or the default) in its settings.
function FlyIcon() {
  return (
    <svg className="gh-octi" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0a8 8 0 100 16A8 8 0 008 0zM5.5 5a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zm5 0a1.5 1.5 0 113 0 1.5 1.5 0 01-3 0zM8 12.5c-1.7 0-3.16-.98-3.86-2.4-.14-.28.1-.6.4-.55 1.1.18 2.3.28 3.46.28 1.17 0 2.36-.1 3.46-.28.3-.05.54.27.4.55-.7 1.42-2.16 2.4-3.86 2.4z" />
    </svg>
  );
}

function FlyAccounts() {
  const [accounts, setAccounts] = useState<SecretMeta[] | null>(null);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    api.fetchSecrets()
      .then(({ secrets }) => setAccounts(secrets.filter((s) => s.provider === "fly")))
      .catch(() => setAccounts([]));
  useEffect(() => { void load(); }, []);

  const add = async () => {
    if (!name.trim() || !token.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.createCredential("fly", name.trim(), token.trim());
      setName("");
      setToken("");
      await load();
    } catch (e) {
      setErr(e instanceof api.ApiError && e.status === 501 ? "Secret store is disabled — set SKYNET_MASTER_KEY." : `Couldn't add the account: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    setErr(null);
    try { await api.deleteSecret(id); await load(); }
    catch (e) { setErr(`Couldn't remove: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="gh-card">
      <div className="gh-card-head"><span className="gh-card-title">Fly.io accounts</span></div>
      <p className="gh-card-sub">
        Add a Fly.io API token so a project can "Deploy to Fly.io" — a real, persistent app with a
        shareable URL that keeps running independent of Skynet. Get a token from{" "}
        <code>fly tokens create deploy</code> or the Fly dashboard. Pick the account per project in its settings.
      </p>
      {err && <div className="gh-warn">{err}</div>}
      {accounts && accounts.length > 0 && (
        <div className="settings-list gh-acct-list">
          {accounts.map((a) => (
            <div className="mcp-tok-row" key={a.id}>
              <div className="mcp-tok-main">
                <div className="mcp-tok-top"><span className="settings-name">{a.name || "account"}</span></div>
                <div className="mcp-tok-meta mono"><span className="mcp-tok-fp">····{a.last4}</span></div>
              </div>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void remove(a.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <CredentialActivity provider="fly" />
      <div className="gh-acct-add">
        <input
          className="settings-input gh-acct-name"
          placeholder="Name — e.g. Personal, Work org"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="password"
          className="settings-input"
          autoComplete="off"
          placeholder="Fly.io API token (fo1_…)…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn btn-primary" disabled={busy || !name.trim() || !token.trim()} onClick={() => void add()}>
          Add account
        </button>
      </div>
    </div>
  );
}

// Custom MCP servers — the "scoped tools" roadmap "Tools via MCP" gives an
// agent to act back into the operator's own services (GitHub/Sentry/Slack/
// anything speaking MCP), not just Skynet's own git operations. Stored via
// the mcp-servers store (../lib/client's fetchMcpServers/createMcpServer/
// deleteMcpServer) — a completely separate store from the provider/GitHub/Fly
// credentials above, since a server carries a launch spec (stdio command/
// args/env, or a remote url/headers), not a single bearer key. Granted to a
// project in that project's own settings (see project.tsx's
// ProjectMcpServers) — adding one here doesn't turn it on anywhere by itself.
function McpIcon() {
  return (
    <svg className="gh-octi" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M5 6V4a2 2 0 012-2h2a2 2 0 012 2v2" strokeLinecap="round" />
      <rect x="3" y="6" width="10" height="7" rx="2" />
      <path d="M6 9.5h.01M10 9.5h.01" strokeLinecap="round" />
    </svg>
  );
}

function McpServerForm({ onAdd, busy }: { onAdd: (req: CreateMcpServerRequest) => Promise<void>; busy: boolean }) {
  const [transport, setTransport] = useState<"stdio" | "remote">("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");

  // "KEY=value" lines → a plain object, skipping blank/malformed lines.
  const parseLines = (text: string): Record<string, string> =>
    Object.fromEntries(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf("=");
          return i < 0 ? null : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
        .filter((p): p is [string, string] => !!p),
    );

  const canSubmit = name.trim() && (transport === "stdio" ? command.trim() : url.trim());
  const submit = async () => {
    if (!canSubmit) return;
    await onAdd(
      transport === "stdio"
        ? { transport: "stdio", name: name.trim(), command: command.trim(), args: args.trim().split(/\s+/).filter(Boolean), env: parseLines(env) }
        : { transport: "remote", name: name.trim(), url: url.trim(), headers: parseLines(headers) },
    );
    setName(""); setCommand(""); setArgs(""); setEnv(""); setUrl(""); setHeaders("");
  };

  return (
    <div className="gh-acct-add">
      <div className="cfg-prov" role="group" aria-label="MCP server transport">
        <button type="button" className={"cfg-prov-btn" + (transport === "stdio" ? " on" : "")} onClick={() => setTransport("stdio")}>
          Local command
        </button>
        <button type="button" className={"cfg-prov-btn" + (transport === "remote" ? " on" : "")} onClick={() => setTransport("remote")}>
          Remote URL
        </button>
      </div>
      <input className="settings-input gh-acct-name" placeholder="Name — e.g. Sentry" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      {transport === "stdio" ? (
        <>
          <input className="settings-input" placeholder="Command — e.g. npx" value={command} onChange={(e) => setCommand(e.target.value)} />
          <input className="settings-input" placeholder="Args — e.g. -y @some/mcp-server" value={args} onChange={(e) => setArgs(e.target.value)} />
          <textarea className="settings-input" rows={2} placeholder={"Env (one per line) — e.g.\nSENTRY_AUTH_TOKEN=..."} value={env} onChange={(e) => setEnv(e.target.value)} />
        </>
      ) : (
        <>
          <input className="settings-input" placeholder="URL — e.g. https://mcp.sentry.dev/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          <textarea className="settings-input" rows={2} placeholder={"Headers (one per line) — e.g.\nAuthorization=Bearer ..."} value={headers} onChange={(e) => setHeaders(e.target.value)} />
        </>
      )}
      <button className="btn btn-primary" disabled={busy || !canSubmit} onClick={() => void submit()}>
        Add server
      </button>
    </div>
  );
}

function McpServersSection() {
  const [servers, setServers] = useState<McpServerMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.fetchMcpServers().then(({ servers }) => setServers(servers)).catch(() => setServers([]));
  useEffect(() => { void load(); }, []);

  const add = async (req: CreateMcpServerRequest) => {
    setBusy(true);
    setErr(null);
    try {
      await api.createMcpServer(req);
      await load();
    } catch (e) {
      setErr(e instanceof api.ApiError && e.status === 501 ? "Secret store is disabled — set SKYNET_MASTER_KEY." : `Couldn't add the server: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setBusy(true);
    setErr(null);
    try { await api.deleteMcpServer(id); await load(); }
    catch (e) { setErr(`Couldn't remove: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <div className="gh-card">
      <div className="gh-card-head"><span className="gh-card-title">Custom MCP servers</span></div>
      <p className="gh-card-sub">
        Give agents tools beyond Skynet's own git operations — paste any MCP server's launch command or URL
        (GitHub, Sentry, Slack, or your own). Adding one here doesn't turn it on anywhere: grant it to a
        project in that project's own settings.
      </p>
      <p className="gh-card-sub">
        <strong>Security:</strong> a write-capable server (e.g. one holding a real GitHub token) lets an agent
        act <em>outside</em> Skynet's own git guardrails (PR-only writes, no force-push) — it acts with
        whatever permissions the server's own credentials grant, the same trust model as every integration
        on this page: your own account, your own risk.
      </p>
      {err && <div className="gh-warn">{err}</div>}
      {servers && servers.length > 0 && (
        <div className="settings-list gh-acct-list">
          {servers.map((s) => (
            <div className="mcp-tok-row" key={s.id}>
              <div className="mcp-tok-main">
                <div className="mcp-tok-top"><span className="settings-name">{s.name}</span></div>
                <div className="mcp-tok-meta mono">
                  {s.transport === "remote"
                    ? s.url + (s.headerKeys.length ? ` · headers: ${s.headerKeys.join(", ")}` : "")
                    : [s.command, ...s.args].join(" ") + (s.envKeys.length ? ` · env: ${s.envKeys.join(", ")}` : "")}
                </div>
              </div>
              <button className="btn btn-ghost" disabled={busy} onClick={() => void remove(s.id)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <McpServerForm onAdd={add} busy={busy} />
    </div>
  );
}

// Sentry — the flagship inbound-trigger proof case (docs/integrations-catalog.md):
// a new/regressed issue on a bound Sentry project becomes a task, and an agent
// already granted the Sentry MCP server above (in that project's settings)
// can act back on it. Unlike GitHub/Fly, there's no "connect" flow here — the
// operator wires the webhook up on Sentry's side and pastes the org/project
// slug into the project's own settings; this card just shows what to paste
// where and whether the server-side secret is even configured.
function SentryIcon() {
  return (
    <svg className="gh-octi" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 1a1.4 1.4 0 00-1.2.7L1.2 12a1.4 1.4 0 001.2 2.1h1.9a4.9 4.9 0 00-4-7.3l.8-1.4A6.5 6.5 0 0110 12.7v1.4H5.3a3.3 3.3 0 00-.6-1.9H7v-1.4H3.5a4.9 4.9 0 013.9-2.4V6.6a6.4 6.4 0 00-5.6 3.8L4.6 3.9A1.4 1.4 0 018 3.9l5.6 9.7a1.4 1.4 0 01-1.2 2.1h-1v-1.4h1L8 1z" />
    </svg>
  );
}

function SentrySection({ configured }: { configured: boolean }) {
  const webhookUrl = typeof window !== "undefined" ? `${window.location.origin}/webhooks/sentry` : "/webhooks/sentry";
  return (
    <div className="gh-card">
      <p className="gh-card-sub">
        In Sentry, add a webhook under Settings → Developer Settings → Internal Integration → Webhooks,
        pointing at:
      </p>
      <p className="gh-card-sub mono">{webhookUrl}</p>
      <p className="gh-card-sub">
        Set its signing secret to this server's <code>SENTRY_WEBHOOK_SECRET</code>, then bind a project to
        its Sentry org/project slug in that project's own settings. Add the Sentry MCP server above and grant
        it to the same project so the agent that picks up the resulting task can act back in Sentry.
      </p>
      {!configured && (
        <div className="gh-warn">SENTRY_WEBHOOK_SECRET isn't set on this server — the webhook endpoint 404s until it is.</div>
      )}
    </div>
  );
}

export function IntegrationsView() {
  const [github, setGithub] = useState<GithubConnection>(emptyConnection);
  const [appConfigured, setAppConfigured] = useState(false);
  const [brokerConfigured, setBrokerConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [flyCount, setFlyCount] = useState(0);
  const [mcpCount, setMcpCount] = useState(0);
  const [sentryConfigured, setSentryConfigured] = useState(false);
  useEffect(() => {
    // Guard against this view re-mounting before an earlier fetch resolves
    // (the store re-renders on every WS snapshot delta) — an in-flight
    // request from a stale mount must never overwrite state a newer mount
    // already set. Same "cancelled" pattern the fetchGithub effect below uses.
    let cancelled = false;
    api.fetchSecrets().then(({ secrets }) => { if (!cancelled) setFlyCount(secrets.filter((s) => s.provider === "fly").length); }).catch(() => { if (!cancelled) setFlyCount(0); });
    api.fetchMcpServers().then(({ servers }) => { if (!cancelled) setMcpCount(servers.length); }).catch(() => { if (!cancelled) setMcpCount(0); });
    api.fetchSentryStatus().then(({ configured }) => { if (!cancelled) setSentryConfigured(configured); }).catch(() => { if (!cancelled) setSentryConfigured(false); });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchGithub()
      .then(({ connection, appConfigured, brokerConfigured }) => {
        if (cancelled) return;
        setGithub(connection);
        setAppConfigured(appConfigured);
        setBrokerConfigured(brokerConfigured);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const onConnected = async (
    installation: GithubConnection["installation"],
    repos: GithubRepo[],
  ) => {
    if (!installation) return;
    const conn = await api.connectGithub({ installation, repos });
    setGithub(conn);
  };
  const onUpdateSafety = async (patch: Partial<SafetyPolicy>) => {
    // Optimistic flip so the toggle feels instant; reconcile with the server.
    setGithub((g) => ({ ...g, safety: { ...g.safety, ...patch } }));
    const conn = await api.updateGithubSafety(patch);
    setGithub(conn);
  };
  const onDisconnect = async () => {
    await api.disconnectGithub();
    setGithub(emptyConnection());
  };

  const repoCount = github.repos.filter((r) => r.selected).length;
  const summary =
    github.connected && github.installation
      ? `${github.installation.account} · ${repoCount} repo${repoCount === 1 ? "" : "s"}`
      : "Connect to let runs branch, push & open PRs";

  return (
    <section className="vw" data-screen-label="Integrations">
      <div className="vw-head">
        <h1>Integrations</h1>
        <p>Connect the services your runs work through, and set the guardrails.</p>
      </div>
      <div className="gh-wrap">
        {!loaded ? (
          <p className="gs-sub">Loading…</p>
        ) : (
          <IntegrationSection
            icon={<Octicon />}
            title="GitHub"
            statusLabel={github.connected ? "Connected" : "Not connected"}
            statusOk={github.connected}
            summary={summary}
          >
            <GithubConnect github={github} brokerConfigured={brokerConfigured} onConnected={onConnected} onChanged={setGithub} onDisconnect={onDisconnect} embedded />
            <GithubAccounts />
            <SafetySettings safety={github.safety} onChange={onUpdateSafety} />
            {github.connected && github.auth === "app" && !appConfigured && !brokerConfigured && (
              <div className="gh-warn">
                The GitHub App isn't configured on this server yet (set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY,
                or the token broker), so pushes/PRs won't run until it is. The connection + policy are saved.
              </div>
            )}
            {!github.connected && (
              <div className="gh-warn">Connect GitHub to let runs branch, push, and open PRs.</div>
            )}
          </IntegrationSection>
        )}
        {loaded && (
          <IntegrationSection
            icon={<FlyIcon />}
            title="Fly.io"
            statusLabel={flyCount > 0 ? "Connected" : "Not connected"}
            statusOk={flyCount > 0}
            summary={flyCount > 0 ? `${flyCount} account${flyCount === 1 ? "" : "s"}` : "Connect to deploy a persistent, shareable preview"}
          >
            <FlyAccounts />
            {flyCount === 0 && (
              <div className="gh-warn">Add a Fly.io API token to enable "Deploy to Fly.io" on a project.</div>
            )}
          </IntegrationSection>
        )}
        {loaded && (
          <IntegrationSection
            icon={<McpIcon />}
            title="Custom MCP servers"
            statusLabel={mcpCount > 0 ? `${mcpCount} configured` : "None configured"}
            statusOk={mcpCount > 0}
            summary={mcpCount > 0 ? `${mcpCount} server${mcpCount === 1 ? "" : "s"}` : "Give agents tools beyond git"}
          >
            <McpServersSection />
          </IntegrationSection>
        )}
        {loaded && (
          <IntegrationSection
            icon={<SentryIcon />}
            title="Sentry"
            statusLabel={sentryConfigured ? "Webhook configured" : "Not configured"}
            statusOk={sentryConfigured}
            summary="New Sentry issues become tasks"
          >
            <SentrySection configured={sentryConfigured} />
          </IntegrationSection>
        )}
      </div>
    </section>
  );
}
