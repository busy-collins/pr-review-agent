import type { VerdictBreakdown } from '@/lib/metrics';
import { verdictLabel } from '@/lib/metrics';
import type { Verdict } from '@/lib/types';

const COLOR: Record<Verdict, string> = {
  APPROVED:           'bg-emerald-500',
  CHANGES_REQUESTED:  'bg-amber-500',
  ESCALATED:          'bg-rose-500',
};

export function VerdictDistribution({ breakdown }: { breakdown: VerdictBreakdown }) {
  const total =
    breakdown.APPROVED + breakdown.CHANGES_REQUESTED + breakdown.ESCALATED;
  const order: Verdict[] = ['APPROVED', 'CHANGES_REQUESTED', 'ESCALATED'];

  if (total === 0) {
    return (
      <p className="text-sm text-zinc-500">No reviews to summarize yet.</p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-100">
        {order.map((v) => {
          const pct = (breakdown[v] / total) * 100;
          if (pct === 0) return null;
          return (
            <span
              key={v}
              className={COLOR[v]}
              style={{ width: `${pct}%` }}
              aria-label={`${verdictLabel(v)} ${pct.toFixed(0)}%`}
            />
          );
        })}
      </div>
      <dl className="grid grid-cols-3 gap-3 text-sm">
        {order.map((v) => (
          <div key={v} className="flex items-baseline gap-2">
            <span
              aria-hidden
              className={`inline-block size-2.5 rounded-full ${COLOR[v]}`}
            />
            <span className="font-mono font-semibold tabular-nums text-zinc-900">
              {breakdown[v]}
            </span>
            <span className="text-xs text-zinc-500">{verdictLabel(v)}</span>
          </div>
        ))}
      </dl>
    </div>
  );
}
