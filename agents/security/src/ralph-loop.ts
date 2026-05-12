import { getAnthropicClient, CLAUDE_MODEL } from '../../../shared/anthropic';
import { log } from '../../../shared/logger';
import type {
  SecurityFinding,
  SecurityCategory,
  Severity,
  Verdict,
} from '../../../shared/types';

// ============================================================
// Ralph loop — single iteration. The Step Functions state machine
// invokes this Lambda 1–3 times based on confidence thresholds;
// this module owns ONE iteration of the loop, not the loop itself.
// ============================================================

export interface RalphIterationInput {
  sessionId: string;
  diffContent: string;
  iteration: number;
  previousFindings: SecurityFinding[] | null;
}

export interface RalphIterationResult {
  findings: SecurityFinding[];
  confidence: number;
  reasoning: string;
}

// CLAUDE.md severity → blocks_pr rule
const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set(['CRITICAL', 'HIGH']);

export function markBlockingFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.map((f) => ({
    ...f,
    blocks_pr: BLOCKING_SEVERITIES.has(f.severity),
  }));
}

// ============================================================
// Verdict derived from worst-severity finding.
// ESCALATED on any CRITICAL (per CLAUDE.md escalation rules).
// CHANGES_REQUESTED on any HIGH. Otherwise APPROVED.
// ============================================================
export function computeVerdict(findings: SecurityFinding[]): Verdict {
  let sawCritical = false;
  let sawHigh = false;
  for (const f of findings) {
    if (f.severity === 'CRITICAL') sawCritical = true;
    else if (f.severity === 'HIGH') sawHigh = true;
  }
  if (sawCritical) return 'ESCALATED';
  if (sawHigh) return 'CHANGES_REQUESTED';
  return 'APPROVED';
}

// ============================================================
// Prompt construction
// ============================================================

const CATEGORIES: SecurityCategory[] = [
  'HARDCODED_SECRET',
  'SQL_INJECTION',
  'COMMAND_INJECTION',
  'XSS',
  'AUTH_BYPASS',
  'BOLA',
  'JWT_BYPASS',
  'INSECURE_DEPENDENCY',
  'PII_EXPOSURE',
  'UNSAFE_DESERIALIZATION',
];

export function buildSystemPrompt(): string {
  return [
    'You are a senior staff security engineer reviewing a pull request diff for vulnerabilities.',
    '',
    'Your responsibilities (per project CLAUDE.md):',
    '- Review ONLY changed lines in the diff. Never flag unchanged context.',
    '- Every finding must include a concrete fix suggestion.',
    '- Severity → blocks_pr: CRITICAL and HIGH block the PR; MEDIUM/LOW/INFO do not.',
    '- Be direct, constructive, respectful. Never condescending.',
    '- If you are uncertain whether a pattern is actually exploitable, lower confidence — do not invent findings.',
    '',
    'Categories you must check (use exactly these enum values):',
    CATEGORIES.map((c) => `  - ${c}`).join('\n'),
    '',
    'Severity rubric:',
    '  - CRITICAL: Exploitable in production; data loss, RCE, auth bypass, secret leak, payment manipulation',
    '  - HIGH: Logic error or missing safeguard that an attacker could leverage with effort',
    '  - MEDIUM: Defense-in-depth gap; not directly exploitable but weakens the system',
    '  - LOW: Minor risk; reduces clarity or future-proofing',
    '  - INFO: Best-practice reminder; no real risk',
    '',
    'Confidence score reflects YOUR certainty in the findings, not the security of the PR.',
    'Return all findings via the `report_findings` tool — do not write prose responses.',
  ].join('\n');
}

export function buildUserPrompt(
  diff: string,
  previousFindings: SecurityFinding[] | null,
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
      'Re-examine the diff against these findings. For each, confirm or refute it and adjust severity if warranted. Identify any vulnerabilities the previous pass missed. Aim to increase your confidence by at least 0.05.'
    );
    parts.push('```json');
    parts.push(JSON.stringify(previousFindings, null, 2));
    parts.push('```');
  } else {
    parts.push('');
    parts.push('Identify every security vulnerability introduced by the changed lines. Report them via the `report_findings` tool.');
  }
  return parts.join('\n');
}

// ============================================================
// Tool definition — Anthropic enforces input_schema, so the tool
// call gives us structured findings without prompt-parsing risk.
// ============================================================
export const REPORT_TOOL = {
  name: 'report_findings',
  description: 'Report all security findings discovered in the PR diff.',
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
            severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] },
            category: { type: 'string', enum: CATEGORIES },
            file: { type: 'string' },
            line: { type: 'integer' },
            description: { type: 'string' },
            suggestion: { type: 'string' },
            code_example: { type: ['string', 'null'] },
            owasp_reference: { type: ['string', 'null'] },
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

// ============================================================
// Tool-use response parser. Throws if Claude didn't call the tool
// (which would indicate a prompt failure worth surfacing loudly).
// ============================================================
interface ReportToolInput {
  findings: Array<Omit<SecurityFinding, 'blocks_pr'>>;
  confidence: number;
  reasoning: string;
}

export function parseToolResponse(
  response: { content: Array<{ type: string; name?: string; input?: unknown }> }
): ReportToolInput {
  const toolUse = response.content.find(
    (b) => b.type === 'tool_use' && b.name === REPORT_TOOL.name
  );
  if (!toolUse || !toolUse.input || typeof toolUse.input !== 'object') {
    throw new Error('Security agent did not invoke report_findings tool');
  }
  const raw = toolUse.input as Partial<ReportToolInput>;
  // Anthropic's tool_use schema enforcement is best-effort, not strict —
  // Claude can return non-array findings under model confusion. Coerce
  // defensively so a malformed response doesn't crash the Ralph loop.
  return {
    findings: Array.isArray(raw.findings) ? raw.findings : [],
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
  };
}

// ============================================================
// Single iteration. Calls Claude, parses the tool use, normalizes
// blocks_pr per the severity rule.
// ============================================================
export async function runSecurityIteration(
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
        content: buildUserPrompt(input.diffContent, input.previousFindings, input.iteration),
      },
    ],
  });

  const parsed = parseToolResponse(response);
  const findings = markBlockingFindings(
    parsed.findings.map((f) => ({ ...f, blocks_pr: false }))
  );

  log('INFO', 'security-agent', 'Ralph iteration complete', {
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
