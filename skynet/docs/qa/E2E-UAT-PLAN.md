# Skynet — E2E & UAT Plan

Owner: E2E Test & UAT Manager · Living document · v1 (Day 1)

Skynet is a fleet-supervision control plane: operators resolve human-in-the-loop
(HITL) stops while coding agents run in parallel. This plan defines how we verify
the whole system end-to-end — from the API/WS control plane through the SPA — and
tracks feature coverage and defects.

## 1. Scope & environments

- **System under test:** `main` (integrated build, all workstreams merged).
- **Layers:** monorepo `skynet/` — `apps/server` (Fastify API + WS + orchestrator),
  `apps/web` (SPA), `packages/{shared,runner-sdk}`.
- **Environments**
  - **CI gate** (`.github/workflows/ci.yml`): install → build packages → typecheck →
    build apps → `vitest run` (with a Postgres service).
  - **Local E2E**: `STORE=memory BUS=memory SESSIONS=memory` server + built SPA,
    driven over HTTP + a headless browser.
  - **Durable/scale** (Postgres/Redis, GitHub App, real provider runners): partially
    covered by unit contracts; full E2E requires external credentials (see gaps).

## 2. Strategy

1. **Automated gates (every PR):** typecheck, build, unit/integration tests. Merge-blocking.
2. **Integrated E2E smoke (per release candidate):** boot the real server, drive the
   critical path over HTTP + browser, assert on responses and rendered UI. See
   `docs/qa/e2e-smoke.sh`.
3. **UAT scenarios (per feature):** operator-story acceptance against the criteria each
   workstream defined ("Done when …").
4. **Exploratory + regression:** re-run the matrix below; log defects in §5.
5. **LLM-driven exploratory (nightly / pre-release, non-blocking):** autonomous LLM
   "driver" agents pursue open-ended persona goals against a live seeded server; an LLM
   "judge" scores each run. Finds interaction bugs no fixed script would try. See
   `docs/qa/llm-e2e/`. Confirmed findings become deterministic Vitest regressions.

**Entry criteria:** CI green on the candidate.
**Exit criteria:** all P0/P1 scenarios PASS; no open Sev-High defects; gaps documented.

## 3. Traceability matrix (feature → E2E scenario → status)

Legend: ✅ verified today · 🟢 covered by automated tests · ⚠️ partial / needs creds ·
⬜ not yet exercised · 🐞 defect open (see §5)

| # | Feature (source) | E2E / UAT scenario | Day-1 status |
|---|---|---|---|
| 1 | Server boot + explicit config (#40) | Boots only with STORE/BUS/SESSIONS set; `/health` reports them | ✅ |
| 2 | Auth + sessions (W6, #9/#15) | no-token→401; login→token+httpOnly cookie; `/me`; logout→401; bad creds→401; dev token works | ✅ (8/8) |
| 3 | Workspace isolation | cyberdyne sees seed; resistance isolated (0) | ✅ |
| 4 | Realtime snapshot + WS deltas | SPA connects under auth, renders seeded snapshot; live status bar | ✅ |
| 5 | HITL resolve + idempotency (#? , hitl.test) | resolve→200; re-resolve→200 first-writer-wins; unit idempotency | ✅ + 🟢 |
| 6 | Decision audit trail (W8, #5) | backend records who/what/when/payload; `/api/audit` newest-first | ✅ backend; 🐞 **DEF-001** view staleness |
| 7 | Provider catalog + secret availability (#13) | `/api/providers` lists 5 with `available` flag | ✅ |
| 8 | Per-workspace secrets, encrypted (#13) | set key → provider becomes available; encrypted at rest | ⬜ (needs encryption-key env; set/rotate flow untested) |
| 9 | Merge engine + worktree-per-runner (#11, merge.test) | merge, serialized conflict escalation, checks-fail rollback | 🟢 (unit, incl. real git); ⚠️ full agent→diff→merge E2E untested locally |
| 10 | Runners: mock + 5 providers, fail-loud (#39, runner-failure.test) | mock runs canned plan; real runner missing→needs-attention (no silent success) | 🟢 + ✅ mock; ⚠️ real providers need creds |
| 11 | Live preview pipeline (W5, #8/#12) | visual agent → sandboxed built artifact iframed; non-visual folds away | ✅ (verified in W5 sessions); ⬜ not re-run on `main` today |
| 12 | Store adapters: memory/file/postgres (#33, store.test) | contract suite across adapters | 🟢 memory/file; ⚠️ postgres skipped locally (CI covers) |
| 13 | Bus: memory/redis (W1) | single-process vs cross-replica fan-out | ✅ memory; ⬜ redis fan-out untested locally |
| 14 | GitHub integration + safety (#36/#38, github-safety.test) | connect App, one-repo-per-project, safety preflight | 🟢 safety unit; ⚠️ connect/PR flow needs App creds (PRs #47/#48 open) |
| 15 | SPA views: Home/Inbox/Audit/Projects/Fleet/Integrations/Settings | render + navigate, no console errors | ✅ Home/Inbox/Audit; ⬜ Projects/Fleet/Integrations/Settings not individually smoked |
| 16 | Onboarding wizard (#14/#44/#46) | first-run setup; re-run from Settings | ⬜ |
| 17 | PWA / mobile (#7/#25) | installable, offline shell, push→Inbox | ⬜ |
| 18 | Desktop app (Electron) (#34/#45) | boots on hardened config; installer/auto-update | ⬜ (separate build) |

## 4. Day-1 execution results

**Automated gate (CI parity), `main` @ 9ba3595:**
- install (frozen) ✅ · build packages ✅ · typecheck ✅ (4 projects) · build apps ✅
- `vitest run`: **37 passed, 4 skipped** (6 files). Skips = Postgres store-contract
  (no local `DATABASE_URL`; CI runs them against a PG service).

**Integrated E2E smoke (server + SPA, auth on, seeded):** 19/19 API assertions PASS
(auth 8, isolation 2, HITL+audit 5, idempotency 1, providers 2, boot 1). SPA boots,
connects over WS under auth, renders seeded fleet/queue/projects with no console errors;
Home, Inbox, and Audit views render.

**1 defect found:** DEF-001 (below).

## 5. Defect log

### DEF-001 — Decision Audit view stale after in-session resolves — **Sev: Medium — ✅ FIXED (PR #50)**
- **Feature:** #6 Decision audit trail (`apps/web/src/views/audit.tsx`).
- **Repro:** boot seeded; open Inbox; Approve an item; open Audit within ~1s.
- **Actual (before fix):** the just-resolved decision was missing; `/api/audit` had it,
  the view didn't, until a reload. Intermittent race between the view's mount-fetch and
  the record landing server-side.
- **Root cause:** the view fetched once on mount and re-fetched only on queue
  resolved-count change; opening Audit right after a resolve raced with no retry.
- **Fix (PR #50):** merge the fetched history with decisions resolved live in-session
  (from the store queue, kept current by the `hitl.resolved` WS event, which the server
  publishes *after* `recordAudit` → race-free). Verified: resolve → open Audit after
  150ms now shows it immediately; typecheck + 37 tests + build green.
- **Note:** the user's start-of-Day-2 "fixed" belief was not reflected on `main` (no fix
  commit/branch) and the repro still failed — this PR is the verified fix.

### DEF-002 — Agent chat returns a misleading canned reply for *running* agents — **Sev: Medium**
- Found by the LLM operator-persona run. `POST /api/agents/{id}/messages` on a `running`
  agent returns `200 {"reply":"This agent has finished; follow-up chat isn't supported…"}`
  — the same string for running and done agents. Misrepresents live state.
- **Suggested:** branch the reply on agent status, or return a clear "chat not wired to a
  live runner" signal in this config.

### DEF-003 — Re-assigning an already-assigned task double-spawns and orphans an agent — **Sev: High**
- Found by the LLM admin-persona run. `POST /api/projects/{id}/tasks/{tid}/assign` on a
  task that already has an agent creates a **second** agent on another runner, overwrites
  `task.agentId`, and orphans the first agent (still `waiting`, still in
  `project.agentIds`, its runner stuck `busy` with no task pointing at it). Leaks runners
  and agents.
- **Expected:** idempotent no-op or `409` when the task is already assigned.
- **Suggested:** precondition-check task state in `assignTask` (reject/no-op if
  `assigned`/`done`). Encode as a deterministic regression once fixed.

### DEF-004 — Runner creation doesn't validate model against the provider — **Sev: Medium**
- Found by the LLM admin-persona run. `POST /api/fleet/runners {"provider":"gemini","model":"opus-4.8"}`
  returns `200` and creates a nonsensical pairing (`opus-4.8` is a Claude model). Same gap on PATCH.
- **Suggested:** validate `model ∈ provider.models` (from the provider catalog) → `400` otherwise.

### DEF-005 — No state guard when assigning a `done` task — **Sev: Low**
- Related to DEF-003; the assign endpoint performs no task-state precondition. Fold into the DEF-003 fix.

### DEF-006 — `?token=` query param takes precedence over the Authorization header — **Sev: Low (hardening)**
- Found by the LLM adversary run. Query-string tokens leak via access logs / history / Referer.
- **Suggested:** restrict `?token=` to the WS upgrade handshake; prefer header/cookie for REST.

### DEF-007 — Auth hook prefix match is case-sensitive (`/API/…` skips it) — **Sev: Low (latent)**
- Found by the LLM adversary run. `startsWith("/api")` misses `/API/…`; today it only reaches the
  SPA static handler (no API data leaks), but it's a footgun if a data-bearing static route is added.
- **Suggested:** lowercase the path before the prefix check.

*No security defects found:* the adversary run confirmed workspace isolation (404-on-foreign-resource,
no cross-tenant read/mutate/leak), auth fails closed under `AUTH_REQUIRED=true`, logout invalidates,
HITL resolve is first-writer-wins, and all malformed input → 4xx (no 500s).

## 6. Day-2 execution results

**Re-verification:** DEF-001 re-tested on `main` — **still reproduced** (no fix had landed).
Diagnosed + fixed in **PR #50**; verified the just-resolved decision now shows immediately.
Regression gate re-run green (typecheck; 37 tests pass; web build).

**LLM-driven exploratory run** (`docs/qa/llm-e2e/`) — three autonomous personas drove the
live seeded server (`:8093`, auth on):
- **operator** (HITL lifecycle): all four resolve actions + audit verification + idempotency
  + 5 edge cases PASS. Found **DEF-002** (misleading chat reply).
- **admin** (empty-workspace bring-up): project→task→runner→assign→agent + edit/delete +
  ~10 edge cases; validation/401/404/409 solid. Found **DEF-003 (High)** and **DEF-004**.
- **adversary** (auth/tenancy/inputs): 21 probes, **no security defects** — isolation,
  fail-closed auth, logout invalidation, first-writer-wins, and 4xx-not-500 all hold.
  Two low hardening notes → **DEF-006/007**.

Net new defects from Day 2: 1 High, 2 Med, 2 Low (see §5). The LLM run found interaction
bugs (double-assign orphaning; stale chat state) that the deterministic suite did not.

## 7. Coverage gaps / next up (Day 3+)

1. **Fix + regress DEF-003 (High)** double-assign, then DEF-002/004; add deterministic
   Vitest cases mirroring the LLM findings.
2. **Secrets** set/rotate/encryption E2E (needs `SKYNET_SECRET_KEY`).
3. **Real agent → diff → merge → PR** E2E with `SKYNET_INTEGRATION_REPO` (+ GitHub App).
4. **Redis bus** cross-replica fan-out; **Postgres** store + sessions E2E (docker compose).
5. **Onboarding, PWA install/offline, Desktop** smoke passes.
6. **Real provider runners** (Claude/Codex/Gemini/Cursor/Copilot) with credentials.
7. Per-view SPA smoke for Projects/Fleet/Integrations/Settings.
8. Wire `test:llm-e2e` into a **credentialed nightly** job (non-blocking).
