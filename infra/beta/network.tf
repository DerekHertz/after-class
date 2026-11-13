# One public subnet and no NAT gateway. The instance has a public Elastic IP, and its security group admits only
# ports 80 and 443 from ingress_cidrs.
resource "aws_vpc" "beta" {
  cidr_block           = "10.1.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

resource "aws_internet_gateway" "beta" {
  vpc_id = aws_vpc.beta.id

  tags = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.beta.id
  availability_zone       = var.availability_zone
  cidr_block              = cidrsubnet(aws_vpc.beta.cidr_block, 8, 0)
  map_public_ip_on_launch = false

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.beta.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.beta.id
  }

  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "beta" {
  name        = var.name
  description = "Beta server: HTTP and HTTPS from the allowed CIDRs, no SSH"
  vpc_id      = aws_vpc.beta.id

  tags = { Name = var.name }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each = toset(var.ingress_cidrs)

  security_group_id = aws_security_group.beta.id
  description       = "HTTP from an allowed CIDR"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each = toset(var.ingress_cidrs)

  security_group_id = aws_security_group.beta.id
  description       = "HTTPS from an allowed CIDR"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

# Package installs, ECR pulls, the Caddy image pull, Systems Manager, CloudWatch Logs and the Let's Encrypt calls all use
# HTTPS. DNS to the VPC resolver and the instance metadata and time services are not filtered by security groups.
resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.beta.id
  description       = "HTTPS out for packages, ECR, Systems Manager, CloudWatch Logs and certificate issuance"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}
