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
# attachment finishes, so the bootstrap script waits for the device.
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
  caddyfile = templatefile("${path.module}/files/Caddyfile.tftpl", {
    domain   = var.domain == null ? "" : var.domain
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
    "",
  ])

  # The Dockerfile already sets these. Listing the three that depend on how the server is wired keeps them explicit.
  app_env = join("\n", [
    "AFTERCLASS_HOST=0.0.0.0",
    "AFTERCLASS_PORT=${var.app_port}",
    "AFTERCLASS_HEALTH_ANY_HOST=1",
    "",
  ])

  files = [
    { path = "/etc/afterclass/settings.env", mode = "0644", content = local.settings },
    { path = "/etc/afterclass/app.env", mode = "0644", content = local.app_env },
    { path = "/etc/afterclass/Caddyfile", mode = "0644", content = local.caddyfile },
    { path = "/etc/systemd/system/afterclass-app.service", mode = "0644", content = file("${path.module}/files/afterclass-app.service") },
    { path = "/etc/systemd/system/afterclass-caddy.service", mode = "0644", content = file("${path.module}/files/afterclass-caddy.service") },
    { path = "/usr/local/sbin/afterclass-bootstrap", mode = "0755", content = file("${path.module}/files/afterclass-bootstrap.sh") },
    { path = "/usr/local/sbin/afterclass-pull", mode = "0755", content = file("${path.module}/files/afterclass-pull.sh") },
    { path = "/usr/local/sbin/afterclass-app-start", mode = "0755", content = file("${path.module}/files/afterclass-app-start.sh") },
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
