# Skynet — Roadmap

**How to read this:** Skynet ships in versions. **v0 (MVP) is the only committed scope**; later
versions are directional and will be reordered as we learn. Deep detail for big features lives in
`docs/` briefs. The principle behind every entry: **wrap, don't rebuild** — Skynet is the
management/memory/leverage layer over off-the-shelf coding agents, not an agent itself
(see [docs/positioning.md](docs/positioning.md)).

Shipped work is archived, not deleted — see **[ROADMAP-ARCHIVE.md](ROADMAP-ARCHIVE.md)** for every
`[x]` item retired out of this file, condensed and grouped by version. `[ ]` = not started,
`[~]` = partially landed (the entry says what shipped and what's still open), `[x]` = done (lives
only in the archive now).

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
2. **Cross-vendor consensus runs** (v1.5, landed): same task on 2+ providers, auto-diff, and an eligible
   fleet agent peer-reviews the siblings and picks a winner (a human still confirms unless the project
   is autonomous) — keep/merge follows automatically.
3. **Prompt-injection / tool-poisoning firewall** (v1, landed): gate tool calls steered by untrusted content the
   agent read (issue / web page / dependency). The category's first agent-security layer.
4. **Provably-improving fleet** (v5): measure which memory + task phrasings one-shot vs. churn, promote
   the winners, and show the user the curve.
5. **Compliance evidence pack** (v1, landed): one-click signed "AI change report" — every AI-authored change +
   who approved + why + the policy at the time (EU AI Act tailwind).
6. **Org-wide knowledge diffusion** (v1 mass-inform + v4): one teammate's decision instantly informs
   every teammate's agents.

**Recommended near-term order (re-prioritized now that provider breadth + the governance wedge are both
largely shipped)** — ship in this order:
**(1) Security + reliability debt** — the 7 Aug-2026 security findings and the task-write-atomicity race
are both *confirmed, pre-existing* issues (one already caused real data loss) with broad blast radius;
close these before anything else compounds on top of them. **(2) Memory v0** (nothing has shipped here
yet, and it's the wedge that keeps us from being "just another orchestrator") — **Cross-vendor consensus
runs**' fan-out+diff+merge has now landed; only the peer-review half remains. **(3) v1.5 ease-of-use** (the remaining
operator-ergonomics/design-token tail) **+ desktop code-signing** (the last GTM
blocker on the committed release — mac auto-update silently no-ops without it). Provider breadth and the
Governance-to-SOTA launch wedge — the prior #1/#2 here — are both essentially done; see
[the archive](ROADMAP-ARCHIVE.md). Everything below stays directional.

**Current batch priority order** — see [docs/operating-memo.md](docs/operating-memo.md) §8 for full rationale.
Items are ranked PMF > Platform > Product within each batch:

| Batch | # | Item | Track |
|-------|---|------|-------|
| **N (now)** | 1 | 🔒 Security hardening — Aug 2026 audit remediation (7 findings, see v1 section) | Security |
| | 2 | ✅ 🐛 Task-write atomicity — fixed, PR #649 (see v1 section) | Reliability |
| | 3 | ✅ Cross-vendor consensus runs — fan-out+diff+merge+peer-review, all landed | Platform |
| | 4 | Memory v0 — operator-authored facts, injected per project | Platform |
| | 5 | deep-review / breaker-review settings UI toggle (both already built, PATCH-API-only today) | PMF |
| | 6 | Mass inform — Fleet/Project UI (multi-select + whole-project) | Product |
| | 7 | First-run onboarding telemetry (anonymous install events) | PMF |
| **N+1** | 1 | Memory v0 — decision-derived fact capture from `hitl_audit` | Platform |
| | 2 | Desktop code-signing (macOS + Windows) — engineering done, blocked on certs | GTM |
| | 3 | Preview Phase 2 — service-container runtime + auto-rebuild on merge | Product |
| **N+2** | 1 | Memory v0 — workspace-scoped MCP read/write server | Platform |
| | 2 | Autonomy telemetry dashboard (ZTMR, HITL volume, resolution time) | PMF |
| | 3 | Plan entity + project view panel (Product Steward foundation) | Platform |

Legend: 🔬 = needs an LLM / open research · 🔗 = has a design brief · ⛓ = depends on earlier version ·
🏢 = hosted-only (deferred; **not** needed for the local desktop release).

---

## v0 — MVP · the local desktop app  ✓ shipped

**Goal:** an operator installs the **desktop app**, points it at a repo + their Anthropic key, assigns
a task, and a **real Claude agent** does the work in an isolated worktree under human supervision, then
merges — all **local-first, on their own machine**.

**Scope:** Claude-first · **local-first desktop app** (BYO key, single operator, file-store persistence,
keys never leave the machine). **Hosted / multi-tenant is out of scope** (🏢 deferred — see below).
**Done =** the full loop runs on a **packaged desktop build** (beta, unsigned) on an operator's own
machine. All 11 must-build items shipped — see [the archive](ROADMAP-ARCHIVE.md#v0--mvp--the-local-desktop-app)
for the list. Code-signing is the one deferred piece, split to v1.

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

## v0.5 — UX release polish (pre-release · from [docs/ux-review.md](docs/ux-review.md))  ✓ shipped

Findings from the July 2026 end-to-end audit. All 12 P0/P1 items landed — see
[the archive](ROADMAP-ARCHIVE.md#v05--ux-release-polish) for the list. (P2/P3 items from the same
audit are slotted into v1 / v1.5 below.)

---

## v1 — Orchestration completeness & hardening

61 items from this section have shipped and moved to
[the archive](ROADMAP-ARCHIVE.md#v1--orchestration-completeness--hardening), including the whole
Momentum Board rebuild (TASK 00-14), the cross-project decision backbone + Global Decision Inbox, the
autonomy dial + persisted circuit breaker, the roadmap document parser/governance system, the
competitor-sweep review upgrades (verifier gate, auto-review, deep review-as-run, breaker review,
guided understand-then-merge), and the Solutioning layer (S1-S10: SolutionBrief → decompose → thread →
Crystallize). What's still open or partially landed:

Ordered by priority (urgent bug → launch-wedge remainder → product debt → GTM/infra → hosted-deferred):

- [x] **🐛 Task-write atomicity — no optimistic concurrency, confirmed real data loss.** Fixed
  (PR #649, `reliability/task-write-optimistic-concurrency`). Reported live (2026-08): a batch
  task-update lost `description` on 7 tasks (a genuine PATCH-semantics footgun, mitigated separately
  with tighter MCP tool guidance). The deeper issue found during recovery — every one of the 25+
  `upsertTask` call sites across `orchestrator.ts`/`operations.ts` did a non-atomic read-modify-write
  (fetch → spread → write the whole record back, no version/etag check), unsafe once autonomous writers
  (triage, auto-review, the self-replenishing backlog) run concurrently with human/scripted edits on the
  same record — is closed: `Task.version` (shared contracts) is now checked-and-incremented atomically
  at the Store layer (`Store.putTask(task, expectedVersion?)`, a real CAS in both `MemoryStore` and
  `PostgresStore`, throwing `VersionConflictError` on a stale write; mapped to HTTP 409 at the API
  layer), and every update call site now routes through one shared retry helper,
  `Hub.patchTask(id, patch, opts?)`, which re-reads and re-applies (function-form patches/guards
  re-evaluate against the fresh value, not blindly reapply) on a version conflict, up to `maxRetries`.
  `tests/task-write-concurrency.test.ts` reproduces the actual incident deterministically (a delayed-
  store harness controlling write interleaving) and proves the final record carries both concurrent
  writers' fields — the old pattern would have silently dropped one. Scoped to `Task` only (confirmed
  the only two `Store` implementations were migrated); generalizing the same pattern to other entities
  was deliberately left for a second confirmed incident rather than fixed pre-emptively.
- [~] **⭐ Governance to SOTA (the launch wedge — already the white space; make it best-in-class).**
  Nearly all landed: policy-as-code command policy, budget ceiling + cost-aware allocation/pacing,
  context-aware (blast-radius) risk classification, the prompt-injection/tool-poisoning firewall,
  tamper-evident hash-chained audit + NDJSON export, the compliance evidence pack (signed, one-click),
  MCP push notifications for new HITL gates, `approve-with-rule` (writes a standing `ApprovalRule`) and
  `approve-with-memory` (in-flow `Resolution.memoryNote` capture). **Remaining:** policy-driven gate
  *batching* (similar gates, one decision) and Steward-side approve-in-flow; async/mobile/delegated
  approval + escalation SLAs + a 2-person rule for high-risk gates; 🏢 hosted observability + SIEM export.
- [~] **Deeper runner-capability surfacing** — pull more native capability through the `runner-sdk`
  seam. Landed: real plan steps, token/cost telemetry, a Claude plan-mode HITL gate, token-by-token
  streaming (Claude/Gemini/Cursor), a per-project `disallowedTools` deny-list, structured diffs in
  review, and Copilot's move to real structured-event dispatch. **Remaining:** a full `allowedTools`
  allow-list (the safer deny-list landed first, on purpose), `settingSources` (CLAUDE.md) support, and
  token streaming for Codex/Copilot (neither exposes a chunked wire format to stream from).
- [~] **Mass inform** — select multiple agents (or a whole project) and attach a note that rides the
  *next* prompt each already receives, no extra turn. Shipped: the `inform` interaction type
  (`POST /api/runs/inform`), live-session push for Claude, buffered-note delivery for the CLI runners
  (Codex/Gemini/Hermes/Cursor). Copilot doesn't implement it yet. **Remaining:** the Fleet/Project UI
  (multi-select on Fleet, whole-project on the project page); optional "also remember" → area/workspace
  memory promotion is still v4, not started.
- [~] **Remaining providers behind `runner-sdk`.** Codex, Gemini, Cursor, Copilot, Hermes, OpenCode,
  and Kimi Code are all landed as real `CliRunnerProvider`s (usage/cost telemetry, argv/env wiring,
  live-verified against each vendor's current CLI). Reactive breadth from the candidate list
  ([docs/runner-catalog.md](docs/runner-catalog.md)) stays open-ended — no fixed target, lowest urgency
  now that the field-trailing gap this closed is gone.
- [x] **UI system polish (P2 of [docs/ux-review.md](docs/ux-review.md)).** Landed: untangled
  `--accent`/`--warn` (were an accidental hex duplicate), a real Lucide-based nav icon set, motion
  tokens (`--motion-fast`/`--motion-base`), a real `:active` press state + a global `:focus-visible`
  fallback, 9 missing icon-button `aria-label`s + 4 `aria-expanded` toggles, and all 4 named
  legibility-floor violations (the folder-picker hint was the last holdout). The two pieces deferred
  for their own PR are now in too: purposeful two-column layouts for Fleet (roster left, an aggregate
  utilization/cost-by-provider panel right) and Integrations (a real catalog grid, not a 640px-capped
  single column); and a full sweep of the ~90 remaining `--faint` usages — text that carries meaning
  (costs, counts, attribution, table headers, status/hint copy) moved to `--muted`, pure decoration
  (carets, dismiss icons, timestamps, disabled marks, placeholders, structural dividers) stayed
  `--faint`, matching the standard v0.5's "Legibility floor" sweep set.
- [~] **🔗 Per-project live preview — "see what it builds", any software.** Phase 1 (web/sites) shipped:
  project + per-run preview managers, descriptor→heuristic→agent-assisted recipe resolution
  (`.skynet/preview.json`), refresh-on-merge, and a resizable split-screen dock ⇄ modal reachable from a
  phone via a `/p/<token>/` reverse proxy (Host-rewrite, HMR bridged). **Remaining:** Phase 2 (a
  service-container runtime + auto-rebuild on merge, for apps with a server/API, not just static sites)
  and Phase 3 (command/artifact preview kind — "run it and show the result", for non-web software).
  Full design: [docs/live-preview.md](docs/live-preview.md).
- [~] **🔁 Task ↔ source-of-truth sync.** Tasks imported from an external source should update the
  source when their Skynet status changes. Phase 1 (done): GitHub issues import + status writeback.
  Phase 2 (done): repo checklist files (`- [ ]` items import as tasks; completing one checks the box,
  committed via the GitHub Contents API). **Remaining:** Phase 3, external/webhook sources
  (Linear/Jira) + optional two-way sync. Full design: [docs/task-source-sync.md](docs/task-source-sync.md).
- [~] **Desktop code-signing & notarization** *(split out of v0 #9, which ships beta unsigned)* — sign
  the macOS build (Apple Developer ID + hardened runtime + entitlements + notarization) so Gatekeeper
  opens it cleanly and **mac auto-update works** (it silently no-ops on an unsigned build today); sign
  the Windows build (code-signing cert) to clear SmartScreen. **Engineering done** (PR #488): mac
  `hardenedRuntime`/entitlements/`notarize` block + win `nsis` target in electron-builder config, CI
  secret-passthrough (`.github/workflows/desktop-release.yml`) for both cert pairs, docs in
  [apps/desktop/README.md](apps/desktop/README.md#releases--auto-update). Verified no repo secrets are
  set yet (`gh secret list`), so builds still ship unsigned. **Blocked on:** an operator obtaining an
  Apple Developer ID cert (Apple Developer Program enrollment, $99/yr) + a Windows code-signing cert
  and adding both as repo secrets — a paid/human step, not engineering. Last remaining GTM blocker on
  the committed release.
- [ ] 🏢 **Scale + containerized runner:** Redis multi-replica fan-out; **GKE Jobs for runners** — one
  container per agent, completing the v0 sandbox item's deferred half: memory/CPU caps (cgroups) and a
  network egress allowlist (proxy). The command-deny, worktree write-confinement, and runtime cap
  already ship locally. Hosted-only — not needed for the local desktop release.
- [ ] 🔗⛓ **Structural agent-hierarchy hooks** — `role`, `familyOf`→root, worker→manager merge (cheap,
  additive; from [docs/agent-hierarchy.md](docs/agent-hierarchy.md)). Cheap groundwork for v2; not
  urgent on its own since nothing consumes it yet.
- [ ] 🏢 Auth: **SSO/OIDC**. Hosted-only — not needed for the local desktop release.

### 🔒 Security hardening — Aug 2026 audit remediation

Full-codebase security audit of `main` (8 finder agents by area + a skeptical filtering pass per
candidate finding, confidence ≥ 8/10 kept) surfaced 7 real, independently-confirmed vulnerabilities —
none introduced by any in-flight PR, all pre-existing on `main`. Grouped as one epic because they share
urgency (credential exposure, path traversal, auth escalation — governance-track trust, not feature
work); the 7 have no ordering dependency and can ship in parallel.

- [ ] **Redact GitHub token from push/sync error logs** — `pushBranch`/`syncBase`
  (`apps/server/src/github/provider.ts`) embed the token in the git remote URL with no try/catch,
  unlike the sibling `cloneRepo` which already redacts; a push/fetch failure's raw error message (which
  embeds the token) reaches `hub.runLog()` and broadcasts live to the operator's UI. Fix: apply
  `cloneRepo`'s `redactToken()` pattern to both; consider generic scrubbing at the `runLog` layer too.
  *Severity: High. `apps/server/src/github/provider.ts:258-264,348-352`.*
- [ ] **Contain `roadmapPath`/`repoPath` reads to the project's own repo** — an "author"-scoped
  `PATCH /api/projects/:id` can set `roadmapPath`/`repoPath` to an arbitrary filesystem path with zero
  containment check, and `GET /api/projects/:id/roadmap` then returns that file's raw content. Fix:
  resolve the joined path and reject unless it stays within `repoPath` (the codebase already has this
  exact pattern in `preview/route.ts` — reuse it).
  *Severity: High. `apps/server/src/steward/docs.ts:50`, `apps/server/src/operations.ts:2351-2422`.*
- [ ] **Strip secrets from the Fly static-site build environment** — `FlyDeployManager.start()` runs a
  repo-declared build command with the server's full `process.env` (every provider key,
  `SKYNET_MASTER_KEY`, the GitHub App private key, the Telegram bot token), reachable pre-merge via a
  normal "Deploy to Fly.io" click on a run's own branch. The sibling live-preview path already solved
  this (`PREVIEW_ENV_DENYLIST`/`previewEnv()`) — the Fly path never adopted the wrapper. Fix: pass
  `previewEnv()` into `deploy.ts`'s `ensureDeps`/`runToCompletion` calls.
  *Severity: High. `apps/server/src/fly/deploy.ts:233,235`.*
- [ ] **Stop same-origin preview iframes from exposing the session token** — both preview surfaces set
  `sandbox="allow-scripts allow-same-origin ..."` while serving agent-built content on Skynet's own
  origin by default, so injected/malicious in-preview JS can read `localStorage`'s session token for a
  full session hijack. Fix: drop `allow-same-origin`, or refuse to boot the preview proxy without a
  genuinely distinct origin; longer-term, move the session token out of `localStorage`.
  *Severity: High. `apps/web/src/components/preview.tsx:47`, `apps/web/src/views/project.tsx:2275`.*
- [ ] **Bring `.skynet/preview.json` build/install commands under the command-safety gate** — the
  live-preview `install` step always runs unsandboxed, and `dev`/`start` only sandboxes behind an
  off-by-default flag (and even then it's write-confinement only, not a real boundary). This executes
  agent-branch content (plausibly prompt-injected) via the pre-merge preview path, entirely outside the
  `command-safety.ts`/`injection-firewall.ts` gates applied elsewhere. Fix: route through the same
  bounded-execution/scrubbed-env discipline, and make the sandbox mandatory for `install`.
  *Severity: High. `apps/server/src/preview/worktree.ts:39-45,71-76`.*
- [x] **Close the elevated-viewer permanent-token loophole.** `POST /api/service-tokens`'s
  `requireHuman()` checked only the live, elevation-inflated `scopes` value (`undefined` = full
  authority) — identical to a real admin's, and identical to the exact loophole `requireAdmin()`'s own
  doc comment already named for the promote route. A viewer riding an active break-glass elevation could
  mint a standalone, independently-stored bearer token with a high scope set and no forced expiry,
  outliving the elevation that authorized minting it. Fix: `requireTokenManager` (replacing
  `requireHuman`, all 3 routes) looks up the caller's PERSISTED role via `operators.getByIdentity` —
  never trusts live scopes, mirroring `requireAdmin` exactly — and additionally recognizes an active
  elevation (`principal.elevatedUntil` still in the future) so break-glass access to token management
  isn't shut out entirely (a genuinely non-elevated viewer never reaches these routes at all: the
  workspace mutation-scope gate, `auth-guard.ts`, already requires "author" scope for POST/DELETE before
  this file runs, which a plain `scopes:["observe"]` session never has — GET carries no such gate, so
  this check is what protects it too, confirmed by reading `requiredScope()`). A real persisted admin's
  request is completely unaffected (`ttlMs: null` = no forced expiry still honored verbatim); a caller
  who reaches the mint route only via elevation gets a MANDATORY, non-optional TTL: their requested
  `ttlMs` (or `null`, the old exploit's move) is always clamped to whatever remains of THEIR OWN
  elevation window (`Math.min(requested, elevatedUntil - now())`), so a minted token can never survive
  the specific grant that authorized minting it — closing exactly the "survives past the elevation's
  lapse" gap named in the finding, not just narrowing it to a fixed ceiling that could still outlive an
  elevation minted early in a long window. Regression-guarded end-to-end against a real Fastify app +
  real stores (`tests/service-token-elevation-loophole.test.ts`, mirrors `admin-promotion.test.ts`'s own
  pattern for this exact class of bug): a plain non-elevated viewer refused on all 3 routes (baseline,
  still correct); a real admin's no-forced-expiry mint unaffected; an elevated viewer's mint always
  returns a real, non-null, correctly-clamped `expiresAt` — including when it deliberately over-asks for
  more than its remaining window; list/revoke also gated uniformly; the same viewer refused again the
  instant its elevation is forced into the past; a scoped service token still can never manage other
  tokens (the pre-existing no-self-escalation guarantee, unaffected). Stashed the fix, confirmed exactly
  the 2 TTL-ceiling assertions fail against the original code (everything else — including the
  unrelated self-escalation guarantee — still passed, a precise regression proof rather than a blanket
  one), restored.
  *Severity: High. `apps/server/src/auth/routes.ts:216-252`.*
- [ ] **Validate `path` against traversal in the GitHub Contents API calls** — `getFile`/`putFile`
  concatenate the Contents API URL with no `..`-segment rejection, so a crafted `path` can retarget the
  request at a different repo; `import_repo_file` (an MCP tool, nominally project-confined) and
  `resync_source`/`commitRepoFile` both replay it unvalidated, giving a write leg too. Fix: reject any
  `path` containing a `.`/`..` segment before it reaches `getFile`/`putFile`
  (and `readRepoFile`/`listRepoRoot`), and percent-encode each segment individually.
  *Severity: High. `apps/server/src/github/provider.ts:211-231`, `apps/server/src/mcp/tools.ts:514`.*

Two related findings landed just under the confidence bar (≥8 kept; these hit 7) and are tracked as
**follow-ups**, not blocking: unescaped `.skynet/preview.json` fields interpolated into the generated
Fly `Dockerfile`/`fly.toml` with no sanitization (needs a crafted, not naive, payload to matter); and
the review-verdict auto-merge prompt splicing unsanitized synced-GitHub-issue-title text into the
reviewer LLM's prompt with no source-trust gate (reachable only with public issue sync + autonomy on).

---

## v1.5 — Ship-the-wedge: onboarding, fluency & Memory v0  ⛓
The staggered slice — make Skynet **decisively easier than the field** and start the moat thin, in
parallel with v1 hardening. (Rivals make you pre-auth each CLI and learn worktrees/tmux; the ease
features below are white space.) 10 items from the original UX/ease list have shipped — see
[the archive](ROADMAP-ARCHIVE.md#v15--ship-the-wedge-onboarding-fluency--memory-v0).

Ordered by priority — Memory v0 first (nothing shipped there yet; consensus runs are now fully
landed), then remaining ease-of-use work, then the lowest-urgency UI polish tail:

**Memory v0 (thin moat, pulled forward from v4):**
- [ ] Operator-authored + **decision-derived** facts (every `hitl_audit` "decided X because Y" becomes a memory
  fact), scoped (workspace / project / area / agent), injected into any vendor via the `runner-sdk` seam, and
  **exportable/owned** (git-committable). No LLM distillation yet (that's v4) — but it makes launch
  not-just-another-orchestrator and starts the corpus compounding on day one. **Nothing here has shipped
  yet — highest-priority open item in this version.**

**⭐ Cross-vendor consensus runs (signature bet):**
- [x] Fire the same task at 2+ providers in parallel, each in its own worktree off the same base
  commit, auto-diff the results, and keep/merge the winner — landed (`Orchestrator.startBakeoff`,
  `TaskRun`/`Task`/`HitlItem.bakeoffId`, the "Bake-off ⇉" board action + N-way comparison view). The
  vendor-neutral seam is what makes true cross-*vendor* bake-offs possible (rivals' "councils" are
  single-tool). **Peer-review now also landed**: an eligible non-participant fleet agent
  (`Orchestrator.autoJudgeBakeoff`) compares every sibling's diff summary and picks a winner —
  ALWAYS records `Task.bakeoffVerdict` as an audit trail (an unreadable reply flags for a human,
  never guesses), and only auto-resolves the pick when the project is autonomous, same lever
  `autoReview` already uses. A human can still force it on demand ("Judge now") or just pick manually
  — the agent's recommendation is shown, never forced.

**Easier to use than anyone else:**
- [~] **Project assistant → co-operator (actions from chat).** Steward (the shared brain,
  `apps/server/src/steward/`) has landed with 15+ project/task actions (add/move/rename/archive/reorder/
  schedule/etc.), workspace-wide focus resolution, streaming replies, and **batch actions** (one input
  proposes up to N actions, approved together with overflow reporting) — every proposed action is still
  validated server-side and gated by the control-flag/a HITL, never model-trusted. Also landed:
  `Project.roadmapPath` so the Roadmap tab (and Steward's own grounding) can point at any repo-relative
  file, not just `ROADMAP.md`. **Remaining:** broader action coverage (fleet ops, credentials) +
  Telegram parity on the newer actions.
- [~] **Chat → canvas handoff, zero cold start** — a reply can carry a deep link straight into the exact
  web-app view (project/task pre-focused) instead of cramming it into a chat bubble. **Desktop half
  shipped:** a `skynet://` OS protocol handler (`app.setAsDefaultProtocolClient`), handling both macOS's
  `open-url` event and Windows/Linux's argv-based launch, translating onto the existing hash route with
  no login wall since the app is already running locally as the single operator. **Hosted/GCP path (🏢
  deferred, untouched):** still needs a short-lived signed-token exchange, since that's the one case
  that actually needs to establish a session from a cold click.
- [~] **Operator ergonomics (P3 of [docs/ux-review.md](docs/ux-review.md)).** Landed: the **⌘K command
  palette** (fuzzy-navigate or approve the most recent pending gate), the **keyboard-first Inbox**
  (j/k/↵/a/r/m, a dismissible shortcut hint bar), **cost/usage roll-ups** (project header, per-runner
  Fleet badges, "$0" vs. "vendor doesn't report" distinguished), and **OS notifications + dock badge**
  (Electron IPC bridge, live pending-HITL count, click-to-focus). **Remaining:** Timeline lens depth
  (zoom, brush, click-through) — unscoped.

**UX/UI to SOTA (pre-release review — high & polish, lowest urgency of this version's open items):**
- [ ] **Text-contrast ramp** (ink / muted / faint, checked ratios — muted currently sits at the reading
  floor) + a **systematized button/state token set** (primary / ghost / danger, each with explicit
  hover · focus-visible · disabled · loading).

## v2 — Agentic area-managers (the hierarchy)  🔬🔗⛓
Per-project LLM **area managers** decompose an area's goal and spawn first-class **worker subagents**
via a `spawn_worker` tool; risk-based escalation; worker→manager→project merge.
[docs/agent-hierarchy.md](docs/agent-hierarchy.md)
- [ ] 🔬 The decomposition is **LLM planning** — Skynet supplies the area goal + module map + the
  `spawn_worker` tool, surfaces a `plan` HITL, and spawns workers on approval. The model does the "how."
- [ ] **Managers organize by area *or* role** — same mechanism, different scope: a "Billing manager"
  (module area) or a "Review / QA / Security manager" (function). Role-managers are how specialized
  agents are arranged; workers under them inherit the role's prompt + tool scope.
- [ ] **Agent-to-agent handoff on feature completion** — when a Feature reaches `shipped`, or a
  milestone flips to `shipped`, the orchestrator fans out to configured **role-agents**: a
  **change-manager** commits the CHANGELOG.md entry (HITL-gated diff), a **docs-writer** updates
  user-facing docs from the feature's task descriptions + diff, a **release-comms** agent drafts the
  announcement. Each handoff is a directed variant of `mass-inform` (v1) — a fresh scoped brief, still
  gated end-to-end. **The joinpoint already exists** (`feature.upserted`/`milestone.upserted` with
  `status:"shipped"` are real events today); v2's work is turning them into a configurable role-agent
  fan-out map per project.
- [ ] **⭐ North star: the auto dev team.** The endgame of the hierarchy is **Charter → Blueprint →
  Plan**: project intake is an LLM-assisted **Charter** (goals, non-goals, risks, done-definition —
  human-approved, G-1); from it Skynet proposes a **Team Blueprint** (Chief of Staff, Spec Analyst,
  Architect, Area Leads, Developers, QA, Security, Scribe, Memory Curator) sized to the project and
  hired with **one human approval (G0)**; the CoS then **auto-proposes the initial plan** — epics →
  milestones → tasks with dependency order and honest estimate ranges (calibrated by retro actuals,
  never fabricated deadlines). Work runs through a gated pipeline (spec → plan → build → verify →
  review → secure → merge → document → learn) where the blueprint may delegate *who holds* a gate but
  never remove one, and **nothing self-approves**. **All of it BYOK**. The concrete v1 path here is
  **Autonomous backlog sweep** (shipped, see archive): budget-gated unattended building, verify-and-break
  review, and a self-replenishing backlog are exactly the "run a whole session without drifting or
  overspending" primitives this endgame needs.
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
supervision layer, it doesn't host or resell those services. 3 items shipped (the enabling
inbound-trigger primitive, Skynet as an MCP server, GitHub Issues two-way sync) — see
[the archive](ROADMAP-ARCHIVE.md#v3--triggers--integrations).
- [ ] **Tools via MCP:** an agent gets scoped tools (GitHub / Sentry / Slack MCP) to act back into the
  user's services. A "Sentry agent" = a coding agent + Sentry MCP + a Sentry webhook trigger.
- [ ] **Feedback-loop responders (route back to the *originating* run)** — a CI failure, a PR review comment, or a
  merge conflict re-engages the **same** agent that produced the branch (self-healing), not a fresh run.
  *(Agent Orchestrator-style; ties directly to the responders below.)*
- [ ] **Interop surface (adopted)** — beyond `/mcp`, expose the fleet via an **OpenAI-compatible endpoint + REST**
  so external tools can drive it as a model/service. *(claw-orchestrator-style; broadens who can call Skynet.)*
- [ ] **Candidate responders:** Sentry regression → fix PR · GitHub issue → PR · PR review · CI-failure
  fix · Dependabot/CVE patch+fix · PagerDuty/Datadog incident triage · support ticket → bug task.
- [ ] Tier-2 API agents (Devin, Jules — see runner-catalog) plug in here as delegated remote workers.

## v4 — Moat Layer: Portable cross-vendor memory (M1)  🔗
User-owned memory that no single vendor can match, because everything streams through Skynet.
[docs/positioning.md](docs/positioning.md) §3.2. 2 items shipped (the open memory spec, and the memory
spec's file format) — see [the archive](ROADMAP-ARCHIVE.md#v4--moat-layer-portable-cross-vendor-memory).
- [ ] Cross-vendor, long-lived, **portable/exportable**, scoped (workspace / project / area / family).
- [ ] **Manage repo-native memory too:** read/write/sync **`CLAUDE.md`, `.cursor/rules`, Copilot
  instructions, etc.**, and project Skynet's portable memory into each vendor's native format.
- [ ] Injection via the vendor-agnostic `runner-sdk`; sourced from the streams + `hitl_audit` already
  flowing through the `hub`.
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
- [ ] **⭐ Provably-improving fleet (signature bet)** — the **outcome feedback loop**: measure which memory
  facts + task phrasings one-shot cleanly vs. churn through HITL, auto-promote the winners, and **show the user
  the curve** ("your fleet is measurably better this month"). Nobody in the field measures outcomes; it makes the
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
