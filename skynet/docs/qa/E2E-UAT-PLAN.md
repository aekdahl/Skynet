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
   critical path over HTTP + browser, assert on responses and rendered UI.
3. **UAT scenarios (per feature):** operator-story acceptance against the criteria each
   workstream defined ("Done when …").
4. **Exploratory + regression:** re-run the matrix below; log defects in §5.

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

### DEF-001 — Decision Audit view is stale after in-session resolves — **Sev: Medium**
- **Feature:** #6 Decision audit trail (`apps/web/src/views/audit.tsx`).
- **Repro:** boot seeded; open Inbox; Approve an item; open Audit.
- **Expected:** the just-resolved decision appears in the Audit list.
- **Actual:** view shows the previous count (e.g. API `/api/audit` = 2, view shows 1);
  a full page reload reconciles it (view = 2).
- **Evidence:** `viewMatchesApi:false` on resolve; `reconciled:true` after reload.
- **Diagnosis:** backend, persistence, and idempotency are correct — the record is
  recorded and served. The view's live-refresh trigger (keyed off the queue's
  resolved-count) doesn't reliably re-fetch after an in-session resolve.
- **Impact:** audit is a review/compliance surface; showing stale/missing recent
  decisions is misleading (no data loss — a reload fixes it).
- **Suggested fix:** re-fetch `/api/audit` on the `hitl.resolved` WS event (or on view
  focus), rather than deriving refresh from the queue resolved-count.

## 6. Coverage gaps / next up (Day 2+)

1. **UI round-trip regression** for DEF-001 once fixed.
2. **Secrets** set/rotate/encryption E2E (needs `SKYNET_SECRET_KEY`).
3. **Real agent → diff → merge → PR** E2E with `SKYNET_INTEGRATION_REPO` (+ GitHub App).
4. **Redis bus** cross-replica fan-out (two server replicas).
5. **Postgres** store + sessions E2E locally (docker compose).
6. **Onboarding, PWA install/offline, Desktop** smoke passes.
7. **Real provider runners** (Claude/Codex/Gemini/Cursor/Copilot) with credentials.
8. Per-view SPA smoke for Projects/Fleet/Integrations/Settings.
