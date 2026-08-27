// ─── Coverage tree ──────────────────────────────────────────────────────────
// Derives a directory hierarchy from a flat list of scenario axes, so the
// Coverage panel can answer "WHERE in the system are the gaps?" and not just
// "which sets have one".
//
// The flat list is sorted by gap size, which is the right order for "what do I
// fix next" — but it dissolves structure. Forty-four rows can't tell you that
// every gap sits in `evals/` and `preview/` while the orchestrator is fully
// pinned. That clustering is the actual signal about how well a system is
// understood, and it's a property of the tree, not of any row.
//
// Nothing here needs new server work: every axis already carries the
// repo-relative path it was declared in, and paths are a tree.
//
// ── The honesty problem a tree creates ─────────────────────────────────────
// Rolling up turns a weak signal into an authoritative-looking one. `40/60` on
// `apps/server/` reads as "this subsystem is tested" when it only means "every
// case is mentioned somewhere in the suite" — mention is not assertion (see
// scenarios.ts). So the roll-ups here deliberately count and expose GAPS as the
// primary number; the UI colours those and leaves "covered" neutral rather than
// green. A tree that renders reassurance it hasn't earned is worse than no tree.

import type { ScenarioAxis } from "./contracts.js";

export interface CoverageNode {
  /** Display label. Collapsed directory chains join their segments with "/". */
  name: string;
  /** Full repo-relative path — the stable key for expand/collapse state. */
  path: string;
  kind: "dir" | "file" | "axis";
  /** Cases the tests mention at all, summed over this subtree. */
  covered: number;
  /** Enumerable cases in this subtree. */
  total: number;
  /** `total - covered`, precomputed because it's what the UI ranks and colours by. */
  gaps: number;
  /** Set only on an `axis` leaf, so the UI can render its individual cases. */
  axis?: ScenarioAxis;
  children: CoverageNode[];
}

interface Building {
  name: string;
  path: string;
  kind: "dir" | "file" | "axis";
  axis?: ScenarioAxis;
  childMap: Map<string, Building>;
  axes: ScenarioAxis[];
}

const node = (name: string, path: string, kind: "dir" | "file" | "axis"): Building => ({
  name,
  path,
  kind,
  childMap: new Map(),
  axes: [],
});

/**
 * PURE: fold a flat axis list into a directory → file → axis tree.
 *
 * Single-child directory chains are collapsed (`apps/server/src` renders as one
 * row, not three), because deep nesting with nothing to choose between at each
 * level is noise — the operator is looking for where gaps cluster, and an
 * un-branching chain carries no clustering information.
 *
 * Siblings sort by gap count descending, then by name, matching the flat list's
 * "lead with the gaps" ordering so the two views agree about what matters.
 */
export function buildCoverageTree(axes: ScenarioAxis[]): CoverageNode {
  const root = node("", "", "dir");

  for (const axis of axes) {
    const segments = axis.file.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    const fileName = segments[segments.length - 1]!;
    const dirs = segments.slice(0, -1);

    let cur = root;
    const walked: string[] = [];
    for (const seg of dirs) {
      walked.push(seg);
      const path = walked.join("/");
      let next = cur.childMap.get(seg);
      if (!next) {
        next = node(seg, path, "dir");
        cur.childMap.set(seg, next);
      }
      cur = next;
    }
    let file = cur.childMap.get(fileName);
    if (!file) {
      file = node(fileName, axis.file, "file");
      cur.childMap.set(fileName, file);
    }
    file.axes.push(axis);
  }

  const finish = (b: Building): CoverageNode => {
    const children: CoverageNode[] = [];
    for (const child of b.childMap.values()) children.push(finish(child));
    // A file's axes become its leaves. Two axes can share a name across files,
    // so the leaf key is the file path plus the axis name.
    for (const axis of b.axes) {
      children.push({
        name: axis.name,
        path: `${b.path}#${axis.name}`,
        kind: "axis",
        covered: axis.covered,
        total: axis.total,
        gaps: axis.total - axis.covered,
        axis,
        children: [],
      });
    }
    children.sort((x, y) => y.gaps - x.gaps || x.name.localeCompare(y.name));

    let out: CoverageNode = {
      name: b.name,
      path: b.path,
      kind: b.kind,
      covered: children.reduce((n, c) => n + c.covered, 0),
      total: children.reduce((n, c) => n + c.total, 0),
      gaps: 0,
      children,
    };
    out.gaps = out.total - out.covered;

    // Collapse an un-branching directory chain into a single row.
    if (out.kind === "dir" && out.children.length === 1 && out.children[0]!.kind === "dir" && out.name) {
      const only = out.children[0]!;
      out = { ...only, name: `${out.name}/${only.name}` };
    }
    return out;
  };

  const built = finish(root);
  // The root itself is a synthetic container, never rendered as a row — but it
  // may have collapsed into its only child above, which would hide real levels.
  // Re-derive it from the original children so the top level stays honest.
  if (built.path !== "") {
    const kids = [...root.childMap.values()].map(finish);
    kids.sort((x, y) => y.gaps - x.gaps || x.name.localeCompare(y.name));
    const covered = kids.reduce((n, c) => n + c.covered, 0);
    const total = kids.reduce((n, c) => n + c.total, 0);
    return { name: "", path: "", kind: "dir", covered, total, gaps: total - covered, children: kids };
  }
  return built;
}

/** Every node path from the root down to any node that has a gap. Lets the UI
 *  open straight to the problems instead of making the operator hunt for them. */
export function pathsToGaps(root: CoverageNode): string[] {
  const open: string[] = [];
  const visit = (n: CoverageNode): boolean => {
    let hasGapBelow = false;
    for (const c of n.children) if (visit(c)) hasGapBelow = true;
    const relevant = hasGapBelow || (n.kind === "axis" && n.gaps > 0);
    if (relevant && n.kind !== "axis" && n.path) open.push(n.path);
    return relevant;
  };
  visit(root);
  return open;
}
