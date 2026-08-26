// ─── Repo-native memory sync (v4 slice) ──────────────────────────────────
// Projects Skynet's portable project memory (Project.contextSummary — the
// condensed digest of ProjectContextEntry material that already rides every
// agent's prompt as the PRIMER section, see agent-context.ts) into each
// vendor's own native memory file inside a run's checkout, so a tool used
// directly against the repo (Claude Code, Cursor, GitHub Copilot) — without
// going through Skynet at all — sees the same grounding.
//
// One-way (portable memory -> vendor files), by design (v4 scope: read/write/
// sync the vendor files, not ingest hand-edits back into Skynet's memory).
// `CLAUDE.md` and the Copilot instructions file are human-editable, shared
// files, so Skynet's contribution is fenced between markers and everything
// outside them is preserved verbatim. `.cursor/rules/skynet-memory.mdc` is a
// filename Skynet owns outright (Cursor's rules format is one file per rule),
// so it's simply overwritten each sync.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MARKER_START = "<!-- skynet:memory:start (auto-synced by Skynet on every run — edits outside these markers are kept) -->";
const MARKER_END = "<!-- skynet:memory:end -->";

export const CLAUDE_MD_PATH = "CLAUDE.md";
export const CURSOR_RULE_PATH = join(".cursor", "rules", "skynet-memory.mdc");
export const COPILOT_INSTRUCTIONS_PATH = join(".github", "copilot-instructions.md");

function renderBlock(memory: string): string {
  return `${MARKER_START}\n${memory}\n${MARKER_END}`;
}

/** Insert/replace Skynet's marked block in a human-editable memory file,
 *  preserving everything outside the markers. Creates the file (and its
 *  parent directory) when it doesn't exist yet. */
async function upsertMarkedFile(path: string, memory: string): Promise<void> {
  const existing = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  const block = renderBlock(memory);
  const startIdx = existing?.indexOf(MARKER_START) ?? -1;
  const endIdx = existing?.indexOf(MARKER_END) ?? -1;
  let next: string;
  if (existing == null) {
    next = `${block}\n`;
  } else if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    next = `${existing.slice(0, startIdx)}${block}${existing.slice(endIdx + MARKER_END.length)}`;
  } else {
    next = `${existing.trimEnd()}\n\n${block}\n`;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
}

/** Cursor's rule frontmatter — `alwaysApply` means it's injected into every
 *  chat/agent turn in that repo, matching how the PRIMER section rides every
 *  Skynet-driven prompt. */
function renderCursorRule(memory: string): string {
  return `---\ndescription: Skynet project memory (auto-synced by Skynet — edits here are overwritten on the next run)\nalwaysApply: true\n---\n\n${memory}\n`;
}

async function writeCursorRule(path: string, memory: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderCursorRule(memory), "utf8");
}

/**
 * Project Skynet's portable project memory into every vendor's native memory
 * file inside `cwd`. `cwd` must be a real repo checkout (a provisioned
 * worktree, or an operator-configured runner directory) — never a throwaway
 * scratch dir, since there's no repo there for a vendor tool to read from.
 * No-op when there's no memory yet to project (a project with no context
 * entries condensed).
 */
export async function syncRepoNativeMemory(cwd: string, memory: string | null | undefined): Promise<void> {
  const trimmed = memory?.trim();
  if (!trimmed) return;
  await upsertMarkedFile(join(cwd, CLAUDE_MD_PATH), trimmed);
  await upsertMarkedFile(join(cwd, COPILOT_INSTRUCTIONS_PATH), trimmed);
  await writeCursorRule(join(cwd, CURSOR_RULE_PATH), trimmed);
}
