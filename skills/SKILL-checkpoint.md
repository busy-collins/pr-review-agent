# SKILL.md — Checkpoint Writer

## Purpose
Defines exactly what data is saved at each checkpoint and in what schema.
Every agent must save a checkpoint upon task completion.

---

## Checkpoint Trigger Points
1. After Orchestrator validates PR eligibility
2. After Security SubAgent completes each Ralph loop iteration
3. After Style SubAgent completes each Ralph loop iteration
4. After Aggregator merges findings
5. After GitHub comment is posted successfully

---

## DynamoDB Checkpoint Schema
```json
{
  "session_id": "pr-{repo}-{pr_number}-{timestamp}",
  "checkpoint_stage": "ORCHESTRATOR|SECURITY|STYLE|AGGREGATOR|COMPLETE",
  "pr_number": 0,
  "repo": "owner/repo",
  "status": "IN_PROGRESS|COMPLETED|FAILED|ESCALATED",
  "security_findings": [],
  "style_findings": [],
  "aggregated_comment": "",
  "confidence_score": 0.0,
  "iteration_count": 0,
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "ttl": "Unix timestamp + 48 hours",
  "error": null
}
```

---

## Checkpoint Rules
- Always update `updated_at` on every write
- Always set `ttl` to current time + 172800 seconds (48 hours)
- Never overwrite a `COMPLETE` checkpoint — create a new session instead
- Log every checkpoint write to CloudWatch with session_id and stage
- If DynamoDB write fails — retry 3 times then log CHECKPOINT_FAILED to CloudWatch