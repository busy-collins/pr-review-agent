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
//
// The Anthropic MCP connector schema (BetaRequestMCPServerURLDefinition)
// does not accept custom `headers` — only a single `authorization_token`
// which the API forwards as `Authorization: Bearer <token>` to the MCP
// server. GitHub Copilot's MCP endpoint expects bearer auth so this works.
// ============================================================
export const githubMCPConfig = {
  type: 'url' as const,
  url: 'https://api.githubcopilot.com/mcp/',
  name: 'github-mcp',
  authorization_token: process.env.GITHUB_TOKEN ?? '',
};

// BetaMCPToolResultBlock.content is `string | Array<BetaTextBlock>`.
// Normalize to a single string for callers; GitHub MCP returns either
// the raw text payload directly or a single-element text block array.
function extractMCPResultText(
  content: Anthropic.Beta.Messages.BetaMCPToolResultBlock['content']
): string {
  if (typeof content === 'string') return content;
  return content.map((block) => block.text).join('');
}

// ============================================================
// Core GitHub MCP caller
// All agents call this — never call GitHub API directly
// ============================================================
export async function callGitHubMCP(
  operation: GitHubOperation,
  params: Record<string, unknown>,
  sessionId: string
): Promise<string> {

  const startTime = Date.now();

  try {
    // Cast: create() returns BetaMessage | Stream depending on `stream`. We
    // don't stream, so narrow to BetaMessage for typed `.content` access.
    const response = await client.beta.messages.create({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      // Has to fit Claude's mcp_tool_use block including any argument
      // payload (e.g. the full review comment body for create_issue_comment).
      // 1000 was truncating the tool_use mid-emission so no tool_result
      // ever appeared in the response.
      max_tokens: 16384,
      mcp_servers: [githubMCPConfig],
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

    // Extract MCP tool result from response. BetaMCPToolResultBlock.content
    // is `string | Array<BetaTextBlock>`. We unwrap to the actual payload
    // string here so callers can JSON.parse / use it as text without
    // worrying about block structure.
    const toolResultBlock = response.content.find(
      (block): block is Anthropic.Beta.Messages.BetaMCPToolResultBlock =>
        block.type === 'mcp_tool_result'
    );

    if (!toolResultBlock) {
      throw new GitHubMCPError(
        `No tool result returned for operation: ${operation}`,
        operation,
        sessionId
      );
    }

    if (toolResultBlock.is_error) {
      const errorText = extractMCPResultText(toolResultBlock.content);
      throw new GitHubMCPError(
        `GitHub MCP tool reported error for ${operation}: ${errorText}`,
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

    return extractMCPResultText(toolResultBlock.content);

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

// Fetch PR raw diff — used by Orchestrator to pass to SubAgents.
// Goes direct to GitHub REST instead of routing through Claude+MCP:
// this is a pure CRUD fetch with no reasoning step, so the MCP-via-
// Claude indirection only added latency, max_tokens gymnastics, and
// failure modes (truncated tool_use blocks, missing tool_result).
export async function getPullRequestDiff(
  repo: string,
  prNumber: number,
  sessionId: string
): Promise<string> {
  const [owner, repoName] = repo.split('/');
  const url = `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`;
  const startTime = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ''}`,
        Accept: 'application/vnd.github.v3.diff',
        'User-Agent': 'pr-review-agent',
      },
    });
    if (!response.ok) {
      throw new GitHubMCPError(
        `GitHub diff fetch failed: ${response.status} ${response.statusText}`,
        GITHUB_MCP_OPERATIONS.GET_PR_DIFF,
        sessionId
      );
    }
    const diff = await response.text();
    logMCPCall({
      sessionId,
      operation: GITHUB_MCP_OPERATIONS.GET_PR_DIFF,
      durationMs: Date.now() - startTime,
      success: true,
    });
    return diff;
  } catch (error) {
    logMCPCall({
      sessionId,
      operation: GITHUB_MCP_OPERATIONS.GET_PR_DIFF,
      durationMs: Date.now() - startTime,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
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

// Post review comment — used by Aggregator. Direct REST for the same
// reason getPullRequestDiff is direct: pure CRUD, no Claude reasoning,
// and a markdown body that easily exceeded MCP tool_use token budgets.
export async function postPRComment(
  repo: string,
  prNumber: number,
  body: string,
  sessionId: string
): Promise<{ id: number; html_url: string }> {
  const [owner, repoName] = repo.split('/');
  const url = `https://api.github.com/repos/${owner}/${repoName}/issues/${prNumber}/comments`;
  const startTime = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ''}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'pr-review-agent',
      },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new GitHubMCPError(
        `GitHub comment post failed: ${response.status} ${response.statusText} — ${text.slice(0, 200)}`,
        GITHUB_MCP_OPERATIONS.POST_COMMENT,
        sessionId
      );
    }
    const json = (await response.json()) as { id: number; html_url: string };
    logMCPCall({
      sessionId,
      operation: GITHUB_MCP_OPERATIONS.POST_COMMENT,
      durationMs: Date.now() - startTime,
      success: true,
    });
    return json;
  } catch (error) {
    logMCPCall({
      sessionId,
      operation: GITHUB_MCP_OPERATIONS.POST_COMMENT,
      durationMs: Date.now() - startTime,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
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