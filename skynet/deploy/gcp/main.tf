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
  secret_ids = [
    "anthropic-api-key",
    "telegram-bot-token",
    "telegram-owner-chat-id",
    "admin-password",
    "master-key",
    "github-token", # optional — leave a blank/placeholder version if unused
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
  ip_cidr_range = "10.10.0.0/24"
  region        = var.region
  network       = google_compute_network.vpc.id
}

# The ONLY ingress: Google IAP's range → SSH + the app port, to tagged VMs.
# Everything else is denied (a custom VPC has no default allow rules).
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
    # Ephemeral external IP for EGRESS only (reach Anthropic/Telegram/GitHub).
    # Nothing is reachable inbound — the firewall allows only the IAP range.
    # (For no external IP at all, add Cloud NAT — see README.)
    access_config {}
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

# ── IAP: let the operator open a private tunnel to the VM ───────────────────
resource "google_iap_tunnel_instance_iam_member" "operator" {
  project  = var.project_id
  zone     = var.zone
  instance = google_compute_instance.vm.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "user:${var.operator_email}"
}
