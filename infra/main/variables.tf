variable "region" {
  description = "AWS region. The backend block in versions.tf is pinned to the same value."
  type        = string
  default     = "us-east-2"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "afterclass"
}

variable "alb_ingress_cidrs" {
  description = "CIDR blocks allowed to reach the load balancer on port 80, for example [\"203.0.113.7/32\"]. Required, no default, so the service is never open to the internet by omission."
  type        = list(string)

  validation {
    condition     = length(var.alb_ingress_cidrs) > 0 && alltrue([for c in var.alb_ingress_cidrs : can(cidrhost(c, 0))])
    error_message = "alb_ingress_cidrs needs at least one valid CIDR block."
  }
}

variable "certificate_arn" {
  description = "ACM certificate ARN. Null serves HTTP only. When a domain exists, issue a certificate in the same region as the load balancer, set this, and the load balancer adds a 443 listener and redirects 80 to it."
  type        = string
  default     = null
}

variable "container_port" {
  description = "Port the backend listens on. Matches AFTERCLASS_PORT in the Dockerfile."
  type        = number
  default     = 8080
}

variable "desired_count" {
  description = "Number of API tasks. Set 0 to stop paying for compute while keeping everything else."
  type        = number
  default     = 1
}

variable "alb_idle_timeout_seconds" {
  description = "Load balancer idle timeout. 300 matches the backend's 5-minute turn deadline (TURN_DEADLINE_MS). The stream has no heartbeat yet, and Bun's 255 s socket idle timeout can end a silent stream first."
  type        = number
  default     = 300
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the API task."
  type        = number
  default     = 14
}

variable "create_database" {
  description = "Create the RDS PostgreSQL instance. Off by default because it bills around the clock and the app does not use Postgres yet."
  type        = bool
  default     = false
}

variable "db_instance_class" {
  description = "Smallest Graviton instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "github_oidc_provider_arn" {
  description = "ARN of the account's GitHub OIDC provider, the federated principal of the deploy role. Required, no default. This account's service control policy denies iam:CreateOpenIDConnectProvider, so the stack cannot be applied here until a provider exists or the deploy takes another route."
  type        = string
}

variable "github_repository" {
  description = "owner/name of the repository whose deploy workflow may assume the deploy role."
  type        = string
  default     = "DerekHertz/after-class"
}

variable "github_environment" {
  description = "GitHub environment the deploy job runs in. The role trust policy accepts only this environment, so the environment's required reviewers gate every deploy."
  type        = string
  default     = "production"
}
