output "mcp_url" {
  value       = "https://${var.mcp_domain}/mcp"
  description = "The final MCP endpoint. Point any MCP client here over Streamable HTTP."
}

output "mcp_auth_header" {
  value       = "Authorization: Bearer <MCP_TOKEN>"
  description = "Header every request must carry. <MCP_TOKEN> is the value stored in the <name_prefix>-mcp-token secret."
}

output "mcp_port_path" {
  value       = "public: 443 (HTTPS) → path /mcp | internal app port (private only): ${var.app_port}"
  description = "Port + path summary. Clients hit :443 on the domain at /mcp; the app itself listens on app_port inside the VM's private docker network only."
}

output "ui_url" {
  value       = local.ui_enabled ? "https://${var.ui_domain}/" : "(headless — no UI; set ui_domain to enable the web UI on this same instance)"
  description = "The human web UI (SPA + /api + /ws), served by the SAME instance + datastore as /mcp. Only real when ui_domain is set; login uses the seeded admin (admin_email + the <name_prefix>-admin-password secret)."
}

output "vm_external_ip" {
  value       = google_compute_address.mcp.address
  description = "Static external IP. Create DNS A records for mcp_domain (and ui_domain, if set) → this IP, BEFORE first boot so Caddy can complete the ACME challenge for each."
}

output "claude_mcp_add_command" {
  value       = "claude mcp add --transport http skynet https://${var.mcp_domain}/mcp --header \"Authorization: Bearer <MCP_TOKEN>\""
  description = "Ready-to-run command to register this endpoint with Claude Code (substitute the real token)."
}

output "artifact_registry_image_base" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.name_prefix}/skynet"
  description = "Base image ref. setup.sh pushes :latest here and passes it as -var image=..."
}

output "set_secrets_hint" {
  value       = "Add values with: printf '%s' '<VALUE>' | gcloud secrets versions add ${var.name_prefix}-<name> --data-file=- --project=${var.project_id}  (names: mcp-token, anthropic-api-key, master-key, github-token${local.ui_enabled ? ", admin-password" : ""}). The mcp-token value IS the Bearer token clients present${local.ui_enabled ? "; admin-password is the UI login for ${var.admin_email}" : ""}."
  description = "How to load the Secret Manager values (never stored in Terraform)."
}
