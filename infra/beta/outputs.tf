output "public_url" {
  description = "Set as the BETA_URL variable of the production environment. The https address when a domain is set, otherwise http on the Elastic IP."
  value       = var.domain == null ? "http://${aws_eip.beta.public_ip}" : "https://${var.domain}"
}

output "elastic_ip" {
  description = "The server's public address. Stays the same when the instance is replaced."
  value       = aws_eip.beta.public_ip
}

output "instance_id" {
  description = "Open a shell with: aws ssm start-session --target <this>. The deploy workflow finds it through instance_id_parameter."
  value       = aws_instance.beta.id
}

output "instance_id_parameter" {
  description = "Set as the BETA_INSTANCE_PARAMETER variable of the production environment."
  value       = aws_ssm_parameter.instance_id.name
}

output "deploy_document_name" {
  description = "Set as the BETA_DEPLOY_DOCUMENT variable of the production environment."
  value       = aws_ssm_document.deploy.name
}

output "deploy_role_arn" {
  description = "Role the deploy-beta workflow assumes. Set it as the BETA_ROLE_ARN variable of the production environment."
  value       = aws_iam_role.deploy.arn
}

output "log_group_name" {
  description = "CloudWatch log group for the app and Caddy containers."
  value       = aws_cloudwatch_log_group.beta.name
}

output "data_volume_id" {
  description = "The encrypted data volume mounted at /data."
  value       = aws_ebs_volume.data.id
}
