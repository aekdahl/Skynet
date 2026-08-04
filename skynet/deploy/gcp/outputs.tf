output "vm_name" {
  value       = google_compute_instance.vm.name
  description = "The GCE instance name."
}

output "artifact_registry_image_base" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.name_prefix}/skynet"
  description = "Base image ref. setup.sh pushes :latest here and passes it as -var image=..."
}

output "iap_tunnel_command" {
  value       = "gcloud compute ssh ${google_compute_instance.vm.name} --zone=${var.zone} --project=${var.project_id} --tunnel-through-iap -- -N -L ${var.local_port}:localhost:${var.app_port}"
  description = "Run this (leave it running), then open http://127.0.0.1:<local_port> — private, IAM-gated, no public IP. It's an SSH local-forward over IAP: one stable stream that carries the board's live WebSocket reliably, unlike raw start-iap-tunnel (which drops the WS mid-snapshot → UI hangs on 'loading your workspace…')."
}

output "set_secrets_hint" {
  value       = "Add values with: printf '%s' '<VALUE>' | gcloud secrets versions add ${var.name_prefix}-<name> --data-file=- --project=${var.project_id}  (names: anthropic-api-key, telegram-bot-token, telegram-owner-chat-id, admin-password, master-key, github-token${var.enable_mcp_https ? ", mcp-token" : ""})"
  description = "How to load the Secret Manager values (never stored in Terraform)."
}

# ── Public endpoints (enable_mcp_https = narrow /mcp door; public_ui = whole app)
output "board_url" {
  value       = var.public_ui ? "https://${var.mcp_domain}" : "(public_ui=false — reach the board over the IAP tunnel; see iap_tunnel_command)"
  description = "Public web board URL (public_ui). Log in with admin_email + the admin-password secret (+ MFA)."
}

output "mcp_url" {
  value       = (var.enable_mcp_https || var.public_ui) ? "https://${var.mcp_domain}/mcp" : "(no public endpoint — the box is IAP-only)"
  description = "The public MCP endpoint. Bearer-gated (Settings service token under public_ui; the mcp-token secret under enable_mcp_https)."
}

output "mcp_vm_ip" {
  value       = var.public_ui ? one(data.google_compute_address.public[*].address) : (var.enable_mcp_https ? one(google_compute_address.mcp[*].address) : "(no static IP — IAP-only)")
  description = "Static external IP for the mcp_domain A-record (set it BEFORE apply so Caddy can complete ACME). public_ui uses the pre-reserved <name_prefix>-public-ip."
}

output "mcp_auth_header" {
  value       = "Authorization: Bearer <MCP_TOKEN>"
  description = "Header every /mcp request must carry. <MCP_TOKEN> is the value in the <name_prefix>-mcp-token secret."
}

output "claude_mcp_add_command" {
  value       = var.enable_mcp_https ? "claude mcp add --transport http skynet https://${var.mcp_domain}/mcp --header \"Authorization: Bearer <MCP_TOKEN>\"" : "(enable_mcp_https=false)"
  description = "Ready-to-run command to register the MCP endpoint with Claude Code (substitute the real token)."
}
