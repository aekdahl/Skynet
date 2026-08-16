# Skynet over MCP — let agents drive the fleet

Skynet exposes its whole product surface (projects, tasks, fleet runners, agents,
the human-in-the-loop queue, and the audit trail) as an **MCP server**, so an AI
agent can operate Skynet the same way a human does through the web UI — create
projects, assign tasks, launch agents, watch for gates, and (if trusted) resolve
them.

The MCP server is a second front-end onto the exact same seam the HTTP API uses:
every tool delegates to [`Operations`](../apps/server/src/operations.ts), tool
input schemas reuse the shared Zod contracts, and calls carry the same
workspace-scoped `Principal` resolved from a bearer token. So workspace
isolation, the HITL model, and the GitHub push guardrails all apply to agents
for free — there is no parallel, drift-prone code path.

---

## Two transports, one core

```
          stdio binary ─┐
 (Claude Code local)    ├──► POST /mcp  ──► tools ──► Operations ──► hub / orchestrator / store
 claude.ai / remote  ───┘   (Streamable HTTP,        (scope-checked,   (persist + publish)
                             behind the auth hook)    Zod-validated)
```

| Transport | Endpoint / command | Use it for |
|-----------|--------------------|------------|
| **Streamable HTTP** | `POST /mcp` on the Skynet server | Remote/hosted clients: claude.ai connectors, `claude mcp add --transport http`, other orchestrators, and **sandboxes** (Daytona etc.). |
| **stdio** | the `skynet-mcp` binary ([`apps/mcp-stdio`](../apps/mcp-stdio)) | Local, stdio-only clients and the desktop app. It is a thin transparent proxy to a running server's `/mcp` over loopback — it holds no state, keeping the file store single-writer. |

Both speak to the identical server-side tool core. The HTTP endpoint is the
primary one; stdio is a shim in front of it.

### Connecting a client

Remote HTTP (Claude Code):

```bash
claude mcp add --transport http skynet https://<host>/mcp \
  --header "Authorization: Bearer skynet_pat_…"
```

Local stdio (`mcp.json`) — requires the `skynet-mcp` binary on `PATH`:

```json
{
  "mcpServers": {
    "skynet": {
      "command": "skynet-mcp",
      "env": {
        "SKYNET_MCP_URL": "http://127.0.0.1:8080/mcp",
        "SKYNET_MCP_TOKEN": "skynet_pat_…"
      }
    }
  }
}
```

Both snippets are generated for you, pre-filled with a freshly minted token, in
**Settings → MCP access**.

---

## Authentication & scopes

MCP callers authenticate with a **service token** (`skynet_pat_…`) — a scoped,
long-lived API key that resolves to a workspace `Principal`, exactly like a human
login session. Get one two ways:

1. **Settings → MCP access** — a human mints a token with chosen scopes; the raw
   secret is shown once. Also lists and revokes tokens.
2. **Bootstrap env** (headless/sandbox) — see [Deploying on Daytona](#deploying-on-daytona-or-any-sandbox).

A token carries a **scope set** that narrows what the agent may do. Human logins
carry no scopes and have full authority; a token is restricted to the subset it
was granted:

| Scope | Grants | Example tools |
|-------|--------|---------------|
| `observe` | read-only | `get_snapshot`, `list_agents`, `get_agent`, `list_hitl`, `wait_for_*` |
| `author` | create & drive work | `create_project`, `create_task`, `assign_task`, `message_agent`, `fork_agent`, `stop_agent`, `configure_runner` |
| `approver` | resolve HITL gates | `resolve_hitl` (approve/reject diffs & pushes) |
| `admin` | reserved (token admin) | *never granted to MCP; secrets & GitHub connection are not exposed over MCP* |

> **The HITL gate is the safety model.** Default tokens get `observe + author`
> only, so an agent can plan and run work but **cannot approve its own diffs or
> pushes** — a human (or an explicitly `approver`-scoped token) must. The
> server-side GitHub guardrails (`approveBeforePush`) enforce this regardless of
> what the agent calls. Grant `approver` deliberately.

Scope enforcement happens in the tool layer on every call, not just at mint time,
so an over-broad or leaked token still can't exceed its granted capabilities.

---

## What's exposed

**Tools** (grouped by required scope):

- *observe (read)* — `get_snapshot`, `get_settings`, `list_projects`, `list_agents`, `get_agent`, `run_diff`, `list_tasks`, `get_task`, `list_features`, `list_milestones`, `list_hitl`, `list_audit`, `get_audit`
- *observe (blocking)* — `wait_for_hitl`, `wait_for_agent`

**Summary vs. detail.** `list_agents` / `list_tasks` / `list_audit` / `get_snapshot`
return compact, paginated summaries — no activity logs, task descriptions, or
captured diff patches. A workspace's runs carry an unbounded tool-call history
and its audit trail embeds full unified diffs; returning full records for every
row on a *listing* call scales token cost with workspace history, not with what
the caller asked for (a real deployment hit this: `list_agents`/`get_snapshot`
became unusably large once the workspace had ~50 runs). Once you've found the
one record you need, drill in with `get_agent` / `get_task` / `get_audit` for
its full detail — `get_agent`'s log defaults to the most recent 100 entries
(`logLimit`/`logOffset` to page further back). `list_agents`/`list_tasks`/
`list_audit` default to 30 rows (`limit`/`offset` to page, capped at 200),
exclude archived records, and every response reports `total`/`hasMore` so a
short page is never mistaken for the whole list.
- *author — workspace & projects* — `update_settings`, `create_project`, `update_project`
- *author — backlog & board* — `create_task`, `update_task`, `transition_task` (move through the kanban), `force_task_done`, `move_task`, `reorder_task`, `archive_task`, `delete_task`, `import_github_issues`, `import_repo_file`
- *author — roadmap* — `create_feature`, `update_feature`, `delete_feature`, `create_milestone`, `update_milestone`, `delete_milestone`
- *author — agents & fleet* — `assign_task`, `message_agent`, `fork_agent`, `stop_agent`, `pause_agent`, `resume_agent`, `archive_agent`, `configure_runner`, `update_runner`, `retire_runner`
- *approver* — `resolve_hitl`

**`wait_for_*`** are the event-driven primitives: instead of hot-polling, the
agent calls one and the request parks (backed by the workspace's event bus) until
a HITL item is raised / an agent reaches a target status, or a timeout elapses.
This works across replicas when `BUS=redis`.

**Resource** — `skynet://snapshot`: the live workspace snapshot as JSON.

**Prompt** — `operate_skynet`: a bootstrap message that teaches a client the
create → assign → wait → resolve workflow.

A typical agent loop:

```
get_snapshot → create_project → create_task ×N → assign_task
   → wait_for_hitl → (resolve_hitl | surface to a human) → wait_for_agent → done
```

---

## Deploying on Daytona (or any sandbox)

The scenario: an agent spins up a [Daytona](https://www.daytona.io/) sandbox,
runs Skynet inside it, and then calls that Skynet over MCP to orchestrate its own
fleet of sub-agents — all within the sandbox's isolation boundary.

Skynet is already a single self-contained image ([`Dockerfile`](../Dockerfile))
that serves the SPA + `/api` + `/ws` + `/mcp` from one process on `:8080`. The
only extra ingredient a sandbox needs is a way to get a token **without a human
login** — that's the **bootstrap token**.

### 1. The bootstrap token

Set these env vars when booting Skynet headless:

| Env | Meaning |
|-----|---------|
| `SKYNET_BOOTSTRAP_TOKEN` | a **strong random secret** the agent generates and injects; registered verbatim as a service token at boot |
| `SKYNET_BOOTSTRAP_SCOPES` | comma list, default `observe,author` (never `approver` unless you mean it) |
| `SKYNET_BOOTSTRAP_WORKSPACE` | workspace to scope it to (default the single-tenant one) |
| `AUTH_REQUIRED=true` | reject everything except that token — no open default |

At boot the server logs (without the secret):

```
MCP bootstrap token registered — workspace=cyberdyne scopes=[observe, author] → POST /mcp
```

The agent already knows the secret (it generated it), so it never has to scrape
logs. Because the secret lives only in the sandbox's env and the sandbox is
ephemeral, this is a good fit for agent-created environments.

### 2. Provisioning script (Daytona TS SDK — illustrative)

```ts
import { Daytona } from "@daytonaio/sdk";
import { randomBytes } from "node:crypto";

const daytona = new Daytona(); // reads DAYTONA_API_KEY

// The agent mints its own bootstrap secret.
const token = `skynet_pat_${randomBytes(32).toString("base64url")}`;

// Create the sandbox from the Skynet image with the bootstrap env baked in.
const sandbox = await daytona.create({
  image: "ghcr.io/your-org/skynet:latest", // built from skynet/Dockerfile
  envVars: {
    STORE: "memory",              // ephemeral is fine for a sandbox; use file for durability
    BUS: "memory",
    SESSIONS: "memory",
    AUTH_REQUIRED: "true",
    RUNNER: "claude",             // or leave unset to honor each runner's provider
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    SKYNET_BOOTSTRAP_TOKEN: token,
    SKYNET_BOOTSTRAP_SCOPES: "observe,author",
  },
});

// Skynet listens on 8080; get the sandbox's public preview URL for that port.
const { url } = await sandbox.getPreviewLink(8080);
const mcpUrl = `${url}/mcp`;

// Hand these to the agent's MCP client. If Daytona's preview requires its own
// auth header, include it alongside the Skynet bearer token.
console.log("MCP endpoint:", mcpUrl);
console.log("MCP token:", token);
```

> Daytona's SDK surface evolves — check their docs for the exact `create` /
> preview-link calls. The Skynet-specific parts (image, env, port `8080`,
> `/mcp`, bearer token) are what matter here.

### 3. Connect the agent's MCP client

Point any MCP client at `<preview-url>/mcp` with `Authorization: Bearer <token>`.
For Claude Code:

```bash
claude mcp add --transport http skynet "$MCP_URL" --header "Authorization: Bearer $TOKEN"
```

The agent now has `get_snapshot`, `assign_task`, `wait_for_hitl`, … scoped to its
sandbox. Tear the sandbox down and the token dies with it.

### Notes & caveats

- **Runners still need provider credentials.** Assigning a task launches a real
  runner (Claude/Codex/…), so pass the relevant API key into the sandbox env
  (see [always-test-real-runners](#)). With `RUNNER=mock` no key is needed but
  nothing real executes.
- **Durability.** `STORE=memory` resets on restart — fine for an ephemeral
  sandbox. Use `STORE=file` (+ a mounted volume) to survive restarts.
- **CORS.** `/mcp` responses are streamed on the raw socket and don't carry the
  CORS headers `/api` does. Server-side MCP clients (Claude Code, claude.ai,
  another agent) are unaffected; a browser-based MCP client would need CORS added.
- **`approver` in a sandbox.** Granting it lets the agent resolve its own HITL
  gates with no human — appropriate only for a fully autonomous, sandboxed run
  you trust. Default (`observe,author`) keeps a human in the loop.

---

## Source map

| Concern | File |
|---------|------|
| Tool core (tools, resource, prompt, scope gating) | [`apps/server/src/mcp/tools.ts`](../apps/server/src/mcp/tools.ts) |
| HTTP transport mount | [`apps/server/src/mcp/http.ts`](../apps/server/src/mcp/http.ts) |
| `wait_for_*` bus helpers | [`apps/server/src/mcp/watch.ts`](../apps/server/src/mcp/watch.ts) |
| Shared service layer | [`apps/server/src/operations.ts`](../apps/server/src/operations.ts) |
| Service tokens (mint/resolve/revoke) | [`apps/server/src/auth/service-tokens.ts`](../apps/server/src/auth/service-tokens.ts) |
| Bootstrap token seeding | [`apps/server/src/auth/bootstrap.ts`](../apps/server/src/auth/bootstrap.ts) |
| Token admin routes | [`apps/server/src/auth/routes.ts`](../apps/server/src/auth/routes.ts) |
| stdio bridge | [`apps/mcp-stdio/src/index.ts`](../apps/mcp-stdio/src/index.ts) |
| Settings UI (mint/revoke) | [`apps/web/src/views/settings.tsx`](../apps/web/src/views/settings.tsx) |
