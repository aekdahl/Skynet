variable "project_id" {
  type        = string
  description = "GCP project to deploy into."
}

variable "region" {
  type        = string
  default     = "europe-west1"
  description = "Region for the subnet + Artifact Registry."
}

variable "zone" {
  type        = string
  default     = "europe-west1-b"
  description = "Zone for the VM + its data disk (must be in region). NB: europe-west1 has no -a zone (b/c/d only)."
}

variable "machine_type" {
  type        = string
  default     = "e2-small"
  description = "VM size. e2-small (2GB) is fine for orchestration + a light Claude agent; bump to e2-medium/standard for heavier builds."
}

variable "app_port" {
  type        = number
  default     = 8080
  description = "Port the Skynet server listens on inside the VM (the remote end of the IAP tunnel)."
}

variable "local_port" {
  type        = number
  default     = 48080
  description = "Local port the IAP tunnel binds on your machine (what the browser connects to). Off the common dev-server ports (3000/8000/8080/5173) to avoid conflicts; the app still listens on app_port remotely."
}

variable "data_disk_gb" {
  type        = number
  default     = 20
  description = "Persistent disk for /data (STORE=file lives here; snapshot it for backups)."
}

variable "operator_email" {
  type        = string
  description = "Your Google account email — granted IAP tunnel access to reach the board (roles/iap.tunnelResourceAccessor)."
}

variable "admin_email" {
  type        = string
  description = "Seed operator login email for the Skynet UI (SKYNET_ADMIN_EMAIL). The password is a Secret Manager secret you set separately."
}

variable "admin_workspace" {
  type        = string
  default     = "skynet"
  description = "Workspace the seeded admin belongs to (SKYNET_ADMIN_WORKSPACE)."
}

variable "telegram_control" {
  type        = bool
  default     = false
  description = "Enable conversational + approve/create control over Telegram (SKYNET_TELEGRAM_CONTROL). Off = notifications + status + kill switch only."
}

variable "image" {
  type        = string
  default     = ""
  description = "Full Artifact Registry image ref the VM runs. Leave empty; setup.sh builds + pushes it and passes it in on apply."
}

variable "name_prefix" {
  type        = string
  default     = "skynet"
  description = "Prefix for created resource names."
}
