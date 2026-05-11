import { Anthropic } from '@anthropic-ai/sdk';

// ============================================================
// GitHub MCP Client
// Wraps all GitHub API operations used across agents
// ============================================================

const client = new Anthropic();

// All permitted GitHub MCP operations per CLAUDE.md
export const GITHUB_MCP_OPERATIONS = {
  GET_PR:           'get_pull_request',
  GET_PR_DIFF:      'get_pull_request_diff',
  GET_PR_FILES:     'get_pull_request_files',
  POST_COMMENT:     'create_issue_comment',
  UPDATE_COMMENT:   'update_issue_comment',
  ADD_LABEL:        'add_labels_to_issue',
  REMOVE_LABEL:     'remove_label_from_issue',
  CREATE_STATUS:    'create_commit_status',
  LIST_COMMENTS:    'list_issue_comments',
} as const;

export type GitHubOperation = typeof GITHUB_MCP_OPERATIONS[keyof typeof GITHUB_MCP_OPERATIONS];

// ============================================================
// GitHub MCP Configuration
// ============================================================
export const githubMCPConfig = {
  type: 'url' as const,
  url: 'https://api.githubcopilot.com/mcp/',
  name: 'github-mcp',
  headers: {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  },
};

// ============================================================
// Core GitHub MCP caller
// All agents call this — never call GitHub API directly
// ============================================================
export async function callGitHubMCP(
  operation: GitHubOperation,
  params: Record<string, unknown>,
  sessionId: string
): Promise<unknown> {

  const startTime = Date.now();

  try {
    // Cast: create() returns BetaMessage | Stream depending on `stream`. We
    // don't stream, so narrow to BetaMessage for typed `.content` access.
    const response = await client.beta.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1000,
      mcp_servers: [githubMCPConfig],
      messages: [
        {
          role: 'user',
          content: JSON.stringify({ operation, params }),
        },
      ],
    } as Parameters<typeof client.beta.messages.create>[0]) as Anthropic.Beta.Messages.BetaMessage;

    // Extract MCP tool result from response
    const toolResult = response.content.find(
      (block) => block.type === 'mcp_tool_result'
    );

    if (!toolResult) {
      throw new GitHubMCPError(
        `No tool result returned for operation: ${operation}`,
        operation,
        sessionId
      );
    }

    logMCPCall({
      sessionId,
      operation,
      durationMs: Date.now() - startTime,
      success: true,
    });

    return toolResult;

  } catch (error) {
    logMCPCall({
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
// Named operations used by agents
// ============================================================

// Fetch PR metadata — used by Orchestrator
export async function getPullRequest(
  repo: string,
  prNumber: number,
  sessionId: string
) {
  const [owner, repoName] = repo.split('/');
  return callGitHubMCP(
    GITHUB_MCP_OPERATIONS.GET_PR,
    { owner, repo: repoName, pull_number: prNumber },
    sessionId
  );
}

// Fetch PR raw diff — used by Orchestrator to pass to SubAgents
export async function getPullRequestDiff(
  repo: string,
  prNumber: number,
  sessionId: string
): Promise<string> {
  const [owner, repoName] = repo.split('/');
  const result = await callGitHubMCP(
    GITHUB_MCP_OPERATIONS.GET_PR_DIFF,
    { owner, repo: repoName, pull_number: prNumber },
    sessionId
  );
  return result as string;
}

// Fetch changed files list — used by Orchestrator for line count validation
export async function getPullRequestFiles(
  repo: string,
  prNumber: number,
  sessionId: string
) {
  const [owner, repoName] = repo.split('/');
  return callGitHubMCP(
    GITHUB_MCP_OPERATIONS.GET_PR_FILES,
    { owner, repo: repoName, pull_number: prNumber },
    sessionId
  );
}

// Post review comment — used by Aggregator
export async function postPRComment(
  repo: string,
  prNumber: number,
  body: string,
  sessionId: string
): Promise<{ id: number; html_url: string }> {
  const [owner, repoName] = repo.split('/');
  const result = await callGitHubMCP(
    GITHUB_MCP_OPERATIONS.POST_COMMENT,
    { owner, repo: repoName, issue_number: prNumber, body },
    sessionId
  );
  return result as { id: number; html_url: string };
}

// Update existing comment — used on /review reset slash command
export async function updatePRComment(
  repo: string,
  commentId: number,
  body: string,
  sessionId: string
) {
  const [owner, repoName] = repo.split('/');
  return callGitHubMCP(
    GITHUB_MCP_OPERATIONS.UPDATE_COMMENT,
    { owner, repo: repoName, comment_id: commentId, body },
    sessionId
  );
}

// Add label to PR — used by Aggregator for verdict labeling
export async function addPRLabel(
  repo: string,
  prNumber: number,
  labels: string[],
  sessionId: string
) {
  const [owner, repoName] = repo.split('/');
  return callGitHubMCP(
    GITHUB_MCP_OPERATIONS.ADD_LABEL,
    { owner, repo: repoName, issue_number: prNumber, labels },
    sessionId
  );
}

// Create commit status — used by Aggregator to set PR check status
export async function createCommitStatus(
  repo: string,
  sha: string,
  state: 'pending' | 'success' | 'failure' | 'error',
  description: string,
  sessionId: string
) {
  const [owner, repoName] = repo.split('/');
  return callGitHubMCP(
    GITHUB_MCP_OPERATIONS.CREATE_STATUS,
    {
      owner,
      repo: repoName,
      sha,
      state,
      description,
      context: 'PR Review Agent',
    },
    sessionId
  );
}

// List existing PR comments — used to find and update previous reviews
export async function listPRComments(
  repo: string,
  prNumber: number,
  sessionId: string
) {
  const [owner, repoName] = repo.split('/');
  return callGitHubMCP(
    GITHUB_MCP_OPERATIONS.LIST_COMMENTS,
    { owner, repo: repoName, issue_number: prNumber },
    sessionId
  );
}

// ============================================================
// PR Labels used by Aggregator
// ============================================================
export const PR_LABELS = {
  APPROVED:           'ai-review: approved',
  CHANGES_REQUESTED:  'ai-review: changes-requested',
  ESCALATED:          'ai-review: needs-human-review',
  IN_PROGRESS:        'ai-review: in-progress',
} as const;

// ============================================================
// Error class for GitHub MCP failures
// ============================================================
export class GitHubMCPError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly sessionId: string
  ) {
    super(message);
    this.name = 'GitHubMCPError';
  }
}

// ============================================================
// CloudWatch logging for every MCP call
// ============================================================
interface MCPCallLog {
  sessionId: string;
  operation: string;
  durationMs: number;
  success: boolean;
  error?: string;
}

function logMCPCall(log: MCPCallLog): void {
  console.log(JSON.stringify({
    level: log.success ? 'INFO' : 'ERROR',
    service: 'github-mcp-client',
    ...log,
    timestamp: new Date().toISOString(),
  }));
}