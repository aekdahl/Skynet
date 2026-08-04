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
 *  paginated — or before newer repos existed — still shows every current repo. */
export function useConnectedRepos(): GithubRepo[] | null {
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .fetchGithubRepos()
      .then((rs) => {
        if (!cancelled) setRepos(rs.filter((r) => r.selected));
      })
      .catch(() =>
        // Live fetch failed (offline / transient GitHub error / token gone) — fall
        // back to the stored snapshot so the picker isn't needlessly empty.
        api
          .fetchGithub()
          .then(({ connection }) => {
            if (!cancelled) setRepos(connection.repos.filter((r) => r.selected));
          })
          .catch(() => {
            if (!cancelled) setRepos([]);
          }),
      );
    return () => {
      cancelled = true;
    };
  }, []);
  return repos;
}

export function RepoPicker({
  repos,
  value,
  onChange,
}: {
  repos: GithubRepo[] | null;
  value: string;
  onChange: (repo: string) => void;
}) {
  if (repos === null) return <div className="rp-note">Loading repositories…</div>;
  if (repos.length === 0)
    return (
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
