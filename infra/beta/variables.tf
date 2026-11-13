variable "region" {
  description = "AWS region. The backend block in versions.tf is pinned to the same value."
  type        = string
  default     = "us-east-2"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "afterclass-beta"
}

variable "ingress_cidrs" {
  description = "CIDR blocks allowed to reach ports 80 and 443, for example [\"203.0.113.7/32\"]. Required, no default, so the server is never open to the internet by omission. Use Derek's address until sign-in lands, then [\"0.0.0.0/0\"]."
  type        = list(string)

  validation {
    condition     = length(var.ingress_cidrs) > 0 && alltrue([for c in var.ingress_cidrs : can(cidrhost(c, 0))])
    error_message = "ingress_cidrs needs at least one valid CIDR block."
  }
}

variable "domain" {
  description = "Apex domain, for example example.com, whose public hosted zone already exists in Route 53. Null creates no DNS record and serves HTTP only on the Elastic IP. A domain turns on automatic HTTPS, and Let's Encrypt must reach ports 80 and 443 from the internet, so it needs ingress_cidrs to include 0.0.0.0/0."
  type        = string
  default     = null

  validation {
    condition     = var.domain == null ? true : can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.domain))
    error_message = "domain must be a lowercase apex domain such as example.com."
  }

  validation {
    condition     = var.domain == null ? true : contains(var.ingress_cidrs, "0.0.0.0/0")
    error_message = "A domain needs ingress_cidrs to include 0.0.0.0/0, because Let's Encrypt validates from the internet and could not issue the certificate. Leave domain null until then."
  }
}

variable "sslip_https" {
  description = "With no domain, serve HTTPS on <elastic-ip-with-dashes>.sslip.io, a free public name that resolves to the Elastic IP, so the beta gets a real Let's Encrypt certificate before a domain is bought. Ignored when domain is set. Needs ingress_cidrs to include 0.0.0.0/0 for the same reason as domain."
  type        = bool
  default     = false

  validation {
    condition     = !var.sslip_https || contains(var.ingress_cidrs, "0.0.0.0/0")
    error_message = "sslip_https needs ingress_cidrs to include 0.0.0.0/0, because Let's Encrypt validates from the internet."
  }
}

variable "availability_zone" {
  description = "Zone for the instance and its data volume. Pinned, not looked up, so a change in the offerings never replaces the data volume."
  type        = string
  default     = "us-east-2a"
}

variable "instance_type" {
  description = "Graviton instance type. The image is built for linux/arm64."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  description = "Size of the encrypted gp3 root volume."
  type        = number
  default     = 12
}

variable "data_volume_gb" {
  description = "Size of the encrypted gp3 data volume mounted at /data. It holds the database, the config folder and Caddy's certificates."
  type        = number
  default     = 20
}

variable "app_port" {
  description = "Port the backend listens on inside the container and on the host's loopback. Matches AFTERCLASS_PORT in the Dockerfile."
  type        = number
  default     = 8080
}

variable "caddy_image" {
  description = "Caddy image, pinned by version and by digest of the multi-arch index. Read from the Docker Hub registry on 2026-11-13, where 2.11.8 was 8 days old."
  type        = string
  default     = "caddy:2.11.8@sha256:4fcafa98afd1c2e642e353e3c5cf9ddbe892fcee14bc990e7ba2c5b78e51f9cf"

  validation {
    condition     = can(regex("^[a-z0-9./_-]+:[0-9][0-9.]*@sha256:[0-9a-f]{64}$", var.caddy_image))
    error_message = "caddy_image must be name:version@sha256:<64 hex digits>."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the containers."
  type        = number
  default     = 14
}

variable "github_repository" {
  description = "owner/name of the repository whose deploy-beta workflow may assume the deploy role."
  type        = string
  default     = "DerekHertz/after-class"
}

variable "github_environment" {
  description = "GitHub environment the deploy job runs in. The role trust policy accepts only this environment, so the environment's required reviewers gate every deploy."
  type        = string
  default     = "production"
}
