import type { ReactNode } from 'react';

export function MetricStat({
  label,
  value,
  caption,
  emphasis,
}: {
  label: string;
  value: ReactNode;
  caption?: string;
  emphasis?: 'positive' | 'negative' | 'neutral';
}) {
  const valueColor =
    emphasis === 'positive'
      ? 'text-emerald-700'
      : emphasis === 'negative'
        ? 'text-rose-700'
        : 'text-zinc-900';

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd
        className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${valueColor}`}
      >
        {value}
      </dd>
      {caption && (
        <p className="mt-1 text-xs text-zinc-500">{caption}</p>
      )}
    </div>
  );
}
