import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dynamoSendMock } = vi.hoisted(() => ({
  dynamoSendMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = dynamoSendMock;
  },
  GetItemCommand: class {
    constructor(public input: unknown) {}
  },
  UpdateItemCommand: class {
    constructor(public input: unknown) {}
  },
}));

import {
  buildRateLimitResponse,
  calculateBackoff,
  checkGitHubAPILimit,
  checkRateLimits,
  getBlockingLimit,
  incrementGitHubAPICounter,
  incrementRateLimitCounters,
  isRateLimited,
  RATE_LIMITS,
  type RateLimitResult,
} from '../../api/rate-limiting/rate.limiter';

beforeEach(() => {
  dynamoSendMock.mockReset();
});

// ============================================================
// Pure helpers — no I/O, easy to nail down.
// ============================================================
describe('isRateLimited / getBlockingLimit', () => {
  const allowed = (scope: RateLimitResult['scope'] = 'REPO'): RateLimitResult => ({
    allowed: true,
    scope,
    key: 'k',
    current: 0,
    limit: 50,
    windowSeconds: 60,
    retryAfterSeconds: null,
    resetAt: null,
  });
  const blocked = (scope: RateLimitResult['scope'] = 'USER'): RateLimitResult => ({
    allowed: false,
    scope,
    key: 'k',
    current: 11,
    limit: 10,
    windowSeconds: 300,
    retryAfterSeconds: 200,
    resetAt: '2026-05-11T01:00:00Z',
  });

  it('returns false when every result is allowed', () => {
    expect(isRateLimited([allowed(), allowed('PR')])).toBe(false);
    expect(getBlockingLimit([allowed(), allowed('PR')])).toBeNull();
  });

  it('returns true and points at the first blocking result', () => {
    const results = [allowed(), blocked('USER'), blocked('PR')];
    expect(isRateLimited(results)).toBe(true);
    expect(getBlockingLimit(results)?.scope).toBe('USER');
  });
});

describe('buildRateLimitResponse', () => {
  it('emits a 429 with a scope-specific message', () => {
    const r = buildRateLimitResponse({
      allowed: false,
      scope: 'REPO',
      key: 'repo:x',
      current: 50,
      limit: 50,
      windowSeconds: 3600,
      retryAfterSeconds: 1800,
      resetAt: '2026-05-11T01:00:00Z',
    });
    expect(r.statusCode).toBe(429);
    expect(r.message).toMatch(/Repository review limit/);
    expect(r.retryAfterSeconds).toBe(1800);
  });

  it.each([
    ['REPO',       /Repository review/],
    ['USER',       /User command/],
    ['PR',         /PR review/],
    ['GITHUB_API', /GitHub API/],
  ] as const)('scope %s → %s message', (scope, pattern) => {
    const r = buildRateLimitResponse({
      allowed: false,
      scope,
      key: 'k',
      current: 99,
      limit: 100,
      windowSeconds: 60,
      retryAfterSeconds: 30,
      resetAt: null,
    });
    expect(r.message).toMatch(pattern);
  });
});

describe('calculateBackoff', () => {
  it('grows exponentially from the base', () => {
    // Use baseMs=100 and rely on Math.random returning < 1000ms jitter
    expect(calculateBackoff(0, 100)).toBeGreaterThanOrEqual(100);
    expect(calculateBackoff(1, 100)).toBeGreaterThanOrEqual(200);
    expect(calculateBackoff(2, 100)).toBeGreaterThanOrEqual(400);
  });

  it('caps at 30 seconds regardless of attempt number', () => {
    expect(calculateBackoff(20)).toBeLessThanOrEqual(30_000);
    expect(calculateBackoff(100)).toBeLessThanOrEqual(30_000);
  });
});

// ============================================================
// DynamoDB-backed paths — mock the SDK and check the calls.
// ============================================================
describe('checkRateLimits — DynamoDB interactions', () => {
  it('checks REPO, USER, and PR scopes in one batch (3 reads)', async () => {
    dynamoSendMock.mockResolvedValue({}); // no Item → current=0 → allowed
    await checkRateLimits({
      repo: 'org/repo',
      prNumber: 42,
      sender: 'alice',
    });
    expect(dynamoSendMock).toHaveBeenCalledTimes(3);
  });

  it('returns allowed=true when DynamoDB has no record for the window', async () => {
    dynamoSendMock.mockResolvedValue({}); // missing Item
    const results = await checkRateLimits({
      repo: 'org/repo',
      prNumber: 42,
      sender: 'alice',
    });
    for (const r of results) {
      expect(r.allowed).toBe(true);
      expect(r.current).toBe(0);
    }
  });

  it('returns allowed=false when current count reaches the limit for that scope', async () => {
    // PR scope limit is 3 per 10-minute window. Force current=3 for the PR
    // scope, lower for the others, so PR is the one that blocks.
    let call = 0;
    dynamoSendMock.mockImplementation(async () => {
      call++;
      // checkRateLimits sends GetItem for REPO, USER, PR in order via Promise.all
      // Order isn't strictly deterministic; cover by returning high count only
      // on the third call.
      if (call === 3) return { Item: { request_count: { N: '3' } } };
      return { Item: { request_count: { N: '0' } } };
    });
    const results = await checkRateLimits({
      repo: 'org/repo',
      prNumber: 42,
      sender: 'alice',
    });
    const blocked = results.filter((r) => !r.allowed);
    expect(blocked.length).toBeGreaterThanOrEqual(1);
  });

  it('fails open (allowed=true) when DynamoDB rejects the read', async () => {
    dynamoSendMock.mockRejectedValue(new Error('throttled'));
    const results = await checkRateLimits({
      repo: 'org/repo',
      prNumber: 42,
      sender: 'alice',
    });
    for (const r of results) expect(r.allowed).toBe(true);
  });
});

describe('incrementRateLimitCounters', () => {
  it('issues 3 UpdateItem calls (REPO, USER, PR)', async () => {
    dynamoSendMock.mockResolvedValue({});
    await incrementRateLimitCounters({
      repo: 'org/repo',
      prNumber: 42,
      sender: 'alice',
    });
    expect(dynamoSendMock).toHaveBeenCalledTimes(3);
  });

  it('swallows update errors without throwing — rate limit drift is non-fatal', async () => {
    dynamoSendMock.mockRejectedValue(new Error('throttled'));
    await expect(
      incrementRateLimitCounters({
        repo: 'org/repo',
        prNumber: 42,
        sender: 'alice',
      })
    ).resolves.toBeUndefined();
  });
});

describe('GitHub API rate limit helpers', () => {
  it('checkGitHubAPILimit reads the global counter', async () => {
    dynamoSendMock.mockResolvedValue({});
    const r = await checkGitHubAPILimit();
    expect(r.scope).toBe('GITHUB_API');
    expect(r.key).toBe('github:api:global');
    expect(r.limit).toBe(RATE_LIMITS.GITHUB_API.maxRequests);
  });

  it('incrementGitHubAPICounter issues an update', async () => {
    dynamoSendMock.mockResolvedValue({});
    await incrementGitHubAPICounter();
    expect(dynamoSendMock).toHaveBeenCalledTimes(1);
  });
});
