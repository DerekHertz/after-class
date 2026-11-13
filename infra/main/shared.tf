# The image repository and the GitHub OIDC provider belong to infra/shared, so this stack and infra/beta never
# create or fight over them. Apply infra/shared first. The state bucket name is derived the same way bootstrap names it.
data "terraform_remote_state" "shared" {
  backend = "s3"

  config = {
    bucket = "afterclass-tfstate-${data.aws_caller_identity.current.account_id}"
    key    = "shared/terraform.tfstate"
    region = var.region
  }
}

locals {
  ecr_repository_arn       = data.terraform_remote_state.shared.outputs.ecr_repository_arn
  ecr_repository_name      = data.terraform_remote_state.shared.outputs.ecr_repository_name
  ecr_repository_url       = data.terraform_remote_state.shared.outputs.ecr_repository_url
  github_oidc_provider_arn = data.terraform_remote_state.shared.outputs.github_oidc_provider_arn
}
