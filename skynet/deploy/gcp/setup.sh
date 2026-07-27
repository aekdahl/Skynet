#!/usr/bin/env bash
# One-command GCP setup for an always-on single-user Skynet instance.
# Prereqs: gcloud (authenticated: `gcloud auth login` + `gcloud auth application-default login`),
# terraform, docker (only if you build locally — this uses Cloud Build), and a
# filled-in terraform.tfvars (copy terraform.tfvars.example). Run from deploy/gcp/.
#
# Nothing here is applied without your confirmation: the VM step is an interactive
# `terraform apply`. Review the plan before typing yes.
set -euo pipefail
cd "$(dirname "$0")"

command -v gcloud >/dev/null || { echo "gcloud not found — install the Google Cloud CLI"; exit 1; }
command -v terraform >/dev/null || { echo "terraform not found"; exit 1; }
[ -f terraform.tfvars ] || { echo "Missing terraform.tfvars — copy terraform.tfvars.example and fill it in."; exit 1; }

echo "▸ terraform init"
terraform init -input=false >/dev/null

# Read config from terraform.tfvars (single source of truth).
PROJECT=$(echo 'var.project_id' | terraform console | tr -d '"')
REGION=$(echo 'var.region' | terraform console | tr -d '"')
NAME=$(echo 'var.name_prefix' | terraform console | tr -d '"')
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${NAME}/skynet:latest"
echo "▸ project=${PROJECT} region=${REGION} image=${IMAGE}"
gcloud config set project "${PROJECT}" >/dev/null

# 1. Bootstrap the resources needed BEFORE the VM: APIs, Artifact Registry, and
#    the (empty) secret containers. Low-risk, so auto-approved.
echo "▸ bootstrapping APIs + Artifact Registry + secret containers"
terraform apply -input=false -auto-approve \
  -target=google_project_service.apis \
  -target=google_artifact_registry_repository.skynet \
  -target=google_secret_manager_secret.s

# 2. Load the secret VALUES (never stored in Terraform/this repo). Pause for you.
cat <<EOF

────────────────────────────────────────────────────────────────────────
Set your secret values now (values live ONLY in Secret Manager), e.g.:

  printf '%s' 'sk-ant-...'        | gcloud secrets versions add ${NAME}-anthropic-api-key    --data-file=- --project=${PROJECT}
  printf '%s' '123456:ABC...'     | gcloud secrets versions add ${NAME}-telegram-bot-token   --data-file=- --project=${PROJECT}
  printf '%s' '<your chat id>'    | gcloud secrets versions add ${NAME}-telegram-owner-chat-id --data-file=- --project=${PROJECT}
  printf '%s' '<admin password>'  | gcloud secrets versions add ${NAME}-admin-password        --data-file=- --project=${PROJECT}
  openssl rand -base64 32         | gcloud secrets versions add ${NAME}-master-key            --data-file=- --project=${PROJECT}
  printf '%s' '<github token>'    | gcloud secrets versions add ${NAME}-github-token          --data-file=- --project=${PROJECT}   # optional

(master-key can be omitted — the VM will generate + persist one on /data.)
────────────────────────────────────────────────────────────────────────
EOF
read -r -p "Press Enter once the secrets are set (Ctrl-C to abort)… " _

# 3. Build + push the app image (Cloud Build, context = the skynet/ monorepo).
echo "▸ building + pushing image via Cloud Build (this can take a few minutes)"
gcloud builds submit ../.. --tag "${IMAGE}" --project "${PROJECT}"

# 4. Full apply — creates the VM (+ disk, network, firewall, IAP binding).
#    INTERACTIVE on purpose: review the plan, then type yes.
echo "▸ applying the full stack (review the plan, then confirm)"
terraform apply -input=false -var "image=${IMAGE}"

echo
echo "✅ Done. Reach the board privately (IAM-gated, no public IP):"
terraform output -raw iap_tunnel_command
echo
echo "   …then open http://localhost:$(echo 'var.app_port' | terraform console) in your browser."
echo "   Control it anytime from Telegram (/status, /task, approve gates, /stop)."
