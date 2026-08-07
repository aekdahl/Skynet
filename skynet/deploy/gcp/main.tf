# ─── Skynet on GCP — always-on single-user self-host ────────────────────────
# A GCE VM runs the headless Skynet server (Docker), state on a persistent disk
# (STORE=file), secrets in Secret Manager, ingress locked to Google's IAP range.
# Control is via Telegram (outbound — no inbound needed); the board is reached
# privately with `gcloud compute start-iap-tunnel`. Authored to be run by YOU:
# review `terraform plan`, then apply. Nothing here is applied for you.
#
# NOTE: this is a personal single-user deployment, NOT the deferred multi-tenant
# hosted product — your keys + repo live on this VM, so treat it as sensitive.

terraform {
  required_version = ">= 1.3"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── APIs ────────────────────────────────────────────────────────────────────
resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com",
    "secretmanager.googleapis.com",
    "iap.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

# ── Artifact Registry (holds the image setup.sh builds) ─────────────────────
resource "google_artifact_registry_repository" "skynet" {
  location      = var.region
  repository_id = var.name_prefix
  format        = "DOCKER"
  description   = "Skynet server images"
  depends_on    = [google_project_service.apis]
}

# ── Least-privilege service account for the VM ──────────────────────────────
resource "google_service_account" "vm" {
  account_id   = "${var.name_prefix}-vm"
  display_name = "Skynet VM (least-privilege)"
}

resource "google_project_iam_member" "vm_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_project_iam_member" "vm_metrics" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# Pull the app image from Artifact Registry.
resource "google_project_iam_member" "vm_ar_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.vm.email}"
}

# ── Secret Manager: containers + access ONLY (values added out-of-band) ─────
# Terraform NEVER holds the secret values — you add versions with
# `gcloud secrets versions add` (see README / setup.sh output).
locals {
  secret_ids = concat(
    [
      "anthropic-api-key",
      "telegram-bot-token",
      "telegram-owner-chat-id",
      "admin-password",
      "master-key",
      "github-token", # optional — leave a blank/placeholder version if unused
    ],
    # The Bearer credential for the public /mcp door (only when enabled).
    var.enable_mcp_https ? ["mcp-token"] : [],
  )
}

resource "google_secret_manager_secret" "s" {
  for_each  = toset(local.secret_ids)
  secret_id = "${var.name_prefix}-${each.value}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "vm_access" {
  for_each  = google_secret_manager_secret.s
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

# ── Network: dedicated VPC, no default-permissive rules ─────────────────────
resource "google_compute_network" "vpc" {
  name                    = "${var.name_prefix}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "subnet" {
  name          = "${var.name_prefix}-subnet"
  ip_cidr_range = "10.10.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id
}

# The base ingress: Google IAP's range → SSH + the app port, to tagged VMs.
# Everything else is denied (a custom VPC has no default allow rules). The human
# UI/api/ws are reachable ONLY through this — never publicly.
resource "google_compute_firewall" "iap_ingress" {
  name      = "${var.name_prefix}-allow-iap"
  network   = google_compute_network.vpc.id
  direction = "INGRESS"
  # IAP's fixed source range for TCP forwarding.
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["${var.name_prefix}"]
  allow {
    protocol = "tcp"
    ports    = ["22", tostring(var.app_port)]
  }
}

# Caddy + Let's Encrypt on :443. Two mutually-exclusive modes, one firewall:
#   • enable_mcp_https → narrow /mcp door, locked to mcp_allowed_source_ranges.
#   • public_ui        → whole app public (UI + /mcp), open at the edge and gated
#                        by the app's own login/MFA + Bearer (not by IP).
locals {
  caddy_enabled = var.enable_mcp_https || var.public_ui
}

resource "google_compute_firewall" "mcp_https" {
  count         = local.caddy_enabled ? 1 : 0
  name          = "${var.name_prefix}-allow-mcp-https"
  network       = google_compute_network.vpc.id
  direction     = "INGRESS"
  source_ranges = var.public_ui ? ["0.0.0.0/0"] : var.mcp_allowed_source_ranges
  target_tags   = ["${var.name_prefix}"]
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
}

# ACME HTTP-01 on :80 from anywhere — Caddy serves ONLY the Let's Encrypt
# challenge + a 301 to https; no MCP data on :80. Off if you use DNS-01.
resource "google_compute_firewall" "acme_http" {
  count         = local.caddy_enabled && var.open_acme_http ? 1 : 0
  name          = "${var.name_prefix}-allow-acme-http"
  network       = google_compute_network.vpc.id
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${var.name_prefix}"]
  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
}

# A static external IP so the /mcp DNS A-record + ACME cert are stable. Only
# reserved when the public door is enabled; otherwise the VM keeps its ephemeral
# egress IP (unchanged).
resource "google_compute_address" "mcp" {
  count        = var.enable_mcp_https && !var.public_ui ? 1 : 0
  name         = "${var.name_prefix}-mcp-ip"
  region       = var.region
  address_type = "EXTERNAL"
  depends_on   = [google_project_service.apis]
}

# public_ui points DNS at a pre-reserved static IP (<name_prefix>-public-ip,
# created out of band so the A-record can be set before the first apply).
# Referenced (not managed) so Terraform never churns the IP the DNS depends on.
data "google_compute_address" "public" {
  count  = var.public_ui ? 1 : 0
  name   = "${var.name_prefix}-public-ip"
  region = var.region
}

# ── The VM ──────────────────────────────────────────────────────────────────
resource "google_compute_disk" "data" {
  name = "${var.name_prefix}-data"
  type = "pd-balanced"
  zone = var.zone
  size = var.data_disk_gb
}

resource "google_compute_instance" "vm" {
  name         = "${var.name_prefix}-server"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["${var.name_prefix}"]
  # Let `terraform apply` change the machine type in place: GCE requires the VM
  # to be stopped to resize it, so without this a machine_type change ERRORS.
  # With it, apply just stops → resizes → starts (no recreation; /data survives).
  allow_stopping_for_update = true

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 20
    }
  }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "skynet-data"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    # External IP for EGRESS (reach Anthropic/Telegram/GitHub). Ephemeral by
    # default (inbound still denied except the IAP range). When the public /mcp
    # door is enabled we pin a STATIC IP so the mcp_domain A-record + ACME cert
    # are stable; `null` here keeps the ephemeral IP (unchanged behaviour).
    access_config {
      nat_ip = var.public_ui ? one(data.google_compute_address.public[*].address) : one(google_compute_address.mcp[*].address)
    }
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    startup-script = templatefile("${path.module}/startup.sh.tftpl", {
      project_id       = var.project_id
      region           = var.region
      image            = var.image
      app_port         = var.app_port
      name_prefix      = var.name_prefix
      admin_email      = var.admin_email
      admin_workspace  = var.admin_workspace
      telegram_control = var.telegram_control ? "true" : "false"
      # Caddy runs in either mode (caddy_enabled). The bootstrap /mcp token is
      # only for the narrow enable_mcp_https door — public_ui uses a Settings
      # service token, so no deploy-time token is injected there.
      caddy_enabled    = local.caddy_enabled
      enable_mcp_https = var.enable_mcp_https
      public_ui        = var.public_ui
      mcp_domain       = var.mcp_domain
      mcp_scopes       = var.mcp_scopes
      caddyfile = var.public_ui ? templatefile("${path.module}/Caddyfile-public.tftpl", {
        mcp_domain = var.mcp_domain
        acme_email = var.acme_email
        app_port   = var.app_port
        }) : (var.enable_mcp_https ? templatefile("${path.module}/Caddyfile.tftpl", {
          mcp_domain = var.mcp_domain
          acme_email = var.acme_email
          app_port   = var.app_port
          mcp_ranges = join(" ", var.mcp_allowed_source_ranges)
      }) : "")
    })
  }

  # Guard against applying before the image exists.
  lifecycle {
    precondition {
      condition     = length(var.image) > 0
      error_message = "var.image is empty — run ./setup.sh (it builds + pushes the image and passes it in), or set -var image=..."
    }
    # Caddy (either mode) needs a domain + ACME email for the Let's Encrypt cert.
    precondition {
      condition     = !local.caddy_enabled || (length(trimspace(var.mcp_domain)) > 0 && length(trimspace(var.acme_email)) > 0)
      error_message = "enable_mcp_https / public_ui require mcp_domain and acme_email (Caddy needs them for the Let's Encrypt cert)."
    }
    # The narrow /mcp door additionally needs a client allowlist (and the
    # <name_prefix>-mcp-token secret). public_ui does not — it's login/Bearer-gated.
    precondition {
      condition     = !var.enable_mcp_https || var.public_ui || length(var.mcp_allowed_source_ranges) > 0
      error_message = "enable_mcp_https requires a non-empty mcp_allowed_source_ranges (and the <name_prefix>-mcp-token secret). For an open, login-gated box use public_ui instead."
    }
    # One TLS mode at a time — they configure Caddy differently.
    precondition {
      condition     = !(var.enable_mcp_https && var.public_ui)
      error_message = "Set either enable_mcp_https (narrow /mcp door) or public_ui (whole app public) — not both."
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.vm_access,
    google_project_iam_member.vm_ar_reader,
  ]
}

# ── IAP: let the operator open a private tunnel to the VM ───────────────────
resource "google_iap_tunnel_instance_iam_member" "operator" {
  project  = var.project_id
  zone     = var.zone
  instance = google_compute_instance.vm.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "user:${var.operator_email}"
}
