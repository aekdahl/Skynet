import { useEffect, useState } from "react";
import type { Project } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import { countStatuses, headingIsShipped, inline, parseMarkdown, renderBlocks, sectionsFromBlocks, type Block } from "../components/markdown";
import { Ring } from "./project-grouping";

// The project-detail "Roadmap" tab: ROADMAP.md (or docs/ROADMAP.md), read
// straight from the project's bound repo — no DB record, no hand-entered
// milestones, always in sync with what's actually in the repo. Shipped `##`
// sections collapse to a ring; the first section that ISN'T fully done starts
// open (the "current" phase); everything after stays collapsed.
//
// When neither default candidate exists, `Project.roadmapPath` lets the
// operator (via RoadmapPathPicker below) — or Steward, via a confirmed
// `set_roadmap_path` chat action, same field — point the tab at the real file.

/** Typed a path + saved it, or cleared the override back to the default
 *  candidates. The empty state for "not_found" — shown either because
 *  there's no roadmap doc at all, or because an existing override now points
 *  at a file that's gone missing (renamed/deleted since it was set). */
function RoadmapPathPicker({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const { updateProject } = useStore();
  const [path, setPath] = useState(project.roadmapPath ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (next: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      await updateProject(project.id, { roadmapPath: next });
      onSaved();
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't save that path.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kb-empty">
      {project.roadmapPath
        ? `No file at "${project.roadmapPath}" in this repo anymore.`
        : "No ROADMAP.md (or docs/ROADMAP.md) in this repo."}{" "}
      Point this tab at the real one — or ask Steward, e.g. "the roadmap is at docs/PLAN.md".
      <div className="prd-path-picker">
        <input
          className="qx-input"
          placeholder="e.g. docs/PLAN.md"
          value={path}
          disabled={busy}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && path.trim() && !busy && save(path.trim())}
        />
        <button className="btn btn-primary btn-sm" disabled={!path.trim() || busy} onClick={() => save(path.trim())}>
          Use this file
        </button>
        {project.roadmapPath && (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setPath(""); void save(null); }}>
            Clear override
          </button>
        )}
      </div>
      {err && <div className="prd-path-err">{err}</div>}
    </div>
  );
}

function RoadmapEmptyState({
  result,
  project,
  onRetry,
}: {
  result: Exclude<api.ProjectRoadmapResult, { state: "ok" }>;
  project: Project;
  onRetry: () => void;
}) {
  switch (result.state) {
    case "unbound":
      return <div className="kb-empty">Connect a local folder or GitHub repo in ⚙ Settings to show its roadmap here.</div>;
    case "missing_local_repo":
      return <div className="kb-empty">This project's local folder isn't on disk — reclone or fix the path in Settings.</div>;
    case "not_found":
      return <RoadmapPathPicker project={project} onSaved={onRetry} />;
    case "github_error":
      return (
        <div className="kb-empty">
          Couldn't read the repo ({result.message}) — check the project's GitHub connection in Settings.
          <button className="btn btn-ghost btn-sm" onClick={onRetry}>Retry</button>
        </div>
      );
  }
}

function RoadmapPhase({
  index,
  heading,
  body,
  shipped,
  defaultOpen,
  linkBase,
}: {
  index: number;
  heading: string;
  body: Block[];
  shipped: boolean;
  defaultOpen: boolean;
  linkBase: string | undefined;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const title = heading.replace(/✓\s*shipped/i, "").trim();
  const { done, total } = countStatuses(body);
  const pct = total > 0 ? Math.round((done / total) * 100) : shipped ? 100 : 0;
  const color = shipped ? "var(--ok)" : total > 0 && done > 0 ? "var(--accent)" : "var(--line)";
  return (
    <div className={"prd-phase" + (shipped ? " prd-phase-shipped" : "") + (!shipped && open ? " prd-phase-current" : "")}>
      <button type="button" className="prd-phase-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="prd-phase-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <Ring pct={pct} color={color} />
        <span className="prd-phase-title">{inline(title, `prd-h-${index}`, linkBase)}</span>
        {!shipped && open && <span className="prd-phase-pill">current</span>}
        {total > 0 && (
          <span className="prd-phase-frac mono">{done}/{total}</span>
        )}
      </button>
      {open && <div className="prd-phase-body">{renderBlocks(body, `prd-${index}`, linkBase)}</div>}
    </div>
  );
}

export function RoadmapDocView({ project }: { project: Project }) {
  const [doc, setDoc] = useState<api.ProjectRoadmapResult | null>(null); // null = loading
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .fetchProjectRoadmap(project.id)
      .then((r) => live && setDoc(r))
      .catch((e: unknown) => live && setDoc({ state: "github_error", message: (e as Error)?.message || "network error" }));
    return () => {
      live = false;
    };
  }, [project.id, nonce]);

  // Steward's confirm-first edit commits, then dispatches this so an open tab
  // reflects the change immediately without a manual refresh.
  useEffect(() => {
    const onUpdated = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string }>).detail;
      if (detail?.projectId === project.id) setNonce((n) => n + 1);
    };
    window.addEventListener("skynet:roadmap-updated", onUpdated);
    return () => window.removeEventListener("skynet:roadmap-updated", onUpdated);
  }, [project.id]);

  if (doc === null) return <div className="kb-empty">Loading roadmap…</div>;
  if (doc.state !== "ok") return <RoadmapEmptyState result={doc} project={project} onRetry={() => setNonce((n) => n + 1)} />;

  const linkBase = project.repo ? `https://github.com/${project.repo}/blob/${project.baseBranch || "main"}/` : undefined;
  const blocks = parseMarkdown(doc.content);
  const { lead, sections } = sectionsFromBlocks(blocks);
  const shipped = sections.map((s) => {
    const { done, total } = countStatuses(s.body);
    return headingIsShipped(s.heading) || (total > 0 && done === total);
  });
  const firstCurrent = shipped.findIndex((s) => !s);
  const openIdx = firstCurrent === -1 ? 0 : firstCurrent;

  return (
    <div className="prd">
      <div className="prd-source mono">
        synced from {doc.path} · {doc.source === "local" ? "local checkout" : "GitHub"}
      </div>
      {lead.length > 0 && <div className="prd-lead md">{renderBlocks(lead, "prd-lead", linkBase)}</div>}
      <div className="prd-spine">
        {sections.map((s, i) => (
          <RoadmapPhase
            key={i}
            index={i}
            heading={s.heading}
            body={s.body}
            shipped={shipped[i]!}
            defaultOpen={i === openIdx}
            linkBase={linkBase}
          />
        ))}
      </div>
    </div>
  );
}
