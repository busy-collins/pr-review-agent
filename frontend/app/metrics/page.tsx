import Link from 'next/link';
import { MetricStat } from '@/components/MetricStat';
import { VerdictDistribution } from '@/components/VerdictDistribution';
import {
  computeMetrics,
  formatDuration,
  formatPercent,
  type DashboardMetrics,
} from '@/lib/metrics';
import { getReviews } from '@/lib/mock-data';
import type { Severity } from '@/lib/types';

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const SEVERITY_COLOR: Record<Severity, string> = {
  CRITICAL: 'bg-rose-600',
  HIGH:     'bg-orange-500',
  MEDIUM:   'bg-amber-400',
  LOW:      'bg-sky-500',
  INFO:     'bg-zinc-400',
};

const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: 'Critical',
  HIGH:     'High',
  MEDIUM:   'Medium',
  LOW:      'Low',
  INFO:     'Info',
};

export default function MetricsPage() {
  const reviews = getReviews();
  const metrics = computeMetrics(reviews);

  return (
    <>
      <nav className="mb-6 text-sm">
        <Link
          href="/"
          className="text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
        >
          ← All reviews
        </Link>
      </nav>

      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          Pipeline metrics
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          Aggregate statistics across {metrics.totalReviews} reviews.
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricStat
          label="Total reviews"
          value={metrics.totalReviews}
        />
        <MetricStat
          label="Escalation rate"
          value={formatPercent(metrics.escalationRate)}
          emphasis={metrics.escalationRate > 0.2 ? 'negative' : 'neutral'}
          caption="Verdicts requiring human review"
        />
        <MetricStat
          label="Blocking rate"
          value={formatPercent(metrics.blockingRate)}
          emphasis={metrics.blockingRate > 0.3 ? 'negative' : 'neutral'}
          caption="PRs with ≥1 CRITICAL/HIGH"
        />
        <MetricStat
          label="Avg confidence"
          value={metrics.averageConfidence.toFixed(2)}
          emphasis={metrics.averageConfidence >= 0.85 ? 'positive' : 'neutral'}
          caption="Pipeline output mean"
        />
      </dl>

      <section className="mt-10">
        <SectionHeader title="Verdict distribution" />
        <div className="rounded-lg border border-zinc-200 bg-white p-5">
          <VerdictDistribution breakdown={metrics.verdictBreakdown} />
        </div>
      </section>

      <section className="mt-8">
        <SectionHeader title="Pipeline runtime" />
        <dl className="grid grid-cols-3 gap-3">
          <MetricStat
            label="p50"
            value={formatDuration(metrics.pipelineDurationMs.p50)}
          />
          <MetricStat
            label="p95"
            value={formatDuration(metrics.pipelineDurationMs.p95)}
          />
          <MetricStat
            label="Max"
            value={formatDuration(metrics.pipelineDurationMs.max)}
          />
        </dl>
      </section>

      <section className="mt-8">
        <SectionHeader title="Findings by severity" />
        <SeverityTotals metrics={metrics} />
      </section>

      <section className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <SectionHeader title="Ralph loop iterations" />
          <dl className="grid grid-cols-2 gap-3">
            <MetricStat
              label="Avg security"
              value={metrics.averageSecurityIterations.toFixed(2)}
              caption="Across all sessions"
            />
            <MetricStat
              label="Avg style"
              value={metrics.averageStyleIterations.toFixed(2)}
              caption="Across all sessions"
            />
          </dl>
        </div>

        <div>
          <SectionHeader title="Top repos by activity" />
          <ul className="rounded-md border border-zinc-200 bg-white">
            {metrics.topRepos.map((row, idx) => (
              <li
                key={row.repo}
                className={`flex items-center justify-between px-4 py-2.5 text-sm ${
                  idx > 0 ? 'border-t border-zinc-100' : ''
                }`}
              >
                <span className="font-mono text-zinc-900">{row.repo}</span>
                <span className="font-mono text-xs text-zinc-500 tabular-nums">
                  {row.count} review{row.count === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mt-8">
        <SectionHeader title="Daily throughput" />
        <DailyThroughput metrics={metrics} />
      </section>
    </>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
      {title}
    </h2>
  );
}

function SeverityTotals({ metrics }: { metrics: DashboardMetrics }) {
  const total = SEVERITY_ORDER.reduce(
    (sum, sev) => sum + metrics.severityTotals[sev],
    0
  );

  if (total === 0) {
    return (
      <p className="rounded-md border border-dashed border-zinc-200 bg-white p-4 text-center text-sm text-zinc-500">
        No findings reported across recent reviews.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <ul className="space-y-2">
        {SEVERITY_ORDER.map((sev) => {
          const count = metrics.severityTotals[sev];
          const pct = total === 0 ? 0 : (count / total) * 100;
          return (
            <li key={sev} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs font-medium text-zinc-700">
                {SEVERITY_LABEL[sev]}
              </span>
              <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-zinc-100">
                <span
                  className={`absolute inset-y-0 left-0 ${SEVERITY_COLOR[sev]}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="w-10 shrink-0 text-right font-mono text-xs font-semibold tabular-nums text-zinc-900">
                {count}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DailyThroughput({ metrics }: { metrics: DashboardMetrics }) {
  if (metrics.reviewsByDay.length === 0) {
    return null;
  }
  const max = Math.max(...metrics.reviewsByDay.map((d) => d.count));

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <ul className="flex items-end justify-between gap-2">
        {metrics.reviewsByDay.map((day) => {
          const heightPct = max === 0 ? 0 : (day.count / max) * 100;
          return (
            <li key={day.date} className="flex flex-1 flex-col items-center gap-1">
              <span className="font-mono text-xs font-semibold tabular-nums text-zinc-900">
                {day.count}
              </span>
              <span className="relative h-24 w-full max-w-[28px] overflow-hidden rounded-t-sm bg-zinc-100">
                <span
                  className="absolute inset-x-0 bottom-0 bg-zinc-700"
                  style={{ height: `${heightPct}%` }}
                />
              </span>
              <span className="font-mono text-[10px] text-zinc-500">
                {day.date.slice(5)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
