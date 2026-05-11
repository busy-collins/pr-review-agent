import type {
  APIGatewayProxyEvent,
  APIGatewayProxyHandler,
  APIGatewayProxyResult,
} from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  buildWebhookResponse,
  verifyAndParseWebhook,
  type GitHubWebhookPayload,
  type VerificationResult,
} from '../middlewares/webhook.middleware';
import {
  COMMAND_ACKNOWLEDGEMENTS,
  parseSlashCommand,
  SLASH_COMMANDS,
  UNKNOWN_COMMAND_HELP,
  type SlashCommand,
} from '../slash-commands/slash.command.parser';
import {
  buildRateLimitResponse,
  checkRateLimits,
  getBlockingLimit,
  incrementRateLimitCounters,
  isRateLimited,
} from '../rate-limiting/rate.limiter';
import { log } from '../../shared/logger';
import type { OrchestratorWebhookEvent } from '../../shared/types';

// The parser's SlashCommand includes `/review approve` and `/review status`,
// which are short-circuited before we reach Step Functions. The orchestrator
// only accepts review-triggering commands; this alias enforces that statically.
type ReviewTriggerCommand = Exclude<
  SlashCommand,
  '/review status' | '/review approve'
>;

// ============================================================
// Webhook Lambda — API Gateway entry point.
// Runs in the request thread, so everything here is fast:
// verify → parse → rate-limit → start Step Functions → return.
// The actual review happens asynchronously in the state machine.
// ============================================================

const sfnClient = new SFNClient(
  process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}
);

function getStateMachineArn(): string {
  if (process.env.STATE_MACHINE_ARN) return process.env.STATE_MACHINE_ARN;
  const region = process.env.AWS_REGION;
  const account = process.env.AWS_ACCOUNT_ID;
  const env = process.env.APP_ENV;
  if (!region || !account || !env) {
    throw new Error(
      'Missing required env: STATE_MACHINE_ARN or AWS_REGION + AWS_ACCOUNT_ID + APP_ENV'
    );
  }
  return `arn:aws:states:${region}:${account}:stateMachine:pr-review-pipeline-${env}`;
}

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    return await handleWebhook(event);
  } catch (error) {
    log('ERROR', 'webhook', 'Unhandled webhook error', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return buildWebhookResponse(500, 'Internal server error');
  }
};

async function handleWebhook(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  // Step 1 — verify signature + structural eligibility
  const verification = await verifyAndParseWebhook(event);

  if (!verification.valid) {
    log('WARN', 'webhook', 'Webhook rejected', {
      reason: verification.skipReason ?? 'invalid',
      error: verification.error ?? undefined,
    });
    return buildWebhookResponse(401, verification.skipReason ?? 'Unauthorized');
  }

  if (!verification.shouldProcess) {
    // Valid signature, but the event/action is not one we review.
    // 200 with a skip note so GitHub doesn't retry.
    log('INFO', 'webhook', 'Webhook acknowledged but skipped', {
      event: verification.event ?? undefined,
      action: verification.action ?? undefined,
      reason: verification.skipReason ?? undefined,
    });
    return buildWebhookResponse(200, verification.skipReason ?? 'Skipped');
  }

  if (!verification.payload) {
    return buildWebhookResponse(400, 'Missing webhook payload');
  }

  // Step 2 — extract identifying fields used by rate limits + Step Functions
  const identity = extractIdentity(verification);
  if (!identity) {
    return buildWebhookResponse(400, 'Webhook payload missing required fields');
  }

  // Step 3 — rate limit check (per-repo, per-user, per-PR)
  const limits = await checkRateLimits({
    repo: identity.repo,
    prNumber: identity.prNumber,
    sender: identity.sender,
  });
  if (isRateLimited(limits)) {
    const blocking = getBlockingLimit(limits);
    if (blocking) {
      const resp = buildRateLimitResponse(blocking);
      return buildWebhookResponse(resp.statusCode, resp.message, {
        retryAfterSeconds: resp.retryAfterSeconds,
      });
    }
  }

  // Step 4 — slash command handling for issue_comment events. Only the
  // four commands that drive a Step Functions execution can land in
  // `slashCommand`; STATUS/APPROVE are handled with early returns below.
  let slashCommand: ReviewTriggerCommand | null = null;
  if (verification.event === 'issue_comment') {
    const parsed = parseSlashCommand({
      commentBody: verification.payload.comment?.body ?? '',
      triggeredBy: identity.sender,
      repo: identity.repo,
      prNumber: identity.prNumber,
    });

    if (!parsed.valid) {
      // Acknowledge but don't trigger a review; GitHub still got a 200.
      log('INFO', 'webhook', 'Unrecognized slash command', {
        repo: identity.repo,
        prNumber: identity.prNumber,
      });
      return buildWebhookResponse(200, UNKNOWN_COMMAND_HELP);
    }

    // Commands that don't trigger a Step Functions execution
    if (
      parsed.command === SLASH_COMMANDS.STATUS ||
      parsed.command === SLASH_COMMANDS.APPROVE
    ) {
      log('INFO', 'webhook', 'Non-review slash command acknowledged', {
        command: parsed.command,
        repo: identity.repo,
        prNumber: identity.prNumber,
      });
      return buildWebhookResponse(
        200,
        parsed.command ? COMMAND_ACKNOWLEDGEMENTS[parsed.command] : 'OK'
      );
    }

    // After the STATUS/APPROVE short-circuits above, only review-triggering
    // commands remain. Cast safely after that narrowing.
    slashCommand = parsed.command as ReviewTriggerCommand;
  }

  // Step 5 — build OrchestratorWebhookEvent and start Step Functions
  const orchestratorEvent = buildOrchestratorEvent(
    verification,
    identity,
    slashCommand
  );

  const stateMachineArn = getStateMachineArn();
  const executionName = buildExecutionName(identity);

  try {
    await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: executionName,
        input: JSON.stringify(orchestratorEvent),
      })
    );
  } catch (error) {
    log('ERROR', 'webhook', 'Failed to start Step Functions execution', {
      repo: identity.repo,
      prNumber: identity.prNumber,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return buildWebhookResponse(500, 'Failed to start review pipeline');
  }

  // Step 6 — increment rate-limit counters only after successful start
  await incrementRateLimitCounters({
    repo: identity.repo,
    prNumber: identity.prNumber,
    sender: identity.sender,
  });

  log('INFO', 'webhook', 'Review pipeline started', {
    repo: identity.repo,
    prNumber: identity.prNumber,
    sender: identity.sender,
    executionName,
    eventType: orchestratorEvent.event_type,
    slashCommand: slashCommand ?? undefined,
  });

  // For slash-triggered runs, return the acknowledgement so GitHub can show it.
  // For automatic runs, a brief OK is enough.
  const responseBody = slashCommand
    ? COMMAND_ACKNOWLEDGEMENTS[slashCommand]
    : 'Review pipeline started';
  return buildWebhookResponse(200, responseBody, { executionName });
}

// ============================================================
// Identifying-field extraction. We need (repo, pr_number, sender)
// for rate limiting and the orchestrator payload — both event
// types expose these though under different sub-objects.
// ============================================================
interface Identity {
  repo: string;
  prNumber: number;
  sender: string;
  prUrl: string;
}

function extractIdentity(verification: VerificationResult): Identity | null {
  const p = verification.payload;
  if (!p) return null;

  const repo = p.repository?.full_name;
  const sender = p.sender?.login;
  if (!repo || !sender) return null;

  if (verification.event === 'pull_request' && p.pull_request) {
    return {
      repo,
      sender,
      prNumber: p.pull_request.number,
      prUrl: p.pull_request.html_url,
    };
  }

  if (verification.event === 'issue_comment' && p.issue) {
    return {
      repo,
      sender,
      prNumber: p.issue.number,
      // Comment payload doesn't include the PR's html_url; derive it.
      prUrl: `https://github.com/${repo}/pull/${p.issue.number}`,
    };
  }

  return null;
}

// ============================================================
// Orchestrator payload builder. Pull-request events carry the full
// PR data; issue_comment events carry only the comment + issue ref,
// so head/base branches are unknown until the orchestrator fetches
// the diff. We pass empty strings in that case — downstream uses
// them for display only.
// ============================================================
function buildOrchestratorEvent(
  verification: VerificationResult,
  identity: Identity,
  slashCommand: ReviewTriggerCommand | null
): OrchestratorWebhookEvent {
  const payload = verification.payload as GitHubWebhookPayload;
  const eventType = `${verification.event}.${verification.action}` as
    | 'pull_request.opened'
    | 'pull_request.synchronize'
    | 'pull_request.reopened'
    | 'issue_comment.created';

  if (verification.event === 'pull_request' && payload.pull_request) {
    return {
      event_type: eventType,
      pr_number: identity.prNumber,
      repo: identity.repo,
      sender: identity.sender,
      diff_url: payload.pull_request.diff_url,
      diff_line_count:
        payload.pull_request.additions + payload.pull_request.deletions,
      base_branch: payload.pull_request.base.ref,
      head_branch: payload.pull_request.head.ref,
      slash_command: slashCommand,
      timestamp: new Date().toISOString(),
      pr_url: identity.prUrl,
    };
  }

  // issue_comment branch
  return {
    event_type: eventType,
    pr_number: identity.prNumber,
    repo: identity.repo,
    sender: identity.sender,
    diff_url: '',
    base_branch: '',
    head_branch: '',
    slash_command: slashCommand,
    timestamp: new Date().toISOString(),
    pr_url: identity.prUrl,
  };
}

// ============================================================
// Step Functions execution names must match
// [a-zA-Z0-9_-]{1,80} and be unique per state machine.
// ============================================================
function buildExecutionName(identity: Identity): string {
  const ts = Date.now();
  const safeRepo = identity.repo.replace(/[^a-zA-Z0-9_-]/g, '-');
  const name = `pr-${safeRepo}-${identity.prNumber}-${ts}`;
  // Truncate to 80 chars while preserving the trailing timestamp for uniqueness
  if (name.length <= 80) return name;
  const tail = `-${identity.prNumber}-${ts}`;
  const headLen = 80 - tail.length;
  return `${name.slice(0, headLen)}${tail}`.slice(0, 80);
}
