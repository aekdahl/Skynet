# Skynet — VCS, Merge & Conflict-Ownership Model

> **Status:** proposed — for ratification at the Phase A checkpoint.
> **Why this exists:** "no double work" and "diff-approve → merge" are the product's core
> promises, but the prototype + Phase 0 treat them as one-liners (`review → done: merge branch`)
> with conflict/dependency data *seeded*, not computed. Real agent completion cannot merge, and
> conflict detection cannot be real, until the model below is decided. This is the 4th
> engineering brief, alongside Frontend / Backend / Architecture.

---

## 1. The questions this answers

1. Where does an agent's code physically live while it works, and how is it isolated?
2. What is a "module," authoritatively — so conflicts and the code-agnostic UI mean something?
3. When two agents touch the same area, what counts as a conflict, and who owns resolving it?
4. What happens, concretely, when an operator approves a diff — how does it merge?
5. What happens when that merge conflicts?
6. How do forks (shared-context branches) merge without fighting their own parent?

---

## 2. Branch-per-agent in isolated worktrees

**Decision:** every agent works on its own branch (`Agent.branch`, already in the model) inside
its **own git worktree** of the target repo. One runner ⇄ one worktree ⇄ one branch.

- Maps 1:1 onto runner = container isolation (Architecture Brief §07): the worktree lives inside
  the runner's container; "provision a runner" = create the worktree, "retire" = remove it.
- A worktree (not a fresh clone) shares the object store with the canonical repo, so it's cheap to
  spin up and the integration branch is always visible for rebasing.
- The canonical repo + the **integration branch** are server-owned; runners never push directly to
  it — they only push their own `agent/*` branch. Integration happens through the merge queue (§5).

**Integration-branch model (decision to ratify):** *per-project integration branch* —
`skynet/integration/<projectId>` — rather than merging every agent straight to `main`. A project's
agents integrate among themselves first; promoting a project branch to `main` is a separate,
explicit operator action. Rationale: keeps blast radius per-project, makes "project done" a real
gate, and lets `main` stay protected. (Alternative: single `main` for everything — simpler, but
couples unrelated projects and makes `main` noisy.)

---

## 3. Modules: the source of truth

The UI is code-agnostic — it shows **named modules** (Billing, Auth, Shared UI), never file trees.
Today `MODULE_NAMES` is hard-coded in `apps/server/src/store/seed.ts`. That cannot drive real
conflict detection.

**Decision:** a **curated module map committed to the target repo** at `.skynet/modules.json`:

```jsonc
{
  "modules": [
    { "id": "api/billing", "name": "Billing",   "globs": ["api/billing/**", "db/migrations/*billing*"] },
    { "id": "shared/ui",   "name": "Shared UI", "globs": ["packages/ui/**", "shared/ui/**"] }
  ]
}
```

The server loads this (replacing the hard-coded map) and resolves an agent's changed files →
module ids by glob match. An agent's `modules` becomes *derived from what it actually touched*,
not declared up front.

**Why curated over the alternatives:**
- **CODEOWNERS** — couples to GitHub, and ownership ≠ architectural module; teams own many modules.
- **Repo-structure inference** (top-level dirs = modules) — ambiguous and wrong for monorepos /
  flat layouts; no friendly names.
- **Curated map** — explicit, versioned with the code, gives the friendly names the UI needs, and a
  file matching no glob simply maps to no module (surfaced as "unmapped" rather than guessed).

A file matching multiple globs belongs to all matched modules (overlap is real and intended).

---

## 4. Conflict detection (fork-aware)

**Definition:** a conflict exists when **two different agent *families*** are **concurrently active**
and their *touched* module sets intersect.

- **Family** = an agent plus its fork-descendants, collapsed via `Agent.parentId`. A fork and its
  parent share context on purpose, so they are **one family** and never flag each other (the data
  model already carries `parentId` / `branchFromStep` for exactly this).
- **Concurrently active** = both not `done`.
- **Touched modules** = derived from modified files via `.skynet/modules.json` (§3) — *actual*
  contact, not the agent's declared area.

Computed server-side (a derive step driven from the Hub on `agent.progress` / file changes) and
emitted as `conflict.detected { moduleId, agentIds }` (event already exists; UI already renders the
banner). This replaces the static seed.

> Conflict detection is a **warning signal** (surfaced in the Home banner), not a hard lock — two
> families *may* legitimately edit the same module. It exists so an operator can intervene *before*
> two diffs collide at merge time (§5).

---

## 5. Integration: a serialized merge queue

**Decision:** diff-approve does not merge inline. It **enqueues** the agent's branch onto a
per-integration-branch **merge queue** processed one at a time:

```
operator approves diff
  → enqueue agent.branch
  → (when it reaches the head)
      rebase agent.branch onto integration tip
      run the project's check command (e.g. `pnpm test`)
      ├─ clean + green → fast-forward merge into integration; agent → done; free runner
      ├─ checks fail   → bounce back to the agent as a 'reject'-style resume (revise)
      └─ rebase conflict → raise a `merge` HITL (§6)
```

Serializing per integration branch means the "rebase onto tip" always sees the latest state, so the
**only** way two approved diffs collide is a genuine textual conflict — caught deterministically at
the head of the queue, never as a surprise race. Throughput is fine: merges are fast relative to
agent runtime, and different projects' queues run in parallel.

---

## 6. Merge conflicts → a new HITL kind

When rebase/merge conflicts, the system raises a new HITL item:

- **Proposed contract change (decision to ratify):** add `'merge'` to `HitlKind` in
  `packages/shared/src/contracts.ts`, with payload `{ modules: string[], against: branch, conflictedFiles→modules }`.
  *Not applied yet* — it ripples to the web `KIND_META` and is explicitly a checkpoint decision.
- The operator resolves a `merge` item by one of:
  - **assign a reconciliation agent** — spin an agent (fork-aware: in the same family lineage) whose
    task is to rebase/resolve, then it re-enters the queue;
  - **pick a side** per conflicted module (ours/theirs) for mechanical conflicts;
  - **send back to the author agent** with the conflict context as `modify` guidance.

If the `merge` kind is deferred at the checkpoint, the interim behavior is: a rebase conflict pauses
the agent in `review` with a plain `diff`-kind item annotated with the conflict, and resolution is
manual — acceptable for the spike, not for GA.

---

## 7. Fork merge semantics

A fork branches from its parent at `branchFromStep` and shares context. On completion:

1. A fork merges into **its parent's branch first** (family-internal integration), not straight to
   the integration branch.
2. The family integrates as a unit through the queue (§5).

This guarantees a fork never conflict-flags or merge-collides with its own parent — they reconcile
inside the family before touching shared integration.

---

## 8. What changes in the codebase (post-ratification)

| Area | Change |
|---|---|
| `contracts.ts` | add `'merge'` to `HitlKind` (+ payload) — **gated on §6 ratification** |
| `store/seed.ts` + `Store.listModules` | load `.skynet/modules.json` from the target repo instead of the hard-coded map |
| Orchestrator | worktree-per-runner provisioning; derive touched-modules from diffs; merge-queue processor; conflict-derive step |
| `runner-sdk` | runners operate inside a per-agent worktree (real providers) |
| Web | `KIND_META` gains `merge`; conflict banner now reads computed events (no UI structural change) |

Most of this is **downstream of the A2 runner spike and this ratification** — the merge queue and
conflict computation are built once a real runner produces real branches/diffs to merge.

---

## 9. Decisions to ratify at the checkpoint

1. **Integration-branch model:** per-project integration branch (recommended) vs. single `main`.
2. **`merge` HITL kind:** add now vs. defer (interim = annotated `diff` item).
3. **`.skynet/modules.json`** as the module source of truth, with the glob shape in §3.
4. **Merge queue is server-owned** and serialized per integration branch (vs. letting runners push).
