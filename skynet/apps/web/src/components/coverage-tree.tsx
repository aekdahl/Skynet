import { useMemo, useState } from "react";
import { buildCoverageTree, pathsToGaps, type CoverageNode, type ScenarioAxis } from "@skynet/shared";

// The "where are the gaps" view. The flat list beside it ranks individual sets
// by gap size — the right order for picking the next thing to test — but it
// dissolves structure: forty-odd rows can't show that every gap sits in two
// subsystems while the orchestrator is fully pinned. That clustering is what
// tells you whether an AREA is understood, and it only exists in the hierarchy.
//
// Colour rule, deliberately asymmetric (see coverage-tree.ts / scenarios.ts):
// gaps are coloured, covered is left NEUTRAL — never green. A roll-up says
// "every case is mentioned somewhere in the suite", which is not the same as
// "this subsystem is tested", and a green bar would quietly claim the stronger
// thing. The bar therefore fills by GAP, so a clean subtree reads as plain and
// unremarkable rather than as a reassurance the data can't support.

function Bar({ covered, total }: { covered: number; total: number }) {
  const gapPct = total > 0 ? ((total - covered) / total) * 100 : 0;
  return (
    <span className="qt-bar" title={`${total - covered} of ${total} cases unmentioned`}>
      <span className="qt-bar-fill" style={{ width: `${gapPct}%` }} />
    </span>
  );
}

function Cases({ axis }: { axis: ScenarioAxis }) {
  return (
    <div className="qt-cases">
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
  );
}

function Row({
  node,
  depth,
  open,
  toggle,
}: {
  node: CoverageNode;
  depth: number;
  open: Set<string>;
  toggle: (path: string) => void;
}) {
  const isOpen = open.has(node.path);
  const expandable = node.children.length > 0 || node.kind === "axis";
  const clean = node.gaps === 0;

  return (
    <>
      <button
        type="button"
        className={"qt-row" + (clean ? " qt-row-clean" : "")}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => expandable && toggle(node.path)}
        aria-expanded={expandable ? isOpen : undefined}
      >
        <span className={"qt-caret" + (expandable ? "" : " qt-caret-none")}>{isOpen ? "▾" : "▸"}</span>
        <span className={"qt-name mono" + (node.kind === "axis" ? " qt-name-axis" : "")}>{node.name}</span>
        {node.kind === "axis" && <span className="qa-axis-kind">{node.axis!.kind}</span>}
        <span className="qt-spacer" />
        {node.gaps > 0 && <span className="qt-gaps">{node.gaps} untested</span>}
        <span className="qt-count mono">
          {node.covered}/{node.total}
        </span>
        <Bar covered={node.covered} total={node.total} />
      </button>
      {isOpen && node.kind === "axis" && <Cases axis={node.axis!} />}
      {isOpen &&
        node.children.map((c) => <Row key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} />)}
    </>
  );
}

export function CoverageTree({ axes }: { axes: ScenarioAxis[] }) {
  const root = useMemo(() => buildCoverageTree(axes), [axes]);
  // Open straight to the problems. Making an operator hunt through collapsed
  // directories for the thing the panel exists to surface would be a strange
  // default — so every branch leading to a gap starts expanded, and clean
  // subtrees stay folded away.
  const [open, setOpen] = useState<Set<string>>(() => new Set(pathsToGaps(root)));

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  if (root.children.length === 0) return null;

  return (
    <div className="qt">
      <div className="qa-listhead">
        <span className="qa-listhead-t">Where the gaps are</span>
        <button className="qa-toggle" onClick={() => setOpen(new Set(pathsToGaps(root)))}>
          Reset to gaps
        </button>
      </div>
      <div className="qt-rows">
        {root.children.map((c) => (
          <Row key={c.path} node={c} depth={0} open={open} toggle={toggle} />
        ))}
      </div>
    </div>
  );
}
