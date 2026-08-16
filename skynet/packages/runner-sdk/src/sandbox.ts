// ─── Opt-in OS sandbox wrapper ─────────────────────────────────────────────
// CLI runners spawn a vendor binary in the agent's worktree. When
// SKYNET_RUNNER_SANDBOX is truthy AND a supported OS sandbox tool is present,
// we wrap that spawn so the child can only *write* inside its worktree (plus
// temp and the dirs vendor CLIs cache creds/config in). Reads and network stay
// open, so the agent can still reach its model API and read the repo.
//
// Best-effort by design: if the flag is off, the platform is unsupported, or the
// sandbox tool is missing, the command is returned unchanged with a note saying
// why, and the runner proceeds unsandboxed rather than failing to start. This is
// a guardrail that keeps a well-meaning agent's writes inside its worktree — not
// a security boundary against a hostile agent.
//
// macOS uses `sandbox-exec` (a permissive base profile with writes denied, then
// re-allowed under specific subpaths). Linux uses `bwrap` (bubblewrap): a
// read-only bind of `/` with the writable roots re-bound read-write.

import { existsSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface SandboxSpec {
  /** The one directory the child is expected to write to (its worktree). */
  cwd: string;
}

export interface WrappedCommand {
  bin: string;
  args: string[];
  /** How the command was (or wasn't) sandboxed — surfaced once to the run log. */
  note: string;
  /** True only when an OS sandbox actually wraps the command. */
  sandboxed: boolean;
}

/** Truthy SKYNET_RUNNER_SANDBOX opts the fleet into OS write-confinement. */
export function sandboxEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SKYNET_RUNNER_SANDBOX ?? "");
}

/** Is `bin` resolvable on PATH? (Cheap check so we can fall back cleanly.) */
function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((d) => existsSync(join(d, bin)));
}

// Writable roots beyond the worktree: temp, plus the dirs vendor CLIs cache
// creds/config in. Reads stay open everywhere — this only scopes writes, so a
// runaway agent can't scribble outside its worktree and the operator's HOME.
function writableRoots(cwd: string): string[] {
  const home = homedir();
  const roots = [cwd, tmpdir(), "/tmp", "/private/tmp", "/private/var/folders"];
  for (const rel of [".cache", ".config", ".claude", ".codex", ".gemini", ".cursor", ".copilot", ".hermes", ".npm"]) {
    roots.push(join(home, rel));
  }
  // OpenCode doesn't use a single top-level dot-dir like the others — it
  // follows XDG layout, writing session/auth state under .local/share/opencode
  // (its cache/config dirs already land under the broad .cache/.config above).
  roots.push(join(home, ".local", "share", "opencode"));
  return [...new Set(roots)];
}

/** A permissive sandbox-exec profile: allow all, deny writes, re-allow the roots. */
function macProfile(cwd: string): string {
  const allowWrite = writableRoots(cwd)
    .map((p) => `(subpath ${JSON.stringify(p)})`)
    .join(" ");
  return ["(version 1)", "(allow default)", "(deny file-write*)", `(allow file-write* ${allowWrite})`].join("\n");
}

/** bwrap argv: read-only root, then re-bind the (existing) writable roots rw. */
function bwrapArgs(cwd: string, bin: string, args: string[]): string[] {
  const binds: string[] = [];
  for (const root of writableRoots(cwd)) {
    // bwrap errors on a bind whose source is missing, so only bind what exists.
    if (existsSync(root)) binds.push("--bind", root, root);
  }
  return ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...binds, "--", bin, ...args];
}

/**
 * Wrap `(bin, args)` for OS write-confinement when opted in and available;
 * otherwise return them unchanged with an explanatory `note`. Pure/synchronous
 * so callers (and tests) can assert the exact command that will be spawned.
 */
export function wrapForSandbox(bin: string, args: string[], spec: SandboxSpec): WrappedCommand {
  if (!sandboxEnabled()) return { bin, args, note: "", sandboxed: false };

  const os = platform();
  if (os === "darwin") {
    if (!onPath("sandbox-exec")) {
      return { bin, args, sandboxed: false, note: "SKYNET_RUNNER_SANDBOX set but sandbox-exec not found — running unsandboxed" };
    }
    return {
      bin: "sandbox-exec",
      args: ["-p", macProfile(spec.cwd), bin, ...args],
      sandboxed: true,
      note: `sandboxed via sandbox-exec (writes confined to ${spec.cwd})`,
    };
  }
  if (os === "linux") {
    if (!onPath("bwrap")) {
      return { bin, args, sandboxed: false, note: "SKYNET_RUNNER_SANDBOX set but bwrap (bubblewrap) not found — running unsandboxed" };
    }
    return {
      bin: "bwrap",
      args: bwrapArgs(spec.cwd, bin, args),
      sandboxed: true,
      note: `sandboxed via bwrap (writes confined to ${spec.cwd})`,
    };
  }
  return { bin, args, sandboxed: false, note: `SKYNET_RUNNER_SANDBOX set but no OS sandbox available on ${os} — running unsandboxed` };
}
