output "ecr_repository_url" {
  value       = aws_ecr_repository.app.repository_url
  description = "Push the container image here before applying (see deploy/README.md)."
}

output "service_url" {
  value       = "https://${aws_apprunner_service.app.service_url}"
  description = "Default App Runner URL (works before the custom domain is live)."
}

output "mcp_endpoint" {
  value       = "https://${var.domain_name}/mcp"
  description = "The MCP endpoint to register as a Claude custom connector."
}

output "bearer_token" {
  value       = random_password.bearer.result
  sensitive   = true
  description = "Authorization: Bearer <this>. Read with: terraform output -raw bearer_token"
}
