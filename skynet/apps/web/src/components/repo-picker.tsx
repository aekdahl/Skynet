// Single-select repository picker — a project binds to exactly ONE repo, so all
// of its runs branch & PR within the same repository. The <select> structurally
// enforces the one-repo-per-project rule. Repos come from the connected GitHub
// installation (Integrations); when none are connected, the project is created
// unbound and a hint points to the Integrations screen.

import { useEffect, useState } from "react";
import type { GithubRepo } from "@skynet/shared";
import * as api from "../lib/client";

/** The repos the connected GitHub installation has selected. `null` while loading. */
export function useConnectedRepos(): GithubRepo[] | null {
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .fetchGithub()
      .then(({ connection }) => {
        if (!cancelled) setRepos(connection.repos.filter((r) => r.selected));
      })
      .catch(() => {
        if (!cancelled) setRepos([]);
      });
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
        Repository <span className="rp-hint">· one per project</span>
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
