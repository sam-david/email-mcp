output "ecr_repository_url" {
  value       = aws_ecr_repository.app.repository_url
  description = "Push the container image here before applying (see deploy/README.md)."
}

output "service_url" {
  value       = "https://${aws_apprunner_service.app.service_url}"
  description = "Default App Runner URL (works before the custom domain resolves)."
}

output "mcp_base" {
  value       = "https://${var.domain_name}"
  description = "MCP endpoint per profile: <mcp_base>/<profile>  (e.g. .../dva)"
}

output "profile_bearers" {
  value       = { for k, r in random_password.bearer : k => r.result }
  sensitive   = true
  description = "Suggested bearer token per profile. View: terraform output -json profile_bearers"
}
