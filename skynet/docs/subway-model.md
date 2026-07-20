# Subway model — the project map (spec)

The canonical definition of the **Subway / "Project lines"** visualization. Every term below is
load-bearing. Build to **this**, not to the current `apps/web/src/views/home.tsx` `SwDiagram`, which
predates this spec and will be **reworked** to match (see §9).

Reference: [ux-agent-organization.md](ux-agent-organization.md) (reuses the branch primitive for
manager→worker hierarchy), [agent-hierarchy.md](agent-hierarchy.md), [ROADMAP.md](../ROADMAP.md).

---

## 0. Terminology guardrail (read first)

Two different "merges" exist. **Never conflate them.**

- **Rejoin / fold** *(visual)* — a track collapsing back into its origin on the map. Pure topology; it
  **moves no code**. It means "this line of work is finished and its subtree is complete."
- **Merge** *(git)* — integrating a task's branch, **always human-gated** through the existing
  diff/merge HITL → PR.

Reserve the word **"merge"** for the git event. On the map, tracks **rejoin / fold back / complete**.
This decoupling is what makes the map safe: the map never integrates anything; humans gate every real
merge.

## 1. One map per project

A project renders **exactly one map**. Nothing crosses maps. An agent working _N_ projects appears as
**one track in each** of the _N_ maps — never a line hopping between them.

## 2. The four primitives

- **Trunk** — the map's spine = the project's **integration branch**. The root that every top-level
  track folds back into.
- **Track** — **one agent**, within this project. Its path (left → right) is that agent's journey
  through the project.
- **Station** — **one task** the agent worked (or completed), placed along its track in the order the
  agent took it.
- **Junction** — a station where a track **branches** (fork / new agent) or **folds back**.

> **"Agent" = the fleet runner** (the persistent worker, e.g. `claude-01`) — the thing that gets
> "assigned to multiple projects." A **run** (`TaskRun`) is one execution of one task; a **track
> aggregates an agent's runs in this project** as stations. (Data mapping in §8.)

## 3. The unified rule

> The map is a **tree of tracks rooted at the trunk**. Tracks **branch out** at a station (fork or new
> agent) and **auto-fold back** into their origin — **leaf-first** — the moment their whole subtree is
> complete.

- A **fork** track folds back into its **parent track**.
- A **top-level agent** track folds back into the **trunk**.
- A track **cannot fold until its child tracks have** (leaf-first). _Implication:_ an unfinished fork
  holds its parent open — correct, and it mirrors real merge dependencies.

## 4. Branching (fan-out)

A new track appears when either:

- a **task is forked** → assigned to a **new agent** → new track, **branching at that task's station**; or
- an **agent (run) is forked** → new track, **branching at the station it was on**.

At the junction the **parent keeps** the forked task's station, visually marked **completed /
re-pointed** (the work branched off here).

**Independent parallel agents** (not forks) are **separate top-level tracks** off the trunk, with **no
junction between them** — this is what makes parallelism visible. Each folds into the trunk
**independently** when its own subtree is done (no barrier, no waiting on siblings).

## 5. Fork disposition — additive (default) vs competitive

- **Additive (default)** — every completed fork folds back. Use when both branches' work is wanted.
- **Competitive** — forks are **alternatives**; one is chosen, the rest **dead-end at a "discarded"
  endcap** instead of folding back. Use for "run 3 approaches, keep the best" (→ cross-vendor consensus
  runs, ROADMAP signature bet).

A per-fork-set mode flag. Because the fold is visual-only (§0), **neither mode integrates code on its
own** — real integration is still per-task, human-gated.

## 6. A station carries two facts — work × integration

Render **both**, independently:

- **Work state** — `queued` / `running` / `done` (e.g. the dot fill / lit "now" stop).
- **Integration state** — `no-PR` / `in-review` / `merged` / `rejected` (e.g. a ring or badge).

**"Work done" ≠ "merged."** A track can look complete while its stations' PRs are still awaiting your
approval. The gated diff/merge HITL drives the integration state.

## 7. Everything else

- **Backlog** — unassigned tasks **do not appear** on the map. Show a **count** on the map header
  ("3 in backlog"). A task hops onto an agent's track when it's assigned.
- **Handoff / reassignment** — a task's station lives on the agent that **completed** it, plus a
  **faint connector** from the prior agent's track showing the handoff.
- **Branch / PR granularity** — one **branch + PR per task**; sequential tasks by the same agent **may
  share a branch** (then they're consecutive stations on one line).

## 8. Data mapping (already present — no model change)

| Map concept | Backed by |
| --- | --- |
| Track (agent) | `run.agentId`, scoped to `run.projectId` |
| Station (task) | `task` via `task.runId`; ordered by the run's start time |
| Junction / fork | `run.parentId` (+ `run.branchFromStep` for the exact split point) |
| Trunk | the project integration branch (`skynet/integration/<projectId>`) |
| Integration state | the task's PR / merge-HITL status |

The **one real change vs. today**: rendering aggregates **by agent**, not by run.

## 9. What this reworks

The current `SwDiagram` draws **task-stations on a per-project line** with **runs as branches**. This
spec is **agent-tracks with recursive fold-back to the trunk**, and a station that encodes **work ×
integration**. That's a rebuild — tracked separately from this brief. The branch primitive is shared
with the manager→worker hierarchy rendering (`role`/`parentId`), so build it once.

## 10. Open / deferred

- Exact geometry (curve radii, how far right a fold-back rejoins) — implementation detail, not spec.
- Very deep trees / very wide fan-out — need a legibility cap (collapse / "+N more" on a track) at
  scale; design when it bites.
- Time axis — stations are ordered, not to-scale by wall-clock; revisit if a real timeline is wanted
  (that's the separate **Timeline** lens).
