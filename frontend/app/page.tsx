import Link from 'next/link';
import { ReviewCard } from '@/components/ReviewCard';
import { getReviews } from '@/lib/mock-data';
import type { ReviewSummary, Verdict } from '@/lib/types';

export default function DashboardPage() {
  const reviews = getReviews();
  const stats = computeHeaderStats(reviews);

  return (
    <>
      <header className="mb-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              PR Review Agent
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Recent reviews across all monitored repositories.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/metrics/"
              className="rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-zinc-400 hover:text-zinc-900"
            >
              Metrics →
            </Link>
            <span
              aria-label="Data source"
              className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600"
              title="Backed by mock data — wire to the read API in a follow-up phase."
            >
              Mock data
            </span>
          </div>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total reviews" value={stats.total.toString()} />
          <Stat label="Approved" value={stats.approved.toString()} />
          <Stat label="Changes requested" value={stats.changesRequested.toString()} />
          <Stat label="Escalated" value={stats.escalated.toString()} />
        </dl>
      </header>

      <main className="flex-1">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
          Recent reviews
        </h2>
        {reviews.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">
            No reviews yet. They will appear here as the pipeline processes PRs.
          </p>
        ) : (
          <ul className="space-y-3">
            {reviews.map((review) => (
              <li key={review.session_id}>
                <ReviewCard review={review} />
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="mt-10 border-t border-zinc-200 pt-4 text-xs text-zinc-500">
        Dashboard for the PR Review Agent pipeline. Build: static export ·
        Phase 6 (MVP).
      </footer>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white px-3 py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-zinc-900">
        {value}
      </dd>
    </div>
  );
}

interface HeaderStats {
  total: number;
  approved: number;
  changesRequested: number;
  escalated: number;
}

function computeHeaderStats(reviews: ReviewSummary[]): HeaderStats {
  const acc: HeaderStats = {
    total: reviews.length,
    approved: 0,
    changesRequested: 0,
    escalated: 0,
  };
  const bucket: Record<Verdict, keyof HeaderStats> = {
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'changesRequested',
    ESCALATED: 'escalated',
  };
  for (const r of reviews) acc[bucket[r.final_verdict]]++;
  return acc;
}
