variable "project_id" {
  type        = string
  description = "GCP project to deploy into."
}

variable "region" {
  type        = string
  default     = "europe-west1"
  description = "Region for the subnet, static IP + Artifact Registry."
}

variable "zone" {
  type        = string
  default     = "europe-west1-b"
  description = "Zone for the VM + its data disk (must be in region). NB: europe-west1 has no -a zone (b/c/d only)."
}

variable "machine_type" {
  type        = string
  default     = "e2-small"
  description = "VM size. e2-small (2GB) is fine for orchestration + a light Claude agent; bump for heavier builds."
}

variable "app_port" {
  type        = number
  default     = 8080
  description = "Port the Skynet server listens on INSIDE the private docker network (never published to the VM host or the internet — only Caddy reaches it)."
}

variable "data_disk_gb" {
  type        = number
  default     = 20
  description = "Persistent disk for /data (STORE=file + Caddy's ACME cert store live here; snapshot it for backups)."
}

variable "name_prefix" {
  type        = string
  default     = "skynet-mcp"
  description = "Prefix for created resource names."
}

variable "image" {
  type        = string
  default     = ""
  description = "Full Artifact Registry image ref the VM runs. Leave empty; setup.sh builds + pushes it and passes it in on apply."
}

# ── The public HTTPS endpoint ────────────────────────────────────────────────
variable "mcp_domain" {
  type        = string
  description = "DNS name that resolves (A record) to this VM's static IP and terminates TLS, e.g. mcp.example.com. The final endpoint is https://<mcp_domain>/mcp. A real DNS name is required — Let's Encrypt won't issue for a bare IP."
  validation {
    condition     = length(trimspace(var.mcp_domain)) > 0 && !can(regex("^[0-9.]+$", var.mcp_domain))
    error_message = "mcp_domain must be a DNS hostname (not empty, not a bare IP) — ACME cannot issue a cert for an IP address."
  }
}

variable "acme_email" {
  type        = string
  description = "Email for the Let's Encrypt ACME account (expiry notices). Required — Caddy needs it to register."
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.acme_email))
    error_message = "acme_email must be a valid email address."
  }
}

variable "mcp_scopes" {
  type        = string
  default     = "observe,author"
  description = "Scopes granted to the injected MCP token (SKYNET_BOOTSTRAP_SCOPES). Default observe+author lets an agent plan/run work but NOT approve its own HITL gates. Add 'approver' only if you deliberately want the token to self-resolve gates."
}

# ── Ingress lockdown (this replaces IAP) ─────────────────────────────────────
variable "allowed_source_ranges" {
  type        = list(string)
  description = "CIDR allowlist for the MCP data plane (TCP 443). This is the ingress lockdown that replaces Google IAP — set it to the known egress IPs of your MCP clients (e.g. [\"203.0.113.7/32\"]). MUST NOT be 0.0.0.0/0."
  validation {
    condition     = length(var.allowed_source_ranges) > 0 && !contains(var.allowed_source_ranges, "0.0.0.0/0")
    error_message = "allowed_source_ranges must be a non-empty allowlist and must NOT contain 0.0.0.0/0 — the MCP port is never opened to the whole internet."
  }
}

variable "ssh_source_ranges" {
  type        = list(string)
  default     = []
  description = "Optional CIDR allowlist for SSH (TCP 22) for VM administration. Empty (default) = NO inbound SSH rule at all (administer via the serial console or gcloud). Set to your admin IP(s) if you want SSH; never 0.0.0.0/0."
  validation {
    condition     = !contains(var.ssh_source_ranges, "0.0.0.0/0")
    error_message = "ssh_source_ranges must not contain 0.0.0.0/0."
  }
}

variable "open_acme_http" {
  type        = bool
  default     = true
  description = "Open TCP 80 to the internet for Let's Encrypt's HTTP-01 challenge (Caddy serves ONLY the ACME challenge + a 301 redirect to https on :80 — no MCP data is exposed on :80). Set false only if you switch Caddy to the DNS-01 challenge (see README) so cert issuance needs no inbound port."
}
