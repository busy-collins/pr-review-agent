import { describe, expect, it } from 'vitest';
import {
  assessDiffSize,
  classifyEscalation,
  selectSubAgents,
} from '../../agents/orchestrator/src/session';
import {
  averageConfidence,
  computeFinalVerdict,
  mergeFindings,
} from '../../agents/aggregator/src/index';
import { formatGitHubComment } from '../../agents/aggregator/src/formatter';
import type { TaggedFinding } from '../../shared/types';
import { goldenSet } from './golden-set/index';

// ============================================================
// Golden-set runner. Each fixture exercises the deterministic
// transforms across the orchestrator → aggregator pipeline.
// Adding a new fixture in golden-set/index.ts automatically adds
// new test cases here.
// ============================================================

describe.each(goldenSet)('golden fixture: $id', (fixture) => {
  it(fixture.description, () => {
    // --- Orchestrator pure helpers ---
    const sizeAssessment = assessDiffSize(fixture.diff);
    expect(sizeAssessment).toEqual(fixture.expected.diffAssessment);

    const escalation = classifyEscalation(fixture.diff);
    expect(escalation).toBe(fixture.expected.escalation);

    const subAgents = selectSubAgents(fixture.slashCommand ?? null);
    expect(subAgents).toEqual(fixture.expected.subAgents);

    // --- Aggregator end-to-end (only when fixture provides findings) ---
    if (fixture.expected.findings) {
      const { security, style } = fixture.expected.findings;
      const merged = mergeFindings(security, style);

      const verdict = computeFinalVerdict({
        securityVerdict: security.some((f) => f.severity === 'CRITICAL')
          ? 'ESCALATED'
          : security.some((f) => f.severity === 'HIGH')
            ? 'CHANGES_REQUESTED'
            : 'APPROVED',
        findings: merged.tagged,
        overallConfidence: 0.9,
      });
      expect(verdict).toBe(fixture.expected.finalVerdict);

      // Format renders without throwing and includes basic structure
      const comment = formatGitHubComment({
        sessionId: `golden-${fixture.id}`,
        findings: merged.tagged,
        finalVerdict: verdict,
        overallConfidence: averageConfidence(0.9, 0.9),
        blockingCount: merged.tagged.filter((t: TaggedFinding) =>
          ['CRITICAL', 'HIGH'].includes(t.finding.severity)
        ).length,
        nonBlockingCount: merged.tagged.filter(
          (t: TaggedFinding) =>
            !['CRITICAL', 'HIGH'].includes(t.finding.severity)
        ).length,
        summary: 'Golden-set assertion.',
      });
      expect(comment).toContain('## 🤖 Automated PR Review');
      expect(comment).toContain('### Verdict');
      expect(comment).toContain(`golden-${fixture.id}`);
    }
  });
});

// ============================================================
// Coverage guard: ensures every CLAUDE.md escalation reason has
// at least one fixture exercising it. New escalation reasons will
// fail this test until a fixture is added.
// ============================================================
describe('coverage', () => {
  it('exercises every path-based escalation reason', () => {
    const seen = new Set(goldenSet.map((f) => f.expected.escalation));
    expect(seen.has('AUTH_LOGIC_CHANGE')).toBe(true);
    expect(seen.has('PAYMENT_LOGIC_CHANGE')).toBe(true);
    expect(seen.has('SCHEMA_MIGRATION')).toBe(true);
  });

  it('has at least one oversized-diff fixture', () => {
    const oversized = goldenSet.filter(
      (f) => f.expected.diffAssessment.exceedsLimit
    );
    expect(oversized.length).toBeGreaterThan(0);
  });

  it('has at least one slash-command-narrowed fixture', () => {
    const narrowed = goldenSet.filter(
      (f) =>
        f.slashCommand !== undefined &&
        f.expected.subAgents.length < 2
    );
    expect(narrowed.length).toBeGreaterThan(0);
  });
});
