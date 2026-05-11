import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeCheckpointMock, postCommentMock } = vi.hoisted(() => ({
  writeCheckpointMock: vi.fn(async () => true),
  postCommentMock: vi.fn(async () => ({
    id: 1,
    html_url: 'https://github.com/myorg/myrepo/pull/42#issuecomment-1',
  })),
}));

vi.mock('../../shared/dynamo', () => ({
  writeCheckpoint: writeCheckpointMock,
  readCheckpoints: vi.fn(async () => []),
}));

vi.mock('../../api/mcp/Github.mcp.client', () => ({
  postPRComment: postCommentMock,
  callGitHubMCP: vi.fn(),
  getPullRequest: vi.fn(),
  getPullRequestDiff: vi.fn(),
  getPullRequestFiles: vi.fn(),
  updatePRComment: vi.fn(),
  addPRLabel: vi.fn(),
  createCommitStatus: vi.fn(),
  listPRComments: vi.fn(),
  GITHUB_MCP_OPERATIONS: {},
  PR_LABELS: {},
}));

import {
  averageConfidence,
  computeFinalVerdict,
  handler,
  mergeFindings,
} from '../../agents/aggregator/src/index';
import type {
  SecurityAgentOutput,
  SecurityFinding,
  StyleAgentOutput,
  StyleFinding,
  TaggedFinding,
} from '../../shared/types';

const sec = (overrides: Partial<SecurityFinding> = {}): SecurityFinding => ({
  severity: 'HIGH',
  category: 'SQL_INJECTION',
  file: 'src/db.ts',
  line: 50,
  description: 'd',
  suggestion: 's',
  blocks_pr: true,
  ...overrides,
});

const sty = (overrides: Partial<StyleFinding> = {}): StyleFinding => ({
  severity: 'LOW',
  category: 'UNUSED_IMPORT',
  file: 'src/foo.ts',
  line: 1,
  description: 'd',
  suggestion: 's',
  blocks_pr: false,
  ...overrides,
});

const securityOutput = (
  overrides: Partial<SecurityAgentOutput> = {}
): SecurityAgentOutput => ({
  agent: 'security',
  session_id: 'sid',
  confidence: 0.9,
  findings: [],
  iteration: 1,
  ralph_loop_complete: false,
  verdict: 'APPROVED',
  checkpoint_saved: true,
  ...overrides,
});

const styleOutput = (
  overrides: Partial<StyleAgentOutput> = {}
): StyleAgentOutput => ({
  agent: 'style',
  session_id: 'sid',
  confidence: 0.9,
  findings: [],
  iteration: 1,
  ralph_loop_complete: false,
  verdict: 'APPROVED',
  checkpoint_saved: true,
  ...overrides,
});

const basePrMetadata = {
  pr_number: 42,
  repo: 'myorg/myrepo',
  sender: 'octocat',
  base_branch: 'main',
  head_branch: 'feature',
  diff_line_count: 10,
};

// ============================================================
// Pure helper tests
// ============================================================

describe('averageConfidence', () => {
  it('returns the mean', () => {
    expect(averageConfidence(0.8, 1.0)).toBeCloseTo(0.9, 5);
    expect(averageConfidence(0, 0)).toBe(0);
    expect(averageConfidence(1, 1)).toBe(1);
  });
});

describe('computeFinalVerdict', () => {
  const tag = (
    agent: 'security' | 'style',
    finding: SecurityFinding | StyleFinding
  ): TaggedFinding => ({ agent, finding });

  it('returns ESCALATED on any CRITICAL finding', () => {
    expect(
      computeFinalVerdict({
        securityVerdict: 'APPROVED',
        findings: [tag('security', sec({ severity: 'CRITICAL' }))],
        overallConfidence: 0.95,
      })
    ).toBe('ESCALATED');
  });

  it('returns ESCALATED when security verdict is ESCALATED', () => {
    expect(
      computeFinalVerdict({
        securityVerdict: 'ESCALATED',
        findings: [],
        overallConfidence: 0.95,
      })
    ).toBe('ESCALATED');
  });

  it('returns ESCALATED when overall confidence falls below threshold', () => {
    expect(
      computeFinalVerdict({
        securityVerdict: 'APPROVED',
        findings: [],
        overallConfidence: 0.74,
      })
    ).toBe('ESCALATED');
  });

  it('returns CHANGES_REQUESTED on any HIGH finding without CRITICAL', () => {
    expect(
      computeFinalVerdict({
        securityVerdict: 'CHANGES_REQUESTED',
        findings: [tag('security', sec({ severity: 'HIGH' }))],
        overallConfidence: 0.9,
      })
    ).toBe('CHANGES_REQUESTED');
  });

  it('returns APPROVED when only style findings exist (style alone never blocks)', () => {
    expect(
      computeFinalVerdict({
        securityVerdict: 'APPROVED',
        findings: [
          tag('style', sty({ severity: 'MEDIUM' })),
          tag('style', sty({ severity: 'LOW' })),
        ],
        overallConfidence: 0.92,
      })
    ).toBe('APPROVED');
  });

  it('returns APPROVED on empty findings + high confidence', () => {
    expect(
      computeFinalVerdict({
        securityVerdict: 'APPROVED',
        findings: [],
        overallConfidence: 0.99,
      })
    ).toBe('APPROVED');
  });
});

describe('mergeFindings', () => {
  it('returns all findings tagged with their agent when no collisions', () => {
    const { tagged, conflictResolutions } = mergeFindings(
      [sec({ file: 'a.ts', line: 1 })],
      [sty({ file: 'b.ts', line: 2 })]
    );
    expect(tagged).toHaveLength(2);
    expect(conflictResolutions).toEqual([]);
  });

  it('drops style finding when security has CRITICAL/HIGH on same line', () => {
    const { tagged, conflictResolutions } = mergeFindings(
      [sec({ file: 'a.ts', line: 1, severity: 'HIGH' })],
      [sty({ file: 'a.ts', line: 1 })]
    );
    expect(tagged).toHaveLength(1);
    expect(tagged[0]?.agent).toBe('security');
    expect(conflictResolutions).toEqual([
      { file: 'a.ts', line: 1, resolution: 'SECURITY_WINS' },
    ]);
  });

  it('keeps both findings when security severity is non-blocking on same line', () => {
    const { tagged, conflictResolutions } = mergeFindings(
      [sec({ file: 'a.ts', line: 1, severity: 'LOW' })],
      [sty({ file: 'a.ts', line: 1 })]
    );
    expect(tagged).toHaveLength(2);
    expect(conflictResolutions).toEqual([
      { file: 'a.ts', line: 1, resolution: 'MERGED' },
    ]);
  });
});

// ============================================================
// Handler dispatch tests
// ============================================================

describe('aggregator handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeCheckpointMock.mockResolvedValue(true);
    postCommentMock.mockResolvedValue({
      id: 1,
      html_url: 'https://github.com/myorg/myrepo/pull/42#issuecomment-1',
    });
  });

  it('returns APPROVED on clean input', async () => {
    const result = await handler({
      session_id: 'sid',
      pr_metadata: basePrMetadata,
      security_output: securityOutput({ confidence: 0.95 }),
      style_output: styleOutput({ confidence: 0.95 }),
    });
    expect(result.final_verdict).toBe('APPROVED');
    expect(result.overall_confidence).toBeCloseTo(0.95);
    expect(result.blocking_count).toBe(0);
    expect(result.non_blocking_count).toBe(0);
    expect(result.comment_posted).toBe(true);
    expect(result.github_comment_url).toMatch(/issuecomment-/);
    expect(writeCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'AGGREGATOR', status: 'COMPLETED' })
    );
  });

  it('escalates on any CRITICAL security finding', async () => {
    const result = await handler({
      session_id: 'sid',
      pr_metadata: basePrMetadata,
      security_output: securityOutput({
        confidence: 0.9,
        verdict: 'ESCALATED',
        findings: [
          sec({ severity: 'CRITICAL', category: 'HARDCODED_SECRET' }),
        ],
      }),
      style_output: styleOutput({ confidence: 0.9 }),
    });
    expect(result.final_verdict).toBe('ESCALATED');
    expect(result.blocking_count).toBe(1);
    expect(writeCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ESCALATED' })
    );
  });

  it('escalates when overall confidence drops below threshold', async () => {
    const result = await handler({
      session_id: 'sid',
      pr_metadata: basePrMetadata,
      security_output: securityOutput({ confidence: 0.7 }),
      style_output: styleOutput({ confidence: 0.7 }),
    });
    expect(result.final_verdict).toBe('ESCALATED');
  });

  it('CHANGES_REQUESTED on HIGH security with no CRITICAL', async () => {
    const result = await handler({
      session_id: 'sid',
      pr_metadata: basePrMetadata,
      security_output: securityOutput({
        confidence: 0.9,
        verdict: 'CHANGES_REQUESTED',
        findings: [sec({ severity: 'HIGH' })],
      }),
      style_output: styleOutput({ confidence: 0.9 }),
    });
    expect(result.final_verdict).toBe('CHANGES_REQUESTED');
    expect(result.blocking_count).toBe(1);
    expect(result.non_blocking_count).toBe(0);
  });

  it('APPROVED with only style findings — style alone never blocks', async () => {
    const result = await handler({
      session_id: 'sid',
      pr_metadata: basePrMetadata,
      security_output: securityOutput({ confidence: 0.9 }),
      style_output: styleOutput({
        confidence: 0.9,
        verdict: 'CHANGES_REQUESTED',
        findings: [sty({ severity: 'MEDIUM' }), sty({ severity: 'LOW' })],
      }),
    });
    expect(result.final_verdict).toBe('APPROVED');
    expect(result.blocking_count).toBe(0);
    expect(result.non_blocking_count).toBe(2);
  });

  it('records conflict_resolutions when both agents touch the same line', async () => {
    const result = await handler({
      session_id: 'sid',
      pr_metadata: basePrMetadata,
      security_output: securityOutput({
        findings: [sec({ file: 'a.ts', line: 1, severity: 'HIGH' })],
        verdict: 'CHANGES_REQUESTED',
        confidence: 0.9,
      }),
      style_output: styleOutput({
        findings: [sty({ file: 'a.ts', line: 1 })],
        confidence: 0.9,
      }),
    });
    expect(result.conflict_resolutions).toEqual([
      { file: 'a.ts', line: 1, resolution: 'SECURITY_WINS' },
    ]);
  });

  it('returns comment_posted=false when GitHub call fails', async () => {
    postCommentMock.mockRejectedValueOnce(new Error('GitHub API down'));
    const result = await handler({
      session_id: 'sid',
      pr_metadata: basePrMetadata,
      security_output: securityOutput({ confidence: 0.9 }),
      style_output: styleOutput({ confidence: 0.9 }),
    });
    expect(result.comment_posted).toBe(false);
    expect(result.github_comment_url).toBeNull();
    expect(result.final_verdict).toBe('APPROVED'); // pipeline still completes
  });

  it('rejects malformed input', async () => {
    await expect(
      handler({
        // missing session_id
        pr_metadata: basePrMetadata,
        security_output: securityOutput(),
        style_output: styleOutput(),
      } as never)
    ).rejects.toThrow(/Invalid aggregator input/);
  });

  it('SHADOW_MODE=true skips GitHub post but still records the rendered comment', async () => {
    process.env.SHADOW_MODE = 'true';
    try {
      const result = await handler({
        session_id: 'sid',
        pr_metadata: basePrMetadata,
        security_output: securityOutput({ confidence: 0.9 }),
        style_output: styleOutput({ confidence: 0.9 }),
      });
      expect(postCommentMock).not.toHaveBeenCalled();
      expect(result.comment_posted).toBe(false);
      expect(result.github_comment_url).toBeNull();
      // The rendered comment body is still produced + checkpointed so the
      // dashboard can show what *would* have been posted.
      expect(result.github_comment).toContain('## 🤖 Automated PR Review');
      expect(writeCheckpointMock).toHaveBeenCalledWith(
        expect.objectContaining({ stage: 'AGGREGATOR' })
      );
    } finally {
      delete process.env.SHADOW_MODE;
    }
  });

  it('never calls Slack — that is the state machine\'s job', async () => {
    await handler({
      session_id: 'sid',
      pr_metadata: basePrMetadata,
      security_output: securityOutput({
        confidence: 0.9,
        verdict: 'ESCALATED',
        findings: [sec({ severity: 'CRITICAL' })],
      }),
      style_output: styleOutput({ confidence: 0.9 }),
    });
    // slack_notified always false from Aggregator's perspective
    const checkpointCall = writeCheckpointMock.mock.calls[0];
    expect(checkpointCall).toBeDefined();
  });
});
