# Skynet — Mission Control

A fleet-supervision console for running coding agents in parallel. Operators don't
edit files — they resolve human-in-the-loop (HITL) stops (approve / reject / modify /
decide / diff-review) so agents never stall.

This is the integrated build of the prototype + the three integration briefs in
`../Project Skynet DRAFT/`. It's a **TypeScript monorepo shipped as one Docker
Compose stack**, per the Architecture & Distribution brief.

```
skynet/
├─ apps/
│  ├─ web/        # React + Vite SPA (the prototype, ported)
│  └─ server/     # Fastify API + WebSocket gateway + orchestrator
├─ packages/
│  ├─ shared/     # ◀ entity + event contracts (zod) — the frontend/backend spine
│  └─ runner-sdk/ # provider-agnostic runner interface (+ mock runner)
├─ docker-compose.yml
└─ Dockerfile     # multi-stage: build web → served by the server image
```

The `shared` package is the spine: both apps import the same zod-validated entity
and `ServerEvent` types, so the wire contract can't silently drift.

## Run it

### Local dev (hot reload)

```bash
pnpm install
pnpm --filter @skynet/shared build      # build the contract package first
pnpm --filter @skynet/runner-sdk build
pnpm dev                               # server on :8080, web on :5173 (proxies /api + /ws)
```

Open http://localhost:5173. The Vite dev server proxies `/api` and `/ws` to the
API server on :8080.

### Self-host (one command)

```bash
cp .env.example .env     # provider keys + secrets (optional for Phase 0)
docker compose up        # app (web+api+ws) + postgres + redis
# → open http://localhost:8080
```

## Status — Phase 0 (Foundations) is running

What works today, end-to-end:

- **Persistence + read API** — four collections (agents, queue, projects, fleet)
  plus tasks/modules/deps/providers, behind a `Store` interface. Phase 0 ships an
  in-memory implementation seeded from the prototype's data; a Postgres adapter
  drops in behind the same interface.
- **Connect-time snapshot + deltas** — `GET /api/snapshot` and a WebSocket at `/ws`
  that pushes a full snapshot on connect, then typed `ServerEvent` deltas. This
  replaces the prototype's two client-side simulation loops.
- **The HITL round-trip** — `POST /api/hitl/:id/resolve` is idempotent and
  first-writer-wins; the decision is delivered to the agent and resumes it.
- **Agent lifecycle (mock)** — assigning a task acquires an idle runner, starts an
  agent (mock runner: canned plan + simulated log + one HITL gate), and frees the
  runner on completion. The server-side busy-runner retire guard is enforced.
- **CRUD** — projects, tasks, and fleet runners, each persisted + broadcast.

### Configuration (`.env`)

| Var      | Phase 0 default | Notes                                          |
|----------|-----------------|------------------------------------------------|
| `STORE`  | `memory`        | `postgres` selects the durable adapter         |
| `BUS`    | `memory`        | `redis` fans out across multiple app replicas  |
| `RUNNER` | `mock`          | `claude` (real execution) lands in Phase 1     |

## What's next (see `../Project Skynet DRAFT/ROADMAP.md`)

- **Phase 0 finish:** Postgres `Store` adapter + Redis `Bus` adapter (interfaces exist).
- **Phase 1:** real provider runners behind the `runner-sdk` interface (Claude Code first).
- **Phase 3:** compute conflicts (fork-aware module families) & dependencies from real activity.
- The two hardest open problems — the **git merge / conflict-ownership model** and
  **delivering decisions mid-stream into heterogeneous provider CLIs** — still need
  their own design pass before Phase 1.
