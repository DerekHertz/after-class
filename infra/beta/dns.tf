# Optional. With no domain there is no record and the server answers HTTP on the Elastic IP.
data "aws_route53_zone" "domain" {
  count = var.domain == null ? 0 : 1

  name         = var.domain
  private_zone = false
}

resource "aws_route53_record" "apex" {
  count = var.domain == null ? 0 : 1

  zone_id = data.aws_route53_zone.domain[0].zone_id
  name    = var.domain
  type    = "A"
  ttl     = 300
  records = [aws_eip.beta.public_ip]
}
