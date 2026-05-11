import { describe, expect, it } from 'vitest';
import {
  buildDefaultSummary,
  formatGitHubComment,
} from '../../agents/aggregator/src/formatter';
import type {
  SecurityFinding,
  StyleFinding,
  TaggedFinding,
} from '../../shared/types';

const sec = (overrides: Partial<SecurityFinding> = {}): SecurityFinding => ({
  severity: 'HIGH',
  category: 'SQL_INJECTION',
  file: 'src/db.ts',
  line: 50,
  description: 'unsanitized input',
  suggestion: 'use parameterized queries',
  blocks_pr: true,
  ...overrides,
});

const sty = (overrides: Partial<StyleFinding> = {}): StyleFinding => ({
  severity: 'LOW',
  category: 'UNUSED_IMPORT',
  file: 'src/foo.ts',
  line: 1,
  description: 'unused lodash import',
  suggestion: 'remove the import',
  blocks_pr: false,
  ...overrides,
});

const tag = (
  agent: 'security' | 'style',
  finding: SecurityFinding | StyleFinding
): TaggedFinding => ({ agent, finding });

describe('formatGitHubComment', () => {
  it('renders the CLAUDE.md template skeleton', () => {
    const out = formatGitHubComment({
      sessionId: 'pr-myorg-myrepo-42-1000',
      findings: [],
      finalVerdict: 'APPROVED',
      overallConfidence: 0.95,
      blockingCount: 0,
      nonBlockingCount: 0,
      summary: 'Clean.',
    });
    expect(out).toContain('## 🤖 Automated PR Review');
    expect(out).toContain('### Summary');
    expect(out).toContain('### Issues Found');
    expect(out).toContain('### Verdict');
    expect(out).toContain('Session: `pr-myorg-myrepo-42-1000`');
    expect(out).toContain('Confidence: `0.95`');
    expect(out).toContain('APPROVED');
  });

  it('renders "no issues" placeholder on empty findings', () => {
    const out = formatGitHubComment({
      sessionId: 's',
      findings: [],
      finalVerdict: 'APPROVED',
      overallConfidence: 1,
      blockingCount: 0,
      nonBlockingCount: 0,
      summary: 'Clean.',
    });
    expect(out).toMatch(/_No issues to report\._/);
  });

  it('groups findings by severity in CRITICAL → INFO order', () => {
    const findings: TaggedFinding[] = [
      tag('style', sty({ severity: 'LOW', line: 1 })),
      tag('security', sec({ severity: 'CRITICAL', category: 'HARDCODED_SECRET', line: 2 })),
      tag('security', sec({ severity: 'HIGH', line: 3 })),
      tag('style', sty({ severity: 'INFO', line: 4 })),
    ];
    const out = formatGitHubComment({
      sessionId: 's',
      findings,
      finalVerdict: 'ESCALATED',
      overallConfidence: 0.9,
      blockingCount: 2,
      nonBlockingCount: 2,
      summary: 'Found issues.',
    });

    const criticalIdx = out.indexOf('🔴 **CRITICAL**');
    const highIdx     = out.indexOf('🟠 **HIGH**');
    const lowIdx      = out.indexOf('🔵 **LOW**');
    const infoIdx     = out.indexOf('⚪ **INFO**');

    expect(criticalIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeGreaterThan(criticalIdx);
    expect(lowIdx).toBeGreaterThan(highIdx);
    expect(infoIdx).toBeGreaterThan(lowIdx);
  });

  it('labels security vs style findings distinctly', () => {
    const findings: TaggedFinding[] = [
      tag('security', sec({ severity: 'HIGH' })),
      tag('style', sty()),
    ];
    const out = formatGitHubComment({
      sessionId: 's',
      findings,
      finalVerdict: 'CHANGES_REQUESTED',
      overallConfidence: 0.85,
      blockingCount: 1,
      nonBlockingCount: 1,
      summary: '',
    });
    expect(out).toMatch(/🔒 Security/);
    expect(out).toMatch(/✨ Style/);
  });

  it('includes owasp_reference and code_example for security findings when present', () => {
    const finding = sec({
      severity: 'CRITICAL',
      owasp_reference: 'A03:2021 - Injection',
      code_example: 'const query = sql`SELECT * FROM users WHERE id = ${id}`',
    });
    const out = formatGitHubComment({
      sessionId: 's',
      findings: [tag('security', finding)],
      finalVerdict: 'ESCALATED',
      overallConfidence: 0.9,
      blockingCount: 1,
      nonBlockingCount: 0,
      summary: '',
    });
    expect(out).toContain('A03:2021 - Injection');
    expect(out).toContain('SELECT * FROM users');
  });

  it('escapes nothing — file paths and descriptions are passed through verbatim', () => {
    const out = formatGitHubComment({
      sessionId: 's',
      findings: [
        tag(
          'security',
          sec({ file: 'path/with-special_chars.ts', line: 99, description: 'desc' })
        ),
      ],
      finalVerdict: 'CHANGES_REQUESTED',
      overallConfidence: 0.9,
      blockingCount: 1,
      nonBlockingCount: 0,
      summary: '',
    });
    expect(out).toContain('path/with-special_chars.ts:99');
  });

  it('displays the verdict with the right glyph', () => {
    for (const [verdict, glyph] of [
      ['APPROVED', '✅'],
      ['CHANGES_REQUESTED', '⚠️'],
      ['ESCALATED', '🚨'],
    ] as const) {
      const out = formatGitHubComment({
        sessionId: 's',
        findings: [],
        finalVerdict: verdict,
        overallConfidence: 1,
        blockingCount: 0,
        nonBlockingCount: 0,
        summary: '',
      });
      expect(out).toContain(glyph);
    }
  });
});

describe('buildDefaultSummary', () => {
  it('says "clean" on no findings', () => {
    expect(
      buildDefaultSummary({
        findings: [],
        blockingCount: 0,
        nonBlockingCount: 0,
        finalVerdict: 'APPROVED',
      })
    ).toMatch(/No issues found/i);
  });

  it('flags human review when ESCALATED', () => {
    expect(
      buildDefaultSummary({
        findings: [tag('security', sec({ severity: 'CRITICAL' }))],
        blockingCount: 1,
        nonBlockingCount: 0,
        finalVerdict: 'ESCALATED',
      })
    ).toMatch(/human review/i);
  });

  it('mentions blocking count when CHANGES_REQUESTED', () => {
    expect(
      buildDefaultSummary({
        findings: [tag('security', sec({ severity: 'HIGH' }))],
        blockingCount: 1,
        nonBlockingCount: 2,
        finalVerdict: 'CHANGES_REQUESTED',
      })
    ).toMatch(/1 blocking issue/);
  });

  it('is advisory tone when APPROVED with only style findings', () => {
    expect(
      buildDefaultSummary({
        findings: [tag('style', sty())],
        blockingCount: 0,
        nonBlockingCount: 1,
        finalVerdict: 'APPROVED',
      })
    ).toMatch(/advisory|not blocked/i);
  });
});
