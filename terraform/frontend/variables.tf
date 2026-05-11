variable "aws_region" {
  description = "AWS region for the S3 bucket. CloudFront is global; the bucket region only affects origin latency."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment — drives naming, retention, and price class."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be one of: staging, production"
  }
}

variable "frontend_build_path" {
  description = "Local path to the Next.js static export output. Run `npm run build` in frontend/ before `terraform apply`."
  type        = string
  default     = "../../frontend/out"
}

variable "project_tags" {
  description = "Tags applied to every taggable resource."
  type        = map(string)
  default = {
    Project   = "pr-review-agent"
    ManagedBy = "terraform"
  }
}

variable "invalidate_on_deploy" {
  description = "When true, runs `aws cloudfront create-invalidation` after the bucket sync so changes are visible immediately. Requires AWS CLI on the machine running terraform."
  type        = bool
  default     = true
}
