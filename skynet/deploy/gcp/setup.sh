#!/usr/bin/env bash
# One-command, PROMPT-DRIVEN GCP setup for an always-on single-user Skynet.
# Run it and answer the prompts — it writes terraform.tfvars, loads your secrets
# straight into Secret Manager (nothing secret is stored in this repo or in
# Terraform state), builds + pushes the image, provisions the VM, and prints the
# tunnel command. Re-running is safe: existing config + already-set secrets are
# kept (it only asks for what's missing) — with one exception: an undersized
# machine_type (e2-small/e2-medium) is auto-bumped to e2-standard-4 every run.
#
# The only hard prereqs are gcloud + terraform installed. The one thing NOT
# automated is the final `terraform apply` confirmation — you review the plan and
# type yes, because it provisions billable resources.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
command -v gcloud >/dev/null || { echo "gcloud not found — install the Google Cloud CLI"; exit 1; }
command -v terraform >/dev/null || { echo "terraform not found — install Terraform"; exit 1; }

# ── 0. Auth (run the two logins for you if needed) ───────────────────────────
if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  say "▸ You're not authenticated — running the two logins (a browser will open)…"
  gcloud auth login
  gcloud auth application-default login
fi

# ── 1. Config → terraform.tfvars (prompt only if it's not there yet) ─────────
if [ ! -f terraform.tfvars ]; then
  say "▸ Configure your instance"
  read -r -p "  GCP project id [skynet-pid]: " PROJECT_IN; PROJECT_IN=${PROJECT_IN:-skynet-pid}
  [ -n "$PROJECT_IN" ] || { echo "  project id is required"; exit 1; }
  read -r -p "  Region [europe-west1]: " REGION_IN; REGION_IN=${REGION_IN:-europe-west1}
  # Default zone: not every region has an "-a" (e.g. europe-west1 / us-east1 are
  # b/c/d). Query the first UP zone in the region; if the Compute API isn't on
  # yet (brand-new project) fall back to a zone that's known to exist.
  DEFZONE=$(gcloud compute zones list --project="$PROJECT_IN" \
    --filter="region:( ${REGION_IN} ) AND status=UP" \
    --format="value(name)" --limit=1 2>/dev/null || true)
  if [ -z "$DEFZONE" ]; then
    case "$REGION_IN" in
      europe-west1|us-east1) DEFZONE="${REGION_IN}-b" ;;  # no -a zone in these
      *)                     DEFZONE="${REGION_IN}-a" ;;
    esac
  fi
  read -r -p "  Zone [${DEFZONE}]: " ZONE_IN; ZONE_IN=${ZONE_IN:-$DEFZONE}
  read -r -p "  Your Google account email (IAP access + web login) [alex@zubi.ai]: " EMAIL_IN; EMAIL_IN=${EMAIL_IN:-alex@zubi.ai}
  [ -n "$EMAIL_IN" ] || { echo "  email is required"; exit 1; }
  echo "  Machine type:"
  echo "    1) e2-small      — 2 vCPU · 2 GB    (light; orchestration only)"
  echo "    2) e2-medium     — 2 vCPU · 4 GB    (single agent at a time)"
  echo "    3) e2-standard-2 — 2 vCPU · 8 GB    (light concurrent use)"
  echo "    4) e2-standard-4 — 4 vCPU · 16 GB   (recommended — several concurrent agents + live-preview builds without choking)"
  read -r -p "  Choose 1-4, or type any machine type [4]: " MT_IN; MT_IN=${MT_IN:-4}
  case "$MT_IN" in
    1) MT="e2-small" ;;
    2) MT="e2-medium" ;;
    3) MT="e2-standard-2" ;;
    4) MT="e2-standard-4" ;;
    *) MT="$MT_IN" ;; # a custom machine type typed verbatim (e.g. e2-standard-8)
  esac
  read -r -p "  Allow control (approve/create/etc.) over Telegram? [Y/n]: " TC_IN
  TC=true; [[ "${TC_IN:-y}" =~ ^[Nn] ]] && TC=false
  # Public UI over HTTPS (drop the IAP tunnel for humans). Needs a real domain
  # (Let's Encrypt won't issue for a bare IP) whose A-record points at the VM's
  # static IP, and adds a Telegram-OTP second factor to the login.
  read -r -p "  Serve the UI publicly over HTTPS at a domain (public_ui)? [Y/n]: " PUI_IN
  PUI=true; [[ "${PUI_IN:-y}" =~ ^[Nn] ]] && PUI=false
  if $PUI; then
    read -r -p "  Public domain (A-record → the VM's static IP) [skynet.zubi.ai]: " DOMAIN_IN; DOMAIN_IN=${DOMAIN_IN:-skynet.zubi.ai}
    read -r -p "  Let's Encrypt (ACME) email [${EMAIL_IN}]: " ACME_IN; ACME_IN=${ACME_IN:-$EMAIL_IN}
  fi
  cat > terraform.tfvars <<TFV
project_id       = "${PROJECT_IN}"
region           = "${REGION_IN}"
zone             = "${ZONE_IN}"
machine_type     = "${MT}"
operator_email   = "${EMAIL_IN}"
admin_email      = "${EMAIL_IN}"
admin_workspace  = "skynet"
telegram_control = ${TC}
TFV
  if $PUI; then
    cat >> terraform.tfvars <<TFV
public_ui        = true
mcp_domain       = "${DOMAIN_IN}"
acme_email       = "${ACME_IN}"
TFV
  fi
  echo "  ✓ wrote terraform.tfvars (edit it anytime; re-run to reuse)"
fi

# ── 1b. Auto-upgrade an undersized machine_type on an EXISTING tfvars ────────
# The wizard above only runs on a FIRST deploy — an existing terraform.tfvars
# (from before e2-standard-4 became the recommendation) never sees it again,
# so a plain re-run alone wouldn't pick up the bump. A live incident showed
# e2-small/e2-medium genuinely can't handle a few concurrent agents (memory
# pressure severe enough to make the whole VM briefly unresponsive, not just
# the app container) — so those two specifically are auto-upgraded on every
# run, not just offered. Anything else (including a deliberately-larger custom
# type) is left alone. Self-limiting: once bumped, the grep below no longer
# matches, so this is a no-op on every subsequent run.
if [ -f terraform.tfvars ] && grep -qE '^machine_type[[:space:]]*=[[:space:]]*"(e2-small|e2-medium)"' terraform.tfvars; then
  OLD_MT=$(grep -E '^machine_type[[:space:]]*=' terraform.tfvars | sed -E 's/^machine_type[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/')
  say "▸ Bumping machine_type: ${OLD_MT} → e2-standard-4 (too small for concurrent agents — see deploy/gcp/README.md)"
  awk '/^machine_type[[:space:]]*=/{print "machine_type     = \"e2-standard-4\""; next} {print}' terraform.tfvars >terraform.tfvars.new
  mv terraform.tfvars.new terraform.tfvars
fi

say "▸ terraform init"
terraform init -input=false >/dev/null

PROJECT=$(echo 'var.project_id' | terraform console | tr -d '"')
REGION=$(echo 'var.region' | terraform console | tr -d '"')
NAME=$(echo 'var.name_prefix' | terraform console | tr -d '"')
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${NAME}/skynet:latest"
echo "  project=${PROJECT} region=${REGION}"
gcloud config set project "${PROJECT}" >/dev/null

# ── 2. Bootstrap the pre-VM resources (APIs, Artifact Registry, secret shells) ─
say "▸ Enabling APIs + Artifact Registry + secret containers"
terraform apply -input=false -auto-approve \
  -target=google_project_service.apis \
  -target=google_artifact_registry_repository.skynet \
  -target=google_secret_manager_secret.s

# ── 3. Load secret VALUES via prompts, straight into Secret Manager ──────────
have_secret() {
  gcloud secrets versions list "$1" --project="${PROJECT}" --limit=1 --format='value(name)' 2>/dev/null | grep -q .
}
put_secret() { printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project="${PROJECT}" >/dev/null; }

# Prompt for a secret value ($3="req" makes it mandatory). Skips if already set.
load_secret() {
  local id="$1" label="$2" req="${3:-}" val=""
  if have_secret "${NAME}-${id}"; then echo "  ✓ ${label} already set — keeping it"; return; fi
  while :; do
    read -r -s -p "  ${label}${req:+ (required)}: " val; echo
    if [ -z "$val" ]; then
      [ "$req" = "req" ] || { echo "    (skipped)"; return; }
      echo "    required — please enter a value"; continue
    fi
    put_secret "${NAME}-${id}" "$val"; echo "    ✓ set"; return
  done
}

say "▸ Secrets (typed hidden; blank skips an optional one; already-set values are kept)"
load_secret anthropic-api-key "Anthropic API key" req
load_secret admin-password    "Admin password for the web login" req
load_secret telegram-bot-token     "Telegram bot token (blank to skip phone control)"
load_secret telegram-owner-chat-id "Telegram chat id (from @userinfobot)"
load_secret github-token           "GitHub token (blank to add later; needed to clone repos)"
# Master key: generated + stored automatically (never typed).
if ! have_secret "${NAME}-master-key"; then
  openssl rand -base64 32 | gcloud secrets versions add "${NAME}-master-key" --data-file=- --project="${PROJECT}" >/dev/null
  echo "  ✓ master-key generated"
else
  echo "  ✓ master-key already set — keeping it"
fi

# ── 4. Build + push the app image (Cloud Build; context = the skynet/ monorepo) ─
say "▸ Building + pushing the image via Cloud Build (a few minutes)"
gcloud builds submit ../.. --tag "${IMAGE}" --project "${PROJECT}"

# ── 4b. Snapshot the data disk BEFORE the VM apply (all your state lives on it) ─
# The apply/startup below can reconfigure or roll the VM in place, so back /data
# up first — a bad deploy stays fully recoverable. Skipped on a first deploy (no
# disk yet). A failed snapshot prompts before continuing rather than silently
# applying with no backup.
ZONE=$(echo 'var.zone' | terraform console | tr -d '"')
DATA_DISK="${NAME}-data"
if gcloud compute disks describe "${DATA_DISK}" --zone="${ZONE}" --project="${PROJECT}" >/dev/null 2>&1; then
  SNAP="${DATA_DISK}-$(date +%Y%m%d-%H%M%S)"
  say "▸ Snapshotting ${DATA_DISK} → ${SNAP} (backup before the apply)"
  if ! gcloud compute disks snapshot "${DATA_DISK}" --zone="${ZONE}" --project="${PROJECT}" --snapshot-names="${SNAP}"; then
    read -r -p "  snapshot FAILED — continue with the apply anyway? [y/N]: " GO
    [ "${GO}" = "y" ] || [ "${GO}" = "Y" ] || { echo "  aborting — no backup was taken"; exit 1; }
  fi
else
  echo "  (no ${DATA_DISK} disk yet — first deploy, nothing to snapshot)"
fi

# ── 5. Provision the VM (INTERACTIVE — review the plan, then type yes) ────────
say "▸ Provisioning the VM (review the plan, then type yes)"
terraform apply -input=false -var "image=${IMAGE}"

# ── 6. Health gate — never claim success until the app actually serves ───────
# The server has hard startup gates (STORE/BUS/SESSIONS + required secrets); a
# missing one makes the container crash-loop with nothing on the app port. Poll
# the VM until it answers, and on failure dump the real container logs right here
# — so a bad deploy is loud and self-diagnosing, not a cryptic tunnel error later.
# (First boot installs Docker + pulls the image, so allow a few minutes.)
say "▸ Rolling the VM onto the new image, then waiting for it to serve…"
APP_PORT=$(echo 'var.app_port' | terraform console)
ZONE=$(echo 'var.zone' | terraform console | tr -d '"')
VM=$(terraform output -raw vm_name)
PUBLIC_UI=$(echo 'var.public_ui' | terraform console)
DOMAIN=$(echo 'var.mcp_domain' | terraform console | tr -d '"')
ssh_vm() { gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap --quiet --command="$1" 2>/dev/null; }
# terraform apply updates the VM's startup-script metadata but does NOT re-pull
# on a RUNNING instance (the image tag is always :latest — no diff to act on).
# Reboot to re-run startup: fresh registry login + pull + recreate, re-reading
# the updated metadata. A reset is a plain API call — it avoids the IAP-tunnel/
# reauth hang that an in-place SSH re-run hits when your gcloud session needs
# reauth (the tunnel blocks silently instead of erroring, so setup.sh could hang
# for hours at "re-running startup on the VM…").
say "▸ Rebooting the VM to pull the new image + apply the startup script…"
gcloud compute instances reset "$VM" --zone="$ZONE" --project="$PROJECT" >/dev/null 2>&1 \
  || echo "  (reset failed — run 'gcloud auth login', then re-run this script)"

# Health gate. public_ui: poll the PUBLIC url — no tunnel (so reauth can't block
# it), and it proves Caddy + Let's Encrypt actually serve (the app up on :8080 is
# NOT enough — Caddy can be wedged with no cert). Otherwise check over the tunnel.
poll_public() {
  for _ in $(seq 1 40); do
    [ "$(curl -s -o /dev/null --max-time 8 -w '%{http_code}' "https://${DOMAIN}/" 2>/dev/null)" = "200" ] && return 0
    sleep 12
  done
  return 1
}
HEALTHY=""
if [ "$PUBLIC_UI" = "true" ]; then
  say "▸ Waiting for https://${DOMAIN} to serve (reboot + Caddy + Let's Encrypt — a few minutes)…"
  poll_public && HEALTHY=1
else
  for _ in $(seq 1 40); do
    if ssh_vm "curl -fsS -o /dev/null http://localhost:${APP_PORT}"; then HEALTHY=1; break; fi
    sleep 12
  done
fi
if [ -n "$HEALTHY" ]; then
  [ "$PUBLIC_UI" = "true" ] && echo "  ✓ serving at https://${DOMAIN}" || echo "  ✓ app is serving on :${APP_PORT}"
else
  echo "  ✗ not serving yet. Container state + recent logs:"
  ssh_vm "sudo docker ps -a --format '{{.Names}} | {{.Status}}'; echo '--- app ---'; sudo docker logs --tail=30 skynet 2>&1; echo '--- caddy ---'; sudo docker logs --tail=30 caddy 2>&1" \
    || echo "    (couldn't reach the VM over IAP SSH — run 'gcloud auth login', then: gcloud compute ssh ${VM} --zone=${ZONE} --project=${PROJECT} --tunnel-through-iap --command='sudo docker logs --tail=30 caddy')"
  echo "  Fix the cause, then re-run this script."
fi

# ── 7. Reach the board ───────────────────────────────────────────────────────
if [ "$PUBLIC_UI" = "true" ]; then
  if [ -n "$HEALTHY" ]; then say "✅ Done — the board is live at https://${DOMAIN}"; else say "⚠️  Provisioned, but https://${DOMAIN} isn't serving yet (see the logs above)."; fi
  echo "  Open https://${DOMAIN} and log in — password, then a one-time code arrives on Telegram (MFA)."
  echo "  Recovery codes: /data/mfa-recovery-codes.txt on the VM (SSH in, save them safely, then delete the file)."
  echo "  For an agent: mint a token in Settings → API tokens and call https://${DOMAIN}/mcp with 'Authorization: Bearer <token>'."
  echo "  Control it anytime from Telegram: /status, /task, approve gates, /stop."
  exit 0
fi
# IAP-only mode: offer the private SSH-forward tunnel.
if [ -n "$HEALTHY" ]; then say "✅ Done — the app is live."; else say "⚠️  Provisioned, but the app isn't healthy yet (see the logs above)."; fi
TUNNEL=$(terraform output -raw iap_tunnel_command)
PORT=$(echo 'var.local_port' | terraform console)
echo "Reach the board privately (IAM-gated, no public IP) — an SSH-forward over IAP:"
echo "  ${TUNNEL}"
echo "  …leave it running, then open http://127.0.0.1:${PORT} and log in with your email + admin password."
echo "Control it anytime from Telegram: /status, /task, approve gates, /stop."
read -r -p $'\nOpen the tunnel now? (stays open in this terminal) [Y/n]: ' T
[[ "${T:-y}" =~ ^[Nn] ]] || exec bash -c "${TUNNEL}"
