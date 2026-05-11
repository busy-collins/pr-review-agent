import type { Context } from 'aws-lambda';
import { log } from '../../../shared/logger';
import { writeCheckpoint } from '../../../shared/dynamo';
import { validate } from '../../../shared/schema-validate';
import { postPRComment } from '../../../api/mcp/Github.mcp.client';
import aggregatorSchema from '../schemas/aggregator.schema.json';
import { buildDefaultSummary, formatGitHubComment } from './formatter';
import type {
  AggregatorInput,
  AggregatorOutput,
  ConflictResolution,
  SecurityFinding,
  Severity,
  StyleFinding,
  TaggedFinding,
  Verdict,
} from '../../../shared/types';

// ============================================================
// Aggregator Lambda handler.
// Merges Security + Style findings, resolves conflicts, picks the
// final verdict, renders + posts the GitHub comment, writes the
// final checkpoint. Slack notification is owned by the state
// machine's NotifySlackEscalation step, not this handler.
// ============================================================

const MIN_CONFIDENCE_THRESHOLD = parseFloat(
  process.env.MIN_CONFIDENCE_THRESHOLD || '0.75'
);

const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set(['CRITICAL', 'HIGH']);

// Shadow mode: run the pipeline end-to-end against real PRs but do
// NOT post the comment to GitHub. Used during the rollout window
// described in PLAN.md — lets us collect production data without
// surfacing agent output to users until we have confidence. Read
// at call time so toggling the env var takes effect on the next
// invocation without needing to recycle the Lambda container.
function isShadowMode(): boolean {
  return process.env.SHADOW_MODE === 'true';
}

export async function handler(
  event: AggregatorInput,
  _context?: Context
): Promise<AggregatorOutput> {
  const inputCheck = validate(aggregatorSchema, 'AggregatorInput', event);
  if (!inputCheck.valid) {
    throw new Error(`Invalid aggregator input: ${inputCheck.errors.join('; ')}`);
  }

  log('INFO', 'aggregator', 'Aggregator invoked', {
    sessionId: event.session_id,
    prNumber: event.pr_metadata.pr_number,
    repo: event.pr_metadata.repo,
    securityFindings: event.security_output.findings.length,
    styleFindings: event.style_output.findings.length,
  });

  const overallConfidence = averageConfidence(
    event.security_output.confidence,
    event.style_output.confidence
  );

  const { tagged, conflictResolutions } = mergeFindings(
    event.security_output.findings,
    event.style_output.findings
  );

  const blockingCount = tagged.filter((t) =>
    BLOCKING_SEVERITIES.has(t.finding.severity)
  ).length;
  const nonBlockingCount = tagged.length - blockingCount;

  const finalVerdict = computeFinalVerdict({
    securityVerdict: event.security_output.verdict,
    findings: tagged,
    overallConfidence,
  });

  const summary = buildDefaultSummary({
    findings: tagged,
    blockingCount,
    nonBlockingCount,
    finalVerdict,
  });

  const githubComment = formatGitHubComment({
    sessionId: event.session_id,
    findings: tagged,
    finalVerdict,
    overallConfidence,
    blockingCount,
    nonBlockingCount,
    summary,
  });

  const postResult = await tryPostComment(
    event.pr_metadata.repo,
    event.pr_metadata.pr_number,
    githubComment,
    event.session_id
  );

  const checkpointSaved = await writeCheckpoint({
    sessionId: event.session_id,
    stage: 'AGGREGATOR',
    status: finalVerdict === 'ESCALATED' ? 'ESCALATED' : 'COMPLETED',
    prMetadata: event.pr_metadata,
    data: {
      final_verdict: finalVerdict,
      overall_confidence: overallConfidence,
      blocking_count: blockingCount,
      non_blocking_count: nonBlockingCount,
      security_confidence: event.security_output.confidence,
      style_confidence: event.style_output.confidence,
      aggregated_comment: githubComment,
      github_comment_url: postResult.url,
      conflict_resolutions: conflictResolutions,
    },
  });

  const result: AggregatorOutput = {
    session_id: event.session_id,
    final_verdict: finalVerdict,
    overall_confidence: overallConfidence,
    blocking_count: blockingCount,
    non_blocking_count: nonBlockingCount,
    conflict_resolutions: conflictResolutions,
    github_comment: githubComment,
    github_comment_url: postResult.url,
    comment_posted: postResult.posted,
    slack_notified: false,
    checkpoint_saved: checkpointSaved,
    completed_at: new Date().toISOString(),
  };

  const outputCheck = validate(aggregatorSchema, 'AggregatorOutput', result);
  if (!outputCheck.valid) {
    log('ERROR', 'aggregator', 'Output failed schema validation', {
      sessionId: event.session_id,
      errors: outputCheck.errors,
    });
  }

  return result;
}

// ============================================================
// Verdict logic (per CLAUDE.md):
//   - CRITICAL finding OR security ESCALATED OR confidence < 0.75
//     → ESCALATED
//   - Any HIGH severity finding → CHANGES_REQUESTED
//   - Otherwise → APPROVED
// Style findings alone never block; they appear in the comment
// but do not drive the verdict.
// ============================================================
export function computeFinalVerdict(input: {
  securityVerdict: Verdict;
  findings: TaggedFinding[];
  overallConfidence: number;
}): Verdict {
  const hasCritical = input.findings.some(
    (t) => t.finding.severity === 'CRITICAL'
  );
  if (
    hasCritical ||
    input.securityVerdict === 'ESCALATED' ||
    input.overallConfidence < MIN_CONFIDENCE_THRESHOLD
  ) {
    return 'ESCALATED';
  }
  const hasHigh = input.findings.some((t) => t.finding.severity === 'HIGH');
  if (hasHigh) return 'CHANGES_REQUESTED';
  return 'APPROVED';
}

// ============================================================
// Merge + conflict resolution.
// Same (file, line) hit by both agents → resolve per priority:
//   - Security CRITICAL/HIGH present → SECURITY_WINS (drop style)
//   - Otherwise → MERGED (keep both)
// ============================================================
export function mergeFindings(
  securityFindings: SecurityFinding[],
  styleFindings: StyleFinding[]
): { tagged: TaggedFinding[]; conflictResolutions: ConflictResolution[] } {
  const conflictResolutions: ConflictResolution[] = [];

  // Index security findings by file:line for fast collision lookup
  const securityByKey = new Map<string, SecurityFinding[]>();
  for (const f of securityFindings) {
    const key = `${f.file}:${f.line}`;
    const list = securityByKey.get(key) ?? [];
    list.push(f);
    securityByKey.set(key, list);
  }

  const tagged: TaggedFinding[] = securityFindings.map((f) => ({
    agent: 'security',
    finding: f,
  }));

  for (const sf of styleFindings) {
    const key = `${sf.file}:${sf.line}`;
    const collisions = securityByKey.get(key);
    if (collisions && collisions.length > 0) {
      const securityWins = collisions.some((c) =>
        BLOCKING_SEVERITIES.has(c.severity)
      );
      if (securityWins) {
        conflictResolutions.push({
          file: sf.file,
          line: sf.line,
          resolution: 'SECURITY_WINS',
        });
        continue; // drop the style finding
      }
      conflictResolutions.push({
        file: sf.file,
        line: sf.line,
        resolution: 'MERGED',
      });
    }
    tagged.push({ agent: 'style', finding: sf });
  }

  return { tagged, conflictResolutions };
}

export function averageConfidence(a: number, b: number): number {
  return (a + b) / 2;
}

// ============================================================
// PR comment posting — failure is non-fatal. We still return a
// valid result so the state machine can complete the pipeline
// and the checkpoint records what we tried to post.
//
// Shadow mode short-circuits the GitHub call entirely — the
// comment body is still rendered and persisted in DynamoDB +
// the dashboard, but no user-visible comment appears on the PR.
// ============================================================
async function tryPostComment(
  repo: string,
  prNumber: number,
  body: string,
  sessionId: string
): Promise<{ posted: boolean; url: string | null }> {
  if (isShadowMode()) {
    log('INFO', 'aggregator', 'Shadow mode: skipping GitHub comment post', {
      sessionId,
      repo,
      prNumber,
      bodyLength: body.length,
    });
    return { posted: false, url: null };
  }
  try {
    const result = await postPRComment(repo, prNumber, body, sessionId);
    return { posted: true, url: result.html_url ?? null };
  } catch (error) {
    log('ERROR', 'aggregator', 'Failed to post PR comment', {
      sessionId,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return { posted: false, url: null };
  }
}
