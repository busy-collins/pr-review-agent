import type { ReviewSummary, Severity, Verdict } from './types';

// ============================================================
// Aggregate metrics computed from the review list. Pure functions —
// no I/O, easy to swap once the read-API replaces mock data.
// ============================================================

export interface VerdictBreakdown {
  APPROVED: number;
  CHANGES_REQUESTED: number;
  ESCALATED: number;
}

export interface SeverityBreakdown {
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  INFO: number;
}

export interface RepoStat {
  repo: string;
  count: number;
}

export interface DailyCount {
  date: string;
  count: number;
}

export interface DashboardMetrics {
  totalReviews: number;
  verdictBreakdown: VerdictBreakdown;
  escalationRate: number;
  blockingRate: number;
  averageConfidence: number;
  averageSecurityIterations: number;
  averageStyleIterations: number;
  pipelineDurationMs: { p50: number; p95: number; max: number };
  severityTotals: SeverityBreakdown;
  topRepos: RepoStat[];
  reviewsByDay: DailyCount[];
}

export function computeMetrics(reviews: ReviewSummary[]): DashboardMetrics {
  const verdictBreakdown: VerdictBreakdown = {
    APPROVED: 0,
    CHANGES_REQUESTED: 0,
    ESCALATED: 0,
  };
  const severityTotals: SeverityBreakdown = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    INFO: 0,
  };
  const repoCounts = new Map<string, number>();
  const dayBuckets = new Map<string, number>();
  const durations: number[] = [];

  let confidenceSum = 0;
  let secIterSum = 0;
  let styleIterSum = 0;
  let blockingReviews = 0;

  for (const review of reviews) {
    verdictBreakdown[review.final_verdict]++;
    for (const sev of Object.keys(severityTotals) as Severity[]) {
      severityTotals[sev] += review.severity_counts[sev];
    }
    repoCounts.set(review.repo, (repoCounts.get(review.repo) ?? 0) + 1);

    const day = review.created_at.slice(0, 10);
    dayBuckets.set(day, (dayBuckets.get(day) ?? 0) + 1);

    durations.push(Date.parse(review.updated_at) - Date.parse(review.created_at));

    confidenceSum += review.overall_confidence;
    secIterSum += review.security_iterations;
    styleIterSum += review.style_iterations;
    if (review.blocking_count > 0) blockingReviews++;
  }

  const total = reviews.length || 1; // avoid /0 in averages on empty input

  const topRepos: RepoStat[] = [...repoCounts.entries()]
    .map(([repo, count]) => ({ repo, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const reviewsByDay: DailyCount[] = [...dayBuckets.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    totalReviews: reviews.length,
    verdictBreakdown,
    escalationRate: verdictBreakdown.ESCALATED / total,
    blockingRate: blockingReviews / total,
    averageConfidence: confidenceSum / total,
    averageSecurityIterations: secIterSum / total,
    averageStyleIterations: styleIterSum / total,
    pipelineDurationMs: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      max: durations.length > 0 ? Math.max(...durations) : 0,
    },
    severityTotals,
    topRepos,
    reviewsByDay,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

const VERDICT_LABELS: Record<Verdict, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes',
  ESCALATED: 'Escalated',
};

export function verdictLabel(verdict: Verdict): string {
  return VERDICT_LABELS[verdict];
}
