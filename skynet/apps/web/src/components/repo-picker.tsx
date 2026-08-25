// Single-select repository picker — a project binds to exactly ONE repo, so all
// of its runs branch & PR within the same repository. The <select> structurally
// enforces the one-repo-per-project rule. Repos come from the connected GitHub
// installation (Integrations); when none are connected, the project is created
// unbound and a hint points to the Integrations screen.

import { useEffect, useState } from "react";
import type { GithubRepo } from "@skynet/shared";
import * as api from "../lib/client";

/** The repos the connection can bind to. `null` while loading. Fetched LIVE (not
 *  from the connect-time snapshot) so a connection made before the repo list was
 *  paginated — or before newer repos existed — still shows every current repo.
 *  Pass a GitHub credential id to list THAT account's repos instead of the
 *  workspace default connection (a second PAT added in Integrations); the list
 *  refetches (and resets to loading) whenever the credential changes. */
export function useConnectedRepos(credentialId?: string): GithubRepo[] | null {
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRepos(null); // switching accounts → back to loading, not the old account's list
    api
      .fetchGithubRepos(credentialId)
      .then((rs) => {
        if (!cancelled) setRepos(rs.filter((r) => r.selected));
      })
      .catch(() => {
        // Live fetch failed (offline / transient GitHub error / token gone) — fall
        // back to the stored snapshot so the picker isn't needlessly empty. The
        // snapshot only describes the DEFAULT connection, so a specific
        // credential's failure degrades to empty rather than the wrong account.
        if (credentialId) {
          if (!cancelled) setRepos([]);
          return;
        }
        api
          .fetchGithub()
          .then(({ connection }) => {
            if (!cancelled) setRepos(connection.repos.filter((r) => r.selected));
          })
          .catch(() => {
            if (!cancelled) setRepos([]);
          });
      });
    return () => {
      cancelled = true;
    };
  }, [credentialId]);
  return repos;
}

export function RepoPicker({
  repos,
  value,
  onChange,
  pinnedAccount = false,
}: {
  repos: GithubRepo[] | null;
  value: string;
  onChange: (repo: string) => void;
  /** True when a specific (non-default) GitHub account is selected — its empty
   *  state means THAT token sees no repos, not that GitHub isn't connected. */
  pinnedAccount?: boolean;
}) {
  if (repos === null) return <div className="rp-note">Loading repositories…</div>;
  if (repos.length === 0)
    return pinnedAccount ? (
      <div className="rp-note">
        This account's token can't see any repositories — check the PAT's repository access (its
        resource owner and repo selection) in GitHub, or rotate it in{" "}
        <a className="rp-link" href="#/integrations">
          Integrations
        </a>
        .
      </div>
    ) : (
      <div className="rp-note">
        Connect GitHub in{" "}
        <a className="rp-link" href="#/integrations">
          Integrations
        </a>{" "}
        to bind a repository to this project.
      </div>
    );
  return (
    <label className="rp">
      <span className="rp-label">
        Repository <span className="rp-hint">· one per project, cloned locally</span>
      </span>
      <select className="rp-select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select repository…</option>
        {repos.map((r) => (
          <option key={r.id} value={r.name}>
            {r.name}
          </option>
        ))}
      </select>
    </label>
  );
}
