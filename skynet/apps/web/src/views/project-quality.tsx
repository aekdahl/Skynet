import { useEffect, useState } from "react";
import type { Project, ProjectQualityResult, ScenarioAxis } from "@skynet/shared";
import * as api from "../lib/client";
import { CoverageTree } from "../components/coverage-tree";

// The project-detail "Coverage" tab — scenario coverage for the checked-out
// branch. Answers the question line coverage can't: which of the codebase's
// enumerable behaviour sets (union types, zod enums — the closed sets it
// branches on) do the tests exercise at all.
//
// The panel leads with the GAPS, not a score. That's deliberate and matches
// what the underlying signal can actually support: a case the tests never
// mention is almost certainly untested (strong), while a case they do mention
// is only proof of mention, not of assertion (weak). Presenting this as a
// quality percentage would overclaim the second half; presenting it as a list
// of untested cases claims only the first.

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function AxisRow({ axis }: { axis: ScenarioAxis }) {
  const gaps = axis.cases.filter((c) => !c.covered);
  return (
    <div className={"qa-axis" + (gaps.length > 0 ? " qa-axis-gap" : "")}>
      <div className="qa-axis-head">
        <span className="qa-axis-name mono">{axis.name}</span>
        <span className="qa-axis-kind">{axis.kind}</span>
        <span className="qa-axis-file mono" title={axis.file}>{axis.file}</span>
        <span className={"qa-axis-count mono" + (gaps.length > 0 ? " qa-count-gap" : "")}>
          {axis.covered}/{axis.total}
        </span>
      </div>
      <div className="qa-cases">
        {axis.cases.map((c) => (
          <span
            key={c.value}
            className={"qa-case " + (c.covered ? "qa-case-on" : "qa-case-off")}
            title={c.covered ? "mentioned somewhere in the tests" : "never mentioned in any test"}
          >
            {c.value}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ProjectQualityView({ project }: { project: Project }) {
  const [res, setRes] = useState<ProjectQualityResult | null>(null); // null = loading
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [showAll, setShowAll] = useState(false);
  // Tree first: the panel exists to make gaps graspable, and "which
  // subsystems are unpinned" is the question a flat ranked list can't answer.
  const [mode, setMode] = useState<"tree" | "list">("tree");

  useEffect(() => {
    let live = true;
    setRes(null);
    setErr(null);
    api
      .fetchProjectQuality(project.id)
      .then((r) => live && setRes(r))
      .catch((e: unknown) => live && setErr((e as Error)?.message || "Couldn't scan the repo."));
    return () => {
      live = false;
    };
  }, [project.id, nonce]);

  if (err) return <div className="prd-path-err">{err}</div>;
  if (res === null) return <div className="kb-empty">Scanning the branch…</div>;
  if (res.state === "unbound")
    return <div className="kb-empty">Connect a local folder or GitHub repo in ⚙ Settings to scan it.</div>;
  if (res.state === "missing_local_repo")
    return (
      <div className="kb-empty">
        This project has no local checkout on disk to scan. The scan reads the working tree directly, so a
        GitHub-only project needs cloning first.
      </div>
    );

  const q = res.quality;
  const withGaps = q.axes.filter((a) => a.covered < a.total);
  const shown = showAll ? q.axes : withGaps;

  return (
    <div className="qa">
      <div className="qa-head">
        <div>
          <h2 className="vw-h">Scenario coverage</h2>
          <p className="qa-sub">
            The closed sets this code branches on — union types and enums — and whether the tests exercise each
            case. {q.sourceFiles} source · {q.testFiles} test files · {q.behaviourCount} behaviours asserted.
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setNonce((n) => n + 1)}>
          Re-scan
        </button>
      </div>

      <div className="qa-stats">
        <div className="qa-stat">
          <span className="qa-stat-num mono">{withGaps.length}</span>
          <span className="qa-stat-lbl">sets with an untested case</span>
        </div>
        <div className="qa-stat">
          <span className="qa-stat-num mono">{q.totalCases - q.coveredCases}</span>
          <span className="qa-stat-lbl">cases no test mentions</span>
        </div>
        <div className="qa-stat">
          <span className="qa-stat-num mono">
            {q.coverage ? `${Math.round(q.coverage.lines)}%` : "—"}
          </span>
          <span className="qa-stat-lbl">
            {q.coverage ? "line coverage" : "line coverage not configured"}
          </span>
        </div>
      </div>

      {/* The method's own limits, stated where the numbers are read rather than
          buried in docs — an operator acting on this needs to know which half
          of the signal is trustworthy. */}
      <div className="qa-caveat">
        A case the tests never mention is a strong signal it's untested. A case they <em>do</em> mention only
        proves mention — not that anything is asserted about it. Read this as a gap-finder, not a score.
      </div>

      {q.axes.length === 0 ? (
        <div className="kb-empty">
          No enumerable behaviour sets found. This scan looks for TypeScript string-literal unions and zod
          enums; a repo in another language, or one that models states differently, won't register here.
        </div>
      ) : (
        <>
          <div className="qa-modes">
            {(["tree", "list"] as const).map((m) => (
              <button
                key={m}
                className={"qa-mode" + (mode === m ? " qa-mode-on" : "")}
                onClick={() => setMode(m)}
              >
                {m === "tree" ? "Where the gaps are" : "Worst sets first"}
              </button>
            ))}
          </div>
          {mode === "tree" ? (
            <CoverageTree axes={q.axes} />
          ) : (
            <>
              <div className="qa-listhead">
                <span className="qa-listhead-t">
                  {showAll ? `All ${q.axes.length} sets` : `${withGaps.length} of ${q.axes.length} sets have a gap`}
                </span>
                <button className="qa-toggle" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Show only gaps" : "Show all"}
                </button>
              </div>
              {shown.length === 0 ? (
                <div className="kb-empty">Every enumerable case is mentioned by at least one test.</div>
              ) : (
                <div className="qa-axes">
                  {shown.map((a) => (
                    <AxisRow key={a.name + a.file} axis={a} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {q.coverage == null && (
        <div className="qa-hint">
          <b>No line coverage yet.</b> Add <code className="mono">coverage: {"{ enabled: true, reporter: ['json-summary'] }"}</code> to
          this project's Vitest config (or the equivalent for its runner) and this panel picks the summary up
          automatically — it reads <code className="mono">coverage/coverage-summary.json</code>, it never runs
          your tests itself.
        </div>
      )}
      {q.coverage && (
        <div className="qa-hint">
          Line {pct(q.coverage.lines / 100)} · branch {pct(q.coverage.branches / 100)} · function{" "}
          {pct(q.coverage.functions / 100)} — read from <code className="mono">{q.coverage.path}</code>. Line
          coverage says which code <em>ran</em>, not which behaviour is <em>pinned</em>; the gaps above are the
          stronger signal.
        </div>
      )}
    </div>
  );
}
