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
  default     = "e2-standard-2"
  description = "VM size. e2-standard-2 (2 DEDICATED vCPUs / 8GB) handles agents + live-preview builds without the shared-core throttling that makes a busy e2-small drop connections (~$50/mo). Cheaper options for lighter use: e2-medium (2 shared vCPU / 4GB, ~$25/mo) or e2-small (2GB, ~$13/mo) for pure orchestration."
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
  default     = 30
  description = "Persistent disk for /data — holds the file store AND agent worktrees, cloned repos, and preview node_modules (kept off the small boot disk so churn can't wedge the VM). Bump it for many/large projects; the fs auto-grows on redeploy. Snapshot it for backups."
}

variable "boot_disk_gb" {
  type        = number
  default     = 50
  description = "Boot disk (OS + Docker images + container overlay). 50 GB gives headroom for image churn; agent scratch (/tmp, npm cache) is redirected to /data so it can't fill this. Growing it on an existing VM is non-destructive — a reboot auto-expands the root partition."
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

# ── Optional: a public HTTPS /mcp door for agents (keeps IAP for the human UI) ─
# Off by default → the box stays IAP-only (unchanged). When enabled, this SAME
# VM also gains Caddy on :443 serving ONLY /mcp (Bearer-gated, source-IP
# allowlisted) — so a non-browser client (e.g. a Cloud Run agent that can't use
# the IAP tunnel) can reach the MCP endpoint. The human UI/api/ws stay exactly as
# they are: reachable ONLY over the IAP tunnel on app_port. Same box, same data
# disk, in-place `terraform apply` — no new box, no migration.
variable "enable_mcp_https" {
  type        = bool
  default     = false
  description = "Add a public HTTPS /mcp endpoint (Caddy on :443, Bearer + source-IP allowlist) to this IAP box, for agents that can't use the tunnel. Off = IAP-only (unchanged). When true, mcp_domain + acme_email + mcp_allowed_source_ranges are required, and you add the <name_prefix>-mcp-token secret (the Bearer credential)."
}

variable "public_ui" {
  type        = bool
  default     = false
  description = "Serve the WHOLE app (UI + /mcp) publicly over HTTPS at mcp_domain with a Let's Encrypt cert, instead of IAP-only. The UI is gated by the app login (+ MFA); /mcp by a Bearer service token minted in Settings. Opens :443/:80 to the internet and keeps IAP for SSH (break-glass). Requires mcp_domain + acme_email and a pre-reserved static IP named <name_prefix>-public-ip (DNS A-record → its address). Mutually exclusive with the narrow enable_mcp_https door."
}

variable "mcp_domain" {
  type        = string
  default     = ""
  description = "DNS hostname for the public endpoint (A-record → the static IP). Required when enable_mcp_https or public_ui. Not a bare IP — ACME can't issue for an IP. The endpoint is https://<mcp_domain> (UI) / https://<mcp_domain>/mcp."
  validation {
    condition     = var.mcp_domain == "" || !can(regex("^[0-9.]+$", var.mcp_domain))
    error_message = "mcp_domain must be empty or a DNS hostname (not a bare IP)."
  }
}

variable "acme_email" {
  type        = string
  default     = ""
  description = "Let's Encrypt account email for the /mcp cert. Required when enable_mcp_https."
}

variable "mcp_allowed_source_ranges" {
  type        = list(string)
  default     = []
  description = "CIDR allowlist for the public /mcp door (TCP 443) — set to the egress IP(s) of your MCP clients (e.g. a Cloud Run static egress IP). Required non-empty when enable_mcp_https; never 0.0.0.0/0. This is what keeps the public door narrow; the human UI is unaffected (still IAP-only)."
  validation {
    condition     = !contains(var.mcp_allowed_source_ranges, "0.0.0.0/0")
    error_message = "mcp_allowed_source_ranges must not contain 0.0.0.0/0."
  }
}

variable "mcp_scopes" {
  type        = string
  default     = "observe,author"
  description = "Scopes for the injected MCP token (SKYNET_BOOTSTRAP_SCOPES). Default observe+author. Add 'approver' only if the token may resolve its own HITL gates."
}

variable "open_acme_http" {
  type        = bool
  default     = true
  description = "When enable_mcp_https, open TCP 80 to the internet for Let's Encrypt's HTTP-01 challenge (Caddy serves only the ACME challenge + a 301 to https there). Set false if you switch Caddy to the DNS-01 challenge."
}
