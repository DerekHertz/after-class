# The deploy workflow does not get a general shell command. It may start one Systems Manager document on this
# instance, and that document takes a 40-digit commit hash and runs /usr/local/sbin/afterclass-deploy with it.
resource "aws_ssm_document" "deploy" {
  name            = "${var.name}-deploy"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Pull the image tagged with the given commit hash and restart the app container."
    parameters = {
      tag = {
        type           = "String"
        description    = "Image tag, a full lowercase commit hash."
        allowedPattern = "^[0-9a-f]{40}$"
      }
    }
    mainSteps = [
      {
        action = "aws:runShellScript"
        name   = "deploy"
        inputs = {
          runCommand     = ["/usr/local/sbin/afterclass-deploy {{ tag }}"]
          timeoutSeconds = "600"
        }
      },
    ]
  })
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only a job that runs in this repository's protected environment gets the role. The subject carries no branch,
    # so the environment itself must allow deployments from master only (infra/README.md, GitHub setup).
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [local.ecr_repository_arn]
  }

  statement {
    sid     = "RunDeployDocumentOnTheInstance"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_ssm_document.deploy.arn,
      "arn:aws:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.beta.id}",
    ]
  }

  # GetCommandInvocation takes no resource-level permission. A command id is unguessable and only this role's own
  # command is of interest.
  statement {
    sid       = "ReadCommandResult"
    actions   = ["ssm:GetCommandInvocation"]
    resources = ["*"]
  }

  statement {
    sid       = "FindTheInstance"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.instance_id.arn]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy-beta"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
