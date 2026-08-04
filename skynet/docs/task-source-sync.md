# Task source-of-truth sync

Skynet tasks are often **imported** from an external source of truth — GitHub
issues, a `TODO.md`, a tracker. When a Skynet task then changes status or
completes, the original should update too. This doc is the design; Phase 1
(GitHub issues) is implemented.

## Problem

A task had no provenance — nothing recorded that it came from `acme/web#42`, so
Skynet couldn't write back. Two halves are needed:

1. **Provenance** on the task (a link to its source).
2. **Write-back** — on a status change, reflect it in the source.

## Model

`Task.source` records where a task came from (set at import, carried for life):

```ts
Task.source =
  | { kind: "github_issue"; repo: "owner/name"; number: 42; url: string }
  | { kind: "repo_file";    path: "docs/TODO.md"; anchor: string }   // Phase 2
  | { kind: "external";     system: string; id: string; url: string } // Phase 3
  | null
```

`syncedAt` / `sourceRev` (reserved) guard against clobbering an external edit and
seed a future two-way sync.

## The `SyncSink` seam

One adapter per `source.kind` — a stable seam so new sources plug in without
touching the core (mirrors `RunnerProvider`):

```ts
interface SyncSink {
  kind: TaskSource["kind"];
  // Reflect a Skynet state transition in the source. Best-effort; never throws
  // into the caller.
  onStateChange(task: Task, from: TaskState, to: TaskState, ctx: SyncCtx): Promise<void>;
}
```

**GitHub-issue adapter** (Phase 1) maps Skynet state → issue action:

| Skynet transition | GitHub issue |
| --- | --- |
| `→ review` | comment ("Skynet: opened PR / in review") |
| `→ done` | comment + **close** the issue |
| `done → *` (regress) | **reopen** + comment |

## Trigger

Every task-state mutation funnels through `hub.upsertTask` → the `task.upserted`
bus event. A **bus subscriber** (`startTaskSourceSync`) tracks the last-seen state
per task; when a task with a `source` changes state — and the project opted in —
it dispatches to the matching sink. Best-effort + retried + logged on the task's
activity; it never blocks or fails the transition.

Why the bus, not each call site: status changes happen in many places (human
drag, `complete`/`completeMerged`, the autonomy loop). Subscribing once is the
single choke point.

## Guardrails

Writing to a source of truth is **outward-facing** (like `git push`), so it's
**opt-in per project** (`Project.syncSourceStatus`, default off) and authenticates
with the workspace's GitHub connection (→ becomes the project's pinned GitHub
account once per-project credentials land). Closing an issue is reversible
(reopen), so Phase 1 doesn't add a HITL gate beyond the opt-in; a stricter policy
can gate `close`/`comment` through the existing approval machinery later.

## Direction

Phase 1 is **one-way** (Skynet → source) on status change. Two-way (re-import when
the source changes, with conflict handling via `sourceRev`) is a bigger loop —
deferred; the field reserves the seam.

## Phasing

1. **GitHub issues** *(done)* — import open issues → tasks (`source` set,
   deduped); on transition, comment / close / reopen. Opt-in per project.
2. **repo files** *(done)* — a repo file's `- [ ]` checklist items import as tasks
   (anchored by label); completing a task flips its box to `- [x]` (reopening
   unchecks it), committed via the GitHub Contents API (single-file commit under
   the project's account). GitHub-repo-backed projects; a local-worktree / PR
   variant + `status:` frontmatter are future refinements.
3. **external / webhook** — Linear/Jira adapters or a generic outbound webhook
   (`{task, from, to, prUrl}`); optional two-way.

## Reuses

The event bus (trigger), the GitHub connection + push/PR flow, the per-project
approval policy (opt-in + future gating), and optionally the BYOK Steward agent to
author a nuanced closing comment instead of a canned one.
