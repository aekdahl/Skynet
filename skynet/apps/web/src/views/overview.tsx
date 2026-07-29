import { useEffect, useState } from "react";
import type { GithubOwner, Project } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import {
  agentsForProject,
  backlogTasks,
  conflictModulesForAgent,
  fmtWait,
  modName,
  openQueue,
  projectShipped,
  waitedSecs,
} from "../lib/derive";
import { Bar, StatusDot } from "../components/common";
import { PrimaryButton } from "../components/empty";
import { RepoPicker, useConnectedRepos } from "../components/repo-picker";
import { FolderPicker } from "../components/folder-picker";

function ProjectCard({
  project,
  now,
  onOpen,
}: {
  project: Project;
  now: number;
  onOpen: () => void;
}) {
  const { runs, queue, tasks, modules } = useStore();
  const pa = agentsForProject(runs, project.id);
  const waiting = openQueue(queue).filter((q) =>
    pa.some((a) => a.id === q.runId),
  );
  // "Shipped" = every task done (see projectShipped), not merely every run done —
  // an unstarted backlog would otherwise badge the project shipped.
  const allDone = projectShipped(tasks, project.id);
  const empty = pa.length === 0;
  const prog = pa.length
    ? pa.reduce((n, a) => n + a.progress, 0) / pa.length
    : 0;
  const backlog = backlogTasks(tasks, project.id);
  const conflictAgent = pa.find(
    (a) => conflictModulesForAgent(a, runs).length > 0,
  );
  const conflictMod = conflictAgent
    ? conflictModulesForAgent(conflictAgent, runs)[0]
    : undefined;

  // A card is a glance, not a changelog. Only in-flight runs earn their own row
  // (waiting-on-you first, then running); finished runs collapse to a single
  // "✓ N merged" count so a shipped project doesn't stack 15 "merged" rows.
  const MAX_RUN_ROWS = 4;
  const activeSorted = pa
    .filter((a) => a.status !== "done")
    .sort(
      (x, y) =>
        (waiting.some((q) => q.runId === x.id) ? 0 : 1) -
        (waiting.some((q) => q.runId === y.id) ? 0 : 1),
    );
  const activeRuns = activeSorted.slice(0, MAX_RUN_ROWS);
  const hiddenActive = activeSorted.length - activeRuns.length;
  const mergedCount = pa.filter((a) => a.status === "done").length;

  return (
    <button className={"proj" + (allDone ? " proj-done" : "")} onClick={onOpen}>
      <div className="proj-top">
        <span className="proj-name">{project.name}</span>
        {waiting.length > 0 && (
          <span className="needs-pill">⏸ {waiting.length} waiting on you</span>
        )}
        {allDone && <span className="shipped-pill">✓ shipped</span>}
        {empty && <span className="shipped-pill">new</span>}
      </div>
      <p className="proj-goal">{project.goal}</p>
      {project.repoPath && (
        <div className="proj-repo mono" title={project.repoPath}>
          {project.gitBacked ? "◈ git" : "📁"} {project.repoPath}
        </div>
      )}
      {project.repo && <div className="proj-repo mono">⑂ {project.repo}</div>}
      <Bar
        value={prog}
        status={waiting.length > 0 ? "waiting" : allDone ? "done" : "running"}
      />
      <div className="proj-runs">
        {activeRuns.map((a) => {
          const q = waiting.find((it) => it.runId === a.id);
          return (
            <div key={a.id} className="proj-agent">
              <StatusDot status={a.status} />
              <span className="proj-agent-name">{a.name}</span>
              <span className="proj-agent-state mono">
                {q
                  ? "waiting " + fmtWait(waitedSecs(q, now))
                  : Math.round(a.progress * 100) + "%"}
              </span>
            </div>
          );
        })}
        {hiddenActive > 0 && (
          <div className="proj-backlog mono">+ {hiddenActive} more running</div>
        )}
        {mergedCount > 0 && (
          <div className="proj-merged mono">✓ {mergedCount} merged</div>
        )}
        {backlog.length > 0 && (
          <div className="proj-backlog mono">○ {backlog.length} in backlog</div>
        )}
        {empty && backlog.length === 0 && (
          <div className="proj-empty-hint">
            No tasks yet · open to add the first one
          </div>
        )}
      </div>
      {conflictMod && (
        <div className="proj-conflict">
          ⚠ overlaps another project in {modName(modules, conflictMod)}
        </div>
      )}
    </button>
  );
}

// Where a new project's work happens: a local folder, an already-connected repo,
// or a brand-new repo Skynet creates on GitHub (gated behind a confirm step).
type BindMode = "folder" | "existing" | "new";

/** Accounts a new repo can be created under. null = loading; [] = GitHub not
 *  connected (the "New repo" mode is hidden in that case). */
function useRepoOwners(): GithubOwner[] | null {
  const [owners, setOwners] = useState<GithubOwner[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .fetchGithubOwners()
      .then((o) => !cancelled && setOwners(o))
      .catch(() => !cancelled && setOwners([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return owners;
}

// Project name → a sane default repo slug (GitHub allows letters/digits/. - _).
const slugRepo = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 100);

export function NewProjectCard({
  onCreate,
}: {
  onCreate: (
    name: string,
    goal: string,
    opts?: { repo?: string; repoPath?: string; createRepo?: { name: string; private: boolean; owner?: string } },
  ) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [mode, setMode] = useState<BindMode>("folder");
  const [repo, setRepo] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoNameTouched, setNewRepoNameTouched] = useState(false);
  const [newRepoOwner, setNewRepoOwner] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [confirming, setConfirming] = useState(false); // new-repo confirm gate
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repos = useConnectedRepos();
  const owners = useRepoOwners();
  const hasRepos = (repos?.length ?? 0) > 0;
  const canCreate = (owners?.length ?? 0) > 0;

  // Default the owner to the authenticated user (first entry) once loaded.
  useEffect(() => {
    if (owners && owners.length && !newRepoOwner) setNewRepoOwner(owners[0]!.login);
  }, [owners, newRepoOwner]);

  // The repo name follows the project name until the operator edits it directly.
  const effectiveRepoName = newRepoNameTouched ? newRepoName : slugRepo(name);
  const repoNameValid = /^[A-Za-z0-9._-]+$/.test(effectiveRepoName);

  const reset = () => {
    setOpen(false);
    setConfirming(false);
    setCreating(false);
    setError(null);
    setName("");
    setGoal("");
    setMode("folder");
    setRepo("");
    setRepoPath("");
    setNewRepoName("");
    setNewRepoNameTouched(false);
  };

  const submit = async (opts: { repo?: string; repoPath?: string; createRepo?: { name: string; private: boolean; owner?: string } }) => {
    setCreating(true);
    setError(null);
    try {
      await onCreate(name.trim(), goal.trim() || "No goal set yet.", opts);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the project.");
      setCreating(false);
    }
  };

  const invalidNew = mode === "new" && (!repoNameValid || !newRepoOwner);
  const invalidExisting = mode === "existing" && !repo;
  const disabled = !name.trim() || invalidNew || invalidExisting;
  const reason = !name.trim()
    ? "Name your project to continue."
    : invalidExisting
      ? "Pick a connected repository."
      : invalidNew
        ? "Enter a valid repository name."
        : "";

  if (!open)
    return (
      <button className="proj proj-new" onClick={() => setOpen(true)}>
        <span className="proj-new-plus">+</span> New project
      </button>
    );

  return (
    <div className="proj proj-new-form">
      <input
        className="qx-input"
        autoFocus
        placeholder="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <textarea
        className="qx-input"
        rows={2}
        placeholder="Goal — what does done look like?"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />

      {(hasRepos || canCreate) && (
        <div className="np-modes" role="tablist" aria-label="Where work happens">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "folder"}
            className={"np-mode" + (mode === "folder" ? " np-mode-on" : "")}
            onClick={() => { setMode("folder"); setError(null); }}
          >
            Local folder
          </button>
          {hasRepos && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === "existing"}
              className={"np-mode" + (mode === "existing" ? " np-mode-on" : "")}
              onClick={() => { setMode("existing"); setError(null); }}
            >
              Existing repo
            </button>
          )}
          {canCreate && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === "new"}
              className={"np-mode" + (mode === "new" ? " np-mode-on" : "")}
              onClick={() => { setMode("new"); setError(null); }}
            >
              New repo
            </button>
          )}
        </div>
      )}

      {mode === "folder" && (
        <>
          <div className="rp-label">Local folder <span className="rp-hint">· runs work here</span></div>
          <FolderPicker value={repoPath} onChange={setRepoPath} />
        </>
      )}
      {mode === "existing" && <RepoPicker repos={repos} value={repo} onChange={setRepo} />}
      {mode === "new" && (
        <div className="np-newrepo">
          <div className="rp-label">New repository <span className="rp-hint">· Skynet creates it on GitHub</span></div>
          <div className="np-newrepo-row">
            <select
              className="rp-select np-owner"
              value={newRepoOwner}
              onChange={(e) => setNewRepoOwner(e.target.value)}
              aria-label="Repository owner"
            >
              {owners?.map((o) => (
                <option key={o.login} value={o.login}>
                  {o.login}{o.type === "org" ? " (org)" : ""}
                </option>
              ))}
            </select>
            <span className="np-slash" aria-hidden="true">/</span>
            <input
              className="qx-input np-reponame"
              placeholder="repo-name"
              value={effectiveRepoName}
              onChange={(e) => { setNewRepoNameTouched(true); setNewRepoName(e.target.value); }}
              aria-label="Repository name"
            />
          </div>
          <label className="np-private">
            <input
              type="checkbox"
              className="proj-autonomy-cb"
              checked={newRepoPrivate}
              onChange={(e) => setNewRepoPrivate(e.target.checked)}
            />
            <span className="proj-autonomy-switch" aria-hidden="true" />
            <span className="np-private-label">{newRepoPrivate ? "Private" : "Public"} repository</span>
          </label>
        </div>
      )}

      {confirming && mode === "new" ? (
        <div className="np-confirm">
          <p className="np-confirm-text">
            Create a new <strong>{newRepoPrivate ? "private" : "public"}</strong> repository{" "}
            <code className="np-confirm-repo">{newRepoOwner}/{effectiveRepoName}</code> on GitHub and bind this project to it?
          </p>
          {error && <div className="np-error">{error}</div>}
          <div className="qx-row">
            <PrimaryButton
              disabled={creating}
              onClick={() => void submit({ createRepo: { name: effectiveRepoName, private: newRepoPrivate, owner: newRepoOwner } })}
            >
              {creating ? "Creating…" : "Create repo & project"}
            </PrimaryButton>
            <button className="btn btn-ghost" disabled={creating} onClick={() => { setConfirming(false); setError(null); }}>
              Back
            </button>
          </div>
        </div>
      ) : (
        <>
          {error && <div className="np-error">{error}</div>}
          <div className="qx-row">
            <PrimaryButton
              disabled={disabled || creating}
              reason={reason}
              onClick={() => {
                if (mode === "new") { setConfirming(true); return; } // gate the outward-facing repo creation
                void submit({
                  repo: mode === "existing" ? repo || undefined : undefined,
                  repoPath: mode === "folder" ? repoPath || undefined : undefined,
                });
              }}
            >
              {creating ? "Creating…" : mode === "new" ? "Review & create" : "Create project"}
            </PrimaryButton>
            <button className="btn btn-ghost" onClick={reset}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function OverviewView({
  now,
  onOpenProject,
  onCreate,
}: {
  now: number;
  onOpenProject: (id: string) => void;
  onCreate: (name: string, goal: string, opts?: { repo?: string; repoPath?: string }) => void;
}) {
  const { projects, runs, queue } = useStore();
  const oq = openQueue(queue);
  const running = runs.filter((a) => a.status === "running").length;
  const longest = oq.length ? Math.max(...oq.map((q) => waitedSecs(q, now))) : 0;

  const sorted = [...projects].sort((a, b) => {
    const w = (p: Project) =>
      oq.filter((q) => agentsForProject(runs, p.id).some((x) => x.id === q.runId))
        .length;
    const d = (p: Project) => {
      const pa = agentsForProject(runs, p.id);
      return pa.length > 0 && pa.every((x) => x.status === "done") ? 1 : 0;
    };
    return d(a) - d(b) || w(b) - w(a);
  });

  return (
    <section className="overview">
      <div className="ov-head">
        <h1>Ongoing projects</h1>
        <p className="ov-sub">
          {running} runs running ·{" "}
          {oq.length > 0 ? (
            <span className="ov-sub-warn">
              {oq.length} decisions waiting on you — longest {fmtWait(longest)}
            </span>
          ) : (
            "nothing waiting on you"
          )}
        </p>
      </div>
      <div className="ov-grid">
        <NewProjectCard onCreate={onCreate} />
        {sorted.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            now={now}
            onOpen={() => onOpenProject(p.id)}
          />
        ))}
      </div>
    </section>
  );
}
