# Skynet — Roadmap

**How to read this:** Skynet ships in versions. **v0 (MVP) is the only committed scope**; later
versions are directional and will be reordered as we learn. Deep detail for big features lives in
`docs/` briefs. The principle behind every entry: **wrap, don't rebuild** — Skynet is the
management/memory/leverage layer over off-the-shelf coding agents, not an agent itself
(see [docs/positioning.md](docs/positioning.md)).

**Committed target = the local desktop app.** The only in-scope release right now is the
**local-first Electron app** (BYO key, runs on the operator's own machine, keys never leave the host).
A **hosted / multi-tenant** deployment is **explicitly out of scope** — everything that exists only to
serve one (GCP infra, multi-replica scale, SSO, CORS/rate-limit hardening, team roles, SIEM export) is
deferred and tagged 🏢. See **[Deferred — hosted release](#deferred--hosted--multi-tenant-release-not-in-scope-)**.

**Sequencing — ship staggered, not "orchestration then moat."** The memory moat *compounds with
usage*: it distills from the streams (`hub`) and decisions (`hitl_audit`) that only exist once people
run agents through Skynet, so waiting for the moat means launching with an empty second brain. We do
**not** wait. We **launch on governance** (the safety layer + decision audit + HITL Inbox — already
built, and genuine white space vs. every competitor surveyed), capture memory raw material from the
first run, and pull a **thin Memory v0 forward** (v1.5) so we're never "just another orchestrator."
The area-manager hierarchy (v2) deliberately waits *behind* the moat's start. **Orchestration is the
funnel; governance is the launch wedge; portable, open memory is the moat.**

**⭐ Signature bets** — the "nobody-else-has-this" differentiators (a competitor sweep of 60+ tools
found these rare-to-absent), and where they live:
1. **Open portable memory — one second brain across every agent** (v4; thin v0 in v1.5): user-owned,
   cross-vendor, exposed as an **MCP memory server any tool can read/write, even outside Skynet**.
2. **Cross-vendor consensus runs** (v1.5): same task on Claude + Codex + Gemini, auto-diff, keep/merge
   the winner — or have them peer-review each other.
3. **Prompt-injection / tool-poisoning firewall** (v1, landed): gate tool calls steered by untrusted content the
   agent read (issue / web page / dependency). The category's first agent-security layer.
4. **Provably-improving fleet** (v5): measure which memory + task phrasings one-shot vs. churn, promote
   the winners, and show the user the curve.
5. **Compliance evidence pack** (v1): one-click signed "AI change report" — every AI-authored change +
   who approved + why + the policy at the time (EU AI Act tailwind).
6. **Org-wide knowledge diffusion** (v1 mass-inform + v4): one teammate's decision instantly informs
   every teammate's agents.

**Recommended near-term order (re-prioritized on the findings)** — ship in this order:
**(1) Provider breadth** (Codex/Gemini/Cursor/Copilot + **OpenCode**) — the *only* place we trail the field,
and it's table stakes (also unlocks consensus runs); **(2) Governance-to-SOTA quick wins** (the launch wedge,
mostly already built) + **guided provider connect**; **(3) v1.5** ease-of-use + **Memory v0** (the wedge that
makes us not-just-another-orchestrator); **(4) Cross-vendor consensus runs** (needs the v1 providers).
Everything below stays directional.

**Current batch priority order** — see [docs/operating-memo.md](docs/operating-memo.md) §8 for full rationale.
Items are ranked PMF > Platform > Product within each batch:

| Batch | # | Item | Track |
|-------|---|------|-------|
| **N (now)** | 1 | 🔒 Security hardening — Aug 2026 audit remediation (7 findings, see v1 section) | Security |
| | 2 | deep-review / breaker-review settings UI toggle | PMF |
| | 3 | Memory v0 — operator-authored facts, injected per project | Platform |
| | 4 | Reactive runner breadth (Kimi Code landed) | Product |
| | 5 | First-run onboarding telemetry (anonymous install events) | PMF |
| | 6 | Mass inform — Fleet/Project UI (multi-select + whole-project) | Product |
| **N+1** | 1 | Memory v0 — decision-derived fact capture from `hitl_audit` | Platform |
| | 2 | Desktop code-signing (macOS + Windows) | GTM |
| | 3 | Cross-vendor consensus runs (same task, two agents, auto-diff) | Platform |
| | 4 | Preview Phase 2 — service-container runtime + auto-rebuild on merge | Product |
| **N+2** | 1 | Memory v0 — workspace-scoped MCP read/write server | Platform |
| | 2 | Autonomy telemetry dashboard (ZTMR, HITL volume, resolution time) | PMF |
| | 3 | Approve-with-rule batch mode (similar gates, one decision) | PMF |
| | 4 | Plan entity + project view panel (Product Steward foundation) | Platform |

Legend: 🔬 = needs an LLM / open research · 🔗 = has a design brief · ⛓ = depends on earlier version ·
🏢 = hosted-only (deferred; **not** needed for the local desktop release).

---

## v0 — MVP · the local desktop app  ✓ shipped

**Goal:** an operator installs the **desktop app**, points it at a repo + their Anthropic key, assigns
a task, and a **real Claude agent** does the work in an isolated worktree under human supervision, then
merges — all **local-first, on their own machine**.

**Must build / resolve:**
1. [x] **Live Claude execution** — drive Claude Code via the Agent SDK/CLI; resolve the headless auth (scrub conflicting `CLAUDE_CODE_*`/gateway env so `ANTHROPIC_API_KEY` is used).
2. [x] **Worktree-per-runner provisioning** — each agent gets an isolated git worktree/branch.
3. [x] **Repo connection + `.skynet/modules.json`** — a workspace points at a real repo + integration branch.
4. [x] **Provider credential management** — per-workspace keys, injected into runners, never client-exposed.
5. [x] **Sandboxed runner (local legs)** — defense-in-depth without a container: command allow/deny, worktree write-confinement, and a wall-clock runtime cap that force-fails runaway runs.
6. [x] **Real-execution event fidelity** — real diffs → diff HITL, changed files → modules, branch → preview.
7. [x] **Local auth posture** — the desktop app serves on localhost as the single operator, secure-by-default via `AUTH_REQUIRED` (fails closed unless dev/test).
8. [x] **Onboarding / first-run** — create workspace → connect repo → add key → add runner; retire seed fixtures.
9. [x] **Desktop packaging (beta, unsigned)** — packaged mac/Windows installers via `electron-builder` with `electron-updater` and a tag-triggered CI release to GitHub Releases; ships unsigned by decision for beta.
10. [x] **E2E of the full loop (manual acceptance)** — the full assign → diff-review → approve → merge → done loop is LLM-judged end-to-end against a real Claude agent in the packaged desktop build, with an automated guard on every PR.
11. [x] **UX/UI first-run polish to SOTA** — fixed the pre-release UX review's launch blockers in the first-run experience: loading states, empty-state CTAs, disabled-button styling, and fleet-readiness surfacing.

**Scope:** Claude-first · **local-first desktop app** (BYO key, single operator, file-store persistence,
keys never leave the machine). **Hosted / multi-tenant is out of scope** (🏢 deferred — see below).
**Done =** the full loop runs on a **packaged desktop build** (beta, unsigned) on an operator's own
machine. *(**All v0 must-build items are done** — the beta is cuttable: tag `v*` → the desktop-release
CI publishes installers. Code-signing is the one deferred piece, split to v1.)*

---

### Deferred — hosted / multi-tenant release (not in scope) 🏢

A hosted deployment is **explicitly out of scope** for the current release; the product ships as the
local desktop app above. These pieces exist **only** to serve a hosted/multi-tenant instance — none
block the local release, and each is tagged 🏢 where it appears in a later version:
- **Cloud deploy & infra** — GCE VM + Docker (app + runner containers) + Cloud SQL + Memorystore +
  staging URL/TLS. *(Pulled out of the v0 must-build list; picked back up when hosting is in scope.)*
- **Multi-replica scale + containerized runner** — Redis fan-out, GKE Jobs, per-agent container
  isolation with memory/CPU (cgroup) caps + network-egress allowlist (v1).
- **Hosted auth & tenancy** — real multi-user login, SSO/OIDC, scoped CORS, rate limiting, the
  read-only viewer role, and time-limited admin promotion (v1).
- **Enterprise integrations** — SIEM export of the audit trail; hosted observability
  (metrics/logging/tracing); hosted memory sync + team sharing (the v4 open-core paid layer).

The **governance wedge itself is local** (safety classifier, HITL Inbox, decision audit all run on the
desktop build) — only its enterprise *export/sync* surfaces are 🏢. When hosting re-enters scope, this
is the bucket to pull from.

*Hosted scaffolding landed opportunistically (still 🏢 as a release path — pieces in place, not the release itself):*
- *A **`public_ui` GCP mode** that serves the whole app over HTTPS on a domain (drops IAP for the UI), with the
  optional `/mcp` door on the same instance so a single VM can host the app + MCP endpoint. The GCP wizard
  prompts for `public_ui` + domain + ACME email.*
- ***Telegram-OTP MFA + recovery codes** for the public login path — the auth handshake exists for when a
  hosted release turns on public sign-in; today's local desktop path is unchanged.*
- ***Data-disk snapshot before each VM apply** in `setup.sh` — the deploy machinery snapshots persistent
  state pre-mutation so hosted rollouts are recoverable.*
- ***Durable login sessions on the GCP VM** (`durable_sessions`, default on) — a Redis sidecar container
  with AOF persistence on `/data/redis`, sessions via `SESSIONS=redis`. Fixes a real reported pain ("I get
  logged out all the time"): the app container's restarts are its DESIGNED recovery path (memory cap →
  OOM-kill → `--restart=always`), and with `SESSIONS=memory` every such restart invalidated every login.
  Sessions now survive container restarts and VM reboots alike; no extra cloud resources (a sidecar on the
  same VM, capped at 96 MB, never published to the host, accounted for in the app container's memory
  reservation). Template renders verified both ways + `bash -n` clean + `terraform validate` passing.*
- ***Project-scoped MCP service tokens** — tokens can now be pinned to specific projects (not just
  workspaces), so an MCP token issued to an external agent is naturally sandboxed to the project it should
  see. Necessary groundwork for shared/hosted MCP access.*

---

## v0.5 — UX release polish (pre-release · from [docs/ux-review.md](docs/ux-review.md))

Findings from the July 2026 end-to-end audit. **P0 blocks release; P1 makes the core loop
sell itself.** (P2/P3 items from the same audit are slotted into v1 / v1.5 below.)

**P0 — integrity & first impressions**
1. [x] **Router + nav-state integrity** — sidebar nav highlighting now derives purely from router state through one function, so highlights can no longer accumulate across views.
2. [x] **Onboarding step 2 (GitHub) is a PLACEHOLDER** mid-wizard — removed the unfinished GitHub step from the onboarding wizard; Integrations owns that connect flow post-onboarding instead.
3. [x] **Blocked-CTA / disabled-state system** — unified disabled-button styling app-wide with a shared, visible inline reason instead of hover-only tooltips.
4. [x] **Legibility floor** — swept `styles.css` for text under the ≥11px/`--muted` legibility floor and fixed every instance carrying meaning, reserving `--faint` for genuine decoration.
5. [x] **Persist the workspace name server-side** — workspace name now persists via the settings API instead of a client-side `localStorage` helper.

**P1 — core-loop guidance & affordances**
6. [x] **Continuation after Create project** — creating a project now lands in it with the task composer focused, plus a live first-run checklist on Home until the first merge.
7. [x] **Task composer polish** — confirmed the composer's autofocus, placeholder copy, ⌘↵ submit, and visible blocked-reason state were already in place.
8. [x] **Assign is a primary affordance** — relabeled to "Start →" and put it directly on backlog/todo kanban cards, with `todo → ongoing` as a legal drag transition.
9. [x] **Explain the Autonomy toggle** — added a visible subtitle explaining the toggle, and a workspace's first project now defaults Autonomy off.
10. [x] **Fleet copy & guardrails** — fixed pluralization and CTA copy, added an inline confirm dialog to Retire, and corrected the provider strip's wording.
11. [x] **Inbox empty state teaches** — the empty state now lists all four gate kinds with a one-line explanation each.
12. [x] **Prioritize the backlog _and_ todo** — extended manual reorder to todo cards too, so a card's rank also drives which task Autonomy auto-picks first.

## v1 — Orchestration completeness & hardening
- [~] **Momentum Board — automated kanban rebuild.** Data model + signals + rule engine + design system landed server/shared-side (TASK 00 data model #607, TASK 01 GitHub signal parsing #608, TASK 02 rule engine + stall detection #610, TASK 03 rules/transitions/proposals API + realtime #611, TASK 04 design tokens + primitives #609); **TASK 05 lands the actual board UI**, gated per-project behind `Project.newBoardEnabled` (mirrors `Project.autoMerge.enabled`'s opt-in shape) so the current six-state board (`apps/web/src/views/project.tsx`) is untouched for every project that hasn't opted in. `apps/web/src/kanban/{board,cards}.tsx` maps the six real `TaskState`s onto 4 presentation buckets via `columnBucket()` (packages/shared/src/kanban.ts, pure — no new state machine): Intake (dashed accent) · Queued (solid human-blue bar + a real WIP counter, new `Project.queuedWipLimit`) · In Flight (the `ak-sweep-bar` lime gradient primitive) · Landed (a 6-day sparkline of `to:"done"` transitions). A card animates into its new column on every genuine bucket move (a plain CSS mount keyframe — React already remounts a card when it changes list membership, so no separate WS-event listener/diff-tracker was needed). WIP holding is purely a derived split of the live Queued list (first N by `Task.order` render as queued, the rest as dimmed "held" cards with a promotes-when-a-slot-frees note) — nothing is persisted as "held", so auto-promotion is just next-render recompute, verified live (moving a queued task out auto-promoted the held one instantly, no reload). The automation pill (`N RULES LIVE · M MOVES TODAY · X% touched by hand`) reads `Snapshot.rules`/`proposals` (already WS-live) plus a per-project `GET /transitions` fetch merged with live `transition.created` deltas — none of this aggregation existed server-side, so it's computed client-side from the raw feed. **Real bug found and fixed via live verification** (not just tests): `Operations.transitionTask` — the human "move a card" path — never called `hub.recordTransition`, so only rule-engine moves ever hit the Transition feed and "% touched by hand" would misreport ~100% automation on any project a human was actually driving; fixed with a `recordHumanTransition` helper (`actor:"human"`, `ruleId:null`), regression-guarded in `tests/task-transitions.test.ts` (stashed the fix, confirmed the new assertions fail, popped it back). No per-task checkpoint record exists yet (`TaskCheckpoints` is explicitly not persisted) so the In Flight focus card's `CheckpointRail` is derived straight from real `TaskRun`/`Task` fields (`branch`/`pr`/`mergedAt`/`flyDeployment`/`reviewVerdict`) rather than fabricated; "review 2/2" from the original design brief has no backing data anywhere in the model (`Task.reviewVerdict` is one decision, not a count) so the rail's review label stays plain rather than inventing a number. Stalled-card countdown mirrors the rule engine's `stallEscalateHours` default (96h) client-side since it isn't exposed over the API (the server only ships an already-elapsed `staleHours` snapshot on a `stall_nudge` Proposal) — a known, documented approximation, not a real config read. Verified end-to-end live in the browser against a real dev server (no mocks): flag on/off toggling switches boards instantly with zero regression to the old board; WIP limit + held/auto-promote; a task moving columns with no page reload; the automation pill's numbers matching real seeded Transition data. **TASK 06 lands the panel every card clicks into**: `apps/web/src/kanban/task-detail.tsx` — a 760px right-side drawer, task-CENTRIC (not run-centric, so it works for a queued task with no run yet — the existing `views/task.tsx` is keyed by `TaskRun` and can't), local `selectedTaskId` state owned by `board.tsx` (not the app's global `#/task/:id` route, deliberately — a card's click is a drawer, not a navigation). Breadcrumb (project / epic / task) + a state chip; body grid `1fr | 260px`: left = real Subtasks (`Task.parentTaskId`, clickable — verified live, both directions, including the "↑ Subtask of…" back-link) + suggested-but-unaccepted ones (pending `suggested_subtask` Proposals matching this task, dashed/lime, individual Accept + Accept-all wired to the already-existing `/subtasks/accept(-all)` endpoints via two new `Store` mutations); Trail = every real `Transition` for the task (`GET /api/tasks/:id/transitions`, new `fetchTaskTransitions`) rendered with `TrailRow` — verified live that a human mover's name renders in the PLAIN (non-machine) style, confirming `recordHumanTransition`'s data reaches this view correctly. Right rail: Checkpoints (the same 5 stages, full detail — each names its resolving signal, e.g. "PR #482 opened", or "—" when not yet reached), Owner (assignment mode + resolved agent names), and a decision block (only rendered when the task's run has a real open diff/merge HITL) whose MERGE/HOLD buttons call the exact same `store.resolveHitl(id, "approve"|"reject")` the old board's own diff-approval UI uses — no new merge logic. Sandbox limitation, same as TASK 05: no LLM credential here means no real agent run → no real diff HITL or rule-engine-generated suggested-subtask Proposal to exercise MERGE/HOLD or the accept-suggestion flow live; everything else (panel open/close, breadcrumb, real subtasks + navigation, Trail, Checkpoints, Owner, empty states) was verified live end-to-end against a real dev server.
- [x] **Momentum Board — Activity Feed (TASK 08, Phase 6b).** A 480px "Feed" tab (`apps/web/src/kanban/feed.tsx`) listing every `actor:"machine"` Transition, grouped Today/Yesterday/Earlier, each row one sentence (subject task bolded) + mono `rule · Ntime-ago` metadata + a trailing action: lime "undo · Xm left" with a real live countdown (reuses `useNow`, already threaded through `ProjectView`), plain "review" (the existing generic `onOpenTask` callback — see gap below), or amber "escalates in Xh" for a task with a pending `stall_nudge` Proposal (reuses `board.tsx`'s `STALL_ESCALATE_HOURS_DEFAULT`, now exported). A footer callout summarizes the day's machine-vs-human split from the same Transition data. **Two real server-side gaps found and fixed**, not just UI work: (1) `Operations.undoRuleAction` already existed (correct logic, calls `RuleEngine.undo`) but had zero HTTP route — added `POST /api/pending-actions/:id/undo`; (2) `store.listPendingActionsForProject` existed at the store layer (both `memory.ts`/`postgres.ts`) with no Operations wrapper or route — added `Operations.listPendingActionsForProject` + `GET /api/projects/:id/pending-actions`. Both regression-guarded in `tests/kanban-api-surface.test.ts` (a full HTTP-layer test: seeds a real `RuleEngine`-backed `Operations`, drives a `move_task` rule through announce → sweep-finalize → `app.inject` undo, asserts the task state reverts and a reversal Transition is written; stashed the routes, confirmed both new tests fail, popped). No WS event exists for a `PendingRuleAction`'s own lifecycle (only the Transition it eventually produces is pushed live) — the feed refetches `finalized` pending actions on a 30s interval and applies a successful undo's result optimistically client-side; the *reverted* Transition itself does ride a genuine `transition.created` push, so the new row still appears live with no refetch needed. **TASK 06 (task detail panel) turned out to never have reached `main`** despite its PR showing "MERGED" — its base branch was itself merged first, stranding the commit (caught by diffing `git log origin/main` against the PR, not trusting `gh pr view`'s status); the Feed's "review" action was built against the existing generic `onOpenTask` prop instead of depending on it, so this task shipped self-contained rather than silently breaking. **A real UI bug found via live verification** (not caught by any test): the row's evidence-text fallback for non-move actions (`add_label`/`post_slack_nudge`/`create_proposal`, where `from === to`) read `evidence[0]`, which is always the generic trigger description (`"task.upserted → backlog"`) — every action's *own* result text is `evidence[evidence.length - 1]` (`createPendingAction`/`executeAction` in `rules/engine.ts` always append `[trigger, ...actionResult]`); found by seeding a live `create_proposal` rule and reading the rendered sentence, fixed to read the last entry. Verified end-to-end live against a real dev server (no mocks, no LLM needed — rule matching is deterministic): seeded rules that move a task through an announce-before-acting window, watched the row appear live within the 30s sweep + WS push, clicked "undo" before the window closed and confirmed a real reversal Transition appeared live and the countdown chip correctly disappeared past expiry; seeded a `create_proposal` stall rule and confirmed the amber "escalates in Xh" chip renders with correct duration math.
- [x] **Momentum Board — pattern-spotted automation onboarding (TASK 10, Phase 8).** Closes the loop: a repeated MANUAL move becomes a proposed rule instead of staying tribal knowledge. A new `RuleEngine.sweepPatternDetection` sweep (same reaper pattern as TASK 02's stall sweep, `config.patternDetectSweepMs`/`patternDetectWindowDays`/`patternDetectThreshold` — 1h/30d/3 defaults) groups `actor:"human", ruleId:null` Transitions by exact `{from,to}` within the window, requires the threshold cleared by DISTINCT task ids (one task bouncing back and forth is noise, not a pattern), and creates a `suggested_rule` Proposal with real detector stats (`SuggestedRulePayload.detected`: `sampleSize`/`matchCount`/`matchRate`/`windowDays`/`estimatedMinutesSavedPerMonth`) — `matchRate` is "of every human move OUT of `from` in the window, what fraction landed on `to`", not just a raw occurrence count. **Deliberately scoped down from the brief in one honest way**: "similar triggering condition (e.g. same label present)" has no backing data anywhere in this codebase (no `Task.labels` field, no label webhook parsing, confirmed by reading the whole model before writing code) and the engine's condition vocabulary has no label/priority-equals operator to express one even if it did — the detector groups on `{from,to}` alone via the one operator (`state_equals`) it can honestly support end-to-end, rather than fabricating a signal. UI: a 480px "pattern spotted" card at the top of the existing Rules tab (`apps/web/src/kanban/pattern-onboarding.tsx`) reusing `rules.tsx`'s `describeCondition`/`describeAction` (now exported — no separate "chip" component exists anywhere in the app, only editable form rows) as a read-only summary, plus `BacktestCard` reused completely unmodified (already pure/read-only). Three actions: **Turn it on** (`acceptProposal(..., {activate:true})` — new optional param, creates the Rule `state:"live"` immediately), **Watch first** (plain accept — the existing default, `state:"watch"`), **Never** (the pre-existing `dismissProposal` — its own doc comment already anticipated this exact use: "this dismissed row is what a future pattern-detector should check before re-proposing the same rule"). Two schema fields added to `Rule` (`watchStartedAt`, `updatedAt`) power a second new sweep, `sweepWatchPromotion`: a watch-state rule left unmodified for `config.watchPromoteAfterMs` (7d default) since it last entered watch auto-promotes to live — "unmodified" compares `updatedAt` (bumped on every `updateRule` call) against `watchStartedAt`, so an operator actively tuning a rule during its watch week is read as engagement, not silent approval, and is left alone. **A genuine, previously-unimplemented promise made real**: `RuleLifecycleState`'s own doc comment claimed watch mode is "evaluated and logged, never acts" but `handleEvent` filtered watch-state rules out entirely — nothing ever evaluated them. Now a watch rule's matching conditions bump a new `RuleStats.watchMatches` counter (surfaced on the rule row: "N matches while watching") with zero dispatch, no Transition, task never touched — a real, live, honest implementation of a promise the schema had been making for phases. **Two real bugs found and fixed via live verification, not caught by unit tests alone**: (1) the dedup check only suppressed re-proposing a pattern already `pending`/`dismissed`, not one already **accepted into a real Rule** — since the historical Transitions that earned a proposal never expire from the window on their own, every subsequent sweep re-proposed the exact same pattern an operator had already turned on (caught live: clicked "Turn it on," ran the sweep again, got an identical duplicate proposal back); fixed by also excluding any non-archived Rule's own pattern key, regression-guarded in `tests/rule-engine.test.ts` (reverted the fix via a scripted patch, confirmed the new test fails, restored it) and re-verified live across 3 more sweep cycles with zero duplicates. (2) Reusing TASK 07's `BacktestCard` for a FROM-state-triggered proposal surfaces a pre-existing semantic gap, not a new bug: `backtestRule` matches a condition against `t.to` (the state a task landed in), so a `state_equals:"backlog"` condition — the natural shape for a "Backlog → Triage" pattern — reads "0 would have matched" even though the pattern genuinely occurred 3 times, because no transition in the project's history ever left a task's `to` sitting at `backlog`. The detector's own `detected` stats (computed independently, not from `backtestRule`) are unaffected and remain the primary, correct signal on the card; left `backtestRule`'s core semantics unchanged rather than risk regressing TASK 07's existing behavior/tests. Verified end-to-end live against a real dev server (no mocks, no LLM needed — pattern matching is deterministic): moved 3 distinct tasks through the same manual `{from,to}` sequence twice, watched two "pattern spotted" cards appear live with correct stats (100% match rate, 3 times in 30d, ~6min/mo saved), clicked "Turn it on" on one (verified the Rule landed `state:"live"`) and "Watch first" on the other (verified `watchStartedAt` set, `state:"watch"`), touched a live backlog task and watched the watch rule's `watchMatches` counter increment with the task never moved and no Transition ever written, and — with the sweep intervals turned way down for the session (`SKYNET_WATCH_PROMOTE_AFTER_MS=15000`) — watched the unmodified watch rule auto-promote to `state:"live"` on its own within 15s.
- [x] **Momentum Board — motion, responsive, and accessibility hardening pass (TASK 13, Phase 10).** A cross-cutting audit of every behavioral requirement from the original design handoff that isn't "draw a screen," run against the real merged UI across TASK 04-11 (5 parallel research agents audited focus/keyboard, loading/reconnect, error handling, breakpoints, and hover states independently before any fix landed). **1. Keyboard + focus.** Keyboard parity was already clean — every accept/undo/merge/retry/dismiss control across every screen is a real `<button>`, confirmed by direct DOM inspection and by Tab-reaching several live. The real gap: `rules.css`, `pattern-onboarding.css`, `feed.css`, and `task-detail.css` never adopted the `--ak-focus-ring` token their sibling files (`kanban.css`/`board.css`/`gravity.css`/`health.css`) already used, falling back to the app's generic `--accent` outline instead — added scoped `:focus-visible` overrides (own classes + panel-scoped `.btn` selectors, never touching the app-wide `.btn` rule other non-kanban screens share) everywhere. Live-verified: `document.activeElement` after a real Tab landed on `.rb-state-btn`, computed `boxShadow` read back exactly `rgba(211, 242, 106, 0.5) 0px 0px 0px 2px` — the literal spec value. **2. Loading + reconnect.** No screen had a real loading state — `board.tsx`/`feed.tsx`/`health.tsx`'s own async Transition fetches rendered "0"/empty identically to "still loading," silently understating a project mid-fetch. Added a shared `.ak-skel-row` (surface-2 + a sweep, `prefers-reduced-motion`-guarded) to `kanban.css` and wired real `loading` gates into all three, plus upgraded Task Detail's plain "Loading…" text to the same skeleton. `store.tsx` already tracked `wsPhase`/`connected` (built for the app-shell reconnect banner) but nothing screen-level read it — wired `signalsStale = wsPhase !== "open"` into the Momentum Board's automation pill (the acceptance-tested requirement) and, cheaply, the Feed footer. Live-verified by stopping the dev server mid-session: the pill read exactly `"1 RULES LIVE · 0 MOVES TODAY · ⚠ signals stale"`; restarting cleared it. Gravity's own field is a radial layout, not row-shaped — a literal "skeleton rows" treatment doesn't map onto it, so it was deliberately left out rather than forcing a bespoke skeleton for a shape the spec's own wording doesn't describe. **3. Error handling.** Audited `rules/engine.ts` in full: `applyAction` itself rarely throws (every non-move action is a documented no-op-with-evidence by design), but every persistence call around it (`hub.recordTransition`/`upsertTask`/`upsertProposal`) could, and BOTH dispatch paths (`executeAction`, `finalizePendingAction`) had zero try/catch — a throw propagated straight to `handleEvent`'s bus-callback `.catch(() => undefined)` or `sweepPendingActions`'s per-item catch, a true black hole with no log, Transition, or Proposal, confirmed by grep (zero `console.*` calls anywhere in the file). Worse, the announce path's silent-retry-forever behavior on a stuck-pending action could produce a **duplicate Proposal** on every sweep tick if `create_proposal`'s `upsertProposal` succeeded before a later step threw. Fixed by wrapping both paths: a failure now records a new `status:"failed"` Transition (`Transition.status`/`failureReason`, additive — every prior row reads back as unfailed) with the reason, and — for the announce path — finalizes the pending action instead of leaving it dangling for accidental auto-retry. Added `RuleEngine.retryFailedAction`/`Operations.retryFailedAction`/`POST /api/rules/:ruleId/retry`, re-dispatching the rule's CURRENT actions for the task (not a stale snapshot of what failed) — the Feed's new "retry" button. Regression-guarded with a real throw (monkey-patched `store.putProposal` to fail once) proving the failed Transition, the no-double-retry finalize, and a subsequent successful retry, all against a real `MemoryStore`+`Hub`. Live-verified with a temporary, deliberately-scoped fault injection (`params.__forceFail`, added and fully reverted before commit — confirmed by grep): the Feed rendered the failed row in the exact warn palette (`getComputedStyle` confirmed `#F2B45C` on both the retry button and the failure text) with a working retry button that, once the injected fault was cleared, produced a real successful row live. **4. Responsive breakpoints.** `board.css`'s 4-column grid had zero `@media` query — columns squished toward 0 width uncontrolled below any threshold. Added `@media (max-width: 1100px)`: switches `.mb-cols` to a horizontally-scrolling flex row sized for exactly 3 columns' width, so the 4th is one scroll away — live-confirmed via `getBoundingClientRect` at 1050px (4 columns, ~244px each, `overflow-x: auto`) and reverted correctly to `display: grid` at 1400px. Gravity's own 1100px JS fallback (`gravity.tsx`'s `GRAVITY_MIN_WIDTH`, a `resize`-listening hook) was untouched and still intact — confirmed by reading it, not assumed. `feed.css`/`task-detail.css` were fixed-width drawers (480px/760px) only softened by `max-width: 100%`, never actually going full-screen below any breakpoint — added `@media (max-width: 720px)` (mirroring the app's own existing `.steward-dock` full-screen-at-narrow-viewport precedent in `styles.css`) to both, plus collapsing Task Detail's 2-column body to 1. Live-confirmed via computed `width` at 650px (Task Detail: 650px, no border, single-column body; Feed: fluid, not clamped to 480px) and reverted correctly above 720px. Automation Builder's own panel was never a fixed-width drawer to begin with (no backdrop, no `position:fixed` — an inline section that already reflows within the page's own container), so it genuinely didn't need the same fix — confirmed by reading its CSS, not assumed clean. **5. Hover states.** Audited every card/button across `board.css`/`gravity.css`/`health.css`/`rules.css`/`pattern-onboarding.css`/`feed.css`/`task-detail.css`: every existing card hover (`.mb-card`, `.gv-card`, `.mb-detail-subtask`) did the identical single thing (border-color only, no background lighten, no lift shadow, no transition — so the change was instant, not 120ms). Added a new `--ak-shadow-lift` token and applied the full treatment (border → machine-tinted, surface +2%, lift shadow, 120ms, `prefers-reduced-motion`-guarded) to all three — carefully suppressed on non-clickable variants (the Stalled card's outer wrapper, a suggested-subtask's non-interactive row) so hover feedback never implies clickability that isn't there, and layered (not replaced) Gravity's existing merge-ready glow via a same-specificity override. Added `text-decoration: underline` to the plain-text ghost actions (`.rb-del`, `.pso-never`, `.gv-mode-btn`, `.mb-detail-parent-link`) and a genuinely-missing hover state to `.rb-state-btn` (had none at all), brightening its border toward `--ak-track` (confirmed via `styles.css` as the correct token — it was previously unused for borders anywhere in the codebase). **Honest gap**: keyboard *reachability*, the exact focus-ring *value*, and semantic-button *correctness* were all confirmed programmatically (`document.activeElement`, computed `boxShadow`) and mouse-click activation of the identical code paths was separately verified live — but genuine keyboard *activation* (a synthetic Enter/Space actually firing a click) could not be mechanically proven through this session's automated browser tool: dispatched `keydown`/`keyup` events reached the DOM's own listeners (confirmed via an injected listener) but didn't trigger Chrome's native default action for a focused `<button>`, a documented characteristic of CDP-synthesized input, not an app defect — real keyboard users and screen readers rely on exactly the native `<button>` semantics already used throughout, correctly, per the audit.
- [x] **Momentum Board — Rail Graph board view (TASK 12, Phase 11).** The last of the 8 original-handoff screens: the board rendered as a commit-graph-style stream (`apps/web/src/kanban/rail-graph.tsx`), the 3rd tab in `gravity.tsx`'s `NewBoardView` switcher (Momentum / Gravity / Rail) alongside the two already-shipped metaphors. `Transition` (packages/shared/src/kanban.ts) is already commit-graph-shaped (`taskId, from, to, actor, ruleId, evidence, at`) so it's rendered directly, not lifted into a separate graph structure — one colored "epic trunk" `<div>` per `Feature` (via `Feature.color`, falling back to `--ak-track` when unset — see gap below), a node on the trunk for every real `Transition` touching a task in that epic, entries grouped by day with a sticky per-group date rail (a CSS-subgrid trick: each `.rg-day-group` is its own `120px|1fr` sub-grid nested in the outer `120px|1fr|300px` grid, so each day's `position:sticky` label sticks bounded by its OWN group's height and unsticks naturally as that day scrolls past — zero scroll-sync JS). The "continuous trunk line" is pure CSS too: every row renders every lane's line `<span>` at the identical fixed offset so stacked borders visually join into one line, with a node rendered as a flex-centered child of only the active lane's line (no absolute positioning, no magic offsets, robust to variable card heights). Three card kinds per spec: lime-bordered advance (`STATE_ORDER[to] > STATE_ORDER[from]`, a new small ordering table — the first place this codebase needed to compare state *progress* rather than just equality), warn-bordered stall with a REASSIGN? action, and a dashed-lime "epic auto-split" card (synthetic row, not a real Transition) for a parent task that gained children via `Task.parentTaskId`, positioned at the parent's most recent transition time. Right rail: per-epic health bars (avg `readiness()` — packages/shared's own existing pure scorer — across each lane's tasks, computed on render, no stored field) and a "what the board did for you" card (today's machine-transition count + live rule count) with "open feed" (navigates to the existing Activity Feed — the one deliberate, spec-required deviation from "no new data plumbing": a new `onOpenFeed` callback threaded `project.tsx` → `NewBoardView` → `RailGraphBoard`) and a ghost "pause rules" action. **New additive server endpoint**: `pause rules` bulk-sets every `state:"live"` Rule for a project to `"paused"` in one call rather than N client-side PATCHes — `Operations.pauseAllRules` + `POST /api/projects/:id/rules/pause-all` (leaves `state:"watch"`/already-paused rules untouched, `pausedReason:null` matching `updateRule`'s own "null = human-initiated" convention), regression-tested in `tests/kanban-api-surface.test.ts` (pauses exactly the live ones, publishes `rule.upserted` per rule, a repeat call is a genuine no-op, 404s for an unknown project) and gated behind a real confirm step client-side before the call fires (a genuine state change, not a read). The switcher itself: `NewBoardView` grew from a 2-way to a 3-way `role="tablist"`, Gravity's existing `>=1100px` `useViewportWidth()` gate (`GRAVITY_MIN_WIDTH`) is completely unchanged and still the only width-gated tab — Rail has no minimum width per the original spec, and Momentum never had one. **Two real pre-existing gaps found while building this, neither touched (out of scope per this task's own constraints) but both handled correctly rather than silently worked around**: (1) `Feature.color` (contracts.ts) has a schema field but genuinely no way to ever set it — neither `CreateFeatureRequest` nor `UpdateFeatureRequest` exposes it — confirmed by reading both schemas, not assumed; Rail Graph's fallback color path is therefore not a defensive nicety, it's the *only* path every feature in this codebase can currently take. (2) `MomentumBoardProps.onOpenTask` (ultimately `App.tsx`'s `openTask`) is misleadingly named — it always resolves by **run id**, never task id (`views/task.tsx` matches `tasks.find(t => t.runId === agent.id)` with zero task-id fallback), confirmed live: clicking Gravity's own `GravityCard` (`onOpen={() => onOpenTask(task.id)}`, already-shipped TASK 11) navigates to a broken "This agent was retired or completed" screen — a genuine pre-existing bug in shipped Gravity, left unfixed here per this task's explicit "no changes to any other already-shipped screen" constraint, but documented in a code comment and deliberately not copied: every Rail Graph call site (card-sentence link, REASSIGN?, auto-split subtask pills) uses `task.runId` and degrades to plain non-interactive/disabled content when a task has none yet (the common case for anything that hasn't started a run). Verified end-to-end live against a real dev server with seeded multi-feature data (3 lanes: 2 real features + the synthetic no-epic lane, confirmed via `activeLaneIdx` DOM inspection), a genuine stall (correctly disabled REASSIGN? since the stalled task had no run), and a real parent+children auto-split (dashed card, static non-interactive pills); "open feed" navigates correctly; "pause rules" requires confirm and, once confirmed, genuinely flips the live rule server-side (`state:"paused", pausedReason:null`) with the rule-count updating live via WS. Switcher fully live-verified at both widths: >=1100px all 3 tabs enabled and independently selectable; <1100px Gravity's tab correctly `disabled` and, critically, a Gravity-mode-*active* session correctly falls back to rendering Momentum on shrink (`effectiveMode` derivation) rather than a broken/blank Gravity render, with Momentum and Rail both remaining fully clickable at the narrow width throughout.
- [x] **Momentum Board — default rollout + removal criteria (TASK 14, Phase 11 — the last task in this epic).** Closes the Momentum Rollout epic (TASK 00-13): `Project.newBoardEnabled` now defaults `true` for every newly-created project (`packages/shared/src/contracts.ts`'s schema default AND, the value that actually matters, the explicit literal `Operations.createProject` sets — the two were previously in sync at `false`, now in sync at `true`). **Every existing project is untouched** — this only changes what a *new* project starts with; an operator can still flip it off per-project in settings (copy there updated to stop saying "off by default"/"try the new board," since it no longer is a trial). **Safety-checked before flipping, not assumed**: dispatched a dedicated audit of the exact claim the task spec made — "`parentTaskId` defaults null, checkpoints/readiness computed on read, never stored" — against the CURRENT code (not the original TASK 00 claim). Verdict: safe, but for a more precise reason than the claim states. Postgres/Memory store reads are a raw JSON pass-through with **zero Zod re-validation** (confirmed at `apps/server/src/store/postgres.ts`'s generic `get<T>`/`getTask`) — so a genuinely pre-Momentum-Rollout task row's `parentTaskId` comes back `undefined`, not the schema's defaulted `null`, at the store layer. The real enforcement point is the **client's parse boundary**: `Snapshot.parse()` (throwing) on initial connect and `WsMessage.safeParse()` on every live delta (`apps/web/src/lib/client.ts`) run the full Zod tree, and `.default()` fires there — by the time a `Task` reaches React, `parentTaskId` genuinely is `null`. Every downstream consumer (`cards.tsx`, `task-detail.tsx`) was independently confirmed to treat it defensively (truthy/optional-chained) regardless. Checkpoints (`TaskCheckpoints`, explicitly never persisted per its own doc comment) and Gravity's `readiness()` were confirmed pure/defensive at every call site — `readiness()` doesn't even read `Task`/`TaskRun` directly, only a caller-constructed, always-complete checkpoint object, and its math is clamped so it can't produce `NaN` regardless of input. One real, non-blocking finding surfaced by the audit and worth keeping as a house rule going forward: unlike `fetchAudit()` (which deliberately switched to per-row `safeParse` after a past incident, per its own comment, where one bad row blanked the whole audit page), `Snapshot.parse()` is still a single strict throwing parse over the WHOLE snapshot — every field this epic added is additive (`.optional()`/`.nullable().default()`) so a merely-*missing* field can't trip it today, but a future *required*, non-defaulted field added to `Task`/`Rule`/`Transition`/`Proposal` without a migration would throw inside that one `.parse()` call and blank the entire UI for every project in the workspace, not just the new board. **Documented removal criteria** (this PR, not yet executed): once every active project has the new board enabled with zero P0 regressions for 14 days, remove the old six-state drag-and-drop board's entire code path from `apps/web/src/views/project.tsx` (the final `else` branch wrapping `BoardDnd.Provider`/`.kb-cols-6`, several hundred lines) and remove `Project.newBoardEnabled`/`queuedWipLimit` themselves — a real schema removal, not just a default flip, so it gets its own task when the window closes. **What actually shipped across this epic, as one coherent capability**: a rule engine (`apps/server/src/rules/engine.ts`) reacting to GitHub signals and task-state changes — move/label/Slack-nudge/create-proposal actions, an announce-before-acting undo window, an auto-pause circuit breaker, a pattern detector that turns repeated manual moves into proposed rules, and (TASK 13) a failed-action retry path — surfaced through **three view metaphors over the exact same Transition/Rule/Proposal data**, not three separate data models: Momentum (a column-based, "where in the pipeline" view), Gravity (a radial, readiness-score-driven view — the same tasks, positioned by how close to done/merge-ready they are, sharing every checkpoint/readiness calculation with Momentum's own In-Flight card), and Board Health (an aggregate, "is the automation trustworthy" dashboard — automation rate, cycle time, stall detection, rule undo-rate flagging) — plus an Activity Feed (a live, readable log of every machine action, with live countdown undo and now failure/retry) and an Automation Builder (a sentence-builder UI over the rule engine's own condition/action vocabulary, with a live backtest against real history before an operator commits). Every screen shares one design-token system (`--ak-*`, `styles.css`) and, as of TASK 13, one consistent focus-ring/hover/loading/responsive treatment.
- [x] **⭐ Browser tools for coding agents (MCP)** — every runner (except Hermes) can drive a real Chrome/Playwright browser within a coding task, opt-in per workspace, gated through the normal HITL tool-approval flow.
- [~] Remaining providers live behind `runner-sdk`: **Codex, Gemini, Cursor, Copilot, OpenCode, Kimi Code**
  all done; then breadth reactively from the candidate list in
  [docs/runner-catalog.md](docs/runner-catalog.md).
  *Landed: Codex, Gemini, Cursor, and Copilot are all real, wired-up `CliRunnerProvider`s
  (`orchestrator.ts`'s `getProvider` dynamic-imports each from `runner-sdk`), plus Hermes (not
  originally named in this bullet) — five non-Claude vendors live today, each with real CLI
  detection, argv/env wiring, and (per the CLI-usage-fidelity pass above) verified-current usage
  parsing for Codex/Gemini/Cursor. **OpenCode landed** (`packages/runner-sdk/src/opencode.ts`,
  `RUNNER=opencode`, npm `opencode-ai`) — drives `opencode run --format json`, a real NDJSON stream
  verified live against 1.18.18 (a plain reply, a bash call, and a file write, each captured and locked
  into `tests/cli-runner-vendor-usage.test.ts`); `usageFromJson` needed zero vendor-specific unwrapping
  since its per-step `input`/`output`/`cost` fields already match the scanner's aliases — opencode.ts
  accumulates them itself (OpenCode reports per-step deltas, not a running session total the way Codex
  does). No live HITL gate: `run`'s non-interactive mode auto-*rejects* any `ask`-configured permission
  instead of pausing for a decision (verified live — the rejection is stderr-only, never a stdout event),
  so `--auto` avoids that trap and Skynet's own post-run diff review gates the merge, same as Hermes. The
  model catalog uses OpenCode's own `provider/model` slugs (`anthropic/claude-opus-5` etc., defaulted to
  Anthropic per its docs) passed straight through, like Hermes' slugs. Landed alongside two real bugs this
  integration surfaced in the shared CLI base (`cli-runner.ts`), both verified live and fixed for every
  vendor, not just this one: (1) `opencode run` hung indefinitely producing zero output on Node `spawn()`'s
  default *open* stdin pipe, while completing instantly from an interactive shell or with stdin explicitly
  closed — fixed via a new opt-in `CliVendor.closeStdin` flag; (2) the OpenCode binary resolves its working
  directory from the inherited `PWD` env var rather than the OS cwd, so a stale `PWD` (spawn's `cwd` option
  changes the real working directory but never syncs `PWD` to match) silently pointed it at the Skynet
  server's own launch directory instead of the agent's worktree, writing real files there while `commitAll`
  correctly saw a clean, unrelated worktree and reported "no changes to integrate" — fixed by setting `PWD`
  to match `cwd` on every spawn.* **Kimi Code landed** (`packages/runner-sdk/src/kimi.ts`, `RUNNER=kimi`,
  native single-binary install — [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)) — drives
  `kimi -p <task> --output-format stream-json`, a real NDJSON stream verified live against kimi-code 0.38.0
  (installed via the official `install.sh`; a plain reply, a successful bash call, a *failing* bash call,
  and a file write, each captured and locked into `tests/cli-runner-vendor-usage.test.ts`). No usage/cost is
  ever reported by this mode (confirmed against the CLI's own docs and every live capture) — `onUsage`
  simply never fires for this vendor, an honest gap rather than a fabricated row. No live HITL gate: `-p`
  mode runs under a fixed `auto` permission policy by design and can't even be combined with `--yolo`/
  `--auto` (verified live — both hard-error before spawning), so like Hermes/OpenCode, Skynet's own
  post-run diff review gates the merge. Credential injection is unusual for this vendor: Kimi Code's docs
  are explicit that provider credentials are *never* read from ambient shell env vars, with exactly one
  documented exception — the ephemeral `KIMI_MODEL_*` family, which is the only channel available for
  per-workspace key injection without writing `config.toml`. The model string is a `"<type>/<id>"` prefix
  (`kimi`/`anthropic`/`openai`, defaulting to `kimi` — Moonshot's own models — with no prefix) that
  `kimi.ts` splits into `KIMI_MODEL_PROVIDER_TYPE`/`KIMI_MODEL_NAME`; the `anthropic` path was verified
  live end-to-end with a real `ANTHROPIC_API_KEY` (the `kimi` native path is mechanically identical but
  wasn't independently live-verified for lack of a Moonshot key in this environment). No `closeStdin` or
  `PWD` workaround needed here — both were verified live to behave correctly out of the box, unlike
  OpenCode. Reactive breadth from the candidate list is still open-ended.
- [x] **Agent labels / custom grouping** — Fleet already supported grouping agents by a labeled "Group" field and editing an agent's name via the Configure form.
- [~] **Mass inform** — select multiple agents (or a whole project) and attach a note that rides the
  *next* prompt each already receives — **no extra turn, ~free**. **Shipped:** a third interaction
  type (`inform`) alongside chat + resolve, never a HITL gate — `POST /api/runs/inform` (`{note,
  runIds?, projectId?}`, the two sets union) queues the note per matched live run and reports
  informed/skipped honestly (never fakes delivery). Delivery is provider-specific and optional on
  `RunnerHandle` (a provider that doesn't implement it is just skipped): **Claude** pushes onto the
  live SDK session with `shouldQuery:false` — appended to the transcript, merged into whichever real
  turn comes next, verified live (a note asking for a marker comment landed in the generated file with
  no extra turn logged). **CLI runners** (Codex/Gemini/Hermes, via the shared `cli-runner.ts` base, and
  Cursor) buffer the note and prepend it to the next real stdin write / spawned follow-up turn — proven
  against a real subprocess in tests; live-verified against `cursor-agent` too, which surfaced a real
  vendor quirk (its one-shot `-p` process doesn't appear to read injected stdin mid-turn, so the note
  only reliably rides a *fresh* follow-up turn, not a live one — `cursor.ts` now hooks both paths).
  Copilot doesn't implement `inform` yet (same bespoke-handle shape as Cursor; left for a follow-up).
  **Remaining:** the Fleet/Project UI ships (multi-select on Fleet, whole-project on the project page);
  optional "also remember" → area/workspace memory promotion is still v4, not started.
- [~] **🔗 Per-project live preview — "see what it builds", any software.** Today's W5 preview is
  per-agent-*branch* and effectively static/web. Generalize to a **stable per-project preview of the
  integration branch** that handles any software, not just SPAs. **Proposed approach:**
  - **A per-project preview descriptor** — `.skynet/preview.json` in the repo (auto-detected defaults
    from `package.json`/framework, operator-overridable in the project settings) declaring a `kind`
    plus `install`/`build`/`start`/`outputDir`/`port`/`healthPath`. Reuses the module-map pattern
    (repo-native config, per project).
  - **Three preview kinds, one seam:**
    · **static** (SPA/site) → build → serve `outputDir` (today's artifact mode, made per-project).
    · **service** (web app + server, API) → run `start` in the project's **sandboxed runner
    container** (v1) / opt-in OS sandbox (desktop), health-check the `port`, and expose it through a
    Skynet **reverse proxy** at a stable `preview.<project>.<host>` URL (desktop: a localhost port in
    an embedded webview). Streams build+runtime logs; auto-rebuilds on merge to the integration branch.
    The proxy rewrites the upstream `Host` to the loopback origin (`127.0.0.1:<port>`) — Vite 6+ dev
    servers reject a foreign `Host` with "Blocked request. This host is not allowed" (`server.allowedHosts`),
    so a public-origin proxy that forwards the real Host would break the preview; Host-rewrite fixes it
    for every framework without per-recipe flags. **Shipped:** a `/p/<token>/` reverse proxy fronts the
    loopback dev server on Skynet's learned public origin (Host-rewritten, HMR WebSocket bridged), Vite
    recipes get `--base=/p/<token>/`, and `PreviewState.url` becomes the proxied URL when hosted (loopback
    on desktop). *Bug fixed: base-injection matched the literal word "vite" against the OUTER command,
    but the common path resolves to `npm run dev` — the word never appears there, only inside the wrapped
    script — so injection silently never fired for the typical project and every preview fell into the
    regex-rewrite fallback (`preview-proxy.ts`'s `rewriteJsImports`), which can only re-prefix a path that
    appears as a quoted string literal — never a runtime-computed one (`import(variable)`, e.g.
    pdfjs-dist's fake-worker fallback), which is a structural blind spot no amount of regex tuning closes.
    `injectViteBase`/`npmRunScriptName` (`project-preview.ts`) now look through the `npm run` wrapper at
    the real script body, so base-mode — the actually-complete fix — applies to the common case too.*
    *Root-served (strip) mode made structurally correct — the pdf.worker reload-loop, ended: a
    `concurrently`-wrapped Vite (`"dev": "concurrently … \"npm:dev:client\""`, the Takeoff shape) puts the
    word "vite" two script-indirections deep, so base-injection can never fire and strip mode has to
    actually work. Three layers close it for good (all live-verified against a real
    Vite + pdfjs-dist + concurrently fixture through the real preview machinery): (1) `rewriteJsImports`
    also rewrites `export default "/…"` — the entire body Vite serves for a `?url` asset import, which is
    how a worker file's URL reaches app code as a runtime string (the exact pdfjs-dist leak the two
    earlier regex fixes missed); (2) SALVAGE — a token-less request in a dev-server-only namespace
    (`/@fs/…`, `/@vite/…`, `/@id/…`, `/node_modules/…`) that escaped the prefix is routed back to its
    preview (via the worktree path baked into `/@fs/` URLs → Referer → sole live preview) instead of
    falling through to the SPA fallback, catching the whole runtime-computed-URL class regex can never
    see; (3) the proxy now owns the server's `upgrade` event EXCLUSIVELY (delegating non-preview sockets
    to @fastify/websocket) and splices root-origin `vite-hmr`/`vite-ping` sockets through to the dev
    server — which both makes HMR genuinely work in strip mode and kills the once-per-second reload
    loop: @fastify/websocket completes a websocket handshake on any matched route before noticing there's
    no websocket handler, so Vite's "is the server back?" probe (success = the socket OPENS) always
    "succeeded" against the SPA fallback and the client reloaded forever; unroutable Vite sockets are now
    destroyed WITHOUT a handshake, so the probe fails honestly and the page just stays up.*
    Remaining Phase-2: the service-container runtime + auto-rebuild on merge.
    · **command** (CLI/lib/other) → run a command and surface **output/exit/artifacts** (no URL) —
    "preview" = run it and show the result. Covers "any software".
  - **Per project + per branch:** the project preview tracks the **integration branch** (what the fleet
    has merged); the existing per-run branch preview stays for reviewing a single agent's diff. One
    "Preview" affordance on the project view; the runtime kind decides URL vs. logs.
  - **Reuses** the existing preview builder, the **container/OS sandbox** (v0 #5 / v1), command-safety
    bounds, and the merge integration branch. Wrap, don't rebuild — Skynet orchestrates the build/run
    + proxy; it doesn't reimplement a PaaS.
  - **⭐ The overwatch loop + UX (the point of it):** the preview tracks the **integration branch** and
    **refreshes as the fleet merges** (dev-server HMR, or debounced rebuild + soft reload) so a human
    verifying agents watches the app change live. Opens **split-screen** beside the board or as a
    **pop-out modal**, with device-frame, a URL bar, freshness, logs, and manual restart/refresh. A
    per-run "Preview this change" button verifies a change *before* approving its merge.
    *(Shipped for web/sites: the split-screen dock ⇄ modal, refresh-on-merge, and the per-run
    "▶ Preview this change" button — the run's branch, pinned, pre-merge.)*
  - **Agent-assisted start:** the recipe resolves descriptor → heuristic → the **repo-aware assistant**
    (the same BYOK agent behind "Ask about this project" / Telegram) proposing + starting the preview.
  - Full design + phasing: **[docs/live-preview.md](docs/live-preview.md)**. **Phase-1 v0 (web/sites)
    shipped:** project + per-run preview managers (detached worktrees, opt-in sandbox, free-port +
    health-check), descriptor → heuristic → **agent-assisted** recipe resolution (proposal persisted to
    `.skynet/preview.json`), refresh-on-merge, node_modules provisioning (symlink the checkout's
    deps, else install) so a dev script's local bin resolves in the fresh worktree, and the
    **resizable** split-screen dock ⇄ modal (scrollable/resizable logs) with a "▶ Preview app"
    (project) and "▶ Preview this change" (run) affordance, **plus the `/p/<token>/` reverse proxy so a
    live preview is reachable from a phone** (Host-rewrite → Vite allowedHosts, HMR WS bridged, Vite
    `--base` injected). **Still to do:** Phase 2 remainder (service-container runtime + auto-rebuild on
    merge) & Phase 3 (command/artifacts, "any software").
  - [x] **Perf — warm-worktree dep caching, nested sub-packages.** A nested monorepo's own embedded install step now skips re-running when its sub-package's lockfile is unchanged from the last successful install in that worktree.
- [x] **Deploy to Fly.io — a real, persistent deployment alongside the ephemeral local preview.** A human-triggered, explicit-operator-action deploy of a project's integration branch (or a single run's branch) to a real `https://<app>.fly.dev` app that survives independent of the local Skynet process.
- [~] **🔁 Task ↔ source-of-truth sync.** Tasks imported from an external source (GitHub issues, repo
  files, a tracker) should update the source when their Skynet status changes. **Approach:** a
  `Task.source` provenance link (set at import) + a `SyncSink` adapter seam (one per source kind),
  triggered from the `task.upserted` bus event (single choke point). Opt-in per project
  (`syncSourceStatus`) since writing back is outward-facing. **Phase 1 (done):** GitHub issues —
  import open issues → tasks (deduped, `source` set), and on transition comment / close / reopen the
  issue. **Phase 2 (done):** repo files — a file's `- [ ]` checklist items import as tasks; completing
  one checks its box (`- [x]`) / reopening unchecks it, committed via the GitHub Contents API.
  **Phase 3:** external/webhook (Linear/Jira) + optional two-way. Full design: **[docs/task-source-sync.md](docs/task-source-sync.md)**.
- [ ] **Desktop code-signing & notarization** *(split out of v0 #9, which ships beta unsigned)* — sign
  the macOS build (Apple Developer ID + hardened runtime + entitlements + notarization) so Gatekeeper
  opens it cleanly and **mac auto-update works** (it silently no-ops on an unsigned build today); sign
  the Windows build (code-signing cert) to clear SmartScreen. The electron-builder config + CI
  secret-passthrough are straightforward to wire; the gating input is the **certs** — an Apple
  Developer ID cert + a Windows code-signing cert added as repo secrets. Verifiable only on a real
  signed tag build (electron-builder skips signing when secrets are absent).
- [ ] 🏢 **Scale + containerized runner:** Redis multi-replica fan-out; **GKE Jobs for
  runners** — one container per agent, completing the v0 sandbox item's deferred
  half: memory/CPU caps (cgroups) and network egress allowlist (proxy). The
  command-deny, worktree write-confinement, and runtime cap already ship locally.
- [x] **Guided provider connect** — one-click "Connect Claude / Codex / …": in-app key entry + a live verify,
  so onboarding never requires hand-authing each vendor CLI (the #1 friction rivals impose). Key entry
  already worked (`createCredential`/`setSecret`); landed the missing live-verify half — a cheap,
  read-only, per-vendor call (`secrets/verify.ts`: Anthropic/OpenAI/Google `models` list, OpenRouter
  auth-key check, Cursor `/v0/me`, GitHub `/user` for both `copilot` and a pinned GitHub PAT) confirms a
  saved key actually authenticates rather than just being present. Never blocks the save itself (a key
  can be valid but momentarily rate-limited); Settings shows a spinner → pass/fail badge with the
  vendor's own error text, on both the main provider row and the "+ Add another key" form. Verified live
  against real keys (good and deliberately-wrong) through the actual Settings UI.
- [x] **Run escalation / hand-off — a stuck run halts for a human.** A run enters a first-class
  `escalation` HITL ("NEEDS HELP") three ways: the **agent hands off** itself when genuinely blocked
  (AskUserQuestion with header "ESCALATE" → detected by the runner), **too many failures**
  (`SKYNET_RUN_MAX_FAILURES`, default 3), or **too long** (`SKYNET_RUN_STUCK_MS`, opt-in — below the
  runner's hard cap). The operator resolves it from the Inbox: **help & resume** (guidance → the agent
  continues, or a fresh session relaunches in the worktree), **reassign** to a different runner, or
  **stop**. The halted run frees its runner but keeps its worktree so a resume/reassign can continue the
  work. *(Verified live: a real agent correctly escalated rather than fabricate a secret; help & resume
  round-tripped. Foundation for the "escalation SLAs / delegated approval" governance items below.)*
  *Bug fixed: a "Runner went silent" escalation (raised by `reapStaleAgents` after a server restart
  orphans a run's heartbeat) could NOT actually be resumed. `resolveHitl` marks the HITL resolved
  before `relaunchEscalated` attempts the relaunch, so if `provider.start()` then threw for any reason
  (a transient provider outage, say), the old catch path called `failStartup()` — which retires the
  run's worktree and drops it into a dead `"review"` state with no HITL left to act on. Every button
  the operator could still see just re-triggered the same failure into the same dead end — exactly
  "I tried all buttons." Fixed by re-raising a fresh, actionable escalation on relaunch failure instead
  (worktree untouched, Resume/Reassign/Stop back on the table) — see `raiseEscalationCard()` in
  `orchestrator.ts`, factored out of `escalate()` so both the original raise and the retry path share
  it. Regression-proofed with a real-git test using a provider whose `start()` fails once on demand.*
  *Follow-up fix: the same dead end also hit ONE step earlier — `acquireOrProvisionRunner` itself
  throwing (no idle runner within the fleet cap, or the assigned runner removed — "reassign when the
  runner left") only logged and set the run back to `"waiting"`, with no HITL left to click since the
  original one was already resolved. Now re-raises a fresh escalation the same way, so Resume/Reassign
  keep working even when there's genuinely no runner to hand the run to right now.*
  *Root-cause fix: both bugs above were symptoms of a wider pattern — several code paths dumped a run
  into `"review"` with NO HITL raised at all (not even one to fail resuming). `fail()`'s generic-failure
  branch escalated only past `SKYNET_RUN_MAX_FAILURES` (default 3), silently parking every failure below
  that with no retry loop ever consuming the count — so those "early" failures were exactly as terminal
  as the 3rd, just invisible. `failStartup()` (no credential, worktree provisioning failed) never
  escalated either. The result, reported directly: "a lot of tasks being stuck in REVIEW." Fixed two
  ways — (1) `fail()` now escalates on every failure while the guard is enabled (the count still shapes
  the reason text an operator sees; `SKYNET_RUN_MAX_FAILURES=0` still opts back into the old silent
  parking, for operators who deliberately want it); (2) `gcWorktrees`'s existing "limbo" sweep (previously
  a once-after-`worktreeTtlDays` LOG LINE nobody read) now immediately escalates any `review` run with no
  open gate, on the very first sweep — a real backstop that also recovers already-stuck runs from before
  this fix, and any future gap in the same spirit (e.g. `failStartup()`, left otherwise unchanged since
  its worktree is genuinely empty). `escalate()` also gained a task-lookup fallback for when there's no
  live handle to read `taskId` off (needed for the sweep to move the task back to `ongoing` on a
  successful resume). Regression-proofed by stashing the fix and re-running the new tests against old
  code — all 3 fail exactly as reported.*
  *UI follow-up: the global Runs dashboard had its OWN version of this bug, reported live — a run
  reading "starting…" with a growing elapsed clock 20+ hours in. Its per-row classifier only had 3
  explicit buckets (done / has-an-open-HITL / paused) and dumped everything else — including a `review`
  run with a frozen heartbeat and no HITL, exactly the dead end above — into the generic "running" bucket,
  which just shows elapsed-since-start with no regard for whether anything is actually happening. Extracted
  the classifier into a pure, unit-tested `classifyRun()` (`derive.ts`) and added a branch: a non-`running`
  status with a stale heartbeat (the dashboard's existing 60s early-warning line) and no open HITL now
  sorts and labels the same as an open HITL ("stuck in review — no pending decision"), instead of hiding
  among genuinely active runs.*
  *Feature added: "Send to Todo" and escalation "Reassign" each used to have exactly ONE hardcoded
  behavior — the former always discarded the run's in-progress work, the latter always continued in the
  same worktree — with no way to ask for the other, reported live as a real gap ("work shouldn't be lost
  when returning to todo due to task is stall or hung — a confirm modal where the user can decide to
  reset or continue"). Both now offer a real choice via a new `useChoice()` dialog (`confirm.tsx`, a
  multi-option sibling to the existing yes/no `useConfirm()`): **keep the work, pause it** (the run halts
  with its worktree + committed work intact, exactly like an escalation — a later "Start →" on the same
  task, or `assignTask`'s new resume-a-paused-run branch, relaunches it in place) or **start clean**
  (discards the worktree, same as Stop; Reassign's reset variant then immediately re-assigns a genuinely
  fresh run for the same task). New `Orchestrator.pauseRun()` mirrors `escalate()` (worktree preserved,
  no HITL raised — nothing needs the operator's attention, they just chose to come back later) and
  `Resolution.resetWork` (only meaningful alongside `reassign`) drives the reset path in
  `deliverEscalation`. Regression-proofed with 4 new real-git tests (`escalation.test.ts`) covering both
  choices on both flows, and verified live end-to-end (pause → Start → resumes the SAME run id; reset →
  a brand-new run with its own fresh worktree).*
- [x] **Fix: Stop on an escalation card orphaned its task in "ongoing" forever.** Found live on a real
  deployment — 11 of 11 tasks stuck in "ongoing" turned out to have runs that had already reached a
  terminal state (`done`, mostly via a stall reap or the operator resolving the escalation with Stop), yet
  the task itself never moved. Root cause: `haltAgent` (the plain "Stop run" button on a live, non-escalated
  run) correctly upholds the invariant "an ongoing task always has a live run" — it returns the task to
  `todo` when the run stops. `deliverEscalation`'s `reject` branch (Stop **on an escalation card**
  specifically) was a separate, parallel implementation of "stop this run" that did the same runner/worktree
  cleanup but never synced the task, silently violating that invariant every time. Since `ongoing`'s only
  legal human kanban move is → `todo`, and nothing was ever making that move automatically, the task just
  sat there — unreachable by drag (nothing to drop it onto) and invisible as "broken" (no error, no card, no
  escalation left open). Fixed by adding the same sync `haltAgent` does. Regression-proofed: stashed the fix,
  confirmed `escalation.test.ts`'s reject case now asserts `state → "todo"`/`runId → null`/
  `reviewVerdict → null` and genuinely fails without it, popped it back.
- [x] **Manual "Switch agent" on a live ongoing task.** Requested live alongside the Force Done loading-state
  fix: "it should be possible to manually switch agent on a task." Before this, once a run started the
  `AgentEligibility` picker went permanently read-only — the only ways to change WHO was working a task were
  "Send to To-do" (abandon and restart from scratch) or escalation's "Reassign" (grabs any eligible idle
  runner, never the operator's own pick). Neither let an operator just say "move this to THAT agent" while
  the work was healthy and still in progress.
  New `🔀 Switch agent…` dropdown on any `ongoing` card, populated from the live fleet's idle agents (same
  `fleet` prop `AgentEligibility` already renders from — no new fetch). Picking one stops the current
  session and resumes the SAME run — same worktree, same branch, same committed AND uncommitted work — on
  the chosen agent. Built almost entirely on EXISTING machinery rather than a parallel implementation:
  `relaunchEscalated` (escalation's own "stop old, acquire new, resume in the same worktree" engine) gained
  an optional `targetAgentId` — when set, it claims that EXACT agent (`acquireSpecificAgent`, a new
  id-keyed sibling of `acquireOrProvisionRunner`'s "any matching idle runner" search, same
  `acquireExclusive` claim discipline, never auto-provisions) instead of picking any match, and frames the
  handoff prompt as a deliberate operator choice ("wasn't stuck, they just chose to switch") rather than
  escalation language. The one real wrinkle: `relaunchEscalated` was written for runs already parked in
  `this.escalations` (`ctx`), and a manual switch targets a run that's STILL LIVE and was never escalated —
  `ctx` is absent, so `task`/`baseRef` now fall back to the live session's own recollection of them
  (`live?.taskId` / `live?.baseRef`) instead of silently losing task/feature/brief grounding on resume (also
  fixes a latent gap in the escalation-failure fallback path, which used to drop `taskId` entirely for a
  never-escalated run). And since a manual switch can fail (target went busy/removed) while the ORIGINAL
  session is still perfectly healthy, that one failure path was changed to propagate the error straight to
  the caller instead of raising an escalation card on a task that isn't actually stuck — new
  `Orchestrator.reassignRunToAgent` / `Operations.reassignTaskAgent`, `POST /api/projects/:id/tasks/:tid/
  reassign-agent`, and an MCP `reassign_task_agent` tool.
  `tests/reassign-task-agent.test.ts` (4 new tests, real throwaway git repo, same harness as
  `escalation-reassign-interrupted-git.test.ts`): the happy path proves the SAME worktree/uncommitted file
  survives the switch and the new agent's own prompt carries the manual-reassign framing; target-busy and
  target-missing both leave the original run completely untouched (old handle never stopped, no second
  `start()` call); a non-`ongoing` task is refused before the orchestrator is ever touched. All 27
  pre-existing escalation/reassign tests still pass unchanged — the new `targetAgentId` branch is fully
  additive to `relaunchEscalated`.
- [x] **Organize board also unsticks unassigned backlog tasks it's confident about.** Requested live: "when
  Steward organize the tasks it should also set the ones that make sense to any agent in backlog so they can
  be picked up for work." An `unassigned` backlog task never leaves backlog on its own — the eligibility
  choice is deliberately the operator's (`AssignmentRequiredError`), and the autonomy triage sweep skips it
  too — so a task created without an explicit "who can work this" choice just sat there until a human
  noticed and set it. "Organize board" already visits every task's title + description for priority-sorting,
  so it's a natural second moment to also clear that ONE blocker for the tasks that don't actually need a
  routing judgment call. A new, independent consult (`suggestAnyAgentEligible`, `steward/organize.ts`) asks
  which currently-unassigned backlog tasks are self-contained/well-scoped enough that WHICH agent picks them
  up wouldn't matter — explicitly told to default to leaving a task off the list (for a human to route by
  hand) whenever unsure, since wrongly declaring a task fine for anyone is the costlier mistake. Same
  discipline as the existing prioritize consult: one retry on an unreadable reply, degrades to "suggest
  nothing" (never guesses, never throws) on a persistently bad reply or an ask failure; a reply that parses
  as valid JSON but simply has no `anyAgent` field reads as "nothing suggested" rather than a parse error, so
  a differently-shaped-but-valid reply never burns a wasted retry. `organizeBoard`'s result gained an
  `assigned` count alongside `reordered`/`archived`, surfaced in the button's toast and title.
  `tests/organize-board.test.ts` (4 new tests): the consult's named ids get `{mode:"any"}` and nothing else
  is touched; a task that already has an assignment is never even asked about (0 consult calls); an
  unreadable reply assigns nothing; a made-up id in the reply is discarded. Also updated the one existing
  retry-count test — the SAME shared mock now also answers the new eligibility consult, so the total call
  count went from 2 to 3 (the eligibility call's valid-but-field-less reply doesn't itself trigger a retry).
  Verified live end-to-end: the button's title and the empty-state toast both render the updated copy; the
  full request/response roundtrip (including the new `assigned` field) works correctly.
- [x] **Manual "Force to review" on an ongoing card.** Requested live, right after Force Done's own real
  commit/push/merge fix: `ongoing → review/done` was purely agent-driven — the only human control on an
  ongoing card was "Send to To-do" (abandon it). No escape hatch existed for the far more common ask: a run
  that's stuck, slow, or has done enough for a human to want to look now, without abandoning its in-progress
  work. New `⚡ Force to review` button, next to the existing `⚡ Force done`, runs the EXACT same
  commit → diff → raise-review path `complete()` already runs on the runner's own natural finish — just
  triggered by the operator instead of the `onCompleted` event. Deliberately commit-before-stop: the
  worktree is committed FIRST, and the live session is only stopped once a real commit lands — so clicking
  this on a run that hasn't produced anything yet can never kill real in-progress work for nothing; it fails
  honestly with `NothingToReviewError` instead ("nothing has changed yet") and leaves the session running
  untouched. Also throws honestly (not a silent no-op) when the run isn't live right now — an `ongoing` task
  is supposed to always have a live run behind it, so this only fires for a genuinely dead/already-reaped
  edge case. `tests/force-review.test.ts` (3 tests) drives
  the real Orchestrator against a real throwaway git repo: a live run with real uncommitted work is
  committed + stopped + raises a genuine diff review (task flips to `review`, the commit is verifiably on
  the branch); a live run with a CLEAN worktree throws and leaves the session running (nothing torn down);
  a non-`ongoing` task 404s before ever touching the orchestrator. New `Orchestrator.forceReviewRun` /
  `Operations.forceReview`, `POST /api/projects/:id/tasks/:tid/force-review`, and an MCP `force_review` tool.
  Live interactive verification of the success path needs a real provider credential this sandbox doesn't
  have (an `ongoing` task can only be reached through a genuinely live run — no mock runner exists in the
  real server binary, only in test harnesses); confirmed instead that the new button renders cleanly with
  no console errors and the app typechecks end to end, backed by the real-git integration tests above for
  the correctness-critical path.
- [x] **Force Done gets a completeness check before it pushes.** Requested live as a direct follow-up to
  Force Done committing + pushing/opening a PR (the entry three below): skipping the normal review gate
  shouldn't ALSO skip judgment on whether the work is actually done — an operator hitting Force Done on a
  run that stalled halfway through would previously get the same unconditional push as one that genuinely
  finished. Now, whenever `forceIntegrateRun` is about to push/merge with no open HITL to approve (the only
  branch that never went through a human-endorsed diff review), it first runs the SAME "does this run
  satisfy the task" consult `autoReview`'s plain-consult path already uses — same prompt
  (`REVIEW_OUTPUT_INSTRUCTION`), same field-based `parseReviewVerdict` (never classifying the model's
  prose) — on the run's OWN provider, so it still works on a single-agent fleet (unlike `requestReview`,
  which needs a second, non-doer agent). An "approve" (or no signal at all — no linked task, no `consult`
  support, nothing to diff, a failed consult) pushes exactly as before. A "flag" holds the push back
  entirely and raises a REAL diff review instead — deliberately bypassing `raiseDiffReview`'s own
  `full`-autonomy fast path (a new `skipFullAutonomy` option), since a `full`-approval-level project
  auto-merging straight past this finding would silently undo the whole point of checking. The task lands
  in `review` (not `done`) with `reviewVerdict: {decision:"flag", reason, by:"force-done-check"}` stamped
  immediately, so the "⚠ flagged for you" banner shows without waiting for a later autonomy tick. Raising
  the gate IS the notification: Telegram/push already fires the moment any HITL is raised, so the operator
  hears about it the instant it happens — no new notification plumbing needed. `tests/force-done-
  integration.test.ts` (2 new tests, against a real throwaway git repo) pin both outcomes: a flag verdict
  holds back the push (the file never lands on the integration branch) and raises an actionable diff gate
  carrying the real changed files; an approve verdict still pushes through exactly as before.
- [x] **Manual "Request re-triage" on a card parked in triage.** Requested live: the only way back into
  triage's assessment was to wait for the task to cycle through `backlog` on the periodic sweep — no way to
  ask for a fresh read on demand once project context changed (goal, instructions, a newly added feature)
  or the description was edited after the original "unclear" verdict. Mirrors the existing "Request review"
  button exactly: a new `Re-triage` action on any card sitting in the Triage column, alongside a "Parked in
  triage" label (same `kb-unreviewed`/`kb-unreviewed-btn` styling `requestReview` already uses — no new
  CSS). Server-side, `Orchestrator.tickAutonomy`'s own triage-write logic (assessment + duration + clarity +
  grouping + the clarification loop breaker) was extracted into a shared `triageOne(ws, agent, task)` so the
  periodic sweep and the new eager `requestRetriage(ws, taskId)` entry point run the IDENTICAL write path
  rather than two copies that could drift — the loop-breaker fix directly above this one automatically
  covers the manual path too. Throws honest, specific errors instead of a silent no-op: `NoTriageTargetError`
  when the task isn't in `triage` right now, `NoCapacityError` (reused — the same error every other manual
  on-demand action already throws) when no agent is idle. `tests/request-retriage.test.ts` (5 tests) covers
  both outcomes (clear → promotes to `todo`, unclear → fresh clarification) plus both failure modes and the
  404 case; the write-logic itself (including the loop breaker) stays covered by `autonomy.test.ts` since
  `triageOne` is now the one implementation both paths share. Verified live: seeded a task into Triage with
  no idle agent — clicking Re-triage surfaced "No idle runner available" as a toast (not a silent no-op);
  adding an idle runner and clicking again returned 204 and the card's assessment updated in place.
- [x] **Fix: a third termination path could strand a task "ongoing"/"review" while its run showed "done".**
  Reported live: "Task status should of course match the column in kanban it is in" — a card sitting in a
  mid-pipeline column (Ongoing/Review) whose own status chip (driven by the linked run's `status`, a
  SEPARATE state machine from the task's kanban `state` — see `apps/web/src/views/project.tsx`'s per-card
  chip) read "done". The invariant "an ongoing/review task always has a live run behind it" already has two
  enforcers — `haltAgent` (the plain Stop button, and the fix directly above this one for its escalation-card
  twin) and `settleArchivedRun` — both of which return the task to `todo` + detach it when their run goes
  terminal. `reapStaleAgents`'s OWN third termination path — the sweep that frees a runner whose session died
  silently while its run sat `waiting` on an open gate (not yet an escalation) — never got this fix: it
  called `stopAgent` + `runStatus(..., "done")` + `runCompleted(...)` but never touched the owning task, so a
  run reaped this way left its task permanently stranded in whatever column it was in, now showing a "done"
  run underneath it. Added the identical task-reset (`state → "todo"`, `runId → null`, `reviewVerdict →
  null`) this sweep was missing, matching `haltAgent`/`settleArchivedRun` byte-for-byte. New test in
  `escalation.test.ts`: a run parked on a plain (non-escalation) gate whose heartbeat goes stale is reaped,
  and the task is un-stranded to `todo` — the exact scenario that used to leave a done-looking run under a
  mid-pipeline card.
- [x] **Fix: a fourth stranding path — abandoning a run via a kanban move left its Inbox card dangling.**
  Reported live: "inbox messages must update if tasks move in kanban." Same invariant family as the fix
  directly above (an ongoing/review task always has a LIVE run behind it), but the Inbox side of it:
  `Operations.transitionTask`'s `abandonsRun` branch (ongoing/review → todo, or demoting done →
  triage/backlog) already stopped the run and marked it archived — but never touched any HITL gate still
  open for it. Drag a card with an open diff/verifier/approval gate back out of Review, and the Inbox kept
  showing that gate forever: a pending decision pointing at a run whose worktree was already retired and
  runner already freed, answerable by nothing. Confirmed this is genuinely the OTHER abandon direction —
  `transitionTask`'s review→done path (bypassing the diff gate by dragging straight to Done) was already
  correct, resolving the gate via `approve` before this fix; only the "abandon and start over" direction had
  the gap. Fix: dismiss every open HITL for the run (`hub.resolveHitl(..., {action:"dismiss"})`, `by:
  operatorId`) in the same `abandonsRun` branch, right after the existing stop+archive — called directly on
  the Hub, not via `Operations.resolveHitl` (which calls `orchestrator.deliver`, meaningless for a handle
  `stopAgent` just tore down), the same lower-level pattern `Orchestrator.settleArchivedRun` already uses for
  the direct-archive-a-run path. Deliberately does NOT reuse `settleArchivedRun` wholesale here: it keeps the
  worktree (a reversible soft-hide), while an abandoned kanban move is a genuine "start fresh," correctly
  retired via the existing `stopAgent` call — reusing it would have quietly stopped retiring worktrees on
  this path. Also deliberately does NOT force the run's `status` to `"done"` here — an existing test
  (`task-transitions.test.ts`) already pins that the abandon path leaves the run's OWN status untouched (it's
  the task's kanban `state` that changes), and the periodic `settleArchivedRuns` self-heal sweep still
  reconciles that within ~60s regardless; this fix is scoped to exactly the reported symptom (the Inbox),
  not a re-litigation of that separate, already-decided invariant. The web client needed NO changes — its
  `queue`/`task` store slices already update reactively off `hitl.resolved`/`task.upserted`; it was
  faithfully showing what the server told it, which was simply never told the gate got resolved. New tests
  in `task-transitions.test.ts` (5 cases): ongoing→todo and done→backlog both dismiss the gate; every open
  gate for the run is dismissed, not just one; a `preserve`-flagged move (pause, not abandon) leaves the gate
  untouched (still meaningfully answerable once resumed); and the pre-existing review→done "approve" path is
  confirmed unaffected by the new logic.
- [x] **Fix: a Telegram merge-conflict card was an unexplained raw diff dump — impossible to act on.**
  Reported live with a screenshot: "A merge needs a look" arrived on the phone as a tail-truncated `diff
  --cc` combined-diff snippet cut off mid-sentence, no title, no explanation, nothing saying which files
  conflicted or what Approve/Reject/Modify would actually do. Root cause: `decisionCardHtml`/`gateNotice`
  (`telegram/notices.ts`) picked exactly ONE content block per gate via an if/else-if chain — for a `diff`
  gate that's the stats+file list, but a `merge` gate isn't a `diff` gate, so it fell through to the
  captured-output branch and rendered the raw `<<<<<<<`/`=======`/`>>>>>>>` conflict text (or a
  `diff --cc` combined diff for the feature-branch-batch case) as the ENTIRE card. Worse: `HitlItem.why` —
  the system-authored explanation of what happened and what the buttons do, which the web queue card
  (`queue.tsx`) has always shown unconditionally — was never read by either Telegram function at all, and
  the conflicting files already carried on `flags` (rendered as chips on web) were never shown either.
  Rewrote both to match the web card's own ordering (title → rationale → why → kind-specific content →
  captured output → conflicting files): the raw conflict text now rides at the BOTTOM as clearly-labeled
  supplementary detail ("Conflict (captured before the merge was aborted) — Modify sends this to the agent
  as-is"), preceded by the actual explanation and a `Conflicts in: <files>` line — so the operator can
  decide from the card alone, with the raw diff only as backup context (or the existing "View diff" /
  "Open in the app" for full detail). Added to `tests/telegram-notices.test.ts` (2 new tests) covering a
  realistic merge-conflict item: title, why, and conflicting files all present and ordered BEFORE the raw
  (HTML-escaped) conflict text, not instead of it. All prior diff/command/question card tests unaffected —
  `title`/`why` are additive lines, never replacing the existing kind-specific content.
- [x] **Fix: answering a triage clarifying question could loop forever — same question, every time.**
  Reported live right after clarifying questions shipped: answer the question → task returns to `backlog`
  for re-triage (by design, since the answer can change the effort/risk/grouping read) → triage runs again
  → the model comes back "unclear" with the SAME question → asked again → answer again → ... The re-triage
  prompt had zero awareness that this was a SECOND pass: it re-read the (now-answered) task from scratch
  with no signal that an answer already sat right there in the description, so a model that stayed
  unconvinced by its own earlier ambiguity — or simply wasn't confident — had nothing steering it toward
  "clear" the second time, and nothing stopped a third, fourth, or hundredth lap either. Each lap silently
  burned a triage consult AND a Steward clarification-draft consult, for a question the operator had already
  answered.
  Two layers, since a prompt instruction alone is advisory, not a guarantee: (1) the triage prompt now
  explicitly says so when `task.description` carries `CLARIFICATION_ANSWERED_MARKER` — the exact heading
  `Operations.answerClarification` stamps above the operator's answer — telling the model to treat that
  answer as authoritative and never re-ask the same or a rephrased version of it, reporting "clear" unless
  the answer reveals a genuinely NEW gap. (2) A code-level breaker backs that up regardless of whether the
  model complies: `tickAutonomy`'s triage step checks for that same marker (grepping for OUR OWN literal
  string, never classifying the model's free text — same discipline as every other triage signal) and, if
  the model still says "unclear" on a task that's already been through one answered round, FORCES a promote
  to `todo` instead of opening a second `clarification` — the model's continued doubt gets folded into
  `assessmentRisks` as a flagged risk instead of another question. Guarantees the loop terminates after
  exactly one ask-and-answer round no matter what the model does on the second pass.
  New test in `tests/autonomy.test.ts` drives a provider that always replies "unclear" against a task
  already carrying an answered clarification and asserts the forced promote + risk note; the existing
  first-time-unclear case (no marker yet) is unchanged — it still parks in `triage` with a fresh ask.
- [x] **Fix: Force Done didn't force anything DONE — it forced the card to say so.** The escape hatch's own
  doc comment said it out loud: *"Never merges the branch — this is a 'call it done' operator override, not
  a work-completion signal."* That's exactly the trap — an operator reaching for Force Done (a wedged HITL,
  a stuck merge queue, a run that finished but never advanced the card) got a green "Done" label over an
  agent's real work that was still sitting uncommitted or unmerged in its worktree, one `retire()` away from
  being silently lost the next time that worktree got reclaimed. "Done" has to mean the work actually landed.
  Now Force Done routes through the SAME integration pipeline a normal Approve click uses, not a label flip:
  an open diff/merge/verifier gate gets approved for real (`resolveHitl` → `deliver`, unchanged); with no
  gate open, the new `Orchestrator.forceIntegrateRun` commits whatever's uncommitted in the run's worktree —
  live or not — via `WorktreeProvisioner.commitAll` (idempotent, a no-op on an already-clean tree), cleanly
  detaches a still-live run first (stop the handle, free the runner — the same sequence
  `restoreCheckpoint`'s live-detach already used, just with a commit added before it), then hands the branch
  to a new shared `Orchestrator.integrateRun` — `deliver()`'s old inline approve-branch logic, extracted
  byte-for-byte so both callers get the identical feature-branch-batch / GitHub-PR / local-merge-queue
  routing rather than a second, drifting copy of it. Only falls back to the old cosmetic-only flip when
  there's genuinely nothing to integrate (no run, or no git backend at all) — everything else waits for the
  real result: a GitHub push marks the task done synchronously as part of that same call; a local merge
  enqueue marks it done asynchronously once the merge actually lands, or raises a real conflict gate instead
  of lying about "done", exactly like any other approve. So the endpoint can now legitimately return a task
  still sitting in `review` — that's honest in-flight state, not a regression.
  `tests/force-done-integration.test.ts` (new, 2 tests) runs this against a REAL throwaway git repo (same
  harness as `guided-merge-orchestrator.test.ts`, not a mocked backend): a still-live run with uncommitted
  work gets its file committed, its runner freed, and the branch landed on the project's integration branch
  before the task flips done; a run with an open diff gate gets that gate genuinely approved (not bypassed)
  and lands the same way. `tests/task-transitions.test.ts`'s existing 3 cases (no git backend configured)
  now pin that the `!git` guard falls all the way through to the unchanged cosmetic tail.
- [x] **Triage asks — clarifying questions with a Steward-drafted answer.** Triage could already decide a
  task was `unclear`, but had nowhere to say WHAT was unclear and no way to get it resolved: the task parked
  in `triage` indefinitely with nobody told what was missing. The expensive consequence showed up live —
  agents later picked those tasks up, burned their whole turn budget rediscovering the same ambiguity, and
  escalated verbatim with *"no acceptance criteria to aim at"* / *"the project has no goal set"*. Asking
  costs one cheap consult; discovering it at agent prices costs orders of magnitude more.
  Now: when triage reports `clarity: "unclear"` it must also name 1-3 SHORT, SPECIFIC, ANSWERABLE things it
  needs (the prompt rejects a generic "please clarify" — a vague question wastes the exchange), parsed with
  the same defensive per-field discipline as every other triage signal (`splitEstMinutesTag`: missing stays
  missing, a malformed `questions` never drops the other fields, capped 5 × 200 chars). Steward then drafts
  a PROPOSED answer grounded in the project's goal/instructions + the task — cheap and tool-less, and
  degrading to `null` (ask without a draft) rather than failing the tick when no credential resolves.
  Surfaced on the task card itself, not the Inbox: the question is about THIS task and the context needed to
  answer it is already right there. The operator sends the draft, edits it, or writes their own —
  `Operations.answerClarification` APPENDS their words verbatim (never model-rewritten, never replacing the
  original brief) along with the questions they answer, clears the clarification, and returns the task to
  `backlog` for a genuine RE-triage rather than promoting straight to `todo`, since the answer may change
  the effort/risk/grouping read too. The draft is never applied on its own: a model guessing at operator
  intent is precisely what produced the ambiguity being asked about.
  `tests/triage-clarification.test.ts` (11 tests) covers the tag parsing (incl. caps, malformed values, and
  missing-vs-empty) and the full Operations path (append-not-replace, no-prior-description, re-triage state,
  refusal when nothing is open, 404, and the published delta). Verified live end-to-end in the browser: a
  seeded unclear task rendered its questions + draft, and sending an edited answer appended it to the brief
  and moved the task back to backlog.
- [x] **Spend efficiency on Home — how much of what the fleet costs actually ships.** Reconciling a month of
  real provider spend surfaced the number that mattered most and appeared NOWHERE in the UI: only ~19% of it
  reached a merge; the rest went to runs that stalled, were stopped, or finished without landing. A ratio
  that decides whether the fleet is worth its bill shouldn't need an ad-hoc query over the store to see.
  `spendEfficiency()` / `spendOutcomeOf()` (`apps/web/src/lib/derive.ts`) are a PURE derivation over runs
  already in the snapshot — no new endpoint, no new storage: a merge (`mergedAt`) is the only evidence of
  delivery; `running`/`waiting`/`review` AND not archived is in-flight (a reaped run keeps a live-looking
  status while being archived, so checking status alone would hide real waste as "still working");
  everything else was paid for and didn't land. Rendered on Home as a proportional bar + per-outcome
  run/dollar breakdown. Deliberately honest about its own limits: a run the provider never priced
  contributes $0, so `pricedShare` is tracked and, below 99%, the card says outright that the totals are a
  floor rather than rendering a confidently wrong number. `tests/spend-efficiency.test.ts` (11 tests) covers
  the outcome rules (including archived-vs-status and merged-stays-delivered), unpriced-run accounting, and
  the empty / all-unpriced no-NaN edges. Verified live against a seeded store mirroring the real
  deployment's shape — rendered "19% of $141.67 delivered" against its actual 18.8%.
- [x] **Fix: Skynet's cost meter under-reported real spend by ~3x, and side-calls silently ran Opus.**
  Reported live as "we burnt through $100 in 8h" — Skynet's own numbers said its busiest day EVER was $25
  and that whole month was $119, so the first (wrong) conclusion drawn from them was "it isn't us."
  Reconciling against the provider console proved the meter itself was the problem: console said
  **515.2M input / 3.45M output** for August, Skynet had recorded **189.1M / 1.22M** — **63% of all token
  spend was invisible**. Three independent causes, all fixed here:
  *(1) The runner read the WRONG field, and dropped every prior query segment.* Two compounding errors, both
  settled against the SDK's own field docs rather than guessed at. First, it read `result.usage`, documented
  as **"MAIN AGENT LOOP ONLY — excludes Task subagent, sidechain, and auxiliary model calls"** — and Skynet's
  agents spawn subagents routinely (an Explore/research subagent is a normal move), so all of that work was
  billed and none of it recorded. `modelUsage` — "the correct field for token/cost accounting", covering
  "main loop, Task subagents, sidechains, and internal calls such as compaction" — is now the source, summed
  across its per-model entries. Second, a run spans SEVERAL `query()` calls (turn-budget continues up to
  `MAX_TURN_CONTINUES` = 3, plus transient relaunches) and only the current one was ever reported. The
  subtlety that makes this easy to "fix" into a much worse bug: these readings are **cumulative within a
  query** ("each result carries the running total so far, so read the latest result rather than summing
  across results") but **reset on resume** ("resumed sessions start fresh"). So the runner now keeps
  `priorSegments` + the live segment's latest total and emits their sum, and `Hub.runUsage` deliberately
  stays a REPLACE — accumulating there on top of an already-cumulative reading would multiply a long run's
  recorded cost by roughly its turn count. (An earlier pass of this fix did exactly that; the corrected
  design is pinned by tests that fail in BOTH directions.)
  *(2) Every non-run LLM call was unmetered.* `streamQueryText` hit `msg.type === "result"` and `break`—
  discarding `total_cost_usd` — which covered Steward chat (both surfaces, sync + streaming), triage,
  auto-review, deep/breaker review, merge briefs, diff walkthroughs, the task linter, crystallize, brief
  decomposition, and project-context condensation. Added a `UsageSink` threaded through every one-shot
  helper, plus one shared `readUsage()` the live-run path and the one-shots both read through so they can't
  drift (it folds `cache_read`/`cache_creation` into `inputTokens` — a cache read is ~10x cheaper but still
  billed, and omitting it under-reports).
  *(3) Those same unmetered calls DEFAULTED TO OPUS.* Both `oneShotText`/`oneShotTextStream` and
  `oneShotRepoAssistant(Stream)` did `?? "opus"` — so on a workspace whose entire fleet is Sonnet, every
  caller that didn't think about a model got the priciest one in the catalog, unmetered. Worst offender:
  repo-grounded Steward chat runs up to **14 tool-using turns with the full `claude_code` preset**, per
  question. `model` is now REQUIRED on all four helpers, turning "what does this cost me?" into a compile
  error — which immediately surfaced **9** such call sites (grep had found 5). All now pass a new shared
  `ASSISTANT_MODEL` ("sonnet"); measured blended rates on this very deployment put Opus at $1.04/Mtok vs
  Sonnet at $0.50/Mtok, so ~2.1x cheaper in practice on the affected paths.
  Regression-proofed in every direction: `tests/usage-accounting.test.ts` (12 pure tests — subagent/sidechain
  capture, cache-tier folding, the cost fallbacks, `addUsage` across segments, and Hub staying a replace) plus
  3 new end-to-end cases in `tests/claude-runner-retry.test.ts` driving the real runner through both relaunch
  paths (turn-exhaustion and a 529 storm, whose pre-retry spend must still count). Verified by injection:
  making `readUsage` ignore `modelUsage` fails 8 tests; dropping the cross-relaunch carry-forward fails 2;
  re-adding a `?? "opus"` fallback or an optional `model?` trips the source-level guards (same scanning style
  as `client-coverage.test.ts`, so neither can quietly return).
- [x] **Session circuit-breaker — a stuck autonomous SWEEP halts for a human, not just a stuck run.**
  Every guardrail above (turn caps, runtime/idle caps, the per-run 3-strikes escalation just above, the
  credential circuit-breaker) is scoped to ONE run. Nothing stopped a project's autonomous sweep itself
  from grinding through task after task while each one individually failed or got flagged — financially
  bounded by a spend budget (see the budget guard elsewhere on this roadmap), but not stopped
  *behaviorally*. Now: `config.autonomyMaxConsecutiveFailures` (`SKYNET_AUTONOMY_MAX_CONSECUTIVE_FAILURES`,
  default 3) consecutive BAD autonomy outcomes for the SAME project — a flagged auto-review verdict, or a
  run that failed — with no good outcome in between, turns that project's own `autonomy` toggle off
  (persisted, the existing UI switch reflects it) and raises ONE summary `escalation` HITL naming which
  tasks and why, instead of letting the sweep grind through more. Composes the two EXISTING outcome
  signals rather than adding a new one: `autoReview`'s verdict (approve resets the streak, flag extends
  it) and `fail()`'s run failures — counted ONCE per run (the first `fail()` call for a runId), not once
  per internal retry attempt, so a single flaky run's own 3-strikes retry loop can't also trip this on top
  of (and racing) its own dedicated escalation. Only tracks outcomes produced WHILE the project is
  autonomous — a manually-supervised project isn't "sweeping". In-memory, keyed by project id (a restart
  resets it to 0 — fails OPEN, one more attempt is allowed before it can trip again; an accepted trade-off
  given the layered guardrails above and the spend budget still bound the actual damage). Re-enabling the
  toggle (the operator's own action, or a future auto-resume) resumes the sweep and resets the streak
  (`Orchestrator.resetAutonomyStreak`, wired from `operations.ts#updateProject`). The summary escalation
  reuses the existing `escalation` HITL kind/UI rather than adding a new surface, but is purely
  informational — resolving it (any action) just dismisses the notice; deliver() special-cases its
  `flags: ["autonomy-paused"]` marker to skip the real escalation's run-lifecycle resolution (help &
  resume / reassign / stop don't apply — there's no single run to act on, and the actual "resume" lever is
  the toggle, not this item). Manual "Start now" assignment is untouched and still works on a paused
  project (`assignTask` never gated on `autonomy` to begin with — only the autonomy tick's own auto-pick
  step is). Known gap, flagged rather than silently missing: a `full`-approval-level project's own
  unattended diff auto-merges (`raiseDiffReview`'s `policy:full-autonomy` path) don't feed the streak's
  good-outcome signal — only `autoReview`'s approve does, per this feature's explicit scope (composing the
  two named mechanisms, not every path that can succeed). Tests: `tests/autonomy-circuit-breaker.test.ts`
  — 3 flags trip + exactly one escalation (not three); a 4th bad outcome after tripping doesn't raise a
  second; an approve in between resets the streak; a failed run composes into the same streak as flags
  without double-counting its own retries; manual assignment while paused; pause is per-project, not
  per-workspace; re-enabling resets; resolving the escalation has no run-lifecycle side effect.
- [~] **⭐ Governance to SOTA (the launch wedge — already the white space; make it best-in-class).** A 6-way
  competitor deep-dive found *none* ship a real safety/policy layer, decision audit, or (bar one) a HITL
  inbox — so this is where we win now:
  - [x] **Safety = policy-as-code, not a hardcoded denylist** — a versioned, diffable per-workspace command policy (allow/gate/deny) that can be dry-run against historical runs before enabling, edited from a Settings panel.
  - [x] **Budget ceiling — daily spend rollup + auto-pick gating.** A per-project daily USD spend ceiling stops the autonomy loop from starting new work once reached, while in-flight runs finish and manual assignment stays available.
  - [x] **Budget-as-allocation — cost-aware picking + pacing.** Turned the flat budget ceiling into an allocator — auto-pick now skips tasks whose estimated cost band won't fit the remaining budget, with optional pacing to spread spend across the working day.
  - [x] **Context-aware risk** — commands are now flagged and bumped to `high` risk by blast radius (outside-worktree paths, network egress) rather than by string matching alone, so auto-approval can't quietly run them.
  - [x] **⭐ Prompt-injection / tool-poisoning firewall** — a structured LLM consult now detects when untrusted content the agent read (a web page, a vendored README) is steering its next tool call, and forces a human gate even on an otherwise auto-approving project; Claude-only for now.
  - [x] **Tamper-evident audit** — every audit record is now hash-chained to the previous one so tampering is detectable offline, with an NDJSON export endpoint for SIEM ingestion.
  - **⭐ Compliance evidence pack** — one-click signed "AI change report" for auditors (EU AI Act tailwind).
    *Landed: a project / run / date-range-scoped report built entirely from the existing tamper-evident
    `AuditRecord` trail — no new decision-recording path. Every approved diff/merge, who approved it (a
    human operator, a standing approval policy, or a fleet agent's auto-review — attributed to the real
    reviewer + reason via `Task.reviewVerdict`) and why, and the risk classification in effect at decision
    time. Ed25519-signed (Node's built-in `crypto`, no new dependency, deliberately not a PKI — a
    per-installation keypair, private key never leaves the host) so tampering with the exported document is
    detectable offline from the document alone (content-hash + signature, both embedded). Rendered to
    Markdown (`packages/shared/src/compliance.ts` — one canonical renderer shared by server tests and the
    web client) for the one-click download; JSON is the signed source of truth. Verified against a real
    git-backed run (human + policy-approved changes, both correctly attributed). SIEM export (line above)
    stays a separate, deferred 🏢 hosted-only feature — this is local, single-operator, one-click.*
  - **Unified HITL Inbox at SOTA** — one inbox across *all* vendors (structurally impossible for single-tool
    rivals); policy-driven auto-triage (auto-approve policy-safe, batch similar gates); **approve-with-memory /
    approve-with-rule** (an approval can write a policy or memory fact in-flow — the Inbox becomes *how* policy
    and memory get authored); async / mobile / delegated approval + escalation SLAs + a 2-person rule for high risk.
    *Landed groundwork: **MCP push notifications** — an MCP client sees new HITL gates + review-needed events
    live over `notifications/message` (workspace-scoped, approver-hint on scoped tokens); wait-for-hitl
    long-poll remains as the reliable fallback for stateless HTTP clients. **`approve-with-rule` turns out to
    already be shipped** (found, not built, while scoping this item) — "Always allow" on a command-approval
    gate writes a standing per-project `ApprovalRule` (exact command, risk-capped), and `decideAutoApproval`
    is consulted on every new command gate (`orchestrator.raise()`), so an identical future command
    auto-approves without asking again; a real precursor to the fuller policy-as-code engine above, not a
    stub. **`approve-with-memory` in-flow capture landed**: a quiet "+ Also remember" toggle on any of the
    four everyday gate kinds (approval/plan/diff/merge) lets an operator attach a durable-preference note to
    an approve, alongside (not instead of) the command-specific rule button — `Resolution.memoryNote`,
    threaded through `ResolveRequest`/MCP's `resolve_hitl` for free, persisted on the resolution and the
    audit trail (rendered in the Audit view) so the intent isn't lost. This is UI + plumbing only: Memory v0
    (below) and the broader policy-as-code engine above haven't landed, so nothing reads the note back or
    enforces it yet — it's a queue of operator intent waiting for either to adopt as a write path. Steward-side
    approve-in-flow and policy-driven gate *batching* still to do.*
  - Secrets at rest (local); 🏢 **observability** (hosted metrics/logging/tracing) + SIEM export of the audit.
- [x] **Runner session-map cleanup** — the Claude runner's fork-resume session map is now a bounded LRU (cap 500) instead of growing unbounded, with no behavior change for realistic single-operator volumes.
- [~] **Deeper runner-capability surfacing** — the `runner-sdk` seam normalizes vendors to a subset; pull more native capability through it (each is additive, behind the existing seam). *Landed: real plan steps (Claude task-tracking tools → PLAN panel) + token/cost telemetry (`onUsage` → Agent `usage`, best-effort for the CLIs) + **plan-mode gate (Claude)** — an opt-in per-project `planModeGate` sets `permissionMode: "plan"`; `ExitPlanMode` is intercepted and raised as a real `plan` HITL (the dead `HitlKind` finally has a producer), and everything but read-only investigation is denied outright until the operator approves it — genuinely no writes happen first + token-by-token streaming for Claude (`includePartialMessages` → a bus-only `run.log.delta` event, never persisted per-token → live "typing" in the run log, same finalized `run.log` write as before). **CLI usage fidelity firmed up** (re-verified against each vendor's CURRENT CLI, not assumed): Codex — fixed a real bug, `usageFromJson` scanned for a flat `usage`/`stats`/`tokens` key but codex-cli 0.147.0's `TokenCountEvent` nests real counts two levels deep (`msg.info.total_token_usage`), so usage was silently never reported; now unwrapped correctly. Gemini — `buildArgs` never actually requested JSON output, so text mode was the ONLY mode ever exercised and usage was never parsed despite the JSON-handling code already existing; now defaults to `--output-format stream-json` (verified against gemini-cli's `StreamJsonFormatter`). Cursor — `--output-format stream-json` confirmed current via `cursor-agent --help`; no bug found, left as-is.*
  - [x] **Token-by-token streaming for the CLI runners** — shipped live-typing token streams for Gemini and Cursor, the two CLI vendors whose wire protocol actually carries per-chunk deltas; Codex and Copilot don't expose one to stream.
  Still to do:
  - **Per-runner tool + prompt policy** — surface `allowedTools`/`disallowedTools`, a project system prompt, and `settingSources` (CLAUDE.md) instead of the hardcoded auto-allow set + inline steering. Ties into v4 repo-native memory.
    *Landed: `disallowedTools` (Claude only)* — `Project.disallowedTools` is a per-project deny-list (a
    deny-list, not an allow-list: an allow-list risks silently stranding an agent that needs a tool nobody
    thought to list) threaded through `StartSpec` into the SDK's own `Options.disallowedTools`. Confirmed via
    the installed SDK's bundled implementation (not just the type doc) that this is forwarded verbatim as the
    CLI's own `--disallowedTools` flag — the tool is removed from the model's context entirely, a categorical
    unavailability, distinct from (and with no interaction/double-gating with) the existing
    `canUseTool`/`AUTO_ALLOW` mid-run HITL gate, which only decides whether an *already-available* tool call
    needs human review. UI: a checkbox picker (`ProjectToolAccess`, `project.tsx`, mirrors `ProjectRunnerKeys`)
    over the risky/mutating built-ins (Bash, Write, Edit, MultiEdit, NotebookEdit, WebFetch, WebSearch);
    Skynet's own control-flow tools (TodoWrite/TaskCreate/TaskUpdate/AskUserQuestion/ExitPlanMode — the PLAN
    panel + HITL plan/question gates depend on them) are deliberately left off the curated list so the UI
    can't casually break Skynet's own machinery, though the underlying field accepts any tool name (a value
    set via the API/MCP outside the curated list still shows up, removable). Not yet done: a full
    `allowedTools` allow-list (deferred on purpose — land the simpler, safer deny-list primitive first) and
    `settingSources` (CLAUDE.md, scoped as a separate change).
  - [x] **Structured diffs in gates/review** — diff gates now carry a stat summary plus an on-demand full unified patch, rendered in the diff view, working identically across every vendor since all changes land in the same worktree.
  - **Token-by-token streaming for the CLI runners** — Codex/Gemini/Cursor NDJSON deltas → the same `run.log.delta` live-typing path Claude now has (Copilot's JSON mode is per-turn, not per-chunk — see below, nothing to stream yet).
  - [x] **Copilot usage/event fidelity** — the Copilot runner now dispatches on real structured JSON events instead of regex-matching text output, with a working approval gate (denied tool calls replay via a scoped `--allow-tool` retry) and per-run session continuity, fixing two adjacent turn-continuity bugs along the way.
- [~] **Review upgrades (adopted from the competitor sweep):**
  - *Landed: **Verifier gate** (bernstein / MartinLoop-style) — the check-running + rollback-on-failure
    mechanics already existed (`MergeEngine` ran `checkCmd` post-merge and reset the merge commit on
    failure); what didn't was the GATE — a failure just logged a 200-char snippet and silently parked
    the run in `review`, no human decision point. Now it raises a real `verifier` HITL (new `HitlKind`)
    carrying the full check output (capped at 50KB, not 200 chars), with the same two-outcome
    resolution shape `merge`/`diff` gates already use — no new one invented: approve retries the
    merge + check (`git.merge.enqueue`), reject or modify bounces the agent to revise
    (`reviseAfterReview`) with the output as guidance (typed guidance wins if the operator supplies
    it; a plain reject falls back to the gate's own output — no typing required to un-stick a failed
    build). `checkCmd` is now **per-project** (`Project.checkCmd`, falls back to the workspace-global
    `SKYNET_CHECK_CMD`), threaded through `MergeRequest` rather than baked into the engine at
    construction — `MergeEngine` is cached per (repo, baseBranch) and shared across every project on
    that repo, so a project-level override resolved and passed per-`enqueue()` call is what keeps two
    projects sharing a cache key (or a project editing its command later) from reading a stale/wrong
    value. **"Auto-commit on green" needed no change** — `onMerged` already fired unconditionally past
    a passing check; confirmed, not re-implemented. HITL rendering (Inbox card, run-detail context,
    audit trail — the diff is now captured for verifier gates too, same as merge/diff, since the
    agent's own worktree is still around even though the scratch integration worktree is gone —
    and the Telegram card/keyboard) all extended to the new kind. Verified with 12 new deterministic
    tests against real throwaway git repos (no LLM involved — this is a git/process feature end to
    end): raise + full output, rollback, retry-raises-a-fresh-gate, reject-bounces-with-the-output-as-
    guidance-then-a-fixed-revise-merges-clean, per-project override, and the on/no-checkCmd fallback
    chain. Live-clicked the new project-settings field for real too. Not built: the gate itself doesn't
    carry a diff stat/summary inline the way merge/diff gates do (only the check output) — the
    underlying diff is still fetchable the same on-demand way, just not pre-computed on the card.*
  - *Landed: **every review is auto-reviewed** — a fleet agent judges each `review`-state task's diff/output
    and writes a structured verdict (approve/flag) to the task; the log line names the reviewer + reason, and
    the audit trail records who reviewed what. Auto-approve merges only when the project's autonomy toggle is
    on; flagged runs stay in `review` for a human. Verdict parsing is field-based (JSON tail), not prose,
    so a reason mentioning "flagged" never false-flags an APPROVE.*
  - *Landed: **`Project.deepReview` — reviewer-as-run (a real agent that actually USES the change).** The
    plain auto-review above reads the last 30 log lines through a stateless, tool-less `consult` — it never
    sees the change run. Deep review (a per-project opt-in, off by default — this is a real bounded agent run,
    not a cheap text call) replaces that with a SECOND real agent: it opens a live preview of the run's own
    branch (`projectPreview.startRun`, reusing the SAME "Preview this change" machinery/worktree — a detached
    checkout, never the doer's own branch-owning worktree) with browser tools on, is handed the task text +
    diff stat + preview URL, and is instructed to actually click through the changed behavior before answering
    with the identical `REVIEW_OUTPUT_INSTRUCTION` JSON contract the plain consult uses. Deliberately kept
    invisible on the kanban board — no `TaskRun`, no fleet-runner "busy" row — via a minimal private
    `RunnerEvents` adapter that auto-resolves the reviewer's own gates (there's no human to ask), captures its
    final text as the verdict, and its `mcp__browser__*` tool calls as a short "evidence" list
    (`Task.reviewVerdict.evidence`). Hard-bounded: `StartSpec.maxTurns` (new field, reviewer gets 20 vs. the
    normal 60) + `StartSpec.disallowedTools` locks out `Edit`/`MultiEdit`/`Write`/`NotebookEdit`/`Bash`
    categorically (an SDK-level removal, not a per-call gate) — a reviewer can browse and read, it structurally
    cannot fix anything it finds. **Never blocks the pipeline**: no repo, a non-Claude reviewer (browser tools
    are Claude-only today, matching `StartSpec.browser`'s existing scope), the preview failing to start, a
    timeout, or an unreadable reply from the reviewer all fall straight back to the plain consult path — same
    safe-default discipline as an unreadable plain-consult verdict, just one layer earlier. Verified two ways:
    5 orchestrator tests against a REAL throwaway git repo + a real (dependency-free, `.skynet/preview.json`-
    described) preview subprocess via an injected `ProjectPreviewManager` (mirrors the existing `providerOverride`
    test seam) — on/off parity, evidence capture, every fallback path, reviewer≠author still enforced; and a
    live, unscripted run of the real Claude Agent SDK through the exact `StartSpec` this feature builds, which
    confirmed `disallowedTools` genuinely blocks edits (zero attempts, not just zero approvals) while the
    reviewer navigated a real local page, clicked a button, and correctly reported what it observed. No settings
    UI yet — enable via `PATCH /api/projects/:id {"deepReview":true}`; a project-settings toggle is a natural
    follow-up, out of scope here.*
  - *Landed: **`Project.breakerReview` — the adversarial second lens (Two-lens review, item 2 below), layered
    on `deepReview`.** The verifier above confirms a change works; this tries to prove it doesn't. Requires
    `deepReview` (a no-op otherwise — there's no verifier pass to run after). After the `deepReview` reviewer
    APPROVES (never spent confirming a flag a human already needs to see), `Orchestrator.runBreakerReview`
    spins up a THIRD bounded agent run — same invisible-on-the-board mechanism as `runDeepReview` (private
    `RunnerEvents` adapter, no `TaskRun`/fleet row) — but told to actively try to BREAK the change against the
    SAME kind of live preview: malformed input, edge cases, auth boundaries, concurrent actions. Structured
    output (field-based parsing, `breaker-verdict.ts`): `{findings:[{severity,what,repro}],verdict:"clean"|
    "broken"}` — every finding needs a real repro (Do #2: "report only what you actually reproduced... no
    speculation"), so a clean pass still records what was *attempted*, not just silence. Any `"broken"` verdict
    with a medium+ severity finding flips the task's verdict to flag with the findings as the reason — the
    existing flag path handles the rest (no auto-merge, human sees it, findings visible on
    `Task.reviewVerdict.breaker` for a future feature-brief `evidenceSummary` line). **Never blocks the
    pipeline**: a run that couldn't even start (no repo, wrong provider, preview failure) records nothing; one
    that ran but produced no readable verdict (timeout, unreadable reply) is recorded "clean" WITH a `note` —
    the verifier's approve is never touched either way. **Tighter bound than the verifier**: 12 turns / 4min vs.
    20 turns / 6min. **Safety**: unlike the reviewer (`Bash` categorically removed), the breaker keeps `Bash`
    available — probing concurrent/malformed requests often needs it — but its approval gates run through the
    SAME `classifyCommand` + `decideAutoApproval` path a real run's Bash gate would (Do #5: "standard command
    gates still apply"), auto-resolved against the project's own trust level with no human to escalate a gate
    to; `WebFetch`/`WebSearch` are removed from context (acts only on the loopback preview URL it's given, not
    the open internet); browser tools against the preview stay unconditionally allowed, same as the reviewer.
    Off by default, same reasoning as `deepReview` (a real agent run, not a cheap check); no auto-created tasks
    from findings (that's a future step) and no settings UI yet, matching `deepReview`'s own current state —
    enable via `PATCH /api/projects/:id {"breakerReview":true}`. Verified with 9 orchestrator tests against a
    REAL throwaway git repo + real preview subprocess (mirrors `deep-review.test.ts`'s harness): a medium-
    severity reproduced finding flips the verdict, a low-severity-only "broken" verdict does NOT, a clean pass
    records its attempts, an unreadable reply is clean-with-note, the breaker is skipped when the verifier
    already flagged AND when `breakerReview` is on but `deepReview` is off, and the Bash gate genuinely
    auto-approves a low-risk command while denying a high-risk one.*
  - *Landed: **the ready-to-merge card shows its evidence, not just its verdict.** A "RECOMMEND MERGE / HIGH
    RISK" card that only shows a one-line prose verdict on a 274-file diff isn't enough to click Merge on — an
    operator either trusts the badge blind or re-derives the same reasoning by hand from the GitHub diff. The
    ingredients `buildMergeBriefing`/`buildFeatureMergeBriefing` (`orchestrator.ts`) always computed (diff stat,
    matched modules, which files tripped the sensitive-area heuristic, tests-changed) were being collapsed into
    an opaque `impact` string and discarded — now they're real `MergeBriefing` fields (`add`/`del`/
    `filesChanged`/`modules`/`sensitiveFiles`/`testsChanged`/`authoredBy`/`reviewedBy`/`reviewDecision`), and
    the card renders them directly: the actual sensitive file PATHS (not just the flag), a real diff-composition
    line, and — since the reviewer is already guaranteed structurally to be a different fleet agent than the
    author (`orchestrator.ts`'s `autoReview`) — an explicit "Authored by X → reviewed by Y (approved/flagged)"
    line, so that independence is visible instead of implicit. The two `buildMergeBriefing`/
    `buildFeatureMergeBriefing` computations were also lifted out of the orchestrator into pure, exported
    functions (`computeMergeBriefing`/`computeFeatureMergeBriefing`/`mergeSensitiveFiles`/`mergeRisk`) so this
    logic — previously untested — is directly unit-tested without a git worktree. Biggest gap closed: GitHub's
    real check-run status (`githubService.prStatus` — already implemented, but only ever consulted reactively
    *after* a merge attempt was blocked) is now fetched by the card itself on load and shown BEFORE the merge
    decision (`GET /api/merges/:id/checks`, best-effort/on-demand — never baked into the polled snapshot, since
    it's a real GitHub API call): passing/pending/failing render as a colored badge, and — since silence isn't
    the same as passing — a repo with no CI configured says so explicitly rather than showing nothing. Verified
    live against a seeded ready-to-merge card end to end (sensitive-file chips, authored/reviewed line, diff
    stat all correct; the checks badge fails silent — no misleading badge — when no GitHub connection exists,
    exactly the intended fallback). Not built: the Verifier gate (above) still only runs on the local
    merge-queue path, never for GitHub-PR-based runs — so a repo with no CI configured genuinely has no
    automated pass/fail signal yet, which the card now says outright instead of staying silent about it.*
  - *Bug fixed: the "Autonomy"/"Deep review"/"Plan mode" toggle box (`.proj-autonomy`, shared by the
    new-project form and the project page) had a fixed `height: 36px` sized for its original single-line
    usage; once a two-line hint (`.proj-autonomy-hint`) was added under the label, the text overflowed past
    the box's rounded border instead of the box growing to fit — reported live with a screenshot. Fixed by
    switching to `min-height` + real vertical padding, so a single-line pill still lands at 36px (unchanged)
    while a wrapped hint grows the box to fit. Verified live on all three affected toggles (new-project form,
    project page).*
  - *Bug fixed: the GitHub repo picker (project creation) and "Edit repository access" (Integrations) showed
    "far from all repos I have access to," reported live. Two compounding causes: (1) `availableRepos()`
    (`github/service.ts`) only re-listed LIVE for a PAT connection — an App/broker connection (the common
    path) returned the connect-time snapshot FOREVER, silently missing every repo added to the org/account
    (or newly granted to the installation) afterward; the PAT branch already had this live-refresh, App mode
    just never got it. (2) "Edit repository access" was worse: it rendered `MOCK_REPOS`, hardcoded sample
    data left over from before the real broker/device-flow connect path was built (`PlaceholderNote: "Sample
    repositories — not fetched from GitHub yet"`) — for a real org it either showed 0 (no `MOCK_ACCOUNTS`
    match) or entirely fictitious repos, with no way to ever discover or select a newly-visible repo. Fixed
    both: `availableRepos()` now re-lists live for App/broker too (`listInstallationRepos`, already correctly
    paginated), carrying each repo's PRIOR `selected` flag forward by id so this is a pure live refresh, not
    a silent re-opt-in of repos the operator deliberately left unselected; "Edit repository access" now fetches
    that same live list (instead of the mock stub) when editing an already-connected installation. Regression-
    proofed: stashing the service fix makes the new `github-app-repos.test.ts` suite fail exactly as reported
    (returns the stale 1-repo snapshot instead of the live 3).*
  - *Bug fixed (follow-up, "New repo" this time): "the Algorithma-se org is not visible at all, despite adding
    a new pat for it" — reported live against the New-repo owner picker in project creation. PR #525 had wired
    the account selector for the "Existing repo" half only; the "New repo" half still ran entirely on the
    DEFAULT connection: `useRepoOwners()`/`fetchGithubOwners()`/`listRepoOwners()` took no credential,
    `createRepo` always used the default connection's token, and `githubCredentialId` was only sent for
    existing-repo creations. Compounding it, `listRepoOwners` silently swallowed `/user/orgs` failures — and
    a fine-grained PAT typically CAN'T call that endpoint (it needs an org "Members: read" permission tokens
    usually aren't minted with), so even the deliberately-added org PAT would have shown only the personal
    login. Fixed end to end: the account picker now shows for BOTH repo modes and threads `credentialId`
    through owners + repos + creation (`createRepo` creates AS the pinned account, and the project is pinned
    to it); and when org-listing yields nothing, owners are DERIVED from the repos the token can actually see
    (any owner prefix ≠ the user is an org it works with) — so the org appears whenever the token can reach
    any of its repos, org-membership permission or not. Regression-proofed (`github-owners.test.ts`): stashing
    the service fix fails 5 of 6 tests exactly as reported (org invisible, repo created under the wrong
    identity).*
  - *Bug fixed: the Inbox's own HITL cards (`QueueCard`, `apps/web/src/views/queue.tsx`) never showed which
    project a card belonged to — only the agent name and the task title, reported live as a "Diff Review" card
    with no way to tell which project it was for at a glance. The ready-to-merge card (above) and the Home
    dashboard's "NEEDS YOU" strip already resolve and show this (`projectName()` in `derive.ts`); the Inbox was
    the one surface that didn't. Added the same `qcard-project` chip (project name resolved from the run's
    `projectId`) between the risk chip and the agent name, matching the existing pattern exactly. Verified live:
    seeded a project, added a fleet agent with no working credential, and started a task — the resulting "Run
    keeps failing" escalation card (itself surfaced by the `fail()`-always-escalates fix above) now reads
    "NEEDS HELP · MEDIUM RISK · Acme Rocket · <task title>" in the Inbox.*
  - *Bug fixed: a "write one line into the roadmap" PR reported 900+ files changed, HIGH RISK, sensitive-area
    hits on files it never touched — the exact evidence the entry above just made visible was itself wrong.
    Root cause: `openPrForRun`/`openPrForFeature` (`orchestrator.ts`) computed the diff stat/patch/PR-body
    against the bare `base` branch NAME (e.g. `"main"`) — this shared repo's own LOCAL branch pointer, which
    nothing ever fast-forwards (`WorktreeProvisioner.fetchBase()` only ever advances
    `refs/remotes/origin/<base>`, never the local branch itself). Three-dot diff (`base...HEAD`) only
    overcounts once HEAD has actually incorporated the base's advancing history via a real merge commit —
    which is exactly what happens routinely (`mergeBase()` folding fresh `origin/main` into a run before its
    PR opens, or a feature batch's own task branches having done the same before landing in the feature
    branch) — so a stale LOCAL base then computes its merge-base far in the past and the "diff" balloons to
    include everything real `main` gained since the local ref was last touched, misattributed to one small
    PR. Fix: diff against the FETCHED remote-tracking ref (`WorktreeProvisioner.freshBase()`, already existed
    for exactly this class of problem — see "worktree freshness" below) instead of the bare name; the actual
    PR target branch (GitHub's `base` field, the stored `PullRequest.base`) is untouched, only the diff
    computation moved. `openPrForFeature` additionally gained its own `fetchBase()` call — `MergeEngine` never
    fetched origin at all, unlike `openPrForRun`'s caller (`pushToGithub`'s `mergeBase()`), so that path could
    overcount even without the ref-name bug alone. Reproduced and verified with two real-git regression tests
    (`tests/worktree-freshness.test.ts`) that fail on the old code and pass on the new: one for each call
    site, each constructing the exact "local base frozen, HEAD transitively contains origin's advance via a
    real merge" scenario that makes three-dot diff overcount.*
  - *Landed: **`error_max_turns` is resumable** — a run that hits the Claude turn cap parks with the current
    plan + guidance instead of dead-ending; the operator resolves it forward.*
  - *Landed: **checkpoint / snapshot-restore** a run's state — extends fork/resume for long tasks
    (AGX-style). A `Checkpoint` record (sha + captured plan/progress + Claude session id,
    `Store`-persisted across file/memory/postgres) manually triggered from the run's Checkpoint
    button — the smaller, safer piece vs. auto-checkpointing on every plan-step transition (no new
    hook into the plan-progress dataflow, no risk of checkpoint spam on a chatty plan; the hook point
    for that, `Hub.runProgress`, is documented in the code for whoever picks it up next). Restore
    re-provisions the run's worktree at the checkpoint's pinned sha (`git update-ref` under
    `refs/skynet/checkpoints/*` so gc can't reclaim it once the branch is reset past it) via the
    existing `WorktreeProvisioner`, and — Claude only — resumes the captured SDK session
    (`StartSpec.resumeSessionId`, forked like `fork()` already does) instead of always the latest.
    Verified for real against a live run (no mocks): worktree rewind, the pinned-ref gc-safety, and
    the full create/list/restore API+UI path all confirmed working end-to-end. Not independently
    verified: the Claude SDK's actual conversation-resume behavior on a restored session (needs a
    real `ANTHROPIC_API_KEY`, unavailable in the sandbox this landed from) — the mechanism mirrors
    `fork()`'s already-shipped `resume`/`forkSession` call exactly, so risk is low, but flagging the gap.*
  - *Landed: **Agent-authored diff walkthrough** — the run's own provider drafts a plain-English summary +
    file/line-anchored comments grounded on the REAL `git diff` (a stateless `consult`, same pattern as the
    auto-review verdict — structured JSON read as a field, never prose classification) before the diff HITL
    raises. Stored on `HitlItem.diff.walkthrough` and rendered above the raw patch in the Inbox/run-detail diff
    view; a failed/unsupported draft (most CLI runners today have no `consult`) never blocks the gate — the
    raw diff is always there regardless. *(Octomux-style.)*
- [~] **🔬⭐ Guided merge — understand-then-merge, to any branch.** Merging today is a single approve on the
  diff HITL. Make it a **guided experience**: before anything merges, Skynet presents a plain-English **merge
  brief** — what the change *does*, which files/modules it touches, the **risks** (blast radius: writes outside
  the worktree, secrets, DB migrations, public-API/contract changes, new deps, history-destructive ops) and the
  **mitigations already in place** (tests run + their results, verifier-gate status, the auto-review verdict) —
  so the operator *understands* the merge rather than eyeballing a patch. On approval, Skynet **merges to a
  target branch of the operator's choosing** — the integration branch / `main` by default, or any other branch
  (a feature stack, a release branch) — owning the rebase/conflict path and reporting the outcome. **Wrap,
  don't rebuild:** it *composes* the **agent-authored diff walkthrough**, the **verifier gate** (tests), and the
  **auto-review verdict** above into one review→merge surface; records the whole brief + decision to the
  tamper-evident audit (feeds the **compliance evidence pack**); and reuses the existing merge engine — only the
  **target-branch selection** and the synthesized brief are new. Human-gated end to end; nothing self-merges.
  **Shipped:** `MergeRequest.targetBranch` (`merge.ts`) — the local merge queue integrates into an
  operator-chosen branch, creating it off `baseBranch` if it doesn't exist yet, same as the default
  (`MergeEngine.enqueue`/`ensureIntegrationBranch`); each distinct target branch runs its own serialized chain
  + scratch worktree, so two branches for the same project never stomp each other. The merge brief itself
  (`merge-brief.ts`) is a stateless consult — same discipline as the diff walkthrough — grounded on the real
  patch, drafted alongside the walkthrough BEFORE the diff HITL raises (`Orchestrator.draftMergeBrief`,
  `HitlItem.diff.mergeBrief`) and composing the task's recorded auto-review verdict + whether the project runs
  checks after merge as SYSTEM-known mitigations (never asked of the model — only genuinely new risk framing
  comes from the consult). `HitlItem.diff.defaultTargetBranch` is computed unconditionally (GitHub PR base when
  connected, else the local integration branch) so the picker's default always matches where a plain approve
  would go; a `merge` retry gate (post-conflict/failure) carries the originally-attempted branch forward. The
  Inbox card (`queue.tsx`) renders the brief above the raw patch and a free-text "Merge into" field (chosen
  over a dropdown — no branch-listing endpoint exists yet, so free-text avoids inventing one); the choice rides
  `Resolution.targetBranch` through resolve → deliver → the audit trail (`hub.ts` records it alongside the
  brief, which is already captured via `HitlItem.diff`). Verified against a live model + a real local git
  repo end to end: a real diff drafted a genuine brief, and approving into a fresh non-default branch actually
  landed the merge there. **Deliberately out of scope, to keep this landable:** the GitHub PR flow's base
  branch isn't operator-choosable yet (a different mechanism from the local merge queue — a non-default choice
  there logs an honest note instead of silently applying or silently dropping); the compact run-detail
  quick-approve (`task.tsx`) keeps the default branch with no picker (the full guided surface is the Inbox
  card, which has the room for it); "Verifier gate" itself is still unbuilt (see above) — the brief notes the
  project's post-merge check command when one is configured, nothing more.
- [~] **Solutioning layer (S1–S9) — `SolutionBrief`, the persistent pre-work planning doc
  everything else hangs off (S4: schema, store, API, MCP).** A human-authored (or human-approved)
  design doc for a chunk of work — problem, approach, options weighed (with the ones NOT taken kept
  for the reasoning), risks, acceptance criteria, open questions — BEFORE any task or run exists for
  it. Modeled closely on `Feature` (contracts.ts): full 3-store CRUD (memory/file/postgres,
  `solution_briefs` JSONB table), `list/create/get/update/delete` under
  `/api/projects/:id/briefs`, live-synced like every other collection (`solutionBriefs` in
  `Snapshot`, `solutionBrief.upserted`/`.deleted` `ServerEvent`s — the same real-time contract
  Feature/Milestone already have, not a static REST-only afterthought), and 4 MCP tools
  (`list_briefs`/`get_brief`/`create_brief`/`update_brief`, "author" scope). `Task.source` gains a
  `"brief"` provenance kind (`{briefId}`) for S7 to spawn tasks off an approved brief and still know
  where they came from. **The one rule enforced two different ways on purpose:** approving a brief
  (`status: "approved"`) is human/API only, never an agent-scoped token — on the HTTP route it's a
  runtime scope check (`principal.scopes !== undefined` refuses ANY scoped token, even one holding
  "approver" elsewhere in this system, since "agent-scoped" per auth.ts means "scoped at all", not
  "lacks this one scope"); on MCP, `update_brief`'s exposed `status` field structurally excludes
  `"approved"` from its enum, so there's nothing to bypass — the SDK itself refuses the tool call
  before Operations is ever reached (verified live via a real MCP client, not just asserted).
  `approvedAt`/`approvedBy` are stamped server-side only, on the actual draft→approved transition
  (never re-stamped by a later edit, never cleared by moving past it to building/done) —
  `UpdateSolutionBriefRequest` carries no such fields at all, so a client-supplied stamp has nowhere
  to land (zod's default non-strict parse drops it). **Deliberately out of scope for S4** (later
  S-numbers, not silently dropped): no UI (the Inbox/project views don't render briefs yet); no
  agent-driven brief authoring or brief→task spawning (S7); no `delete_brief` MCP tool (the HTTP
  route has DELETE, matching the task's own "list/create/update/delete" route spec, but the MCP tool
  list was named exactly 4 tools — deletion stays a human/API-console action, consistent with keeping
  destructive brief operations off the agent surface the same way approval is). Naming note: this
  landed on `docs/`-less territory — no prior "Solutioning layer" section existed in this file before
  S4; this bullet is that section's first entry.
  **S7 — decompose: approved brief → Feature + ordered, sized, linked tasks (the payoff).** One call,
  `POST /api/projects/:id/briefs/:bid/decompose` (`Operations.decomposeBrief`), turns an approved
  brief into a Feature + a batch of concrete tasks a fleet can actually pick up — one structured-output
  consult (`decompose.ts`, same discipline as `merge-brief.ts`/`review-verdict.ts`: a field-based
  parser, never prose classification) asks for `{feature:{name,description}, tasks:[{text,description,
  acceptanceCriteria,effort,dependsOnIndex}]}`, retried once on an unreadable reply, then a thrown
  error (400) with **nothing created** — the Feature and every Task are written only once the whole
  plan parses; a partial/bad reply never half-creates. Each task lands `state: "backlog"` (triage +
  the task linter run on it same as any manually-created task), `source: {kind:"brief", briefId}`,
  `assessmentEffort` from the model's own sizing, and its acceptance criteria folded into the
  description under a `## Acceptance` heading. New `Task.dependsOnTaskIds: string[]` (contracts.ts)
  carries the plan's ordering intent past creation — `dependsOnIndex` (an index into the SAME response
  array) is sanitized to only in-range, *strictly earlier* indices before being resolved to real task
  ids, so a self/forward reference or an out-of-range one is silently dropped rather than failing the
  whole plan (the one thing a null return protects against is a nameless feature or an empty task
  list, not a single stray index — same "drop the bad entry, keep the good ones" discipline
  `merge-brief.ts`'s risks/mitigations already use). The autonomy loop's auto-pick eligibility filter
  (`tickAutonomy`) now skips a `todo`+`autoPick` task until every id in `dependsOnTaskIds` is `done` —
  a pure in-memory check against the tick's own already-fetched task list, no extra store round-trip;
  a missing/deleted dependency counts as unsatisfied (the safe default); a manual "Start now" still
  bypasses it, same as `autoPick` itself is bypassed by a manual start. Idempotent by **content**, not
  by `brief.featureId` (a brief can carry a featureId from manual pre-linking at creation time without
  ever having been decomposed — see S4's `CreateSolutionBriefRequest.featureId`): a brief counts as
  "already decomposed" only once a real task in the project carries `source.briefId` matching it;
  regenerating means deleting those tasks first, a manual operator action, never an implicit overwrite.
  Sets the brief's `featureId` on success; deliberately leaves `status` at `"approved"` — the
  approved→`"building"` transition belongs to S8, not this step. Verified: 13 tests (`parseDecomposition`
  as a pure unit — sanitization, safe-default nulls, effort validation — plus the full `Operations`
  path: creation, idempotency-by-content vs. the pre-linked-featureId non-collision, the
  retry-once-then-nothing-created contract, 404s) and a dependency-gated-autopick test proving a task
  stays `todo` until its dependency is `done`, then picks up the next tick; a live, unscripted run of
  the real prompt against the real Claude API on a realistic brief confirmed a sensibly-ordered,
  correctly-dependent plan comes back parseable as-is. The consult itself is injectable
  (`OperationsDeps.decomposeConsult`, mirroring `Orchestrator`'s `providerOverride`/`previewOverride`
  test seams) rather than mocked at the module level — `oneShotText` resolves through
  `@skynet/runner-sdk/claude`'s package-exports subpath (`dist/claude.js`, not source), and `vi.mock`
  on a node_modules-resolved subpath silently failed to intercept calls made from `operations.ts` (a
  Vite dep-optimizer caching gap, not a vitest bug) — the injected-function seam sidesteps the whole
  class of issue and is the more idiomatic fit anyway, given the codebase's own precedent.
  *(S8 — brief threading + the feedback loop, stacked on S1's `buildAgentContext` (its `brief` field
  was reserved, unwired) and S4's `SolutionBrief` entity: a starting task's `=== SOLUTION BRIEF ===`
  section is no longer dead data — `Orchestrator.findTaskBrief` resolves the brief a task is scoped
  under (a direct `Task.source.briefId` when the task was spawned straight from one, else the brief
  whose own `featureId` matches the task's — the reverse link Feature itself doesn't carry) and
  threads its approach + acceptance criteria (not problem/risks/options/open-questions — the
  turn-to-turn "what to build and how we'll know it's done", not the full planning doc) into EVERY
  `buildAgentContext` call site that produces a real `StartSpec` — assign, fork, checkpoint restore,
  decision resume, review-revise, escalation resume/reassign (six sites; the four `consult`-only
  sites — diff walkthrough ×2, triage, auto-review — stay feature-only, unchanged, matching their
  narrower "judge, don't build" role). `SOLUTION_BRIEF_CHAR_CAP` tightened 2,000→1,500 chars to match
  this task's own spec. **Feedback**: a fleet-proposed task that PARKS (backlog, unassigned — the
  human/autonomy-judgment path, untouched) now still inherits the source task's feature when a brief
  backs it, so a discovery shows up in the brief's scope instead of floating unscoped — `create-active`'s
  auto-promote fast path (already feature-scoped before this) is unaffected either way, since the
  brief link only fires on the path that DOESN'T already set one. **Status** rides the two real
  moments a brief's progress is actually observable, no new polling: `approved` → `building` the
  instant a task under it leaves `todo` (checked inline in `assignTask`, gated on the ORIGINAL
  pre-assign state so a re-assign or a backlog→ongoing skip never re-fires it, and on the brief
  genuinely being `approved` — a still-`draft` brief is never silently promoted); `building` → `done`
  inside the existing `checkFeatureCompletion` hook, the moment every sibling task under the feature
  is done — independent of the PR/merge machinery it also drives, so a brief with no git backend or
  no GitHub connection still completes. A manual `updateBrief` status write is never fought — nothing
  here re-derives or re-asserts a status, it only ever writes on its own two specific transitions.
  UI: a `▤` chip on task cards (`kb-brief-chip`, same row as the feature/milestone chips), and the web
  store now actually carries `solutionBriefs` (S4 shipped the `Snapshot` field + `ServerEvent`s for it
  server-side but never wired the client reducer — a real gap this closes, since nothing could render
  a brief without it). `resolveTaskBrief` itself lives in `packages/shared` (not orchestrator.ts) so
  the exact same resolution rule drives the server's threading/status AND the client's chip — never
  two definitions of "which brief is this." Regression-proofed the same way S1 did (stashed the
  orchestrator/shared wiring, confirmed 9 of 14 new assertions fail, popped it back):
  `tests/brief-threading.test.ts` — pure `resolveTaskBrief` resolution rules, the feedback-loop
  in-memory harness (`tests/fleet-proposals.test.ts`'s pattern), and the threading/status transitions
  against a real git repo (`tests/feature-brief-orchestrator.test.ts`'s pattern).)*
  *Landed (S5): Crystallize — the "make it durable" moment.* `POST /api/projects/:id/briefs/crystallize`
  takes the conversation transcript the caller already holds (the Steward dock's own chat state — there's
  no server-side steward session to reference instead; the request body mirrors `/api/steward/chat`'s own
  client-supplied-history contract exactly) and turns it into a real `SolutionBrief` in ONE LLM call
  (`oneShotText`, the same Claude one-shot helper `steward/assistant.ts` already uses for plain chat —
  crystallize isn't tied to a fleet run, so the run-scoped `RunnerProvider.consult` seam doesn't fit; this
  does). Same discipline as the diff walkthrough / merge brief / auto-review verdict: the model emits a
  zod-validated `DraftBrief` JSON object (`steward/crystallize.ts`), read as fields, never prose classified
  by regex. Unlike those three (advisory — the caller proceeds regardless of a bad reply), crystallize's
  entire job IS to produce a brief, so a reply that doesn't parse gets exactly ONE retry with the
  validation error appended to the prompt (so the model can self-correct), and a second bad reply throws
  `CrystallizeParseError` → 422 — never a half-parsed brief. The retry loop (`draftBriefFromConversation`)
  takes its model-call function as a parameter, so it — and `Operations.crystallizeBrief`, via a new
  `OperationsDeps.crystallizeAsk` test seam defaulting to the real `oneShotText` call — is fully testable
  with a stubbed reply, no real LLM call or API key required. UI: a "Crystallize into a solution brief →"
  button on the Steward dock, shown once a project is focused and the thread has at least one turn; since
  no brief-viewing UI exists yet (S4), success is surfaced as a confirmation line in the thread itself
  rather than a navigation with nowhere to go. **Deliberately skipped, exactly as the task allowed:** the
  "steward suggestion chip" nudge and the Telegram reply-command variant — both explicitly marked
  nice-to-have/skippable, and neither was trivial with the existing command routing. Verified for real: a
  live (uncredentialed, so genuinely failing) Claude call in this sandbox proved the ACTUAL production
  code path end-to-end — the button rendered, the request fired, the retry ran twice against the real
  model, and it correctly threw + created NO brief (confirmed via a live snapshot fetch) rather than
  silently succeeding on garbage; the successful-draft path (all fields landing correctly) is proven by
  `tests/crystallize-brief.test.ts` / `-routes.test.ts` with a stubbed reply, since no real credential was
  available here to prove that half live. *Aside, unrelated to this change, flagged in passing:* the
  onboarding wizard's Fleet step silently blocks "Enter Skynet →" ("Select at least one provider to start
  your fleet") even with a provider selected, whenever NO provider has a real credential — "Skip setup" on
  step 1 is the only way through a fresh, keyless install today. Not touched here; noted for whoever picks
  it up.
- [x] **S6 — Deep-explore grounding (optional).** Added an opt-in, read-only bounded agent run that actually reads the codebase and annotates a draft `SolutionBrief` with wrong assumptions, real touchpoints, and blast radius before an operator approves it.
- [x] **S10 — Execution intents: feasibility resolver + composite actions + ONE server executor.** Added one shared server-side feasibility resolver + executor that every future caller (Steward's confirm chip, MCP tools, Telegram) can call into to start/queue work, instead of separate reimplementations of "which tasks can run now."
- [~] **UI system polish (P2 of [docs/ux-review.md](docs/ux-review.md)):** *Landed:* **amber
  untangled** — `--accent` (brand/primary) and `--warn` (caution/waiting status) were an accidental
  hex duplicate (`#FFB224` both, not just visually close); `--warn` is now a genuinely distinct
  golden-yellow (`#E8C64A`, ~8° hue shift). The handful of singular "look here, a decision is
  needed" signals (topbar/nav needs-you counts, the home NEEDS YOU strip title) are pinned to
  `--accent` explicitly so the rarest, most-actionable signal keeps the brand hue; every other
  `--warn` consumer (risk chips, wait pills, log lines, timeline bars, ~20 selectors) shifts
  automatically. **Nav icons** — the 12 unicode glyphs in `shell.tsx` (⌂⊙❑▤◇⇲⑂◈⚙✓◐▾▸) replaced with
  a hand-inlined 16px Lucide stroke set (`components/icons.tsx`, path data only, no new
  dependency — matches the app's existing hand-inlined-`<svg>` pattern rather than adding an icon
  library for a dozen icons). **Motion tokens** — `--motion-fast` (120ms) / `--motion-base` (200ms),
  both ease-out; migrated ~24 scattered ad-hoc transition durations onto them, incl. the one
  roadmap-named transition that actually exists in the code — queue.tsx's HITL-resolve fade+slide
  (`.qcard.leaving`, the "gate-resolve collapse") — now on `--motion-base` and wrapped in
  `prefers-reduced-motion`. The other three named transitions (view/lens crossfade, card-enter,
  subway-merge draw-in) were searched for by name and behavior and don't exist as implemented CSS
  anywhere in the codebase today — nothing to migrate; building them would be new animated
  features, out of scope here. **Interactive-surface state rule** — every `.btn` variant gained a
  real `:active` press state (none existed anywhere before) plus `:focus-visible`; a global,
  low-specificity `button/a/input/select/textarea/[role=button]/[tabindex]:focus-visible` fallback
  now rings every interactive element that had no bespoke treatment (more specific existing rules,
  e.g. `.op-navitem`, still win). Spot-checked ~15 `:hover` selectors for stray hover-without-
  `cursor:pointer`; found none. **a11y** — `aria-label` added to 9 icon-only buttons that had none
  (modal closes, task edit/archive/delete, agent remove, approval-rule revoke), `aria-expanded`
  added to 4 disclosure toggles missing it, and one `role="button"` div (Settings' Advanced toggle)
  fixed to respond to Enter/Space, not just click. Fixed 3 of the 4 legibility-floor violations
  ux-review.md named (subway start/ship labels 9.5px→11px + `--muted`, backlog subtitle, folder-
  picker hint — the 4th, the timeline legend, was already fixed by an earlier pass). *Verified
  live* (screenshots + keyboard-tab + injected-swatch color check) in the running app, not just
  reviewed in source. *Deliberately not done:* content max-width — every view already has a
  max-width + centered wrapper (`.vw`, `.overview`, `.projview`, `.queue`, `.detail`, `.audit`,
  `.map`), so the roadmap's "views left-hug at 1440" framing was stale; the real remaining ask —
  *purposeful* two-column layouts for the still-sparse views (Fleet: cards + an aggregate stats
  column; Integrations: a real catalog grid) — is a bigger, judgment-heavy layout redesign, not a
  CSS-token fix, and belongs in its own PR. A full sweep of the ~90 other `--faint` usages beyond
  the 4 named examples wasn't attempted either — that's the still-separately-tracked v0.5
  "Legibility floor" item (#4 above).
- [x] **Project header decluttered — Governance popover.** Consolidated ~15 same-weight header pills into a single Governance popover (Approvals, Autonomy, Budget, Plan mode, Deep/Breaker review), cutting the toolbar down to about 7 top-level controls.
- [ ] 🏢 Auth: **SSO/OIDC**.
- [x] 🏢 **Read-only (viewer) role** — added a read-only viewer role that can observe everything but mutate nothing, enforced by a new scope check on every non-GET API route (not just the MCP layer, which was the only place it ran before).
- [x] 🏢 **Time-limited admin promotion** — admin-granted, auto-expiring elevation of a viewer to admin (break-glass style) that reverts automatically, with every grant and expiry audited.
- [ ] 🔗⛓ **Structural agent-hierarchy hooks** — `role`, `familyOf`→root, worker→manager merge (cheap, additive; from [docs/agent-hierarchy.md](docs/agent-hierarchy.md)).
- [~] 🔗⛓ **Feature-scoped branch hierarchy — branch out from branches.** When a Task has `featureId` set,
  its approved diff now merges into a shared `skynet/feature/<id>` branch (`MergeEngine.targetBranchFor`,
  generalized from the old `integrationBranch(projectId)` — `MergeRequest.featureId` picks the
  destination) instead of straight to the project's integration branch or its own PR. Once every task
  under that Feature is done, Skynet closes the batch: for a GitHub-bound project, ONE aggregate PR
  (`openPrForFeature`, `Feature.pr` — a dedicated field, not reused per-task `TaskRun.pr` slots, since by
  batch-close time every task's own worktree/review state is already retired); for a local-only project,
  the feature branch merges up into the project's real integration branch. Conflicts at either stage
  reuse the existing `merge`-kind HITL unchanged (`raiseMergeHitl`/`raiseMergeFailedHitl`, now
  feature-aware via `isFeatureUpMerge` + `HitlItem.sourceBranchOverride` so a retry re-targets correctly
  either way — a real correctness bug an adversarial design review caught before it shipped, not after).
  Ready-to-merge gets a parallel `mergeReadyFeaturePr`/`dismissReadyFeaturePr` (merge + dismiss only — no
  rework/update-branch for a batch; a stale/conflicting feature PR surfaces as a normal GitHub conflict on
  the PR itself, and requesting changes means a follow-up task under the same feature). Verified end to
  end against real git repos (`tests/merge.test.ts`, including a concurrency regression test for a scratch-
  worktree collision the implementation surfaced and fixed) plus orchestrator-level ready-to-merge
  coverage (`tests/ready-merge.test.ts`). **Deliberately NOT built** (scoped out, not silently missing):
  tasks under a Feature still branch from the project base at *assign* time, same as always — they do
  **not** branch from the feature branch itself (the `fork()`-style `baseRef` chaining the original sketch
  above envisioned). That's real added complexity for a benefit the actual ask ("fewer PRs for related
  work") doesn't need; only the merge *destination* changed. A different axis from **Structural
  agent-hierarchy hooks** just above (that's agent *role* — worker/manager; this is *Feature/task*
  grouping) — complementary, not dependent.
- [x] **Feature-batch size guardrail.** Added two assistive guardrails — a merge-risk floor at PR time and an early warning at task-link time — that flag an unattended Feature batch before it grows into one unreviewable mega-PR.
- [x] **Make the one human approval reviewable — feature-level brief.** A batched Feature PR now carries a system-composed brief (per-task verdicts, aggregate spend, a consult-drafted narrative of what shipped) instead of forcing a rubber-stamp on a 30-task diff.
- [x] **🔬⭐ Autonomous backlog sweep — the v1 path to the auto dev team.** Composed existing v1 machinery into five shipped phases — budget ceiling, two-lens (verifier + breaker) review plus feature-level verification, circuit breakers with right-sized batches, a self-replenishing scope-taxonomied backlog, and budget-as-allocation — so the fleet can build out a whole backlog unattended under a daily budget, with humans approving only completed, tested work.
- [ ] **🐛 Task-write atomicity — no optimistic concurrency, confirmed real data loss.** Reported
  live (2026-08): an operator batch-updating 7 tasks lost `description` on all seven (their first
  attempt sent `null` for fields they didn't mean to touch — a genuine PATCH-semantics footgun,
  since `UpdateTaskRequest`'s fields are `.nullable().optional()`, so omitted = untouched but an
  explicit `null` legitimately clears the field; **mitigated** by tightening the MCP `update_task`
  tool's description + a new server-wide MCP instruction to never fill in a field just because it's
  in the schema). But a SEPARATE, deeper issue surfaced during their manual recovery: restoring one
  field on `t-skynet-mt0ebjfq-10` raced against the autonomous **triage** step writing the same task
  concurrently, and the triage write — built the same way every `Task` write in this codebase is
  (`Operations.updateTask`/`orchestrator.ts`: fetch the current record, spread `{...current,
  ...patch}`, write the whole thing back via `Hub.upsertTask` → `store.putTask`, no version/etag
  check) — silently clobbered the recovery. This is a genuine, unguarded **lost-update race**, not
  specific to `update_task`: EVERY one of the 25+ `upsertTask` call sites across `orchestrator.ts`/
  `operations.ts` does the same non-atomic read-modify-write. It was a low-risk pattern when a task
  had effectively one writer at a time; it stops being safe now that autonomous writers (triage,
  auto-review, the self-replenishing-backlog proposal path above) run concurrently with human/
  scripted edits on the same record. **Needs a real design decision before implementing** (broad
  blast radius — 25+ call sites, likely more than just `Task`): options include a monotonic
  `version`/`updatedAt` field checked-and-incremented atomically at the Store layer (reject/retry a
  stale write), narrowing the highest-risk autonomous paths (triage, auto-review) to single-field
  atomic patches instead of whole-record read-modify-write, or a compare-and-swap primitive on
  `Store.putTask` that every caller routes through. Scope this deliberately rather than bolting a
  fix onto one call site — the race is systemic, not local to triage or to `update_task`.

- [x] **⭐ Scenario coverage — "how well does what we built actually work?" per project.** Added a per-project Coverage lens (plus a tree view) that extracts closed-set behaviour axes from the code and cross-checks them against the test corpus, surfacing untested cells that line coverage's "which statements ran" metric misses.

- [x] **⚠️ CRITICAL — the agent-control loop exists ONLY on the Claude SDK path.** Documented finding: only the Claude SDK runner has real HITL gating, escalation, and resume — every CLI-backed runner (Codex/Gemini/Cursor/Copilot/Hermes/OpenCode) is a comparatively ungovernable, approval-gate-at-best runner.
- [x] **Alternative LLM providers, phase 1 — Claude-compatible endpoint per credential.** Added a Claude-compatible endpoint per credential (baseUrl + gateway auth token) so a cheaper vendor speaking the Anthropic wire protocol runs the full, fully-governed agent loop instead of a second-class CLI adapter.

- [x] **Compatible endpoints, made usable: presets, real pricing, and a "not Claude" marker.** Turned the free-text compatible-endpoint field into a real setup: a vendor rate catalog (Sonnet as the baseline for comparison), accurate cache-aware spend accounting, a working per-endpoint verify check, and a "via <vendor>" marker so it's clear which vendor served a run's tokens.

- [x] **Endpoint smoke test — prove a vendor can actually drive the agent loop, not just authenticate.** Added a per-credential Test button that runs one tiny real task to prove a Claude-compatible endpoint actually drives tool calls, gating, streaming, and usage reporting, not just authentication.
- [x] **Endpoint smoke test — prove a vendor can actually drive the agent loop, not just authenticate.**
  Verify answers "does this key work". It does not answer the question that decides whether a
  Claude-compatible endpoint is usable *for Skynet*, and that gap is dangerous precisely because it's
  invisible: a compatibility shim can authenticate perfectly and never emit a tool call, which silently
  kills every approval, question and escalation — and nobody would attribute the symptom to the endpoint.
  New **Test** button per credential (Settings) runs ONE tiny real task — read a scratch file, echo its
  contents — and reports a checklist rather than a verdict: endpoint reachable · emits tool calls *and
  Skynet's gate intercepts them* · tool results feed back · streams partial output · reports usage ·
  separates cache tiers · has published rates. Critical checks gate the verdict; streaming and cache
  tiers report without blocking (Skynet works without token-level deltas, just less liveliness).
  Auth failing SKIPS the rest rather than printing a wall of red — with no session there's nothing
  truthful to say about tools, and a false "tools failed" sends someone debugging the wrong layer.
  Costs a fraction of a cent, capped at 60s, and is **operator-triggered only** — never automatic, since
  unlike verify it spends money. Catalog caveats a live probe can't see (an ignored thinking budget, a
  shim that misreports its context window) are surfaced alongside the results.
  **Two bugs the first live run against a real endpoint exposed**, both invisible to unit tests: an SDK
  result is a `success|error` union, so a rejected key came back as an error RESULT rather than a thrown
  exception — nothing threw, a zero-filled usage object existed, and `auth` reported a cheerful **pass**
  for a credential that had authenticated with nothing; and `usage` is an object even when every counter
  is zero, so truthiness alone called an entirely empty session "reachable". Both now pinned by tests.

- [x] **Internal surfaces gate on RELEASE, not on "production".** Fixed internal QA/dev surfaces gating off a dev-build flag that was false for any production deploy, hiding Skynet's own tooling from its own hosted instance; also closed a route-gating hole that left QA pages reachable by deep link in a shipped build.

- [x] **Repoint an EXISTING runner at another credential (and stop the endpoint chip breaking the row).**
  The Key picker was create-only — "an existing agent's credential is fixed" was a fair rule when a
  credential was just a second API key, but it stopped being fair the moment a credential could name a
  Claude-compatible endpoint: moving a runner to a cheaper vendor then meant delete-and-recreate, which
  throws away its task history and cost rollup. The picker is now offered when editing too, seeded from
  the agent's current credential, and says plainly that a switch applies to the runner's NEXT run
  (anything in flight resolved its credential at start). Server-side, `UpdateRunnerRequest.credentialId`
  is validated to exist AND to belong to that runner's provider — without the provider check you could
  point a Claude runner at a GitHub or Fly token, which authenticates nothing and fails only once a real
  run starts.
  **Two bugs of mine found while doing it, both by looking at the actual UI rather than the code:**
  the `via <vendor>` chip was added as a sixth top-level child of `.fleet-idle-row`, which is a FIXED
  five-column grid (`1fr auto auto auto auto`) — so it landed in an implicit sixth cell and wrapped the
  row's action buttons onto a line of their own. It's now inside the name cell. (It was visible in my
  own verification screenshot and I read past it.) And there are TWO inline ConfigForm editors — the
  card and the idle roster — of which only one was updated, so a vendor switch made from the idle row
  saved the new MODEL against the OLD credential: a runner configured for `deepseek-v4-flash` while
  still authenticating to Anthropic, which is worse than not offering the switch at all. Both are now
  guarded by source-scanning tests (the grid shape, and that every ConfigForm save path carries
  `credentialId`).

- [x] **Bench a credential — stop every agent on a key, and put them back.** When something is wrong with
  a key (leaking, rate-limited, compromised, billing surprise) the operator needs one action that takes
  the whole fleet off it. `SecretMeta.paused` records who/when/why, `providerUsable` refuses a paused
  key so no runner on it is given work, and pausing HALTS the runs already on it —
  `haltRunsOnCredential` reuses `haltAgent`, so each run stops, its worktree retires, its runner frees
  and its task returns to `todo` cleanly re-pickable by a runner on a different key. **Both halves are
  the feature**: refusing new work alone leaves whatever is already running to keep using the key, which
  for a leaking key is most of the damage; halting without the durable flag just lets the autonomy loop
  pick it straight back up next tick. Mark-then-halt, in that order, so a freed task can't be
  re-assigned to the same key through the gap. Durable ON PURPOSE, unlike the in-memory quota breaker
  (`depletedKeys`) which SHOULD evaporate on restart because the key may have been topped up — a
  deliberate pause exists because someone decided the key must not be used, and a deploy is not a
  decision to resume. A key rotation preserves the pause (replacing the key is a step toward fixing the
  problem, not a decision to resume); an explicit resume also clears the quota breaker, since that's the
  operator saying the key is good again. Available to the operator (Settings, with a required reason)
  and to **Steward** (`pause_key`/`resume_key`, through the same confirm-chip path as every other
  action).
- [x] **`maxRunners` caps CONCURRENCY, not roster size.** It used to refuse creation, so idle agents ate
  the ceiling and configuring a fleet — one runner per cheap endpoint, a spare on a second key — hit a
  wall for capacity nobody was using. Adding runners is now never blocked; the cap is enforced where
  runs are actually assigned, counting BUSY runners, so idle and paused-key runners cost nothing. Past
  the cap tasks simply queue. The Fleet page says so outright ("5 agents configured, 2 work at once")
  rather than leaving an operator to wonder why their eleventh runner never picks anything up, and names
  separately how many are on a paused key — those take no work at all, which is a different problem from
  queueing. Settings and the MCP tool descriptions were corrected too; both still described a fleet-size
  cap.

- [x] **A run on a compatible endpoint could authenticate with the WRONG vendor's credential.** Found from
  a live DeepSeek `401 Authentication Fails, Your api key: ****f81f is invalid` on a key that was fine.
  `applyCredential` stripped `ANTHROPIC_API_KEY` before pointing a run at a third-party endpoint — but
  not `CLAUDE_CODE_OAUTH_TOKEN`, which `buildRunnerEnv` deliberately PRESERVES as a real standalone
  credential and which outranks the gateway token. On any host carrying a `claude setup-token`
  subscription (a developer machine, or a container that inherited one), a run pointed at DeepSeek would
  therefore authenticate with the **Anthropic subscription token**: the third-party vendor receives the
  operator's personal token, and the run 401s naming a key that was never the problem — sending whoever
  debugs it after the wrong thing entirely. This is the exact failure the ANTHROPIC_API_KEY strip was
  written to prevent; the second credential was simply missed. Both now come off together.
  **Also: keys are trimmed at the boundary.** A key pasted from a vendor console routinely carries a
  trailing newline, which rode into `Authorization: Bearer <key>\n` and was rejected as invalid — and
  because `last4` was fingerprinted from the untrimmed string, the fingerprint shown in Settings
  disagreed with the vendor's own `****f81f`, destroying the one cheap diagnostic an operator has.
  Trimmed once in `sealRecord`, so the stored key, its fingerprint, and what a runner sends are the same
  string. Six of the seven new tests fail on the pre-fix code.

- [x] **⭐ Making Skynet DRIVE projects, not just process tasks — three steps.**
  **(1) Steward proposes work the discussion produced.** Its prompt said *"include it ONLY for change
  requests, never for questions, summaries, or chat"* — so agreeing on four things with Steward and then
  having to ask it a second time to write them down was the designed behaviour, not an omission.
  Proposing is cheap and reversible (nothing runs unconfirmed; an ignored chip costs nothing), so the
  rule now allows offering `add_task` when a discussion produced concrete work, with an explicit
  *don't* list (answered questions, summaries, undecided discussion, speculation, work already on the
  board). Relaxing it makes duplicate chips the obvious new failure mode, so that guard is CODE, not a
  sentence a model may ignore: `validateProjectAction` drops an `add_task` whose title already exists
  (`sameTaskText` — loose about case/spacing/trailing punctuation, deliberately *not* fuzzy beyond that,
  since silently swallowing genuinely new work is the worse error).
  **(2) S11 — the execution intents are finally reachable.** `start_task`/`queue_tasks`/`start_feature`/
  `process_backlog` were fully built, tested (21 tests) and DELIBERATELY switched off: the dock couldn't
  execute them, so teaching Steward to propose one would have produced a confirm chip that did nothing.
  The dock now routes them to `POST /projects/:id/steward/actions`, and only then were they added to
  `SYSTEM`. The outcome is REPORTED, not swallowed — a composite routinely does less than it looks like
  it will (already running, never triaged clear, over today's budget), and a chip that just says "done"
  after excluding four of five tasks is a lie. Steward is explicitly told never to propose these
  speculatively: writing work down is free, starting agents spends money.
  **(3) The project driver.** The autonomy tick was TASK-scoped — triage one, pick one, review one —
  so it kept individual tasks moving but never asked the project-level question. A project with an
  empty backlog, two items stuck in triage and nothing merged for days looked *identical* to a healthy
  idle one: the loop stayed busy, it didn't drive. `assessProjectDrive` (pure, `drive.ts`) answers
  "what stands between this project and done?" as one of eight states, ordered so the diagnosis sends
  you at the right thing — work in flight outranks everything (the project IS progressing); a review
  waiting on a human outranks a capacity complaint (adding runners wouldn't help); and "no usable
  runner" is kept distinct from "runners are busy", because a runner on a paused key is configured but
  cannot work. Written to `Project.drive` only when the answer CHANGES (a state to read, not a log),
  shown on the project page only when something is actually in the way — a line that also appears for
  healthy projects is one operators learn to ignore. The single automatic remedy is a source REFILL
  (re-pull issues / a roadmap doc when nothing is startable), rate-limited to once per project per 15
  min: a read, not a run. Everything else is surfaced for a human, because a project that has genuinely
  run out of clear work is a decision, not a scheduling problem.

- [x] **The driver ACTS: a dry board proposes its own next steps.** The project driver could already
  tell when a project had run out of startable work, and re-pull a bound source. A project with **no**
  source was the case where it genuinely stops until a human thinks of the next thing —
  `replenishBacklog` is that thinking, grounded in what the project already knows: its goal, its roadmap
  doc, the operator-supplied context, and **what's already DONE** (the difference between proposing
  *next* steps and re-proposing the same list). Structured output, zod-validated, ONE retry on an
  unreadable reply — same discipline as decompose/crystallize — and an empty list is an explicitly
  VALID answer: a project whose direction isn't written down anywhere should produce nothing rather
  than a plausible-sounding invented roadmap.
  **Why this can't run away**, which is the whole reason it's safe to switch on: proposed tasks land in
  `backlog` with `autoPick: false`, and auto-pick only ever starts tasks flagged `autoPick` — so nothing
  proposed here can start itself; a human (or an explicit `queue_tasks`) has to pick it up. Without that
  property this would be a perpetual work generator — invent tasks, run them, empty the board, invent
  more — the one failure mode a cost-conscious operator would never forgive. Gated additionally on
  `project.autonomy` (the established consent for "may spend on its own", the same gate auto-pick and
  auto-review sit behind) and rate-limited to once per project per 6h — far coarser than the source
  refill, because that's a read and this is a model call, and a project that just ran dry will still be
  dry in fifteen minutes.

- [x] **⭐ Merging you can comprehend: evidence-gated auto-merge + one-click undo.** Approving a finished
  diff is the worst moment to ask a human for judgement — they didn't write the code, may not remember
  the task, and by then all the leverage is gone: rejecting discards hours of work, so the honest
  options are rubber-stamp or feel bad. Skynet already gathered real evidence about every change (an
  independent agent's review verdict, a browser-driven deep review, an adversarial breaker pass, a fixed
  sensitive-path list, the diff's own size) and then **ignored all of it at the gate**: every merge asked
  a human, except `approvalLevel: "full"`, which jumped to merging anything non-high-risk with **no
  review required at all**. There was nothing between "judge every diff yourself" and "trust
  everything".
  **`decideAutoMerge` (pure, `merge-policy.ts`) is that middle**, and the thing that makes it
  comprehensible is that it always says WHICH condition sent a diff to a person — every failing
  condition, not just the first, so fixing one doesn't reveal the next on a re-run. Sensitive paths and
  high risk gate unconditionally (a policy able to switch those off would defeat the reason the list is
  fixed); review approval, deep-review evidence and a clean breaker are demanded only when the project
  actually opted into that lens, since holding a project to a bar it never chose just means nothing ever
  merges. Off by default. An unattended merge logs WHAT the evidence was, so "who approved this?" has a
  better answer than "the machine did".
  **One-click undo is what makes any of it tolerable** — it converts approval-before into review-after,
  and if undo costs one click, most merges don't need pre-clearance at all. `MergeEngine.revert` records
  the merge commit at merge time and undoes it with a **revert commit, never a history rewrite** (the
  branch may already be pushed or built on; rewriting it would break everyone's checkout to undo one
  change). A second revert is refused rather than stacking an empty commit, and a revert that conflicts
  because the change has been built on since is **reported honestly rather than forced** — that's a real
  decision for a human. Verified against REAL git repos, not mocks.
### 🔒 Security hardening — Aug 2026 audit remediation
Full-codebase security audit of `main` (8 finder agents by area + a skeptical filtering pass per
candidate finding, confidence ≥ 8/10 kept) surfaced 7 real, independently-confirmed vulnerabilities —
none introduced by any in-flight PR, all pre-existing on `main` today. Grouped as one epic because they
share urgency (credential exposure, path traversal, auth escalation — governance-track trust, not
feature work), but the 7 tasks have no ordering dependency on each other and can be picked up and
shipped in parallel.

- [ ] **Redact GitHub token from push/sync error logs** — `pushBranch`/`syncBase`
  (`apps/server/src/github/provider.ts`) build the git remote with the token embedded
  (`https://x-access-token:<token>@github.com/...`) and run it with no try/catch, unlike the sibling
  `cloneRepo` which already redacts. Node's own `Command failed: <argv>` error format embeds the
  token-bearing URL in `.message` on *any* push/fetch failure (branch protection, stale
  `--force-with-lease`, revoked installation, a network blip) — that raw message reaches
  `hub.runLog()`, which persists it and broadcasts it live to the operator's UI. Fix: wrap both in the
  same `redactToken()` pattern `cloneRepo` already uses; consider generic scrubbing at the `runLog`
  layer as defense-in-depth. *Severity: High. `apps/server/src/github/provider.ts:258-264,348-352`.*
- [ ] **Contain `roadmapPath`/`repoPath` reads to the project's own repo** — an "author"-scoped
  `PATCH /api/projects/:id` can set `roadmapPath` (or `repoPath` itself) to an arbitrary filesystem
  path with zero containment check; `GET /api/projects/:id/roadmap` (no elevated scope required) then
  returns that file's raw content in the response. Fix: resolve the joined path in `readProjectDoc` and
  reject unless it stays within `repoPath` (the codebase already uses this exact pattern in
  `preview/route.ts` — reuse it); also constrain `repoPath` updates the same way.
  *Severity: High. `apps/server/src/steward/docs.ts:50`, `apps/server/src/operations.ts:2351-2422`.*
- [ ] **Strip secrets from the Fly static-site build environment** — `FlyDeployManager.start()` runs a
  repo-declared `.skynet/preview.json` `install`/`build` command with the server's full `process.env`
  (every provider API key, `SKYNET_MASTER_KEY`, the GitHub App private key, the Telegram bot token),
  reachable pre-merge via a normal "Deploy to Fly.io" click on a run's own branch. The sibling
  live-preview path already solved this exact problem (`PREVIEW_ENV_DENYLIST`/`previewEnv()` in
  `project-preview.ts`) — the Fly path reuses the same `worktree.ts` helpers but never adopted the
  wrapper. Fix: pass `previewEnv()` into both the `ensureDeps` and `runToCompletion` calls in
  `deploy.ts`. *Severity: High. `apps/server/src/fly/deploy.ts:233,235`.*
- [ ] **Stop same-origin preview iframes from exposing the session token** — both preview surfaces
  (`apps/web/src/components/preview.tsx`, `apps/web/src/views/project.tsx`) set
  `sandbox="allow-scripts allow-same-origin ..."` while serving agent-built app content on Skynet's own
  origin by default (the live-preview proxy has no separate-origin option at all; the artifact-preview
  base URL defaults to the app's own port unless an operator manually opts into a separate subdomain,
  which nothing nudges them toward). Same-origin + those two flags means injected/malicious in-preview
  JS can read `localStorage`'s `skynet_token` — the same token driving both REST and WS — for a full
  session hijack. Fix: drop `allow-same-origin`, or refuse to boot the preview proxy without a
  genuinely distinct configured origin; longer-term, move the session token out of `localStorage`.
  *Severity: High. `apps/web/src/components/preview.tsx:47`, `apps/web/src/views/project.tsx:2275`.*
- [ ] **Bring `.skynet/preview.json` build/install commands under the command-safety gate** — the
  live-preview `install` step always runs unsandboxed via `/bin/sh -c` regardless of configuration, and
  the `dev`/`start` step only sandboxes behind an off-by-default `SKYNET_RUNNER_SANDBOX` (and even then
  the sandbox is write-confinement only, not a real security boundary — reads/network stay open). This
  executes agent-branch content (plausibly prompt-injected) via the explicitly pre-merge "preview this
  change before approving it" path, entirely outside the `command-safety.ts`/`injection-firewall.ts`
  gates already applied to agent tool calls elsewhere in this codebase. Fix: route these commands
  through the same bounded-execution/scrubbed-env discipline, and make the sandbox mandatory (not
  opt-in) for the `install` step specifically. *Severity: High. `apps/server/src/preview/worktree.ts:39-45,71-76`.*
- [ ] **Close the elevated-viewer permanent-token loophole** — `POST /api/service-tokens`'s
  `requireHuman()` checks only the live, elevation-inflated `scopes` value, not the caller's *persisted*
  role the way `requireAdmin()` deliberately does (with an existing doc comment explaining exactly why —
  to stop "elevated viewer re-grants/self-extends"). A viewer temporarily elevated to full authority
  (15min–1hr) can mint a standalone, independently-stored bearer token with a high scope set and no
  forced expiry, which survives long after the elevation lapses. Fix: gate service-token routes with
  the same persisted-role check `requireAdmin` uses, and enforce a mandatory TTL ceiling on tokens
  minted by a non-persisted-admin caller. *Severity: High. `apps/server/src/auth/routes.ts:216-252`.*
- [ ] **Validate `path` against traversal in the GitHub Contents API calls** — `getFile`/`putFile`
  build the Contents API URL by raw string concatenation with no `..`-segment rejection before
  `fetch()`; WHATWG URL normalization collapses `../` segments client-side, so a crafted `path` can
  retarget the request at a completely different repo. `import_repo_file` (an MCP tool, `"author"`
  scope, nominally project-confined) exposes this `path` unvalidated — `project-scope.ts`'s confinement
  only checks the `projectId` argument, not the semantic target of `path` — and the same traversal
  string is later replayed by `resync_source`/`commitRepoFile` (the identically-vulnerable `putFile`),
  giving a write leg into the out-of-scope repo too. Fix: reject any `path` containing a `.`/`..`
  segment before it reaches `getFile`/`putFile` (and the same-pattern `readRepoFile`/`listRepoRoot` in
  `github/service.ts`), and percent-encode each remaining segment individually rather than
  concatenating raw strings into the URL. *Severity: High. `apps/server/src/github/provider.ts:211-231`,
  `apps/server/src/mcp/tools.ts:514`.*

Two related findings came in just under the report's confidence bar (≥8 kept; these landed at 7) and
are tracked as **follow-ups**, not blocking this epic: unescaped `.skynet/preview.json` fields
(`outputDir`/`region`/etc.) interpolated into the generated Fly `Dockerfile`/`fly.toml` with no
sanitization (a config/instruction-injection primitive into Fly's remote builder — needs a
crafted-not-naive payload to actually work, per the filtering pass); and the review-verdict auto-merge
prompt splicing unsanitized synced-GitHub-issue-title text into the reviewer LLM's prompt with no
source-trust gate, reachable only when a project has both public issue sync and `project.autonomy` on.
- [x] **MCP kept going down, and `--restart=always` could not save it.** Diagnosed live: the app was
  unreachable while `docker ps` reported *"Up 24 hours"*. `docker inspect` said `running` with
  `RestartCount=0`, but the PID it named **did not exist on the host**, and `docker exec` gave the game
  away — *"cannot exec in a stopped state"* — against a container `inspect` still called running. The
  container's task had died while dockerd kept stale metadata, so the restart policy **never fired**:
  Docker didn't believe anything had exited. Nothing recovered it, no alert distinguished it from a
  healthy idle box, and it stayed down until a human noticed — which is the whole shape of the recurring
  annoyance.
  Restored by removing the zombie and re-running the startup script (the canonical container definition,
  rather than a hand-rebuilt `docker run` that could drift). **The durable fix is a liveness watchdog
  that asks the APPLICATION, not Docker** (`deploy/gcp/startup.sh.tftpl`): a systemd timer curls
  `:8080` every 60s and, after **3 consecutive** failures, force-recreates the container regardless of
  what dockerd believes. Deliberately conservative, because an over-eager watchdog is worse than none —
  consecutive failures only (a blip during a deploy or a GC pause must not trigger it), and at most one
  recovery per 10 min so a genuinely broken image isn't recreated every minute forever. Recovery
  re-runs the startup script rather than duplicating the run command, so the two can't drift apart.
  Verified three ways: the Terraform template renders (`%%{http_code}` and `$${COOLDOWN}` needed
  escaping — `%{` and `${` are template syntax, and an unescaped one would have broken the next deploy
  outright); the timer is active on the box; and the decision logic was exercised against a dead port
  with recovery stubbed — streak 1 → 2 → fires at 3 → clears → cooldown blocks the next — **without
  taking the live app down to test it**.

## v1.5 — Ship-the-wedge: onboarding, fluency & Memory v0  ⛓
The staggered slice — make Skynet **decisively easier than the field** and start the moat thin, in
parallel with v1 hardening. (Rivals make you pre-auth each CLI and learn worktrees/tmux; the ease
features below are white space.)

**UX/UI to SOTA (pre-release review — high &amp; polish):**
- [ ] **Text-contrast ramp** (ink / muted / faint, checked ratios — muted currently sits at the reading floor) + a **systematized button/state token set** (primary / ghost / danger, each with explicit hover · focus-visible · disabled · loading).
- [x] **Agent picker at Start** — added a compact provider/model picker at the Start action, saved as a soft preference that never blocks Start if unmatched, alongside the already-live "which agent is this run on" display.
- [x] **Structured triage card** — triage cards now show a structured effort pill, full-contrast summary, and risks list instead of one muted paragraph, plus a grouped Operate/Configure nav (the Inbox count badge already shipped).
- [x] **Humanized time** — added stale-heartbeat styling so a silently-hung run no longer reads as healthy, an honest empty state for the PLAN panel, and a provider glyph on Home's Runs board.
- [ ] **Design tokens published** (type scale, 8px rhythm, motion behind `prefers-reduced-motion`, one focus ring, semantic palette kept separate from the accent); **a11y pass** (icon-button labels, visible focus, keyboard walkthrough of assign→decide→merge); explicit **Inbox-first mobile/PWA shell**.
  *(Partially landed — investigated each clause independently rather than assuming the bundle was all-or-nothing. **Semantic palette** was already separate from the accent (`--ok`/`--warn`/`--danger`/`--info`/`--violet` are distinct hues from `--accent`, per the comment already in `styles.css`) — no action needed. **Inbox-first mobile/PWA shell** was already fully shipped by an earlier, differently-scoped PR (`20b6e91`): standalone/installed launches open straight to the Inbox queue (`pwa/launch.ts`'s `initialView`), the manifest's shortcuts lead with Inbox, and `styles.responsive.css` already restructures the shell for narrow/touch screens with safe-area insets — verified by reading, not re-done.
    **Type scale, published**: `styles.css` had accrued 25 distinct `font-size` values (a deliberate half-pixel ladder for secondary/tertiary text density — e.g. 11.5/12.5/13.5px are the dominant convention, not drift) with zero naming — every occurrence was a bare px literal. Added a `--fz-*` token per distinct value actually in use and mechanically replaced every literal with its token (byte-identical rendering — a lossless catalog, not a renumbering) across `styles.css` and `styles.responsive.css`. New code now has a discoverable set to draw from instead of inventing another one-off size.
    **One focus ring**: audited every `outline`/`:focus`/`:focus-visible` rule against the existing baseline ring (`button:focus-visible` et al.) and the button/state tokens. Found and fixed one real a11y gap (`.cmdk-input:focus` suppressed the outline with no replacement indicator at all — the command palette's search box had no visible focus cue). Consolidated four near-identical, drifted text-input focus treatments (`.qx-input`, `.settings-input`, `.rp-select`, `.adv-input` — one had silently drifted to a translucent accent border, one dropped the outline for a solid one) onto a single new `--input-focus-border` token, and switched them to `:focus-visible` (a plain `:focus` was re-styling on mouse clicks too, not just keyboard). Removed three redundant per-component `outline`/`outline-offset` overrides (`.md-fold-summary`, `.tg-setup-head`, `.prd-phase-summary`) that only repeated the baseline ring under a different name — they now fall back to the shared rule and keep only their own `border-radius` addition.
    **Motion behind `prefers-reduced-motion`**: three looping "still alive" keyframe animations (`rb-flip`, `rb-stale-pulse`, `sk-shimmer`) predated the convention already established for their siblings (`pulse`, `pvpulse`, `pipe-pulse`, …) and weren't guarded — wrapped their `@keyframes` in `@media (prefers-reduced-motion: no-preference)` per that same existing pattern. Left the width-fill progress-bar transitions (`.bar-fill`, `.fleet-task-fill`, `.pf-progress-fill`) and toggle-switch knob slides alone on purpose — `styles.css`'s own top-of-file comment already carves those out deliberately as informational/discrete-action motion, not ambient decoration, and past owners chose not to suppress them; no reason found to override that call.
    **a11y pass**: icon-button labels were already ~99% done by an earlier "9 icon buttons" pass — found and fixed the one remaining gap (`tweaks.tsx`'s dev-panel `✕` close button, now `aria-label="Close Tweaks panel"`). Keyboard-walked assign → HITL decide → merge end to end: assign (`project.tsx`), the Inbox decide flow (`queue.tsx`/`task.tsx`, including the `j`/`k`/`a`/`r`/`m` shortcut layer), and merge (`merges.tsx`) were all already fully keyboard-operable. Found and fixed two real dead ends on the task-card detail path: (1) `.kb-card-tools`' Edit/Archive/Delete/Move buttons only revealed on `:hover`, so tabbing onto one showed nothing — added a `:focus-within` fallback alongside the existing `:hover` one; (2) the read-only task-detail modal (`project.tsx`, no-run cards) didn't manage focus at all — added focus-on-open (the close button), Escape-to-close, and focus-return to the originating card on close, matching the pattern already used by `confirm.tsx`/`command-palette.tsx` elsewhere in this app. Also deleted `.kb-archive`, dead CSS with no matching `className` anywhere in the app, found while working the same hover-reveal selectors.
    **Not done — 8px spacing rhythm**: deliberately scoped out. Unlike font-size, `padding`/`margin`/`gap` values in `styles.css` are not a latent, already-consistent ladder — the file has ~700+ declarations spanning single-digit odd pixel values up to full-panel widths (400px, 288px, …), many clearly fine-tuned per component (icon/text baseline alignment, badge padding) rather than page-rhythm spacing. A faithful "rhythm" pass means actual design consolidation (choosing canonical steps and remapping every declaration onto them), not just token-naming the existing values — and that carries real visual-regression risk across every screen in the app that a single pass can't safely verify: this sandbox has no working browser (Playwright's Chromium is missing system shared libraries — `libglib-2.0.so.0` — and `apt-get update` is blocked here, so no live visual QA was possible this round; verified instead via a full `pnpm -r typecheck` pass and manual diff review). Left as future, deliberately-scoped work rather than guessed at blind.)*

**Easier to use than anyone else:**
- [x] **Repo-optional / chat-only mode** — added an explicit "no repo — chat only" UI choice and a safety fix so a chat-only run's cwd is a private scratch dir instead of the server's own working directory.
- [x] **Task linter v0 (assistive)** — added a background, dismissible task linter that flags vague/under-scoped tasks (no "done" defined, touches multiple modules) right after creation.
- [ ] **Charter-assisted project creation** — creating a project is a short LLM-drafted intake, not a name
  field: goals, non-goals, risks, constraints, definition of done — operator corrects and approves (the
  Charter). Uses the **user's own key** via the existing secret store (one cheap call; metered). The
  Charter is what the auto dev team (v2 north star) later sizes itself from, and what **auto task/milestone
  proposal** plans against. See [docs/dev-team-blueprint.md](docs/dev-team-blueprint.md) §1.
- [x] **Parallelism nudge** — added a dismissible Home nudge that surfaces when idle runners and a deep eligible backlog suggest scaling up the fleet.
- [x] **Task grouping & per-project roadmap** — added Features (grouping related tasks) and Milestones (planned per-project releases) as a level above the task board, with Steward and Telegram both able to manage them.
- [x] **Per-project agent instructions (house rules)** — added a per-project instructions field that rides every prompt an agent sees on that project, plus a shared context assembler (project goal, feature, and a sibling-run digest) so a fresh agent starts with relevant project/feature/in-flight context.
- [x] **Project Context — meeting notes/emails/docs, condensed into the S2 primer** — the operator can now paste or upload raw context (notes, an email, a doc) on a project's Context tab, which Skynet condenses into a short primer that grounds both an agent's task prompt and "ask about this project" chat.
- [x] **Per-project isolation for credentials & GitHub identity** — a project can now pin its own LLM credential and GitHub PAT, so its runs bill to the right key and its PRs open under the right account regardless of the workspace default. *Bug fix: `Project.enabledRunnerCredentialIds` (the "Keys" panel's checkbox allowlist — confine a project to specific fleet runner keys) was only enforced by the three sites that ACQUIRE a runner for new work (`acquireAgent`/`acquireOrProvisionRunner`/`acquireSpecificAgent` in `apps/server/src/orchestrator.ts`) — a project restricted to one key was still triaged and auto-reviewed on ANY idle runner in the workspace, because `tickAutonomy`'s triage/periodic-review picks, `requestReview` (manual "Request review"), and `verifyFeatureBeforeShip` (feature-level deep review) each filtered `listAgents` by `status === "idle"` alone, never against the project's allowlist. Root-caused via `keyAllowedForProject`, a single shared helper now used by all seven picking sites (the 3 correct ones refactored onto it too, so a future picking site can't silently reintroduce the gap); a project with no allowed idle runner right now simply skips that tick's triage/review rather than falling back to a disallowed key. Regression-proofed in `tests/project-runner-keys.test.ts` (triage / periodic auto-review / manual request-review, each with the disallowed-key runner as the ONLY idle one) and `tests/feature-verification.test.ts` (feature-level verification correctly skips a disallowed-key idle agent even when it's earlier in store order than the allowed one).*
- [~] **Project assistant → co-operator (actions from chat)** — the repo-aware project chat (read-only, *shipped*: answers about status + reads repo files like ROADMAP.md) gains the ability to *act* — create a task, start a run, move a card, add a runner — via the same **reply-plus-action envelope** the Telegram intent already uses (`telegram/intent.ts`): the model proposes one action, but it's **validated server-side and gated by the control-flag / a HITL**, never model-trusted. Turns the advisor into a co-operator without a second natural-language surface to maintain. *Steward (the shared brain, `apps/server/src/steward/`) has landed with: 15+ project + task actions (add/move/rename/desc/archive/reorder/schedule/etc.), workspace-wide focus resolution, streaming replies, dock focus-pinning, and **batch actions** — one input can propose up to N actions approved together (an "action budget" with overflow reporting). Grouping/roadmap actions (features + milestones, see below) share the same envelope. Still to do: broader coverage (fleet ops, credentials) + Telegram parity on the newer actions.* Also landed: the Roadmap tab's "reads ROADMAP.md" lookup used to dead-end when a repo kept its plan somewhere else — `Project.roadmapPath` now lets the operator (a picker on the tab's empty state) or Steward (`set_roadmap_path`, confirm-first, e.g. "the roadmap is at docs/PLAN.md") point it at any repo-relative file; `resolveRoadmapDoc` is the single place both the tab's API and Steward's own grounding resolve through, so they can't drift.
- [~] **Chat → canvas handoff, zero cold start** — the reply-vs-action decision above gets a third
  lane: when a request is better SHOWN than said (review a diff, browse the board, tune the fleet), the
  reply carries a **deep link straight into the exact web-app view** — project/task pre-focused —
  instead of trying to cram it into a chat bubble. The link mechanism already exists and is already
  sent from Telegram today — `runLink()` → `PUBLIC_URL` + `#/agent/<runId>`
  (`apps/server/src/telegram/notices.ts`) — and the hash router already handles `#/project/<id>`
  (`apps/web/src/lib/routing.ts`). What's missing is **zero cold start**: today the link only lands
  cleanly if the browser tab is already signed in — click it fresh and you hit the login wall, which
  defeats the point. Two paths, matched to how each release is actually reached, not one generic
  scheme: **desktop (the committed release)** registers a `skynet://` OS protocol handler — no token
  at all, since the app is already running locally as the single operator and the OS just routes the
  click to it; **hosted/GCP (`public_ui`, 🏢 deferred)** is the one case that actually needs a
  signed-token flow — mint a short-lived, single-use exchange token per link that the app consumes on
  load to establish a normal session. Chat stays the command line, the web app stays the one canvas —
  the link is the bridge, not a second interface to maintain. *(**Desktop half shipped:**
  `app.setAsDefaultProtocolClient("skynet")` (`apps/desktop/main.cjs`), handling both delivery
  mechanisms — macOS's `open-url` app event, and Windows/Linux's argv-based `second-instance` forward
  (warm) / `process.argv` (cold launch, captured before `app.whenReady()`). A received
  `skynet://agent/<runId>` translates onto the *existing* hash route verbatim (`apps/desktop/
  deep-link.cjs`'s `skynetUrlToHash` — pure, unit-tested) and either navigates the already-loaded
  window in place (`location.hash`, no reload) or rides into the initial `loadURL` on a cold launch.
  `runLink()`'s counterpart `desktopRunLink(runId)` emits the `skynet://` form instead of
  `PUBLIC_URL#/...` whenever `config.desktop` is set (`apps/server/src/telegram/index.ts`'s
  `linkFor`) — the existing desktop flag (`SKYNET_DESKTOP=1`, already set by main.cjs), not a new one.
  **Hosted/GCP signed-token-exchange path is still 🏢 deferred, untouched.**)* *(Prompted by an outside SOTA-routing
  pitch — "transport vs. generation," deep links that "hydrate state" instead of forcing a re-login.
  The underlying idea is sound and is genuinely missing; the "agent renders a whole spatial PWA on the
  fly" framing isn't — see the AG-UI note in Considerations for why we're not chasing that part.)*
- [~] **Operator ergonomics (P3 of [docs/ux-review.md](docs/ux-review.md)):** **⌘K command palette**
  (navigation + verbs: assign, approve latest gate, open project) · **keyboard-first Inbox**
  (j/k navigate, a/r/m approve/reject/modify, ↵ opens the run — `QueueView.selectedIdx` already
  exists; finish it + a visible shortcut bar) · **OS notifications + dock badge** on new gates
  (Electron; waiting-minutes are the product's core currency) · **Timeline lens depth** (zoom,
  brush, click-through) · **cost/usage roll-ups** (per-project header + per-runner in Fleet —
  pre-figures the team blueprint's budgets). *Landed: the **⌘K command palette** (`CommandPalette`,
  ⌘K/Ctrl+K) — fuzzy-navigate to a view or project, or approve the most recent pending HITL gate —
  and the **keyboard-first Inbox** — `QueueView.selectedIdx` now actually wired (j/k navigate, ↵
  opens the run, a/r/m approve/reject/modify calling the same `store.resolveHitl` the card buttons
  use), plus a dismissible shortcut hint bar. Both skip their shortcuts while the operator is typing
  in a text field. **Cost/usage roll-ups** — one tested `computeUsageRollup` (`lib/derive.ts`),
  grouped by project and by agent, `costUsd`/`durationMs` staying `null` (not 0) when nothing in the
  group reported one; wired into the project header (replacing an ad hoc duplicate), new per-runner
  badges on each Fleet card, and agent-detail's existing total fixed to distinguish "$0" from
  "vendor doesn't report" instead of just hiding at 0. **OS notifications + dock badge** — the
  notification-on-new-gate path (`notifyInbox`, gated behind an explicit Settings toggle) already
  existed and needed no new code; what shipped is the Electron plumbing it was missing: a
  `contextBridge` preload + IPC bridge for the dock/taskbar badge (live pending-HITL count) and
  window focus/restore on notification click, plus a pre-existing `runId`/`agentId` field-name
  mismatch in the service worker that silently broke deep-linking a click to the specific gate.
  Still to do: **Timeline lens depth** (zoom, brush, click-through) — unverified/unscoped.*

**Memory v0 (thin moat, pulled forward from v4):**
- [ ] Operator-authored + **decision-derived** facts (every `hitl_audit` "decided X because Y" becomes a memory
  fact), scoped (workspace / project / area / agent), injected into any vendor via the `runner-sdk` seam, and
  **exportable/owned** (git-committable). No LLM distillation yet (that's v4) — but it makes launch
  not-just-another-orchestrator and starts the corpus compounding on day one.

**⭐ Cross-vendor consensus runs (signature bet):**
- [ ] Fire the same task at Claude + Codex + Gemini in parallel, auto-diff the results, keep/merge the winner, or
  have them peer-review each other. Needs the multi-provider runners from v1; the vendor-neutral seam is what
  makes true cross-*vendor* bake-offs possible (rivals' "councils" are single-tool).

## v2 — Agentic area-managers (the hierarchy)  🔬🔗⛓
Per-project LLM **area managers** decompose an area's goal and spawn first-class **worker subagents**
via a `spawn_worker` tool; risk-based escalation; worker→manager→project merge.
[docs/agent-hierarchy.md](docs/agent-hierarchy.md)
- [ ] 🔬 The decomposition is **LLM planning** — Skynet supplies the area goal + module map + the
  `spawn_worker` tool, surfaces a `plan` HITL, and spawns workers on approval. The model does the "how."
- [ ] **Managers organize by area *or* role** — same mechanism, different scope: a "Billing manager"
  (module area) or a "Review / QA / Security manager" (function). Role-managers are how specialized
  agents are arranged; workers under them inherit the role's prompt + tool scope.
- [ ] **Agent-to-agent handoff on feature completion** — when a Feature (v1.5 grouping) reaches
  `shipped`, or a milestone flips to `shipped`, the orchestrator fans out to configured **role-agents**:
  a **change-manager** commits the CHANGELOG.md entry (agent-authored, HITL-gated diff — same
  governance as any run's diff review); a **docs-writer** updates the user-facing docs from the
  feature's task descriptions + diff; a **release-comms** agent drafts the Slack/Telegram/email
  announcement. Each handoff is a directed variant of `mass-inform` (v1) — a fresh scoped brief,
  no extra human keystroke, still gated end-to-end. **Reuses**: Steward's action envelope (validated
  ids, confirm-first) as the write path; the existing HITL Inbox as the routing target (extend an
  item's addressee from "any operator with approver scope" to a specific role-agent); the Feature +
  Milestone entities as the trigger. **The joinpoint is already there** — `feature.upserted` with
  `status:"shipped"` and `milestone.upserted` with `status:"shipped"` are events the fleet can
  subscribe to today. The v2 work is turning them into a first-class fan-out primitive with a
  configurable role-agent map per project (which agents run on which completion event).
- [ ] **⭐ North star: the auto dev team.** The endgame of the hierarchy is **Charter → Blueprint →
  Plan**: project intake is an LLM-assisted **Charter** (goals, non-goals, risks, done-definition —
  human-approved, G-1); from it Skynet proposes a **Team Blueprint** (Chief of Staff, Spec Analyst,
  Architect, Area Leads, Developers, QA, Security, Scribe, Memory Curator) sized to the project and
  hired with **one human approval (G0)**; the CoS then **auto-proposes the initial plan** — epics →
  milestones → tasks with dependency order and honest estimate ranges (calibrated by retro actuals,
  never fabricated deadlines). Work runs through a gated pipeline (spec → plan → build → verify →
  review → secure → merge → document → learn) where the blueprint may delegate *who holds* a gate but
  never remove one, and **nothing self-approves**. **All of it BYOK** — intake, planning, and every
  role resolve the user's own keys via the existing secret store, metered under the project budget.
  The concrete v1 path here is **🔬⭐ Autonomous backlog sweep** (above): budget-gated unattended
  building, verify-and-break review, and a self-replenishing backlog are exactly the "run a whole
  session without drifting or overspending" primitives this endgame needs.
  Full sketch: [docs/dev-team-blueprint.md](docs/dev-team-blueprint.md) (phased: Charter rides v1.5 ·
  CoS+Leads+QA ride v2 · Security/Spec/Scribe ride v1 governance + v3 triggers · Curator/retro ride v4/v5).
- **🔗 Product steward & the living Plan** — the concrete substrate under the north star: a
  first-class, **versioned Plan entity** (the durable roadmap the steward maintains — the proper
  replacement for the AI's throwaway `ROADMAP.md`/`PLAN.md` scratch files in the repo) plus a
  **persistent, project-scoped steward conversation** so the operator runs the whole build by
  talking to one agent and only making decisions, feeding new input as they go. The steward drives
  Skynet's own MCP `author` tools + an `edit_plan` tool (wrap, don't rebuild); commitments stay HITL.
  Phase 1 (the Plan entity + a project-view panel) is independently useful and can ride **v1.5**
  alongside Charter-assisted creation. See [docs/product-steward.md](docs/product-steward.md).

## v3 — Triggers & integrations (inbound work)  🔗
Turn Skynet from "I assign tasks" into "work flows in from my stack, human-gated." Every integration
uses the **user's own accounts** (their Sentry, GitHub, LLM key) — Skynet is the connective +
supervision layer, it doesn't host or resell those services.
- [x] **The enabling primitive:** an **inbound-trigger** concept — a webhook/event creates a task or agent
  in a workspace. Today the only trigger is "operator assigns a task"; this one primitive unlocks the
  whole category. (Cheap to design early so we don't foreclose it; build here.) Added a GitHub issues webhook, the first concrete instance, that creates a linked task the moment an issue is opened, reopened, or labeled.
- [ ] **Tools via MCP:** an agent gets scoped tools (GitHub / Sentry / Slack MCP) to act back into the
  user's services. A "Sentry agent" = a coding agent + Sentry MCP + a Sentry webhook trigger.
- [x] **Skynet *as* an MCP server (shipped):** the reverse direction — Skynet exposes its own surface
  (projects/tasks/fleet/agents/HITL) as MCP tools so an agent can drive the fleet, incl. a headless
  bootstrap token for sandbox deploys (e.g. Daytona). See [docs/mcp.md](docs/mcp.md). Also fixed list tools to return paginated summaries instead of full records, which had made them unusable at scale.
- [ ] **Feedback-loop responders (route back to the *originating* run)** — a CI failure, a PR review comment, or a
  merge conflict re-engages the **same** agent that produced the branch (self-healing), not a fresh run.
  *(Agent Orchestrator-style; ties directly to the responders below.)*
- [ ] **Interop surface (adopted)** — beyond `/mcp`, expose the fleet via an **OpenAI-compatible endpoint + REST**
  so external tools can drive it as a model/service. *(claw-orchestrator-style; broadens who can call Skynet.)*
- [x] **⭐ GitHub Issues ↔ tasks (two-way sync).** GitHub issues now sync both ways: importing or a webhook creates a linked task worked through the normal loop, and the task's kanban stage and PR post back to the issue as a status label and a "Closes #n" link.
- [ ] **Candidate responders:** Sentry regression → fix PR · GitHub issue → PR · PR review · CI-failure
  fix · Dependabot/CVE patch+fix · PagerDuty/Datadog incident triage · support ticket → bug task.
- [ ] Tier-2 API agents (Devin, Jules — see runner-catalog) plug in here as delegated remote workers.

## v4 — Moat Layer: Portable cross-vendor memory (M1)  🔗
User-owned memory that no single vendor can match, because everything streams through Skynet.
[docs/positioning.md](docs/positioning.md) §3.2
- [ ] Cross-vendor, long-lived, **portable/exportable**, scoped (workspace / project / area / family).
- [ ] **Manage repo-native memory too:** read/write/sync **`CLAUDE.md`, `.cursor/rules`, Copilot
  instructions, etc.**, and project Skynet's portable memory into each vendor's native format.
- [ ] Injection via the vendor-agnostic `runner-sdk`; sourced from the streams + `hitl_audit` already
  flowing through the `hub`.
- [x] **⭐ Open the format — openness is the second moat.** Published a versioned, human-readable, git-committable open memory spec (`docs/memory-format.md`) so Skynet's memory is a substrate, not a locked-in silo.
- [x] **⭐ Memory as an MCP server** — published the memory spec's markdown file format (`docs/memory-format.md` v0.1, format-only); the MCP read/write server itself remains a separate, not-yet-built item below.
- [ ] **⭐ Memory as an MCP server** — expose the brain over MCP so **any** agent or tool can read/write it, even
  ones never run through Skynet. Your context follows you everywhere; rides the shipped `/mcp` surface.
  *Landed (thin v0): four new MCP tools — `list_memory`/`add_memory`/`delete_memory`/`refresh_memory` — put
  a project's memory (`ProjectContextEntry`, condensed into `Project.contextSummary`, the primer every
  agent's prompt already reads via `agent-context.ts`) on the wire for any MCP client, scoped/gated exactly
  like every other project-bearing tool (see [docs/mcp.md](docs/mcp.md)). Wired to TODAY's store, not the
  richer open, git-committable format above (`.skynet/memory/`) — that lands underneath this same tool
  contract once it ships, no client-facing change needed.*
- [ ] **Open-core split** — the *format + read/write MCP* are free/open (drive ubiquity); *distillation
  intelligence, cross-vendor translation quality, hosted sync, team sharing, and governance* are the paid layer.
- [ ] 🔬 **LLM-assisted distillation** of good memory from history — open research; start with
  operator-authored + decision-derived facts, add a Skynet-side curating LLM later. Spike writeup
  (pipeline shape, guardrails against a fabricating/over-generalizing corpus, eval approach, phasing):
  [docs/memory-distillation.md](docs/memory-distillation.md).

## v5 — Moat Layer: Agent fluency (M2)  🔬🔗
Help users run **more agents with clearer tasks** — the flywheel (better results + more usage).
[docs/positioning.md](docs/positioning.md) §3.3
- [ ] **Task linter** (split/clarify suggestions) + **parallelism nudges** — *the assistive v0 ships early in
  v1.5*; v5 is the LLM-based coach on top.
- [ ] **⭐ Provably-improving fleet (signature bet)** — the **outcome feedback loop**: measure which memory facts
  + task phrasings one-shot cleanly vs. churn through HITL, auto-promote the winners, and **show the user the
  curve** ("your fleet is measurably better this month"). Nobody in the field measures outcomes; it makes the
  moat visible and compounds with v4.
- [ ] 🔬 The coach is **LLM-based** (critiques tasks, proposes decompositions); open research on UX + quality.
- [ ] Compounds with v4 — the coach learns from the workspace's own memory/history.

## v6 — Vendor migration
Help a user **move from one vendor to another** (Claude ↔ Codex ↔ Gemini …): carry over the
vendor-neutral memory, translate config/rules, and re-home in-flight work — leveraging the portable
memory (v4) + thin runner adapters.

---

## Considerations / open questions (decide later)
- **Vendor agent SDK adoption** — Claude uses `@anthropic-ai/claude-agent-sdk` (in-process, no
  subprocess boundary, no PATH probe). Every other provider we ship (codex / gemini / cursor /
  copilot / hermes) is a **CLI runner** because that's the surface the vendor exposes today.
  **Watch for**: an official OpenAI Codex agent SDK, a Google Gemini agent SDK, a Cursor agent
  SDK, or equivalents. If/when one lands, swap that provider's runner from CLI-subprocess to
  in-process SDK — a purely additive change (the `runtime: "sdk" | "cli"` field on
  `ProviderRequirements` already represents both). Faster, no PATH dependency, no shell env
  weirdness. Waiting on the vendor, not building.
- 🔬 **LLMs for memory distillation (v4) and the fluency coach (v5)** — both likely require an LLM;
  decide model / cost / UX. (Flagged by design, not avoidance.)
- **Generative-UI streaming protocols (AG-UI and similar)** — the pitch is standardizing how an agent
  streams UI events (tool-call-start, state-delta) to a client instead of hand-rolling the wiring every
  time. We already hand-roll this twice, on purpose: Steward's `{"proposeActions":[...]}` envelope
  (`apps/server/src/steward/assistant.ts`) and the bespoke inline renderers it drives (`DiffView`,
  `RoadmapDocView`). **Watch for**: a standard that earns real *multi-vendor* adoption, same posture as
  the vendor-SDK entry above — this isn't that yet (single-vendor-pushed, pre-adoption). The
  validate-then-confirm trust boundary (nothing model-trusted, every id re-checked server-side before
  a chip even renders) is the part that actually matters and stays regardless of transport; swapping
  the wire format later is a no-op to that boundary. Not chasing this now — "wrap, don't rebuild" cuts
  against adopting a nascent protocol for a problem our envelope already solves.
- **Cross-repo / multi-repo atomic changes** — a coordinated change spanning several repos. A gap **no
  local tool** fills today (cloud-only: Oz/Devin); a bigger future bet, flagged so we don't foreclose it.
- **No-telemetry / keys-never-leave-host guarantee** — make the local-first privacy stance an *explicit,
  stated* guarantee (already true for the desktop build; competitors like Octomux market it as a headline).
- **Distribution:** hosted (our GCP) vs. self-host (`docker compose`) vs. **BYO-runner** (containers on
  the customer's infra, only the UI hosted) for code-privacy.
- **Retention/policy** for logs, audit, and memory.
- **Steward-mediated agent questions** — today an agent's mid-run clarifying question
  (Claude's `AskUserQuestion`, etc.) raises a `question`-kind HITL that goes straight to the
  operator's Inbox + a Telegram notice (`telegram/notices.ts`), answered directly by a human —
  there's no relay through Steward. Idea: let Steward (`apps/server/src/steward/assistant.ts`,
  already repo/project-grounded) see the question first and attempt an answer itself when it's
  confident, falling back to the human (same Inbox/Telegram path as today) only when it isn't —
  so routine "which file/convention should I use" questions don't all need a human, while
  anything Steward can't ground stays a real human decision. Would reuse the existing
  confirm-first discipline (nothing model-trusted) rather than let Steward silently resolve a
  HITL on its own authority.

## Parked / explicitly out
- **Building our own coding agent** — never. Wrap, don't rebuild ([docs/positioning.md](docs/positioning.md)).
- **In-process agent loops built on model-only SDKs** (e.g. an OpenAI / Google
  Gemini raw-model wrapper that Skynet drives as if it were the agent) — never.
  Model SDKs give a message endpoint; the vendor's coding agent — planning,
  tools, editing, permission gates — is what actually does the work. Rolling
  our own on top of a raw-model SDK to get "in-process everywhere" would be
  the same "build our own coding agent" trap, just spelled differently.
  In-process runs come from **vendor agent SDKs** (Claude today; watch-list
  above) or not at all.
