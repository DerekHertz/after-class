variable "region" {
  description = "AWS region. The backend block in versions.tf is pinned to the same value."
  type        = string
  default     = "us-east-2"
}

variable "name" {
  description = "Prefix for resource names. The main stack uses the same default, so the repository name matches."
  type        = string
  default     = "afterclass"
}
