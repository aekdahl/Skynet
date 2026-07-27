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
  read -r -p "  GCP project id: " PROJECT_IN
  [ -n "$PROJECT_IN" ] || { echo "  project id is required"; exit 1; }
  read -r -p "  Region [us-central1]: " REGION_IN; REGION_IN=${REGION_IN:-us-central1}
  read -r -p "  Zone [${REGION_IN}-a]: " ZONE_IN; ZONE_IN=${ZONE_IN:-${REGION_IN}-a}
  read -r -p "  Your Google account email (IAP access + web login): " EMAIL_IN
  [ -n "$EMAIL_IN" ] || { echo "  email is required"; exit 1; }
  read -r -p "  Machine type [e2-small] (e2-medium for heavier builds): " MT_IN; MT_IN=${MT_IN:-e2-small}
  read -r -p "  Allow control (approve/create/etc.) over Telegram? [y/N]: " TC_IN
  TC=false; [[ "${TC_IN:-}" =~ ^[Yy] ]] && TC=true
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

# ── 6. Done — reach the board + optionally open the tunnel now ───────────────
say "✅ Done."
TUNNEL=$(terraform output -raw iap_tunnel_command)
PORT=$(echo 'var.app_port' | terraform console)
echo "Reach the board privately (IAM-gated, no public IP):"
echo "  ${TUNNEL}"
echo "  …then open http://localhost:${PORT} and log in with your email + admin password."
echo "Control it anytime from Telegram: /status, /task, approve gates, /stop."
read -r -p $'\nOpen the tunnel now? [Y/n]: ' T
[[ "${T:-y}" =~ ^[Nn] ]] || exec bash -c "${TUNNEL}"
