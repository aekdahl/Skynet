# Skynet — Shipped Roadmap Archive

Every `[x]` item retired out of [ROADMAP.md](ROADMAP.md), condensed to ~1 sentence each and grouped
under the version heading it shipped under. This is a historical record, not a spec — for current
scope and open work, see the live roadmap. TASK/Phase/PR references are kept where the original entry
named one, for traceability back through git history.

---

## v0 — MVP · the local desktop app

1. **Live Claude execution** — drove Claude Code via the Agent SDK/CLI; fixed headless auth by scrubbing conflicting `CLAUDE_CODE_*`/gateway env.
2. **Worktree-per-runner provisioning** — each agent runs in an isolated git worktree/branch.
3. **Repo connection + `.skynet/modules.json`** — a workspace points at a real repo + integration branch.
4. **Provider credential management** — per-workspace keys, injected into runners, never client-exposed.
5. **Sandboxed runner (local legs)** — command allow/deny, worktree write-confinement, wall-clock runtime cap.
6. **Real-execution event fidelity** — real diffs → diff HITL, changed files → modules, branch → preview.
7. **Local auth posture** — desktop app serves on localhost as sole operator, secure-by-default via `AUTH_REQUIRED`.
8. **Onboarding / first-run** — create workspace → connect repo → add key → add runner; seed fixtures retired.
9. **Desktop packaging (beta, unsigned)** — `electron-builder` + `electron-updater` mac/Windows installers via tag-triggered CI release.
10. **E2E of the full loop (manual acceptance)** — assign → diff-review → approve → merge → done loop LLM-judged end-to-end, guarded on every PR.
11. **UX/UI first-run polish to SOTA** — fixed the pre-release UX review's launch blockers (loading states, empty-state CTAs, disabled-button styling, fleet-readiness).

## v0.5 — UX release polish

1. **Router + nav-state integrity** — sidebar highlighting now derives purely from router state through one function.
2. **Onboarding step 2 (GitHub) placeholder removed** — Integrations owns that connect flow post-onboarding.
3. **Blocked-CTA / disabled-state system** — unified disabled-button styling app-wide with a visible inline reason.
4. **Legibility floor** — swept `styles.css` for text under the ≥11px/`--muted` floor and fixed meaningful instances.
5. **Persist the workspace name server-side** — via the settings API instead of a client-side `localStorage` helper.
6. **Continuation after Create project** — lands in the new project with the composer focused + a first-run checklist.
7. **Task composer polish** — confirmed autofocus, placeholder copy, ⌘↵ submit, and blocked-reason state were in place.
8. **Assign is a primary affordance** — relabeled "Start →" on backlog/todo cards; `todo → ongoing` is a legal drag.
9. **Explain the Autonomy toggle** — added a visible subtitle; a workspace's first project defaults Autonomy off.
10. **Fleet copy & guardrails** — fixed pluralization/CTA copy, added a confirm dialog to Retire, fixed provider-strip wording.
11. **Inbox empty state teaches** — lists all four gate kinds with a one-line explanation each.
12. **Prioritize the backlog and todo** — manual reorder now also drives which task Autonomy auto-picks first.

## v1 — Orchestration completeness & hardening

- **Momentum Board — automated kanban rebuild** (TASK 00-14, the whole epic) — a rule engine reacting to GitHub/task-state signals (move/label/Slack-nudge/create-proposal actions, an announce-before-acting undo window, an auto-pause circuit breaker, a pattern detector), surfaced through three view metaphors (Momentum/Gravity/Rail Graph) and a task-detail drawer sharing one design-token system; closed when `newBoardEnabled` flipped to default-on for new projects (old six-state board removal is a tracked follow-up, not yet executed).
- **Momentum Board — Activity Feed** (TASK 08, Phase 6b) — a live per-project feed of every machine action (undo countdown, review link, escalation warning); found and added two missing endpoints (undo route, pending-actions list).
- **Momentum Board — pattern-spotted automation onboarding** (TASK 10, Phase 8) — a repeated manual move now surfaces as a proposed rule with real detector stats, with Turn-it-on / Watch-first / Never actions and a watch-state auto-promotion sweep.
- **Momentum Board — motion, responsive & a11y hardening** (TASK 13, Phase 10) — cross-cutting audit adding real loading states, error/retry handling, responsive breakpoints, and consistent hover/focus treatment.
- **Cross-project decision backbone** (TASK 15, Phase 12) — `GET /api/decisions` joins every open HITL item across a workspace's projects, sorted by cost-of-waiting; the foundation for the Inbox/Telegram surfaces below.
- **Global Decision Inbox** (TASK 16, Phase 13) — one screen for every human decision across every project, plus a full hardening pass (keyboard shortcuts, shortcut map, gate-arrival animation, responsive right rail).
- **Autonomy dial + persisted breaker** (TASK 19, Phase 16) — 4 named autonomy detents over existing fields, a durable (survives-restart) circuit breaker with an audited trip/lift, and a time-limited override.
- **Steward panel, audit actor-type, partial action execution** (TASK 21, Phase 18) — audit rows show who/what approved, Steward actions can execute a subset of a batch, and replies can cite sources (run/commit/breaker) as clickable chips.
- **Roadmap document parser and line identity** (TASK 27, Phase 24) — parses `ROADMAP.md` into a byte-round-trippable AST with stable per-line identity across edits (3-pass reconciliation), wired to a GitHub push webhook.
- **Momentum Board — Rail Graph board view** (TASK 12, Phase 11) — a third board metaphor rendering task history as a commit-graph-style stream, grouped by epic lane and day.
- **Momentum Board — default rollout + removal criteria** (TASK 14, Phase 11) — `newBoardEnabled` now defaults true for new projects; documented removal criteria for the old six-state board.
- **Browser tools for coding agents (MCP)** — every runner except Hermes can drive a real Chrome/Playwright browser within a task, opt-in per workspace, gated through the normal HITL tool-approval flow.
- **Agent labels / custom grouping** — Fleet already supported grouping agents by a labeled Group field and renaming via Configure.
- **Deploy to Fly.io** — a human-triggered deploy of a project's integration branch (or one run's branch) to a real, persistent `fly.dev` app.
- **Guided provider connect** — one-click "Connect Claude / Codex / …" with in-app key entry and a live verify check.
- **Run escalation / hand-off** — a stuck run halts into a first-class escalation state for a human instead of failing silently.
- **Fix:** a Stop on an escalation card no longer orphans its task in "ongoing" forever.
- **Manual "Switch agent"** on a live ongoing task.
- **Organize board** also unsticks unassigned backlog tasks it's confident about.
- **Manual "Force to review"** on an ongoing card.
- **Force Done** gets a completeness check before it pushes.
- **Manual "Request re-triage"** on a card parked in triage.
- **Fix:** a third termination path could strand a task "ongoing"/"review" while its run showed "done".
- **Fix:** a fourth stranding path — abandoning a run via a kanban move left its Inbox card dangling.
- **Fix:** a Telegram merge-conflict card was an unexplained raw diff dump; now actionable.
- **Fix:** a diff-review card said "Approve to integrate" on a 0+/0- no-op diff with no hint.
- **Fix:** Telegram silently discarded an operator's pick on an escalation card.
- **Fix:** answering a triage clarifying question could loop forever on the same question.
- **Fix:** Force Done didn't force anything done, only the card's label.
- **Triage asks** — clarifying questions now come with a Steward-drafted answer.
- **Spend efficiency on Home** — reconciling a month of fleet cost against what actually shipped.
- **Fix:** Skynet's cost meter under-reported real spend by ~3x, and side-calls silently ran Opus.
- **Session circuit-breaker** — a stuck autonomous sweep halts for a human, not just a stuck run.
- **Runner session-map cleanup** — the Claude runner's fork-resume session map is now a bounded LRU (cap 500).
- **S6 — Deep-explore grounding (optional)** — an opt-in, read-only bounded agent run that annotates a draft SolutionBrief with wrong assumptions and real touchpoints before approval.
- **S10 — Execution intents** — one shared server-side feasibility resolver + executor for starting/queuing work, reused by Steward, MCP, and Telegram.
- **Project header decluttered** — consolidated ~15 header pills into one Governance popover, cutting the toolbar to ~7 controls.
- 🏢 **Read-only (viewer) role** — enforced by a scope check on every non-GET API route, not just MCP.
- 🏢 **Time-limited admin promotion** — auto-expiring break-glass elevation, every grant and expiry audited.
- **Feature-batch size guardrail** — flags an unattended Feature batch before it grows into one unreviewable mega-PR.
- **Make the one human approval reviewable** — a batched Feature PR now carries a system-composed brief instead of a rubber-stamp diff.
- **Autonomous backlog sweep** — budget ceiling, two-lens review, circuit breakers, a self-replenishing backlog, and budget-as-allocation so the fleet can work a backlog unattended under a daily budget.
- **Scenario coverage** — a per-project Coverage lens cross-checking behaviour axes extracted from code against the test corpus.
- **CRITICAL finding (documented)** — the agent-control loop with real HITL gating exists only on the Claude SDK path; every CLI-backed runner is comparatively ungovernable.
- **Alternative LLM providers, phase 1** — a Claude-compatible endpoint per credential so a cheaper vendor runs the full governed agent loop.
- **Compatible endpoints made usable** — a vendor rate catalog, cache-aware spend accounting, a working verify check, and a "via `<vendor>`" marker.
- **Endpoint smoke test** — a per-credential Test button runs one tiny real task to prove an endpoint actually drives tool calls/gating/streaming/usage, not just authentication; found and fixed two bugs (a rejected key reporting as a pass, zero-usage read as "reachable").
- **Internal surfaces gate on RELEASE, not on "production"** — fixed a dev-build-flag gate that hid Skynet's own tooling on its hosted instance, and a route-gating hole that left QA pages reachable by deep link.
- **Repoint an existing runner at another credential**, without breaking the endpoint chip.
- **Bench a credential** — stop every agent on a key and put them back once it's healthy again.
- **`maxRunners` caps CONCURRENCY, not roster size** — used to refuse creation, now only throttles active runs.
- **Fix:** a run on a compatible endpoint could authenticate with the wrong vendor's credential.
- **Making Skynet DRIVE projects, not just process tasks** — three shipped steps.
- **The driver ACTS** — a dry board proposes its own next steps.
- **Merging you can comprehend** — evidence-gated auto-merge with one-click undo.
- **MCP kept going down, and `--restart=always` could not save it** — root-caused and fixed live.
- **Agent chats follow the operator** — the Steward dock is now tabbed.
- **Kanban/agent redesign, stage 1** — one shared "this run is over" teardown (`Orchestrator.retireRun`).
- **Stop paying twice for the same context** — three compounding defects fixed.
- **Make the cache hit rate visible** — you cannot optimise what you cannot measure.
- **Exploration model is a setting**, and no longer Opus.
- **Review upgrades (competitor-sweep adoption)** — a real **verifier gate** (a check-run failure now raises a human decision instead of silently parking the run), **auto-review on every task** (a fleet agent judges the diff and writes approve/flag), **deep review-as-run** (a bounded reviewer agent that actually opens a live preview and clicks through the change), **breaker review** (a third bounded agent that actively tries to break the change, layered on deep review), and an evidence-rich ready-to-merge card (real diff composition, sensitive-file paths, authored/reviewed-by, live GitHub check status) instead of an opaque verdict string — plus several real bugs found and fixed along the way (a stale local base ref inflating diff stats to "900+ files changed", a missing project chip on Inbox cards, GitHub org/repo pickers serving stale or mock data, `error_max_turns` now resumable, and manual checkpoint/snapshot-restore for long runs).
- **Guided merge — understand-then-merge, to any branch** — before a merge, Skynet composes the agent-authored diff walkthrough, verifier-gate status, and auto-review verdict into one plain-English merge brief, and lets the operator merge into any target branch (not just the default), not only `main`/the integration branch.
- **Solutioning layer (S1-S10)** — `SolutionBrief`, a human-approved pre-work planning doc (problem, approach, options weighed, risks, acceptance criteria) that everything else hangs off: full CRUD + live sync + MCP tools (S4); decompose an approved brief into a Feature + ordered, sized, dependency-linked tasks in one call (S7); thread the brief's approach/acceptance-criteria into every run for a task under it, with status auto-progressing draft→building→done (S8); Crystallize — turn a Steward chat thread into a real brief in one LLM call (S5); optional deep-explore grounding that annotates a draft brief with real touchpoints before approval (S6); and the shared execution-intents resolver/executor (S10).
- **Feature-scoped branch hierarchy — branch out from branches** — a task under a Feature now merges into a shared `skynet/feature/<id>` branch instead of straight to the integration branch; once every task under the Feature is done, Skynet closes the batch as one aggregate PR (GitHub-bound) or an up-merge (local-only). Deliberately did not chain each task's own branch off the feature branch — only the merge *destination* changed.

## v1.5 — Ship-the-wedge: onboarding, fluency & Memory v0

1. **Agent picker at Start** — a compact provider/model picker saved as a soft preference that never blocks Start if unmatched.
2. **Structured triage card** — an effort pill, full-contrast summary, and risks list instead of one muted paragraph, plus a grouped Operate/Configure nav.
3. **Humanized time** — stale-heartbeat styling for a silently-hung run, an honest empty PLAN state, and a provider glyph on Home's Runs board.
4. **Repo-optional / chat-only mode** — an explicit "no repo — chat only" choice, with a safety fix so its cwd is a private scratch dir, not the server's own.
5. **Task linter v0 (assistive)** — a background, dismissible linter flagging vague/under-scoped tasks right after creation.
6. **Parallelism nudge** — a dismissible Home nudge suggesting scaling up the fleet when idle runners meet a deep eligible backlog.
7. **Task grouping & per-project roadmap** — Features and Milestones as a level above the task board, managed via Steward and Telegram.
8. **Per-project agent instructions (house rules)** — a per-project instructions field on every prompt, plus a shared context assembler (goal, feature, sibling-run digest).
9. **Project Context** — pasted/uploaded notes, emails, and docs condensed into a short primer grounding both task prompts and project chat.
10. **Per-project isolation for credentials & GitHub identity** — a project can pin its own LLM credential and GitHub PAT; two real enforcement gaps found and fixed (triage/review picking sites bypassing the key allowlist, and `mergePr` never honoring the pinned GitHub credential).
11. **Charter-assisted project creation** — creating a project drafts a short LLM intake (goals, non-goals, risks, constraints, definition of done) via the operator's own key/secret store (one cheap, metered call), which the operator corrects and approves before create. See [docs/dev-team-blueprint.md](docs/dev-team-blueprint.md) §1.
11. **Design tokens, a11y, and an Inbox-first mobile/PWA shell** — a `--fz-*` type-scale token per font-size in use, a single `--input-focus-border` token replacing 4 drifted focus treatments, ambient animations guarded behind `prefers-reduced-motion`, a keyboard walkthrough of assign→decide→merge with two dead-ends fixed, and (the piece originally left as future work) an `--space-*` 8px spacing rhythm consolidating ~830 `padding`/`margin`/`gap` declarations in `styles.css` onto a canonical scale, ties rounding down, with element-coupled offsets and micro/optical values deliberately excluded.

## v3 — Triggers & integrations

1. **The enabling primitive** — an inbound-trigger concept; first instance is a GitHub issues webhook that creates a linked task on open/reopen/label.
2. **Skynet as an MCP server (shipped)** — exposes projects/tasks/fleet/agents/HITL as MCP tools, incl. a headless bootstrap token for sandbox deploys; also fixed list tools to return paginated summaries.
3. **GitHub Issues ↔ tasks (two-way sync)** — importing or a webhook creates a linked task, and the task's stage/PR post back to the issue as a label and a "Closes #n" link.

## v4 — Moat Layer: Portable cross-vendor memory

1. **Open the format** — published a versioned, human-readable, git-committable open memory spec (`docs/memory-format.md`) as a substrate, not a locked-in silo.
2. **Memory as an MCP server (format only)** — published the memory spec's markdown file format; the read/write MCP server itself remains a separate open item on the live roadmap.
