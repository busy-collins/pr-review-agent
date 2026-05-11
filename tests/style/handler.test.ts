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

import { handler } from '../../agents/style/src/index';
import type { StyleFinding } from '../../shared/types';

const basePrMetadata = {
  pr_number: 42,
  repo: 'myorg/myrepo',
  sender: 'octocat',
  base_branch: 'main',
  head_branch: 'feature',
  diff_line_count: 10,
};

function toolUseResponse(input: {
  findings: Array<Omit<StyleFinding, 'blocks_pr'>>;
  confidence: number;
  reasoning: string;
}) {
  return {
    content: [{ type: 'tool_use', name: 'report_findings', input }],
  };
}

describe('style agent handler', () => {
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

    expect(result.agent).toBe('style');
    expect(result.verdict).toBe('APPROVED');
    expect(result.findings).toEqual([]);
    expect(result.ralph_loop_complete).toBe(false);
    expect(writeCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'STYLE', status: 'IN_PROGRESS' })
    );
  });

  it('returns CHANGES_REQUESTED with findings on a noisy diff', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      toolUseResponse({
        findings: [
          {
            severity: 'MEDIUM',
            category: 'NO_ANY_TYPE',
            file: 'src/foo.ts',
            line: 12,
            description: 'use of `any`',
            suggestion: 'narrow to a concrete type',
          },
          {
            severity: 'LOW',
            category: 'UNUSED_IMPORT',
            file: 'src/foo.ts',
            line: 3,
            description: 'unused lodash import',
            suggestion: 'remove the import',
          },
        ],
        confidence: 0.88,
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
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.blocks_pr === false)).toBe(true);
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
        pr_metadata: basePrMetadata,
        diff_content: 'diff',
        iteration: 1,
        previous_findings: null,
      } as never)
    ).rejects.toThrow(/Invalid style agent input/);
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

  it('never sets checkpoint status to ESCALATED — style alone cannot block', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      toolUseResponse({
        findings: [
          {
            severity: 'MEDIUM',
            category: 'COMMENTED_OUT_CODE',
            file: 'src/x.ts',
            line: 5,
            description: 'block of commented code',
            suggestion: 'remove it',
          },
        ],
        confidence: 0.9,
        reasoning: '',
      })
    );

    await handler({
      session_id: 'pr-myorg-myrepo-42-1000',
      pr_metadata: basePrMetadata,
      diff_content: 'diff',
      iteration: 1,
      previous_findings: null,
    });

    const allArgs = writeCheckpointMock.mock.calls.map(
      (call) => (call as unknown as [{ status: string }])[0]
    );
    expect(allArgs.length).toBeGreaterThan(0);
    for (const arg of allArgs) {
      expect(arg.status).not.toBe('ESCALATED');
    }
  });
});
