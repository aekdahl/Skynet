// ─── Diff grouping by intent (Review & Merge, Phase 15) ────────────────────
// "Grouped by intent, not by file" — a mechanical derivation over the diff
// hunks (per-file +/- parsed from the raw patch, files bucketed by the
// project's own module map), not an LLM semantic grouper. Reuses the SAME
// module map that already resolves HitlItem.diff.modules — a module is a
// reasonable, already-available proxy for "what part of the system this
// touches", without inventing a second classification axis.

import type { DiffGroup } from "@skynet/shared";
import type { ModuleMap } from "./modules-map.js";

interface FileDiffStat {
  file: string;
  add: number;
  del: number;
}

/** Per-file added/deleted line counts, parsed straight from a unified diff's
 *  hunks (mirrors DiffView's client-side parser, server-side). Best-effort:
 *  a segment with no readable path is silently skipped rather than thrown. */
function perFileStats(patch: string): FileDiffStat[] {
  const out: FileDiffStat[] = [];
  const segments = patch.split(/^diff --git /m).slice(1); // drop anything before the first file
  for (const seg of segments) {
    let file = "";
    let add = 0;
    let del = 0;
    for (const line of seg.split("\n")) {
      if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        if (p !== "/dev/null") file = p.replace(/^b\//, "");
      } else if (!file && line.startsWith("--- ")) {
        const p = line.slice(4).trim();
        if (p !== "/dev/null") file = p.replace(/^a\//, "");
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        add++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        del++;
      }
    }
    if (file) out.push({ file, add, del });
  }
  return out;
}

const UNGROUPED_TITLE = "Other changes";

/** Bucket a diff's files into intent-ish groups (module name, files, +/-),
 *  largest group first. Empty for an empty/unparseable patch — the raw diff
 *  and file list are always still available regardless. */
export function groupDiffByIntent(patch: string, moduleMap: ModuleMap): DiffGroup[] {
  const stats = perFileStats(patch);
  if (!stats.length) return [];
  const names = new Map(moduleMap.catalog().map((m) => [m.id, m.name]));
  const byModule = new Map<string, DiffGroup>();
  for (const s of stats) {
    const modId = moduleMap.moduleForFile(s.file);
    const key = modId ?? "__ungrouped__";
    const title = modId ? (names.get(modId) ?? modId) : UNGROUPED_TITLE;
    const g = byModule.get(key) ?? { title, files: [], add: 0, del: 0 };
    g.files.push(s.file);
    g.add += s.add;
    g.del += s.del;
    byModule.set(key, g);
  }
  return [...byModule.values()].sort((a, b) => b.add + b.del - (a.add + a.del));
}
