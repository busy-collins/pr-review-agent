import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AgentSection } from '@/components/AgentSection';
import { CommentPreview } from '@/components/CommentPreview';
import { VerdictBadge } from '@/components/VerdictBadge';
import { durationBetween, relativeTime } from '@/lib/format';
import { getAllSessionIds, getReviewById } from '@/lib/mock-data';
import type { ReviewDetail } from '@/lib/types';

// ============================================================
// Static-export support: pre-render one HTML page per known
// session id. When the read-API lands, swap to a client-side
// fetch or a build-time index.
// ============================================================
export function generateStaticParams() {
  return getAllSessionIds().map((session_id) => ({ session_id }));
}

interface PageProps {
  params: { session_id: string };
}

export default function SessionDetailPage({ params }: PageProps) {
  const review = getReviewById(params.session_id);
  if (!review) notFound();

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

      <SessionHeader review={review} />

      <div className="mt-8 space-y-6">
        <AgentSection
          agent="security"
          findings={review.security_findings}
          confidence={review.security_confidence}
          iterations={review.security_iterations}
        />
        <AgentSection
          agent="style"
          findings={review.style_findings}
          confidence={review.style_confidence}
          iterations={review.style_iterations}
        />

        <section>
          <header className="mb-2 flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-zinc-900">
              Posted GitHub comment
            </h3>
            {review.github_comment_url ? (
              <a
                href={review.github_comment_url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
              >
                View on GitHub ↗
              </a>
            ) : (
              <span className="text-xs text-zinc-400">
                No comment was posted
              </span>
            )}
          </header>
          <CommentPreview body={review.github_comment_body} />
        </section>
      </div>
    </>
  );
}

function SessionHeader({ review }: { review: ReviewDetail }) {
  const reviewDuration = durationBetween(review.created_at, review.updated_at);

  return (
    <header>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-baseline gap-2 text-2xl font-semibold tracking-tight text-zinc-900">
            <span className="font-mono">{review.repo}</span>
            <span className="text-zinc-400">#{review.pr_number}</span>
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Opened by{' '}
            <span className="font-medium text-zinc-700">@{review.sender}</span>{' '}
            • Reviewed {relativeTime(review.updated_at)} • {reviewDuration} runtime
          </p>
        </div>
        <VerdictBadge verdict={review.final_verdict} />
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Overall confidence"
          value={review.overall_confidence.toFixed(2)}
        />
        <Stat label="Blocking issues" value={review.blocking_count.toString()} />
        <Stat
          label="Non-blocking"
          value={review.non_blocking_count.toString()}
        />
        <Stat label="Pipeline status" value={review.status} />
      </dl>

      <p className="mt-4 font-mono text-xs text-zinc-500">{review.session_id}</p>
    </header>
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
