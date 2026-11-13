output "ecr_repository_name" {
  description = "Set as the ECR_REPOSITORY variable of the production environment."
  value       = aws_ecr_repository.api.name
}

output "ecr_repository_arn" {
  description = "Read by the beta and main stacks for their pull and push permissions."
  value       = aws_ecr_repository.api.arn
}

output "ecr_repository_url" {
  description = "Registry URL for the API image."
  value       = aws_ecr_repository.api.repository_url
}

output "github_oidc_provider_arn" {
  description = "Read by the beta and main stacks as the federated principal of their deploy roles."
  value       = aws_iam_openid_connect_provider.github.arn
}
