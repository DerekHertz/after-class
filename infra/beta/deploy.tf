# scripts/deploy-beta.sh starts this document with Derek's own AWS sign-in. It takes a 40-digit commit hash and an image
# digest and runs /usr/local/sbin/afterclass-deploy with them, so a deploy cannot name an image from another registry or by
# a mutable tag.
resource "aws_ssm_document" "deploy" {
  name            = "${var.name}-deploy"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Pull the GHCR image with the given digest and restart the app container."
    parameters = {
      tag = {
        type           = "String"
        description    = "The release's commit, a full lowercase commit hash. It labels the output."
        allowedPattern = "^[0-9a-f]{40}$"
      }
      digest = {
        type           = "String"
        description    = "The image digest the release recorded, sha256 and 64 lowercase hex digits."
        allowedPattern = "^sha256:[0-9a-f]{64}$"
      }
    }
    mainSteps = [
      {
        action = "aws:runShellScript"
        name   = "deploy"
        inputs = {
          runCommand     = ["/usr/local/sbin/afterclass-deploy {{ tag }} {{ digest }}"]
          timeoutSeconds = "600"
        }
      },
    ]
  })
}
