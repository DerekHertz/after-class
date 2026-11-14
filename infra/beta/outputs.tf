output "public_url" {
  description = "The https address when a domain or sslip_https is set, otherwise http on the Elastic IP."
  value       = local.public_origin
}

output "elastic_ip" {
  description = "The server's public address. Stays the same when the instance is replaced."
  value       = aws_eip.beta.public_ip
}

output "instance_id" {
  description = "Open a shell with: aws ssm start-session --target <this>. scripts/deploy-beta.sh finds it through instance_id_parameter."
  value       = aws_instance.beta.id
}

output "instance_id_parameter" {
  description = "Read by scripts/deploy-beta.sh, which has the default name written in."
  value       = aws_ssm_parameter.instance_id.name
}

output "deploy_document_name" {
  description = "Started by scripts/deploy-beta.sh, which has the default name written in."
  value       = aws_ssm_document.deploy.name
}

output "log_group_name" {
  description = "CloudWatch log group for the app and Caddy containers."
  value       = aws_cloudwatch_log_group.beta.name
}

output "data_volume_id" {
  description = "The encrypted data volume mounted at /data."
  value       = aws_ebs_volume.data.id
}
