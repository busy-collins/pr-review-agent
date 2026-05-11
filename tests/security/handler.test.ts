import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeCheckpointMock, messagesCreateMock } = vi.hoisted(() => ({
  writeCheckpointMock: vi.fn(async () => true),
  messagesCreateMock: vi.fn(),
}));

vi.mock('../../shared/dynamo', () => ({
  writeCheckpoint: writeCheckpointMock,
  readCheckpoints: vi.fn(async () => []),
}));

vi.mock('../../shared/anthropic', () => ({
  getAnthropicClient: () => ({
    messages: { create: messagesCreateMock },
  }),
  CLAUDE_MODEL: 'claude-sonnet-4-6',
}));

import { handler } from '../../agents/security/src/index';
import type { SecurityFinding } from '../../shared/types';

const basePrMetadata = {
  pr_number: 42,
  repo: 'myorg/myrepo',
  sender: 'octocat',
  base_branch: 'main',
  head_branch: 'feature',
  diff_line_count: 10,
};

function toolUseResponse(input: {
  findings: Array<Omit<SecurityFinding, 'blocks_pr'>>;
  confidence: number;
  reasoning: string;
}) {
  return {
    content: [{ type: 'tool_use', name: 'report_findings', input }],
  };
}

describe('security agent handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeCheckpointMock.mockResolvedValue(true);
  });

  it('returns APPROVED with empty findings on a clean diff', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      toolUseResponse({ findings: [], confidence: 0.95, reasoning: 'clean' })
    );

    const result = await handler({
      session_id: 'pr-myorg-myrepo-42-1000',
      pr_metadata: basePrMetadata,
      diff_content: 'diff --git a/x b/x\n@@ -1 +1 @@\n+x',
      iteration: 1,
      previous_findings: null,
    });

    expect(result.agent).toBe('security');
    expect(result.verdict).toBe('APPROVED');
    expect(result.findings).toEqual([]);
    expect(result.confidence).toBe(0.95);
    expect(result.ralph_loop_complete).toBe(false);
    expect(writeCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'SECURITY', status: 'IN_PROGRESS' })
    );
  });

  it('returns ESCALATED when a CRITICAL finding is reported', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      toolUseResponse({
        findings: [
          {
            severity: 'CRITICAL',
            category: 'HARDCODED_SECRET',
            file: 'src/config.ts',
            line: 12,
            description: 'AWS access key committed to source',
            suggestion: 'Move to AWS Secrets Manager and rotate the key',
          },
        ],
        confidence: 0.92,
        reasoning: 'unambiguous credential exposure',
      })
    );

    const result = await handler({
      session_id: 'pr-myorg-myrepo-42-1000',
      pr_metadata: basePrMetadata,
      diff_content: 'diff',
      iteration: 1,
      previous_findings: null,
    });

    expect(result.verdict).toBe('ESCALATED');
    expect(result.findings[0]?.blocks_pr).toBe(true);
    expect(writeCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ESCALATED' })
    );
  });

  it('marks ralph_loop_complete on the final iteration', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      toolUseResponse({ findings: [], confidence: 0.7, reasoning: 'uncertain' })
    );

    const result = await handler({
      session_id: 'pr-myorg-myrepo-42-1000',
      pr_metadata: basePrMetadata,
      diff_content: 'diff',
      iteration: 3,
      previous_findings: [],
    });

    expect(result.ralph_loop_complete).toBe(true);
    expect(result.iteration).toBe(3);
  });

  it('rejects malformed input', async () => {
    await expect(
      handler({
        // missing session_id
        pr_metadata: basePrMetadata,
        diff_content: 'diff',
        iteration: 1,
        previous_findings: null,
      } as never)
    ).rejects.toThrow(/Invalid security agent input/);
  });

  it('throws when Claude does not invoke the tool', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text' }],
    });

    await expect(
      handler({
        session_id: 'pr-myorg-myrepo-42-1000',
        pr_metadata: basePrMetadata,
        diff_content: 'diff',
        iteration: 1,
        previous_findings: null,
      })
    ).rejects.toThrow(/did not invoke report_findings/);
  });

  it('returns CHANGES_REQUESTED with HIGH but no CRITICAL', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      toolUseResponse({
        findings: [
          {
            severity: 'HIGH',
            category: 'SQL_INJECTION',
            file: 'src/db.ts',
            line: 88,
            description: 'unsanitized query parameter',
            suggestion: 'use parameterized queries',
          },
          {
            severity: 'LOW',
            category: 'PII_EXPOSURE',
            file: 'src/log.ts',
            line: 5,
            description: 'email logged at info level',
            suggestion: 'redact before logging',
          },
        ],
        confidence: 0.86,
        reasoning: 'two findings confirmed',
      })
    );

    const result = await handler({
      session_id: 'pr-myorg-myrepo-42-1000',
      pr_metadata: basePrMetadata,
      diff_content: 'diff',
      iteration: 1,
      previous_findings: null,
    });

    expect(result.verdict).toBe('CHANGES_REQUESTED');
    expect(result.findings.find((f) => f.severity === 'HIGH')?.blocks_pr).toBe(true);
    expect(result.findings.find((f) => f.severity === 'LOW')?.blocks_pr).toBe(false);
  });
});
