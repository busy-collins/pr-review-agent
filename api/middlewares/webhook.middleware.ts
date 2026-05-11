import { createHmac, timingSafeEqual } from 'crypto';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// ============================================================
// Webhook Verification Middleware
// Verifies every incoming GitHub webhook before processing
// Runs before any agent logic — no exceptions
// ============================================================

// Supported GitHub webhook event types per CLAUDE.md
export const ALLOWED_EVENTS = [
  'pull_request',
  'issue_comment',
] as const;

export type AllowedEvent = typeof ALLOWED_EVENTS[number];

// PR actions that trigger a full review
export const REVIEW_TRIGGER_ACTIONS = [
  'opened',
  'synchronize',
  'reopened',
] as const;

// ============================================================
// Main verification function
// Called as the first step in the Lambda webhook handler
// ============================================================
export interface VerificationResult {
  valid: boolean;
  event: string | null;
  action: string | null;
  shouldProcess: boolean;
  skipReason: string | null;
  payload: GitHubWebhookPayload | null;
  error: string | null;
}

export async function verifyAndParseWebhook(
  event: APIGatewayProxyEvent
): Promise<VerificationResult> {

  // Step 1 — Extract required headers (case-insensitive — API Gateway v1
  // preserves client casing, and GitHub sends mixed-case header names)
  const signature = getHeader(event.headers, 'x-hub-signature-256');
  const githubEvent = getHeader(event.headers, 'x-github-event');
  const deliveryId = getHeader(event.headers, 'x-github-delivery');

  if (!signature || !githubEvent || !deliveryId) {
    return buildResult(false, null, null, false,
      'Missing required GitHub webhook headers', null,
      'Missing x-hub-signature-256, x-github-event, or x-github-delivery'
    );
  }

  // Step 2 — Verify HMAC signature against the raw request body.
  // API Gateway may deliver the body base64-encoded; GitHub signs the raw
  // bytes, so decode before HMAC and JSON parsing.
  const body = event.isBase64Encoded && event.body
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body || '';
  const signatureValid = verifySignature(body, signature);

  if (!signatureValid) {
    return buildResult(false, githubEvent, null, false,
      'Invalid webhook signature', null,
      'HMAC-SHA256 signature verification failed'
    );
  }

  // Step 3 — Parse body
  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(body) as GitHubWebhookPayload;
  } catch {
    return buildResult(false, githubEvent, null, false,
      'Invalid JSON payload', null,
      'Failed to parse webhook body as JSON'
    );
  }

  const action = payload.action || null;

  // Step 4 — Check event type is allowed
  if (!ALLOWED_EVENTS.includes(githubEvent as AllowedEvent)) {
    return buildResult(true, githubEvent, action, false,
      `Event type '${githubEvent}' is not monitored`, payload, null
    );
  }

  // Step 5 — Filter pull_request events by action
  if (githubEvent === 'pull_request') {
    if (!REVIEW_TRIGGER_ACTIONS.includes(action as typeof REVIEW_TRIGGER_ACTIONS[number])) {
      return buildResult(true, githubEvent, action, false,
        `PR action '${action}' does not trigger a review`, payload, null
      );
    }
  }

  // Step 6 — Filter issue_comment events — only slash commands
  if (githubEvent === 'issue_comment') {
    if (action !== 'created') {
      return buildResult(true, githubEvent, action, false,
        'Only new comments are processed', payload, null
      );
    }

    // Must be on a pull request
    if (!payload.issue?.pull_request) {
      return buildResult(true, githubEvent, action, false,
        'Comment is not on a pull request', payload, null
      );
    }

    // Must start with /review to be a slash command
    const commentBody = payload.comment?.body || '';
    if (!commentBody.trim().startsWith('/review')) {
      return buildResult(true, githubEvent, action, false,
        'Comment is not a slash command', payload, null
      );
    }
  }

  // All checks passed — process this webhook
  return buildResult(true, githubEvent, action, true, null, payload, null);
}

// ============================================================
// HMAC-SHA256 signature verification
// Uses timing-safe comparison to prevent timing attacks
// ============================================================
function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    console.error(JSON.stringify({
      level: 'ERROR',
      service: 'webhook-middleware',
      message: 'GITHUB_WEBHOOK_SECRET environment variable is not set',
      timestamp: new Date().toISOString(),
    }));
    return false;
  }

  try {
    const expectedSignature = `sha256=${
      createHmac('sha256', secret)
        .update(body, 'utf8')
        .digest('hex')
    }`;

    const sigBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    // Buffers must be same length for timingSafeEqual
    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);

  } catch {
    return false;
  }
}

// ============================================================
// Build API Gateway response for rejected webhooks
// ============================================================
export function buildWebhookResponse(
  statusCode: number,
  message: string,
  data?: Record<string, unknown>
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      timestamp: new Date().toISOString(),
      ...data,
    }),
  };
}

// ============================================================
// GitHub webhook payload types
// ============================================================
export interface GitHubWebhookPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number: number;
    title: string;
    html_url: string;
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
    user: { login: string };
    diff_url: string;
    additions: number;
    deletions: number;
    changed_files: number;
  };
  issue?: {
    number: number;
    pull_request?: { url: string };
  };
  comment?: {
    id: number;
    body: string;
    user: { login: string };
  };
  repository?: {
    full_name: string;
    default_branch: string;
  };
  sender?: {
    login: string;
  };
  installation?: {
    id: number;
  };
}

// ============================================================
// Case-insensitive header lookup. API Gateway REST (v1) preserves
// the client's header casing, so we can't rely on a fixed case.
// ============================================================
function getHeader(
  headers: APIGatewayProxyEvent['headers'],
  name: string
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key] ?? undefined;
    }
  }
  return undefined;
}

// ============================================================
// Helper to build consistent VerificationResult objects
// ============================================================
function buildResult(
  valid: boolean,
  event: string | null,
  action: string | null,
  shouldProcess: boolean,
  skipReason: string | null,
  payload: GitHubWebhookPayload | null,
  error: string | null
): VerificationResult {
  return { valid, event, action, shouldProcess, skipReason, payload, error };
}