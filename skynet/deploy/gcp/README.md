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
cd skynet/deploy/gcp
cp terraform.tfvars.example terraform.tfvars   # fill in project_id, emails, etc.
./setup.sh
```
`setup.sh` will: init → bootstrap APIs + Artifact Registry + the (empty) secret containers → **pause for you to load the secret values** (it prints the exact `gcloud secrets versions add` commands) → build+push the image via Cloud Build → `terraform apply` the VM (interactive — you confirm the plan) → print the tunnel command.

## Reach the board
```bash
gcloud compute start-iap-tunnel skynet-server 8080 --local-host-port=localhost:8080 --zone=us-central1-a --project=YOUR_PROJECT
# then open http://localhost:8080  (log in with the admin_email + the admin-password secret)
```
Access is IAM-gated (your `operator_email`), fully private — no public IP, no open ports, no TLS to manage.

## Control from your phone
Set the Telegram secrets and message your bot (`/status`, `/task …`, approve gates, `/stop`, `/quit`). Outbound-only, so it works with the VM fully locked down. See `../../docs/…` / the in-app Settings → "Remote control · Telegram" for bot setup.

## Update / backup / teardown
- **Update:** re-run `./setup.sh` (rebuilds + pushes the image; the VM re-pulls on `terraform apply`, or `docker pull && docker restart skynet` on the box).
- **Backup:** snapshot the `skynet-data` persistent disk (`gcloud compute disks snapshot skynet-data --zone=…`).
- **Teardown:** `terraform destroy` (the persistent disk + secrets are removed too — snapshot first if you want to keep state).

## Cost (rough)
`e2-small` ≈ **$13–15/mo** + a 20 GB disk (~$2) + egress + **your LLM tokens**. Autonomy can spend while you sleep — the spend cap + human-approved gates are your throttle. Drop to `e2-micro` for pure orchestration, up for heavy builds.

## Optional upgrades
- **No external IP at all:** add **Cloud NAT** (a router + NAT config) so the VM has no external address; egress still works. The current setup uses an ephemeral external IP for egress with all inbound denied — nothing is publicly reachable, but this makes it explicit.
- **Browser Google-login URL (instead of the tunnel):** put the app behind an **HTTPS load balancer with IAP enabled** — you'd open a real `https://…` URL and get a Google sign-in page, no `gcloud` tunnel. Needs an LB (+ ideally a domain + managed cert); left out to keep this minimal.
- **Managed Postgres:** swap `STORE=file` for `STORE=postgres` on Cloud SQL if you outgrow the file store.
