import type { Verdict } from '@/lib/types';

const STYLES: Record<Verdict, { label: string; classes: string }> = {
  APPROVED: {
    label: 'Approved',
    classes: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  },
  CHANGES_REQUESTED: {
    label: 'Changes requested',
    classes: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  },
  ESCALATED: {
    label: 'Escalated',
    classes: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const style = STYLES[verdict];
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset ${style.classes}`}
    >
      {style.label}
    </span>
  );
}
