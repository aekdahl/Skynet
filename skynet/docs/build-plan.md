# Skynet — Build Plan

**Date:** 2026-09-13 · **Follows:** [recovery-review.md](recovery-review.md) · **Basis:** `origin/main` @ `4c7ac1b`
**Scope note:** hardening (branch protection, CI gating, credentials, auth) is deliberately excluded and
handled in a later pass. Two items from that list live here anyway because the loop does not work without
them: the completion-callback handlers (Phase 1) and the supervised default autonomy level (Phase 3).

> Four phases that turn the existing pieces into an autonomous builder with two guaranteed capabilities:
> **an operator adds a task and Skynet performs it to a merged, verified diff**, and **Skynet reasons about a
> solution with the operator and turns it into a dependency-ordered set of tasks it then performs.**
> Phases 1–3 make it autonomous and trustworthy. Phase 4 makes it expert.

Legend for every item: **exists** (wired end to end, keep and harden) · **partial** (code exists, not
connected or not gated) · **new** (to build).

---

## 1. What we are building

Four layers. Each exists as thin code; the work is connecting them so a decision at the top becomes a
verified commit at the bottom without a human carrying it between layers.

| Layer | Job | What exists today |
|---|---|---|
| **Reasoning** | Understand goal + codebase, weigh options, decide an approach with acceptance criteria | `SolutionBrief` (`problem`, `approach`, `optionsConsidered`, `risks`, `acceptanceCriteria`, `openQuestions`, `exploration`); Steward `crystallizeBrief` from a conversation; `exploreBrief` read-only agent run over the repo; `draft-charter`; `Plan` (versioned markdown). `contracts.ts:1304-1340` · `operations.ts:3205, 3452` · `steward/crystallize.ts` |
| **Planning** | Turn an approved approach into one-shot-sized tasks with dependencies, criteria, grouping | `decomposeBrief` emits tasks with `text`, `description`, `acceptanceCriteria`, `effort`, `dependsOnIndex` under a `Feature`; `Task.dependsOnTaskIds/featureId/milestoneId`; task linter (vague, multi-module, no-done-definition); replenishment proposes ≤5 next tasks. `decompose.ts:71-81` · `task-linter.ts:36` · `steward/replenish.ts` |
| **Execution** | Isolated worktree → commit → review → merge to base with checks | The kernel: assign → acquire → worktree → run → complete → diff HITL → deliver → merge queue → checks. Triage promotes clear tasks; auto-pick starts `autoPick` tasks; `drive.ts` diagnoses why a project is stuck. `orchestrator.ts:2451, 1255, 3152` · `merge.ts:284` |
| **Verification & learning** | Prove the result meets its criteria; learn; feed the next run | Deep review reads the linked brief's criteria; zero-diff against criteria is flagged; `verifyFeatureBeforeShip`; memory v0 facts injected. Nothing turns outcomes into facts or verifies criteria as a gate. `orchestrator.ts:6911, 1339-1354, 4411` |

**Definition of done for this plan.** Both flows run on a real repository with a real agent, from the UI and
from Steward, ending with a verified commit on the base branch: ten consecutive tasks through Flow A and two
complete briefs through Flow B, with every gate's outcome recorded.

---

## 2. Flow A — add a task, perform it

| # | Who | Step | Detail |
|---|---|---|---|
| 1 | operator / Steward | Task created in `backlog` | **exists** `POST /api/projects/:id/tasks`, Steward `add_task`. **new** `Task.acceptanceCriteria: string[]`, drafted by the linter when the operator wrote none, editable inline. |
| 2 | Skynet | Triage: clear enough to start? | **exists** `triageOne` writes assessment, effort, clarity; clear → `todo`, unclear → one clarifying question with a loop breaker. **partial** triage requires criteria (drafts them, never silently promotes). **new** triage sets `autoPick` per the project's autonomy level. |
| 3 | Skynet | Pickup when ready | **exists** autonomy tick starts one `autoPick` task per pass; Steward `start_task`, `queue_tasks`, `process_backlog`. **new** dependency-aware pickup (all `dependsOnTaskIds` done) and the unused `queuedWipLimit` respected. |
| 4 | agent | Work in an isolated worktree | **exists** `spawnRunForTask` → `provision` on `agent/<run>` from `origin/<base>`; linked brief's approach + criteria already in the prompt. **new** the task's own criteria and memory facts always go in, brief or no brief. |
| 5 | Skynet | Completion that means something | **partial** `complete()` commits a dirty tree and diffs. **new** always diff branch vs base regardless of who committed; zero diff / no-result stream / clean tree → *needs attention*, never *done*. |
| 6 | verifier | Verify against criteria before anyone reads the diff | **new** bounded step: run `checkCmd` in the worktree, then a review agent judges each criterion against diff + test output → structured per-criterion verdict. Failing criteria go back to the same run as a message, up to two rounds. Only then the diff HITL opens, verdict attached. |
| 7 | operator / policy | Diff review | **exists** `raiseDiffReview`, Inbox actions, `approve-with-rule`, auto-review under autonomy. **partial** the two draft consults become best-effort with a hard timeout. **new** verdict shown above the diff; a fully green verdict is what full autonomy may auto-approve. |
| 8 | Skynet | Merge to base, checks run | **partial** `MergeEngine` merges into `skynet/integration/<pid>` and runs `checkCmd`. **new** after checks pass, fast-forward base (local) or open the PR and hold `review` until it merges (GitHub); `checkCmd` in both modes; *done* only when the commit is on base. |
| 9 | Skynet | Record and learn | **partial** transitions and resolutions persisted. **new** one `TaskOutcome` per task: rounds, verdicts, review action, time to merge, cost. Feeds zero-touch merge rate and Phase 4. |

---

## 3. Flow B — reason about a solution, then build it

| # | Who | Step | Detail |
|---|---|---|---|
| 1 | operator | States a goal in Steward | **exists** dock on every page, project focus resolved from the conversation. **new** Steward recognizes a goal larger than a task and offers to *work it up*; new action `propose_brief`. |
| 2 | Steward | Explore the codebase first | **exists** `exploreBrief` fills `exploration.findings` and `touchpoints`. **partial** make it the first thing Steward does when a goal arrives; charter + memory facts in the exploration prompt. |
| 3 | Steward + operator | Reason about options, converge | **exists** `crystallizeBrief` drafts problem / approach / options / risks / criteria / open questions. **new** run as a loop: open questions become questions to the operator; each answer re-crystallizes; the draft brief is visible and editable beside the conversation. |
| 4 | operator | Approve the brief | **exists** `draft → approved`, `approvedBy`. **new** approval requires ≥1 criterion and no unanswered *blocking* question. This is the human decision that authorizes spend. |
| 5 | Skynet | Decompose into tasks | **exists** `decomposeBrief` (criteria, effort, `dependsOnIndex`, grouped under a `Feature`). **new** approval triggers decomposition; size rules (effort cap → split; every task has criteria; acyclic deps; same-touchpoint tasks ordered, not parallel); one plan confirmation; tasks created with `dependsOnTaskIds`, `featureId`, `briefId`; `brief.status → building`. |
| 6 | Skynet | Update the Plan | **exists** versioned markdown `Plan`. **new** Steward appends the feature, tasks and order on decomposition and updates as tasks finish. Entities are truth; the Plan is the narrative. |
| 7 | Skynet | Perform the tasks | **exists** Flow A per task; Steward `start_feature`. **new** dependency-aware ordering; `drive.ts` states become Steward messages, not badges. |
| 8 | verifier | Verify the feature, not just the tasks | **partial** `verifyFeatureBeforeShip`. **new** when the last task merges, run the brief's criteria against base as a whole (same verifier, feature scope). Pass → `brief.status → done`, feature shipped, Plan updated. Fail → a new task decomposed from the failing criteria, linked to the brief, Flow A again. |
| 9 | operator | Reads one message | **new** "Usage-based billing shipped: 7 tasks, 2 needed a second round, 1 review, criteria 6/6." |

Steps 1–4 stand alone: an operator can think through a problem with Steward and keep the brief as a
decision record without approving it. That is where the memory moat's best raw material comes from.

---

## 4. Data model changes (additive)

| Entity | Change | Why |
|---|---|---|
| `Task` | **new** `acceptanceCriteria: string[]`, `verification: { round, verdicts[] } \| null`, `briefId` | Criteria on the task so Flow A works without a brief; the verifier writes where the HITL and task page can show it |
| `TaskOutcome` | **new** one record per finished task: rounds, verdicts, review action, wall time, cost, runner | Raw material for zero-touch merge rate, per-area one-shot rate, runner routing |
| `SolutionBrief` | **partial** `openQuestions[].blocking`; `taskIds` computed from tasks' `briefId` | Approval rules; brief page shows its tasks |
| `Project` | **new** `autonomyLevel: "supervised" \| "gated" \| "full"` as the operator-facing control (existing fields stay as implementation) | One dial the operator understands and Phase 3 raises |
| `Run`, `HitlItem` | **new** `version` with the same compare-and-set `Task` has | The task-write race exists on runs and gates too |
| Orchestrator state | **new** persist `reviews`, `mergeApprovals`, merge queue, id sequence (or ULIDs) | A restart must lose nothing decided or committed |

---

## 5. Phases

### Phase 1 — one honest loop (2–3 weeks)
**Exit:** Flow A steps 1–5 and 7–8 run on a real repo with Claude; ten consecutive tasks land on base with
checks; a scripted run through the real server proves it daily.

Close the kernel defects (refs are to the review's defect list):
- **new** Finish the merge: fast-forward base after checks (local); GitHub runs `checkCmd` and holds `review`
  until the PR merges. *Done* = on base. `merge.ts:265-371` · `orchestrator.ts:3214-3225, 4574-4576`
- **new** Honest completion: always `diffStat` vs base; zero-diff / no-result / clean tree → needs attention;
  register the live handle before `provider.start`. `orchestrator.ts:1256-1385, 2675` · `claude.ts:1980`
- **new** No credential → `onFailed`, free the runner. `claude.ts:1557-1566`
- **new** Deliver, then persist the resolution (or persist pending + retry). `operations.ts:917-921`
- **new** Survive a restart: persist review and merge-queue state; no id reuse; never delete a branch with
  commits not on base. `orchestrator.ts:722-802, 2547` · `worktrees.ts:193-195`
- **new** `.catch` on the three completion callbacks + a process-level rejection handler that marks the run
  failed. `orchestrator.ts:1034-1036`
- **new** Timeouts on the gate's two draft consults. `orchestrator.ts:1573-1576`
- **new** Autonomy errors to a project-level log shown on the project page. `orchestrator.ts:6062`

Make it runnable by anyone:
- **new** A deterministic demo runner in `runner-sdk` (edits a file, optionally raises one gate, completes),
  selectable in Fleet.
- **new** The boot test: real server via `index.ts` + demo runner, temp repo, add task over HTTP, approve,
  assert the file is on base (`tests/interop.test.ts` is most of the way there).
- **partial** Run the evals weekly with a key; record pass rate.

Task criteria, first slice:
- **new** `Task.acceptanceCriteria`; linter drafts when missing; criteria go into every agent brief; the
  zero-diff guard uses them.

### Phase 2 — cut to the kernel (2–3 weeks, partly parallel)
**Exit:** a new operator reaches a merged diff from a fresh install without docs; both flows reachable from
the UI and from Steward in the same words; orchestrator < 3,000 lines.

Server:
- **new** Split `orchestrator.ts` along the kernel boundary (assign/spawn, complete/fail, diff gate,
  integrate/deliver, merge gates, janitors). Bake-offs, hierarchy, feature batching, GitHub PR management,
  chat, deep/auto review, budget, drive states become hub-event subscribers.
- **new** Extensions registry, off unless configured: Telegram, live preview, Fly, MCP interop, Sentry, seven of
  nine runner adapters.
- **partial** Steward's action set becomes the two flows: keep `add_task`, `start_task`, `queue_tasks`,
  `start_feature`, `resolve_hitl`; add `propose_brief`, `approve_brief`, `decompose_brief`; retire fleet-ops
  and credential actions from the conversation for now.
- **new** Per-row snapshot parsing; one store-mutation helper that surfaces every error.

Web:
- **new** Five nav items: Projects, Inbox, Fleet, Ready to merge, Settings. One inbox, one board (six-column
  kanban), one task page. Settings gets tabs.
- **new** Project page = Board, Briefs, Plan, Activity, Settings. Briefs is Flow B's home (conversation, live
  draft, its tasks and status). The other lenses go behind the boundary or are deleted.
- **new** First run in three steps: connect a repo → add an agent (or demo runner) → write the first task.
  Home shows last merged work and what needs you.
- **new** Task card shows criteria and verifier verdict; diff review shows the verdict above the diff.

### Phase 3 — autonomy that earns itself (3 weeks)
**Exit:** two complete briefs go goal → shipped feature through Flow B on a real repo; zero-touch merge rate
recorded and shown; a project reaches "full" by earning it.

- **new** The verifier step (Flow A #6): `checkCmd` + per-criterion verdict, two bounded rounds, verdict on the
  HITL; feature-level verification on a brief's last merge.
- **new** Approval triggers decomposition with size rules, dependency ordering, touchpoint conflicts; one
  confirmation; tasks linked; Plan updated.
- **new** Explore-first Steward; brief drafts and re-drafts beside the conversation; open questions become
  questions.
- **new** Dependency-aware, WIP-limited pickup; triage sets `autoPick` per autonomy level.
- **new** The autonomy dial: start *supervised*; after N verified zero-touch merges Skynet offers *gated*
  (only red verdicts or risky commands gate), then *full* (green verdicts auto-merge). The offer is a
  Steward message; the operator raises it; a red streak lowers it (circuit breaker exists).
- **new** `drive.ts` states → Steward messages with the one thing to do; `empty` offers replenishment
  proposals for one-click approval.
- **new** Zero-touch merge rate from `TaskOutcome`, per project per week, on Home and the project page.
- **partial** Memory facts from decisions: approved briefs, rejected diffs with reasons, answered
  clarifications → facts → next exploration and agent brief.

### Phase 4 — expert (ongoing after Phase 3)
**Exit:** one-shot rate and zero-touch merge rate rise over four weeks on the same repos without operators
changing how they write tasks; runner routing chosen by track record.

Skynet's levers for quality are context, decomposition, verification and learning, not the model.
- **new** Understanding as a gate: no pickup without a repo-grounded brief (touchpoints, charter
  constraints, memory facts, criteria); linter blocks *vague* and *no-done-definition*.
- **new** Verification beyond tests: the verifier writes missing tests for criteria that have none; deep
  review mandatory when touchpoints include declared sensitive areas; evals as a weekly per-project quality
  score.
- **new** Learning from outcomes: per-area one-shot rate shown to the operator; automatic memory facts from
  repeated verifier failures; decomposition rules tuned by what size one-shots in this repo.
- **new** Decomposition that knows the codebase: per-repo effort cap and touchpoint ordering; cross-feature
  touchpoint conflicts sequenced by the planner, not the merge queue.
- **new** Two runners, verified, routed: Claude + one CLI vendor with protocol fixtures from real output;
  per-area track record picks the runner.
- **partial** Roles as prompts, not agents: the dev-team blueprint's roles become verified prompt + tool-scope
  profiles on the same runner, used by decomposition when criteria call for one.

---

## 6. Will this be the expert builder?

- **After Phase 1** a task reliably becomes a verified commit on base, and failure always looks like failure.
- **After Phase 2** a new operator does Flow A in five minutes and finds Flow B without being told.
- **After Phase 3** the operator states goals and makes decisions; Skynet reasons, plans, builds, verifies,
  reports, and raises its own autonomy only by earning it. That is the autonomous builder the docs describe
  and never named.
- **Phase 4** makes it expert the way an expert team is: it understands before it acts, verifies against
  intent not just tests, learns what works in this codebase, and routes work to whoever does it best. Its
  ceiling is the underlying agent plus the context Skynet gives it. Skynet does not make the model smarter;
  it makes the model consistently as good as it can be, and it compounds.

What is still missing after Phase 4 is judgment about *what* to build. Flow B reasons about how to solve a
stated problem; it does not decide the roadmap. That stays human, on purpose.
