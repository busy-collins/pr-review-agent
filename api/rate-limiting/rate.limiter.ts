import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

// ============================================================
// Rate Limiting Strategy
// Prevents abuse of the review pipeline and GitHub API
// Three layers: per-repo, per-user, per-PR
// ============================================================

const dynamo = new DynamoDBClient(
  process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}
);

// Rate limit table — separate from session table
const RATE_LIMIT_TABLE = process.env.RATE_LIMIT_TABLE_NAME || 'pr-review-rate-limits';

// ============================================================
// Rate limit configuration
// ============================================================
export const RATE_LIMITS = {
  // Per repository — prevents one repo flooding the pipeline
  REPO: {
    windowSeconds: 3600,    // 1 hour window
    maxRequests: 50,         // 50 reviews per repo per hour
  },
  // Per user — prevents one engineer spamming slash commands
  USER: {
    windowSeconds: 300,     // 5 minute window
    maxRequests: 10,         // 10 slash commands per user per 5 mins
  },
  // Per PR — prevents same PR being reviewed excessively
  PR: {
    windowSeconds: 600,     // 10 minute window
    maxRequests: 3,          // 3 reviews per PR per 10 mins
  },
  // GitHub API — protects against hitting GitHub rate limits
  GITHUB_API: {
    windowSeconds: 3600,    // 1 hour window
    maxRequests: 4500,       // GitHub allows 5000/hr — stay under limit
  },
} as const;

export type RateLimitScope = keyof typeof RATE_LIMITS;

// ============================================================
// Rate limit check result
// ============================================================
export interface RateLimitResult {
  allowed: boolean;
  scope: RateLimitScope;
  key: string;
  current: number;
  limit: number;
  windowSeconds: number;
  retryAfterSeconds: number | null;
  resetAt: string | null;
}

// ============================================================
// Main rate limit checker
// Called by webhook handler before starting Step Functions
// ============================================================
export async function checkRateLimits(params: {
  repo: string;
  prNumber: number;
  sender: string;
}): Promise<RateLimitResult[]> {

  const checks = await Promise.all([
    checkLimit('REPO',  `repo:${params.repo}`),
    checkLimit('USER',  `user:${params.sender}`),
    checkLimit('PR',    `pr:${params.repo}:${params.prNumber}`),
  ]);

  // Log any rate limit hits
  checks
    .filter((r) => !r.allowed)
    .forEach((r) => logRateLimitHit(r, params));

  return checks;
}

// Check if any rate limit is exceeded
export function isRateLimited(results: RateLimitResult[]): boolean {
  return results.some((r) => !r.allowed);
}

// Get the most restrictive exceeded limit for error messaging
export function getBlockingLimit(results: RateLimitResult[]): RateLimitResult | null {
  return results.find((r) => !r.allowed) || null;
}

// ============================================================
// Increment counters after successful pipeline start
// Called after Step Functions execution begins
// ============================================================
export async function incrementRateLimitCounters(params: {
  repo: string;
  prNumber: number;
  sender: string;
}): Promise<void> {
  await Promise.all([
    incrementCounter('REPO', `repo:${params.repo}`),
    incrementCounter('USER', `user:${params.sender}`),
    incrementCounter('PR',   `pr:${params.repo}:${params.prNumber}`),
  ]);
}

// ============================================================
// GitHub API rate limit tracker
// Incremented by GitHub MCP client on every API call.
// The counter is a single global key — there is no per-session scoping,
// so no sessionId is required.
// ============================================================
export async function checkGitHubAPILimit(): Promise<RateLimitResult> {
  return checkLimit('GITHUB_API', 'github:api:global');
}

export async function incrementGitHubAPICounter(): Promise<void> {
  await incrementCounter('GITHUB_API', 'github:api:global');
}

// ============================================================
// Core DynamoDB rate limit operations
// ============================================================
async function checkLimit(
  scope: RateLimitScope,
  key: string
): Promise<RateLimitResult> {

  const config = RATE_LIMITS[scope];
  const windowStart = Math.floor(Date.now() / 1000) - config.windowSeconds;
  const now = Math.floor(Date.now() / 1000);
  const resetAt = new Date((now + config.windowSeconds) * 1000).toISOString();

  try {
    const response = await dynamo.send(new GetItemCommand({
      TableName: RATE_LIMIT_TABLE,
      Key: {
        rate_limit_key: { S: key },
        window_start:   { N: String(windowStart) },
      },
    }));

    const current = parseInt(response.Item?.request_count?.N || '0', 10);
    const allowed = current < config.maxRequests;

    return {
      allowed,
      scope,
      key,
      current,
      limit: config.maxRequests,
      windowSeconds: config.windowSeconds,
      retryAfterSeconds: allowed ? null : config.windowSeconds - (now - windowStart),
      resetAt: allowed ? null : resetAt,
    };

  } catch {
    // On DynamoDB error — allow the request (fail open)
    // Prevents rate limit system from blocking all reviews on infrastructure failure
    console.warn(JSON.stringify({
      level: 'WARN',
      service: 'rate-limiter',
      message: 'DynamoDB error — failing open',
      key,
      scope,
      timestamp: new Date().toISOString(),
    }));

    return {
      allowed: true,
      scope,
      key,
      current: 0,
      limit: config.maxRequests,
      windowSeconds: config.windowSeconds,
      retryAfterSeconds: null,
      resetAt: null,
    };
  }
}

async function incrementCounter(
  scope: RateLimitScope,
  key: string
): Promise<void> {

  const config = RATE_LIMITS[scope];
  const windowStart = Math.floor(Date.now() / 1000) - config.windowSeconds;
  const ttl = Math.floor(Date.now() / 1000) + config.windowSeconds;

  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: RATE_LIMIT_TABLE,
      Key: {
        rate_limit_key: { S: key },
        window_start:   { N: String(windowStart) },
      },
      UpdateExpression: 'ADD request_count :inc SET #ttl = :ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':inc': { N: '1' },
        ':ttl': { N: String(ttl) },
      },
    }));
  } catch (error) {
    // Non-fatal — log and continue
    console.error(JSON.stringify({
      level: 'ERROR',
      service: 'rate-limiter',
      message: 'Failed to increment rate limit counter',
      key,
      scope,
      error: error instanceof Error ? error.message : 'Unknown',
      timestamp: new Date().toISOString(),
    }));
  }
}

// ============================================================
// Rate limit exceeded response builder
// ============================================================
export function buildRateLimitResponse(limit: RateLimitResult): {
  statusCode: number;
  message: string;
  retryAfterSeconds: number | null;
} {
  const scopeMessages: Record<RateLimitScope, string> = {
    REPO:       `Repository review limit reached (${limit.limit} reviews per hour)`,
    USER:       `User command limit reached (${limit.limit} commands per 5 minutes)`,
    PR:         `PR review limit reached (${limit.limit} reviews per 10 minutes)`,
    GITHUB_API: `GitHub API rate limit approaching — try again shortly`,
  };

  return {
    statusCode: 429,
    message: scopeMessages[limit.scope],
    retryAfterSeconds: limit.retryAfterSeconds,
  };
}

// ============================================================
// Exponential backoff for GitHub API retries
// Used by GitHub MCP client on 429 or 503 responses
// ============================================================
export function calculateBackoff(attempt: number, baseMs = 2000): number {
  const jitter = Math.random() * 1000;
  return Math.min(baseMs * Math.pow(2, attempt) + jitter, 30000);
}

// ============================================================
// CloudWatch logging
// ============================================================
function logRateLimitHit(
  result: RateLimitResult,
  params: { repo: string; prNumber: number; sender: string }
): void {
  console.warn(JSON.stringify({
    level: 'WARN',
    service: 'rate-limiter',
    message: 'Rate limit exceeded',
    scope: result.scope,
    key: result.key,
    current: result.current,
    limit: result.limit,
    retryAfterSeconds: result.retryAfterSeconds,
    repo: params.repo,
    prNumber: params.prNumber,
    sender: params.sender,
    timestamp: new Date().toISOString(),
  }));
}