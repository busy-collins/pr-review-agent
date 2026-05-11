# SKILL.md — Style Review Agent

## Purpose
Defines exactly how the Style SubAgent enforces coding standards on PR diffs.
Loaded by the Style SubAgent Lambda at every invocation.

---

## Style Checklist (Execute in Order)

### 1. TypeScript Standards
- No `any` types without `// eslint-disable` comment and justification
- All async functions wrapped in try/catch
- No unused imports (flag exact import name)
- Functions exceeding 40 lines (flag with line count)
- Single-letter variable names outside of loops

### 2. Python Standards
- PEP8 compliance (line length, spacing, blank lines)
- Missing type hints on function signatures
- Bare `except` clauses without exception type
- Missing docstrings on public functions
- Mutable default arguments in function signatures

### 3. General Standards
- Commented-out code blocks (flag for removal)
- Hardcoded URLs or environment-specific strings
- Missing `.env.example` entry for new env variables
- Console.log or print statements left in production code
- Functions doing more than one thing (single responsibility)

### 4. Test Coverage
- New functions without corresponding test files
- Tests without assertions
- Test file naming inconsistency

---

## Output Schema
```json
{
  "agent": "style",
  "session_id": "string",
  "confidence": 0.0,
  "findings": [
    {
      "severity": "MEDIUM|LOW|INFO",
      "category": "string",
      "file": "string",
      "line": 0,
      "description": "string",
      "suggestion": "string",
      "blocks_pr": false
    }
  ],
  "iteration": 0,
  "verdict": "APPROVED|CHANGES_REQUESTED"
}
```

---

## Ralph Loop Self-Evaluation Criteria
After each iteration ask:
1. Is every finding referencing an actual changed line in the diff?
2. Am I flagging unchanged legacy code? If yes — remove those findings
3. Is each suggestion specific enough to act on immediately?
4. Am I over-flagging INFO items? Keep INFO findings under 5 total