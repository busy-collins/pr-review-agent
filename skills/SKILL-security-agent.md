# SKILL.md — Security Review Agent

## Purpose
Defines exactly how the Security SubAgent scans PR diffs for vulnerabilities.
This skill is loaded by the Security SubAgent Lambda at every invocation.

---

## Scan Checklist (Execute in Order)

### 1. Hardcoded Secrets
- Scan for: API keys, tokens, passwords, private keys, connection strings
- Patterns: `sk-`, `Bearer `, `password=`, `secret=`, `private_key`
- Severity: CRITICAL — always blocks PR

### 2. Injection Vulnerabilities
- SQL injection: string concatenation in queries, missing parameterization
- Command injection: `exec()`, `eval()`, `subprocess` with user input
- XSS: unescaped user input rendered in HTML
- Severity: CRITICAL for direct injection, HIGH for potential injection

### 3. Authentication & Authorization
- Missing auth checks on new endpoints
- Broken object-level authorization (BOLA)
- JWT validation bypass patterns
- Severity: CRITICAL

### 4. Insecure Dependencies
- Flag any new package additions
- Check for known vulnerable version patterns
- Severity: HIGH

### 5. PII Exposure
- Logging of sensitive user data (email, phone, SSN)
- PII in error messages or stack traces
- Severity: HIGH

### 6. Unsafe Deserialization
- `JSON.parse` on untrusted input without validation
- Python `pickle.loads` on untrusted data
- Severity: HIGH

---

## Output Schema
```json
{
  "agent": "security",
  "session_id": "string",
  "confidence": 0.0,
  "findings": [
    {
      "severity": "CRITICAL|HIGH|MEDIUM|LOW|INFO",
      "category": "string",
      "file": "string",
      "line": 0,
      "description": "string",
      "suggestion": "string",
      "blocks_pr": true
    }
  ],
  "iteration": 0,
  "verdict": "APPROVED|CHANGES_REQUESTED|ESCALATED"
}
```

---

## Ralph Loop Self-Evaluation Criteria
After each iteration ask:
1. Did I miss any patterns from the checklist above?
2. Is each finding supported by the actual diff lines?
3. Is my confidence score justified by the evidence?
4. Are all suggestions concrete and actionable?

Increase confidence by 0.1 per confirmed finding. Decrease by 0.15 per false positive identified in re-evaluation.