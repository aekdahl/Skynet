// ─── Local folder browser ─────────────────────────────────────────────────
// Lists directories on the SERVER's machine so the web UI can offer a folder
// *picker* (select, don't type) when connecting a project to a repo. This only
// makes sense because desktop = server and browser on the same machine.
//
// ⚠️ Local-only: this exposes the filesystem to the authenticated principal.
// Fine for the single-operator local build; it's gated off unless
// config.allowLocalFs, and MUST stay disabled for any hosted/multi-user
// deployment (see ROADMAP gate).

import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface FsEntry {
  name: string;
  path: string;
  isGitRepo: boolean; // contains a .git → connecting it is git-backed
}
export interface FsListing {
  path: string; // resolved absolute directory being listed
  parent: string | null; // parent dir, or null at the filesystem root
  entries: FsEntry[]; // immediate subdirectories (dotfiles hidden)
  exists: boolean; // false when `path` isn't an existing directory (typo/typed path)
  isGitRepo: boolean; // the listed dir itself is a git repo
}

/** Expand a leading `~` to the home dir — so a typed `~/projects` resolves. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** List immediate subdirectories of `input` (default: home). Never throws. */
export async function listDir(input?: string): Promise<FsListing> {
  const path = resolve(input && input.trim() ? expandHome(input.trim()) : homedir());
  const parent = dirname(path) === path ? null : dirname(path);
  let exists = false;
  try {
    exists = statSync(path).isDirectory();
  } catch {
    /* nonexistent / unreadable → exists stays false (UI warns "not found") */
  }
  let entries: FsEntry[] = [];
  try {
    const dirents = await readdir(path, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => {
        const p = join(path, d.name);
        return { name: d.name, path: p, isGitRepo: existsSync(join(p, ".git")) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    /* unreadable dir → empty listing, still allow going up */
  }
  return { path, parent, entries, exists, isGitRepo: exists && existsSync(join(path, ".git")) };
}

/** True when the given path is (or contains) a git repository. */
export function isGitRepo(path: string): boolean {
  return existsSync(join(resolve(path), ".git"));
}
