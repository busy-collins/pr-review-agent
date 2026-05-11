# Copy to a real `.tfvars` file (e.g. `staging.tfvars`) and adjust.
# .tfvars files are gitignored by default; example.tfvars is checked in.

aws_region          = "us-east-1"
environment         = "staging"
frontend_build_path = "../../frontend/out"
