// ─── Markdown checklist parse + flip (repo-file task sync) ──────────────────
// PURE helpers for Phase 2 of task ↔ source sync (docs/task-source-sync.md): a
// task imported from a repo file (a `- [ ] …` checklist item, e.g. in TODO.md)
// is anchored by its LABEL, and its checkbox is flipped on the file when the
// Skynet task completes / reopens. Anchoring by label (not line number) survives
// unrelated edits above it; if the label no longer matches, write-back safely
// no-ops rather than editing the wrong line.

import type { TaskState } from "@skynet/shared";

/** A GitHub-flavored markdown checklist item: `- [ ] label` / `- [x] label`
 *  (also `*`/`+` bullets, any indent). */
const ITEM_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+?)\s*$/;

export interface ChecklistItem {
  label: string;
  checked: boolean;
}

/** Every checklist item in the markdown, in order. */
export function parseChecklist(md: string): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  for (const line of md.split("\n")) {
    const m = ITEM_RE.exec(line);
    if (m) out.push({ label: m[4]!.trim(), checked: m[2] !== " " });
  }
  return out;
}

/** Set the checkbox of the item(s) whose label matches `label` (trimmed, case-
 *  insensitive). Returns the updated markdown, or `null` when nothing matched (so
 *  the caller skips the write — never clobbers a renamed/removed item). Preserves
 *  the line's indent, bullet, and label text. */
export function setChecklistItem(md: string, label: string, checked: boolean): string | null {
  const target = label.trim().toLowerCase();
  const box = checked ? "x" : " ";
  const lines = md.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = ITEM_RE.exec(lines[i]!);
    if (m && m[4]!.trim().toLowerCase() === target) {
      const next = `${m[1]}${box}${m[3]}${m[4]}`;
      if (next !== lines[i]) changed = true;
      lines[i] = next;
    }
  }
  return changed ? lines.join("\n") : null;
}

/** The checkbox state a Skynet transition implies, or null when it shouldn't
 *  touch the file: `→ done` checks it; leaving `done` unchecks it; every other
 *  board move is a no-op. */
export function repoFileChecked(from: TaskState, to: TaskState): boolean | null {
  if (to === from) return null;
  if (to === "done") return true;
  if (from === "done") return false;
  return null;
}
