# ============================================================
# PR Review Agent — Frontend Hosting (Terraform)
# Mirrors infrastructure/cdk/stacks/frontend.stack.ts:
#   - Private S3 bucket (encrypted, public access blocked)
#   - CloudFront distribution with Origin Access Control
#   - 403/404 fallback to index.html for SPA-style routing
#   - Synced from frontend/out/ at apply time
# ============================================================

locals {
  bucket_name = "pr-review-dashboard-${var.environment}-${data.aws_caller_identity.current.account_id}"
  is_prod     = var.environment == "production"
  tags        = merge(var.project_tags, { Environment = var.environment })

  # Files produced by `next build` with output: 'export'. The fileset
  # walks the build directory at plan time; adding/removing files in
  # the build automatically adds/removes terraform-managed objects.
  build_files = fileset(var.frontend_build_path, "**/*")

  # Minimal MIME type table covering everything a Next.js static export
  # produces. Extension lookup is case-insensitive via the lower() below.
  mime_types = {
    "html"  = "text/html; charset=utf-8"
    "htm"   = "text/html; charset=utf-8"
    "css"   = "text/css; charset=utf-8"
    "js"    = "application/javascript; charset=utf-8"
    "mjs"   = "application/javascript; charset=utf-8"
    "map"   = "application/json"
    "json"  = "application/json"
    "txt"   = "text/plain; charset=utf-8"
    "xml"   = "application/xml"
    "svg"   = "image/svg+xml"
    "png"   = "image/png"
    "jpg"   = "image/jpeg"
    "jpeg"  = "image/jpeg"
    "gif"   = "image/gif"
    "webp"  = "image/webp"
    "avif"  = "image/avif"
    "ico"   = "image/x-icon"
    "woff"  = "font/woff"
    "woff2" = "font/woff2"
    "ttf"   = "font/ttf"
    "otf"   = "font/otf"
    "wasm"  = "application/wasm"
  }
}

data "aws_caller_identity" "current" {}

# ============================================================
# S3 bucket — private; only CloudFront can read.
# ============================================================
resource "aws_s3_bucket" "dashboard" {
  bucket        = local.bucket_name
  force_destroy = !local.is_prod
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "dashboard" {
  bucket = aws_s3_bucket.dashboard.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "dashboard" {
  bucket = aws_s3_bucket.dashboard.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "dashboard" {
  bucket = aws_s3_bucket.dashboard.id

  versioning_configuration {
    status = local.is_prod ? "Enabled" : "Suspended"
  }
}

# ============================================================
# CloudFront — Origin Access Control fronts the private bucket.
# ============================================================
resource "aws_cloudfront_origin_access_control" "dashboard" {
  name                              = "pr-review-dashboard-oac-${var.environment}"
  description                       = "OAC for PR Review dashboard (${var.environment})"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "dashboard" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "PR Review Agent dashboard (${var.environment})"
  default_root_object = "index.html"

  # PRICE_CLASS_100 = NA + EU only (cheaper, fine for non-prod).
  # PRICE_CLASS_ALL = full global distribution.
  price_class = local.is_prod ? "PriceClass_All" : "PriceClass_100"

  origin {
    origin_id                = "dashboard-s3"
    domain_name              = aws_s3_bucket.dashboard.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.dashboard.id
  }

  default_cache_behavior {
    target_origin_id       = "dashboard-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    # CachingOptimized (managed) — long TTLs, vary on accept-encoding.
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  # Next.js with trailingSlash: true produces /sessions/<id>/index.html.
  # S3 will 403/404 if a path doesn't match exactly — redirect those to
  # the SPA shell so deep links survive refresh.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 300
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 300
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = local.tags
}

# Bucket policy: only the specific CloudFront distribution (matched by
# AWS:SourceArn) can fetch objects. Defined AFTER the distribution to
# include its ARN in the policy condition.
data "aws_iam_policy_document" "dashboard_bucket" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.dashboard.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.dashboard.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "dashboard" {
  bucket = aws_s3_bucket.dashboard.id
  policy = data.aws_iam_policy_document.dashboard_bucket.json
}

# ============================================================
# Static file upload. One aws_s3_object per file; etag = filemd5
# so Terraform detects content changes and updates only the
# delta. Removing a file from the build set deletes it from S3.
# ============================================================
resource "aws_s3_object" "files" {
  for_each = local.build_files

  bucket = aws_s3_bucket.dashboard.id
  key    = each.value
  source = "${var.frontend_build_path}/${each.value}"
  etag   = filemd5("${var.frontend_build_path}/${each.value}")
  content_type = lookup(
    local.mime_types,
    lower(reverse(split(".", each.value))[0]),
    "application/octet-stream"
  )

  # Long cache for the JS/CSS chunks (hashed filenames); short cache
  # for HTML so deploys propagate. The runtime cache policy on CloudFront
  # is the primary control — these are origin hints that S3 echoes back
  # as Cache-Control headers.
  cache_control = endswith(each.value, ".html") ? "public, max-age=0, must-revalidate" : "public, max-age=31536000, immutable"
}

# ============================================================
# CloudFront invalidation. Triggers on the union of every object's
# etag — any content change creates a new triggers hash, which
# forces the null_resource to re-run.
# ============================================================
resource "null_resource" "invalidate_distribution" {
  count = var.invalidate_on_deploy ? 1 : 0

  triggers = {
    file_hashes = sha1(join("", [for f in sort(tolist(local.build_files)) : filemd5("${var.frontend_build_path}/${f}")]))
  }

  provisioner "local-exec" {
    command = "aws cloudfront create-invalidation --distribution-id ${aws_cloudfront_distribution.dashboard.id} --paths '/*'"
  }

  depends_on = [aws_s3_object.files]
}
