import { Anthropic } from '@anthropic-ai/sdk';

// ============================================================
// Slack MCP Client
// Used exclusively for escalation notifications per CLAUDE.md
// ============================================================

const client = new Anthropic();

// Permitted Slack MCP operations — escalation only
export const SLACK_MCP_OPERATIONS = {
  POST_MESSAGE:    'slack_post_message',
  POST_THREAD:     'slack_reply_to_thread',
  ADD_REACTION:    'slack_add_reaction',
} as const;

export type SlackOperation = typeof SLACK_MCP_OPERATIONS[keyof typeof SLACK_MCP_OPERATIONS];

// ============================================================
// Slack MCP Configuration
// ============================================================
export const slackMCPConfig = {
  type: 'url' as const,
  url: 'https://slack.com/api/mcp',
  name: 'slack-mcp',
  // Anthropic MCP connector accepts only `authorization_token`;
  // the API forwards it as `Authorization: Bearer <token>`.
  authorization_token: process.env.SLACK_BOT_TOKEN ?? '',
};

// ============================================================
// Escalation reason definitions
// Maps pipeline verdict to human-readable Slack message
// ============================================================
export const ESCALATION_REASONS = {
  LOW_CONFIDENCE:       'Agent confidence score fell below threshold after 3 Ralph loop iterations',
  AUTH_LOGIC_CHANGE:    'PR modifies authentication or authorization logic',
  PAYMENT_LOGIC_CHANGE: 'PR modifies payment processing logic',
  SCHEMA_MIGRATION:     'PR contains database schema migrations',
  DIFF_TOO_LARGE:       'PR diff exceeds 3,000 lines — partial review only',
  CRITICAL_FINDING:     'Security agent found one or more CRITICAL severity vulnerabilities',
} as const;

export type EscalationReason = keyof typeof ESCALATION_REASONS;

// ============================================================
// Core Slack MCP caller
// ============================================================
async function callSlackMCP(
  operation: SlackOperation,
  params: Record<string, unknown>,
  sessionId: string
): Promise<unknown> {

  const startTime = Date.now();

  try {
    // Cast: the create() overload returns BetaMessage | Stream depending on
    // whether `stream: true` is set. We don't stream here, so narrow to the
    // non-streaming BetaMessage so `.content` is properly typed.
    const response = await client.beta.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      // Same reasoning as GitHub MCP — keep budget high enough for
      // Claude to emit large mcp_tool_use args (escalation summaries).
      max_tokens: 16384,
      mcp_servers: [slackMCPConfig],
      // MCP connector is opt-in via this beta flag; without it the API
      // rejects `mcp_servers` as "Extra inputs are not permitted".
      betas: ['mcp-client-2025-04-04'],
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ operation, params }),
        },
      ],
    } as Parameters<typeof client.beta.messages.create>[0]) as Anthropic.Beta.Messages.BetaMessage;

    const toolResult = response.content.find(
      (block) => block.type === 'mcp_tool_result'
    );

    if (!toolResult) {
      throw new SlackMCPError(
        `No tool result for operation: ${operation}`,
        operation,
        sessionId
      );
    }

    logSlackCall({ sessionId, operation, durationMs: Date.now() - startTime, success: true });
    return toolResult;

  } catch (error) {
    logSlackCall({
      sessionId,
      operation,
      durationMs: Date.now() - startTime,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

// ============================================================
// Named Slack operations
// ============================================================

// Primary escalation notification — used by Orchestrator
export async function postEscalationNotification(params: {
  sessionId: string;
  repo: string;
  prNumber: number;
  sender: string;
  reason: EscalationReason;
  prUrl: string;
  confidenceScore?: number;
}): Promise<{ ts: string; channel: string }> {

  const channel = process.env.SLACK_ESCALATION_CHANNEL || '#pr-review-escalations';
  const reasonText = ESCALATION_REASONS[params.reason];

  const message = buildEscalationMessage(params, reasonText);

  const result = await callSlackMCP(
    SLACK_MCP_OPERATIONS.POST_MESSAGE,
    { channel, text: message, unfurl_links: false },
    params.sessionId
  );

  return result as { ts: string; channel: string };
}

// Post size warning when diff exceeds 3000 lines
export async function postSizeWarningNotification(params: {
  sessionId: string;
  repo: string;
  prNumber: number;
  diffLineCount: number;
  prUrl: string;
}): Promise<void> {

  const channel = process.env.SLACK_ESCALATION_CHANNEL || '#pr-review-escalations';

  const message = [
    `⚠️ *PR Too Large for Full Review*`,
    `*Repo:* \`${params.repo}\` | *PR:* #${params.prNumber}`,
    `*Diff size:* ${params.diffLineCount.toLocaleString()} lines (limit: 3,000)`,
    `*Action:* Size warning posted to PR. Manual review required.`,
    `*PR:* ${params.prUrl}`,
    `_Session: \`${params.sessionId}\`_`,
  ].join('\n');

  await callSlackMCP(
    SLACK_MCP_OPERATIONS.POST_MESSAGE,
    { channel, text: message },
    params.sessionId
  );
}

// Thread reply for additional context on escalation
export async function postEscalationThreadReply(params: {
  sessionId: string;
  threadTs: string;
  channel: string;
  additionalContext: string;
}): Promise<void> {
  await callSlackMCP(
    SLACK_MCP_OPERATIONS.POST_THREAD,
    {
      channel: params.channel,
      thread_ts: params.threadTs,
      text: params.additionalContext,
    },
    params.sessionId
  );
}

// ============================================================
// Escalation message builder
// Follows SKILL-comment-formatter.md tone rules
// ============================================================
function buildEscalationMessage(
  params: {
    sessionId: string;
    repo: string;
    prNumber: number;
    sender: string;
    prUrl: string;
    confidenceScore?: number;
  },
  reasonText: string
): string {

  const confidenceLine = params.confidenceScore !== undefined
    ? `*Confidence score:* \`${params.confidenceScore.toFixed(2)}\``
    : '';

  return [
    `🚨 *PR Review Escalation — Human Review Required*`,
    ``,
    `*Repo:* \`${params.repo}\` | *PR:* #${params.prNumber} | *Author:* @${params.sender}`,
    `*Reason:* ${reasonText}`,
    confidenceLine,
    ``,
    `*Action required:* Please review this PR manually before approving.`,
    `*PR link:* ${params.prUrl}`,
    ``,
    `_Session: \`${params.sessionId}\` | PR Review Agent_`,
  ].filter(Boolean).join('\n');
}

// ============================================================
// Error class for Slack MCP failures
// ============================================================
export class SlackMCPError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly sessionId: string
  ) {
    super(message);
    this.name = 'SlackMCPError';
  }
}

// ============================================================
// CloudWatch logging for every Slack MCP call
// ============================================================
interface SlackCallLog {
  sessionId: string;
  operation: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

function logSlackCall(log: SlackCallLog): void {
  console.log(JSON.stringify({
    level: log.success ? 'INFO' : 'ERROR',
    service: 'slack-mcp-client',
    ...log,
    timestamp: new Date().toISOString(),
  }));
}