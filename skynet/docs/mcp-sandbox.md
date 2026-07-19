# Skynet as a headless MCP server (sandbox / Daytona)

Skynet is one server with two front-ends onto the same `Operations` core: the web
UI (HTTP + WS) and an **MCP server at `POST /mcp`** for agents. There is no
separate "MCP product" — running Skynet **headless** _is_ the MCP server. This
doc covers running it GUI-less in a sandbox (e.g. a Daytona sandbox an agent
spins up) and driving it over MCP.

> Headless mode (`SKYNET_HEADLESS=true`) skips the web SPA and the live-preview
> pipeline — you get the API + WS + `/mcp` only, same binary, leaner footprint.

---

## 1. What you need

| Env | Purpose |
| --- | --- |
| `SKYNET_HEADLESS=true` | Server-only (no SPA/preview). Set by `Dockerfile.mcp`. |
| `AUTH_REQUIRED=true` | Reject unauthenticated requests. Default-on outside dev. |
| `SKYNET_BOOTSTRAP_TOKEN=skynet_pat_…` | A **strong random** secret you generate. Registered at boot as a scoped service token — the credential the MCP client presents. |
| `SKYNET_BOOTSTRAP_SCOPES=observe,author` | What that token may do (default). See §5. **Never `approver`** unless you intend a human-free loop. |
| `STORE=file` `SKYNET_DB_PATH=/data/skynet-data.json` | Durable single-process persistence (desktop-like). |
| `SKYNET_MASTER_KEY=<32-byte base64>` | Enables the encrypted provider-key store (Settings/secret API). |
| `ANTHROPIC_API_KEY=<key>` | So agents actually **run**. Without a provider credential the control plane works but nothing executes. |
| `SKYNET_TRUST_PROXY=true` | If behind the sandbox's HTTPS proxy — keys rate limiting on the real client. |

Generate the bootstrap token with 256 bits of entropy, e.g.:

```bash
echo "skynet_pat_$(openssl rand -hex 32)"
```

---

## 2. Quick start (local, to see the loop)

> A prebuilt image is published to **`ghcr.io/aekdahl/skynet-mcp`** by the
> **MCP image** GitHub Actions workflow (run it on demand from the Actions tab,
> or it builds automatically on a `v*` release tag). Pull that instead of
> building locally if you don't need a custom build:
> `docker pull ghcr.io/aekdahl/skynet-mcp:latest`.

```bash
docker build -f Dockerfile.mcp -t skynet-mcp .
TOKEN="skynet_pat_$(openssl rand -hex 32)"
docker run --rm -p 8080:8080 \
  -e SKYNET_BOOTSTRAP_TOKEN="$TOKEN" \
  -e SKYNET_MASTER_KEY="$(openssl rand -base64 32)" \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  skynet-mcp
# Log line: "MCP endpoint ready → POST :8080/mcp (Authorization: Bearer <service-token>)"
```

The MCP endpoint is now at `http://localhost:8080/mcp`, authenticated with `$TOKEN`.

---

## 3. Deploy + drive it from an agent, via Daytona

The pattern is the same regardless of SDK version: **(a)** create a sandbox from
the `skynet-mcp` image (or run it inside a sandbox), **(b)** pass the env incl. the
bootstrap token, **(c)** expose port 8080 and get its public URL, **(d)** connect
an MCP client to `<url>/mcp` with the token.

> The Daytona SDK method names below are illustrative — check the current
> [Daytona docs](https://www.daytona.io/docs/) for exact signatures. The **Skynet
> contract** (env, `/mcp`, tools, scopes) is fixed and is what matters.

```ts
import { Daytona } from "@daytonaio/sdk";
import { randomBytes } from "node:crypto";

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
const bootstrapToken = `skynet_pat_${randomBytes(32).toString("hex")}`;

// (a)+(b) Create a sandbox from the published headless image, with Skynet's env.
const sandbox = await daytona.create({
  image: "your-registry/skynet-mcp:latest", // built from Dockerfile.mcp and pushed
  env: {
    SKYNET_BOOTSTRAP_TOKEN: bootstrapToken,
    SKYNET_BOOTSTRAP_SCOPES: "observe,author",   // human still gates HITL (see §5)
    SKYNET_MASTER_KEY: randomBytes(32).toString("base64"),
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    SKYNET_TRUST_PROXY: "true",
  },
});

// (c) Expose port 8080 and get its public URL (method name varies by SDK version).
const { url } = await sandbox.getPreviewLink(8080); // e.g. https://8080-<id>.daytona.app

// (d) Connect an MCP client to <url>/mcp with the bootstrap token — see §4.
```

If you'd rather not pre-build an image, create a plain sandbox and run the server
inside it: clone the repo, `pnpm install && pnpm --filter "./packages/*" --filter
@skynet/server build`, then `SKYNET_HEADLESS=true AUTH_REQUIRED=true STORE=file
SKYNET_BOOTSTRAP_TOKEN=… node apps/server/dist/index.js`, and expose port 8080.

---

## 4. Connecting an MCP client

**Direct (Streamable HTTP)** — any MCP client that speaks Streamable HTTP:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${bootstrapToken}` } },
});
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();          // discover the tool surface
await client.callTool({ name: "create_project", arguments: { name: "Demo", goal: "…" } });
```

**stdio bridge** — for hosts that only speak stdio (e.g. some desktop agents), run
`apps/mcp-stdio` locally; it proxies stdio ⇄ the remote `/mcp`:

```bash
SKYNET_MCP_URL="<url>/mcp" SKYNET_MCP_TOKEN="$bootstrapToken" node apps/mcp-stdio/dist/index.js
```

---

## 5. Tools + scopes (and the HITL trade-off)

The MCP tools are the same `Operations` the web UI uses, gated by the token's scopes:

- **`observe`** — `get_snapshot`, `list_projects`, `list_agents`, `get_agent`, `list_hitl`, `list_audit`
- **`author`** — `create_project`, `update_project`, `create_task`, `update_task`, `assign_task`, `message_agent`, `fork_agent`, `stop_agent`, `archive_agent`, `configure_runner`, `update_runner`, `retire_runner`
- **`approver`** — `resolve_hitl` (approve/reject/modify diffs, answer questions, gate a push)

**The trade-off to decide up front:** with the default `observe,author`, an MCP
agent can create and drive work but **cannot resolve approval gates** — a human
(or a separate `approver`-scoped token) still gates risky commands and diffs.
Granting `approver` gives the agent a **fully autonomous, human-free loop** — it
can approve its own risky actions. Do that only when you deliberately want no
human checkpoint. (Skynet's safety classifier still labels severity, and the
denylist still hard-blocks catastrophic commands regardless of scope.)

---

## 6. Security checklist for an exposed sandbox

- `AUTH_REQUIRED=true` (default-on outside an explicit `NODE_ENV=development`/`test`).
- Serve `/mcp` over **HTTPS** (the sandbox's proxy) — the token is a bearer credential.
- Treat `SKYNET_BOOTSTRAP_TOKEN` as a secret; rotate by restarting with a new one.
- Rate limiting is on by default (`/api` + `/mcp`); set `SKYNET_TRUST_PROXY=true`
  behind a proxy so it keys per client.
- Keep `approver` off the bootstrap token unless a human-free loop is intended.
