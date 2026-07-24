# Skynet — The Product Steward & the living Plan

> **Status:** proposed. Rides on the auto-dev-team blueprint
> ([docs/dev-team-blueprint.md](dev-team-blueprint.md)) and the area-manager hierarchy
> ([docs/agent-hierarchy.md](agent-hierarchy.md)); not on the MVP critical path.
> **Why:** let the operator run a whole build by *talking to one agent and making decisions* —
> "I want to build xyz," then discuss, direct, and feed new input as they figure it out — while
> the agent writes the tasks, keeps the roadmap, and orchestrates the work. Today people do this
> by having an AI keep throwaway roadmap/plan docs in the repo; Skynet can own that properly.

## What this brief adds (and what it doesn't)

The blueprint already defines the **Chief of Staff** (drafts the initial plan, owns the backlog,
assigns, digests, proposes scaling) and the **Spec Analyst** (runs intake, turns vague asks into
task briefs, asks clarifying `question`s). It also already says the operator "chats with any role"
and makes "one decision to start." **That is the engine.** This brief does *not* re-specify roles,
gates, or the pipeline.

It pins down two primitives the blueprint *assumes but leaves implicit*, and which the operator's
own description makes concrete:

1. **The living Plan** — a first-class, versioned Skynet entity the steward continuously maintains
   (the durable replacement for the repo's temp `ROADMAP.md`/`PLAN.md` scratch files).
2. **The Product Steward conversation** — one persistent, project-scoped thread that is the
   operator's single point of contact across the whole life of the project, not a one-shot intake.

Together they turn "chat with the CoS" from an ad-hoc capability into the **primary way work enters
and evolves** in a project.

---

## 1. The loop (the operator's five steps, mapped)

```
1. Operator: "I want to build xyz."
      └─ Steward opens the project conversation, runs intake (Spec-Analyst hat),
         asks follow-ups as `question` HITLs, drafts the CHARTER (G-1, human-owned).
2. Steward drafts the PLAN v1 (CoS hat): milestones → initial backlog tasks,
      dependency-ordered, honest estimate ranges. Raised as ONE `plan` HITL.
      └─ Approving writes Plan v1 and creates the backlog tasks (author scope).
3. Operator directs in the conversation: "kick these off, hold that one, and
      here's a new idea." Steward creates/edits/orders tasks and updates the Plan.
4. Skynet orchestrates execution — the autonomy loop (triage/pickup/review) and,
      for larger areas, area-managers (agent-hierarchy.md) run the tasks to merge.
5. Operator only decides: features, end-state, trade-offs — surfaced as HITL. The
      steward writes the tasks, keeps the Plan current, and reports progress.
```

Nothing here self-approves: the Charter (G-1), the initial plan, and every risky task decision
remain human gates (blueprint §3). The steward *arranges and records*; the human *decides*.

---

## 2. The living Plan (new entity)

The Charter is the fixed **contract** (goals, non-goals, done-definition — changes rarely, G-1).
The Plan is the **evolving state of the work** — what people keep re-writing in a repo doc today.
Make it a Skynet entity so it's durable, versioned, visible, and owned by the operator (not lost
in a branch or a chat scrollback).

```ts
// packages/shared/src/contracts.ts (additive)
Plan = {
  id, projectId, workspaceId,
  markdown: string,          // the human-readable roadmap the steward maintains
  version: number,           // bumped on every steward edit
  updatedBy: string,         // "steward:<agentId>" or an operator id
  updatedAt: number,
  // lightweight structure the UI can render without parsing prose:
  milestones: { id, title, state: "planned"|"active"|"done", taskIds: string[] }[],
}
```

- **Ownership:** the steward writes it; the operator can edit inline (an edit is just another
  version, attributed). Every change is a `plan.upserted` event through the `hub` — same streaming
  spine as everything else, so it lands in the audit trail and (later) the memory corpus.
- **Rendered in the project view** beside the kanban — the roadmap and the board are two views of
  the same work (milestones ↔ tasks via `taskIds`).
- **Not repo-coupled.** It lives in Skynet and works for chat-only projects too. Export/sync to a
  repo file (`ROADMAP.md`) is optional and rides the **v4 memory** repo-native sync — the Plan is
  exactly the kind of portable, user-owned artifact that layer already promises.
- **One per project** (matches "one CoS per project"). Milestones give the digest and the subway a
  real backbone instead of inferring structure from loose tasks.

## 3. The Product Steward conversation (new surface)

Today a `chat` interaction targets a **run** (a task's execution). The steward needs a thread that
targets the **project** and outlives any single run.

- A **project-scoped conversation** (`conversationId` on the project; messages carried on the
  existing chat event shape, `runId: null`, `projectId` set). The operator's home for "talk to the
  team."
- Backed by a **long-lived steward agent** — the CoS/Spec-Analyst hats from the blueprint, but
  persistent for the project rather than spun per task. It holds project memory (Charter, Plan,
  recent decisions) as context.
- **Its tools are Skynet's own** — the MCP `author` scope already exposes create/assign/order/edit
  task and (add) an `edit_plan` tool. **Wrap, don't rebuild:** the steward is a runner driving the
  Skynet MCP surface (docs/mcp.md), not a new bespoke task engine. It never edits product code.
- **Decisions go through HITL**, never chat guesses: a fork in direction is a `question`; a plan
  change is a `plan` gate. The conversation is for discussion; commitments are gated + audited.

| Steward needs to… | Reuses |
|---|---|
| create / assign / re-order / edit tasks | MCP **`author`** scope (already exists) |
| maintain the roadmap | new `edit_plan` tool → the Plan entity (§2) |
| execute the backlog | **autonomy loop** + **area-managers** (agent-hierarchy.md) |
| ask the operator to decide | **HITL** `question` / `plan` → Inbox |
| remember decisions across sessions | **v4 memory** (decision-derived facts already flow through `hub`) |

## 4. Boundaries (so it doesn't sprawl)

- **vs. Charter** — Charter is the one-shot, rarely-changing contract (G-1). Plan is the living,
  frequently-updated worklist. The steward reads the Charter, writes the Plan.
- **vs. area-managers** — the steward is the *human-facing planner/PM* (project scope, owns intake
  + Plan + backlog). Area-managers are the *execution* layer (per-area, decompose → workers → merge).
  The steward feeds them tasks; it does not itself spawn workers or touch code.
- **vs. task runs** — a task's `chat` is still per-run (discuss that execution). The steward
  conversation is project-level and about *what to build and next*, not one run's mechanics.

## 5. Phasing (each step usable alone)

1. **Plan entity + project view panel** — steward (or operator) maintains a markdown Plan;
   milestones link tasks. Independently useful the day it lands (durable roadmap, no temp files).
2. **`edit_plan` MCP tool + author-scope wiring** — an agent can propose Plan edits + backlog tasks
   under the existing author scope; Plan/backlog changes are gated + audited.
3. **Persistent steward conversation** — project-scoped thread + long-lived steward agent (CoS +
   Spec-Analyst hats), intake → Plan v1 → ongoing direction. This is the "talk to one agent" UX.
4. **Fold into the blueprint's gated pipeline** — steward-authored tasks flow through the toll gates
   and (for larger areas) area-managers; the digest reports against Plan milestones.

## 6. Wrap-don't-rebuild check

Every new bit is Skynet-side management, not agent internals: the Plan is a document + events, the
steward is a runner on the existing seam driving Skynet's own MCP tools, decisions reuse HITL, and
execution reuses the autonomy loop and area-managers. We add *what to build and track*, never the
agent's planning/coding/tool loop (docs/positioning.md).

## Open questions

- **Plan authorship conflicts** — operator inline-edits vs. steward edits: last-writer-wins with
  version history, or a soft lock while the steward is drafting? (Same class as DEF-001 — prefer a
  version check on write.)
- **Structure vs. prose** — how much of the Plan is structured (`milestones`) vs. free markdown the
  steward owns? Start markdown-first with a thin milestone index; harden later.
- **One steward or the full blueprint** — the steward can ship as a single CoS+Spec agent (small,
  useful) long before the full multi-role team; the entity/surface here are the substrate for both.
