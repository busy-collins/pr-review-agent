import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  verifyAndParseWebhook,
  buildWebhookResponse,
} from '../../api/middlewares/webhook.middleware';

// ============================================================
// Webhook middleware tests — covers the real HMAC chain.
// We compute valid signatures in-test rather than mocking the
// crypto module, so regressions in the signature scheme actually
// fail here.
// ============================================================

const SECRET = 'test-webhook-secret-do-not-use-in-prod';

function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function buildEvent(opts: {
  body: string;
  signature?: string;
  event?: string;
  delivery?: string;
  isBase64Encoded?: boolean;
  /** Use mixed-case header names (GitHub sends "X-Hub-Signature-256"). */
  mixedCaseHeaders?: boolean;
}): APIGatewayProxyEvent {
  const sigKey = opts.mixedCaseHeaders ? 'X-Hub-Signature-256' : 'x-hub-signature-256';
  const evtKey = opts.mixedCaseHeaders ? 'X-GitHub-Event' : 'x-github-event';
  const delKey = opts.mixedCaseHeaders ? 'X-GitHub-Delivery' : 'x-github-delivery';

  return {
    body: opts.body,
    isBase64Encoded: opts.isBase64Encoded ?? false,
    headers: {
      [sigKey]: opts.signature ?? sign(opts.body),
      [evtKey]: opts.event ?? 'pull_request',
      [delKey]: opts.delivery ?? 'delivery-abc-123',
    },
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

const validPullRequestBody = JSON.stringify({
  action: 'opened',
  pull_request: { number: 42 },
  repository: { full_name: 'myorg/myrepo' },
  sender: { login: 'octocat' },
});

beforeEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

describe('verifyAndParseWebhook — header handling', () => {
  it('accepts mixed-case header names (GitHub sends "X-Hub-Signature-256")', async () => {
    const result = await verifyAndParseWebhook(
      buildEvent({ body: validPullRequestBody, mixedCaseHeaders: true })
    );
    expect(result.valid).toBe(true);
    expect(result.event).toBe('pull_request');
  });

  it('rejects with 401-equivalent when required headers are missing', async () => {
    const event = buildEvent({ body: validPullRequestBody });
    delete event.headers['x-hub-signature-256'];
    const result = await verifyAndParseWebhook(event);
    expect(result.valid).toBe(false);
    expect(result.skipReason).toMatch(/Missing/);
  });
});

describe('verifyAndParseWebhook — signature verification', () => {
  it('rejects a signature computed with the wrong secret', async () => {
    const result = await verifyAndParseWebhook(
      buildEvent({
        body: validPullRequestBody,
        signature: sign(validPullRequestBody, 'wrong-secret'),
      })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/HMAC/);
  });

  it('rejects a signature whose digest is the right length but wrong bytes', async () => {
    const result = await verifyAndParseWebhook(
      buildEvent({
        body: validPullRequestBody,
        signature: `sha256=${'0'.repeat(64)}`,
      })
    );
    expect(result.valid).toBe(false);
  });

  it('returns valid=false (not throwing) when GITHUB_WEBHOOK_SECRET is unset', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const result = await verifyAndParseWebhook(
      buildEvent({ body: validPullRequestBody })
    );
    expect(result.valid).toBe(false);
  });
});

describe('verifyAndParseWebhook — body decoding', () => {
  it('decodes a base64-encoded body before computing the HMAC', async () => {
    const rawBody = validPullRequestBody;
    const event = buildEvent({
      body: Buffer.from(rawBody, 'utf8').toString('base64'),
      isBase64Encoded: true,
      signature: sign(rawBody),
    });
    const result = await verifyAndParseWebhook(event);
    expect(result.valid).toBe(true);
  });

  it('reports invalid JSON as an explicit parse failure, not a signature failure', async () => {
    const garbage = 'not-json-at-all';
    const result = await verifyAndParseWebhook(
      buildEvent({ body: garbage, signature: sign(garbage) })
    );
    expect(result.valid).toBe(false);
    expect(result.skipReason).toMatch(/JSON/);
  });
});

describe('verifyAndParseWebhook — eligibility filters', () => {
  it('acks-but-skips for events outside the allowed list', async () => {
    const body = JSON.stringify({ action: 'created' });
    const result = await verifyAndParseWebhook(
      buildEvent({ body, event: 'star', signature: sign(body) })
    );
    expect(result.valid).toBe(true);
    expect(result.shouldProcess).toBe(false);
    expect(result.skipReason).toMatch(/not monitored/);
  });

  it('acks-but-skips for pull_request actions that do not trigger a review', async () => {
    const body = JSON.stringify({ action: 'labeled' });
    const result = await verifyAndParseWebhook(
      buildEvent({ body, signature: sign(body) })
    );
    expect(result.valid).toBe(true);
    expect(result.shouldProcess).toBe(false);
  });

  it('acks-but-skips issue_comment events whose body is not a slash command', async () => {
    const body = JSON.stringify({
      action: 'created',
      issue: { number: 1, pull_request: { url: 'x' } },
      comment: { id: 1, body: 'just a regular comment', user: { login: 'a' } },
    });
    const result = await verifyAndParseWebhook(
      buildEvent({ body, event: 'issue_comment', signature: sign(body) })
    );
    expect(result.valid).toBe(true);
    expect(result.shouldProcess).toBe(false);
    expect(result.skipReason).toMatch(/slash command/);
  });

  it('acks-but-skips issue_comment events on issues that are not PRs', async () => {
    const body = JSON.stringify({
      action: 'created',
      issue: { number: 1 }, // no .pull_request
      comment: { id: 1, body: '/review full', user: { login: 'a' } },
    });
    const result = await verifyAndParseWebhook(
      buildEvent({ body, event: 'issue_comment', signature: sign(body) })
    );
    expect(result.valid).toBe(true);
    expect(result.shouldProcess).toBe(false);
    expect(result.skipReason).toMatch(/not on a pull request/);
  });

  it('processes a /review slash command on an open PR', async () => {
    const body = JSON.stringify({
      action: 'created',
      issue: { number: 1, pull_request: { url: 'x' } },
      comment: { id: 1, body: '/review security', user: { login: 'a' } },
    });
    const result = await verifyAndParseWebhook(
      buildEvent({ body, event: 'issue_comment', signature: sign(body) })
    );
    expect(result.valid).toBe(true);
    expect(result.shouldProcess).toBe(true);
  });
});

describe('buildWebhookResponse', () => {
  it('returns the right shape for API Gateway', () => {
    const r = buildWebhookResponse(200, 'ok');
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(r.body);
    expect(body.message).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
  });

  it('merges extra data fields into the body', () => {
    const r = buildWebhookResponse(429, 'rate limited', { retryAfterSeconds: 30 });
    expect(JSON.parse(r.body)).toMatchObject({
      message: 'rate limited',
      retryAfterSeconds: 30,
    });
  });
});
