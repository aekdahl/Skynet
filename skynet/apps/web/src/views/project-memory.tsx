import { useEffect, useState } from "react";
import type { MemoryFactSummary, MemoryScope, Project } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import "../kanban/project-memory.css";

// Memory v0, phase 1 — operator-authored facts, git-committed to
// `.skynet/memory/*.md` (docs/memory-format.md), injected verbatim into
// every vendor's run through buildAgentContext's === MEMORY === section
// (agent-context.ts / orchestrator.ts's memoryDigestFor). No LLM
// distillation here — that's v4; no decision-derived capture either — that's
// phase 2. This tab is the operator's own read+write surface: list what's
// recorded, and add a new fact by hand.

const SCOPE_LABEL: Record<MemoryScope, string> = {
  workspace: "Workspace",
  project: "Project",
  area: "Area",
  agent: "Agent",
};

function FactRow({ fact }: { fact: MemoryFactSummary }) {
  return (
    <div className={`pmem-fact${fact.superseded ? " pmem-fact-superseded" : ""}`}>
      <div className="pmem-fact-head">
        <span className="pmem-fact-scope">{SCOPE_LABEL[fact.scope]}{fact.agentFamily ? ` · ${fact.agentFamily}` : fact.area ? ` · ${fact.area}` : ""}</span>
        <span className="pmem-fact-meta">{fact.author} · {new Date(fact.createdAt).toLocaleDateString()}</span>
      </div>
      <div className="pmem-fact-heading">{fact.heading}</div>
      {fact.body && <div className="pmem-fact-body">{fact.body}</div>}
      {fact.superseded && <div className="pmem-fact-superseded-note">Superseded by a later fact</div>}
    </div>
  );
}

function AddFactForm({ project, onAdded }: { project: Project; onAdded: (fact: MemoryFactSummary) => void }) {
  const { providers } = useStore();
  const [scope, setScope] = useState<MemoryScope>("workspace");
  const [agentFamily, setAgentFamily] = useState<string>(providers[0]?.id ?? "claude");
  const [area, setArea] = useState("");
  const [heading, setHeading] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!heading.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const fact = await api.addMemoryFact(project.id, {
        scope,
        heading: heading.trim(),
        body,
        area: scope === "area" ? area.trim() || null : null,
        agentFamily: scope === "agent" ? agentFamily : null,
        supersedes: null,
      });
      onAdded(fact);
      setHeading("");
      setBody("");
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't record that fact.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pmem-add">
      <div className="pmem-add-row">
        <select className="qx-input" value={scope} onChange={(e) => setScope(e.target.value as MemoryScope)}>
          {(["workspace", "project", "agent", "area"] as const).map((s) => (
            <option key={s} value={s}>{SCOPE_LABEL[s]}</option>
          ))}
        </select>
        {scope === "agent" && (
          <select className="qx-input" value={agentFamily} onChange={(e) => setAgentFamily(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
        {scope === "area" && (
          <input className="qx-input" placeholder="Area name" value={area} onChange={(e) => setArea(e.target.value)} />
        )}
      </div>
      <input
        className="qx-input"
        placeholder="The fact, in one line — e.g. 'Never touch payments without a human review'"
        value={heading}
        onChange={(e) => setHeading(e.target.value)}
      />
      <textarea
        className="qx-input pmem-add-body"
        placeholder="Optional elaboration"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
      />
      <div className="pmem-add-actions">
        <button className="btn btn-primary btn-sm" disabled={busy || !heading.trim() || (scope === "area" && !area.trim())} onClick={submit}>
          {busy ? "Recording…" : "Record fact"}
        </button>
        {err && <span className="pmem-add-err">{err}</span>}
      </div>
    </div>
  );
}

export function ProjectMemoryView({ project }: { project: Project }) {
  const [facts, setFacts] = useState<MemoryFactSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .fetchProjectMemory(project.id)
      .then((f) => live && setFacts(f))
      .catch((e: unknown) => live && setErr((e as Error)?.message || "Couldn't load memory."));
    return () => {
      live = false;
    };
  }, [project.id]);

  if (!project.repoPath && !project.repo) {
    return <div className="kb-empty">Bind this project to a repo to record memory — facts are committed as plain markdown, not stored in a database.</div>;
  }
  if (err) return <div className="kb-empty">{err}</div>;
  if (!facts) return <div className="kb-empty">Loading…</div>;

  return (
    <div className="pmem">
      <div className="pmem-intro">
        Operator-authored facts, injected into every agent's run for this project. Plain markdown, committed to
        <code> .skynet/memory/</code> in the repo — export it, read it, edit it by hand; nothing here is locked in a database.
      </div>
      <AddFactForm project={project} onAdded={(f) => setFacts((prev) => [f, ...(prev ?? [])])} />
      {facts.length === 0 ? (
        <div className="kb-empty">No facts recorded yet.</div>
      ) : (
        <div className="pmem-list">
          {facts.map((f) => (
            <FactRow key={f.id} fact={f} />
          ))}
        </div>
      )}
    </div>
  );
}
