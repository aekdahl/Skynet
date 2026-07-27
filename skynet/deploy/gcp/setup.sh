#!/usr/bin/env bash
# One-command, PROMPT-DRIVEN GCP setup for an always-on single-user Skynet.
# Run it and answer the prompts — it writes terraform.tfvars, loads your secrets
# straight into Secret Manager (nothing secret is stored in this repo or in
# Terraform state), builds + pushes the image, provisions the VM, and prints the
# tunnel command. Re-running is safe: existing config + already-set secrets are
# kept (it only asks for what's missing).
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
  read -r -p "  Machine type [e2-small] (e2-medium for heavier builds): " MT_IN; MT_IN=${MT_IN:-e2-small}
  read -r -p "  Allow control (approve/create/etc.) over Telegram? [Y/n]: " TC_IN
  TC=true; [[ "${TC_IN:-y}" =~ ^[Nn] ]] && TC=false
  cat > terraform.tfvars <<TFV
project_id       = "${PROJECT_IN}"
region           = "${REGION_IN}"
zone             = "${ZONE_IN}"
machine_type     = "${MT_IN}"
operator_email   = "${EMAIL_IN}"
admin_email      = "${EMAIL_IN}"
admin_workspace  = "skynet"
telegram_control = ${TC}
TFV
  echo "  ✓ wrote terraform.tfvars (edit it anytime; re-run to reuse)"
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

# ── 5. Provision the VM (INTERACTIVE — review the plan, then type yes) ────────
say "▸ Provisioning the VM (review the plan, then type yes)"
terraform apply -input=false -var "image=${IMAGE}"

# ── 6. Health gate — never claim success until the app actually serves ───────
# The server has hard startup gates (STORE/BUS/SESSIONS + required secrets); a
# missing one makes the container crash-loop with nothing on the app port. Poll
# the VM until it answers, and on failure dump the real container logs right here
# — so a bad deploy is loud and self-diagnosing, not a cryptic tunnel error later.
# (First boot installs Docker + pulls the image, so allow a few minutes.)
say "▸ Waiting for the app to come up (first boot pulls the image — a few minutes)…"
APP_PORT=$(echo 'var.app_port' | terraform console)
ZONE=$(echo 'var.zone' | terraform console | tr -d '"')
VM=$(terraform output -raw vm_name)
ssh_vm() { gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap --quiet --command="$1" 2>/dev/null; }
HEALTHY=""
for _ in $(seq 1 30); do
  if ssh_vm "curl -fsS -o /dev/null http://localhost:${APP_PORT}"; then HEALTHY=1; break; fi
  sleep 12
done
if [ -n "$HEALTHY" ]; then
  echo "  ✓ app is serving on :${APP_PORT}"
else
  echo "  ✗ app is not answering on :${APP_PORT}. Container state + recent logs:"
  ssh_vm "sudo docker ps -a --format '{{.Names}} | {{.Status}}'; echo '--- logs ---'; sudo docker logs --tail=40 skynet 2>&1" \
    || echo "    (couldn't reach the VM over IAP SSH — check 'gcloud auth list' and your IAP access)"
  echo "  Fix the cause (usually a missing secret/env), then re-run this script — the VM keeps retrying the container meanwhile."
fi

# ── 7. Reach the board + optionally open the tunnel now ──────────────────────
if [ -n "$HEALTHY" ]; then say "✅ Done — the app is live."; else say "⚠️  Provisioned, but the app isn't healthy yet (see the logs above)."; fi
TUNNEL=$(terraform output -raw iap_tunnel_command)
PORT=$(echo 'var.local_port' | terraform console)
echo "Reach the board privately (IAM-gated, no public IP):"
echo "  ${TUNNEL}"
echo "  …then open http://127.0.0.1:${PORT} and log in with your email + admin password."
echo "Control it anytime from Telegram: /status, /task, approve gates, /stop."
read -r -p $'\nOpen the tunnel now? [Y/n]: ' T
[[ "${T:-y}" =~ ^[Nn] ]] || exec bash -c "${TUNNEL}"
