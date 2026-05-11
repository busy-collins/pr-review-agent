output "dashboard_url" {
  description = "Public URL of the dashboard (HTTPS via CloudFront)."
  value       = "https://${aws_cloudfront_distribution.dashboard.domain_name}"
}

output "distribution_id" {
  description = "CloudFront distribution ID. Use with `aws cloudfront create-invalidation` for ad-hoc cache busts."
  value       = aws_cloudfront_distribution.dashboard.id
}

output "distribution_domain_name" {
  description = "CloudFront-assigned domain name (e.g. d123abc.cloudfront.net)."
  value       = aws_cloudfront_distribution.dashboard.domain_name
}

output "bucket_name" {
  description = "Name of the S3 bucket backing the distribution."
  value       = aws_s3_bucket.dashboard.id
}

output "bucket_arn" {
  description = "ARN of the S3 bucket — useful if granting other accounts read access via the bucket policy."
  value       = aws_s3_bucket.dashboard.arn
}
