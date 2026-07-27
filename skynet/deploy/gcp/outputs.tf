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
  value       = "Add values with: printf '%s' '<VALUE>' | gcloud secrets versions add ${var.name_prefix}-<name> --data-file=- --project=${var.project_id}  (names: anthropic-api-key, telegram-bot-token, telegram-owner-chat-id, admin-password, master-key, github-token)"
  description = "How to load the Secret Manager values (never stored in Terraform)."
}
