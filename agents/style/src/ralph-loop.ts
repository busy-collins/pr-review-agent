import { getAnthropicClient, CLAUDE_MODEL } from '../../../shared/anthropic';
import { log } from '../../../shared/logger';
import type {
  StyleFinding,
  StyleCategory,
  StyleVerdict,
} from '../../../shared/types';

// ============================================================
// Style SubAgent Ralph loop — one iteration per Lambda invocation.
// Same per-iteration pattern as the Security agent, but with the
// project's coding-standards prompt and StyleFinding contract.
// ============================================================

export interface RalphIterationInput {
  sessionId: string;
  diffContent: string;
  iteration: number;
  previousFindings: StyleFinding[] | null;
}

export interface RalphIterationResult {
  findings: StyleFinding[];
  confidence: number;
  reasoning: string;
}

// ============================================================
// Verdict: per CLAUDE.md, style findings never block a PR.
// Output verdict signals only whether suggestions exist.
// Aggregator owns the final blocking decision.
// ============================================================
export function computeVerdict(findings: StyleFinding[]): StyleVerdict {
  return findings.length === 0 ? 'APPROVED' : 'CHANGES_REQUESTED';
}

// Strip whatever blocks_pr the model returns; the schema constrains it
// to const: false, but we enforce in-code as defense-in-depth.
export function normalizeFindings(
  findings: Array<Omit<StyleFinding, 'blocks_pr'>>
): StyleFinding[] {
  return findings.map((f) => ({ ...f, blocks_pr: false as const }));
}

// ============================================================
// Prompt construction
// ============================================================

const CATEGORIES: StyleCategory[] = [
  'NO_ANY_TYPE',
  'MISSING_ERROR_HANDLING',
  'UNUSED_IMPORT',
  'FUNCTION_TOO_LONG',
  'SINGLE_LETTER_VARIABLE',
  'MISSING_TYPE_HINT',
  'BARE_EXCEPT',
  'MISSING_DOCSTRING',
  'MUTABLE_DEFAULT_ARG',
  'COMMENTED_OUT_CODE',
  'HARDCODED_URL',
  'MISSING_ENV_EXAMPLE',
  'CONSOLE_LOG_IN_PROD',
  'SINGLE_RESPONSIBILITY',
  'MISSING_TESTS',
  'PEP8_VIOLATION',
];

export function buildSystemPrompt(): string {
  return [
    'You are a senior staff engineer reviewing a pull request diff for code quality and maintainability.',
    '',
    'Project standards (from CLAUDE.md):',
    '',
    'TypeScript:',
    '  - Strict mode. No `any` without explicit justification.',
    '  - All async functions must handle errors.',
    '  - No unused imports or variables.',
    '  - Functions must not exceed 40 lines.',
    '  - Descriptive variable names. No single-letter names outside loop counters.',
    '',
    'Python:',
    '  - PEP8 compliance.',
    '  - Type hints required on all function signatures.',
    '  - No bare `except` clauses.',
    '  - Docstrings required on all public functions.',
    '',
    'General:',
    '  - No hardcoded secrets, URLs, or environment-specific values.',
    '  - No commented-out code blocks.',
    '  - All environment variables must be documented in `.env.example`.',
    '',
    'Categories you may use (exactly these enum values):',
    CATEGORIES.map((c) => `  - ${c}`).join('\n'),
    '',
    'Severity rubric:',
    '  - MEDIUM: real code smell, missing tests, poor naming',
    '  - LOW: minor style / formatting',
    '  - INFO: best-practice reminder, no functional risk',
    '',
    'Hard rules:',
    '  - You MUST NOT use severity CRITICAL or HIGH. Those are reserved for security and correctness, not style.',
    '  - Every finding must include a concrete fix suggestion.',
    '  - blocks_pr is ALWAYS false for style findings — they never block a PR.',
    '  - Review ONLY changed lines from the diff. Do not comment on unchanged context.',
    '  - If a pattern is ambiguous, lower confidence rather than reporting noise.',
    '',
    'Return all findings via the `report_findings` tool — do not write prose responses.',
  ].join('\n');
}

export function buildUserPrompt(
  diff: string,
  previousFindings: StyleFinding[] | null,
  iteration: number
): string {
  const parts: string[] = [];
  parts.push('## PR diff to review');
  parts.push('```diff');
  parts.push(diff);
  parts.push('```');

  if (iteration > 1 && previousFindings) {
    parts.push('');
    parts.push(`## Previous iteration findings (iteration ${iteration - 1})`);
    parts.push(
      'Re-examine the diff against these findings. Confirm true positives, refute false positives, adjust severity where warranted, and surface any issues the previous pass missed. Aim to increase your confidence by at least 0.05.'
    );
    parts.push('```json');
    parts.push(JSON.stringify(previousFindings, null, 2));
    parts.push('```');
  } else {
    parts.push('');
    parts.push('Identify every code-quality issue introduced by the changed lines. Report them via the `report_findings` tool.');
  }
  return parts.join('\n');
}

// ============================================================
// Tool definition. Mirrors Security but with StyleFinding shape:
// severity restricted to MEDIUM/LOW/INFO, no code_example or
// owasp_reference fields.
// ============================================================
export const REPORT_TOOL = {
  name: 'report_findings',
  description: 'Report all style and code-quality findings discovered in the PR diff.',
  input_schema: {
    type: 'object' as const,
    required: ['findings', 'confidence', 'reasoning'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['severity', 'category', 'file', 'line', 'description', 'suggestion'],
          properties: {
            severity: { type: 'string', enum: ['MEDIUM', 'LOW', 'INFO'] },
            category: { type: 'string', enum: CATEGORIES },
            file: { type: 'string' },
            line: { type: 'integer' },
            description: { type: 'string' },
            suggestion: { type: 'string' },
          },
        },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: {
        type: 'string',
        description: 'Brief explanation of how you arrived at this confidence score.',
      },
    },
  },
};

interface ReportToolInput {
  findings: Array<Omit<StyleFinding, 'blocks_pr'>>;
  confidence: number;
  reasoning: string;
}

export function parseToolResponse(response: {
  content: Array<{ type: string; name?: string; input?: unknown }>;
}): ReportToolInput {
  const toolUse = response.content.find(
    (b) => b.type === 'tool_use' && b.name === REPORT_TOOL.name
  );
  if (!toolUse || !toolUse.input || typeof toolUse.input !== 'object') {
    throw new Error('Style agent did not invoke report_findings tool');
  }
  return toolUse.input as ReportToolInput;
}

export async function runStyleIteration(
  input: RalphIterationInput
): Promise<RalphIterationResult> {
  const client = getAnthropicClient();
  const startTime = Date.now();

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: buildSystemPrompt(),
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: [REPORT_TOOL],
    tool_choice: { type: 'tool', name: REPORT_TOOL.name },
    messages: [
      {
        role: 'user',
        content: buildUserPrompt(
          input.diffContent,
          input.previousFindings,
          input.iteration
        ),
      },
    ],
  });

  const parsed = parseToolResponse(response);
  const findings = normalizeFindings(parsed.findings);

  log('INFO', 'style-agent', 'Ralph iteration complete', {
    sessionId: input.sessionId,
    iteration: input.iteration,
    findingsCount: findings.length,
    confidence: parsed.confidence,
    durationMs: Date.now() - startTime,
  });

  return {
    findings,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
  };
}
