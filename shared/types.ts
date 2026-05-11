// ============================================================
// Shared types — single source of truth for cross-agent contracts
// Aligned with the per-agent JSON schemas under agents/*/schemas/
// ============================================================

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type Verdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'ESCALATED';
export type CheckpointStage = 'ORCHESTRATOR' | 'SECURITY' | 'STYLE' | 'AGGREGATOR' | 'COMPLETE';
export type SessionStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'ESCALATED';

export type EscalationReason =
  | 'LOW_CONFIDENCE'
  | 'AUTH_LOGIC_CHANGE'
  | 'PAYMENT_LOGIC_CHANGE'
  | 'SCHEMA_MIGRATION'
  | 'DIFF_TOO_LARGE'
  | 'CRITICAL_FINDING';

export type SlashCommand =
  | '/review full'
  | '/review security'
  | '/review style'
  | '/review status'
  | '/review reset'
  | null;

export interface PRMetadata {
  pr_number: number;
  repo: string;
  sender: string;
  base_branch: string;
  head_branch: string;
  diff_line_count: number;
}

export interface OrchestratorWebhookEvent {
  event_type: 'pull_request.opened' | 'pull_request.synchronize' | 'issue_comment.created';
  pr_number: number;
  repo: string;
  sender: string;
  diff_url: string;
  diff_line_count?: number;
  base_branch: string;
  head_branch: string;
  slash_command: SlashCommand;
  timestamp: string;
  pr_url?: string;
}

export type OrchestratorInput =
  | { action: 'VALIDATE'; payload: OrchestratorWebhookEvent }
  | {
      action: 'POST_SIZE_WARNING';
      session_id: string;
      pr_metadata: PRMetadata;
      diff_line_count: number;
      pr_url: string;
    }
  | {
      action: 'NOTIFY_SLACK';
      session_id: string;
      pr_metadata: PRMetadata;
      reason: EscalationReason;
      pr_url: string;
      confidence_score?: number;
    }
  | {
      action: 'HANDLE_FAILURE';
      stage: string;
      error: unknown;
      session_id?: string;
    };

// ============================================================
// Security SubAgent contract — aligned with agents/security/schemas
// ============================================================

export type SecurityCategory =
  | 'HARDCODED_SECRET'
  | 'SQL_INJECTION'
  | 'COMMAND_INJECTION'
  | 'XSS'
  | 'AUTH_BYPASS'
  | 'BOLA'
  | 'JWT_BYPASS'
  | 'INSECURE_DEPENDENCY'
  | 'PII_EXPOSURE'
  | 'UNSAFE_DESERIALIZATION';

export interface SecurityFinding {
  severity: Severity;
  category: SecurityCategory;
  file: string;
  line: number;
  description: string;
  suggestion: string;
  code_example?: string | null;
  blocks_pr: boolean;
  owasp_reference?: string | null;
}

export interface SecurityAgentInput {
  session_id: string;
  pr_metadata: PRMetadata;
  diff_content: string;
  iteration: number;
  previous_findings: SecurityFinding[] | null;
}

export interface SecurityAgentOutput {
  agent: 'security';
  session_id: string;
  confidence: number;
  findings: SecurityFinding[];
  iteration: number;
  ralph_loop_complete: boolean;
  verdict: Verdict;
  checkpoint_saved: boolean;
}

// ============================================================
// Style SubAgent contract — aligned with agents/style/schemas
// ============================================================

export type StyleCategory =
  | 'NO_ANY_TYPE'
  | 'MISSING_ERROR_HANDLING'
  | 'UNUSED_IMPORT'
  | 'FUNCTION_TOO_LONG'
  | 'SINGLE_LETTER_VARIABLE'
  | 'MISSING_TYPE_HINT'
  | 'BARE_EXCEPT'
  | 'MISSING_DOCSTRING'
  | 'MUTABLE_DEFAULT_ARG'
  | 'COMMENTED_OUT_CODE'
  | 'HARDCODED_URL'
  | 'MISSING_ENV_EXAMPLE'
  | 'CONSOLE_LOG_IN_PROD'
  | 'SINGLE_RESPONSIBILITY'
  | 'MISSING_TESTS'
  | 'PEP8_VIOLATION';

export type StyleSeverity = Extract<Severity, 'MEDIUM' | 'LOW' | 'INFO'>;
export type StyleVerdict = Extract<Verdict, 'APPROVED' | 'CHANGES_REQUESTED'>;

export interface StyleFinding {
  severity: StyleSeverity;
  category: StyleCategory;
  file: string;
  line: number;
  description: string;
  suggestion: string;
  blocks_pr: false;
}

export interface StyleAgentInput {
  session_id: string;
  pr_metadata: PRMetadata;
  diff_content: string;
  iteration: number;
  previous_findings: StyleFinding[] | null;
}

export interface StyleAgentOutput {
  agent: 'style';
  session_id: string;
  confidence: number;
  findings: StyleFinding[];
  iteration: number;
  ralph_loop_complete: boolean;
  verdict: StyleVerdict;
  checkpoint_saved: boolean;
}

// ============================================================
// Aggregator contract — aligned with agents/aggregator/schemas
// ============================================================

export interface ConflictResolution {
  file: string;
  line: number;
  resolution: 'SECURITY_WINS' | 'MERGED' | 'DEDUPLICATED';
}

export interface AggregatorInput {
  session_id: string;
  pr_metadata: PRMetadata;
  security_output: SecurityAgentOutput;
  style_output: StyleAgentOutput;
}

export interface AggregatorOutput {
  session_id: string;
  final_verdict: Verdict;
  overall_confidence: number;
  blocking_count: number;
  non_blocking_count: number;
  conflict_resolutions: ConflictResolution[];
  github_comment: string;
  github_comment_url: string | null;
  comment_posted: boolean;
  slack_notified: boolean;
  checkpoint_saved: boolean;
  completed_at: string;
}

// Tagged finding for display — knows which agent produced it
export interface TaggedFinding {
  agent: 'security' | 'style';
  finding: SecurityFinding | StyleFinding;
}

export interface OrchestratorValidateOutput {
  session_id: string;
  status: 'ELIGIBLE' | 'SKIPPED' | 'ESCALATED';
  eligible: boolean;
  skip_reason: string | null;
  subagents_to_run: Array<'security' | 'style'>;
  diff_content?: string;
  pr_metadata: PRMetadata;
  checkpoint_saved: boolean;
  escalation_reason?: EscalationReason | null;
}
