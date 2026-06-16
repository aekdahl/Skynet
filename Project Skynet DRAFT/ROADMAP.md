# Tower — Roadmap

> Mission Control is a fleet-supervision console for running coding agents in parallel.
> The **UI is built and interactive**; the orchestration engine behind it is not.
> This roadmap lists what is **planned but not yet built**. For what _is_ built, see the
> Frontend Integration Brief; for the engine contracts, see the Backend Integration Brief.

**Legend:** 🔴 not started · 🟡 partially mocked in UI (no real engine) · ⬜ design exists, needs build

---

## Phase 0 — Foundations (blocks everything)

- 🔴 **Persistence.** All state (projects, tasks, agents, fleet, queue) is in-memory and resets on reload. Back the four collections with a real store + read API.
- 🔴 **Real-time transport.** Replace the two client-side simulation loops (1s wait-tick, 4s log poll) with a WebSocket/SSE stream: `agent.log`, `agent.progress`, `agent.heartbeat`, `agent.status`, `hitl.raised`, `hitl.resolved`, `conflict.detected`, `agent.completed`.
- 🔴 **Connect-time snapshot + deltas.** Send full state on connect, then patch per event.

## Phase 1 — Agents that actually run

- 🟡 **Real agent execution.** Assigning a task currently spins up a *mock* agent with a canned 4-step plan and simulated log lines. Wire real provisioning + execution.
- 🔴 **Runner interface.** Normalize start / pause / resume / message / fork / stop behind one provider-agnostic interface.
- 🟡 **Provider integrations.** UI configures 5 providers (Claude Code, Codex, Gemini, Cursor, Copilot) but none execute. Ship Claude Code end-to-end first, then the rest.
- 🔴 **Server-side busy-runner guard.** UI blocks retiring a busy runner; the backend must enforce it authoritatively.
- 🔴 **Server-driven provider/model catalog.** Model dropdowns are hard-coded in the client today.

## Phase 2 — The HITL round-trip (core value)

- 🟡 **Decision delivery.** Approve / reject / modify / pick-option are captured in the UI but don't reach a real agent. Deliver the decision and resume/merge.
- 🟡 **Chat with an agent.** The discuss composer echoes one canned reply. Connect it to the agent's real conversation channel.
- 🔴 **Idempotent, first-writer-wins resolution.** Multiple operators may resolve the same item; a second resolve should return the existing result, not error.
- ⬜ **Decision audit trail.** No history view exists. Persist every resolution (who/what/when/payload) and build a reviewable log.

## Phase 3 — Coordination & "no double work"

- 🟡 **Conflict detection.** The Home conflict banner reads static data. Compute conflicts from real activity — two agent *families* touching the same module (fork-aware: a fork and its parent are one family).
- 🟡 **Dependency gating.** Timeline shows dependency connectors from static `DEPS`. Derive real task dependencies and use them to order/gate work.
- 🔴 **Capacity nudges.** When the queue backs up and runners sit idle, suggest spinning up more. Hooks exist in the UI; behavior doesn't.
- 🟡 **Heartbeat health.** Heartbeat is a static number. Make it tick and shift to a warning state when an agent goes quiet.

## Phase 4 — Live preview pipeline

- 🟡 **Aimed-delivery preview.** Per-agent rendered mocks exist; replace with a real preview of the project's working branch (deploy URL / artifact / render service).
- 🔴 **Visual vs. non-visual flag.** Backend should mark which projects have a renderable delivery so the UI keeps folding the panel away for the rest.
- 🔴 **Keep previews current + sandboxed/auth'd.**

## Phase 5 — Platform & access

- 🔴 **Auth + workspaces.** The workspace switcher and avatar are visual only. Scope every entity, event stream, and credential to a workspace.
- 🔴 **Multi-operator presence.** Broadcast resolutions; optionally show who's viewing an item.
- 🔴 **Routing / deep links.** Navigation is in-memory state, not URLs. Add shareable links + browser back/forward if needed (map `view` + `projectId` + `agentId` + `lens`).
- 🔴 **Command safety.** `approval` items wrap real commands/migrations — validate, sandbox, and bound them server-side.

## Phase 6 — Mobile

- ⬜ **PWA.** Bring the main app to mobile as an installable, **Inbox-first** PWA (responsive views already map to it). Push notifications as the entry point into the Inbox. *(The standalone "Push to Approve" mock is reference-only and superseded by this direction.)*

---

## Productionizing (cross-cutting)

- 🔴 Port from in-browser React + Babel to a real toolchain (Vite/Next + JSX); replace `window.*` exports with imports; lift the four collections into a proper state layer.
- 🔴 Retention policy for logs and the decision audit trail.
- 🔴 Decide VCS model: one branch per agent, merge strategy, git-level conflict ownership.
- 🔴 Source of truth for "modules" — repo structure, CODEOWNERS, or a curated map.

---

## Explicitly out / parked

- **Keyboard shortcuts** — removed by request; not planned.
- **Scandinavian-light restyle** — considered and skipped; we keep the dark mission-control aesthetic.
- **Raw file trees / unstructured diffs in the UI** — against the code-agnostic principle; not planned.
- **Layout explorations** (`Tower - Reimagined.html`, `Tower - Operator Variations.html`) — reference only; "Operator / Classic" was selected and is the shipping shell.

---

_Built today:_ the full Operator shell (title bar · sidebar · status bar), all five Home lenses (Subway, Timeline, Ledger, Roster, + needs-you strip & conflict banners), Inbox triage (approve/reject/modify/chat/pick-option), project & task CRUD with a kanban, fleet configure/retire across 5 providers, agent detail (plan · log · modules · live preview · chat · fork), and tweakable theme/density.
