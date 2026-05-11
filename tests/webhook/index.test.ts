import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { RateLimitResult } from '../../api/rate-limiting/rate.limiter';

const {
  verifyMock,
  sfnSendMock,
  checkRateLimitsMock,
  incrementCountersMock,
} = vi.hoisted(() => ({
  verifyMock: vi.fn<(event: unknown) => Promise<unknown>>(),
  sfnSendMock: vi.fn<(cmd: unknown) => Promise<unknown>>(),
  checkRateLimitsMock: vi.fn<(args: unknown) => Promise<unknown[]>>(),
  incrementCountersMock: vi.fn<(args: unknown) => Promise<void>>(),
}));

vi.mock('../../api/middlewares/webhook.middleware', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/middlewares/webhook.middleware')
  >('../../api/middlewares/webhook.middleware');
  return {
    ...actual,
    verifyAndParseWebhook: verifyMock,
  };
});

vi.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: class {
    send = sfnSendMock;
  },
  StartExecutionCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../api/rate-limiting/rate.limiter', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/rate-limiting/rate.limiter')
  >('../../api/rate-limiting/rate.limiter');
  return {
    ...actual,
    checkRateLimits: checkRateLimitsMock,
    incrementRateLimitCounters: incrementCountersMock,
  };
});

import { handler } from '../../api/webhook/index';

const lambdaContext = {} as never;
const lambdaCallback = (() => undefined) as never;

beforeEach(() => {
  process.env.STATE_MACHINE_ARN =
    'arn:aws:states:us-east-1:123456789012:stateMachine:pr-review-pipeline-test';
  vi.clearAllMocks();
  checkRateLimitsMock.mockResolvedValue([] as RateLimitResult[]);
  sfnSendMock.mockResolvedValue({ executionArn: 'arn:exec' });
});

function lastSfnInput(): { stateMachineArn: string; name: string; input: string } {
  const call = sfnSendMock.mock.calls[0];
  if (!call) throw new Error('SFN send was not called');
  return (call[0] as { input: { stateMachineArn: string; name: string; input: string } }).input;
}

function buildEvent(): APIGatewayProxyEvent {
  return {
    body: 'ignored — middleware is mocked',
    headers: {},
    isBase64Encoded: false,
    httpMethod: 'POST',
    path: '/webhook',
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {} as never,
    resource: '/webhook',
  };
}

function callHandler(event: APIGatewayProxyEvent) {
  const result = handler(event, lambdaContext, lambdaCallback);
  if (result instanceof Promise) return result;
  throw new Error('handler returned non-promise');
}

const pullRequestPayload = {
  action: 'opened',
  pull_request: {
    number: 42,
    title: 'feat: thing',
    html_url: 'https://github.com/myorg/myrepo/pull/42',
    head: { sha: 'abc', ref: 'feature' },
    base: { sha: 'def', ref: 'main' },
    user: { login: 'octocat' },
    diff_url: 'https://github.com/myorg/myrepo/pull/42.diff',
    additions: 10,
    deletions: 5,
    changed_files: 1,
  },
  repository: { full_name: 'myorg/myrepo', default_branch: 'main' },
  sender: { login: 'octocat' },
};

const issueCommentPayload = (commentBody: string) => ({
  action: 'created',
  issue: { number: 42, pull_request: { url: 'https://api.github.com/.../42' } },
  comment: { id: 1, body: commentBody, user: { login: 'octocat' } },
  repository: { full_name: 'myorg/myrepo', default_branch: 'main' },
  sender: { login: 'octocat' },
});

describe('webhook handler', () => {
  it('returns 401 on bad signature', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: false,
      event: null,
      action: null,
      shouldProcess: false,
      skipReason: 'Invalid webhook signature',
      payload: null,
      error: 'HMAC failed',
    });

    const result = await callHandler(buildEvent());
    expect(result.statusCode).toBe(401);
    expect(sfnSendMock).not.toHaveBeenCalled();
  });

  it('returns 200 + skip note for irrelevant events', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: true,
      event: 'pull_request',
      action: 'labeled',
      shouldProcess: false,
      skipReason: "PR action 'labeled' does not trigger a review",
      payload: pullRequestPayload,
      error: null,
    });

    const result = await callHandler(buildEvent());
    expect(result.statusCode).toBe(200);
    expect(sfnSendMock).not.toHaveBeenCalled();
  });

  it('starts Step Functions on a pull_request.opened event', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: true,
      event: 'pull_request',
      action: 'opened',
      shouldProcess: true,
      skipReason: null,
      payload: pullRequestPayload,
      error: null,
    });

    const result = await callHandler(buildEvent());
    expect(result.statusCode).toBe(200);
    expect(sfnSendMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(lastSfnInput().input);
    expect(payload.event_type).toBe('pull_request.opened');
    expect(payload.pr_number).toBe(42);
    expect(payload.repo).toBe('myorg/myrepo');
    expect(payload.base_branch).toBe('main');
    expect(payload.head_branch).toBe('feature');
    expect(payload.diff_line_count).toBe(15);
    expect(payload.slash_command).toBeNull();
    expect(incrementCountersMock).toHaveBeenCalledTimes(1);
  });

  it('returns 429 when rate-limited and does NOT start Step Functions', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: true,
      event: 'pull_request',
      action: 'opened',
      shouldProcess: true,
      skipReason: null,
      payload: pullRequestPayload,
      error: null,
    });
    checkRateLimitsMock.mockResolvedValueOnce([
      {
        allowed: false,
        scope: 'REPO',
        key: 'repo:myorg/myrepo',
        current: 50,
        limit: 50,
        windowSeconds: 3600,
        retryAfterSeconds: 1800,
        resetAt: '2026-05-11T01:00:00Z',
      },
    ]);

    const result = await callHandler(buildEvent());
    expect(result.statusCode).toBe(429);
    expect(sfnSendMock).not.toHaveBeenCalled();
    expect(incrementCountersMock).not.toHaveBeenCalled();
  });

  it('parses /review security slash command and starts pipeline', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: true,
      event: 'issue_comment',
      action: 'created',
      shouldProcess: true,
      skipReason: null,
      payload: issueCommentPayload('/review security'),
      error: null,
    });

    const result = await callHandler(buildEvent());
    expect(result.statusCode).toBe(200);
    expect(sfnSendMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(lastSfnInput().input);
    expect(payload.event_type).toBe('issue_comment.created');
    expect(payload.slash_command).toBe('/review security');
  });

  it('does NOT start Step Functions for /review status', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: true,
      event: 'issue_comment',
      action: 'created',
      shouldProcess: true,
      skipReason: null,
      payload: issueCommentPayload('/review status'),
      error: null,
    });

    const result = await callHandler(buildEvent());
    expect(result.statusCode).toBe(200);
    expect(sfnSendMock).not.toHaveBeenCalled();
    expect(incrementCountersMock).not.toHaveBeenCalled();
  });

  it('does NOT start Step Functions for /review approve', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: true,
      event: 'issue_comment',
      action: 'created',
      shouldProcess: true,
      skipReason: null,
      payload: issueCommentPayload('/review approve'),
      error: null,
    });

    const result = await callHandler(buildEvent());
    expect(result.statusCode).toBe(200);
    expect(sfnSendMock).not.toHaveBeenCalled();
  });

  it('acknowledges unknown slash commands with help text', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: true,
      event: 'issue_comment',
      action: 'created',
      shouldProcess: true,
      skipReason: null,
      payload: issueCommentPayload('/review nonsense'),
      error: null,
    });

    const result = await callHandler(buildEvent());
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Unknown command');
    expect(sfnSendMock).not.toHaveBeenCalled();
  });

  it('returns 500 when Step Functions start fails', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: true,
      event: 'pull_request',
      action: 'opened',
      shouldProcess: true,
      skipReason: null,
      payload: pullRequestPayload,
      error: null,
    });
    sfnSendMock.mockRejectedValueOnce(new Error('AWS down'));

    const result = await callHandler(buildEvent());
    expect(result.statusCode).toBe(500);
    expect(incrementCountersMock).not.toHaveBeenCalled();
  });

  it('produces an execution name within the 80-char Step Functions limit', async () => {
    verifyMock.mockResolvedValueOnce({
      valid: true,
      event: 'pull_request',
      action: 'opened',
      shouldProcess: true,
      skipReason: null,
      payload: {
        ...pullRequestPayload,
        repository: {
          full_name: 'a-very-long-organization-name/a-very-long-repository-name-indeed',
          default_branch: 'main',
        },
      },
      error: null,
    });

    await callHandler(buildEvent());
    const name = lastSfnInput().name;
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});
