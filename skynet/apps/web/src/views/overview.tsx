import { useState } from "react";
import type { Project } from "@skynet/shared";
import { useStore } from "../lib/store";
import {
  agentsForProject,
  backlogTasks,
  conflictModulesForAgent,
  fmtWait,
  modName,
  openQueue,
  waitedSecs,
} from "../lib/derive";
import { Bar, StatusDot } from "../components/common";

function ProjectCard({
  project,
  now,
  onOpen,
}: {
  project: Project;
  now: number;
  onOpen: () => void;
}) {
  const { agents, queue, tasks, modules } = useStore();
  const pa = agentsForProject(agents, project.id);
  const waiting = openQueue(queue).filter((q) =>
    pa.some((a) => a.id === q.agentId),
  );
  const allDone = pa.length > 0 && pa.every((a) => a.status === "done");
  const empty = pa.length === 0;
  const prog = pa.length
    ? pa.reduce((n, a) => n + a.progress, 0) / pa.length
    : 0;
  const backlog = backlogTasks(tasks, project.id);
  const conflictAgent = pa.find(
    (a) => conflictModulesForAgent(a, agents).length > 0,
  );
  const conflictMod = conflictAgent
    ? conflictModulesForAgent(conflictAgent, agents)[0]
    : undefined;

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
      <Bar
        value={prog}
        status={waiting.length > 0 ? "waiting" : allDone ? "done" : "running"}
      />
      <div className="proj-agents">
        {pa.map((a) => {
          const q = waiting.find((it) => it.agentId === a.id);
          return (
            <div key={a.id} className="proj-agent">
              <StatusDot status={a.status} />
              <span className="proj-agent-name">{a.name}</span>
              <span className="proj-agent-state mono">
                {q
                  ? "waiting " + fmtWait(waitedSecs(q, now))
                  : a.status === "done"
                    ? "merged"
                    : Math.round(a.progress * 100) + "%"}
              </span>
            </div>
          );
        })}
        {backlog.length > 0 && (
          <div className="proj-backlog mono">○ {backlog.length} in backlog</div>
        )}
        {empty && backlog.length === 0 && (
          <div className="proj-backlog mono">No tasks yet — open to add some</div>
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

export function NewProjectCard({
  onCreate,
}: {
  onCreate: (name: string, goal: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
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
      <div className="qx-row">
        <button
          className="btn btn-primary"
          disabled={!name.trim()}
          onClick={() => {
            onCreate(name.trim(), goal.trim() || "No goal set yet.");
            setOpen(false);
            setName("");
            setGoal("");
          }}
        >
          Create project
        </button>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
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
  onCreate: (name: string, goal: string) => void;
}) {
  const { projects, agents, queue } = useStore();
  const oq = openQueue(queue);
  const running = agents.filter((a) => a.status === "running").length;
  const longest = oq.length ? Math.max(...oq.map((q) => waitedSecs(q, now))) : 0;

  const sorted = [...projects].sort((a, b) => {
    const w = (p: Project) =>
      oq.filter((q) => agentsForProject(agents, p.id).some((x) => x.id === q.agentId))
        .length;
    const d = (p: Project) => {
      const pa = agentsForProject(agents, p.id);
      return pa.length > 0 && pa.every((x) => x.status === "done") ? 1 : 0;
    };
    return d(a) - d(b) || w(b) - w(a);
  });

  return (
    <section className="overview">
      <div className="ov-head">
        <h1>Ongoing projects</h1>
        <p className="ov-sub">
          {running} agents running ·{" "}
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
