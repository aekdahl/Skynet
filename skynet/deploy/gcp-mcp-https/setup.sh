#!/usr/bin/env bash
# One-command, PROMPT-DRIVEN setup for exposing the Skynet MCP server on a VM
# over public HTTPS — no Google IAP. It writes terraform.tfvars, reserves the
# static IP, loads secrets (incl. a generated MCP token) into Secret Manager,
# waits for you to point DNS at the IP, builds + pushes the image, provisions the
# VM (Caddy terminates TLS + serves /mcp), and health-checks the live URL.
# Nothing secret is stored in this repo or in Terraform state.
#
# Prereqs: gcloud + terraform installed, and a DNS name you can create an A
# record for. The only non-automated step is the final `terraform apply` confirm.
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
  say "▸ Configure your MCP endpoint"
  read -r -p "  GCP project id: " PROJECT_IN
  [ -n "$PROJECT_IN" ] || { echo "  project id is required"; exit 1; }
  read -r -p "  Region [europe-west1]: " REGION_IN; REGION_IN=${REGION_IN:-europe-west1}
  DEFZONE=$(gcloud compute zones list --project="$PROJECT_IN" \
    --filter="region:( ${REGION_IN} ) AND status=UP" \
    --format="value(name)" --limit=1 2>/dev/null || true)
  if [ -z "$DEFZONE" ]; then
    case "$REGION_IN" in
      europe-west1|us-east1) DEFZONE="${REGION_IN}-b" ;;
      *)                     DEFZONE="${REGION_IN}-a" ;;
    esac
  fi
  read -r -p "  Zone [${DEFZONE}]: " ZONE_IN; ZONE_IN=${ZONE_IN:-$DEFZONE}
  read -r -p "  Machine type [e2-small]: " MT_IN; MT_IN=${MT_IN:-e2-small}
  read -r -p "  MCP domain (DNS name for the endpoint, e.g. mcp.example.com): " DOMAIN_IN
  [ -n "$DOMAIN_IN" ] || { echo "  mcp_domain is required"; exit 1; }
  read -r -p "  ACME email (Let's Encrypt account, cert notices): " ACME_IN
  [ -n "$ACME_IN" ] || { echo "  acme_email is required"; exit 1; }
  read -r -p "  Allowed client source IP(s), comma-separated CIDR (e.g. 203.0.113.7/32): " CIDR_IN
  [ -n "$CIDR_IN" ] || { echo "  at least one allowed source range is required (never 0.0.0.0/0)"; exit 1; }
  # Turn "a/32, b/32" into a HCL list: ["a/32", "b/32"]
  CIDR_HCL=$(printf '%s' "$CIDR_IN" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' \
    | sed 's/^/"/;s/$/"/' | paste -sd, -)
  cat > terraform.tfvars <<TFV
project_id            = "${PROJECT_IN}"
region                = "${REGION_IN}"
zone                  = "${ZONE_IN}"
machine_type          = "${MT_IN}"
mcp_domain            = "${DOMAIN_IN}"
acme_email            = "${ACME_IN}"
allowed_source_ranges = [${CIDR_HCL}]
mcp_scopes            = "observe,author"
TFV
  echo "  ✓ wrote terraform.tfvars (edit it anytime; re-run to reuse)"
fi

say "▸ terraform init"
terraform init -input=false >/dev/null

PROJECT=$(echo 'var.project_id' | terraform console | tr -d '"')
REGION=$(echo 'var.region' | terraform console | tr -d '"')
NAME=$(echo 'var.name_prefix' | terraform console | tr -d '"')
DOMAIN=$(echo 'var.mcp_domain' | terraform console | tr -d '"')
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${NAME}/skynet:latest"
echo "  project=${PROJECT} region=${REGION} domain=${DOMAIN}"
gcloud config set project "${PROJECT}" >/dev/null

# ── 2. Bootstrap pre-VM resources incl. the STATIC IP (so we can print it) ───
say "▸ Enabling APIs + Artifact Registry + secret containers + static IP"
terraform apply -input=false -auto-approve \
  -target=google_project_service.apis \
  -target=google_artifact_registry_repository.skynet \
  -target=google_secret_manager_secret.s \
  -target=google_compute_address.mcp

STATIC_IP=$(terraform state show google_compute_address.mcp 2>/dev/null | awk '/address *=/{print $3; exit}' | tr -d '"')

# ── 3. Load secret VALUES straight into Secret Manager ──────────────────────
have_secret() {
  gcloud secrets versions list "$1" --project="${PROJECT}" --limit=1 --format='value(name)' 2>/dev/null | grep -q .
}
put_secret() { printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- --project="${PROJECT}" >/dev/null; }
load_secret() { # id label [req]
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
load_secret github-token      "GitHub token (blank to add later; needed to clone repos)"
# Master key: generated + stored automatically (never typed).
if ! have_secret "${NAME}-master-key"; then
  openssl rand -base64 32 | gcloud secrets versions add "${NAME}-master-key" --data-file=- --project="${PROJECT}" >/dev/null
  echo "  ✓ master-key generated"
else
  echo "  ✓ master-key already set — keeping it"
fi
# MCP token: the Bearer credential clients present. Generate + show ONCE.
MCP_TOKEN=""
if ! have_secret "${NAME}-mcp-token"; then
  MCP_TOKEN="skynet_pat_$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 43)"
  put_secret "${NAME}-mcp-token" "${MCP_TOKEN}"
  echo "  ✓ mcp-token generated"
else
  echo "  ✓ mcp-token already set — keeping it (its value was shown when first created)"
fi

# ── 4. DNS gate — Caddy needs the A record BEFORE it can get a cert ─────────
say "▸ Point DNS at the static IP, THEN continue"
echo "  Create this DNS A record and let it propagate:"
echo "      ${DOMAIN}.  A  ${STATIC_IP:-<see: terraform output vm_external_ip>}"
echo "  (Caddy obtains the Let's Encrypt cert via an HTTP-01 challenge on :80 at first boot;"
echo "   if DNS isn't resolving yet, it retries automatically until it does.)"
read -r -p $'\n  Press Enter once the A record is created to build + provision… '

# ── 5. Build + push the image (Cloud Build; context = the skynet/ monorepo) ─
say "▸ Building + pushing the image via Cloud Build (a few minutes)"
gcloud builds submit ../.. --tag "${IMAGE}" --project "${PROJECT}"

# ── 6. Provision the VM (INTERACTIVE — review the plan, then type yes) ───────
say "▸ Provisioning the VM (review the plan, then type yes)"
terraform apply -input=false -var "image=${IMAGE}"

# ── 7. Health gate — poll the LIVE https URL (no IAP SSH here) ───────────────
# First boot installs Docker, pulls the image, AND Caddy negotiates a cert, so
# allow several minutes. A tokenless request returning 401 already proves TLS +
# the auth edge gate are up; a real token should get a JSON-RPC 200.
MCP_URL="https://${DOMAIN}/mcp"
say "▸ Waiting for ${MCP_URL} to serve (TLS + auth)…"
HEALTHY=""
for _ in $(seq 1 40); do
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${MCP_URL}" 2>/dev/null || echo "000")
  # 401 = Caddy up, cert valid, edge gate rejecting the tokenless probe.
  if [ "$CODE" = "401" ]; then HEALTHY=1; break; fi
  sleep 15
done
if [ -n "$HEALTHY" ]; then
  echo "  ✓ endpoint is live and requiring a Bearer token (HTTP 401 on a tokenless probe)"
else
  echo "  ✗ ${MCP_URL} isn't answering with a valid cert yet (last code: ${CODE:-?})."
  echo "    Common causes: DNS A record not propagated, :80 blocked so ACME can't complete,"
  echo "    or the source-IP allowlist excludes THIS machine (443 is allowlisted — run the"
  echo "    health check from an allowed IP). The VM keeps retrying; re-run this script to re-poll."
fi

# ── 8. Deliverables ─────────────────────────────────────────────────────────
say "$([ -n "$HEALTHY" ] && echo '✅ Done — MCP is live over HTTPS.' || echo '⚠️  Provisioned, but not verified healthy yet (see above).')"
echo "  MCP URL     : ${MCP_URL}"
echo "  Auth header : Authorization: Bearer <MCP_TOKEN>"
echo "  Port / path : 443 (HTTPS) → /mcp"
if [ -n "$MCP_TOKEN" ]; then
  echo
  echo "  ⚠️  Save this MCP token now — it is NOT shown again and not stored in this repo:"
  echo "      ${MCP_TOKEN}"
  echo
  echo "  Register it with Claude Code:"
  echo "      claude mcp add --transport http skynet ${MCP_URL} --header \"Authorization: Bearer ${MCP_TOKEN}\""
else
  echo "  (MCP token already existed — reuse the value you saved when it was first created,"
  echo "   or rotate it: gcloud secrets versions add ${NAME}-mcp-token --data-file=- , then reboot the VM.)"
fi
