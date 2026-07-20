# UX brief — Agent organization (labels/grouping) & roles-as-managers

For the UX manager. Two related jobs: (A) let operators **organize agents** they're running, and
(B) surface the idea that **specialized roles are just area-managers pointed at a function**. Keep it
consistent with the dark mission-control aesthetic and the existing views (Roster, Ledger, Subway,
Inbox, Fleet, Agent detail).

## Background — what exists today (don't redesign these)
- A task → an **agent** (named after its task). Multiple agents from the **same vendor** run at once.
- Agents are **grouped by project** today; the **Roster** lens splits active agents vs. idle runners;
  **Ledger** is the dense scan; **Subway** shows progress with **branches off a parent** (forks) —
  now formally defined as **one map per project, one track per agent, tasks as stations, forks as
  branches that fold back when done**: see [subway-model.md](subway-model.md) (the canonical spec; the
  hierarchy view in Job B reuses its branch primitive).
- The **Fleet** view manages *runners* (configured vendor+model instances), separate from agents.
- Data already on an agent: `id`, `name` (the task), `status`, `provider`, `model`, `projectId`,
  `modules`, `parentId` (lineage), `role` (worker|manager — see B).

## Job A — Organize agents (rename · label · group · saved views)
**Problem:** at 10–40 live agents, project-only grouping isn't enough to keep track.

Design these (smallest → larger):
1. **Rename / nickname** an agent. Inline-editable title on the Agent detail header and Roster/Ledger
   row. Default stays the task text; a custom name overrides for display only (never changes the task).
   *Data:* add a `displayName` (UI-only) to the agent.
2. **Labels / tags** — free-form colored tags ("frontend", "spike", "urgent"). Add/remove from a
   row's overflow menu and the Agent detail. Filter any list by tag. *Data:* `labels: string[]`.
3. **Custom groups / saved views** — let an operator define a named view = a filter (by tag, module,
   provider, status, project) + a sort. Show saved views as chips above Roster/Ledger. *Data:* a
   per-operator `views` list (name + filter + sort), stored server-side.
4. **Bulk selection** — checkboxes on Roster/Ledger rows enabling bulk actions (this is also the entry
   point for **Mass inform**, ROADMAP v1 — coordinate so the multi-select is shared).

**Interaction requirements**
- Don't add a new top-level nav item; these live *within* Roster/Ledger (filter/sort/select chrome)
  and the Agent detail header.
- Tags + saved views must round-trip through the API (they're per-workspace/per-operator state, not
  local). Flag to engineering: small additive fields (`displayName`, `labels`, `views`).
- Empty/at-scale states: design for both 2 agents and 40.

**Acceptance:** an operator can rename an agent, tag several agents, save a "Frontend · needs-me" view,
select 5 agents at once, and have all of it survive a reload (server-persisted).

## Job B — Make "roles = managers" legible
**The concept (important, and a UX problem, not an engineering one):** Skynet does **not** have a
separate "agent type" system. A **manager** is an agent with `role: manager` plus a **scope** and the
ability to spawn workers. The scope can be:
- a **module area** — e.g. *Billing manager* (owns `api/billing`), or
- a **function** — e.g. *Review manager*, *QA manager*, *Security manager*.

Same mechanism, different scope. "Review Manager with review-workers" is the hierarchy pointed at a
*function* instead of a *directory*. **The UI should make creating either feel like the same action.**

Design these:
1. **"New manager" flow** — one creation flow with a **scope picker**: *Area* (select modules) or
   *Role* (pick/name a function: Review, QA, Security, Docs, …). Same form, a segmented toggle.
2. **Hierarchy visualization** — a manager renders as a parent with its workers as children
   (reuse Subway's branch rendering; in Roster, a manager card that expands to its workers). The
   operator should *see* "Review Manager → 3 review workers" at a glance.
3. **Manager card** — shows scope (area chips or a role badge), worker count, rolled-up progress, and
   the manager's pending **delegation plan** (a `plan` HITL: "spawn these workers?") when present.
4. **Supervision cue** — indicate when a manager **auto-resolved** a low-risk worker decision vs. when
   something **escalated** to the operator (ties to the risk-escalation policy). A small "handled by
   manager" marker + an Inbox filter.

**Acceptance:** an operator can create a *Review Manager* exactly as easily as a *Billing Manager*,
see its workers nested under it, review its delegation plan, and tell at a glance which worker
decisions the manager handled vs. escalated.

## Dependencies & scope notes
- **Job A** is buildable now (additive fields; no engine dependency) — ship independently.
- **Job B** depends on the **agentic-manager runtime** (ROADMAP v2) for the live behavior, but the
  **creation flow + hierarchy visualization can be designed in parallel** against the data model
  (`role`, `parentId`, scope). Design now, wire when v2 lands.
- Reference briefs: [agent-hierarchy.md](agent-hierarchy.md) (the model), [positioning.md](positioning.md)
  (why), [ROADMAP.md](../ROADMAP.md) (v1 labels/mass-inform, v2 managers).
