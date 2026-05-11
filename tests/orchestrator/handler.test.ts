import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock() factories are hoisted above all imports, so the mock fns must
// be created inside vi.hoisted() to be accessible from those factories.
const {
  writeCheckpointMock,
  getDiffMock,
  postCommentMock,
  postEscalationMock,
  postSizeWarningMock,
} = vi.hoisted(() => ({
  writeCheckpointMock: vi.fn(async () => true),
  getDiffMock: vi.fn(async () => ''),
  postCommentMock: vi.fn(async () => ({
    id: 1,
    html_url: 'https://github.com/x',
  })),
  postEscalationMock: vi.fn(async () => ({ ts: '1', channel: 'c' })),
  postSizeWarningMock: vi.fn(async () => undefined),
}));

vi.mock('../../shared/dynamo', () => ({
  writeCheckpoint: writeCheckpointMock,
  readCheckpoints: vi.fn(async () => []),
}));

vi.mock('../../api/mcp/Github.mcp.client', () => ({
  getPullRequestDiff: getDiffMock,
  postPRComment: postCommentMock,
  GITHUB_MCP_OPERATIONS: {},
  PR_LABELS: {},
  callGitHubMCP: vi.fn(),
  getPullRequest: vi.fn(),
  getPullRequestFiles: vi.fn(),
  updatePRComment: vi.fn(),
  addPRLabel: vi.fn(),
  createCommitStatus: vi.fn(),
  listPRComments: vi.fn(),
}));

vi.mock('../../api/mcp/Slack.mcp.client', () => ({
  postEscalationNotification: postEscalationMock,
  postSizeWarningNotification: postSizeWarningMock,
  postEscalationThreadReply: vi.fn(),
  SLACK_MCP_OPERATIONS: {},
  ESCALATION_REASONS: {},
}));

import { handler } from '../../agents/orchestrator/src/index';

const baseWebhook = {
  event_type: 'pull_request.opened' as const,
  pr_number: 42,
  repo: 'myorg/myrepo',
  sender: 'octocat',
  diff_url: 'https://example.com/diff',
  base_branch: 'main',
  head_branch: 'feature',
  slash_command: null,
  timestamp: '2026-05-11T00:00:00Z',
};

const tinyDiff = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1 +1 @@',
  '+small change',
].join('\n');

describe('orchestrator handler dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeCheckpointMock.mockResolvedValue(true);
  });

  it('VALIDATE returns ELIGIBLE for a small clean PR', async () => {
    getDiffMock.mockResolvedValueOnce(tinyDiff);
    const result = (await handler({
      action: 'VALIDATE',
      payload: baseWebhook,
    })) as { status: string; eligible: boolean; subagents_to_run: string[] };

    expect(result.status).toBe('ELIGIBLE');
    expect(result.eligible).toBe(true);
    expect(result.subagents_to_run).toEqual(['security', 'style']);
    expect(writeCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'ORCHESTRATOR', status: 'IN_PROGRESS' })
    );
  });

  it('VALIDATE returns SKIPPED when diff exceeds the size cap', async () => {
    // Build a diff with > 3,000 reviewable lines
    const huge = ['diff --git a/src/big.ts b/src/big.ts', '@@ -1,1 +1,1 @@'];
    for (let i = 0; i < 3001; i++) huge.push(`+line ${i}`);
    getDiffMock.mockResolvedValueOnce(huge.join('\n'));

    const result = (await handler({
      action: 'VALIDATE',
      payload: baseWebhook,
    })) as { status: string; eligible: boolean; skip_reason: string | null };

    expect(result.status).toBe('SKIPPED');
    expect(result.eligible).toBe(false);
    expect(result.skip_reason).toMatch(/exceeds size limit/);
    expect(writeCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'ORCHESTRATOR', status: 'ESCALATED' })
    );
  });

  it('VALIDATE flags ESCALATED when an auth path is touched', async () => {
    const authDiff =
      'diff --git a/src/auth/login.ts b/src/auth/login.ts\n@@ -1 +1 @@\n+x';
    getDiffMock.mockResolvedValueOnce(authDiff);
    const result = (await handler({
      action: 'VALIDATE',
      payload: baseWebhook,
    })) as { status: string; escalation_reason: string | null };
    expect(result.status).toBe('ESCALATED');
    expect(result.escalation_reason).toBe('AUTH_LOGIC_CHANGE');
  });

  it('VALIDATE restricts subagents based on slash command', async () => {
    getDiffMock.mockResolvedValueOnce(tinyDiff);
    const result = (await handler({
      action: 'VALIDATE',
      payload: { ...baseWebhook, slash_command: '/review security' },
    })) as { subagents_to_run: string[] };
    expect(result.subagents_to_run).toEqual(['security']);
  });

  it('HANDLE_FAILURE writes a FAILED checkpoint and resolves', async () => {
    const result = await handler({
      action: 'HANDLE_FAILURE',
      stage: 'SUBAGENT',
      error: new Error('mock-error'),
      session_id: 'pr-myorg-myrepo-42-1000',
    });
    expect(result).toEqual({ handled: true });
    expect(writeCheckpointMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' })
    );
  });

  it('NOTIFY_SLACK forwards to the Slack client', async () => {
    await handler({
      action: 'NOTIFY_SLACK',
      session_id: 'pr-myorg-myrepo-42-1000',
      pr_metadata: {
        pr_number: 42,
        repo: 'myorg/myrepo',
        sender: 'octocat',
        base_branch: 'main',
        head_branch: 'feature',
        diff_line_count: 10,
      },
      reason: 'AUTH_LOGIC_CHANGE',
      pr_url: 'https://github.com/myorg/myrepo/pull/42',
    });
    expect(postEscalationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'AUTH_LOGIC_CHANGE',
        prNumber: 42,
      })
    );
  });

  it('rejects unknown actions', async () => {
    await expect(
      // @ts-expect-error — intentionally invalid action
      handler({ action: 'NOPE' })
    ).rejects.toThrow(/Unknown orchestrator action/);
  });
});
