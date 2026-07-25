import { useEffect, useState } from "react";
import * as api from "../lib/client";
import { Markdown } from "../components/markdown";

// ROADMAP.md as its own page — the plan is visible product truth, not a file only
// contributors see. Rendered full-width with real nesting + per-item status
// (checkbox markers in the doc: [x] shipped · [~] in progress · [ ] planned).
export function RoadmapView() {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .fetchRoadmap()
      .then((r) => live && setMd(r.markdown))
      .catch(() => live && setErr(true));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="vw roadmap-vw">
      <div className="vw-head">
        <h1>Roadmap</h1>
        <p>
          What's shipping and what's next. <strong>v0 is committed scope</strong>; later versions are
          directional and will be reordered as we learn. Each item is tagged with its status.
        </p>
      </div>

      <div className="roadmap-legend">
        <span className="md-status md-st-done"><span className="md-status-mark">✓</span>shipped</span>
        <span className="md-status md-st-wip"><span className="md-status-mark">◐</span>in progress</span>
        <span className="md-status md-st-todo"><span className="md-status-mark">○</span>planned</span>
      </div>

      {err ? (
        <p className="roadmap-err">Couldn't load the roadmap — see ROADMAP.md in the repository.</p>
      ) : md === null ? (
        <p className="roadmap-err">Loading…</p>
      ) : (
        <div className="roadmap-doc">
          <Markdown text={md} foldShipped />
        </div>
      )}
    </section>
  );
}
