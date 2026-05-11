import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  buildUserPrompt,
  computeVerdict,
  markBlockingFindings,
  parseToolResponse,
  REPORT_TOOL,
} from '../../agents/security/src/ralph-loop';
import type { SecurityFinding } from '../../shared/types';

const finding = (overrides: Partial<SecurityFinding> = {}): SecurityFinding => ({
  severity: 'MEDIUM',
  category: 'XSS',
  file: 'src/foo.ts',
  line: 42,
  description: 'd',
  suggestion: 's',
  blocks_pr: false,
  ...overrides,
});

describe('computeVerdict', () => {
  it('returns ESCALATED when any finding is CRITICAL', () => {
    const findings = [finding({ severity: 'CRITICAL' }), finding({ severity: 'LOW' })];
    expect(computeVerdict(findings)).toBe('ESCALATED');
  });

  it('returns CHANGES_REQUESTED when worst is HIGH', () => {
    expect(computeVerdict([finding({ severity: 'HIGH' })])).toBe('CHANGES_REQUESTED');
  });

  it('returns APPROVED when only MEDIUM/LOW/INFO present', () => {
    const findings = [
      finding({ severity: 'MEDIUM' }),
      finding({ severity: 'LOW' }),
      finding({ severity: 'INFO' }),
    ];
    expect(computeVerdict(findings)).toBe('APPROVED');
  });

  it('returns APPROVED on empty findings', () => {
    expect(computeVerdict([])).toBe('APPROVED');
  });

  it('CRITICAL beats HIGH regardless of order', () => {
    const findings = [finding({ severity: 'HIGH' }), finding({ severity: 'CRITICAL' })];
    expect(computeVerdict(findings)).toBe('ESCALATED');
  });
});

describe('markBlockingFindings', () => {
  it('sets blocks_pr=true for CRITICAL and HIGH only', () => {
    const findings = [
      finding({ severity: 'CRITICAL', blocks_pr: false }),
      finding({ severity: 'HIGH', blocks_pr: false }),
      finding({ severity: 'MEDIUM', blocks_pr: true }),
      finding({ severity: 'LOW', blocks_pr: true }),
      finding({ severity: 'INFO', blocks_pr: true }),
    ];
    const marked = markBlockingFindings(findings);
    expect(marked.map((f) => f.blocks_pr)).toEqual([true, true, false, false, false]);
  });
});

describe('buildSystemPrompt', () => {
  it('mentions every required category', () => {
    const prompt = buildSystemPrompt();
    for (const cat of REPORT_TOOL.input_schema.properties.findings.items.properties.category.enum) {
      expect(prompt).toContain(cat);
    }
  });

  it('describes the severity → blocks_pr rule', () => {
    expect(buildSystemPrompt()).toMatch(/CRITICAL and HIGH block the PR/);
  });
});

describe('buildUserPrompt', () => {
  it('does not include previous-findings section on iteration 1', () => {
    const prompt = buildUserPrompt('diff body', null, 1);
    expect(prompt).not.toMatch(/Previous iteration findings/);
    expect(prompt).toContain('diff body');
  });

  it('includes previous-findings section on iteration 2+', () => {
    const prev = [finding({ severity: 'HIGH' })];
    const prompt = buildUserPrompt('diff body', prev, 2);
    expect(prompt).toMatch(/Previous iteration findings \(iteration 1\)/);
    expect(prompt).toContain('"severity": "HIGH"');
  });

  it('omits previous-findings section when iteration > 1 but previousFindings is null', () => {
    const prompt = buildUserPrompt('diff body', null, 2);
    expect(prompt).not.toMatch(/Previous iteration findings/);
  });
});

describe('parseToolResponse', () => {
  it('extracts the report_findings tool input', () => {
    const result = parseToolResponse({
      content: [
        {
          type: 'tool_use',
          name: 'report_findings',
          input: { findings: [], confidence: 0.9, reasoning: 'clean diff' },
        },
      ],
    });
    expect(result.confidence).toBe(0.9);
    expect(result.findings).toEqual([]);
  });

  it('throws when no tool_use block is present', () => {
    expect(() =>
      parseToolResponse({ content: [{ type: 'text' }] })
    ).toThrow(/did not invoke report_findings/);
  });

  it('throws when tool_use has wrong name', () => {
    expect(() =>
      parseToolResponse({
        content: [{ type: 'tool_use', name: 'something_else', input: {} }],
      })
    ).toThrow(/did not invoke report_findings/);
  });
});
