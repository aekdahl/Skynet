# ─── Skynet MCP over public HTTPS — a VM, no Google IAP ──────────────────────
# Exposes ONLY the MCP endpoint (`/mcp`) on a real https:// URL, no IAP tunnel:
#
#   [MCP client] ──TLS──▶ Caddy (:443, terminates TLS, serves only /mcp) ──▶
#                         Skynet (headless, loopback docker network, :8080)
#
# TLS is terminated by Caddy with an automatic Let's Encrypt certificate. The
# data plane (:443) is locked to a source-IP allowlist (this replaces IAP);
# :80 is opened only so Caddy can complete the ACME HTTP-01 challenge and 301 to
# https (no MCP data is served there). Every /mcp request must carry
# `Authorization: Bearer <MCP_TOKEN>` — Caddy rejects tokenless requests at the
# edge and Skynet validates the token value + scopes. Authored to be run by YOU:
# review `terraform plan`, then apply. Nothing here is applied for you.
#
# NOTE: single-user self-host, NOT the deferred multi-tenant hosted product —
# your keys + repo live on this VM, so treat it as sensitive.

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
  description   = "Skynet MCP server images"
  depends_on    = [google_project_service.apis]
}

# ── Least-privilege service account for the VM ──────────────────────────────
resource "google_service_account" "vm" {
  account_id   = "${var.name_prefix}-vm"
  display_name = "Skynet MCP VM (least-privilege)"
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
# `gcloud secrets versions add` (see README / setup.sh output). The MCP token is
# the credential MCP clients present as `Authorization: Bearer <token>`.
locals {
  secret_ids = [
    "mcp-token",        # the Bearer token every /mcp request must carry
    "anthropic-api-key",
    "master-key",       # file-store encryption key
    "github-token",     # optional — leave a blank/placeholder version if unused
  ]
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
  ip_cidr_range = "10.20.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id
}

# A custom VPC has NO default allow rules, so everything below is deny-by-default
# except what these three rules open, all scoped to the tagged VM.

# 1) The MCP data plane: TLS on :443, ONLY from the source-IP allowlist. This is
#    the ingress lockdown that replaces Google IAP.
resource "google_compute_firewall" "mcp_https" {
  name          = "${var.name_prefix}-allow-mcp-https"
  network       = google_compute_network.vpc.id
  direction     = "INGRESS"
  source_ranges = var.allowed_source_ranges
  target_tags   = [var.name_prefix]
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
}

# 2) ACME HTTP-01 on :80 from anywhere — Caddy serves ONLY the Let's Encrypt
#    challenge + a 301 to https here; no MCP data is exposed on :80. Toggle off
#    (open_acme_http=false) if you switch Caddy to the DNS-01 challenge.
resource "google_compute_firewall" "acme_http" {
  count         = var.open_acme_http ? 1 : 0
  name          = "${var.name_prefix}-allow-acme-http"
  network       = google_compute_network.vpc.id
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = [var.name_prefix]
  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
}

# 3) Optional SSH for administration — only created when ssh_source_ranges is set
#    (this deploy has no IAP, so SSH is your break-glass path if you want one).
resource "google_compute_firewall" "ssh" {
  count         = length(var.ssh_source_ranges) > 0 ? 1 : 0
  name          = "${var.name_prefix}-allow-ssh"
  network       = google_compute_network.vpc.id
  direction     = "INGRESS"
  source_ranges = var.ssh_source_ranges
  target_tags   = [var.name_prefix]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# ── Static external IP (point your DNS A record at this) ────────────────────
resource "google_compute_address" "mcp" {
  name         = "${var.name_prefix}-ip"
  region       = var.region
  address_type = "EXTERNAL"
  depends_on   = [google_project_service.apis]
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
  tags         = [var.name_prefix]

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
    # Static external IP: inbound is still deny-by-default — only the firewall
    # rules above open :443 (allowlisted) and :80 (ACME only).
    access_config {
      nat_ip = google_compute_address.mcp.address
    }
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    startup-script = templatefile("${path.module}/startup.sh.tftpl", {
      project_id  = var.project_id
      region      = var.region
      image       = var.image
      app_port    = var.app_port
      name_prefix = var.name_prefix
      mcp_domain  = var.mcp_domain
      mcp_scopes  = var.mcp_scopes
      # Render the Caddy config here (domain/email/port already substituted) and
      # embed the result verbatim; the startup script writes it to /data/Caddyfile.
      caddyfile = templatefile("${path.module}/Caddyfile.tftpl", {
        mcp_domain = var.mcp_domain
        acme_email = var.acme_email
        app_port   = var.app_port
      })
    })
  }

  # Guard against applying before the image exists.
  lifecycle {
    precondition {
      condition     = length(var.image) > 0
      error_message = "var.image is empty — run ./setup.sh (it builds + pushes the image and passes it in), or set -var image=..."
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.vm_access,
    google_project_iam_member.vm_ar_reader,
  ]
}
