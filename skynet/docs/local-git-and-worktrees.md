# Skynet — Local git & automatic worktrees (desktop model)

How Skynet uses version control on a local machine. The guiding rule:
**git is required; a forge (GitHub) is optional; and the user never touches git plumbing.**

## git vs. GitHub
- **git** = the mechanism (branches, worktrees, merge, commit). Always used, entirely local.
- **GitHub / GitLab / …** = a hosting platform + API (PRs, issues, reviews, CI). **Optional**, and only
  for remote/collaboration/triggers (ROADMAP v3). The core loop needs none of it.

So on desktop there is **no GitHub integration** — just git in a local folder.

## A project is a folder
- You point a project at a **local directory**. That's the entire "connect a repo" step — no OAuth, no
  tokens, no remote.
- **Has `.git`? → git-backed** (branches/worktrees/merge available). Skynet detects this automatically.
- **No `.git`?** → Skynet offers to `git init` it, or the project runs in **no-VCS / chat mode** (agents
  work without branches or merge). Repo is not hard-required.
- Everything stays on the machine; only the model API calls leave.

## Worktrees are fully automatic — the user never manages them
This is a hard requirement: **Skynet creates, tracks, and removes worktrees itself. No user ever runs a
`git worktree` command or picks a branch.** Point at a folder; Skynet does the rest.

Per agent, invisibly, tied to the agent lifecycle:

| Agent event | What Skynet does with git (automatic) |
|---|---|
| **assigned** | `git worktree add` a fresh working dir on a new `agent/<task>` branch, off the project's `.git` |
| **running** | the agent's `cwd` = that worktree; it uses git/shell there, isolated |
| **diff approved** | merge the branch into the project's integration branch (the merge queue) |
| **completed / retired** | `git worktree remove` + prune the branch when it's safely merged |
| **conflict / failure** | keep the branch (don't delete) so work is recoverable; the worktree can still be cleaned up |
| **crash / restart** | orphaned worktrees are detected and pruned on next boot |

**Invariants:**
- **Never touch the user's main checkout, current branch, or uncommitted changes.** All agent work
  happens in separate worktrees; the folder the user has open is left exactly as it was.
- **One `.git`, many worktrees, one agent per worktree** — shared history, isolated working dirs, so
  parallel agents can't clobber each other.
- Worktrees live in a **Skynet-managed location** (not scattered in the project tree), and are garbage-
  collected — the user never sees stray `agent/*` folders or branches for merged work.
- Requires only that `git` is installed and the folder is a repo (or Skynet inits one). **Zero git
  knowledge required of the user.**

## Hosted mode (for contrast)
Same mechanics, different location: the server **clones the remote once** into a container and does the
identical worktree dance inside it. Cloning a *GitHub-hosted* repo needs repo access (a token), but the
branching/merge is still plain local git in the container — GitHub's API is not on the core path.

## Status / where this builds
- The **merge engine** is already git-only on a local path (`git -C <repo> …`, no remote).
- **Automatic worktree creation is MVP #2 (worktree-per-runner)** — not built yet. Today the runner takes
  a `cwd`; #2 adds the create/track/cleanup lifecycle above so parallel agents are safe and invisible.
- Desktop onboarding (#3) = "pick a folder" — this doc is the target for that flow.
