import type { Context } from 'aws-lambda';
import { log } from '../../../shared/logger';
import { writeCheckpoint } from '../../../shared/dynamo';
import { validate } from '../../../shared/schema-validate';
import securitySchema from '../schemas/security.schema.json';
import { computeVerdict, runSecurityIteration } from './ralph-loop';
import type {
  SecurityAgentInput,
  SecurityAgentOutput,
} from '../../../shared/types';

// ============================================================
// Security SubAgent Lambda handler.
// One Lambda invocation = one Ralph loop iteration. The Step
// Functions state machine decides whether to invoke iteration 2/3
// based on the returned confidence score.
// ============================================================

const MAX_ITERATIONS = parseInt(process.env.MAX_RALPH_ITERATIONS || '3', 10);

export async function handler(
  event: SecurityAgentInput,
  _context?: Context
): Promise<SecurityAgentOutput> {
  const inputCheck = validate(securitySchema, 'SecurityAgentInput', event);
  if (!inputCheck.valid) {
    throw new Error(
      `Invalid security agent input: ${inputCheck.errors.join('; ')}`
    );
  }

  log('INFO', 'security-agent', 'Security agent invoked', {
    sessionId: event.session_id,
    prNumber: event.pr_metadata.pr_number,
    repo: event.pr_metadata.repo,
    iteration: event.iteration,
    hasPreviousFindings: event.previous_findings !== null,
  });

  const iterationResult = await runSecurityIteration({
    sessionId: event.session_id,
    diffContent: event.diff_content,
    iteration: event.iteration,
    previousFindings: event.previous_findings,
  });

  const verdict = computeVerdict(iterationResult.findings);
  const ralphLoopComplete = event.iteration >= MAX_ITERATIONS;

  const checkpointSaved = await writeCheckpoint({
    sessionId: event.session_id,
    stage: 'SECURITY',
    status: verdict === 'ESCALATED' ? 'ESCALATED' : 'IN_PROGRESS',
    prMetadata: event.pr_metadata,
    data: {
      security_findings: iterationResult.findings,
      security_confidence: iterationResult.confidence,
      security_iterations: event.iteration,
      security_reasoning: iterationResult.reasoning,
      security_verdict: verdict,
    },
  });

  const result: SecurityAgentOutput = {
    agent: 'security',
    session_id: event.session_id,
    confidence: iterationResult.confidence,
    findings: iterationResult.findings,
    iteration: event.iteration,
    ralph_loop_complete: ralphLoopComplete,
    verdict,
    checkpoint_saved: checkpointSaved,
  };

  const outputCheck = validate(securitySchema, 'SecurityAgentOutput', result);
  if (!outputCheck.valid) {
    log('ERROR', 'security-agent', 'Output failed schema validation', {
      sessionId: event.session_id,
      errors: outputCheck.errors,
    });
  }

  return result;
}
