# Skynet — Parallel Workstreams

How we parallelize the build across **4–6 engineers + the core lane**. Each lane works
**behind a stable interface** so streams don't collide. Hand each lane to one person; they
own their branch and files end-to-end.

> **What's already built (don't redo):** the monorepo, `packages/shared` contracts +
> event stream, `apps/server` (Fastify API + WS snapshot/deltas, `Store`/`Bus` interfaces,
> orchestrator), `apps/web` (ported SPA + typed client), Postgres `Store` adapter, workspace
> scoping + token auth, the Claude runner spike, and the git merge engine. See
> `README.md`, the briefs, and `docs/vcs-and-conflict-model.md`.

---

## Rules of engagement (keep it collision-free)

1. **Only the Core lane edits `packages/shared/`** (the contract spine). If your stream needs
   a new field/type, request it — Core pre-lands it (see *Core pre-work* below) so you never
   touch `shared`. This is the single most important rule.
2. **Add new files; don't rewrite shared ones.** Your stream owns *new* modules behind an
   existing interface. The small wiring into shared files (`orchestrator.ts`, `hub.ts`,
   `index.ts`, `App.tsx`) is done by **Core** or via a tiny, pre-agreed hook — call it out in
   your PR so Core merges the wiring.
3. **Branch naming:** `ws/<id>-<slug>` off `main` (e.g. `ws/w1-redis-bus`). One stream per branch.
4. **Definition of done (every stream):**
   - `pnpm -r typecheck` clean and `pnpm --filter @skynet/web build` green.
   - The default dev path still works: `RUNNER=mock STORE=memory pnpm dev` (your feature is
     opt-in via config/env until wired).
   - Stream-specific acceptance criteria below are met and demonstrated.
5. **Interfaces are the contracts between us.** `Store` (`store/store.ts`), `Bus` (`bus.ts`),
   `RunnerProvider` (`runner-sdk/src/types.ts`), `MergeEngine` (`merge.ts`), `auth.ts`. Read
   the reference implementation named in your stream before starting.

---

## Core lane — owned by the core dev (Claude)

Integration-sensitive, spine, and the things that unblock everyone else.

- **`packages/shared` contract changes** — the only place the wire is defined.
- **Orchestrator lifecycle + merge queue + worktree-per-runner provisioning**
  (`orchestrator.ts`, `merge.ts`) — real per-agent git worktrees feeding the merge engine.
- **Claude runner auth unblock** — get the nested Agent SDK authenticated so live execution
  (and thus W2's real provider runs) lights up. Currently 401 in headless.
- **Wiring** delegated modules into `orchestrator.ts` / `hub.ts` / `index.ts` / `App.tsx`.

### Core pre-work (do FIRST — unblocks streams without them touching `shared`)
Pre-land these additive contract fields/types in `packages/shared` so dependent streams start clean:
- `Agent.previewUrl: string | null` → **W5** (live preview)
- `AuditRecord` type + `Snapshot` stays as-is; add a `GET /api/audit` response type → **W8**
- confirm `Dependency` (exists) + add `Agent.dependsOn?: string[]` if W4 needs explicit edges → **W4**
- `Store.listAudit(workspaceId)` signature + stub in both adapters → **W8** (Core adds signature; W8 fills endpoint+view)

---

## Lane A — Realtime & Auth (BE)

### W1 · Redis Bus adapter
- **Seam:** `Bus` (`apps/server/src/bus.ts`). **Reference:** `InProcessBus` in the same file;
  `store/postgres.ts` for the "adapter behind an interface, selected by config" pattern.
- **Owns (new):** `apps/server/src/bus.redis.ts` (`RedisBus implements Bus`).
- **Scope:** per-workspace channels (`event:<workspaceId>`) via Redis pub/sub; publish/subscribe
  mirror `InProcessBus`. Select via `BUS=redis` (config slot exists; compose provides Redis).
  Core wires the `index.ts` one-liner that picks the impl.
- **Done when:** with `BUS=redis`, two server replicas behind the same Redis both push a
  workspace's deltas to their own sockets; `BUS=memory` unchanged.

### W6 · Auth hardening
- **Seam:** `apps/server/src/auth.ts` (`resolvePrincipal`, `tokenFrom`). **Reference:** the dev
  token map there now.
- **Owns:** session/SSO behind the same `resolvePrincipal` shape (cookie or OIDC), plus a
  workspace/operator store. Keep `AUTH_REQUIRED` semantics.
- **Done when:** real login issues a token that resolves to `{workspaceId, operatorId}`;
  unknown/expired → 401; the dev-token path still works for local dev.

---

## Lane B — Provider runners ①  (BE)
### W2a · Codex runner · W2b · Gemini runner
- **Seam:** `RunnerProvider` (`packages/runner-sdk/src/types.ts`). **Reference:** `claude.ts`
  (real) and `mock.ts` (shape) — copy the structure exactly.
- **Owns (new):** `packages/runner-sdk/src/codex.ts`, `gemini.ts` (one each), each exported as a
  subpath like `@skynet/runner-sdk/claude` (`package.json` `exports`).
- **Scope:** implement start/pause/resume/message/stop + the event callbacks; map each vendor's
  approval gate to `onHitl` (kind `approval`). Selected via `RUNNER=codex|gemini`; Core wires
  `orchestrator.getProvider()`.
- **Done when:** with the provider selected, an assigned task drives real log/progress/HITL
  events through the existing orchestrator (auth permitting); falls back cleanly otherwise.

## Lane C — Provider runners ② + Preview (BE/infra)
### W2c · Cursor runner · W2d · Copilot runner
Same spec as Lane B for `cursor.ts`, `copilot.ts`.

### W5 · Live-preview pipeline
- **Seam:** `Agent.previewUrl` (Core pre-lands) + web `components/preview.tsx`.
- **Owns (new):** `apps/server/src/preview/*` — per-agent-branch deploy URL / built artifact /
  render service; set `previewUrl` + the existing `visual` flag.
- **Done when:** a visual project's agent surfaces a real, sandboxed preview URL the SPA iframes;
  non-visual agents keep folding the panel away.

---

## Lane D — Derived intelligence (BE)

### W3 · Module map + diff→module derivation
- **Owns (new):** `apps/server/src/modules-map.ts` — load `.skynet/modules.json` (glob→module)
  from the target repo (per `docs/vcs-and-conflict-model.md` §3); map an agent's changed files
  → module ids. Core wires it into `Store.listModules` / agent module derivation.
- **Done when:** `agent.modules` is derived from real changed files; absent map → seed fallback.

### W4 · Server-side conflict + dependency computation
- **Owns (new):** `apps/server/src/derive/conflicts.ts`, `derive/deps.ts`. Fork-aware families
  (collapse via `parentId`), overlapping touched modules → emit `conflict.detected`; derive task
  dependencies → power Timeline gating. Core adds the hub trigger.
- **Done when:** `conflict.detected` / dependency edges are computed from live activity (not
  seed); matches the client-side derivation the UI shows today, then supersedes it.

---

## Lane E — Frontend platform (FE)

### W7 · Routing / deep links
- **Owns:** URL sync for the router state in `apps/web/src/App.tsx`
  (`view`/`lens`/`projectId`/`agentId`) — shareable links + back/forward. **You own App.tsx
  routing**; coordinate with Core on any structural shell change.
- **Done when:** every view/project/agent/lens is a shareable URL; reload restores it.

### W9 · PWA / mobile
- **Owns (new):** web app manifest + service worker + responsive passes; Inbox-first install.
- **Done when:** installable PWA, offline shell, push entry-point into the Inbox.

---

## Lane F — Audit & Quality (FE + cross-cutting)

### W8 · Decision audit-trail view
- **Seam:** Core pre-lands `Store.listAudit(workspaceId)` + `AuditRecord` type. `hitl_audit`
  already persists (who/what/when/payload) in `store/postgres.ts`.
- **Owns (new):** `GET /api/audit` in `api.ts` (small, workspace-scoped) + `apps/web/src/views/audit.tsx`
  + a sidebar entry.
- **Done when:** resolved HITL items are reviewable after the fact, scoped to the workspace.

### W10 · Test + CI harness
- **Owns (new):** Vitest setup + first tests (contracts round-trip, `Store` adapters, merge
  engine, HITL idempotency) + `.github/workflows/ci.yml` (typecheck + build + test).
- **Done when:** `pnpm test` runs green locally and in CI on every PR.

---

## Sequencing & dependencies

- **Start now (no blockers):** W1, W3, W4, W6, W7, W9, W10, and the provider-runner files
  (W2a–d) — runner *adapters* compile and integrate in mock mode immediately.
- **Soft-blocked on Core pre-work** (a few hours): W5 (`previewUrl`), W8 (`listAudit`/`AuditRecord`).
- **Live provider execution** (W2a–d running for real) lights up once Core lands the **Claude
  auth unblock** + **worktree-per-runner** — but that does NOT block writing/merging the adapters.

## Suggested assignment (6 devs + Core)
A: W1 + W6 · B: W2a + W2b · C: W2c + W2d + W5 · D: W3 + W4 · E: W7 + W9 · F: W8 + W10 · Core: spine, lifecycle, auth-unblock, wiring.
(For 4 devs, fold C→B and F→E.)
