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
| **N (now)** | 1 | deep-review / breaker-review settings UI toggle | PMF |
| | 2 | Memory v0 — operator-authored facts, injected per project | Platform |
| | 3 | Kimi Code runner + reactive runner breadth | Product |
| | 4 | First-run onboarding telemetry (anonymous install events) | PMF |
| | 5 | Mass inform — Fleet/Project UI (multi-select + whole-project) | Product |
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
1. [x] **Router + nav-state integrity** — `parseHash` (`apps/web/src/lib/routing.ts:19-47`) resolves
   `#/settings`, `#/acceptance`, `#/simulation` deep links, and `DEV_ONLY_VIEWS`
   (`apps/web/src/lib/dev.ts:25`) is empty, so nothing dev-gates them. The sidebar `.on` highlight
   derives purely from router state through one function, `activeNav(view)`
   (`apps/web/src/components/shell.tsx:36-66`) — every nav item's `.on` is `active === <key>`, never
   an ad-hoc local predicate, so highlights can't accumulate. `:focus-visible`
   (`styles.css:1849-1852`) is a separate outline from `.on`'s background/box-shadow treatment.
   Window title reflects view/project/agent via a `useEffect` in `App.tsx:209-217`. *(One nuance:
   the QA nav-section header carries `.on` too when Acceptance/Simulation is active — a
   parent-section + child-item pair, deliberately styled differently (`styles.css:1858` just
   recolors the header text, no outline/background) — not the original "three primary items lit
   simultaneously" bug.)*
2. [x] **Onboarding step 2 (GitHub) is a PLACEHOLDER** mid-wizard — removed the GitHub step
   from the wizard (now Workspace → Module map → Fleet). Integrations already owns the connect
   flow post-onboarding, so a first-run user never meets the unfinished App-install mid-wizard.
3. [x] **Blocked-CTA / disabled-state system** — one pattern app-wide: distinct disabled
   treatment + an inline, readable reason ("Select at least one provider", "name required")
   next to the button. Applies to GetStarted, wizard step 4, task composer, fleet form.
   *(GetStarted / wizard / task composer / fleet form already had it. Extended the pattern
   to the rest of the app: factored `PrimaryButton`'s reason-rendering out into a shared
   `Blocked` wrapper (`components/empty.tsx`) any button style can use — migrated
   Start/Assign, Retire (agent detail + fleet), Fork, Simulation's Judge/Copy, Settings'
   key/credential/token forms, and Merges' rework guidance to it. Selector chips
   (provider picker, subway rows, task-grouping chips) were left on hover-title — they're
   multi-choice rows, not a single blocked CTA, so a permanent reason line under each would
   be noise, not signal.)*
4. [x] **Legibility floor** — ≥11px and `--muted` for any text that carries meaning; `--faint`
   only for decoration. Fixed the roadmap's two named offenders (subway anchor labels
   `.swb-anchor-label`, backlog subtitle `.proj-backlog`) plus the rest of the same bug found on a
   full sweep of `styles.css`: risk chips, eval scores, test tallies, the Runs-board header row and
   status pills, subway track/station labels and counts, and every N/M-fraction readout across the
   app (feature/milestone/first-run progress, roadmap phase counts). Legends and picker hints were
   already compliant (`--muted` at 11px+, and genuinely decorative respectively) — left alone.
   Judgment calls, left `--faint`: a bare "—" no-agent placeholder (a null-state glyph, not
   information), per-log-line timestamps (a "when" annotation secondary to the log line's own
   `--muted` text), the timeline's axis-tick labels and the subway diagram's dense per-station name
   labels (both a chart/diagram-chrome convention, and — for the latter — a font-size bump risked
   overlap in a tightly absolute-positioned layout with many instances per row), and structural
   nav/palette section dividers (`OPERATE`/`CONFIGURE`, command-palette group headers) — grouping
   chrome, not content.
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
10. [x] **Fleet copy & guardrails** — "1 agent" pluralization fixed; the header CTA is now
    "+ Add agent" (matched to the form's own "Add to fleet" submit, one verb across the whole
    flow); Retire now confirms inline via the same danger-styled `useConfirm()` dialog used
    elsewhere (Stop run, etc.), with copy verified against what `retireRunner` actually does
    (history preserved, only the agent record removed; a busy agent is already 409-blocked);
    the provider strip reads "catalog: Claude, Codex, …" instead of implying all five are configured.
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
- [x] **⭐ Browser tools for coding agents (MCP)** — Equip every runner with a Chrome/Playwright **MCP**
  server so an agent can drive a real browser *within* a coding task: reproduce a bug, verify a UI change
  end-to-end, or read live docs before editing. Wrap, don't rebuild — a scoped MCP tool on the existing
  `runner-sdk` seam, **not** our own browser automation; the existing HITL gate already governs tool
  approvals, so a nav/click can be gated like any other tool. Opt-in per runner/workspace, off by default.
  *(Pulls the browser slice of v3's "Tools via MCP" forward — it's the highest-leverage tool for the code
  loop; verification/repro is where it pays off, and it composes with the live-preview pipeline below.)*
  **Landed for every vendor except Hermes** (no evidence it supports MCP): the Claude half —
  `browserMcpServers()` (`runner-sdk/src/claude.ts`) wraps `@playwright/mcp` over stdio, wired into the
  live query's `mcpServers` when `StartSpec.browser` is set (a per-workspace `browserTools` toggle); tools
  surface as `mcp__browser__…`, outside the auto-allow set, so every browser action gates through normal
  HITL approval like any other tool. **The CLI runners: each vendor wires it its own way**, verified live
  against the real CLI (not memory — several docs were stale) via the shared
  `browserMcpServerSpec`/`mergeBrowserMcpConfig` helpers (`runner-sdk/src/cli-runner.ts`, same
  `SKYNET_BROWSER_MCP_COMMAND` override Claude uses):
  - **Codex** — no project-local config file at all; `-c mcp_servers.browser.*=…` per-invocation
    overrides (verified against codex-cli 0.147.0) mean zero file writes, ever.
  - **Gemini** — file-based only (`--help` has no config-override flag); `CliVendor.prepareWorktree`
    (a new optional hook) writes `.gemini/settings.json` inside the run's own worktree, merged onto
    whatever the repo itself commits there — never the operator's `~/.gemini/settings.json`.
  - **Cursor** — file-based (`.cursor/mcp.json`) same as Gemini, but a freshly-added server also needs a
    one-time approval a headless run can't satisfy interactively; granted via `--approve-mcps` on the
    invocation (session-scoped) rather than the persistent, global `mcp enable`. Tool calls aren't
    live-HITL-gated here specifically — matches cursor-agent's existing `--force` full-trust design in
    this codebase (relies on Skynet's post-run diff review), not a new exception.
  - **Copilot** — a real per-invocation flag, `--additional-mcp-config <json>` (verified against
    `@github/copilot` 1.0.80); tool calls fall through the existing generic approval-prompt match, same
    live gate as any other tool.
- [~] Remaining providers live behind `runner-sdk`: **Codex, Gemini, Cursor, Copilot, OpenCode** done;
  **Kimi Code** (Moonshot AI's terminal coding agent, same CLI shape as Claude/Codex/Gemini,
  [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)) still to do; then breadth reactively from
  the candidate list in [docs/runner-catalog.md](docs/runner-catalog.md).
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
  to match `cwd` on every spawn.* Still to do: **Kimi Code** and reactive breadth from the candidate list.
- [x] **Agent labels / custom grouping** — Fleet already supports both: a "Group" field
  (`label`) with a known-groups datalist, the fleet grid groups by label with headings, and
  editing an agent's name is already part of the same Configure form.
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
  - [x] **Perf — warm-worktree dep caching, nested sub-packages.** The root-level path (ensureDeps's
    symlink/install, reconcileDepsOnRefresh's root reinstall) was already correct — untouched here.
    The actual gap: a recipe for a nested monorepo can embed its OWN install directly in `recipe.cmd`
    (`cd apps/web && pnpm install && pnpm dev`) for a sub-package the root-level provisioning never
    reaches, and that embedded install reran on every single start/restart with nothing to skip it.
    `project-preview.ts`'s `reconcileEmbeddedInstalls` now detects a `cd <dir> && <pm install> &&`
    segment (`EMBEDDED_INSTALL_RE`) and strips it when that sub-package's `node_modules` already
    exists and its lockfile is content-identical (SHA-256, not mtime — the worktree's own
    `checkout --detach && reset --hard` on every restart touches every tracked file's mtime whether
    or not it changed, so mtime would always read "stale" here) to the one from the last successful
    install *in this reused worktree* (`.skynet/preview-installs/<slug>.hash`, written by a step
    spliced into the command's own `&&` chain — the only way to know the install actually exited 0,
    since a `cmd` that also starts a long-running dev server never itself exits). The same warm check
    now also gates `reconcileDepsOnRefresh`'s nested case, so a merge-triggered refresh only re-runs a
    sub-package's install when the diff actually touched *its* manifest, not any dep-file anywhere.
    Verified against a real nested-monorepo fixture (real `npm install`, not mocked): cold start
    installs, warm restart skips it (`▸ cd apps/web && node server.js` — no install segment at all),
    a dependency bump makes it reinstall again.
- [x] **Deploy to Fly.io — a real, persistent deployment alongside the ephemeral local preview.** The
  live preview above is a scratch worktree running a local dev server: torn down on stop/restart, never
  independently reachable once Skynet itself isn't running. This adds a second, human-triggered option —
  a genuine `https://<app>.fly.dev` deployment of a project's **integration branch** (or a single **run's
  branch**, for pre-merge verification) that survives independent of the local Skynet process, and is
  only ever torn down by an explicit operator action (never automatically, never on a Skynet restart).
  **Reuses, doesn't replace:** the SAME worktree provisioning as the local preview (`prepareWorktree`/
  `ensureDeps`, extracted into `preview/worktree.ts` so both engines share one implementation), the
  existing `.skynet/preview.json` descriptor's previously-unused `build`/`outputDir` fields (a new `fly`
  sub-block adds only what's genuinely Fly-specific: app name, region, VM sizing — small/free-tier
  defaults, always operator-overridable), and the same per-project credential-pinning UI pattern as the
  GitHub PAT (`flyCredentialId`, a `fly` credential in the existing `SecretStore`). Two deploy shapes:
  a **static site** (descriptor declares `build`) builds locally in the warm worktree and ships a minimal
  generated `Dockerfile`/`fly.toml`; a **service** (a real backend) skips any local install entirely and
  defers to `flyctl launch`'s own builder detection — reusing local `node_modules` for a container's
  shipped artifact would risk shipping macOS-built native deps into a Linux image. Mechanism: shells out
  to the real `flyctl` CLI (matches this codebase's `git-bin.ts` precedent — wrap a battle-tested binary
  rather than reimplement the Machines API), with a deterministic app-name collision retry. Explicit
  operator action only — a "⇪ Deploy to Fly.io" button; never wired into the autonomy loop, the merge
  queue, or any automatic trigger. Full design: **[docs/live-preview.md](docs/live-preview.md)
  §"Deploy to Fly.io"**.
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
  - [x] **Safety = policy-as-code, not a hardcoded denylist** — a versioned, diffable per-workspace policy
    (allow/gate/deny, path scopes, resource + token-budget caps, network-egress rules); dry-run a policy
    against historical runs before enabling it. *Landed: `CommandPolicy`/`PolicyVersion` (contracts.ts) —
    `classifyCommand()` (command-safety.ts) now consults a policy argument instead of hardcoded rule
    arrays; the shipped classifier is `DEFAULT_COMMAND_POLICY`, the exact same rules expressed as data, so a
    workspace with no saved version is byte-for-byte unaffected. Versions are per-workspace, git-like
    (`store.putPolicyVersion` deactivates the prior active version but keeps it — never overwrites), backed
    by all three Store adapters (memory/file/Postgres). Dry-run (`command-policy.ts#dryRunPolicy`) replays a
    workspace's real historical commands (drawn from its `hitl_audit` trail) through a proposed-but-unsaved
    policy and reports exactly which commands would flip decision/risk vs. the currently active policy —
    verified live against real audit history end-to-end (API + Settings UI). A Settings → Command policy
    panel edits rules, dry-runs, and browses version history. Resource-cap and network-egress fields are
    recorded on the policy but inert — no runtime enforcement exists for either yet (network-egress
    enforcement is explicitly out of scope here; see 🏢 below). Path scopes were scoped out (no per-path
    command semantics existed to attach them to). Tests: `tests/command-policy.test.ts`.
  - [x] **Budget ceiling — daily spend rollup + auto-pick gating.** A per-project `dailyBudgetUsd` (USD,
    null = no limit — today's behavior, unchanged): once the project's KNOWN spend today reaches it, the
    autonomy loop's auto-pick step stops starting NEW work on that project for the rest of the day —
    in-flight runs finish, and a human can still assign manually at any time (`assignTask` itself is never
    gated). The safety floor for "today we develop for $20." A different mechanism from
    `CommandPolicy.resourceCaps.maxTokenBudget` above (per-command policy, still inert) — this is a
    per-project daily USD ceiling on real spend. *Landed:* `computeDailySpend`
    (`packages/shared/src/budget.ts`, pure — sums `TaskRun.usage.costUsd` for a project's runs started in
    the current local day) is the ONE place "today's spend" is computed, shared by the server gate
    (`orchestrator.ts#underDailyBudget`, called from `tickAutonomy` step 2) and the web project header, so
    the number an operator sees is exactly the number the gate acted on. Vendors that don't report cost are
    tracked as a separate `unknownCostRuns` count and treated as a floor, never silently dropped and never
    fabricated into the enforcement number (so the gate can't be tripped by spend it can't actually see).
    Logs the pause transition once via the hub, not every tick (`budgetPausedFlagged`, re-arms silently once
    spend drops back under budget — which happens on its own at local midnight, since "today" is always
    recomputed from `now()`, no separate reset). Project settings gets a "Daily budget" field; the project
    header shows "spent today / budget" once one is set.
  - [x] **Budget-as-allocation — cost-aware picking + pacing.** The ceiling above is a stop-gate: it halts
    ALL new work once spend is exhausted, with no sense of what fits along the way. This turns the same
    budget into an allocator — "$20 today" shapes which tasks the fleet starts, not just when it stops.
    *Landed:* `tickAutonomy`'s existing triage step already produces `Task.assessmentEffort`
    (small/medium/large) via a real LLM call — reused as-is, no second estimation call. `costBandFor`
    (`packages/shared/src/budget.ts`) maps that FREE signal to a static $ band (0.50/2/8); an untriaged task
    (`null` effort) assumes the MEDIUM band, never zero, so an unclassified task can't look free to the
    picker. Auto-pick's `pickable` list (already sorted by `order`, the same rank the ↑/↓ column writes)
    is walked in that SAME order by `orchestrator.ts#selectAffordable`: a task is skipped — never
    reordered — only when its cost band would exceed what's left, and the walk continues so a cheaper
    lower-priority task can still fit past an expensive one that didn't. Skips log once per tick (not once
    per task) naming what was skipped. **Pacing** (`Project.budgetPacing`, off by default): spreads the
    budget across a working window (`config.budgetPacingWindowMs`, default 8h) instead of committing it all
    to the first tick — availability grows linearly from $0 at local midnight to the full budget as the
    window elapses (`orchestrator.ts#pacedAvailableUsd`), and never exceeds the TRUE remaining headroom
    (real spend already made) regardless of how much of the window has passed — pacing can only make the
    picker more conservative, never let it overspend a tight budget. `committedUsd` (same file) gives a
    rough forward-looking $ estimate for tasks already `ongoing` (in flight, not yet cost-reported); the
    project header's "spent today / budget" gains "(≈$X committed)" when nonzero. A project settings toggle
    ("Pace spend") only appears once a daily budget is set. Deliberately not built: no scheduler/queue
    (this is a per-tick greedy filter, not a planner), no auto-adjusting budgets, no calibration of the cost
    bands against real spend (a static table — tune it by hand from `Usage.costUsd` data if it drifts).
  - [x] **Context-aware risk** — classify by *blast radius*, not string match: outside the worktree, touching
    secrets, git-history-destructive, package publish, DB migration, network egress.
    *Landed: `blastRadiusFlags()` in `command-safety.ts` scans a command's absolute paths against the agent's
    worktree root and flags any path that falls outside it as `outside-worktree:<path>`. Also flags network-egress
    commands (curl/wget/ssh/scp/rsync/nc — distinct from the already-denied pipe-to-shell patterns). Both signals
    are added to the gate's `flags` chips and bump risk to `high` in `orchestrator.ts#raise()`, so auto-approval
    can never quietly run an outside-worktree or network-egress command regardless of the project's approval level.
    Tests: `tests/blast-radius.test.ts`.*
  - [x] **⭐ Prompt-injection / tool-poisoning firewall** — detect when untrusted content the agent read (an
    issue, a web page, a dependency README) is steering its tool calls, and gate it. No competitor has this.
    *Landed (v1): a structured LLM consult (`injection-firewall.ts`, same prompt-builder + safe-default-parser
    pattern as `review-verdict.ts` — the model reads a `{steered, reason, source}` JSON field, never a
    substring/regex classification of prose) judges whether a command-gate is following an instruction embedded
    in content the agent read, distinct from `command-safety.ts`'s classifier (which judges a command's own
    shape, not its origin). The Claude runner tracks a capped buffer of untrusted reads — any `WebFetch`, plus
    `Read` scoped to `node_modules`/`vendor`/`.git` paths (a scoping heuristic for what's worth remembering;
    the security judgment itself stays the LLM's job) — and hands it to `orchestrator.ts#raise()`, which runs
    the check **before** the approval-policy auto-approve block and **forces a human gate on any steered
    verdict, overriding the project's approval level** (a `trusted` project that would otherwise silently
    auto-approve a low-risk command still gates it). The gate carries a `prompt-injection-suspected: <source>`
    flag and a bumped risk floor; every check's outcome is logged — including a benign one — so the firewall's
    activity is auditable, not just its hits. *Verified live* (not just unit tests): a real Claude agent doing
    ordinary "get the app running" work read a vendored dependency's README containing a subtly-injected setup
    instruction (`echo ... > .cache`, framed as ordinary docs, no "ignore your instructions" framing), followed
    it as part of what it believed was legitimate setup, and the firewall correctly flagged the resulting
    command as steered and parked it for a human — while a genuinely unrelated command earlier in the same run
    (`node index.js`) was correctly judged not-steered and auto-approved as normal. Full test suite: pure-parser
    unit tests + three end-to-end scenario tests (adversarial/benign/no-untrusted-reads) via the `providerOverride`
    seam, proving the auto-approval-bypass property against a scripted provider, not just mocked JSON.
    **Known v1 limits, stated plainly rather than overclaimed:** Claude-only — CLI vendors (Codex/Gemini/Cursor/
    Copilot/Hermes) don't populate the buffer, since their event streams don't expose tool-result bodies today;
    a task's own imported source text (e.g. a GitHub issue body) is not treated as untrusted, only content read
    *during* the run; the `node_modules`/`vendor`/`.git` path heuristic is narrow by design and will miss other
    untrusted local content; a failed/unreadable consult fails open (no extra scrutiny, but `command-safety.ts`'s
    own gate still applies); and — as the live verification also showed — a sufficiently blunt injection often
    gets refused by the model's own training before any tool call is even attempted, so this firewall is
    defense-in-depth for the cases where the model *does* comply, not the only line of defense.*
  - [x] **Tamper-evident audit** — hash-chained, append-only decision records (who saw which diff/command, what
    the policy said, what the agent did after); exportable to SIEM.
    *Landed: every `AuditRecord` now carries a `hash` (SHA-256 of the canonical JSON of its immutable decision
    fields: workspaceId/hitlId/runId/action/operatorId/at/payload/prevHash) and a `prevHash` linking it to the
    preceding record in the same workspace's chain — a linked list where any alteration to a field or to the
    record's position in the trail is immediately detectable offline. Genesis record has `prevHash=null`;
    pre-chain records (written before this feature landed) have neither field and are skipped by verification.
    All three Store adapters (memory/file/Postgres) chain records at write time; Postgres adds `hash` and
    `prev_hash` columns via `ALTER TABLE IF NOT EXISTS`. `verifyAuditChain()` (`audit-chain.ts`) re-computes and
    verifies the full chain in oldest-first order. SIEM export: `GET /api/audit/export` returns the workspace
    trail as NDJSON (one record per line, oldest-first, `application/x-ndjson`, `Content-Disposition: attachment`)
    so a SIEM agent can ingest the stream and verify the chain offline. Optional `?from=<ms>&?to=<ms>` narrow
    the window. Tests: `tests/audit-chain.test.ts`.*
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
- [x] **Runner session-map cleanup** — `ClaudeRunnerProvider.sessions` (runId→sessionId, kept for fork resume) is now a bounded LRU (cap 500, evict-oldest via re-insertion-on-touch), not evict-on-completion as originally scoped: Fork stays available on ANY run indefinitely (no completion/archival ever disables the Fork button), so there's no lifecycle event that safely marks an entry as "will never be resumed again" — evicting on done/worktree-retire would silently break resume for the ordinary "fork a run I finished a while ago" case. Beyond the cap, a fork just starts a fresh (non-resumed) session — exactly what already happens today after a server restart, since this cache was never persisted. Small RAM/tech-debt fix; no behavior change for realistic single-operator volumes.
- [~] **Deeper runner-capability surfacing** — the `runner-sdk` seam normalizes vendors to a subset; pull more native capability through it (each is additive, behind the existing seam). *Landed: real plan steps (Claude task-tracking tools → PLAN panel) + token/cost telemetry (`onUsage` → Agent `usage`, best-effort for the CLIs) + **plan-mode gate (Claude)** — an opt-in per-project `planModeGate` sets `permissionMode: "plan"`; `ExitPlanMode` is intercepted and raised as a real `plan` HITL (the dead `HitlKind` finally has a producer), and everything but read-only investigation is denied outright until the operator approves it — genuinely no writes happen first + token-by-token streaming for Claude (`includePartialMessages` → a bus-only `run.log.delta` event, never persisted per-token → live "typing" in the run log, same finalized `run.log` write as before). **CLI usage fidelity firmed up** (re-verified against each vendor's CURRENT CLI, not assumed): Codex — fixed a real bug, `usageFromJson` scanned for a flat `usage`/`stats`/`tokens` key but codex-cli 0.147.0's `TokenCountEvent` nests real counts two levels deep (`msg.info.total_token_usage`), so usage was silently never reported; now unwrapped correctly. Gemini — `buildArgs` never actually requested JSON output, so text mode was the ONLY mode ever exercised and usage was never parsed despite the JSON-handling code already existing; now defaults to `--output-format stream-json` (verified against gemini-cli's `StreamJsonFormatter`). Cursor — `--output-format stream-json` confirmed current via `cursor-agent --help`; no bug found, left as-is.*
  - [x] **Token-by-token streaming for the CLI runners** — shipped for the two vendors whose wire protocol actually carries per-chunk deltas; the other two don't and aren't forced. Gemini: `-p` non-interactive `stream-json` mode emits a `message`+`delta:true` event per chunk with no distinct "message complete" event on the wire (verified live against gemini-cli's `nonInteractiveCli.ts`, not just the `MessageEvent` type shape) — `gemini.ts#parseLine` now buffers chunks, previews each via `onLogDelta`, and flushes the buffer as one persisted line the moment the next non-delta event arrives (`CliVendor.parseLine` widened to return `CliEvent | CliEvent[]` so a flush can precede that event's own, in `cli-runner.ts`). Cursor: added `--stream-partial-output`; its wire format reuses the exact same `{type:"assistant"}` shape for both a raw chunk and the consolidated message with no dedicated delta type, so `cursor.ts#isConsolidatedAssistantEvent` tells them apart by field presence (`model_call_id` set, or `timestamp_ms` absent) — verified against the shipped CLI's own bundled source (no public repo to check against, no live `CURSOR_API_KEY` in the verifying environment either), not empirically confirmed against a captured live payload; treat as a good-faith reading worth re-checking if a `cursor-agent` update ever changes this. Codex: checked for real, not assumed — `codex exec --json`'s wire format (`codex-rs/exec/src/exec_events.rs`'s `ThreadEvent`, confirmed at the exact `rust-v0.147.0` tag already used for usage) only has `item.started`/`item.completed` lifecycle events for assistant messages, no delta variant; the raw internal protocol DOES have one (`AgentMessageContentDelta` in `codex-rs/protocol`) but `exec --json` doesn't expose it — not wired, nothing to force. Copilot: still text-mode only (see the item below) — no JSON stream to extract a delta from yet.
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
  - [x] **Structured diffs in gates/review** — shipped: `HitlItem.diff` (stat) is set in `raiseDiffReview` from `WorktreeManager.diffStat`, and the full unified patch is served on-demand by `GET /api/runs/:id/diff` (`orchestrator.ts#runDiff` → `worktrees.ts#patch`, a real `git diff` in the worktree) and rendered by `diff-view.tsx`'s `parseUnifiedDiff`. No vendor-specific patch-event plumbing exists (or is needed) — every runner's changes land in the same worktree, so one `git diff` covers Claude/Codex/Cursor/Gemini/Copilot alike.
  - **Token-by-token streaming for the CLI runners** — Codex/Gemini/Cursor NDJSON deltas → the same `run.log.delta` live-typing path Claude now has (Copilot's JSON mode is per-turn, not per-chunk — see below, nothing to stream yet).
  - [x] **Copilot usage/event fidelity** — shipped: the Copilot runner now drives `copilot -p ... --output-format json` and dispatches on real structured events instead of regex-matching human-readable text, confirmed live against copilot 1.0.80. The approval gate is a genuine protocol finding, not an assumption: non-interactive `-p` mode has no stdin-driven approval channel at all, so the CLI never emits `permission.requested` there — a tool needing permission is auto-denied immediately (`tool.execution_complete` with `error.code:"denied"`) and the model just adapts inline, all within one continuous turn (verified live: asking the agent to write a file was silently denied twice — the `create` tool, then a `bash > file` fallback — before it gave its own honest "permission denied" answer, no external stimulus). So the gate is keyed off that denial instead: Skynet raises the HITL the CLI itself couldn't, and approving replays the same action as a follow-up turn with that one call's permission scoped in via `--allow-tool` (a specific `shell(cmd)`/`write(path)` pattern, never a blanket `--allow-all-tools`) — verified end-to-end against a real authenticated run, including the file actually landing on the approved retry. Usage: `assistant.message.outputTokens` summed across the run + the terminal `result.usage.totalApiDurationMs`; input tokens and cost stay unreported (0/null) — genuinely absent from this protocol, not a gap (Copilot meters "premium requests"/AI credits, not $/token). Two adjacent bugs fixed along the way: a follow-up turn after a gate decision was missing `--continue` (the condition excluded exactly the turns that needed it, so an approved retry silently lost all prior task context — reproducible in the old text-mode parser too); and turn continuity now uses an explicit per-run `--session-id` instead of `--continue`'s ambient "most recently active session on the host," which would let two concurrent Skynet runs' follow-up turns cross-contaminate each other's conversations.
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
- [x] **S6 — Deep-explore grounding (optional).** Before an operator approves a `SolutionBrief`, an
  opt-in `POST /api/projects/:id/briefs/:bid/explore` spins a bounded, READ-ONLY agent run that
  actually reads the codebase and annotates the draft — wrong assumptions, real touchpoints, blast
  radius — instead of trusting the brief's prose alone. Built on the `deepReview` template
  (`Orchestrator.runDeepReview`): a real bounded run behind a private, invisible-on-the-board
  `RunnerEvents` adapter (no TaskRun, no fleet-runner row, every gate auto-resolves — there's no
  human watching), `disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]` so it's
  categorically incapable of mutating anything, and a `null`-on-ANY-failure contract (no repo, no
  usable Claude credential, worktree prep failed, timeout, unreadable output). Two deliberate
  differences from that template: (1) no live preview/browser — this reads code, it doesn't exercise
  a running app, so it checks out a DETACHED worktree of the project's base branch via
  `preview/worktree.ts`'s `prepareWorktree` (the same machinery the local preview and Fly deploy
  engines already share — reused, not reimplemented); (2) there's no pre-picked reviewer `Agent` (a
  brief predates any task/run), so the model/provider is a fixed Claude default rather than an
  existing agent's own. `Orchestrator.exploreBrief` returns the structured verdict; the null-on-
  failure gets turned into a real thrown `Error` one layer up (`Operations.exploreBrief`) so the
  failure is VISIBLE at the API boundary (a 400 the caller actually sees) rather than a silent 200 —
  the brief is written ONLY on a genuine success, `exploration` (new `SolutionBrief` field:
  `{at, findings, touchpoints} | null`) never touches any operator-authored field or the `status`
  gate. Test seam note: `config.worktreesDir` is read once at module-import time (not live), so unlike
  `previewOverride`'s existing injected-manager pattern this needed its own constructor seam
  (`exploreWorktreesDirOverride`) for a test to point at an isolated temp dir — otherwise every test
  run would share one `.skynet-worktrees/explore-<id>` directory relative to wherever vitest happens
  to run from. Verified: a stubbed provider's `StartSpec.disallowedTools` is asserted directly
  (`tests/explore-brief.test.ts`), and re-running stash→confirm-fails→pop showed all 6 tests fail
  with `ops.exploreBrief is not a function` before this landed. **Deliberately not built** (the
  task's own Accept criteria is backend-only, and S4 itself ships with no web UI yet to attach one
  to): the "status chip while running" mentioned in the task brief — no `SolutionBrief` view exists
  in `apps/web` to add it to; the POST is synchronous (the client's own in-flight request IS the
  "running" state) so no server-side polling/async job infra was needed either. **Depends on S4**
  (`SolutionBrief`) — landed and merged.
- [x] **S10 — Execution intents: feasibility resolver + composite actions + ONE server executor.**
  The server-side seam everything else (S11's confirm chip, S12's MCP surface, Telegram) calls into
  to actually start/queue work — not three separate reimplementations of "which of these tasks can
  run right now." Two pieces. **`resolveExecutable(project, tasks, runs, opts)`** (new
  `steward/execution.ts`, PURE) decides, from a caller-scoped candidate list (a feature's tasks, or
  the project's backlog+triage+todo), which are executable and why not for the rest —
  `{eligible, excluded: {taskId, reason}[]}`, `reason` one of `unclear | already-running | done |
  over-budget | not-in-scope`. `done`/`ongoing`/`review` are always excluded (idempotency —
  re-issuing the same directive never double-starts a task with a live or just-finished run);
  archived is `not-in-scope`; `unclear` (a task still parked in `triage` — there's no separate
  boolean, that IS the observable "never came out clear" signal, since the autonomy tick's own
  triage step auto-promotes triage→todo the moment its clarity read comes back clear) fires only
  under `opts.feasibleOnly`. The budget half walks the remaining candidates in PRIORITY order
  (`task.order`, tie-broken by id — the identical sort `tickAutonomy`'s auto-pick already uses)
  accumulating `costBandFor`, marking the remainder `over-budget` once `pacedAvailableUsd` runs out
  — never dropped, still reported, since an over-budget task is still queueable (the tick picks it
  up once budget frees). `pacedAvailableUsd` moved from a private `Orchestrator` method to a pure
  export on `packages/shared/src/budget.ts` (alongside `computeDailySpend`/`costBandFor`, which were
  already there) so the resolver and the tick call the EXACT same calculation — a dry-run's "N over
  budget" can never be a different number than what the tick does moments later.
  **`Operations.executeStewardAction(ws, projectId, action, operatorId, opts)`** is the one executor,
  dispatching on 4 new kinds (`StewardExecutionAction`, a strict zod discriminated union,
  `packages/shared/src/contracts.ts`): `start_task` (direct, single-task `assignTask`, still run
  through the resolver for the SAME feasibility check every kind gets — not a bypass);
  `queue_tasks {taskIds}` (explicit ids, `feasibleOnly` never applied — the caller already decided);
  `start_feature {featureId, execMode: "queue"|"start_now", feasibleOnly}` and `process_backlog
  {feasibleOnly}` (composite — resolve the scope, then either queue every eligible task or, for
  `start_now`, assign up to idle capacity — catching `NoCapacityError`/`RunnerNotConfiguredError`
  specifically to know when to stop assigning and start queuing the rest instead — then queue the
  remainder). Queuing a task (state→`todo` when backlog/triage, `autoPick: true`, and an
  `unassigned` eligibility fixed to `any`) writes directly via `hub.upsertTask`, deliberately
  bypassing `Operations.transitionTask`/`HUMAN_TRANSITIONS` (which has no backlog→todo edge at all —
  that gate is for a HUMAN kanban drag; this is the identical SYSTEM-initiated write the autonomy
  tick's own triage step already makes the same way). **Autonomy fold-in:** queuing is pointless
  with the project's autonomy toggle off — nothing would ever pick the work up — so executing any
  call that queues at least one task turns autonomy on as part of the SAME operation (reported via
  `autonomyEnabled`) rather than making the operator separately confirm a `set_autonomy` action for
  what is conceptually one intent ("start this feature"); chose this over teaching the model to
  propose the two actions together, since it's deterministic and doesn't depend on LLM behavior.
  **Dry-run** (`opts.dryRun`) resolves the identical decision and returns it without calling
  `hub.upsertTask`/`upsertProject`/`assignTask` — `start_now`'s dry-run specifically never acquires a
  runner (real-time fleet capacity can't be previewed without racing it), so it reports every
  eligible task as "would queue," the conservative honest answer. New route: `POST
  /api/projects/:id/steward/actions` (default "author" scope, no auth-guard change needed). The 4
  kinds are also added to `ProjectActionKind`/`AssistantAction`/`validateProjectAction`
  (`steward/assistant.ts`) — same id-resolution + confirm-chip-summary treatment every other kind
  gets — but **deliberately NOT yet in the `SYSTEM` prompt text**: the web dock's `runAction`
  (`steward-dock.tsx`) has a `const unhandled: never = a.kind` exhaustiveness guard and doesn't
  execute these four (they run only through the new endpoint), so teaching Steward's LLM to propose
  one today would let an operator confirm a chip the dock then can't do anything with. Wiring the
  dock to the endpoint (and only then adding these to `SYSTEM`) is S11's job. Verified: 21 tests
  (`tests/execution-intents.test.ts`) — the resolver's exclusion reasons individually (including
  `eligible.length + excluded.length === tasks.length` always holding) and priority-order — plus the
  executor through a REAL `Operations` + `Orchestrator` + `MemoryStore` + stub provider: `queue_tasks`
  makes a backlog task pickable and the NEXT `tickAutonomy` genuinely starts it; `start_feature` on a
  done+ongoing+two-todo feature touches only the two; `start_now` with one idle runner assigns one
  and queues the rest while folding autonomy on; dry-run mutates nothing (asserted on the task AND
  the project record); re-issuing the same composite twice is a no-op the second time (already-running
  / already-queued). Plus 8 new `validateProjectAction` cases (`tests/project-assistant.test.ts`) and
  confirmed the existing `budget-allocation.test.ts`/`daily-budget.test.ts` suites are unaffected by
  the `pacedAvailableUsd` extraction. **Deliberately out of scope, per the task's own sizing:** S7's
  `dependsOnTaskIds` dependency check (the resolver leaves room for it, doesn't implement it); the
  dock UI wiring + richer confirm-chip rendering (S11); the MCP tools + their `dryRun` param (S12);
  Telegram's own action vocabulary (`telegram/intent.ts`) still doesn't call this executor — a
  fourth parallel action path, not touched here, matching "don't churn existing kinds."
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
- [x] **Project header decluttered — Governance popover.** Reported live: the project header's toolbar
  had grown to ~15 same-weight pills (Approvals, Autonomy, Daily budget, Pace spend, Plan mode, Deep
  review, Breaker review, GitHub/Fly account, Keys, Tools, Preview app, Deploy to Fly.io, Inform,
  the gear, Delete) with no hierarchy between primary actions and rarely-touched settings. Seven of
  those — Approvals, Autonomy, Daily budget (+ Pace spend), Plan mode, and Deep review (+ Breaker
  review) — are now bundled behind one `ProjectGovernance` popover (`project.tsx`), reusing the exact
  details/summary idiom the Keys/Tools popovers already established rather than inventing a new
  pattern. The collapsed summary still surfaces the two facts worth seeing without opening it — the
  approval level, and an "Autonomy off" flag — and Full autonomy's existing red "danger" treatment
  stays visible on the collapsed pill itself (`.proj-governance-danger`), not just inside the menu.
  Preview app / Deploy to Fly.io lead the row as the primary actions; Inform active agents / the gear /
  Delete are pushed to a `margin-left: auto` cluster at the row's trailing edge (`.projview-head-admin`)
  so administrative controls read as visually distinct from day-to-day ones, wrapping as one unit on
  narrow widths instead of interleaving. Net: ~15 top-level controls down to about 7. Verified live —
  every toggle's real persistence (including the Full-autonomy confirm dialog and the danger styling),
  the Pace-spend/Breaker-review conditional reveals, and the admin cluster's wrap behavior at mobile
  width — not just reviewed in source.
- [ ] 🏢 Auth: **SSO/OIDC**.
- [x] 🏢 **Read-only (viewer) role** — not every operator should be an admin. A role that can observe
  everything (projects, runs, HITL, audit) but mutate nothing (no assign / resolve / transition /
  settings / provider keys). Wrapped, not rebuilt: `OperatorRecord.role` (`"admin" | "viewer"`,
  `auth/operators.ts`) maps to `Principal.scopes: ["observe"]` at login — a viewer rides the exact
  same `hasScope()` checks a scoped service token already did, no parallel permission system. The
  real work was the audit: `hasScope()` previously ran ONLY inside the MCP layer (`mcp/tools.ts`),
  so every REST mutation route a human hits was actually gated by nothing but "has a session." A new
  classifier, `requiredScope()` (`auth-guard.ts`), now runs in the shared `/api` `onRequest` hook
  (`api.ts`) and requires `"author"` (default) or `"approver"` (HITL resolve + the four merge-decision
  routes) on every non-GET `/api` route — `/mcp` is untouched, it's already gated per-tool at finer
  grain. Web: a `readOnly` flag rides the store (from `GET /api/auth/me`, refreshed across
  snapshot/reconnect); `client.ts`'s `req()` blocks every mutation call client-side BEFORE it reaches
  the network (a friendly toast, not a bare 403), and the Inbox's resolve buttons, Home's "Assign
  work" CTA, and a Settings banner grey out — the server-side gate is the actual boundary, this is
  UX. Dev/test seeds a demo `viewer@cyberdyne.dev` (pw `skynet`) alongside the existing admin pair;
  production gets an equivalent `SKYNET_VIEWER_EMAIL`/`_PASSWORD`/`_WORKSPACE` env seed (mirrors the
  existing admin seed — there's still no invite/user-management UI, so this is the only way to stand
  one up on a hosted deploy today). *(Multi-user — hosted/team only.)*
- [x] 🏢 **Time-limited admin promotion** — temporarily elevate a viewer to admin for a bounded,
  auto-expiring window (break-glass / sudo-style), then revert to their base role automatically; every
  promotion + expiry is audited. Depends on the read-only role above. **Admin-granted, never
  self-service**: an existing admin promotes a NAMED viewer (`POST /api/operators/:operatorId/promote`)
  — there is no "elevate my own session" path at all. Keyed by OPERATOR, not by session token (the
  granting admin has no access to the target's session, and the target may not even be logged in yet):
  a new `ElevationStore` (`auth/elevations.ts`, in-memory) tracks the live grant and is checked by
  `auth.ts`'s `resolvePrincipal()` on EVERY session-resolved request — the same "wherever a Principal
  is resolved" seam session-TTL sweeping already uses — so an expired grant reverts transparently on
  the next request, no manual step, and no backend-specific (Postgres/Redis) plumbing at all (dropped
  entirely from `SessionStore`, which now has no elevation concept — one in-memory store covers every
  session backend). The route's OWN check is what actually closes the self-service loophole: a
  currently-elevated viewer's live `scopes` look identical to a real admin's, so it verifies the
  CALLER's PERSISTED role in the operator directory (`OperatorDirectory.getByIdentity`), not their
  current scope — an elevated viewer cannot re-grant or self-extend, verified explicitly. Every grant
  AND every LAZILY-OBSERVED expiry (sweep-on-access, first request past the deadline) is its own
  audit entry — deliberately NOT folded into the HITL audit trail (`AuditRecord`'s `hitlId`/`runId`
  are structurally required and every existing consumer is keyed to a resolved HITL decision) — with
  no delete/archive route, same as before. Bundled a real pre-existing bug fix along the way:
  `PostgresSessionStore` was silently dropping `scopes` on every resolve (a Postgres-backed viewer
  login would have resolved as full authority) — independent of this feature, fixed regardless.
  Web: a "Access" section in Settings (admin-only, hidden from a currently-elevated viewer even
  though their live scopes would otherwise qualify) lists the workspace's viewer accounts + the
  grant/expiry history and lets an admin promote one; the sidebar's `· Viewer` → `· Admin (Nm left)`
  countdown is unchanged (no button — a promoted viewer's OWN session picks it up on its next
  request, or within ~20s via a light client-side poll while read-only, no reload needed). Verified
  live end-to-end against a real dev server: a viewer's mutation 403s; the viewer itself attempting
  `/promote` on any operator (including itself) 403s; an admin promotes the viewer and the SAME
  viewer token's identical mutation now succeeds mid-window; the now-elevated viewer's OWN attempt to
  promote a second viewer STILL 403s (the persisted-role check firing, not the live-scope one); after
  the window lapses with no action taken, the identical token 403s again while `/api/auth/me` still
  resolves (never logged out); the elevation log showed both the grant and, once observed, its
  expiry — newest first. The Settings "Access" section was confirmed rendering that exact live
  grant/expiry data (roster + promotion history, correctly labeled) end to end.
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
- [x] **Feature-batch size guardrail.** Feature-scoped batching (above) lets one human approval cover
  every task under a Feature — but nothing capped how big that batch could grow, so the single gate could
  quietly become one unreviewable mega-PR. Two layers, both assistive (neither blocks anything): **(1)
  PR-time** — `checkFeatureBatchSize` (pure, `orchestrator.ts`) checks the aggregate diff against
  configurable thresholds (`SKYNET_FEATURE_BATCH_MAX_TASKS`/`_LINES`/`_FILES`, defaults 12/5000/60); past
  any of them the feature PR still opens (blocking it entirely would strand finished work behind nothing)
  but `buildFeatureMergeBriefing`'s risk floors at `"high"` and its rationale names which threshold(s)
  tripped and by how much — the card renders this via the existing structured `MergeBriefing` fields, no
  new UI needed. **(2) Task-link time** — `Operations.updateTask` (the single choke point every "add a
  task to a feature" path funnels through — the UI, Steward's `set_task_feature`, and Telegram all call
  it) fires an assistive note the moment the resulting batch crosses the task-count threshold, well before
  the batch completes, so an operator can split an oversized feature while there's still time. Persisted
  on `Feature.sizeWarning`, fires once (never re-triggers as more tasks pile on past the threshold).
- [x] **Make the one human approval reviewable — feature-level brief.** Approving a 30-task batched
  feature PR off the plain diff card is rubber-stamping or drowning: `Feature.pr.briefing` gains a
  nullable `featureBrief` (`packages/shared/src/contracts.ts`), composed once in `openPrForFeature` right
  alongside the existing heuristic. Everything except the narrative is SYSTEM-composed from data already
  in hand (`composeFeatureBrief`, `apps/server/src/feature-brief.ts`), never asked of the model: a
  one-liner + recorded review verdict per bundled task, the batch's aggregate spend (every sibling run's
  `Usage` summed elementwise — a vendor-omitted `costUsd`/`durationMs` on some runs is excluded from the
  sum, not treated as zero), and an evidence summary (today: the review-verdict tally + whether a verifier
  gate runs after merge; the extension point once real verifier/breaker runs record their own evidence).
  The one genuinely new thing is a consult-drafted `narrative` — what the feature now does AS A WHOLE,
  grounded on the real combined branch diff (`MergeEngine.patch`, mirroring `diffStat`'s no-worktree-
  needed style) via the batch's anchor run's own provider — same stateless, structured-JSON-only
  discipline as the diff walkthrough / per-run merge brief (`draftFeatureBrief`). Best-effort throughout:
  no consult support, no credential, or an unreadable reply all just leave `narrative: null` — the PR
  still opens with the system-composed half of the brief, never blocked on the model. `FeatureMergeCard`
  (`apps/web/src/views/merges.tsx`) renders it collapsed by default (a 30-task card shouldn't force a wall
  of text on everyone) — expand for the narrative, evidence lines, per-task verdict list, and total spend.
  `featureBrief` is nullable + defaulted so a PR opened before this shipped still parses unchanged
  (`tests/file-store-migration.test.ts`). Never drafted for a single-run PR — `buildMergeBriefing`
  hardcodes `featureBrief: null`. Verified with fixture-composed unit coverage
  (`tests/feature-brief.test.ts`) and an orchestrator-level test driving two real tasks through a real
  git batch completion, including a forced consult failure proving the PR still opens
  (`tests/feature-brief-orchestrator.test.ts`).
- [x] **🔬⭐ Autonomous backlog sweep — the v1 path to the auto dev team.** Point Skynet at a whole
  backlog/roadmap under an explicit daily budget and let the fleet build it out unattended: humans
  approve only *completed, working* features, agents test and try to break their own work before a
  human ever sees it, and the fleet replenishes the backlog from what it finds along the way — every
  autonomous loop bounded by construction, never by hope. This is the concrete v1 path toward
  **⭐ North star: the auto dev team** and its **🔗 Product steward & the living Plan** substrate (v2,
  above): Charter → Blueprint → Plan needs exactly this — a fleet that can run unattended for a whole
  work session without drifting, overspending, or silently shipping broken work. It **composed existing
  v1 machinery into five phases — all five now shipped**:
  1. ~~**Budget ceiling.**~~ — **shipped.** `computeDailySpend` (`packages/shared`) rolls per-run
     spend (`TaskRun.usage.costUsd`, nullable when a vendor omits it) into a project's daily total;
     `tickAutonomy`'s auto-pick step (`orchestrator.ts`) checks it before starting another task, so an
     exhausted `dailyBudgetUsd` pauses auto-pick for the rest of the window — never the project's
     `autonomy` toggle itself (see the gate philosophy below — a human can always still assign
     manually). Per-run wall-clock/idle-stall caps (`runtimeCapMs`/`idleCapMs`,
     `runner-sdk/src/caps.ts`) already bound a single run's worst case; this is the same idea one level
     up, in dollars instead of minutes. (`tests/daily-budget.test.ts`)
  2. ~~**Two-lens review: verifier + breaker.**~~ — **shipped, both halves.** Plain `autoReview`
     (`orchestrator.ts`) was a single reviewer-≠-author `consult` call — stateless, text-in/text-out, the
     last 30 log lines as context, **no tool use at all** — enough to judge "does this look right on
     paper" but not to actually RUN the change. The **verifier** lens landed as `Project.deepReview` (see
     **Landed** above): a bounded second agent RUN (not a `consult`) with browser tools, opening a live
     preview of the run's own branch and actually clicking through the change before answering. The
     **breaker** lens landed alongside it as `Project.breakerReview` (see **Landed** above, layered ON
     `deepReview` — requires it): the opposite brief, run only after the verifier approves — try to make
     the change fail (malformed input, edge cases, auth boundaries, concurrent actions) against the SAME
     kind of live preview, reporting only what it actually reproduced. Both compose with (never replace)
     the existing consult-based verdict; a flag from either lens behaves exactly like today's
     `reviewVerdict: flag` — parked in review for a human. Not built: neither lens has a settings UI yet
     (`PATCH /api/projects/:id` only) and breaker findings don't yet auto-create backlog tasks — both
     natural follow-ups, out of scope for the lenses themselves.
  2b. ~~**Feature-level verification — a third altitude.**~~ — **shipped.** The verifier/breaker lenses
     above judge one run's OWN diff; a Feature usually batches several tasks, and nothing checked the
     FEATURE as a whole against what it was actually supposed to deliver — an intake flow that writes up
     an epic → sprints → tasks has no way to verify the epic itself once its tasks are all individually
     done. `Orchestrator.runFeatureVerification` extends the verifier lens one altitude up: same
     mechanics (a bounded second agent, browser tools, no edit tools, the same field-based verdict
     contract) but grounded on the Feature's own description + every sibling task's text/description (the
     "spec"), browsing the live preview of the just-merged integration branch rather than one run's own
     branch. Fires from `completeFeatureMerged` once every sibling task is `done` and the feature branch
     has merged (local-only projects; the GitHub-PR feature path — `mergeReadyFeaturePr` — is a
     deliberate non-goal for now, since a human already reviews that PR before merging), gated on the
     SAME `Project.deepReview` opt-in — no new project setting. A flag holds `Feature.status` back from
     `shipped` (the code stays merged either way — only the ship label is gated) and its findings flow
     through the SAME self-replenishing-backlog path (`processFleetProposals`) a normal review's
     proposals already use, rather than a dead end. No eligible reviewer / verification couldn't run →
     ships as before, same honest-degrade discipline as the verifier lens itself (a best-effort extra
     check, never a new blocking gate). Unlike the per-diff verifier, does NOT exclude the doer as
     reviewer — a multi-task Feature usually has several doers and no single "the" author to exclude, and
     a single-agent project would otherwise never get feature-level verification at all. 4 tests
     (`tests/feature-verification.test.ts`): real git + a real preview process (mirrors
     `deep-review.test.ts`'s harness) driving two real tasks through a shared feature branch —
     `deepReview` off leaves shipping untouched, a passing verdict ships + records browser evidence, a
     flagged verdict withholds shipping and its proposal becomes a real backlog task, and a single-agent
     project still gets verified.
  3. **Circuit breakers + right-sized batches.** Three guardrails, one spirit — an autonomous loop must
     be able to stop *itself*, with no human watching: **(a)** a **session circuit-breaker** — N
     consecutive flagged/failed TASKS on the same project pauses that project's `autonomy` toggle with
     ONE summary escalation, not N separate HITL gates — distinct from the existing PER-RUN retry
     ceiling (`config.runMaxFailures`/`failCounts`, which bounds retries on a single run, never a
     project's whole unattended session); **(b)** ~~a feature size guardrail~~ — **shipped**, see
     **Feature-batch size guardrail** above: caps how large a Feature's auto-picked task batch may grow
     unattended before it forces a human check-in, so a mis-scoped Feature can't silently balloon into a
     week of unattended spend; **(c)** ~~a
     feature-altitude merge brief~~ — **shipped**, see **Make the one human approval reviewable** above:
     one synthesized brief for the whole batched-feature PR, not N per-task ones a human has to mentally
     reassemble.
  4. ~~**Self-replenishing backlog, scope-taxonomied.**~~ — **shipped.** GitHub issue import
     (`Operations.importGithubIssues`) already turned an external backlog into tasks; this closes the
     loop so the fleet writes back to its OWN backlog from what it learns while building. The verdict
     reply (plain consult AND the deep-review run — one shared field-based contract, `review-verdict.ts`)
     may carry an optional `proposals: [{title, why, scope}]` (capped at
     `MAX_PROPOSALS_PER_REVIEW = 3`, malformed entries dropped, never parsed from prose — same discipline
     as the verdict field itself). `orchestrator.ts`'s `resolveProposalPlacement` (pure, unit-tested) is
     the scope-taxonomy valve: **in-scope** (a defect/gap in what the sweep just built) auto-promotes
     straight to `todo`/auto-pickable under the SAME Feature — but ONLY while that Feature is still
     `active`, its sibling-task count is under the feature-batch guardrail (Task 4/§3b above), and the
     project is still under its daily budget (§1 above); any one of those failing degrades it to a parked
     proposal, same as **new-scope** (anything else) always is, full stop — the fleet can *propose* scope,
     it can never *grant itself* scope. Bounded four ways at once, by construction: the per-review cap,
     a `config.fleetProposalMaxPerProjectPerDay` daily ceiling per project (default 10, counts parked
     proposals too — a flood of parked ones is still human triage load), dedup against the project's own
     open task titles (normalized, near-exact — "when in doubt, create parked" is the tie-break, never
     silently drop), and the session circuit-breaker (§3a above) as the last-resort behavioral backstop.
     A parked proposal carries real provenance (`Task.source: {kind:"fleet", byRun, reason, proposedAt}`)
     and a "🤖 fleet-proposed" board badge — never silently indistinguishable from a human-authored task.
     22 tests (`tests/fleet-proposals.test.ts`): field-based parsing (prose ignored, overflow capped,
     malformed entries dropped), every placement branch as a pure decision, and the full path through a
     real `tickAutonomy()` — new-scope parked, in-scope promoted, each of the three degradation paths,
     dedup, and the daily cap.
  5. ~~**Budget as allocation, not just a ceiling.**~~ — **shipped.** `costBandFor`/`committedUsd`
     (`packages/shared`) derive a rough $ signal from triage's already-computed `assessmentEffort` (no
     second estimation call), and `pacedAvailableUsd` spreads the daily budget across
     `config.budgetPacingWindowMs` — opt-in per project via `Project.budgetPacing` — instead of
     committing it all to the first tick; `selectAffordable` (`orchestrator.ts`) then greedily picks
     what fits against the rank-ordered backlog in priority order, without ever reordering it, so
     auto-pick slows down as the ceiling approaches rather than running at full tilt until it hits a
     wall. (`tests/budget-allocation.test.ts`)

  **Gate philosophy, stated once:** budget gates *autonomy* only — a human can always assign a task
  manually regardless of spend; autonomy is a convenience toggle, never the only door. **Scope growth
  needs a human; quality growth is self-serve within budget** — the fleet can spend its already-approved
  budget finding and fixing its own bugs without asking, but it can never expand what it's building
  without asking. Every autonomous loop terminates **by construction** — the budget ceiling (phase 1) is
  the hard stop that needs no judgment call — **plus one behavioral breaker**, the consecutive-failure
  circuit-breaker (phase 3a), for the case a loop is technically under budget but visibly going wrong
  faster than the budget alone would catch.
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

- [x] **⭐ Scenario coverage — "how well does what we built actually work?" per project.** The
  recurring failure mode isn't an untested *file*, it's an untested **cell in a small closed set**:
  both bugs fixed this week were exactly that (escalation `reject` × task-state — [#541](https://github.com/aekdahl/Skynet/pull/541);
  archive × non-terminal run status — [#550](https://github.com/aekdahl/Skynet/pull/550)). Line coverage
  reported both files as covered, because it answers *which statements ran*, not *which behaviours are
  pinned*. New **Coverage** lens on the project page (`apps/web/src/views/project-quality.tsx`) reads the
  project's checked-out branch and extracts its *enumerable behaviour axes* — TypeScript string-literal
  unions and zod enums, the closed sets the code branches on — then crosses every case against the test
  corpus. The analyzer (`apps/server/src/quality/scenarios.ts`) is **pure and string-based**: no
  TypeScript compiler, no install step, and it **never runs the scanned repo's toolchain** — so it works
  on *any* branch of *any* repo (447ms across this whole monorepo: 213 source / 191 test files, 44 axes,
  193 cases) and is safe to point at code an agent just wrote. It picks up a standard
  `coverage/coverage-summary.json` when one exists and says "not configured" plainly when it doesn't,
  rather than rendering a misleading 0%. **The panel leads with gaps, not a score, and says why**: the
  signal is deliberately asymmetric — a case no test *mentions* is strong evidence it's untested, while a
  case that is mentioned proves only mention, not assertion. Presenting a percentage would overclaim the
  weak half, so the UI states the limitation next to the numbers instead of burying it. Found 25 real
  gaps on its first run against Skynet itself (eval `Phase` queued/executing/judging, `BuildStatus`
  queued/ready, `FlyDeployStatus` deploying, …). **Deferred: mutation testing** (Stryker on the diff) —
  the strongest direct answer to "does it work", since it verifies assertions actually *hold*, but it
  needs per-project runner config and real runtime budget, so it's a separate piece of work, not a
  panel that renders in half a second.
  **Tree view** (`packages/shared/src/coverage-tree.ts`, `apps/web/src/components/coverage-tree.tsx`):
  a ranked flat list answers *"what do I fix next"* but dissolves structure — 44 rows can't show that
  the gaps cluster in `evals/`, `preview/` and `settings/` while `orchestrator.ts`, `command-safety.ts`
  and `steward/` are fully pinned. That clustering is what says whether an **area** is understood, and
  it exists only in the hierarchy. Every axis already carries its declaring file, so directory → file →
  axis → case is derivable with no new server work; un-branching chains collapse to one row
  (`apps/web/src`), siblings sort by gap count, and branches leading to a gap start expanded. **The
  roll-ups deliberately fill by GAP and leave "covered" neutral, never green** — a green `38/47` on
  `apps/server/` would read as "this subsystem is tested" when it only means every case is mentioned
  somewhere, and a tree that renders reassurance it hasn't earned is worse than no tree at all.

- [x] **An escalating agent's question actually reaches the operator.** A run that called
  `AskUserQuestion` with an `ESCALATE` header surfaced as a bare *"Agent is blocked — needs a human"*
  banner with **nothing to answer**: the run-detail decision bar rendered only the title, risk chip and
  buttons, so the question itself was reachable only by expanding *Details* — and `buildEscalationRaise`
  (`packages/runner-sdk/src/claude.ts`) threw away the concrete `options` the agent had already written
  down, forcing a human to retype an answer that existed. Found live: an agent correctly reported it
  could find no Kimi adapter in its branch and asked how to proceed, with three options; the operator
  saw a generic blocked banner. Three parts: **(1)** the raise keeps the agent's `options` (and their
  descriptions, in the detail box) and stops duplicating the same paragraph into both `why` and
  `rationale` — which rendered it twice in the detail panel; **(2)** the run-detail bar renders `why`
  directly (clamped, full text still in Details) — the Inbox card already did, so the two surfaces now
  agree; **(3)** picking an option resolves as `modify` with that label as guidance, since
  `deliverEscalation` handles reject/modify/reassign/dismiss only and has no `option` action — exactly
  what typing the same text would do. Also fixes a regression the change would otherwise have
  introduced: the Inbox's `r` (Stop run) shortcut guarded on `it.options`, which escalations now carry,
  silently disabling keyboard-stop for them.

## v1.5 — Ship-the-wedge: onboarding, fluency & Memory v0  ⛓
The staggered slice — make Skynet **decisively easier than the field** and start the moat thin, in
parallel with v1 hardening. (Rivals make you pre-auth each CLI and learn worktrees/tmux; the ease
features below are white space.)

**UX/UI to SOTA (pre-release review — high &amp; polish):**
- [ ] **Text-contrast ramp** (ink / muted / faint, checked ratios — muted currently sits at the reading floor) + a **systematized button/state token set** (primary / ghost / danger, each with explicit hover · focus-visible · disabled · loading).
- [x] **Agent picker at Start** + a saved per-task provider/model preference, and always show which agent a run is on. "Always show which agent" was already live (the kanban card surfaces the run's actual runner/provider·model once assigned). New: a compact provider (+ optional model) select on backlog/todo cards, right at the Start action — persists onto `Task.preferredProvider`/`preferredModel` via the existing `updateTask` path. It's a SOFT hint, never a hard requirement: `Orchestrator.acquireAgent` tries an idle, usable runner on the saved provider (preferring an exact model match) before falling back to today's plain first-idle pick — a preference with no matching idle runner never blocks Start.
- [x] **Structured triage card** (effort pill · full-contrast summary · risks list, not one muted paragraph); **Inbox count badge**; grouped nav (**Operate** / **Configure**).
  *(Inbox count badge was already shipped. Landed: the triage LLM consult's prompt now requests
  `effort`/`risks` alongside the existing `estMinutes`/`clarity` tail tag, parsed the same
  defensive, field-based way as the auto-review verdict (`splitEstMinutesTag`, never regex/
  keyword-classified) — a malformed or missing field never drops the others. `Task` gained
  `assessmentEffort`/`assessmentRisks` as additive, defaulted siblings of the existing
  `assessment` string (which now doubles as the card's summary line), so a task triaged before
  this shipped keeps rendering fine off `assessment` alone — verified live: a real live-browser
  run of the actual triage pipeline landed a task with only `assessment` set (the LLM call's own
  auth failure meant no tag was found) and it rendered as a clean summary-only card, no pill, no
  risks, nothing broken. The happy path (pill + risks) was verified two ways: exhaustively at the
  parser level (new unit tests) and through the real `Orchestrator.tickAutonomy()` pipeline with
  an injected canned reply (new integration tests) — no `ANTHROPIC_API_KEY` was available in the
  sandbox this landed from to get a genuine model-generated reply, so the visual (pill/summary/
  risks rendering) was additionally confirmed with a temporary, since-reverted server-side stub
  of the LLM reply text, screenshotted live in the browser, never committed. `shell.tsx`'s flat
  nav list is now two labeled groups — Operate (Home/Inbox/Audit/Projects/Fleet/Ready to merge)
  and Configure (Integrations/Roadmap/Settings) — reusing the existing `.op-navsec` label style;
  active-item highlighting and routing unchanged (confirmed live).)*
- [x] **Humanized time** + stale-heartbeat styling (no raw "79062s ago"); honest empty-**PLAN** state; **provider identity** (real marks + names, not abstract glyphs).
  *(Investigated first — the raw-seconds text itself was already fixed everywhere: every elapsed/heartbeat/
  waited display in the app (Home's Runs board, task/agent detail, the live-preview freshness label, fleet
  idle time) already routes through `fmtWait` (`lib/derive.ts`), which single-unit-rounds ("42s"/"15m"/"2h"/
  "3d"). What was actually missing: **stale-heartbeat styling** — a `running`/`paused` row's elapsed-since-
  START time keeps growing whether or not the process is still alive, so a silently-hung agent read as
  healthy. Added `STALE_HEARTBEAT_SEC = 60` (Home's `RunsBoard`): 12x the ~5s heartbeat cadence (so ordinary
  jitter never false-flags) but a full two minutes' notice before the server's own reaper
  (`SKYNET_AGENT_REAP_MS`, 180s default) would presume the run dead and escalate it — an amber pulsing dot +
  chip recolor, distinct from the red "needs you" (an open gate) and blue "running" (healthy) tags. **Empty-
  PLAN state** — `TaskDetail`'s PLAN panel showed a misleading "0/0" fraction over a blank `<ol>` for any run
  with `plan: []` (the permanent state for every non-Claude vendor, and the initial state for a fresh Claude
  run); now an honest "No step-by-step plan for this run." **Provider identity** — most surfaces
  (`agent-detail.tsx`, `fleet.tsx`, `project.tsx`'s kb-elig-agent chip) already paired a colored glyph with
  the real vendor name; the one real gap was Home's Runs board, the app's single most prominent live view,
  whose Agent cell showed a bare runner name with no vendor color/mark at all — added the colored glyph
  (`providerInfo`) next to it, vendor name in the tooltip. No new logo assets sourced — reused the existing
  colored-glyph system already used everywhere else rather than risk an unverified trademark usage. Verified
  live: real `fmtWait` call sites confirmed unaffected; the three fixes confirmed visually (synthetic
  markup — no run can exist in this sandbox without a live provider credential, confirmed via a real
  `assignTask` 409 "No credential for any available agent" before any `TaskRun` record is even created).)*
- [ ] **Design tokens published** (type scale, 8px rhythm, motion behind `prefers-reduced-motion`, one focus ring, semantic palette kept separate from the accent); **a11y pass** (icon-button labels, visible focus, keyboard walkthrough of assign→decide→merge); explicit **Inbox-first mobile/PWA shell**.
  *(Partially landed — investigated each clause independently rather than assuming the bundle was all-or-nothing. **Semantic palette** was already separate from the accent (`--ok`/`--warn`/`--danger`/`--info`/`--violet` are distinct hues from `--accent`, per the comment already in `styles.css`) — no action needed. **Inbox-first mobile/PWA shell** was already fully shipped by an earlier, differently-scoped PR (`20b6e91`): standalone/installed launches open straight to the Inbox queue (`pwa/launch.ts`'s `initialView`), the manifest's shortcuts lead with Inbox, and `styles.responsive.css` already restructures the shell for narrow/touch screens with safe-area insets — verified by reading, not re-done.
    **Type scale, published**: `styles.css` had accrued 25 distinct `font-size` values (a deliberate half-pixel ladder for secondary/tertiary text density — e.g. 11.5/12.5/13.5px are the dominant convention, not drift) with zero naming — every occurrence was a bare px literal. Added a `--fz-*` token per distinct value actually in use and mechanically replaced every literal with its token (byte-identical rendering — a lossless catalog, not a renumbering) across `styles.css` and `styles.responsive.css`. New code now has a discoverable set to draw from instead of inventing another one-off size.
    **One focus ring**: audited every `outline`/`:focus`/`:focus-visible` rule against the existing baseline ring (`button:focus-visible` et al.) and the button/state tokens. Found and fixed one real a11y gap (`.cmdk-input:focus` suppressed the outline with no replacement indicator at all — the command palette's search box had no visible focus cue). Consolidated four near-identical, drifted text-input focus treatments (`.qx-input`, `.settings-input`, `.rp-select`, `.adv-input` — one had silently drifted to a translucent accent border, one dropped the outline for a solid one) onto a single new `--input-focus-border` token, and switched them to `:focus-visible` (a plain `:focus` was re-styling on mouse clicks too, not just keyboard). Removed three redundant per-component `outline`/`outline-offset` overrides (`.md-fold-summary`, `.tg-setup-head`, `.prd-phase-summary`) that only repeated the baseline ring under a different name — they now fall back to the shared rule and keep only their own `border-radius` addition.
    **Motion behind `prefers-reduced-motion`**: three looping "still alive" keyframe animations (`rb-flip`, `rb-stale-pulse`, `sk-shimmer`) predated the convention already established for their siblings (`pulse`, `pvpulse`, `pipe-pulse`, …) and weren't guarded — wrapped their `@keyframes` in `@media (prefers-reduced-motion: no-preference)` per that same existing pattern. Left the width-fill progress-bar transitions (`.bar-fill`, `.fleet-task-fill`, `.pf-progress-fill`) and toggle-switch knob slides alone on purpose — `styles.css`'s own top-of-file comment already carves those out deliberately as informational/discrete-action motion, not ambient decoration, and past owners chose not to suppress them; no reason found to override that call.
    **a11y pass**: icon-button labels were already ~99% done by an earlier "9 icon buttons" pass — found and fixed the one remaining gap (`tweaks.tsx`'s dev-panel `✕` close button, now `aria-label="Close Tweaks panel"`). Keyboard-walked assign → HITL decide → merge end to end: assign (`project.tsx`), the Inbox decide flow (`queue.tsx`/`task.tsx`, including the `j`/`k`/`a`/`r`/`m` shortcut layer), and merge (`merges.tsx`) were all already fully keyboard-operable. Found and fixed two real dead ends on the task-card detail path: (1) `.kb-card-tools`' Edit/Archive/Delete/Move buttons only revealed on `:hover`, so tabbing onto one showed nothing — added a `:focus-within` fallback alongside the existing `:hover` one; (2) the read-only task-detail modal (`project.tsx`, no-run cards) didn't manage focus at all — added focus-on-open (the close button), Escape-to-close, and focus-return to the originating card on close, matching the pattern already used by `confirm.tsx`/`command-palette.tsx` elsewhere in this app. Also deleted `.kb-archive`, dead CSS with no matching `className` anywhere in the app, found while working the same hover-reveal selectors.
    **Not done — 8px spacing rhythm**: deliberately scoped out. Unlike font-size, `padding`/`margin`/`gap` values in `styles.css` are not a latent, already-consistent ladder — the file has ~700+ declarations spanning single-digit odd pixel values up to full-panel widths (400px, 288px, …), many clearly fine-tuned per component (icon/text baseline alignment, badge padding) rather than page-rhythm spacing. A faithful "rhythm" pass means actual design consolidation (choosing canonical steps and remapping every declaration onto them), not just token-naming the existing values — and that carries real visual-regression risk across every screen in the app that a single pass can't safely verify: this sandbox has no working browser (Playwright's Chromium is missing system shared libraries — `libglib-2.0.so.0` — and `apt-get update` is blocked here, so no live visual QA was possible this round; verified instead via a full `pnpm -r typecheck` pass and manual diff review). Left as future, deliberately-scoped work rather than guessed at blind.)*

**Easier to use than anyone else:**
- [x] **Repo-optional / chat-only mode** — a runner with **no worktree and no merge**; try Skynet in 30s,
  no git literacy. *(Landed: this was already ~90% built as orchestrator.ts's own pre-existing "Phase 0"
  path — a project with no bound repo (`gitContextFor` resolves `undefined`) already skipped
  `WorktreeProvisioner` entirely and completed via the no-diff/no-merge branch in `complete()`; project
  creation and onboarding never hard-required a repo either. What actually shipped: (1) a real safety
  fix — a chat-only run's `cwd` previously fell through to `config.runnerCwd` (`undefined` by default)
  → every runner-sdk provider's own fallback to `process.cwd()`, i.e. the **server's own working
  directory** — replaced with a private per-run scratch tmp dir (`scratchCwdFor`/`LiveAgent.scratchCwd`),
  minted before start and removed on every teardown path (complete/fail/escalation-reject/stop); (2) an
  explicit, labeled UI choice — a "No repo — chat only" checkbox on Home's `GetStarted` form and a
  matching "Chat only" tab on `NewProjectCard` (previously an empty local-folder field silently, silently
  fell through to no-repo with zero explanation) — plus a "💬 chat only — no repo connected" line on the
  project header so it's never ambiguous why diff-review/merge never show up. Verified live end-to-end
  (real browser, real Cursor CLI attempt — auth failure correctly routed through the existing `fail()`
  path, scratch dir confirmed created then removed) and via `tests/chat-only-run.test.ts`.)*
- [x] **Task linter v0 (assistive)** — *pulled forward from v5:* "vague task → touches 3 modules, split into
  3?"; "no 'done' defined?". The ease differentiator **nobody has** — lowers the skill floor, not just setup.
  *(Landed: a background, fire-and-forget consult right after `createTask`/text-editing `updateTask` — same
  shape as the existing `maybeAutoClone`, never blocks task creation. `task-linter.ts` mirrors
  `review-verdict.ts`'s discipline: reads a structured `{concerns:[{kind,note}]}` field, never
  classifies free text; an unreadable reply parses to `[]`, indistinguishable from a genuinely clean
  task. Cheap by default (`haiku`, `SKYNET_LINT_MODEL` to override). Dismissible via
  `Task.lint.dismissed`, mirroring the existing `dismissPr` pattern. Verified live against a real
  model: a vague task ("fix the thing") surfaced two real concerns; a well-scoped one came back
  clean; dismiss stuck.)*
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
- [x] **Per-project agent instructions (house rules)** — a `Project.instructions` markdown field that rides *every* prompt an agent sees on that project (assignTask, forkAgent, checkpoint restore, decision resume, review-revise, escalation resume, triage consult, auto-review consult) and Steward's grounding, via one shared `withInstructions()` prefix applied to `StartSpec.task` — vendor-neutral, so it reaches CLI runners too without per-vendor code. Motivated by: "build agents in Skynet using a specific subset of packages, pre-written code, and structure" — that's a per-project policy, not a workspace boundary, and it lives on the project record for instant editability. Trims + normalizes empty → null; the read-only header shows a compact "ⓘ Instructions active" chip. *(Re-verified end-to-end — `tests/project-instructions.test.ts` + `tests/instructions-prompt-wiring.test.ts` now pin the orchestrator → StartSpec.task → per-vendor prompt/argv chain, not just the `withInstructions()` primitive.)*
  *(S1 — one shared agent-context assembler: the 10 ad hoc `withInstructions()` call sites above (assignTask,
  fork, checkpoint restore, decision resume, review-revise, escalation resume ×2, triage consult, auto-review
  consult) now all route through one new `buildAgentContext()` (`apps/server/src/agent-context.ts`), which adds
  `Project.goal` (a `=== PROJECT ===` section, name + goal, omitted when the goal is empty) and — when the task
  belongs to one — its **Feature**'s name + description (`=== FEATURE ===`), resolved via a `store.getFeature`
  lookup that tolerates a missing record. Sections emit in a fixed order (project → instructions → primer →
  feature → solution brief → in-flight → task) and are individually omitted when empty; `withInstructions()`
  itself is unchanged (kept as the small no-op-when-unset primitive `tests/project-instructions.test.ts` pins
  directly) and re-exported from `orchestrator.ts` for that test's import path. `primer`/`brief`/`siblings`
  fields are already on the signature for the not-yet-built S2 (primer doc) / S3 (in-flight siblings) / S8
  (Solution Brief) sections — those land data-only, no further plumbing. Bounded to a ~6k total-char budget
  with per-section caps; over budget, in-flight siblings drop first, then the primer's tail is shaved —
  `Project.instructions` and the task body itself are never truncated. Regression-proofed (stashed the
  orchestrator wiring, confirmed the new assertions fail, popped it back): `tests/agent-context.test.ts` (pure
  unit — section order/omission/truncation), `tests/agent-context-wiring.test.ts` (real git worktrees — goal +
  feature actually reach the relaunch prompt at checkpoint-restore / review-revise / escalation-resume), and
  new cases in `tests/project-instructions.test.ts` (assignTask/forkAgent goal + feature threading, on top of
  the existing instructions-threading cases).)*
  *(S3 — sibling-awareness digest: `buildSiblingDigest()` (`apps/server/src/sibling-digest.ts`) is a pure
  derivation — no LLM — over the ongoing/review siblings, last-5 recently-merged runs (`mergedAt`, newest
  first), and top-3 queued-up-next tasks (`order`) on the SAME project, plus a fixed steering line ("prefer
  building on it over duplicating it; flag genuine conflicts via escalation"). Wired into S1's `siblings`
  field at the genuine "an agent is starting FRESH" call sites only — `assignTask`, `fork`, and
  `relaunchEscalated` (covers both reassign and escalation-relaunch via its own `reassign` flag) — via one
  shared `siblingDigestFor` helper; deliberately NOT wired into continuation paths (checkpoint restore,
  review-revise) where the agent already has full context of its own prior turns. Snapshot-at-start only,
  never a live feed (the `inform` seam is the mid-run path — out of scope here). Hard-capped at ~1.2k chars,
  dropping content in priority order (queued → merged → the ongoing/review tail) while the steering line
  always survives. Also bumped S1's own per-sibling cap in `agent-context.ts` from 200→1200 chars, since this
  produces ONE combined digest string rather than many independent one-liners (S1's own `agent-context.test.ts`
  pins behavior, not the literal cap value — unaffected). `tests/sibling-digest.test.ts` (11 pure unit tests —
  empty-project, excludes-own-task, cross-project isolation, merged-recency ordering, queued `order` ordering,
  the ~1.2k cap and its drop priority) + `tests/sibling-digest-wiring.test.ts` (3 orchestrator tests — a busy
  sibling reaches the real `StartSpec.task` at assign and fork time, and a solo project renders no
  `=== IN FLIGHT ===` section at all). Regression-proofed (removed the implementation, confirmed all 14 new
  tests fail, restored it).)*
- [x] **Project Context — meeting notes/emails/docs, condensed into the S2 primer** — the operator can paste or
  upload raw context (meeting notes, an email, a doc) on a project's new **Context** tab; Skynet reads it verbatim
  (`ProjectContextEntry` — never edited by the model, source + date kept, delete + re-add if wrong) and runs one
  LLM pass (`apps/server/src/steward/context.ts`'s `condenseProjectContext`, mirroring S5 crystallize's
  stub-injected-`ask` pure-function shape) to distill the accumulated set into `Project.contextSummary` — the
  short primer `agent-context.ts`'s `buildAgentContext` was already reserved for as "S2" (see S1 above) but never
  had a data source. Every call site picks it up with **zero extra plumbing**: `buildAgentContext` now falls back
  to `project.contextSummary` whenever a caller doesn't pass an explicit `primer`, and Steward's own grounding
  (`steward/assistant.ts`) reads the identical field, so an agent's task prompt and "ask about this project" both
  ground on the same digest. Upload extracts text server-side by extension (`steward/extract.ts`: `.txt`/`.md`
  verbatim, `.pdf` via `pdf-parse`, `.docx` via `mammoth` — a first file-upload capability for the app, gated by a
  new `@fastify/multipart` registration capped at 15MB/1 file) — an unrecognized type throws a clear, user-facing
  error rather than storing garble. Add/upload/delete all re-condense automatically (deleting the last entry
  clears the summary back to null, never leaving a stale one); a manual "Regenerate" re-runs it on demand. A real
  gap found live-testing this against a dev box with no usable provider key: `oneShotText`'s one-shot consult
  DEGRADES an auth/network failure into yielding its own error text rather than throwing (`streamQueryText`'s
  by-design "never leave the caller with nothing" contract, shared by `stewardChat`/`crystallizeBrief`) — with no
  guard, that error text would land in `contextSummary` looking like a real (if useless) summary. Fixed by
  checking whether a usable key resolves at all BEFORE calling condense (`Operations.refreshProjectContext`) — a
  structural, non-content check, not the keyword/shape classification of free text the auto-review APPROVE/FLAG
  bug already burned this codebase on once; skipped only for the real default ask, never an injected test stub.
  Verified live end-to-end in the browser (paste → raw entry lists correctly; the no-key case leaves the summary
  cleanly empty instead of showing the degraded text; Regenerate/Delete both clean) and via a real multipart
  `curl` upload against the running dev server (both a `.txt` success and an unsupported-type rejection).
  `tests/project-context.test.ts` (15 tests: the pure condensation contract, extraction, and the full
  Operations-layer add/upload/delete/refresh path against a real store+hub with a stubbed model reply) +
  `tests/contracts.test.ts` (wire round-trip) + new cases in `tests/agent-context.test.ts` (the S2 fallback:
  explicit `primer` still wins, omitted falls back to `contextSummary`, both-unset omits the section).
- [x] **Per-project isolation for credentials & GitHub identity** — a project can pin its own **LLM credential** so runs on that project bill to that key (add-a-key UI + agent pinning), and its own **GitHub PAT** so PRs open under the right account regardless of workspace default. Complements the roadmap's "work spend to the business" story without a new workspace boundary.
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
  *Landed: **response-size fix** — `list_agents`/`list_tasks`/`list_audit`/`get_snapshot` were returning
  full records (a run's entire tool-call log, a task's full assessment/lint text, an audit record's
  captured diff patch) for every row, so listing scaled with workspace history rather than what the
  caller asked for — one real deployment's `list_agents`/`list_tasks` became unusable at ~50 runs / 100
  tasks. Now summary/detail-split like the rest of the product: list_* return compact, paginated
  (`limit`/`offset`, default 30/cap 200) summaries excluding archived by default; two new tools,
  `get_task` and `get_audit`, fill the drill-in gap for a single record's full detail (mirroring the
  existing `get_agent`); `get_agent`'s log itself now defaults to the most recent 100 entries
  (`logLimit`/`logOffset` to page further back) so even a single long-lived run can't blow the budget.*
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
- [x] **⭐ Open the format — openness is the second moat.** Publish a versioned, human-readable, git-committable
  **open memory spec** (align with / extend `AGENTS.md`-style conventions) so the memory is a *substrate,
  not a new silo*. Openness is the adoption + trust lever — users only pour knowledge into something they
  can't be locked out of — which makes Skynet the default hub. The durable moat then shifts to *curation
  quality + the accumulated personal corpus + being the hub*, not owning the format (the git → GitHub play).
- [x] **⭐ Memory as an MCP server** — expose the brain over MCP so **any** agent or tool can read/write it, even
  *Landed: [docs/memory-format.md](docs/memory-format.md) — spec v0.1. `.skynet/memory/` holds Markdown
  files (workspace/project/area/agent-family scoped), YAML frontmatter for file-level metadata, one `##`
  section per fact with an inert HTML-comment metadata line (id/source/author/created/confidence/
  supersedes), append-only editing so `git log` stays a meaningful record. Format-only: no reader/writer,
  MCP server, or runner-sdk injection ships here — those stay separate, unbuilt roadmap items below.*
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
