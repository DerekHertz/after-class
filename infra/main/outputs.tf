output "alb_dns_name" {
  description = "The load balancer's own name. Visit http://<this>/health from an allowed address."
  value       = aws_lb.api.dns_name
}

output "ecr_repository_url" {
  description = "Registry URL for the API image."
  value       = aws_ecr_repository.api.repository_url
}

output "deploy_role_arn" {
  description = "Role the deploy workflow assumes. Set it as the AWS_ROLE_ARN variable of the production environment."
  value       = aws_iam_role.deploy.arn
}

output "ecr_repository_name" {
  description = "Set as the ECR_REPOSITORY variable of the production environment."
  value       = aws_ecr_repository.api.name
}

output "ecs_cluster_name" {
  description = "Set as the ECS_CLUSTER variable of the production environment."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "Set as the ECS_SERVICE variable of the production environment."
  value       = aws_ecs_service.api.name
}

output "db_master_secret_arn" {
  description = "Secrets Manager ARN of the RDS master password, or null when create_database is false."
  value       = var.create_database ? aws_db_instance.main[0].master_user_secret[0].secret_arn : null
}
