# scripts/deploy-beta.sh starts this document with Derek's own AWS sign-in. It takes only a 40-digit commit hash and
# runs /usr/local/sbin/afterclass-deploy with it, so a deploy cannot name an image from another registry.
resource "aws_ssm_document" "deploy" {
  name            = "${var.name}-deploy"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Pull the GHCR image tagged with the given commit hash and restart the app container."
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

