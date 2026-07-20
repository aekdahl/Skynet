# Skynet — Roadmap

**How to read this:** Skynet ships in versions. **v0 (MVP) is the only committed scope**; later
versions are directional and will be reordered as we learn. Deep detail for big features lives in
`docs/` briefs. The principle behind every entry: **wrap, don't rebuild** — Skynet is the
management/memory/leverage layer over off-the-shelf coding agents, not an agent itself
(see [docs/positioning.md](docs/positioning.md)).

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
3. **Prompt-injection / tool-poisoning firewall** (v1): gate tool calls steered by untrusted content the
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

Legend: 🔬 = needs an LLM / open research · 🔗 = has a design brief · ⛓ = depends on earlier version.

---

## v0 — MVP · the testable loop  ← committed

**Goal:** an internal tester points Skynet at a repo + their Anthropic key, assigns a task, and a
**real Claude agent** does the work in an isolated sandbox under human supervision, then merges.

**Must build / resolve:**
1. **Live Claude execution** — drive Claude Code via the Agent SDK/CLI; resolve the headless auth (scrub conflicting `CLAUDE_CODE_*`/gateway env so `ANTHROPIC_API_KEY` is used).
2. **Worktree-per-runner provisioning** — each agent gets an isolated git worktree/branch.
3. **Repo connection + `.skynet/modules.json`** — a workspace points at a real repo + integration branch.
4. **Provider credential management** — per-workspace keys, injected into runners, never client-exposed.
5. **Sandboxed runner** — one container per agent (resource caps, restricted network, command allow/deny).
6. **Real-execution event fidelity** — real diffs → diff HITL, changed files → modules, branch → preview.
7. **Auth hardening to test-grade** — real login, `AUTH_REQUIRED` on, scoped CORS, rate limiting.
8. **Onboarding / first-run** — create workspace → connect repo → add key → add runner; retire seed fixtures.
9. **Deploy** — GCE VM + Docker (app + runner containers) + Cloud SQL + Memorystore + staging URL/TLS.
10. **E2E test of the loop + staging env.**

**Scope:** Claude-only · one shared hosted instance on GCP · internal testers in separate workspaces.
**Done =** the loop above runs for a tester on staging. *(~30–50 eng-days; critical path #1, #2, #5.)*

---

## v1 — Orchestration completeness & hardening
- **⭐ Browser tools for coding agents (MCP)** — *near-term priority.* Equip the Claude runner (then the
  CLI runners) with a Chrome/Playwright **MCP** server so an agent can drive a real browser *within* a
  coding task: reproduce a bug, verify a UI change end-to-end, or read live docs before editing. Wrap,
  don't rebuild — a scoped MCP tool on the existing `runner-sdk` seam, **not** our own browser
  automation; the existing HITL gate already governs tool approvals, so a nav/click can be gated like any
  other tool. Opt-in per runner/workspace, off by default. Claude first (Agent SDK `mcpServers`), CLI
  runners after. *(Pulls the browser slice of v3's "Tools via MCP" forward — it's the highest-leverage
  tool for the code loop; verification/repro is where it pays off, and it composes with the live-preview
  pipeline below.)*
- Remaining providers live behind `runner-sdk`: **Codex, Gemini, Cursor, Copilot** (+ **OpenCode**, which
  is ubiquitous across the competitor field) — then breadth reactively from the candidate list in
  [docs/runner-catalog.md](docs/runner-catalog.md).
- **Agent labels / custom grouping** — rename agents and group them beyond project (small UX add).
- **Mass inform** — select multiple agents (or a whole project / area / manager-family) and attach a
  note that rides the *next* prompt each already receives — **no extra turn, ~free** (Claude SDK
  `shouldQuery:false`; CLI runners buffer + prepend). A third interaction type (`inform`) alongside
  chat + resolve; optional "also remember" promotes the note to area/workspace memory (v4) so future
  agents inherit it too. Audited via existing streams.
- Real **live-preview** pipeline (sandboxed per-branch URLs).
- **Scale:** Redis multi-replica fan-out; GKE Jobs for runners.
- **Guided provider connect** — one-click "Connect Claude / Codex / …": in-app key entry + a live verify,
  so onboarding never requires hand-authing each vendor CLI (the #1 friction rivals impose).
- **⭐ Governance to SOTA (the launch wedge — already the white space; make it best-in-class).** A 6-way
  competitor deep-dive found *none* ship a real safety/policy layer, decision audit, or (bar one) a HITL
  inbox — so this is where we win now:
  - **Safety = policy-as-code, not a hardcoded denylist** — a versioned, diffable per-workspace policy
    (allow/gate/deny, path scopes, resource + token-budget caps, network-egress rules); dry-run a policy
    against historical runs before enabling it.
  - **Context-aware risk** — classify by *blast radius*, not string match: outside the worktree, touching
    secrets, git-history-destructive, package publish, DB migration, network egress.
  - **⭐ Prompt-injection / tool-poisoning firewall** — detect when untrusted content the agent read (an
    issue, a web page, a dependency README) is steering its tool calls, and gate it. No competitor has this.
  - **Tamper-evident audit** — hash-chained, append-only decision records (who saw which diff/command, what
    the policy said, what the agent did after); exportable to SIEM.
  - **⭐ Compliance evidence pack** — one-click signed "AI change report" for auditors (EU AI Act tailwind).
  - **Unified HITL Inbox at SOTA** — one inbox across *all* vendors (structurally impossible for single-tool
    rivals); policy-driven auto-triage (auto-approve policy-safe, batch similar gates); **approve-with-memory /
    approve-with-rule** (an approval can write a policy or memory fact in-flow — the Inbox becomes *how* policy
    and memory get authored); async / mobile / delegated approval + escalation SLAs + a 2-person rule for high risk.
  - Secrets at rest; **observability** (metrics/logging/tracing).
- **Runner session-map cleanup** — `ClaudeRunnerProvider.sessions` (agentId→sessionId, kept for fork resume) grows one entry per agent for the server-process lifetime. Evict on agent completion (retain only entries an active fork could resume). Small RAM/tech-debt fix; no behavior change.
- **Deeper runner-capability surfacing** — the `runner-sdk` seam normalizes vendors to a subset; pull more native capability through it (each is additive, behind the existing seam). *Landed: real plan steps (Claude task-tracking tools → PLAN panel) + token/cost telemetry (`onUsage` → Agent `usage`, best-effort for the CLIs).* Still to do:
  - **Plan-mode gate (Claude)** — expose `permissionMode: "plan"` as a per-project/runner policy so the agent proposes a plan and `ExitPlanMode` becomes a `plan` HITL approved *before* any writes. Best fit for Skynet's HITL model; native to the Agent SDK.
  - **Per-runner tool + prompt policy** — surface `allowedTools`/`disallowedTools`, a project system prompt, and `settingSources` (CLAUDE.md) instead of the hardcoded auto-allow set + inline steering. Ties into v4 repo-native memory.
  - **Structured diffs in gates/review** — populate `HitlRaise.diff` from Codex/Cursor patch events and `git diff` in the worktree, so approvals show a real diff, not reconstructed text.
  - **Token-by-token streaming** — Claude `includePartialMessages` / CLI NDJSON deltas → live "typing" in the log instead of whole-message chunks.
  - **CLI usage fidelity** — Codex/Gemini/Cursor usage is parsed best-effort today; Copilot emits none (text-only). Firm these up as each vendor's structured output stabilizes.
- **Review upgrades (adopted from the competitor sweep):**
  - **Agent-authored diff walkthrough** — the run drafts a plain-English summary + inline comments grounded on
    the real `git diff` *before* you approve (nothing merges until accepted). Upgrades the diff HITL. *(Octomux-style.)*
  - **Verifier gate** — run the project's tests/checks in the worktree and **block the merge on failure** as a
    first-class gate (not just the pre-merge `checkCmd`); auto-commit on green. *(bernstein / MartinLoop-style.)*
  - **Checkpoint / snapshot-restore** a run's state — extends fork/resume for long tasks. *(AGX-style.)*
- Auth: **SSO/OIDC**.
- **Read-only (viewer) role** — not every operator should be an admin. A role that can observe
  everything (projects, runs, HITL, audit) but mutate nothing (no assign / resolve / transition /
  settings / provider keys). Wrap, don't rebuild: reuse the existing scoped-principal model — service
  tokens already carry `observe`/`author`/`approver` scopes, so extend the same scopes to human
  sessions rather than a parallel permission system.
- **Time-limited admin promotion** — temporarily elevate a viewer to admin for a bounded,
  auto-expiring window (break-glass / sudo-style), then revert to their base role automatically; every
  promotion + expiry is audited. Depends on the read-only role above.
- 🔗⛓ **Structural agent-hierarchy hooks** — `role`, `familyOf`→root, worker→manager merge (cheap, additive; from [docs/agent-hierarchy.md](docs/agent-hierarchy.md)).

## v1.5 — Ship-the-wedge: onboarding, fluency & Memory v0  ⛓
The staggered slice — make Skynet **decisively easier than the field** and start the moat thin, in
parallel with v1 hardening. (Rivals make you pre-auth each CLI and learn worktrees/tmux; the ease
features below are white space.)

**Easier to use than anyone else:**
- **Repo-optional / chat-only mode** — a runner with **no worktree and no merge**; try Skynet in 30s,
  no git literacy. Widens the funnel (also in Considerations).
- **Task linter v0 (assistive)** — *pulled forward from v5:* "vague task → touches 3 modules, split into
  3?"; "no 'done' defined?". The ease differentiator **nobody has** — lowers the skill floor, not just setup.
- **Parallelism nudge** — "idle runners + deep backlog → spin up more?" turns the fleet's own state into guidance.

**Memory v0 (thin moat, pulled forward from v4):**
- Operator-authored + **decision-derived** facts (every `hitl_audit` "decided X because Y" becomes a memory
  fact), scoped (workspace / project / area / agent), injected into any vendor via the `runner-sdk` seam, and
  **exportable/owned** (git-committable). No LLM distillation yet (that's v4) — but it makes launch
  not-just-another-orchestrator and starts the corpus compounding on day one.

**⭐ Cross-vendor consensus runs (signature bet):**
- Fire the same task at Claude + Codex + Gemini in parallel, auto-diff the results, keep/merge the winner, or
  have them peer-review each other. Needs the multi-provider runners from v1; the vendor-neutral seam is what
  makes true cross-*vendor* bake-offs possible (rivals' "councils" are single-tool).

## v2 — Agentic area-managers (the hierarchy)  🔬🔗⛓
Per-project LLM **area managers** decompose an area's goal and spawn first-class **worker subagents**
via a `spawn_worker` tool; risk-based escalation; worker→manager→project merge.
[docs/agent-hierarchy.md](docs/agent-hierarchy.md)
- 🔬 The decomposition is **LLM planning** — Skynet supplies the area goal + module map + the
  `spawn_worker` tool, surfaces a `plan` HITL, and spawns workers on approval. The model does the "how."
- **Managers organize by area *or* role** — same mechanism, different scope: a "Billing manager"
  (module area) or a "Review / QA / Security manager" (function). Role-managers are how specialized
  agents are arranged; workers under them inherit the role's prompt + tool scope.

## v3 — Triggers & integrations (inbound work)  🔗
Turn Skynet from "I assign tasks" into "work flows in from my stack, human-gated." Every integration
uses the **user's own accounts** (their Sentry, GitHub, LLM key) — Skynet is the connective +
supervision layer, it doesn't host or resell those services.
- **The enabling primitive:** an **inbound-trigger** concept — a webhook/event creates a task or agent
  in a workspace. Today the only trigger is "operator assigns a task"; this one primitive unlocks the
  whole category. (Cheap to design early so we don't foreclose it; build here.)
- **Tools via MCP:** an agent gets scoped tools (GitHub / Sentry / Slack MCP) to act back into the
  user's services. A "Sentry agent" = a coding agent + Sentry MCP + a Sentry webhook trigger.
- **Skynet *as* an MCP server (shipped):** the reverse direction — Skynet exposes its own surface
  (projects/tasks/fleet/agents/HITL) as MCP tools so an agent can drive the fleet, incl. a headless
  bootstrap token for sandbox deploys (e.g. Daytona). See [docs/mcp.md](docs/mcp.md).
  *(The browser/Chrome MCP tool is pulled forward to v1 — see above — since it serves the core code loop,
  not inbound triggers; the rest of the tool catalog lands here.)*
- **Feedback-loop responders (route back to the *originating* run)** — a CI failure, a PR review comment, or a
  merge conflict re-engages the **same** agent that produced the branch (self-healing), not a fresh run.
  *(Agent Orchestrator-style; ties directly to the responders below.)*
- **Interop surface (adopted)** — beyond `/mcp`, expose the fleet via an **OpenAI-compatible endpoint + REST**
  so external tools can drive it as a model/service. *(claw-orchestrator-style; broadens who can call Skynet.)*
- **Candidate responders:** Sentry regression → fix PR · GitHub issue → PR · PR review · CI-failure
  fix · Dependabot/CVE patch+fix · PagerDuty/Datadog incident triage · support ticket → bug task.
- Tier-2 API agents (Devin, Jules — see runner-catalog) plug in here as delegated remote workers.

## v4 — Moat Layer: Portable cross-vendor memory (M1)  🔗
User-owned memory that no single vendor can match, because everything streams through Skynet.
[docs/positioning.md](docs/positioning.md) §3.2
- Cross-vendor, long-lived, **portable/exportable**, scoped (workspace / project / area / family).
- **Manage repo-native memory too:** read/write/sync **`CLAUDE.md`, `.cursor/rules`, Copilot
  instructions, etc.**, and project Skynet's portable memory into each vendor's native format.
- Injection via the vendor-agnostic `runner-sdk`; sourced from the streams + `hitl_audit` already
  flowing through the `hub`.
- **⭐ Open the format — openness is the second moat.** Publish a versioned, human-readable, git-committable
  **open memory spec** (align with / extend `AGENTS.md`-style conventions) so the memory is a *substrate,
  not a new silo*. Openness is the adoption + trust lever — users only pour knowledge into something they
  can't be locked out of — which makes Skynet the default hub. The durable moat then shifts to *curation
  quality + the accumulated personal corpus + being the hub*, not owning the format (the git → GitHub play).
- **⭐ Memory as an MCP server** — expose the brain over MCP so **any** agent or tool can read/write it, even
  ones never run through Skynet. Your context follows you everywhere; rides the shipped `/mcp` surface.
- **Open-core split** — the *format + read/write MCP* are free/open (drive ubiquity); *distillation
  intelligence, cross-vendor translation quality, hosted sync, team sharing, and governance* are the paid layer.
- 🔬 **LLM-assisted distillation** of good memory from history — open research; start with
  operator-authored + decision-derived facts, add a Skynet-side curating LLM later.

## v5 — Moat Layer: Agent fluency (M2)  🔬🔗
Help users run **more agents with clearer tasks** — the flywheel (better results + more usage).
[docs/positioning.md](docs/positioning.md) §3.3
- **Task linter** (split/clarify suggestions) + **parallelism nudges** — *the assistive v0 ships early in
  v1.5*; v5 is the LLM-based coach on top.
- **⭐ Provably-improving fleet (signature bet)** — the **outcome feedback loop**: measure which memory facts
  + task phrasings one-shot cleanly vs. churn through HITL, auto-promote the winners, and **show the user the
  curve** ("your fleet is measurably better this month"). Nobody in the field measures outcomes; it makes the
  moat visible and compounds with v4.
- 🔬 The coach is **LLM-based** (critiques tasks, proposes decompositions); open research on UX + quality.
- Compounds with v4 — the coach learns from the workspace's own memory/history.

## v6 — Vendor migration
Help a user **move from one vendor to another** (Claude ↔ Codex ↔ Gemini …): carry over the
vendor-neutral memory, translate config/rules, and re-home in-flight work — leveraging the portable
memory (v4) + thin runner adapters.

---

## Considerations / open questions (decide later)
- 🔬 **LLMs for memory distillation (v4) and the fluency coach (v5)** — both likely require an LLM;
  decide model / cost / UX. (Flagged by design, not avoidance.)
- **Repo-optional / chat-only mode** — a repo should *not* be hard-required. A "just chat with an
  agent" mode is mechanically a runner with **no worktree and no merge**; it widens the funnel to try
  Skynet. Not the core money bet, but cheap to allow.
- **Cross-repo / multi-repo atomic changes** — a coordinated change spanning several repos. A gap **no
  local tool** fills today (cloud-only: Oz/Devin); a bigger future bet, flagged so we don't foreclose it.
- **No-telemetry / keys-never-leave-host guarantee** — make the local-first privacy stance an *explicit,
  stated* guarantee (already true for the desktop build; competitors like Octomux market it as a headline).
- **Distribution:** hosted (our GCP) vs. self-host (`docker compose`) vs. **BYO-runner** (containers on
  the customer's infra, only the UI hosted) for code-privacy.
- **Retention/policy** for logs, audit, and memory.

## Parked / explicitly out
- **Building our own coding agent** — never. Wrap, don't rebuild ([docs/positioning.md](docs/positioning.md)).
- Older Tower explorations live in `../Project Skynet DRAFT/` (reference only).
