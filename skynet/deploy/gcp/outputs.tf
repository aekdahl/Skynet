output "vm_name" {
  value       = google_compute_instance.vm.name
  description = "The GCE instance name."
}

output "artifact_registry_image_base" {
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${var.name_prefix}/skynet"
  description = "Base image ref. setup.sh pushes :latest here and passes it as -var image=..."
}

output "iap_tunnel_command" {
  value       = "gcloud compute start-iap-tunnel ${google_compute_instance.vm.name} ${var.app_port} --local-host-port=127.0.0.1:${var.local_port} --zone=${var.zone} --project=${var.project_id}"
  description = "Run this, then open http://127.0.0.1:<local_port> — private, IAM-gated, no public IP. (Bind to 127.0.0.1, not localhost: on macOS localhost prefers IPv6 ::1, which the IAP tunnel mishandles and drops the board's WebSocket.)"
}

output "set_secrets_hint" {
  value       = "Add values with: printf '%s' '<VALUE>' | gcloud secrets versions add ${var.name_prefix}-<name> --data-file=- --project=${var.project_id}  (names: anthropic-api-key, telegram-bot-token, telegram-owner-chat-id, admin-password, master-key, github-token)"
  description = "How to load the Secret Manager values (never stored in Terraform)."
}
