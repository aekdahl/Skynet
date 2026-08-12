import { useEffect, useState } from "react";
import type { Project } from "@skynet/shared";
import * as api from "../lib/client";
import { countStatuses, headingIsShipped, inline, parseMarkdown, renderBlocks, sectionsFromBlocks, type Block } from "../components/markdown";
import { Ring } from "./project-grouping";

// The project-detail "Roadmap" tab: ROADMAP.md (or docs/ROADMAP.md), read
// straight from the project's bound repo — no DB record, no hand-entered
// milestones, always in sync with what's actually in the repo. Shipped `##`
// sections collapse to a ring; the first section that ISN'T fully done starts
// open (the "current" phase); everything after stays collapsed.

function RoadmapEmptyState({ result, onRetry }: { result: Exclude<api.ProjectRoadmapResult, { state: "ok" }>; onRetry: () => void }) {
  switch (result.state) {
    case "unbound":
      return <div className="kb-empty">Connect a local folder or GitHub repo in ⚙ Settings to show its roadmap here.</div>;
    case "missing_local_repo":
      return <div className="kb-empty">This project's local folder isn't on disk — reclone or fix the path in Settings.</div>;
    case "not_found":
      return (
        <div className="kb-empty">
          No ROADMAP.md (or docs/ROADMAP.md) in this repo.
          <button className="btn btn-ghost btn-sm" onClick={onRetry}>Retry</button>
        </div>
      );
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
  if (doc.state !== "ok") return <RoadmapEmptyState result={doc} onRetry={() => setNonce((n) => n + 1)} />;

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
