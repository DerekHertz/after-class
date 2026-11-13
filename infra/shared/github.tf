# One GitHub OIDC provider exists per account, so it lives here and the beta and main stacks only read its ARN.
# The deploy workflows sign in with a short-lived GitHub OIDC token, so no AWS key is stored in GitHub.
# AWS validates the token against GitHub's published keys, so no thumbprint is set.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
