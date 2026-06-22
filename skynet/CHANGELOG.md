# Changelog

All notable changes to Skynet are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-22

First MVP. Mission Control for supervising a fleet of coding agents in parallel:
assign a task → an agent works in an isolated git worktree → its diff is reviewed
(human-in-the-loop) → approved diffs integrate through a serialized merge queue.

### Core loop
- **Worktree-per-agent provisioning** — each agent runs on its own `agent/<id>`
  branch in an isolated `git worktree`; on completion its diff is committed and
  raised for review, and approving **enqueues the real branch** onto a serialized
  per-project merge queue (`skynet/integration/<projectId>`).
- **Merge engine** — serialized per-integration-branch merges with conflict
  escalation (a `merge` HITL) and post-merge project-check handling.

### Providers (runner-sdk)
- Five backends behind one `RunnerProvider` seam — **Claude Code** (headless-auth
  unblocked), **Codex**, **Gemini**, **Cursor**, **Copilot** — selected via
  `RUNNER=`. Default `RUNNER=mock` for a zero-dependency demo.
- Per-workspace **encrypted provider secrets** with runner key-injection
  (opt-in via `SKYNET_MASTER_KEY`).

### Platform
- **Real-time**: WebSocket snapshot/deltas; `BUS=redis` for cross-replica fan-out.
- **Persistence**: in-memory (default) or `STORE=postgres`.
- **Auth**: dev tokens + real login with durable sessions (`SESSIONS=memory|postgres|redis`).
- **Derived intelligence**: module map (`.skynet/modules.json`) + server-side
  conflict/dependency derivation feeding the Timeline and conflict banner.
- **Live preview**: sandboxed per-branch preview URLs / built artifacts (`PREVIEW=`).

### Web
- Deep-link routing (shareable URLs, back/forward), decision **audit-trail** view,
  installable **PWA** (offline shell, push → Inbox), onboarding flow.

### Quality
- Vitest suite (contracts round-trip, Store adapters, merge engine, HITL
  idempotency) and GitHub Actions CI (typecheck + build + test against Postgres).

[0.1.0]: https://github.com/aekdahl/Skynet/releases/tag/v0.1.0
