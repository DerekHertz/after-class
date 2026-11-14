terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.71.0"
    }
  }

  # The bucket comes from the bootstrap stack: terraform init -backend-config="bucket=<state_bucket>"
  backend "s3" {
    key          = "beta/terraform.tfstate"
    region       = "us-east-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project = "after-class"
      stack   = "beta"
    }
  }
}

data "aws_caller_identity" "current" {}

# The image repository and the GitHub OIDC provider belong to infra/shared. Apply that stack first. The state bucket name
# is derived the same way bootstrap names it.
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
  github_oidc_provider_arn = data.terraform_remote_state.shared.outputs.github_oidc_provider_arn
}
