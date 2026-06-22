# Skynet — Agent Hierarchy: Area Managers & Worker Subagents

> **Status:** proposed (decisions ratified). Rides on top of real execution (MVP #1/#2);
> not on the MVP critical path. This is the 5th engineering brief.
> **Why:** organize work by *area* — a per-project "area manager" agent decomposes its
> area's goal into subtasks and delegates to worker subagents that do the actual coding,
> while the operator supervises at the manager level. Less operator load, clearer ownership.

## Ratified decisions
1. **Agentic managers** — a manager is an LLM agent that decomposes its area and spawns workers.
2. **Per-project scope** — a manager is spun up for an area within a project and retires when the area's work is done.
3. **Risk-based escalation** — managers auto-resolve low-risk worker decisions by policy; medium/high-risk escalate to the operator Inbox.

---

## 1. The model — one delegation tree (reuses what we already have)

This is a *generalization* of existing primitives, not a new subsystem:

```
Project "Payments"
└─ Manager agent      role=manager · area=["api/billing","db/migrations"] · branch skynet/mgr/billing
   ├─ Worker  "reconcile webhooks"   parentId→manager · branch agent/reconcile-webhooks
   ├─ Worker  "dunning retries"        parentId→manager
   └─ Worker  "alerting on drift"      parentId→manager
```

- **`Agent.parentId`** is the delegation edge (manager→worker). Already exists for forks; a worker
  is just a delegated child. `familyOf` walks `parentId` to the **root** (one-line change from the
  current single-hop) so a manager + all its workers are one conflict/merge family.
- **Areas** = module ids (`Agent.modules` / the module map). A manager owns one or more.
- **Subway/Roster** already render branches off a parent — the hierarchy draws for free.

### Contract changes (additive, non-breaking)
- `Agent.role: 'manager' | 'worker'` — default `'worker'` (today's behavior unchanged).
- Generalize `familyOf(agent)` to walk `parentId` to the root.
- (No new HITL kind: a manager's delegation plan reuses the existing **`plan`** kind; merge
  conflicts reuse **`merge`**.)

---

## 2. Manager behavior (agentic)

A manager is an LLM agent whose job is to **arrange work, not edit code**. Its plan = how to split
the area's goal into subtasks.

- It raises a **`plan` HITL** — *"here's how I'll split this area; spawn these N workers?"* — which
  the operator reviews/approves (or edits).
- On approve, it spawns workers via a single new tool (§3).
- It then supervises its workers (risk policy, §4), reviews their diffs into its area branch (§5),
  and reports area-level progress. It does not touch files itself.

Lifecycle: `provision → planning → (plan approved) → delegating → supervising → area done → merge → retire`.
Per-project: the manager lives for the project's area work, then completes; its branch integrates to
the project integration branch.

---

## 3. The one new mechanism: `spawn_worker`

A manager spawns workers through a **custom MCP tool** exposed to its runner:

```
spawn_worker({ task: string, modules: string[] }) → { agentId }
```

The orchestrator implements this tool: it provisions a **first-class Skynet worker agent** under
the manager (own runner, own worktree/branch, own HITL, own merge) — exactly like `assignTask`, with
`parentId = managerId` and `role = 'worker'`.

> **Critical design call:** workers are full Skynet agents, **not** the Agent SDK's in-process
> subagents. That preserves the whole point of Skynet — every unit is visible, supervisable,
> isolated, and mergeable. (The SDK's native subagents may still be used *inside* one worker for
> its own micro-steps; that's invisible to Skynet and fine.)

---

## 4. Risk-based escalation (the supervision policy)

Workers raise HITLs exactly as today, each carrying `kind` + `risk` (both already in the model). The
manager applies a **per-workspace policy** before anything reaches the operator:

| Worker HITL | Default policy |
|---|---|
| `question` / `plan`, `risk: low` | **manager auto-resolves** (picks recommended / approves) |
| any `approval` (real command) | **escalate to operator** (humans gate destructive actions) |
| any `diff` / `merge` review | **escalate to operator** |
| any `risk: medium` or `high` | **escalate to operator** |

- Auto-resolutions are written to the **`hitl_audit`** trail with `operatorId = "manager:<id>"`, so
  every machine decision is reviewable (reuses the audit trail we already built).
- Policy is configurable per workspace (tighten to "escalate everything" = the flat model, or loosen
  for trusted areas). Default is conservative — humans stay on every risky/destructive/merge call.

This is the operator-load payoff *without* surrendering the HITL-first ethos.

---

## 5. Merge & conflict (generalize the rules we built)

- **Merge:** a worker merges into its **manager's area branch** first (family-internal), then the
  manager's branch integrates to the project branch via the serialized merge queue. This is the
  existing *"fork merges into its parent first"* rule (VCS brief §7) applied one tier up.
- **Conflict:** workers under one manager are one family → never flag each other. Two *different*
  managers touching the same module = a real "areas overlap" alert — exactly the boundary violation
  an area-manager structure exists to catch.

---

## 6. UI

- **Subway/Roster:** managers as lines, workers as branches (already the branch rendering). A manager
  card shows its area, its workers, and rolled-up progress.
- **Inbox:** mostly manager-level items (delegation plans + escalated worker HITLs); drill into a
  worker from there. An "auto-resolved by manager" filter surfaces what the manager handled.
- **Projects:** optionally grouped by area-manager.

---

## 7. What changes in the codebase (post-ratification)

| Area | Change | Depends on |
|---|---|---|
| `contracts.ts` | `Agent.role`; (optional) per-workspace escalation policy type | — (additive now) |
| `derive/conflicts.ts` | `familyOf` walks to root | — (cheap now) |
| Merge queue | worker→manager→project tiered integration | real worktrees (MVP #2) |
| `runner-sdk` | manager runner + `spawn_worker` MCP tool | real execution (MVP #1) |
| Orchestrator | implement `spawn_worker` → provision worker under manager; manager lifecycle; apply escalation policy | MVP #1/#2 |
| `hub` | route worker HITLs through manager policy; audit `manager:<id>` resolutions | — |
| Web | hierarchy in Subway/Roster; manager Inbox + auto-resolved filter | — |

---

## 8. Sequencing (the "good way" to land it)

- **Cheap & safe now (≈1 day, additive, no behavior change):** `Agent.role`, `familyOf` walks to
  root, worker→manager merge wiring (reuse fork rule). Inert until managers exist, but keeps the
  model ready and lets the UI/merge generalize early.
- **Post real-execution (MVP #1/#2):** the agentic runtime — manager runner, `spawn_worker` tool,
  delegation `plan` HITL, escalation policy. A manager can't spawn *real* workers until real workers
  run, so this slots naturally after the MVP execution loop is live.

It does **not** compete with the MVP critical path.
