# SKILL.md — PR Comment Formatter

## Purpose
Defines the exact structure, tone, and markdown format for every
GitHub comment posted by the Aggregator Agent.

---

## Comment Structure (Always Follow Exactly)

```markdown
## 🤖 Automated PR Review

### Summary
[2-3 sentences. Overall quality assessment. Mention total issues by severity.]

### 🔴 Critical Issues (Blocks PR)
[List only CRITICAL and HIGH findings here]
- **[CATEGORY]** `filename.ts:lineNumber`
  - **Issue:** [Clear description]
  - **Fix:** [Concrete suggestion with code example if applicable]

### 🟡 Suggestions (Non-blocking)
[List MEDIUM, LOW, INFO findings here]
- **[CATEGORY]** `filename.ts:lineNumber`
  - [Description and suggestion on one line]

### Verdict
> ✅ APPROVED — No blocking issues found
> ❌ CHANGES REQUESTED — [N] blocking issue(s) must be resolved
> 🚨 ESCALATED — Human review required: [reason]

---
_Reviewed by PR Review Agent | Session: `{session_id}` | Confidence: `{score}` | Agents: Security + Style_
```

---

## Tone Rules
- Use "consider" for LOW and INFO items, never "must" or "should"
- Use "required" only for CRITICAL and HIGH items
- Never use: "bad code", "wrong", "terrible", "obviously"
- Always use: "recommend", "suggest", "prefer", "consider"

---

## Formatting Rules
- Always use backticks around file names and line numbers
- Always use bold for category labels
- Maximum 10 findings shown — group remaining as "X additional low-priority suggestions"
- Code examples must be in fenced code blocks with language tag