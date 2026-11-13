variable "region" {
  description = "AWS region. The backend block in versions.tf is pinned to the same value."
  type        = string
  default     = "us-east-2"
}

variable "name" {
  description = "Prefix for resource names. The beta and main stacks use the same default, so the repository name matches in both."
  type        = string
  default     = "afterclass"
}
