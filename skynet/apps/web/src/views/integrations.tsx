// ─── Integrations ─────────────────────────────────────────────────────────
// Connect GitHub (App installation) and tune the safety guardrails agents
// operate under. Backed by the real /api/github endpoints (the connection
// persists in the workspace's Store). The App private key is server-side only;
// this screen never sees a secret. See docs/github-integration.md.

import { useEffect, useState } from "react";
import {
  SAFETY_DEFAULTS,
  type GithubConnection,
  type GithubRepo,
  type SafetyPolicy,
} from "@skynet/shared";
import * as api from "../lib/client";

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
  onConnected,
  onDisconnect,
}: {
  github: GithubConnection;
  onConnected: (installation: GithubConnection["installation"], repos: GithubRepo[]) => void;
  onDisconnect: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "account" | "repos">("idle");
  const [account, setAccount] = useState<(typeof MOCK_ACCOUNTS)[number] | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});

  if (github.connected && github.installation && phase === "idle") {
    const inst = github.installation;
    const repos = github.repos.filter((r) => r.selected);
    return (
      <div className="gh-card">
        <div className="gh-card-head">
          <Octicon />
          <span className="gh-card-title">GitHub</span>
          <span className="gh-pill gh-pill-ok">Connected</span>
        </div>
        <div className="gh-conn">
          <span className="gh-conn-glyph">{inst.type === "Organization" ? "▣" : "◍"}</span>
          <div>
            <div style={{ fontWeight: 600 }}>
              {inst.account}{" "}
              <span style={{ color: "var(--faint)", fontWeight: 400, fontSize: 12 }}>· {inst.type}</span>
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
            onClick={() => {
              setPicked(Object.fromEntries(github.repos.map((r) => [r.id, r.selected])));
              setAccount(MOCK_ACCOUNTS.find((a) => a.login === inst.account) ?? null);
              setPhase("repos");
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
    return (
      <div className="gh-card">
        <div className="gh-card-head">
          <Octicon />
          <span className="gh-card-title">Connect GitHub</span>
        </div>
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
          <button className="btn btn-primary" onClick={() => setPhase("account")}>
            <Octicon /> &nbsp;Install Skynet GitHub App
          </button>
        </div>
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

  // phase === "repos"
  const repos = account ? MOCK_REPOS[account.login] ?? [] : [];
  const pickedCount = Object.values(picked).filter(Boolean).length;
  const confirm = () => {
    if (!account) return;
    const chosen: GithubRepo[] = repos.map((r) => ({ ...r, selected: !!picked[r.id] }));
    onConnected(
      { id: 42, account: account.login, type: account.type, appSlug: "skynet" },
      chosen,
    );
    setPhase("idle");
  };
  return (
    <div className="gh-card">
      <div className="gh-card-head">
        <Octicon />
        <span className="gh-card-title">Select repositories</span>
      </div>
      <p className="gh-card-sub">
        Grant the Skynet App access to the repos the fleet will work in. You can change this anytime.
      </p>
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
        <button className="btn btn-primary" disabled={pickedCount === 0} onClick={confirm}>
          {github.connected ? "Save access" : `Connect ${pickedCount} repo${pickedCount === 1 ? "" : "s"}`}
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
  installation: null,
  repos: [],
  safety: { ...SAFETY_DEFAULTS },
});

export function IntegrationsView() {
  const [github, setGithub] = useState<GithubConnection>(emptyConnection);
  const [appConfigured, setAppConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchGithub()
      .then(({ connection, appConfigured }) => {
        if (cancelled) return;
        setGithub(connection);
        setAppConfigured(appConfigured);
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

  return (
    <section className="vw" data-screen-label="Integrations">
      <div className="vw-head">
        <h1>Integrations</h1>
        <p>Connect GitHub and set the guardrails your agents operate under.</p>
      </div>
      <div className="gh-wrap">
        {!loaded ? (
          <p className="gs-sub">Loading…</p>
        ) : (
          <>
            <GithubConnect github={github} onConnected={onConnected} onDisconnect={onDisconnect} />
            <SafetySettings safety={github.safety} onChange={onUpdateSafety} />
            {github.connected && !appConfigured && (
              <div className="gh-warn">
                The GitHub App isn't configured on this server yet (set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY),
                so pushes/PRs won't run until it is. The connection + policy are saved.
              </div>
            )}
            {!github.connected && (
              <div className="gh-warn">Connect GitHub to let agents branch, push, and open PRs.</div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
