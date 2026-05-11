import Link from 'next/link';
import type { ReviewSummary } from '@/lib/types';
import { durationBetween, relativeTime } from '@/lib/format';
import { SeverityBar } from './SeverityBar';
import { VerdictBadge } from './VerdictBadge';

export function ReviewCard({ review }: { review: ReviewSummary }) {
  const reviewDuration = durationBetween(review.created_at, review.updated_at);

  return (
    <Link
      href={`/sessions/${review.session_id}/`}
      className="block rounded-lg border border-zinc-200 bg-white p-5 transition hover:border-zinc-400 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-baseline gap-2 text-base font-semibold text-zinc-900">
            <span className="font-mono">{review.repo}</span>
            <span className="text-zinc-400">#{review.pr_number}</span>
          </h3>
          <p className="mt-0.5 text-sm text-zinc-500">
            Opened by{' '}
            <span className="font-medium text-zinc-700">@{review.sender}</span>{' '}
            • Reviewed {relativeTime(review.updated_at)} • {reviewDuration} runtime
          </p>
        </div>
        <VerdictBadge verdict={review.final_verdict} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            Confidence
          </span>
          <span className="font-mono text-zinc-900 tabular-nums">
            {review.overall_confidence.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            Blocking
          </span>
          <span className="font-mono text-zinc-900 tabular-nums">
            {review.blocking_count}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-zinc-500">
            Ralph iters
          </span>
          <span className="font-mono text-zinc-700 tabular-nums">
            sec {review.security_iterations} / style {review.style_iterations}
          </span>
        </div>
      </div>

      <div className="mt-3">
        <SeverityBar counts={review.severity_counts} />
      </div>

      <footer className="mt-4 flex items-center justify-between border-t border-zinc-100 pt-3 text-xs">
        <code className="font-mono text-zinc-500">{review.session_id}</code>
        <span className="text-zinc-500">
          View details <span aria-hidden>→</span>
        </span>
      </footer>
    </Link>
  );
}
