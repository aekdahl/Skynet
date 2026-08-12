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
5. [x] **Sandboxed runner (local legs)** — defense-in-depth around each agent, shipped without a
   container: **command allow/deny** (safety classifier, enforced at approve-time),
   **filesystem write-confinement** to the worktree (opt-in OS sandbox — macOS
   `sandbox-exec` / Linux `bwrap`, `SKYNET_RUNNER_SANDBOX`), and a **wall-clock
   runtime cap** (`SKYNET_RUNNER_MAX_RUNTIME_MS`, default 30 min) that force-fails
   a runaway/hung run. 🏢 *One-container-per-agent isolation, memory/CPU (cgroup) caps,
   and network-egress allowlist ride the containerized runner with the hosted release.*
6. [x] **Real-execution event fidelity** — real diffs → diff HITL, changed files → modules, branch → preview.
7. [x] **Local auth posture** — the desktop app serves on localhost as the single operator, with
   `AUTH_REQUIRED` secure-by-default (fails closed unless `NODE_ENV` is explicitly dev/test). 🏢 *Real
   multi-user login, SSO/OIDC, scoped CORS, and rate limiting are deferred with the hosted release.*
8. [x] **Onboarding / first-run** — create workspace → connect repo → add key → add runner; retire seed fixtures.
9. [x] **Desktop packaging (beta, unsigned)** — `electron-builder` `.dmg` (mac arm64 + x64) + `.nsis`
   (win) with the server + SPA bundled, `electron-updater` wired, and a `v*`-tag CI release
   ([.github/workflows/desktop-release.yml](.github/workflows/desktop-release.yml)) that publishes
   installers to GitHub Releases. **Beta ships unsigned by decision** — macOS users right-click → Open
   once (Gatekeeper); Windows background auto-update works unsigned. *(Code-signing + notarization split
   out to v1 — see below.)*
10. [x] **E2E of the full loop (manual acceptance)** — operator-run in the app's **QA → Simulation**
   view: the **"Full run pipeline — edit → diff review → merge"** journey drives a **real Claude agent**
   through the entire DoD loop (assign → isolated worktree → diff-review gate → approve → merge → run +
   task reach `done`) and is LLM-judged. Run in the packaged desktop build with a real
   `ANTHROPIC_API_KEY`. *(Replaces the old hosted-staging E2E; staging is 🏢 deferred. An automated
   deterministic guard of the same loop runs on every PR — `tests/full-loop.test.ts`.)*
11. [x] **UX/UI first-run polish to SOTA** — the launch blockers from the pre-release UX/UI review (the first ten minutes, where a new operator meets an empty board): pull QA surfaces (**Acceptance / Simulation**) out of the operator nav; real loading (skeleton + connect→connected lifecycle + retry — no terminal "Connecting to mission control…"); every empty state gets one primary CTA + a one-line mental-model hint; two-column onboarding + fix the **disabled-button** state globally (dim-amber reads as broken); surface **fleet-readiness** ("no provider connected — agents can't run · Add a key") from the first screen. *(Grades the first-run experience from ~3.4 → SOTA; none architectural.)*

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
- ***Project-scoped MCP service tokens** — tokens can now be pinned to specific projects (not just
  workspaces), so an MCP token issued to an external agent is naturally sandboxed to the project it should
  see. Necessary groundwork for shared/hosted MCP access.*

---

## v0.5 — UX release polish (pre-release · from [docs/ux-review.md](docs/ux-review.md))

Findings from the July 2026 end-to-end audit. **P0 blocks release; P1 makes the core loop
sell itself.** (P2/P3 items from the same audit are slotted into v1 / v1.5 below.)

**P0 — integrity & first impressions**
1. [~] **Router + nav-state integrity** — make Settings/Acceptance/Simulation deep-linkable
   (complete `parseHash`); derive the sidebar `.on` highlight purely from router state
   (highlights currently accumulate — three "active" at once); give focus a distinct
   `:focus-visible` ring instead of the active style; window title reflects view/project.
2. [x] **Onboarding step 2 (GitHub) is a PLACEHOLDER** mid-wizard — removed the GitHub step
   from the wizard (now Workspace → Module map → Fleet). Integrations already owns the connect
   flow post-onboarding, so a first-run user never meets the unfinished App-install mid-wizard.
3. [ ] **Blocked-CTA / disabled-state system** — one pattern app-wide: distinct disabled
   treatment + an inline, readable reason ("Select at least one provider", "name required")
   next to the button. Applies to GetStarted, wizard step 4, task composer, fleet form.
4. [ ] **Legibility floor** — ≥11px and `--muted` for any text that carries meaning; `--faint`
   only for decoration (subway anchor labels, backlog subtitle, legends, picker hints).
5. [x] **Persist the workspace name server-side** — rides `WorkspaceSettings` (the existing
   auto-scale settings record) as a `name` field; onboarding writes it via `PATCH
   /api/settings/fleet`, the sidebar/shell header read it from the live store
   (`workspaceSettings.name`), not `firstrun.ts`'s old localStorage helper.

**P1 — core-loop guidance & affordances**
6. [x] **Continuation after Create project** — land in the project with the task composer
   focused; keep a live **first-run checklist** on Home (create → task → assign → approve)
   until the first merge.
7. [x] **Task composer polish** — `AddTaskCard` already autofocuses the name field, carries the
   "description (optional — the full brief the agent receives)" placeholder, submits on ⌘↵ (and
   bare Enter in the name field), and its "Add task" button already renders a visible blocked-reason
   via `PrimaryButton` (not a hover-only tooltip).
8. [x] **Assign is a primary affordance** — the button (now labeled "Start →" — "Assign" implied
   a handoff, but it kicks the run off immediately) lives directly on backlog/todo kanban cards, and
   `todo → ongoing` is a legal drag transition too.
9. [x] **Explain the Autonomy toggle** — a visible subtitle now sits under the toggle in both
   the project header and the create-project form ("Agents triage, auto-pick, and review tasks
   on their own — off, the board is fully human-driven."), not just the hover title. A
   workspace's very first project also defaults Autonomy **off** (every project after defaults
   on, as before) — gated on the client's own project count at the moment the create form opens,
   not a server-side default change, so every other caller (MCP, API) is unaffected.
10. [ ] **Fleet copy & guardrails** — "1 agents" pluralization; unify "+ Configure agent" vs
    "Add to fleet"; move destructive **Retire** behind detail/overflow or confirm inline;
    label the provider strip as the *catalog*, not configured.
11. [x] **Inbox empty state teaches** — the empty state lists all four gate kinds (approval / plan
    review / diff review / merge conflict) with a one-line blurb each.
12. [x] **Prioritize the backlog _and_ todo** — manual promote/demote (reorder) on **todo**
    cards, not just backlog. A card's rank sets both what surfaces at the top of the column
    and — with Autonomy on — which todo an idle agent **auto-picks first**. The ↑/↓ control
    (`moveTask`, same `order` rank field as the backlog drag-reorder) now renders on both
    backlog and todo cards; `tickAutonomy`'s auto-pick step sorts eligible todo tasks by
    `order` before firing, so a short-capacity tick grants idle agents to the
    highest-priority task first instead of array order. (Drag-to-reorder stays the later polish.)

## v1 — Orchestration completeness & hardening
- [~] **⭐ Browser tools for coding agents (MCP)** — *near-term priority.* Equip the Claude runner (then the
  CLI runners) with a Chrome/Playwright **MCP** server so an agent can drive a real browser *within* a
  coding task: reproduce a bug, verify a UI change end-to-end, or read live docs before editing. Wrap,
  don't rebuild — a scoped MCP tool on the existing `runner-sdk` seam, **not** our own browser
  automation; the existing HITL gate already governs tool approvals, so a nav/click can be gated like any
  other tool. Opt-in per runner/workspace, off by default. Claude first (Agent SDK `mcpServers`), CLI
  runners after. *(Pulls the browser slice of v3's "Tools via MCP" forward — it's the highest-leverage
  tool for the code loop; verification/repro is where it pays off, and it composes with the live-preview
  pipeline below.)* *Landed: the Claude half — `browserMcpServers()` (`runner-sdk/src/claude.ts`) wraps
  `@playwright/mcp` over stdio, wired into the live query's `mcpServers` when `StartSpec.browser` is set
  (a per-workspace `browserTools` toggle); tools surface as `mcp__browser__…`, outside the auto-allow set,
  so every browser action gates through normal HITL approval like any other tool.* Still to do: **CLI
  runners** (Codex/Gemini/Cursor/Copilot) — `cli-runner.ts` has no MCP wiring at all today, and vendor
  support varies (several don't support MCP config yet), so this is a per-vendor investigation, not one
  drop-in change.
- [ ] Remaining providers live behind `runner-sdk`: **Codex, Gemini, Cursor, Copilot** (+ **OpenCode**, which
  is ubiquitous across the competitor field, and **Kimi Code** — Moonshot AI's terminal coding agent, same
  CLI shape as Claude/Codex/Gemini, [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)) — then
  breadth reactively from the candidate list in [docs/runner-catalog.md](docs/runner-catalog.md).
- [x] **Agent labels / custom grouping** — Fleet already supports both: a "Group" field
  (`label`) with a known-groups datalist, the fleet grid groups by label with headings, and
  editing an agent's name is already part of the same Configure form.
- [ ] **Mass inform** — select multiple agents (or a whole project / area / manager-family) and attach a
  note that rides the *next* prompt each already receives — **no extra turn, ~free** (Claude SDK
  `shouldQuery:false`; CLI runners buffer + prepend). A third interaction type (`inform`) alongside
  chat + resolve; optional "also remember" promotes the note to area/workspace memory (v4) so future
  agents inherit it too. Audited via existing streams.
- [ ] Real **live-preview** pipeline (sandboxed per-branch URLs).
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
    on desktop). Remaining Phase-2: the service-container runtime + auto-rebuild on merge.
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
  - **Perf — warm-worktree dep caching:** a fresh preview installs deps each start (~20s for a
    nested monorepo whose recipe embeds `install`, since the built-in root-level provisioning doesn't
    cover a sub-package). Cache/skip the reinstall when the reused worktree already has `node_modules`
    (and the lockfile is unchanged) so restarts are near-instant.
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
- [ ] **Guided provider connect** — one-click "Connect Claude / Codex / …": in-app key entry + a live verify,
  so onboarding never requires hand-authing each vendor CLI (the #1 friction rivals impose).
- [x] **Run escalation / hand-off — a stuck run halts for a human.** A run enters a first-class
  `escalation` HITL ("NEEDS HELP") three ways: the **agent hands off** itself when genuinely blocked
  (AskUserQuestion with header "ESCALATE" → detected by the runner), **too many failures**
  (`SKYNET_RUN_MAX_FAILURES`, default 3), or **too long** (`SKYNET_RUN_STUCK_MS`, opt-in — below the
  runner's hard cap). The operator resolves it from the Inbox: **help & resume** (guidance → the agent
  continues, or a fresh session relaunches in the worktree), **reassign** to a different runner, or
  **stop**. The halted run frees its runner but keeps its worktree so a resume/reassign can continue the
  work. *(Verified live: a real agent correctly escalated rather than fabricate a secret; help & resume
  round-tripped. Foundation for the "escalation SLAs / delegated approval" governance items below.)*
- [ ] **⭐ Governance to SOTA (the launch wedge — already the white space; make it best-in-class).** A 6-way
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
    *Landed groundwork: **MCP push notifications** — an MCP client sees new HITL gates + review-needed events
    live over `notifications/message` (workspace-scoped, approver-hint on scoped tokens); wait-for-hitl
    long-poll remains as the reliable fallback for stateless HTTP clients. Steward-side approve-in-flow +
    `approve-with-rule` still to do.*
  - Secrets at rest (local); 🏢 **observability** (hosted metrics/logging/tracing) + SIEM export of the audit.
- [ ] **Runner session-map cleanup** — `ClaudeRunnerProvider.sessions` (agentId→sessionId, kept for fork resume) grows one entry per agent for the server-process lifetime. Evict on agent completion (retain only entries an active fork could resume). Small RAM/tech-debt fix; no behavior change.
- [~] **Deeper runner-capability surfacing** — the `runner-sdk` seam normalizes vendors to a subset; pull more native capability through it (each is additive, behind the existing seam). *Landed: real plan steps (Claude task-tracking tools → PLAN panel) + token/cost telemetry (`onUsage` → Agent `usage`, best-effort for the CLIs). **CLI usage fidelity firmed up** (re-verified against each vendor's CURRENT CLI, not assumed): Codex — fixed a real bug, `usageFromJson` scanned for a flat `usage`/`stats`/`tokens` key but codex-cli 0.147.0's `TokenCountEvent` nests real counts two levels deep (`msg.info.total_token_usage`), so usage was silently never reported; now unwrapped correctly. Gemini — `buildArgs` never actually requested JSON output, so text mode was the ONLY mode ever exercised and usage was never parsed despite the JSON-handling code already existing; now defaults to `--output-format stream-json` (verified against gemini-cli's `StreamJsonFormatter`). Cursor — `--output-format stream-json` confirmed current via `cursor-agent --help`; no bug found, left as-is.*
  Still to do:
  - **Plan-mode gate (Claude)** — expose `permissionMode: "plan"` as a per-project/runner policy so the agent proposes a plan and `ExitPlanMode` becomes a `plan` HITL approved *before* any writes. Best fit for Skynet's HITL model; native to the Agent SDK.
  - **Per-runner tool + prompt policy** — surface `allowedTools`/`disallowedTools`, a project system prompt, and `settingSources` (CLAUDE.md) instead of the hardcoded auto-allow set + inline steering. Ties into v4 repo-native memory.
  - [x] **Structured diffs in gates/review** — shipped: `HitlItem.diff` (stat) is set in `raiseDiffReview` from `WorktreeManager.diffStat`, and the full unified patch is served on-demand by `GET /api/runs/:id/diff` (`orchestrator.ts#runDiff` → `worktrees.ts#patch`, a real `git diff` in the worktree) and rendered by `diff-view.tsx`'s `parseUnifiedDiff`. No vendor-specific patch-event plumbing exists (or is needed) — every runner's changes land in the same worktree, so one `git diff` covers Claude/Codex/Cursor/Gemini/Copilot alike.
  - **Token-by-token streaming** — Claude `includePartialMessages` / CLI NDJSON deltas → live "typing" in the log instead of whole-message chunks.
  - **Copilot usage/event fidelity** — `copilot` (v1.0.79) turns out to have a machine-readable mode after all (`--output-format json`, JSONL — this was previously undocumented here as text-only, now confirmed live), reporting output tokens + duration per turn, but no input-token count and no USD cost (it meters "premium requests"/AI credits, not $/token — a genuinely different billing model from the others). Adopting it isn't a usage-only change: the Copilot runner's approval-gate detection and tool/log lines are currently parsed from human-readable text, and `--output-format json` replaces ALL output with JSONL, so wiring usage means migrating that whole parser to structured events, not just adding a field extraction. Scoped out of the CLI-usage-fidelity fix as a separate, larger follow-up.
- [~] **Review upgrades (adopted from the competitor sweep):**
  - **Verifier gate** — run the project's tests/checks in the worktree and **block the merge on failure** as a
    first-class gate (not just the pre-merge `checkCmd`); auto-commit on green. *(bernstein / MartinLoop-style.)*
  - *Landed: **every review is auto-reviewed** — a fleet agent judges each `review`-state task's diff/output
    and writes a structured verdict (approve/flag) to the task; the log line names the reviewer + reason, and
    the audit trail records who reviewed what. Auto-approve merges only when the project's autonomy toggle is
    on; flagged runs stay in `review` for a human. Verdict parsing is field-based (JSON tail), not prose,
    so a reason mentioning "flagged" never false-flags an APPROVE.*
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
- [ ] **🔬⭐ Guided merge — understand-then-merge, to any branch.** Merging today is a single approve on the
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
- [ ] **UI system polish (P2 of [docs/ux-review.md](docs/ux-review.md)):** content max-width /
  purposeful two-column layouts (views left-hug at 1440 today) · stop amber doing triple duty
  (brand + primary + "waiting" status — move caution to its own hue; never encode status by hue
  alone) · replace unicode nav glyphs with one 16px stroke icon set (Lucide-style, terminal tone) ·
  **motion tokens** (120/200ms ease-out: view/lens crossfade, card enter, gate-resolve collapse,
  subway merge draw-in; respect `prefers-reduced-motion`) · one interactive-surface state rule
  (hover/active/focus consistent on every clickable, absent on everything else) · **a11y pass**
  (aria-labels on icon buttons, focus-visible everywhere, contrast audit vs the P0 type floor).
- [ ] 🏢 Auth: **SSO/OIDC**.
- [ ] 🏢 **Read-only (viewer) role** — not every operator should be an admin. A role that can observe
  everything (projects, runs, HITL, audit) but mutate nothing (no assign / resolve / transition /
  settings / provider keys). Wrap, don't rebuild: reuse the existing scoped-principal model — service
  tokens already carry `observe`/`author`/`approver` scopes, so extend the same scopes to human
  sessions rather than a parallel permission system. *(Multi-user — hosted/team only.)*
- [ ] 🏢 **Time-limited admin promotion** — temporarily elevate a viewer to admin for a bounded,
  auto-expiring window (break-glass / sudo-style), then revert to their base role automatically; every
  promotion + expiry is audited. Depends on the read-only role above.
- [ ] 🔗⛓ **Structural agent-hierarchy hooks** — `role`, `familyOf`→root, worker→manager merge (cheap, additive; from [docs/agent-hierarchy.md](docs/agent-hierarchy.md)).
- [ ] 🔗⛓ **Feature-scoped branch hierarchy — branch out from branches.** Today every task's agent branch
  cuts from the project's single integration branch and merges straight back to it
  (`MergeEngine.integrationBranch(projectId)` is keyed only by `projectId` — one merge target per
  project, no sub-grouping). When a Feature has several tasks/subtasks, group their branches under a
  **feature branch** first — so the whole feature merges there and can be tested/reviewed as a unit —
  and only that feature branch later merges up into the project base. **Reuses**: the branch-from-branch
  mechanism already proven by agent `fork()` (`orchestrator.ts` passes a parent run's branch as `baseRef`
  into `WorktreeProvisioner.provision()`), extended from today's 1-parent→1-child fork to N sibling tasks
  under one Feature; and live-preview's existing arbitrary-branch pinning (a per-run preview already pins
  to `ref: opts.branch`, and `latest` mode already octopus-combines several run branches) — a feature
  branch just becomes another pinnable ref, no new preview plumbing. **New work, concentrated in the merge
  engine**: a feature-branch naming scheme (e.g. `skynet/feature/${featureId}`); `MergeRequest` keyed by
  `featureId` for the first-stage merge (today it's `projectId`-only); orchestrator wiring so a task under
  a Feature passes the feature branch as `baseRef` (today only `fork()` does this, for a single parent);
  and a human-gated "merge feature branch → project base" step once every task in the Feature is done —
  reusing the same diff/verifier-gate/auto-review machinery **Guided merge** above already composes, just
  retargeted to a feature-vs-base diff instead of task-vs-base. A different axis from **Structural
  agent-hierarchy hooks** just above (that's agent *role* — worker/manager; this is *Feature/task*
  grouping) — complementary, not dependent.

## v1.5 — Ship-the-wedge: onboarding, fluency & Memory v0  ⛓
The staggered slice — make Skynet **decisively easier than the field** and start the moat thin, in
parallel with v1 hardening. (Rivals make you pre-auth each CLI and learn worktrees/tmux; the ease
features below are white space.)

**UX/UI to SOTA (pre-release review — high &amp; polish):**
- [ ] **Text-contrast ramp** (ink / muted / faint, checked ratios — muted currently sits at the reading floor) + a **systematized button/state token set** (primary / ghost / danger, each with explicit hover · focus-visible · disabled · loading).
- [x] **Agent picker at Start** + a saved per-task provider/model preference, and always show which agent a run is on. "Always show which agent" was already live (the kanban card surfaces the run's actual runner/provider·model once assigned). New: a compact provider (+ optional model) select on backlog/todo cards, right at the Start action — persists onto `Task.preferredProvider`/`preferredModel` via the existing `updateTask` path. It's a SOFT hint, never a hard requirement: `Orchestrator.acquireAgent` tries an idle, usable runner on the saved provider (preferring an exact model match) before falling back to today's plain first-idle pick — a preference with no matching idle runner never blocks Start.
- [ ] **Structured triage card** (effort pill · full-contrast summary · risks list, not one muted paragraph); **Inbox count badge**; grouped nav (**Operate** / **Configure**).
- [ ] **Humanized time** + stale-heartbeat styling (no raw "79062s ago"); honest empty-**PLAN** state; **provider identity** (real marks + names, not abstract glyphs).
- [ ] **Design tokens published** (type scale, 8px rhythm, motion behind `prefers-reduced-motion`, one focus ring, semantic palette kept separate from the accent); **a11y pass** (icon-button labels, visible focus, keyboard walkthrough of assign→decide→merge); explicit **Inbox-first mobile/PWA shell**.

**Easier to use than anyone else:**
- [ ] **Repo-optional / chat-only mode** — a runner with **no worktree and no merge**; try Skynet in 30s,
  no git literacy. Widens the funnel (also in Considerations).
- [ ] **Task linter v0 (assistive)** — *pulled forward from v5:* "vague task → touches 3 modules, split into
  3?"; "no 'done' defined?". The ease differentiator **nobody has** — lowers the skill floor, not just setup.
- [ ] **Charter-assisted project creation** — creating a project is a short LLM-drafted intake, not a name
  field: goals, non-goals, risks, constraints, definition of done — operator corrects and approves (the
  Charter). Uses the **user's own key** via the existing secret store (one cheap call; metered). The
  Charter is what the auto dev team (v2 north star) later sizes itself from, and what **auto task/milestone
  proposal** plans against. See [docs/dev-team-blueprint.md](docs/dev-team-blueprint.md) §1.
- [x] **Parallelism nudge** — "idle runners + deep backlog → spin up more?" turns the fleet's own state into
  guidance. Server-computed (`derive/parallelism.ts`, on the snapshot — not persisted), reusing the exact same
  eligibility check the autonomy loop's auto-pick already uses (`assignment.mode !== "unassigned"`, so a task
  no one's set up yet doesn't count as "waiting work"). Threshold: ≥2 idle runners (one idle agent between runs
  is normal churn, not spare capacity) AND ≥3 eligible backlog/todo tasks (a real queue, not the last couple of
  items about to be picked up anyway) — deliberately simple, tune later. Surfaces as a dismissible (session-only,
  not persisted — a fresh load re-checks live state rather than remembering a stale dismissal), accent-toned
  hint on Home's Runs board, the one place idle-runner count and backlog depth already show together; the CTA
  reuses the existing Fleet nav entry point, no new fleet-scaling logic.
- [x] **Task grouping & per-project roadmap** — a level *above* the task board. **Features** group related tasks (⊞ chip on cards; a lens listing each feature's mini 6-column count + progress bar); **milestones** are planned releases per project (◉ chip; a Roadmap lens with target-date badges and rolled-up features/tasks — "in Nd" / "today" / "Nd late"). Same-project scoping is enforced by the server (cross-project links refuse) and by the Steward/Telegram validators. Drove by: "roadmap formed from items in all stages of kanban marked with planned releases + milestones." Steward + Telegram both speak the seven grouping actions (`create_feature`, `set_task_feature`, `archive_feature`, `create_milestone`, `set_feature_milestone`, `set_task_milestone`, `mark_milestone_shipped`) — same confirm-first envelope task actions use.
- [x] **Per-project agent instructions (house rules)** — a `Project.instructions` markdown field that rides *every* prompt an agent sees on that project (assignTask, forkAgent, review-revise, escalation resume, triage consult, auto-review consult) and Steward's grounding. Motivated by: "build agents in Skynet using a specific subset of packages, pre-written code, and structure" — that's a per-project policy, not a workspace boundary, and it lives on the project record for instant editability. Trims + normalizes empty → null; the read-only header shows a compact "ⓘ Instructions active" chip.
- [x] **Per-project isolation for credentials & GitHub identity** — a project can pin its own **LLM credential** so runs on that project bill to that key (add-a-key UI + agent pinning), and its own **GitHub PAT** so PRs open under the right account regardless of workspace default. Complements the roadmap's "work spend to the business" story without a new workspace boundary.
- [~] **Project assistant → co-operator (actions from chat)** — the repo-aware project chat (read-only, *shipped*: answers about status + reads repo files like ROADMAP.md) gains the ability to *act* — create a task, start a run, move a card, add a runner — via the same **reply-plus-action envelope** the Telegram intent already uses (`telegram/intent.ts`): the model proposes one action, but it's **validated server-side and gated by the control-flag / a HITL**, never model-trusted. Turns the advisor into a co-operator without a second natural-language surface to maintain. *Steward (the shared brain, `apps/server/src/steward/`) has landed with: 15+ project + task actions (add/move/rename/desc/archive/reorder/schedule/etc.), workspace-wide focus resolution, streaming replies, dock focus-pinning, and **batch actions** — one input can propose up to N actions approved together (an "action budget" with overflow reporting). Grouping/roadmap actions (features + milestones, see below) share the same envelope. Still to do: broader coverage (fleet ops, credentials) + Telegram parity on the newer actions.*
- [ ] **Chat → canvas handoff, zero cold start** — the reply-vs-action decision above gets a third
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
  the link is the bridge, not a second interface to maintain. *(Prompted by an outside SOTA-routing
  pitch — "transport vs. generation," deep links that "hydrate state" instead of forcing a re-login.
  The underlying idea is sound and is genuinely missing; the "agent renders a whole spatial PWA on the
  fly" framing isn't — see the AG-UI note in Considerations for why we're not chasing that part.)*
- [ ] **Operator ergonomics (P3 of [docs/ux-review.md](docs/ux-review.md)):** **⌘K command palette**
  (navigation + verbs: assign, approve latest gate, open project) · **keyboard-first Inbox**
  (j/k navigate, a/r/m approve/reject/modify, ↵ opens the run — `QueueView.selectedIdx` already
  exists; finish it + a visible shortcut bar) · **OS notifications + dock badge** on new gates
  (Electron; waiting-minutes are the product's core currency) · **Timeline lens depth** (zoom,
  brush, click-through) · **cost/usage roll-ups** (per-project header + per-runner in Fleet —
  pre-figures the team blueprint's budgets).

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
- [ ] **The enabling primitive:** an **inbound-trigger** concept — a webhook/event creates a task or agent
  in a workspace. Today the only trigger is "operator assigns a task"; this one primitive unlocks the
  whole category. (Cheap to design early so we don't foreclose it; build here.)
- [ ] **Tools via MCP:** an agent gets scoped tools (GitHub / Sentry / Slack MCP) to act back into the
  user's services. A "Sentry agent" = a coding agent + Sentry MCP + a Sentry webhook trigger.
- [x] **Skynet *as* an MCP server (shipped):** the reverse direction — Skynet exposes its own surface
  (projects/tasks/fleet/agents/HITL) as MCP tools so an agent can drive the fleet, incl. a headless
  bootstrap token for sandbox deploys (e.g. Daytona). See [docs/mcp.md](docs/mcp.md).
  *(The browser/Chrome MCP tool is pulled forward to v1 — see above — since it serves the core code loop,
  not inbound triggers; the rest of the tool catalog lands here.)*
- [ ] **Feedback-loop responders (route back to the *originating* run)** — a CI failure, a PR review comment, or a
  merge conflict re-engages the **same** agent that produced the branch (self-healing), not a fresh run.
  *(Agent Orchestrator-style; ties directly to the responders below.)*
- [ ] **Interop surface (adopted)** — beyond `/mcp`, expose the fleet via an **OpenAI-compatible endpoint + REST**
  so external tools can drive it as a model/service. *(claw-orchestrator-style; broadens who can call Skynet.)*
- [x] **⭐ GitHub Issues ↔ tasks (two-way sync).** Read issues from a project's connected repo as Skynet
  tasks, work them through the normal loop, and keep the *issue* updated as they progress — the first
  concrete instance of the inbound-trigger + tools-back pattern, specialized for the tracker people
  already live in. **Landed, in three passes — every piece below is done:**
  - **Read (issue → task):** an "import issues" action (callable anytime, not just at project creation —
    `POST /api/projects/:id/import/github-issues`) pulls open issues from the connected repo; each becomes
    a Task linked back via `Task.source` (issue number + URL). Pull-on-demand only; a webhook trigger
    (issue opened/labeled → task) still waits on the v3 inbound-trigger primitive.
  - **Work:** the task runs the standard loop (assign → worktree → diff → PR). *Landed this pass:* the PR
    body is auto-linked with `Closes #<n>` (`orchestrator.ts`'s `openPrForRun`) whenever the task's
    `source.kind === "github_issue"`, so merging the PR closes the issue on GitHub even if write-back
    below hasn't fired yet.
  - **Update as worked (task → issue):** `task-sync.ts` subscribes to every `task.upserted` (human drag,
    complete/merge, the autonomy loop — one choke point) and comments/closes/reopens the linked issue on
    state transitions. *Landed this pass:* it also mirrors the kanban stage as a `skynet:triage|ongoing|
    review|done` label (replace-all on the issue's label set, preserving any non-`skynet:` labels a human
    added). Both gated by the same opt-in `Project.syncSourceStatus` — no second toggle. Verified against
    a real private test repo + issue: PR body carried `Closes #1`, the label tracked triage→ongoing→
    review→done live (including moves the autonomy loop made, not just human drags), and merging the PR
    closed the issue for real.
  - **Reuses:** the GitHub provider's REST client — `getIssueLabels`/`setIssueLabels` added alongside the
    existing `commentIssue`/`setIssueState` on the same `GitProvider` seam, no second client. Supersedes
    the bare "GitHub issue → PR" candidate below with the full round-trip.
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
- [ ] **⭐ Open the format — openness is the second moat.** Publish a versioned, human-readable, git-committable
  **open memory spec** (align with / extend `AGENTS.md`-style conventions) so the memory is a *substrate,
  not a new silo*. Openness is the adoption + trust lever — users only pour knowledge into something they
  can't be locked out of — which makes Skynet the default hub. The durable moat then shifts to *curation
  quality + the accumulated personal corpus + being the hub*, not owning the format (the git → GitHub play).
- [ ] **⭐ Memory as an MCP server** — expose the brain over MCP so **any** agent or tool can read/write it, even
  ones never run through Skynet. Your context follows you everywhere; rides the shipped `/mcp` surface.
- [ ] **Open-core split** — the *format + read/write MCP* are free/open (drive ubiquity); *distillation
  intelligence, cross-vendor translation quality, hosted sync, team sharing, and governance* are the paid layer.
- [ ] 🔬 **LLM-assisted distillation** of good memory from history — open research; start with
  operator-authored + decision-derived facts, add a Skynet-side curating LLM later.

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
- **In-process agent loops built on model-only SDKs** (e.g. an OpenAI / Google
  Gemini raw-model wrapper that Skynet drives as if it were the agent) — never.
  Model SDKs give a message endpoint; the vendor's coding agent — planning,
  tools, editing, permission gates — is what actually does the work. Rolling
  our own on top of a raw-model SDK to get "in-process everywhere" would be
  the same "build our own coding agent" trap, just spelled differently.
  In-process runs come from **vendor agent SDKs** (Claude today; watch-list
  above) or not at all.
