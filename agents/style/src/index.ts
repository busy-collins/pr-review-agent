import type { Context } from 'aws-lambda';
import { log } from '../../../shared/logger';
import { writeCheckpoint } from '../../../shared/dynamo';
import { validate } from '../../../shared/schema-validate';
import styleSchema from '../schemas/styles.schema.json';
import { computeVerdict, runStyleIteration } from './ralph-loop';
import type {
  StyleAgentInput,
  StyleAgentOutput,
} from '../../../shared/types';

// ============================================================
// Style SubAgent Lambda handler.
// One Lambda invocation = one Ralph loop iteration. Confidence-based
// re-invocation is owned by the Step Functions state machine.
// ============================================================

const MAX_ITERATIONS = parseInt(process.env.MAX_RALPH_ITERATIONS || '3', 10);

export async function handler(
  event: StyleAgentInput,
  _context?: Context
): Promise<StyleAgentOutput> {
  const inputCheck = validate(styleSchema, 'StyleAgentInput', event);
  if (!inputCheck.valid) {
    throw new Error(`Invalid style agent input: ${inputCheck.errors.join('; ')}`);
  }

  log('INFO', 'style-agent', 'Style agent invoked', {
    sessionId: event.session_id,
    prNumber: event.pr_metadata.pr_number,
    repo: event.pr_metadata.repo,
    iteration: event.iteration,
    hasPreviousFindings: event.previous_findings !== null,
  });

  const iterationResult = await runStyleIteration({
    sessionId: event.session_id,
    diffContent: event.diff_content,
    iteration: event.iteration,
    previousFindings: event.previous_findings,
  });

  const verdict = computeVerdict(iterationResult.findings);

  // Style findings never block — checkpoint status reflects pipeline progress,
  // not a blocking state, so always IN_PROGRESS here.
  const checkpointSaved = await writeCheckpoint({
    sessionId: event.session_id,
    stage: 'STYLE',
    status: 'IN_PROGRESS',
    prMetadata: event.pr_metadata,
    data: {
      style_findings: iterationResult.findings,
      style_confidence: iterationResult.confidence,
      style_iterations: event.iteration,
      style_reasoning: iterationResult.reasoning,
      style_verdict: verdict,
    },
  });

  const result: StyleAgentOutput = {
    agent: 'style',
    session_id: event.session_id,
    confidence: iterationResult.confidence,
    findings: iterationResult.findings,
    iteration: event.iteration,
    ralph_loop_complete: event.iteration >= MAX_ITERATIONS,
    verdict,
    checkpoint_saved: checkpointSaved,
  };

  const outputCheck = validate(styleSchema, 'StyleAgentOutput', result);
  if (!outputCheck.valid) {
    log('ERROR', 'style-agent', 'Output failed schema validation', {
      sessionId: event.session_id,
      errors: outputCheck.errors,
    });
  }

  return result;
}
