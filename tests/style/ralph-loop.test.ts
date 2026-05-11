import { describe, expect, it } from 'vitest';
import {
  buildSystemPrompt,
  buildUserPrompt,
  computeVerdict,
  normalizeFindings,
  parseToolResponse,
  REPORT_TOOL,
} from '../../agents/style/src/ralph-loop';
import type { StyleFinding } from '../../shared/types';

const finding = (overrides: Partial<StyleFinding> = {}): StyleFinding => ({
  severity: 'LOW',
  category: 'UNUSED_IMPORT',
  file: 'src/foo.ts',
  line: 1,
  description: 'd',
  suggestion: 's',
  blocks_pr: false,
  ...overrides,
});

describe('computeVerdict', () => {
  it('returns APPROVED on empty findings', () => {
    expect(computeVerdict([])).toBe('APPROVED');
  });

  it('returns CHANGES_REQUESTED when any finding exists', () => {
    expect(computeVerdict([finding()])).toBe('CHANGES_REQUESTED');
  });

  it('never returns ESCALATED — that is reserved for security', () => {
    // Exhaustive check across all allowed severities
    const allLevels: StyleFinding[] = [
      finding({ severity: 'MEDIUM' }),
      finding({ severity: 'LOW' }),
      finding({ severity: 'INFO' }),
    ];
    expect(computeVerdict(allLevels)).toBe('CHANGES_REQUESTED');
  });
});

describe('normalizeFindings', () => {
  it('forces blocks_pr=false on every finding', () => {
    const raw = [
      { severity: 'MEDIUM' as const, category: 'NO_ANY_TYPE' as const, file: 'a', line: 1, description: 'd', suggestion: 's' },
      { severity: 'LOW' as const, category: 'UNUSED_IMPORT' as const, file: 'b', line: 2, description: 'd', suggestion: 's' },
    ];
    const normalized = normalizeFindings(raw);
    expect(normalized.every((f) => f.blocks_pr === false)).toBe(true);
  });
});

describe('buildSystemPrompt', () => {
  it('mentions every required category', () => {
    const prompt = buildSystemPrompt();
    for (const cat of REPORT_TOOL.input_schema.properties.findings.items.properties.category.enum) {
      expect(prompt).toContain(cat);
    }
  });

  it('hard-rules out CRITICAL/HIGH severity', () => {
    expect(buildSystemPrompt()).toMatch(/MUST NOT use severity CRITICAL or HIGH/);
  });

  it('mentions both TypeScript and Python rules', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toMatch(/TypeScript:/);
    expect(prompt).toMatch(/Python:/);
  });

  it('states style findings never block a PR', () => {
    expect(buildSystemPrompt()).toMatch(/blocks_pr is ALWAYS false/);
  });
});

describe('buildUserPrompt', () => {
  it('does not include previous-findings section on iteration 1', () => {
    const prompt = buildUserPrompt('diff body', null, 1);
    expect(prompt).not.toMatch(/Previous iteration findings/);
    expect(prompt).toContain('diff body');
  });

  it('includes previous-findings section on iteration 2+', () => {
    const prev = [finding({ severity: 'MEDIUM' })];
    const prompt = buildUserPrompt('diff body', prev, 2);
    expect(prompt).toMatch(/Previous iteration findings \(iteration 1\)/);
    expect(prompt).toContain('"severity": "MEDIUM"');
  });

  it('omits previous-findings section when iteration > 1 but findings null', () => {
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
    expect(() => parseToolResponse({ content: [{ type: 'text' }] })).toThrow(
      /did not invoke report_findings/
    );
  });

  it('throws when tool_use has wrong name', () => {
    expect(() =>
      parseToolResponse({
        content: [{ type: 'tool_use', name: 'something_else', input: {} }],
      })
    ).toThrow(/did not invoke report_findings/);
  });
});

describe('tool schema constraints', () => {
  it('enum forbids CRITICAL and HIGH severity', () => {
    const allowed = REPORT_TOOL.input_schema.properties.findings.items.properties.severity.enum;
    expect(allowed).not.toContain('CRITICAL');
    expect(allowed).not.toContain('HIGH');
    expect(allowed).toEqual(['MEDIUM', 'LOW', 'INFO']);
  });
});
