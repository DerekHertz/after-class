data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

data "aws_ec2_instance_type_offerings" "here" {
  location_type = "availability-zone"

  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

resource "aws_cloudwatch_log_group" "beta" {
  name              = "/${var.name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Session Manager is the only way in, since the security group has no SSH rule and the instance has no key pair.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "instance" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "EcrPull"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [local.ecr_repository_arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.beta.arn}:log-stream:*"]
  }

  statement {
    sid       = "ReadAppKeys"
    actions   = ["ssm:GetParameter"]
    resources = [local.key_parameters_arn]
  }

  # AmazonSSMManagedInstanceCore allows ssm:GetParameter and ssm:GetParameters on every parameter, and the aws/ssm key
  # policy lets any principal in the account decrypt through Systems Manager. Without this deny the instance could read
  # every SecureString in the account.
  statement {
    sid           = "NoOtherParameters"
    effect        = "Deny"
    actions       = ["ssm:GetParameter*"]
    not_resources = [local.key_parameters_arn]
  }

  statement {
    sid       = "DecryptAppKeys"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

# Exists once the account holds a SecureString parameter, so create the key parameters before the first plan.
data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

resource "aws_iam_role_policy" "instance" {
  name   = "pull-image-and-write-logs"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.instance.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
}

# The network interface carries the Elastic IP before the instance exists, so cloud-init has internet from its first
# command. Associating the address to a running instance afterwards would race the package install.
resource "aws_network_interface" "beta" {
  subnet_id       = aws_subnet.public.id
  security_groups = [aws_security_group.beta.id]
  description     = "${var.name} primary interface"

  tags = { Name = var.name }
}

resource "aws_eip" "beta" {
  domain            = "vpc"
  network_interface = aws_network_interface.beta.id

  tags = { Name = var.name }

  depends_on = [aws_internet_gateway.beta]
}

# The data volume is its own resource, so it survives an instance replacement. The instance can start before the
# attachment finishes, so the bootstrap script waits for the device. Nothing formats it at boot. The operator formats a
# new volume once with afterclass-format-data (infra/README.md).
resource "aws_ebs_volume" "data" {
  availability_zone = var.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name                = "${var.name}-data"
    afterclass-snapshot = "daily"
  }

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  # The app's keys are SecureString parameters under this path (infra/README.md). ElevenLabs stays off in the beta.
  key_parameter_prefix = "/afterclass/beta"
  key_parameters_arn   = "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.key_parameter_prefix}/*"

  # The name Caddy serves and gets a certificate for. Empty means plain HTTP on the Elastic IP.
  site_name = var.domain != null ? var.domain : (var.sslip_https ? "${replace(aws_eip.beta.public_ip, ".", "-")}.sslip.io" : "")

  caddyfile = templatefile("${path.module}/files/Caddyfile.tftpl", {
    domain   = local.site_name
    app_port = var.app_port
  })

  settings = join("\n", [
    "AWS_REGION=${var.region}",
    "ECR_REGISTRY=${local.ecr_registry}",
    "ECR_REPOSITORY=${local.ecr_repository_name}",
    "CADDY_IMAGE=${var.caddy_image}",
    "LOG_GROUP=${aws_cloudwatch_log_group.beta.name}",
    "DATA_VOLUME_ID=${aws_ebs_volume.data.id}",
    "APP_PORT=${var.app_port}",
    "KEY_PARAMETER_PREFIX=${local.key_parameter_prefix}",
    "",
  ])

  public_origin = local.site_name == "" ? "http://${aws_eip.beta.public_ip}" : "https://${local.site_name}"

  # The Dockerfile sets the replay skeleton's defaults. The beta runs live, with the keys from Parameter Store, Claude
  # through the Messages API only, and Clerk sign-in (docs/architecture/hosted-sign-in.md).
  app_env = join("\n", concat([
    "AFTERCLASS_HOST=0.0.0.0",
    "AFTERCLASS_PORT=${var.app_port}",
    "AFTERCLASS_HEALTH_ANY_HOST=1",
    "AFTERCLASS_MODE=live",
    "AFTERCLASS_CLAUDE_BACKEND=api",
    "AFTERCLASS_AUTH=clerk",
    "AFTERCLASS_PUBLIC_ORIGIN=${local.public_origin}",
    "AFTERCLASS_CLERK_PUBLISHABLE_KEY=${var.clerk_publishable_key}",
    "AFTERCLASS_CLERK_ISSUER=${local.clerk_frontend_api}",
    "AFTERCLASS_CLERK_JWKS_URL=${local.clerk_frontend_api}/.well-known/jwks.json",
    ], var.extension_id == null ? [] : ["AFTERCLASS_EXTENSION_ID=${var.extension_id}"], [
    "",
  ]))

  files = [
    { path = "/etc/afterclass/settings.env", mode = "0644", content = local.settings },
    { path = "/etc/afterclass/app.env", mode = "0644", content = local.app_env },
    { path = "/etc/afterclass/Caddyfile", mode = "0644", content = local.caddyfile },
    { path = "/etc/systemd/system/afterclass-app.service", mode = "0644", content = file("${path.module}/files/afterclass-app.service") },
    { path = "/etc/systemd/system/afterclass-caddy.service", mode = "0644", content = file("${path.module}/files/afterclass-caddy.service") },
    { path = "/usr/local/sbin/afterclass-bootstrap", mode = "0755", content = file("${path.module}/files/afterclass-bootstrap.sh") },
    { path = "/usr/local/sbin/afterclass-format-data", mode = "0755", content = file("${path.module}/files/afterclass-format-data.sh") },
    { path = "/usr/local/sbin/afterclass-pull", mode = "0755", content = file("${path.module}/files/afterclass-pull.sh") },
    { path = "/usr/local/sbin/afterclass-save-image", mode = "0755", content = file("${path.module}/files/afterclass-save-image.sh") },
    { path = "/usr/local/sbin/afterclass-app-start", mode = "0755", content = file("${path.module}/files/afterclass-app-start.sh") },
    { path = "/usr/local/sbin/afterclass-fetch-keys", mode = "0755", content = file("${path.module}/files/afterclass-fetch-keys.sh") },
    { path = "/usr/local/sbin/afterclass-deploy", mode = "0755", content = file("${path.module}/files/afterclass-deploy.sh") },
  ]

  user_data = "#cloud-config\n${yamlencode({
    write_files = [
      for f in local.files : {
        path        = f.path
        permissions = f.mode
        owner       = "root:root"
        encoding    = "gz+b64"
        content     = base64gzip(f.content)
      }
    ]
    runcmd = [["/usr/local/sbin/afterclass-bootstrap"]]
  })}\n"
}

# A change to the settings, the units or the scripts changes user_data and replaces the instance. The data volume, the
# Elastic IP and the network interface stay, so a replacement costs a few minutes of downtime and no data. The AMI is
# ignored so that a new Amazon Linux release does not replace the instance. Replace it on purpose with
# terraform apply -replace=aws_instance.beta.
resource "aws_instance" "beta" {
  ami                  = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type        = var.instance_type
  iam_instance_profile = aws_iam_instance_profile.instance.name

  user_data                   = local.user_data
  user_data_replace_on_change = true

  network_interface {
    network_interface_id = aws_network_interface.beta.id
    device_index         = 0
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  tags = { Name = var.name }

  # Everything cloud-init needs on its first command must exist before the instance starts.
  depends_on = [
    aws_eip.beta,
    aws_route_table_association.public,
    aws_vpc_security_group_egress_rule.https,
    aws_iam_role_policy_attachment.ssm_core,
    aws_iam_role_policy.instance,
  ]

  lifecycle {
    ignore_changes = [ami]

    precondition {
      condition     = contains(data.aws_ec2_instance_type_offerings.here.locations, var.availability_zone)
      error_message = "${var.instance_type} is not offered in ${var.availability_zone}. Set availability_zone to a zone that offers it."
    }
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.beta.id

  # Stops the instance before detaching, so a replacement never pulls a mounted volume out from under a running database.
  stop_instance_before_detaching = true
}

# The deploy role reads this to find the current instance, so an instance replacement needs no change in GitHub.
resource "aws_ssm_parameter" "instance_id" {
  name  = "/${var.name}/instance_id"
  type  = "String"
  value = aws_instance.beta.id
}
