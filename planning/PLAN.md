# PLAN.md — Autonomous PR Review Agent
## Project Blueprint & Execution Plan

**Version:** 1.0.0
**Status:** Phase 7 in progress — Backend, dashboard, tests, and shadow-mode landed; operational rollout (shadow-mode soak + production cutover) outstanding
**Last Updated:** 2026-05-11

---

## Problem Statement
Engineering teams waste significant time on repetitive code review tasks —
catching style violations, common security issues, and standard patterns that
should never require senior engineer attention. This agent automates the
first-pass review so humans focus only on architecture, business logic, and
edge cases.

---

## Success Criteria
- [ ] Agent posts a structured review comment on every new PR within 3 minutes
- [ ] Security SubAgent catches OWASP Top 10 vulnerabilities in test fixtures
- [ ] Style SubAgent enforces standards with < 5% false positive rate
- [ ] System recovers from SubAgent failure without losing review progress
- [ ] Full pipeline observable end-to-end via CloudWatch dashboard
- [ ] Slash commands respond within 30 seconds of GitHub comment trigger

---

## System Architecture Overview

```
GitHub Webhook (PR Opened / Synchronized)
            ↓
API Gateway (Webhook Receiver)
            ↓
Lambda (Webhook Handler + Signature Verification)
            ↓
Step Functions (Orchestration Pipeline)
            ↓
      ┌─────────────────────┐
      │                     │
Lambda (Security)    Lambda (Style)
SubAgent             SubAgent
      │                     │
      └──────────┬──────────┘
                 ↓
Lambda (Aggregator Agent)
                 ↓
         GitHub PR Comment
                 ↓
    DynamoDB (Session + Checkpoints)
    RDS pgvector (Review History)
    CloudWatch (Observability)
    Slack (Escalation Notifications)
```

---

## Agent Responsibilities

### Orchestrator (Step Functions)
- Receives webhook payload
- Validates PR eligibility (size, repo, branch rules)
- Spawns Security and Style SubAgents in parallel
- Waits for both to complete with timeout of 240 seconds
- Passes results to Aggregator
- Handles failures and escalation routing

### Security SubAgent (Lambda)
- Reads PR diff from GitHub MCP
- Scans for: hardcoded secrets, SQL injection, XSS, insecure dependencies,
  auth bypass patterns, exposed PII, unsafe deserialization
- Assigns severity score per finding
- Runs Ralph loop (max 3 iterations) to validate findings
- Returns structured JSON findings with confidence score

### Style SubAgent (Lambda)
- Reads PR diff from GitHub MCP
- Enforces coding standards per CLAUDE.md
- Checks: naming conventions, function length, complexity, missing types,
  commented-out code, missing error handling
- Runs Ralph loop (max 3 iterations) to validate findings
- Returns structured JSON findings with confidence score

### Aggregator Agent (Lambda)
- Merges Security and Style findings
- Resolves any conflicts (same line flagged by both agents)
- Calculates overall confidence score
- Formats final GitHub comment per CLAUDE.md output rules
- Determines verdict: APPROVED / CHANGES REQUESTED / ESCALATED
- Posts comment via GitHub MCP
- Saves final checkpoint to DynamoDB

---

## Phase Execution Plan

### Phase 1 — Foundation & Project Setup (Days 1–3)

- [x] Create CLAUDE.md
- [x] Create PLAN.md
- [x] Create monorepo structure
- [x] Create all SKILL.md files (`skills/SKILL-*.md` — checkpoint, comment-formatter, ralph-loop, security-agent, style-agent)
- [x] Initialize git repository
- [ ] Setup `.env.example` — **still missing**; env vars used by code are not documented
- [x] Setup TypeScript config (root + `infrastructure/`)
- [ ] Setup ESLint, Prettier — not yet configured
- [x] Create README.md

### Phase 2 — Architecture Design (Days 4–6)

- [x] Define all agent input/output JSON schemas (`agents/*/schemas/*.json`)
- [x] Design Step Functions state machine — implemented in CDK at `infrastructure/cdk/stacks/stepfunctions-stack.ts`
- [x] Design DynamoDB table schema (`infrastructure/database/dynamodb.schema.md`)
- [x] Design RDS pgvector schema (`infrastructure/database/pgvector.schema.sql`)
- [ ] Define all environment variables — gated on `.env.example` from Phase 1
- [ ] Create architecture diagram

### Phase 3 — MCP & Integration Planning (Days 7–9)

- [x] Configure GitHub MCP client (`api/mcp/Github.mcp.client.ts`)
- [x] Configure Slack MCP client (`api/mcp/Slack.mcp.client.ts`)
- [x] Design webhook verification middleware (`api/middlewares/webhook.middleware.ts`)
- [x] Define all slash command parsers (`api/slash-commands/slash.command.parser.ts`)
- [x] Design rate limiting strategy (`api/rate-limiting/rate.limiter.ts`)

### Phase 4 — AWS Infrastructure (Days 10–12)

- [x] Write CDK stack for API Gateway + Lambda (`infrastructure/cdk/stacks/lambda-api.stack.ts`)
- [x] Write CDK stack for Step Functions (`infrastructure/cdk/stacks/stepfunctions-stack.ts`)
- [x] Write CDK stack for DynamoDB (`infrastructure/cdk/stacks/dynamodb.stack.ts`)
- [x] Write CDK stack for RDS pgvector (`infrastructure/cdk/stacks/rds.stack.ts`)
- [x] Write CDK stack for CloudWatch dashboards (`infrastructure/cdk/stacks/cloud-watch-stack.ts`)
- [x] Write CDK stack for IAM roles (`infrastructure/cdk/stacks/iam.stack.ts`)

### Phase 5 — Agent Implementation (Days 13–16)

- [x] Implement Orchestrator logic (`agents/orchestrator/src/{index,session}.ts`)
- [x] Implement Security SubAgent + Ralph loop (`agents/security/src/{index,ralph-loop}.ts`)
- [x] Implement Style SubAgent + Ralph loop (`agents/style/src/{index,ralph-loop}.ts`)
- [x] Implement Aggregator Agent (`agents/aggregator/src/{index,formatter}.ts`)
- [x] Implement slash command handlers (webhook Lambda at `api/webhook/index.ts`)

**Phase 5 notes:**

- Shared infrastructure built in `shared/` (types, logger, Anthropic client, DynamoDB checkpoint I/O, Ajv schema validation)
- 116 unit + smoke tests across all agents (`vitest`); `npm test` and `tsc --noEmit` both green
- Claude model defaulted to `claude-sonnet-4-6` (env-overridable via `CLAUDE_MODEL`)
- Outstanding: `/review approve` currently acknowledges only — no checkpoint write or PR comment; `issue_comment` events pass empty `base_branch`/`head_branch` (downstream uses them for display only); orchestrator's classified `ESCALATED` status currently bypasses SubAgents per state-machine routing — worth revisiting if you want agent findings to inform the human reviewer

### Phase 6 — Frontend Dashboard (Days 17–19)

- [x] Scaffold Next.js dashboard (`frontend/`, Next.js 14 App Router + Tailwind, static export via `output: 'export'`)
- [x] PR review history list view (`frontend/app/page.tsx`)
- [x] PR drill-down view, per-agent outputs (`frontend/app/sessions/[session_id]/page.tsx`)
- [x] Metrics panel (`frontend/app/metrics/page.tsx`)
- [x] Deploy to S3 + CloudFront (`terraform/frontend/` — Terraform-owned, not CDK)

**Phase 6 notes:**

- Dashboard reads from typed mock data (`frontend/lib/mock-data.ts`); swap to a real fetch when the read-API Lambda lands
- Static export — every route is prerendered to HTML at build time; CloudFront falls back to `/index.html` on 403/404 so deep links survive refresh
- S3 bucket is private; CloudFront's Origin Access Control is the only reader
- Terraform `aws_s3_object` resources sync `frontend/out/` at apply time; `npm run build` in `frontend/` is required before `terraform apply`. AWS CLI on PATH required only for the post-deploy CloudFront invalidation (toggleable via `invalidate_on_deploy`)
- Outstanding: when real data arrives, the drill-down's `generateStaticParams` will need to switch to either client-side fetching or a build-time index of recent sessions; `404` errors on the deep-link fallback are routed through `index.html` so client routing handles them

### Phase 7 — Testing & Rollout (Days 20–22)

- [x] Unit tests per SubAgent (vitest — 178 tests across orchestrator, security, style, aggregator, webhook, plus the API middleware/rate-limiter/slash-parser layer)
- [ ] Integration tests against test GitHub repo — operational; needs a real GitHub App + AWS test account. Test runner skeleton not yet written
- [x] Golden set regression tests — `tests/fixtures/golden-set/` with 7 starter fixtures covering clean PR, auth/payment/migration escalations, oversized diff, slash-command narrowing, and an end-to-end aggregator path (PLAN's original "20+" stays as a target; new real-world cases get added as fixtures here)
- [x] Shadow mode deployment plumbing — `SHADOW_MODE` env var read at call time in Aggregator (`agents/aggregator/src/index.ts`); CDK defaults it to `'false'` in `infrastructure/cdk/stacks/lambda-api.stack.ts`. **Operational soak (2-week shadow run on real PRs) outstanding**
- [ ] Production rollout — operational; requires AWS + GitHub credentials, real webhook configuration, and the shadow-mode soak above completing cleanly

**Phase 7 notes:**

- Total test count after this phase: **178** (vitest, `npm test`)
- New test files this phase: `tests/middlewares/webhook.middleware.test.ts` (16 tests with real HMAC computation), `tests/rate-limiting/rate.limiter.test.ts` (14 tests with DynamoDB mocked), `tests/slash-commands/slash.command.parser.test.ts` (21 tests), `tests/fixtures/golden-set.test.ts` (10 tests across 7 fixtures + coverage guards)
- `SHADOW_MODE` is read at call time, not module-load, so toggling the env var takes effect on the next Lambda invocation without recycling the container
- The CLAUDE.md Shadow Mode section documents the behavior contract

---

## Technology Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (Node 20) |
| Infrastructure | AWS CDK v2 |
| Orchestration | AWS Step Functions |
| Compute | AWS Lambda |
| Database | DynamoDB + RDS (pgvector) |
| AI | Claude API (claude-sonnet-4-6) |
| Observability | CloudWatch + X-Ray + Helicone |
| CI/CD | GitHub Actions |
| Frontend | Next.js 14 + Tailwind CSS |

---

## Environment Variables Required

```
# Claude API
ANTHROPIC_API_KEY=

# GitHub
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=

# Slack
SLACK_BOT_TOKEN=
SLACK_ESCALATION_CHANNEL=

# AWS
AWS_REGION=
DYNAMODB_TABLE_NAME=
RDS_CONNECTION_STRING=

# Observability
HELICONE_API_KEY=
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SubAgent timeout on large PRs | High | Medium | 3000 line diff limit enforced |
| False positive security findings | Medium | High | Ralph loop + confidence threshold |
| GitHub API rate limiting | Low | High | Exponential backoff + queue |
| Lambda cold start latency | Medium | Low | Provisioned concurrency on critical functions |
| Claude API downtime | Low | High | Graceful degradation comment posted to PR |

---

## Definition of Done
A phase is complete when:
1. All checklist items are checked
2. Code is reviewed and merged to main
3. Tests pass in CI
4. Checkpoint is committed to git with phase tag