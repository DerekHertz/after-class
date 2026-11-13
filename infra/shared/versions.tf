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
    key          = "shared/terraform.tfstate"
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
      stack   = "shared"
    }
  }
}
