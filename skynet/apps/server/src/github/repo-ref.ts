// ─── Repo reference parsing ────────────────────────────────────────────────
// Skynet binds a project to a GitHub repo by its canonical "owner/repo" slug
// (see contracts.ts). The operator, though, naturally has a URL — the thing the
// browser address bar or the "Clone" button hands them. parseRepoRef accepts
// the common shapes an operator can paste and normalizes them to "owner/repo",
// so an existing repo can be cloned at project-creation time without asking the
// operator to hand-derive the slug.

/**
 * Normalize a pasted repo reference to its canonical "owner/repo" slug, or
 * return null when it isn't a recognizable GitHub repo reference. Accepts:
 *   - a bare slug            → "owner/repo"
 *   - an HTTPS clone/web URL  → "https://github.com/owner/repo(.git)"
 *   - an SSH clone URL        → "git@github.com:owner/repo(.git)"
 *   - an ssh:// URL           → "ssh://git@github.com/owner/repo(.git)"
 * A trailing ".git", surrounding whitespace, and trailing slashes are stripped.
 * Extra path segments (e.g. ".../owner/repo/tree/main") are dropped — the first
 * two segments are the repo. Owner and repo are validated against GitHub's
 * allowed character set so garbage can't slip through as a slug.
 */
export function parseRepoRef(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let path: string;
  const scp = trimmed.match(/^[^@]+@[^:]+:(.+)$/); // git@host:owner/repo (scp-like syntax)
  if (scp) {
    path = scp[1] ?? "";
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    // A proper URL (https://, ssh://, git://) — take its path component.
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  } else {
    path = trimmed;
  }

  const segments = path
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);
  const [owner, repo] = segments;
  if (!owner || !repo) return null;
  const ok = /^[A-Za-z0-9._-]+$/;
  if (!ok.test(owner) || !ok.test(repo)) return null;
  return `${owner}/${repo}`;
}
