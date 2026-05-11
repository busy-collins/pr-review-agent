import type { Context } from 'aws-lambda';
import { log } from '../../../shared/logger';
import { writeCheckpoint } from '../../../shared/dynamo';
import { validate } from '../../../shared/schema-validate';
import {
  getPullRequestDiff,
  postPRComment,
} from '../../../api/mcp/Github.mcp.client';
import {
  postEscalationNotification,
  postSizeWarningNotification,
} from '../../../api/mcp/Slack.mcp.client';
import orchestratorSchema from '../schemas/orchestrator.schema.json';
import {
  assessDiffSize,
  classifyEscalation,
  generateSessionId,
  selectSubAgents,
} from './session';
import type {
  OrchestratorInput,
  OrchestratorValidateOutput,
  OrchestratorWebhookEvent,
  PRMetadata,
} from '../../../shared/types';

// ============================================================
// Orchestrator Lambda handler.
// Step Functions calls this with one of four `action`s — VALIDATE
// is the main entry; the other three are housekeeping invocations
// from later states in the state machine.
// ============================================================
export async function handler(
  event: OrchestratorInput,
  _context?: Context
): Promise<unknown> {
  switch (event.action) {
    case 'VALIDATE':          return validatePR(event.payload);
    case 'POST_SIZE_WARNING': return postSizeWarning(event);
    case 'NOTIFY_SLACK':      return notifySlack(event);
    case 'HANDLE_FAILURE':    return handleFailure(event);
    default: {
      const exhaustive: never = event;
      throw new Error(`Unknown orchestrator action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ============================================================
// VALIDATE — fetch diff, run eligibility checks, write the first
// checkpoint. Returns the shape consumed by the parallel SubAgents.
// ============================================================
async function validatePR(
  payload: OrchestratorWebhookEvent
): Promise<OrchestratorValidateOutput> {
  const inputCheck = validate(orchestratorSchema, 'OrchestratorInput', payload);
  if (!inputCheck.valid) {
    throw new Error(
      `Invalid orchestrator input: ${inputCheck.errors.join('; ')}`
    );
  }

  const sessionId = generateSessionId(payload.repo, payload.pr_number);
  const basePrMetadata: PRMetadata = {
    pr_number: payload.pr_number,
    repo: payload.repo,
    sender: payload.sender,
    base_branch: payload.base_branch,
    head_branch: payload.head_branch,
    diff_line_count: payload.diff_line_count ?? 0,
  };

  log('INFO', 'orchestrator', 'Orchestrator started', {
    sessionId,
    prNumber: payload.pr_number,
    repo: payload.repo,
    eventType: payload.event_type,
    slashCommand: payload.slash_command ?? undefined,
  });

  const diffContent = await getPullRequestDiff(
    payload.repo,
    payload.pr_number,
    sessionId
  );
  const diffString =
    typeof diffContent === 'string' ? diffContent : String(diffContent);
  const sizeAssessment = assessDiffSize(diffString);

  // Size cap — runs before any other eligibility check
  if (sizeAssessment.exceedsLimit) {
    log('WARN', 'orchestrator', 'PR exceeds size limit — skipping review', {
      sessionId,
      totalLines: sizeAssessment.totalLines,
      reviewableLines: sizeAssessment.reviewableLines,
      skippedLines: sizeAssessment.skippedLines,
    });
    const checkpointSaved = await writeCheckpoint({
      sessionId,
      stage: 'ORCHESTRATOR',
      status: 'ESCALATED',
      prMetadata: { ...basePrMetadata, diff_line_count: sizeAssessment.totalLines },
      data: {
        eligible: false,
        skip_reason: 'DIFF_TOO_LARGE',
        total_diff_lines: sizeAssessment.totalLines,
        reviewable_diff_lines: sizeAssessment.reviewableLines,
        skipped_diff_lines: sizeAssessment.skippedLines,
      },
    });
    return {
      session_id: sessionId,
      status: 'SKIPPED',
      eligible: false,
      skip_reason: `Diff exceeds size limit (${sizeAssessment.reviewableLines} reviewable lines after excluding generated files)`,
      subagents_to_run: [],
      pr_metadata: { ...basePrMetadata, diff_line_count: sizeAssessment.totalLines },
      checkpoint_saved: checkpointSaved,
    };
  }

  const escalationReason = classifyEscalation(diffString);
  const subagents = selectSubAgents(payload.slash_command);
  const status: OrchestratorValidateOutput['status'] = escalationReason
    ? 'ESCALATED'
    : 'ELIGIBLE';

  const prMetadata: PRMetadata = {
    ...basePrMetadata,
    diff_line_count: sizeAssessment.totalLines,
  };

  const checkpointSaved = await writeCheckpoint({
    sessionId,
    stage: 'ORCHESTRATOR',
    status: 'IN_PROGRESS',
    prMetadata,
    data: {
      eligible: true,
      subagents_to_run: subagents,
      escalation_reason: escalationReason,
      total_diff_lines: sizeAssessment.totalLines,
      reviewable_diff_lines: sizeAssessment.reviewableLines,
      slash_command: payload.slash_command,
    },
  });

  const result: OrchestratorValidateOutput = {
    session_id: sessionId,
    status,
    eligible: true,
    skip_reason: null,
    subagents_to_run: subagents,
    diff_content: diffString,
    pr_metadata: prMetadata,
    checkpoint_saved: checkpointSaved,
    escalation_reason: escalationReason,
  };

  const outputCheck = validate(orchestratorSchema, 'OrchestratorOutput', result);
  if (!outputCheck.valid) {
    // Output failing validation is a code bug, not a runtime failure —
    // log loudly but don't crash the pipeline.
    log('ERROR', 'orchestrator', 'Output failed schema validation', {
      sessionId,
      errors: outputCheck.errors,
    });
  }
  return result;
}

// ============================================================
// POST_SIZE_WARNING — comment on the PR and notify Slack that
// we skipped review due to size. Invoked after a SKIPPED VALIDATE.
// ============================================================
async function postSizeWarning(
  event: Extract<OrchestratorInput, { action: 'POST_SIZE_WARNING' }>
): Promise<void> {
  const body = [
    '## 🤖 Automated PR Review — Size Warning',
    '',
    'This PR exceeds the 3,000-line limit for automated review and was not analyzed by the agent pipeline.',
    '',
    `**Diff size:** ${event.diff_line_count.toLocaleString()} lines`,
    '',
    'Please request a manual review from a senior engineer.',
    '',
    '---',
    `_Session: \`${event.session_id}\`_`,
  ].join('\n');

  await postPRComment(
    event.pr_metadata.repo,
    event.pr_metadata.pr_number,
    body,
    event.session_id
  );
  await postSizeWarningNotification({
    sessionId: event.session_id,
    repo: event.pr_metadata.repo,
    prNumber: event.pr_metadata.pr_number,
    diffLineCount: event.diff_line_count,
    prUrl: event.pr_url,
  });
}

// ============================================================
// NOTIFY_SLACK — post the escalation message. Invoked from the
// state machine's CheckFinalVerdict branch.
// ============================================================
async function notifySlack(
  event: Extract<OrchestratorInput, { action: 'NOTIFY_SLACK' }>
): Promise<void> {
  await postEscalationNotification({
    sessionId: event.session_id,
    repo: event.pr_metadata.repo,
    prNumber: event.pr_metadata.pr_number,
    sender: event.pr_metadata.sender,
    reason: event.reason,
    prUrl: event.pr_url,
    // exactOptionalPropertyTypes: only set when defined
    ...(event.confidence_score !== undefined && {
      confidenceScore: event.confidence_score,
    }),
  });
}

// ============================================================
// HANDLE_FAILURE — terminal failure cleanup. Logs and updates
// the checkpoint to FAILED so the dashboard can surface it.
// ============================================================
async function handleFailure(
  event: Extract<OrchestratorInput, { action: 'HANDLE_FAILURE' }>
): Promise<{ handled: true }> {
  log('ERROR', 'orchestrator', 'Pipeline failure', {
    stage: event.stage,
    error: serializeError(event.error),
    ...(event.session_id !== undefined && { sessionId: event.session_id }),
  });
  if (event.session_id) {
    await writeCheckpoint({
      sessionId: event.session_id,
      stage: 'ORCHESTRATOR',
      status: 'FAILED',
      data: {
        failure_stage: event.stage,
        error: serializeError(event.error),
      },
    });
  }
  return { handled: true };
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
