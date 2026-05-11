# SKILL.md — Ralph Loop Evaluator

## Purpose
Defines the self-evaluation process every SubAgent must run after
producing an initial output. Ensures output quality before checkpoint.

---

## Ralph Loop Steps

### Iteration 1 — Initial Output
1. Produce first-pass findings
2. Calculate initial confidence score
3. Run self-evaluation checklist below
4. If score >= 0.85 → skip to checkpoint
5. If score < 0.85 → proceed to Iteration 2

### Iteration 2 — Refinement
1. Re-read the diff with fresh context
2. Validate each finding against actual diff lines
3. Remove any findings not directly supported by diff
4. Recalculate confidence score
5. If score >= 0.80 → proceed to checkpoint
6. If score < 0.80 → proceed to Iteration 3

### Iteration 3 — Final Pass
1. Keep only findings with high evidence support
2. Flag low-confidence findings as INFO rather than dropping
3. Set final confidence score
4. Proceed to checkpoint regardless of score
5. If final score < 0.75 → set verdict to ESCALATED

---

## Self-Evaluation Checklist
After every iteration answer YES/NO:
- [ ] Every finding references a specific line number in the diff
- [ ] Every finding has a concrete suggestion (not just identification)
- [ ] No findings reference unchanged legacy code
- [ ] Severity levels match the CLAUDE.md definitions
- [ ] No duplicate findings for the same line

Scoring: 0.2 per YES answer = max confidence of 1.0

---

## Confidence Score Rules
- Start at 0.5 base score
- +0.1 per confirmed finding with evidence
- +0.1 per finding with concrete fix suggestion
- -0.15 per finding removed as false positive
- -0.2 if any checklist item is NO after Iteration 2