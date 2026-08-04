# Skynet on GCP — always-on single-user self-host

Run the **headless Skynet server** on a small always-on GCE VM so it works when
your laptop is off: autonomy keeps ticking and you drive the fleet from
**Telegram** (outbound — no inbound ports). The web board is reachable
**privately over IAP** (Google IAM-gated, no public IP). State lives on a
persistent disk (`STORE=file`); secrets live in **Secret Manager**.

> **This is a *personal single-user* deployment — not the multi-tenant hosted
> product** (that's deferred in the roadmap). Your provider keys and repo live on
> this VM, so treat it as sensitive: set a **spend cap** on your Anthropic key
> and keep high-risk/merge gates human-approved. Everything here is **authored for
> you to run** — review `terraform plan` before applying; nothing is applied for you.

## What it provisions
- A **GCE VM** (`e2-small` default) running the app in Docker, `--restart=always`.
- A **persistent disk** at `/data` — `STORE=file` + the encryption master key. **Snapshot it for backups.**
- **Secret Manager** secrets (containers only in Terraform; you add the values): Anthropic key, Telegram bot token + owner chat id, admin password, master key, optional GitHub token.
- A **dedicated VPC** with **default-deny ingress** — the only allowed inbound is Google's **IAP range** (`35.235.240.0/20`) to SSH + the app port.
- **Artifact Registry** for the image (built by Cloud Build) + a **least-privilege service account** for the VM.
- An **IAP tunnel** grant so *your* Google account (and no one else) can reach the board.

## Prerequisites
- `gcloud` authenticated: `gcloud auth login` **and** `gcloud auth application-default login`.
- `terraform` (>= 1.3).
- A GCP project with billing enabled.

## Run it
```bash
cd skynet/deploy/gcp && ./setup.sh
```
That's the whole deploy — `setup.sh` is a **prompt-driven wizard**. It runs the
`gcloud` logins if needed, then asks you (in order) for your project id, region,
email, and machine type (writing `terraform.tfvars` for you), then prompts for
each **secret** (Anthropic key, admin password, and optional Telegram/GitHub) and
loads them **directly into Secret Manager** — no hand-edited tfvars, no pasted
`gcloud secrets` commands. It generates the master key itself, builds + pushes
the image (Cloud Build), runs `terraform apply` (interactive — you review the
plan and type `yes`, since it creates billable resources), and finally offers to
open the tunnel. **Re-running is safe:** existing config + already-set secrets
are kept — it only asks for what's missing (so adding the GitHub token later, or
bumping the machine type, is just another run). Prefer to fill things in by hand
instead? Copy `terraform.tfvars.example` → `terraform.tfvars` first and it'll
skip the config prompts.

## Reach the board
```bash
gcloud compute ssh skynet-server --zone=europe-west1-b --project=YOUR_PROJECT --tunnel-through-iap -- -N -L 48080:localhost:8080
# leave it running, then open http://127.0.0.1:48080  (log in with the admin_email + the admin-password secret)
# 8080 = the app's port inside the VM; 48080 = the local port (var.local_port) — pick any free one
```
Access is IAM-gated (your `operator_email`), fully private — no public IP, no open ports, no TLS to manage.

> **Why an SSH-forward and not `start-iap-tunnel`?** The board holds a live
> WebSocket. `gcloud compute start-iap-tunnel` turns every browser connection
> into its own fragile IAP proxy socket and drops the WS mid-snapshot — the UI
> hangs on "loading your workspace…" while gcloud floods `Bad file descriptor` /
> `Failed to send all data`. The SSH local-forward multiplexes everything over
> one stable stream, so the WebSocket holds. (It still rides IAP under the hood —
> same IAM gate, no public IP.)

## A public /mcp door for agents (optional — keeps IAP for the UI)

By default this box is IAP-only, which is great for humans but unreachable by a
non-browser client (e.g. a Cloud Run agent that can't run the IAP tunnel). Turn
on `enable_mcp_https` to add **one narrow public door** — Caddy on `:443` serving
**only** `/mcp`, Bearer-gated and source-IP allowlisted — to the **same VM**. The
human UI/api/ws are **unchanged**: still IAP-only on `app_port`. Same box, same
`/data` disk → `terraform apply` upgrades it **in place** (no new box, no
migration).

```hcl
# terraform.tfvars
enable_mcp_https          = true
mcp_domain                = "mcp.example.com"    # A-record → the mcp_vm_ip output
acme_email                = "you@example.com"
mcp_allowed_source_ranges = ["<client-egress-IP>/32"]   # e.g. your Cloud Run static egress IP
```

```bash
# The Bearer credential clients present (also the SKYNET_BOOTSTRAP_TOKEN registered at boot):
printf '%s' 'skynet_pat_a-strong-random-value' | gcloud secrets versions add skynet-mcp-token \
  --data-file=- --project=YOUR_PROJECT
```

Point `mcp_domain` at the **`mcp_vm_ip`** output (a static IP reserved when the
door is on) **before** apply so Caddy can complete the ACME challenge, then
`terraform apply`. `terraform output` gives `mcp_url`, `mcp_auth_header`, and
`claude_mcp_add_command`. Verify from an allowlisted client:

```bash
curl -i https://mcp.example.com/mcp                       # → 401 (tokenless, rejected at the edge)
curl -s https://mcp.example.com/mcp -H "Authorization: Bearer <MCP_TOKEN>" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

> Posture: the human surface keeps IAP's identity gate; the only public exposure
> is `/mcp`, and it's doubly gated — the source-IP allowlist **and** the Bearer
> token (Caddy at the edge + the app validates the value + scopes). For a fully
> private cross-project client instead of a public allowlist, see
> `../gcp-mcp-https` (its "Fully private alternative").

## Serve the whole app publicly (`public_ui`) — no IAP, just a login

If the IAP tunnel is more friction than it's worth (it needs `gcloud`, and the
login drops on your org's reauth interval), serve the **whole app** over HTTPS at
a real domain instead — like normal SaaS. The **UI** is gated by the app login
(+ Telegram MFA); **`/mcp`** by a Bearer **service token** you mint in Settings.
IAP stays only for **SSH** (break-glass — you can always get in to disable MFA).

```bash
# 1. Reserve the static IP and point your A-record at it BEFORE applying:
gcloud compute addresses create skynet-public-ip --region=europe-west1 --project=YOUR_PROJECT
gcloud compute addresses describe skynet-public-ip --region=europe-west1 --project=YOUR_PROJECT --format='value(address)'
#    → create  skynet.example.com  A  <that IP>  at your DNS host
```
```hcl
# terraform.tfvars   (mutually exclusive with enable_mcp_https)
public_ui  = true
mcp_domain = "skynet.example.com"
acme_email = "you@example.com"
```

Then `./setup.sh` (or `terraform apply`). Caddy gets a Let's Encrypt cert and
serves the app on `:443`; open `https://skynet.example.com`, log in, done — no
tunnel, no reauth. WebSocket runs cleanly through Caddy (no more "loading your
workspace…"). For `/mcp`, mint a scoped token in **Settings → API tokens** and
send it as `Authorization: Bearer …`.

> **Posture shift:** this trades Google IAP's identity gate for the app's own
> login as the only human gate — acceptable for a single-user box **with MFA on**
> and the existing rate-limiting. Only `:443` (+ `:80` for ACME) are public; SSH
> stays IAP-gated. Recovery codes + SSH break-glass mean you can't get locked out.

## Control from your phone
Set the Telegram secrets and message your bot (`/status`, `/task …`, approve gates, `/stop`, `/quit`). Outbound-only, so it works with the VM fully locked down. See `../../docs/…` / the in-app Settings → "Remote control · Telegram" for bot setup.

## Update / backup / teardown
- **Update:** re-run `./setup.sh` (rebuilds + pushes the image; the VM re-pulls on `terraform apply`, or `docker pull && docker restart skynet` on the box).
- **Backup:** `setup.sh` **auto-snapshots** the `skynet-data` disk before every VM apply (skipped on a first deploy), so each re-run is recoverable. Snapshot manually anytime: `gcloud compute disks snapshot skynet-data --zone=…`.
- **Teardown:** `terraform destroy` (the persistent disk + secrets are removed too — snapshot first if you want to keep state).

## Cost (rough)
`e2-small` ≈ **$13–15/mo** + a 20 GB disk (~$2) + egress + **your LLM tokens**. Autonomy can spend while you sleep — the spend cap + human-approved gates are your throttle. Drop to `e2-micro` for pure orchestration, up for heavy builds.

## Optional upgrades
- **No external IP at all:** add **Cloud NAT** (a router + NAT config) so the VM has no external address; egress still works. The current setup uses an ephemeral external IP for egress with all inbound denied — nothing is publicly reachable, but this makes it explicit.
- **Browser Google-login URL (instead of the tunnel):** put the app behind an **HTTPS load balancer with IAP enabled** — you'd open a real `https://…` URL and get a Google sign-in page, no `gcloud` tunnel. Needs an LB (+ ideally a domain + managed cert); left out to keep this minimal.
- **Managed Postgres:** swap `STORE=file` for `STORE=postgres` on Cloud SQL if you outgrow the file store.
