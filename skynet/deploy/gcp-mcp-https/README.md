# Skynet MCP over public HTTPS — a VM, no Google IAP

Expose **only** the Skynet MCP endpoint on a real `https://…/mcp` URL, without
the IAP tunnel used by [`../gcp`](../gcp). A GCE VM runs the headless Skynet
server behind **Caddy**, which terminates TLS and publishes just `/mcp`. The MCP
data plane is locked to a **source-IP allowlist** (this is what replaces IAP),
and every request must carry `Authorization: Bearer <MCP_TOKEN>`.

```
                      ┌─────────────────────── GCE VM ───────────────────────┐
 MCP client ──TLS──▶  │  Caddy :443  ──(private docker net)──▶  Skynet :8080  │
 (Bearer token)       │  • terminates TLS (Let's Encrypt)       • /mcp only    │
   only from the      │  • serves ONLY /mcp                      • AUTH_REQUIRED │
   allowlisted IPs    │  • rejects tokenless requests (401)      • Bearer token │
                      └───────────────────────────────────────────────────────┘
   :80 (open) → Caddy serves ONLY the ACME challenge + 301 → https (no MCP data)
```

> **This is a *personal single-user* deployment**, not the deferred multi-tenant
> hosted product. Your provider keys and repo live on this VM — treat it as
> sensitive. Everything here is **authored for you to run**: review
> `terraform plan` before applying; nothing is applied for you.

## Deliverables (what you hand to an MCP client)

| | |
|---|---|
| **Final URL** | `https://<mcp_domain>/mcp` |
| **Auth header** | `Authorization: Bearer <MCP_TOKEN>` — on **every** request |
| **Port / path** | public **`443`** (HTTPS) → path **`/mcp`** |
| **Transport** | MCP Streamable HTTP (`POST /mcp`) |

`<MCP_TOKEN>` is the value of the `skynet-mcp-mcp-token` Secret Manager secret
(`setup.sh` generates a strong one and prints it once). The app port `8080` is
**internal only** — never published to the VM host or the internet; only Caddy
reaches it over a private docker network.

Register it with Claude Code:

```bash
claude mcp add --transport http skynet https://<mcp_domain>/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

`terraform output` prints all of the above (`mcp_url`, `mcp_auth_header`,
`mcp_port_path`, `claude_mcp_add_command`, `vm_external_ip`).

## How each requirement is met

- **Terminate TLS on a dedicated HTTPS endpoint** — Caddy obtains and renews a
  Let's Encrypt certificate for `mcp_domain` and terminates TLS on `:443`
  ([`Caddyfile.tftpl`](./Caddyfile.tftpl)). No IAP, no self-signed cert to trust.
- **Serve MCP on a stable `/mcp` path** — Caddy publishes only `/mcp` (and
  `/mcp/*`); the web UI, `/api`, and `/ws` are **not** exposed here. Skynet runs
  with `SKYNET_HEADLESS=true` (MCP-first: API + WS + `/mcp`, no SPA). Everything
  else returns 404.
- **Require `Authorization: Bearer <MCP_TOKEN>` on every request** — two layers:
  Caddy rejects any request without a `Bearer` header at the edge (401), and
  Skynet (`AUTH_REQUIRED=true`) validates the actual token value + its scopes.
  The token is injected at boot via `SKYNET_BOOTSTRAP_TOKEN` and registered as a
  scoped service token (`SKYNET_BOOTSTRAP_SCOPES`, default `observe,author`).
- **Lock down ingress** — a dedicated VPC with **deny-by-default** ingress. The
  only inbound rules: `:443` from your **`allowed_source_ranges`** allowlist
  (the MCP data plane), and `:80` from anywhere for the **ACME challenge + https
  redirect only** (no MCP data on `:80`). SSH is off unless you set
  `ssh_source_ranges`. See [Fully private alternative](#fully-private-alternative)
  to drop the source-IP allowlist for internal-only GCP networking.

## What it provisions

- A **GCE VM** (`e2-small` default) running Skynet + Caddy in Docker, `--restart=always`.
- A **static external IP** — point your DNS `A` record at it.
- A **persistent disk** at `/data` — `STORE=file`, the encryption master key, and
  Caddy's ACME cert store. **Snapshot it for backups.**
- **Secret Manager** secrets (containers only in Terraform; you add the values):
  `mcp-token` (the Bearer credential), Anthropic key, master key, optional GitHub token.
- A **dedicated VPC** with **deny-by-default ingress** + the three rules above.
- **Artifact Registry** for the image + a **least-privilege service account** for the VM.

## Prerequisites

- `gcloud` authenticated: `gcloud auth login` **and** `gcloud auth application-default login`.
- `terraform` (>= 1.3).
- A GCP project with billing enabled.
- **A DNS name you control** (`mcp_domain`) — you'll create an `A` record to the
  VM's static IP. Let's Encrypt won't issue for a bare IP.

## Run it

```bash
cd skynet/deploy/gcp-mcp-https && ./setup.sh
```

The wizard: runs the `gcloud` logins if needed; asks for project/region/zone,
`mcp_domain`, `acme_email`, and the client IP allowlist (writing
`terraform.tfvars`); reserves the **static IP** and loads secrets straight into
Secret Manager (generating the MCP token and the master key). It then **pauses so
you can create the DNS `A` record** → the printed IP, builds + pushes the image
(Cloud Build), runs `terraform apply` (you review the plan and type `yes`), and
finally polls the live `https://<mcp_domain>/mcp` until it answers `401` to a
tokenless probe (proof TLS + the auth gate are up). Re-running is safe — existing
config and already-set secrets are kept.

Prefer to do it by hand? Copy `terraform.tfvars.example` → `terraform.tfvars`,
add the secret values (`setup.sh`'s `set_secrets_hint` output shows the exact
`gcloud secrets versions add` commands, incl. `mcp-token`), then
`terraform apply -var image=<your image ref>`.

## Verify

```bash
# From an allowlisted IP. A tokenless request is rejected at the edge:
curl -i https://<mcp_domain>/mcp            # → 401, JSON-RPC "Unauthorized"

# With the token, an MCP initialize succeeds:
curl -s https://<mcp_domain>/mcp \
  -H "Authorization: Bearer <MCP_TOKEN>" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A request from a non-allowlisted IP times out (the firewall never lets it reach `:443`).

## Rotate the MCP token

```bash
printf '%s' 'skynet_pat_NEWVALUE' | gcloud secrets versions add skynet-mcp-mcp-token \
  --data-file=- --project=<project>
gcloud compute ssh skynet-mcp-server --zone=<zone> --command='sudo google_metadata_script_runner startup'
# (or reboot the VM) — the startup script re-reads the secret and re-registers the token.
```

## Ingress lockdown — details & alternatives

**Source-IP allowlist (default).** `allowed_source_ranges` is the only path to
`:443`; it must be non-empty and may not be `0.0.0.0/0` (Terraform validates
this). Set it to the egress IP(s) of your MCP clients. `:80` is open only for the
ACME HTTP-01 challenge — Caddy serves nothing but the challenge response and a
301 to https there.

**Avoid opening `:80` (DNS-01).** Set `open_acme_http = false` and switch Caddy to
the DNS-01 challenge (edit [`Caddyfile.tftpl`](./Caddyfile.tftpl) to use a
`dns` block for your DNS provider, using a Caddy build with that DNS plugin).
Then no inbound port is needed for issuance and `:443` stays fully allowlisted.

### Fully private alternative

If your MCP clients run **inside GCP** (same VPC / peered / via a connector), you
can drop the public allowlist entirely: set `allowed_source_ranges` to the
internal subnet CIDR(s), remove the VM's external IP (delete the `nat_ip` /
`access_config`, add **Cloud NAT** for egress), and use the DNS-01 challenge
(above) so no public inbound is required. The endpoint stays `https://…/mcp` with
the same Bearer auth, reachable only from internal networking.

## Cost (rough)

`e2-small` ≈ **$13–15/mo** + a 20 GB disk (~$2) + a static IP + egress + **your
LLM tokens** (only if you assign work that launches runners). Drop to `e2-micro`
for pure MCP orchestration.

## Update / backup / teardown

- **Update:** re-run `./setup.sh` (rebuilds + pushes; re-runs the startup script
  so the VM re-pulls `:latest` and recreates the containers).
- **Backup:** snapshot the `skynet-mcp-data` disk.
- **Teardown:** `terraform destroy` (removes the disk + secrets too — snapshot first).
