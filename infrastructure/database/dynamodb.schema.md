# DynamoDB Table Schema — PR Review Agent

## Table Name

`pr-review-sessions`

---

## Primary Key Design

| Key | Attribute | Type | Description |
|---|---|---|---|
| Partition Key | `session_id` | String | `pr-{repo}-{pr_number}-{timestamp}` |
| Sort Key | `checkpoint_stage` | String | `ORCHESTRATOR \| SECURITY \| STYLE \| AGGREGATOR \| COMPLETE` |

---

## Attribute Definitions

```json
{
  "session_id": {
    "type": "String (S)",
    "description": "Unique session identifier",
    "example": "pr-myorg-myrepo-412-1746123456",
    "pattern": "pr-{owner}-{repo}-{pr_number}-{unix_timestamp}"
  },
  "checkpoint_stage": {
    "type": "String (S)",
    "description": "Pipeline stage at time of checkpoint",
    "enum": ["ORCHESTRATOR", "SECURITY", "STYLE", "AGGREGATOR", "COMPLETE"]
  },
  "pr_number": {
    "type": "Number (N)",
    "description": "GitHub Pull Request number",
    "gsi": "PRNumberIndex"
  },
  "repo": {
    "type": "String (S)",
    "description": "Repository in owner/repo format",
    "example": "myorg/my-service",
    "gsi": "RepoIndex"
  },
  "sender": {
    "type": "String (S)",
    "description": "GitHub username of the PR author"
  },
  "status": {
    "type": "String (S)",
    "description": "Current review status",
    "enum": ["IN_PROGRESS", "COMPLETED", "FAILED", "ESCALATED"],
    "gsi": "StatusIndex"
  },
  "security_findings": {
    "type": "String (S)",
    "description": "JSON stringified array of SecurityFinding objects from security agent"
  },
  "style_findings": {
    "type": "String (S)",
    "description": "JSON stringified array of StyleFinding objects from style agent"
  },
  "aggregated_comment": {
    "type": "String (S)",
    "description": "Fully formatted GitHub Markdown comment ready to post"
  },
  "github_comment_url": {
    "type": "String (S)",
    "description": "URL of the posted GitHub comment"
  },
  "final_verdict": {
    "type": "String (S)",
    "description": "Final pipeline verdict",
    "enum": ["APPROVED", "CHANGES_REQUESTED", "ESCALATED"]
  },
  "overall_confidence": {
    "type": "Number (N)",
    "description": "Averaged confidence score across both SubAgents (0.0 - 1.0)"
  },
  "security_confidence": {
    "type": "Number (N)",
    "description": "Security SubAgent final confidence score"
  },
  "style_confidence": {
    "type": "Number (N)",
    "description": "Style SubAgent final confidence score"
  },
  "blocking_count": {
    "type": "Number (N)",
    "description": "Total CRITICAL and HIGH findings"
  },
  "non_blocking_count": {
    "type": "Number (N)",
    "description": "Total MEDIUM, LOW, INFO findings"
  },
  "security_iterations": {
    "type": "Number (N)",
    "description": "Number of Ralph loop iterations used by Security SubAgent"
  },
  "style_iterations": {
    "type": "Number (N)",
    "description": "Number of Ralph loop iterations used by Style SubAgent"
  },
  "error": {
    "type": "String (S)",
    "description": "Error message if status is FAILED, null otherwise"
  },
  "created_at": {
    "type": "String (S)",
    "description": "ISO8601 timestamp of session creation — never updated",
    "example": "2026-05-10T12:00:00Z"
  },
  "updated_at": {
    "type": "String (S)",
    "description": "ISO8601 timestamp of last checkpoint write — updated on every write"
  },
  "ttl": {
    "type": "Number (N)",
    "description": "Unix timestamp for DynamoDB TTL auto-deletion (created_at + 172800 seconds)"
  }
}
```

---

## Global Secondary Indexes (GSI)

### GSI 1 — RepoIndex

Enables querying all reviews for a specific repository.

```text
Partition Key: repo (S)
Sort Key:      created_at (S)
Projection:    ALL
Use case:      "Show all PRs reviewed in myorg/my-service this week"
```

### GSI 2 — PRNumberIndex

Enables querying all review sessions for a specific PR.

```text
Partition Key: pr_number (N)
Sort Key:      created_at (S)
Projection:    ALL
Use case:      "Show full review history for PR #412"
```

### GSI 3 — StatusIndex

Enables querying by pipeline status for monitoring and alerting.

```text
Partition Key: status (S)
Sort Key:      updated_at (S)
Projection:    KEYS_ONLY
Use case:      "Show all FAILED reviews in the last 24 hours"
```

---

## Billing Mode

`PAY_PER_REQUEST` — on-demand pricing. No capacity planning needed at launch.
Switch to `PROVISIONED` with auto-scaling when review volume exceeds 1,000/day.

---

## TTL Configuration

```text
Attribute Name: ttl
Type:           Number (Unix timestamp)
Value:          created_at (Unix) + 172800 (48 hours)
```
DynamoDB auto-deletes records within 48 hours of session creation.
Completed reviews are archived to RDS pgvector before TTL expiry for long-term history.

---

## Access Patterns Supported

| Access Pattern | Query Method |
|---|---|
| Get full session by session_id | Query by PK `session_id` |
| Get specific checkpoint stage | Query by PK + SK |
| All reviews for a repo | GSI RepoIndex, PK = repo |
| All sessions for a PR | GSI PRNumberIndex, PK = pr_number |
| All failed reviews today | GSI StatusIndex, PK = FAILED + SK range |
| Latest review for a PR | GSI PRNumberIndex, ScanIndexForward = false, Limit = 1 |