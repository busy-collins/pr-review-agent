// ============================================================
// Slash Command Parser
// Parses and validates all /review commands from PR comments
// All commands defined in CLAUDE.md and PLAN.md
// ============================================================

// All valid slash commands
export const SLASH_COMMANDS = {
  FULL:     '/review full',
  SECURITY: '/review security',
  STYLE:    '/review style',
  STATUS:   '/review status',
  RESET:    '/review reset',
  APPROVE:  '/review approve',
} as const;

export type SlashCommand = typeof SLASH_COMMANDS[keyof typeof SLASH_COMMANDS];

// What each command triggers in Step Functions
export const COMMAND_ACTIONS: Record<SlashCommand, CommandAction> = {
  '/review full':     { subagents: ['security', 'style'], resetSession: false, statusOnly: false },
  '/review security': { subagents: ['security'],          resetSession: false, statusOnly: false },
  '/review style':    { subagents: ['style'],             resetSession: false, statusOnly: false },
  '/review status':   { subagents: [],                    resetSession: false, statusOnly: true  },
  '/review reset':    { subagents: ['security', 'style'], resetSession: true,  statusOnly: false },
  '/review approve':  { subagents: [],                    resetSession: false, statusOnly: false },
};

export interface CommandAction {
  subagents: Array<'security' | 'style'>;
  resetSession: boolean;
  statusOnly: boolean;
}

// ============================================================
// Parse result returned to webhook handler
// ============================================================
export interface ParsedCommand {
  valid: boolean;
  command: SlashCommand | null;
  action: CommandAction | null;
  rawInput: string;
  error: string | null;
  triggeredBy: string;
  repo: string;
  prNumber: number;
}

// ============================================================
// Main parser — called by webhook handler for issue_comment events
// ============================================================
export function parseSlashCommand(params: {
  commentBody: string;
  triggeredBy: string;
  repo: string;
  prNumber: number;
}): ParsedCommand {

  const raw = params.commentBody.trim().toLowerCase();

  // Must start with /review
  if (!raw.startsWith('/review')) {
    return buildInvalid(params, 'Comment does not start with /review');
  }

  // Find matching command
  const matchedCommand = Object.values(SLASH_COMMANDS).find(
    (cmd) => raw === cmd || raw.startsWith(`${cmd} `)
  ) as SlashCommand | undefined;

  if (!matchedCommand) {
    return buildInvalid(
      params,
      `Unknown command: "${raw}". Valid commands: ${Object.values(SLASH_COMMANDS).join(', ')}`
    );
  }

  const action = COMMAND_ACTIONS[matchedCommand];

  logCommandParsed({
    command: matchedCommand,
    triggeredBy: params.triggeredBy,
    repo: params.repo,
    prNumber: params.prNumber,
  });

  return {
    valid: true,
    command: matchedCommand,
    action,
    rawInput: params.commentBody,
    error: null,
    triggeredBy: params.triggeredBy,
    repo: params.repo,
    prNumber: params.prNumber,
  };
}

// ============================================================
// Command response messages posted back to GitHub PR
// ============================================================
export const COMMAND_ACKNOWLEDGEMENTS: Record<SlashCommand, string> = {
  '/review full': [
    '🤖 **Full review triggered**',
    'Running Security and Style agents. Results will be posted when complete.',
    '_This comment will be updated with the review results._',
  ].join('\n'),

  '/review security': [
    '🔒 **Security review triggered**',
    'Running Security agent only. Results will be posted when complete.',
  ].join('\n'),

  '/review style': [
    '✨ **Style review triggered**',
    'Running Style agent only. Results will be posted when complete.',
  ].join('\n'),

  '/review status': [
    '📊 **Review status requested**',
    'Fetching current session status...',
  ].join('\n'),

  '/review reset': [
    '🔄 **Review reset triggered**',
    'Clearing previous session and running a fresh full review.',
    '_Previous review comment will be updated with new results._',
  ].join('\n'),

  '/review approve': [
    '✅ **Manual approval recorded**',
    'This PR has been manually approved by the review agent.',
  ].join('\n'),
};

// ============================================================
// Status response builder
// Called when /review status is triggered
// ============================================================
export function buildStatusResponse(params: {
  sessionId: string;
  stage: string;
  status: string;
  confidence?: number;
  iterationsUsed?: number;
}): string {
  const lines = [
    `📊 **Review Status**`,
    ``,
    `**Session:** \`${params.sessionId}\``,
    `**Stage:** ${params.stage}`,
    `**Status:** ${params.status}`,
  ];

  if (params.confidence !== undefined) {
    lines.push(`**Confidence:** \`${params.confidence.toFixed(2)}\``);
  }

  if (params.iterationsUsed !== undefined) {
    lines.push(`**Ralph loop iterations:** ${params.iterationsUsed}`);
  }

  return lines.join('\n');
}

// ============================================================
// Unknown command help message
// ============================================================
export const UNKNOWN_COMMAND_HELP = [
  '❓ **Unknown command**',
  '',
  'Available commands:',
  '- `/review full` — Run Security + Style agents',
  '- `/review security` — Run Security agent only',
  '- `/review style` — Run Style agent only',
  '- `/review status` — Show current review status',
  '- `/review reset` — Clear session and re-run full review',
].join('\n');

// ============================================================
// Helpers
// ============================================================
function buildInvalid(
  params: { commentBody: string; triggeredBy: string; repo: string; prNumber: number },
  error: string
): ParsedCommand {
  return {
    valid: false,
    command: null,
    action: null,
    rawInput: params.commentBody,
    error,
    triggeredBy: params.triggeredBy,
    repo: params.repo,
    prNumber: params.prNumber,
  };
}

function logCommandParsed(params: {
  command: string;
  triggeredBy: string;
  repo: string;
  prNumber: number;
}): void {
  console.log(JSON.stringify({
    level: 'INFO',
    service: 'slash-command-parser',
    message: 'Slash command parsed',
    ...params,
    timestamp: new Date().toISOString(),
  }));
}