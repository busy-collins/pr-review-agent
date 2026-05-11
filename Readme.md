# PLAN.md — Autonomous PR Review Agent
## Project Blueprint & Execution Plan

**Version:** 1.0.0
**Status:** Phase 1 — Foundation
**Last Updated:** 2026-05-10

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
- [ ] Create all SKILL.md files
- [ ] Initialize git repository
- [ ] Setup .env.example
- [ ] Setup ESLint, Prettier, TypeScript config
- [ ] Create README.md

### Phase 2 — Architecture Design (Days 4–6)
- [ ] Define all agent input/output JSON schemas
- [ ] Design Step Functions state machine (ASL definition)
- [ ] Design DynamoDB table schema
- [ ] Design RDS pgvector schema
- [ ] Define all environment variables
- [ ] Create architecture diagram

### Phase 3 — MCP & Integration Planning (Days 7–9)
- [ ] Configure GitHub MCP client
- [ ] Configure Slack MCP client
- [ ] Design webhook verification middleware
- [ ] Define all slash command parsers
- [ ] Design rate limiting strategy

### Phase 4 — AWS Infrastructure (Days 10–12)
- [ ] Write CDK stack for API Gateway + Lambda
- [ ] Write CDK stack for Step Functions
- [ ] Write CDK stack for DynamoDB
- [ ] Write CDK stack for RDS pgvector
- [ ] Write CDK stack for CloudWatch dashboards
- [ ] Write CDK stack for IAM roles

### Phase 5 — Agent Implementation (Days 13–16)
- [ ] Implement Orchestrator logic
- [ ] Implement Security SubAgent + Ralph loop
- [ ] Implement Style SubAgent + Ralph loop
- [ ] Implement Aggregator Agent
- [ ] Implement slash command handlers

### Phase 6 — Frontend Dashboard (Days 17–19)
- [ ] Scaffold Next.js dashboard
- [ ] PR review history list view
- [ ] PR drill-down view (per-agent outputs)
- [ ] Metrics panel
- [ ] Deploy to S3 + CloudFront

### Phase 7 — Testing & Rollout (Days 20–22)
- [ ] Unit tests per SubAgent
- [ ] Integration tests against test GitHub repo
- [ ] Golden set regression tests (20+ fixture PRs)
- [ ] Shadow mode deployment (2 weeks no auto-posting)
- [ ] Production rollout

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
4. Checkpoint is committed to git with phase tag# Test PR
