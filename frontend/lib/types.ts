// ============================================================
// Frontend types — mirror the backend session-table schema from
// infrastructure/database/dynamodb.schema.md. Kept independent of
// the backend's `shared/types.ts` so the dashboard is its own
// deployable unit. The backing JSON schemas remain the source of
// truth; if these drift, an integration test will surface it.
// ============================================================

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type Verdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'ESCALATED';
export type SessionStatus =
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'ESCALATED';

export interface SeverityCounts {
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  INFO: number;
}

export interface ReviewSummary {
  session_id: string;
  repo: string;
  pr_number: number;
  sender: string;
  status: SessionStatus;
  final_verdict: Verdict;
  overall_confidence: number;
  blocking_count: number;
  non_blocking_count: number;
  severity_counts: SeverityCounts;
  security_iterations: number;
  style_iterations: number;
  created_at: string;
  updated_at: string;
  github_comment_url: string | null;
}

// ============================================================
// Drill-down detail. Mirrors what the Aggregator emits plus the
// raw findings from each SubAgent — schema source of truth lives in
// agents/*/schemas/*.json.
// ============================================================
export interface Finding {
  agent: 'security' | 'style';
  severity: Severity;
  category: string;
  file: string;
  line: number;
  description: string;
  suggestion: string;
  blocks_pr: boolean;
  code_example?: string;
  owasp_reference?: string;
}

export interface ReviewDetail extends ReviewSummary {
  security_findings: Finding[];
  style_findings: Finding[];
  security_confidence: number;
  style_confidence: number;
  github_comment_body: string;
}
