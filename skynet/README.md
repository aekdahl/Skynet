# Skynet — Mission Control

A fleet-supervision console for running coding agents in parallel. Operators don't
edit files — they resolve human-in-the-loop (HITL) stops (approve / reject / modify /
decide / diff-review) so agents never stall.

A **TypeScript monorepo shipped as one Docker Compose stack**. The current release
is **v0.1.0 (MVP)** — see [`CHANGELOG.md`](./CHANGELOG.md).

```
skynet/
├─ apps/
│  ├─ web/        # React + Vite SPA (routing, audit view, installable PWA)
│  └─ server/     # Fastify API + WebSocket gateway + orchestrator + merge queue
├─ packages/
│  ├─ shared/     # ◀ entity + event contracts (zod) — the frontend/backend spine
│  └─ runner-sdk/ # provider-agnostic runner interface + 5 real runners + mock
├─ docker-compose.yml
└─ Dockerfile     # multi-stage: build web → served by the server image
```

The `shared` package is the spine: both apps import the same zod-validated entity
and `ServerEvent` types, so the wire contract can't silently drift.

## The core loop

Assign a task → the orchestrator acquires an idle runner and provisions an
**isolated git worktree** on an `agent/<id>` branch → the agent works there →
on completion its diff is committed and raised as a **diff review** in the Inbox →
approving **enqueues the branch** onto a serialized per-project **merge queue**
(`skynet/integration/<projectId>`), which merges it, runs the project's checks, and
escalates textual conflicts as a `merge` HITL. Real-time `ServerEvent` deltas stream
every step to the SPA over WebSocket.

## Run it

### ① Demo — mock agents, zero external deps

```bash
cd skynet
pnpm install
pnpm --filter @skynet/shared build       # build the contract package first…
pnpm --filter @skynet/runner-sdk build    # …apps typecheck/run against its dist
pnpm dev                                  # server :8080, web :5173 (proxies /api + /ws)
```

Open <http://localhost:5173>. Auth is off by default (you land in the `cyberdyne`
workspace). Assign a task to a project → a mock agent runs a canned plan and hits a
HITL gate → resolve it in the **Inbox**. This exercises the whole control plane with
no API keys.

### ② Self-host (one command)

```bash
cp .env.example .env
docker compose up        # app (web+api+ws) + postgres + redis  →  http://localhost:8080
```

### ③ Go live — real agents doing real work→diff→merge

In `.env`:

- `RUNNER=claude` (or `codex` / `gemini` / `cursor` / `copilot`) + the matching
  provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …), or
  store per-workspace keys encrypted (set `SKYNET_MASTER_KEY=$(openssl rand -base64 32)`).
- `SKYNET_INTEGRATION_REPO=/path/to/your/repo` + `SKYNET_BASE_BRANCH=main` — turns on
  worktree provisioning and the merge queue. Optional `SKYNET_CHECK_CMD="pnpm test"`
  runs before each merge commits.

Assign a task → the agent works in its own worktree → you get a diff review in the
Inbox → approve → it integrates into `skynet/integration/<project>`.

## What's in v0.1.0

- **Core loop** — worktree-per-agent provisioning + serialized merge queue with
  conflict escalation and post-merge checks.
- **5 runner backends** behind one `RunnerProvider` seam — Claude Code, Codex,
  Gemini, Cursor, Copilot (`RUNNER=`), plus the default `mock`.
- **Per-workspace encrypted secrets** with runner key-injection (`SKYNET_MASTER_KEY`).
- **Persistence** — in-memory or Postgres `Store`; **real-time** in-process or Redis
  `Bus` (cross-replica fan-out).
- **Auth** — dev tokens + real login with durable sessions (memory / Postgres / Redis).
- **Derived intelligence** — module map (`.skynet/modules.json`) + server-side
  conflict/dependency derivation feeding the Timeline and conflict banner.
- **Live preview** — sandboxed per-branch preview URLs / built artifacts (`PREVIEW=`).
- **Web** — deep-link routing, decision audit-trail view, installable PWA
  (offline shell, push → Inbox), onboarding.
- **Quality** — Vitest suite (contracts, Store adapters, merge engine, HITL) + CI
  (typecheck + build + test against Postgres).

## Configuration (`.env`)

See [`.env.example`](./.env.example) for the full list. Most-used:

| Var | Default | Notes |
|-----|---------|-------|
| `STORE` | `memory` | `postgres` selects the durable adapter |
| `BUS` | `memory` | `redis` fans out across replicas |
| `SESSIONS` | `memory` | login session backend: `postgres` / `redis` for durability |
| `RUNNER` | `mock` | `claude` / `codex` / `gemini` / `cursor` / `copilot` |
| `AUTH_REQUIRED` | `false` | `true` rejects unauthenticated requests (401) |
| `SKYNET_INTEGRATION_REPO` | _(unset)_ | target repo → enables worktrees + merge queue |
| `SKYNET_BASE_BRANCH` | `main` | branch agents cut from / the queue integrates onto |
| `SKYNET_CHECK_CMD` | _(unset)_ | command run in the repo before a merge commits |
| `SKYNET_MASTER_KEY` | _(unset)_ | base64 32-byte key → enables encrypted secrets |
| `PREVIEW` | `off` | `artifact` (build + serve) / `deploy` (external URL) |

With `AUTH_REQUIRED=true`, sign in with the dev seed creds
`jordan@cyberdyne.dev` / `kyle@resistance.dev` (password `skynet`), or use the dev
tokens `dev-cyberdyne` / `dev-resistance`.

## Docs

- [`CHANGELOG.md`](./CHANGELOG.md) — release notes
- [`ROADMAP.md`](./ROADMAP.md) — MVP (v0) then versioned releases
- [`docs/vcs-and-conflict-model.md`](./docs/vcs-and-conflict-model.md) — worktree /
  merge / conflict-ownership model
- [`docs/`](./docs/) — positioning, agent-hierarchy, runner-catalog, workstreams
