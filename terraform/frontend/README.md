# Frontend Deployment (Terraform)

Hosts the PR Review Agent dashboard as a static site on S3 + CloudFront. Mirrors
the CDK stack at [`infrastructure/cdk/stacks/frontend.stack.ts`](../../infrastructure/cdk/stacks/frontend.stack.ts) —
pick one or the other; running both will produce two parallel deployments.

## What gets provisioned

- **S3 bucket** — private, encrypted, all public access blocked. Versioned in production.
- **CloudFront distribution** — uses Origin Access Control (modern OAC, not legacy OAI) so the bucket policy only trusts this specific distribution.
- **Bucket policy** — grants `s3:GetObject` to the CloudFront service principal, scoped to the distribution ARN.
- **Object uploads** — every file under `frontend/out/` becomes an `aws_s3_object`. Content-type derived from extension. Long cache for hashed JS/CSS chunks, no-cache for HTML so deploys propagate.
- **Invalidation** — runs `aws cloudfront create-invalidation --paths '/*'` whenever any file's content changes.

## Prerequisites

1. **AWS credentials** — Terraform uses the standard AWS provider chain (env vars, `~/.aws/credentials`, instance profile).
2. **AWS CLI on PATH** — only required if `invalidate_on_deploy = true` (the default). Set it to `false` to skip the invalidation step.
3. **Frontend built** — `frontend/out/` must exist before `terraform apply`. Build it first:

   ```bash
   cd ../../frontend
   npm install
   npm run build
   ```

## Deploy

```bash
cd terraform/frontend
cp example.tfvars staging.tfvars   # then edit if needed

terraform init
terraform plan  -var-file=staging.tfvars
terraform apply -var-file=staging.tfvars
```

Outputs printed at the end include the `dashboard_url` you can open in a browser.

## Re-deploying after a frontend change

```bash
cd ../../frontend && npm run build && cd ../terraform/frontend
terraform apply -var-file=staging.tfvars
```

Terraform tracks file etags, so unchanged objects are skipped. The
`null_resource.invalidate_distribution` fires whenever any file content changed,
busting the CloudFront cache.

## Destroying

```bash
terraform destroy -var-file=staging.tfvars
```

In **non-production** environments `force_destroy = true` on the bucket so this
works in one shot. In **production** the bucket is versioned and not
force-destroyable — empty it manually before destroy.

## Remote state

State is local by default (`terraform.tfstate` in this directory). For a real
team setup, add a `backend.tf` with an S3 + DynamoDB backend:

```hcl
terraform {
  backend "s3" {
    bucket         = "pr-review-tfstate-<account-id>"
    key            = "frontend/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "pr-review-tfstate-lock"
    encrypt        = true
  }
}
```

## Variables

| Name                   | Type   | Default               | Purpose                                                       |
| ---------------------- | ------ | --------------------- | ------------------------------------------------------------- |
| `aws_region`           | string | `us-east-1`           | Region for the S3 bucket; CloudFront itself is global.        |
| `environment`          | string | `staging`             | `staging` or `production` — drives naming, versioning, price. |
| `frontend_build_path`  | string | `../../frontend/out`  | Path to the Next.js static export.                            |
| `project_tags`         | map    | `{Project,ManagedBy}` | Tags applied to every taggable resource.                      |
| `invalidate_on_deploy` | bool   | `true`                | Run a `/*` CloudFront invalidation after upload completes.    |

## Outputs

- `dashboard_url` — HTTPS URL on the CloudFront default domain
- `distribution_id` — for ad-hoc invalidations
- `distribution_domain_name` — for adding to Route53 or external DNS
- `bucket_name`, `bucket_arn` — for cross-account access policies if needed

## Why this alongside CDK?

The rest of the backend infrastructure (Lambda, Step Functions, DynamoDB, RDS,
CloudWatch, IAM) lives in CDK at `infrastructure/cdk/`. Frontend hosting is
the **only** component owned by Terraform — chosen because static-site stacks
(S3 + CloudFront + OAC) map cleanly to Terraform's resource model and let the
dashboard ship independently of the backend pipeline.
