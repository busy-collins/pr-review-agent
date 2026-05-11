import type { Severity, SeverityCounts } from '@/lib/types';

// Severity-order legend used wherever counts are displayed.
const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const DOT_COLOR: Record<Severity, string> = {
  CRITICAL: 'bg-rose-600',
  HIGH:     'bg-orange-500',
  MEDIUM:   'bg-amber-400',
  LOW:      'bg-sky-500',
  INFO:     'bg-zinc-400',
};

const LABEL: Record<Severity, string> = {
  CRITICAL: 'Critical',
  HIGH:     'High',
  MEDIUM:   'Medium',
  LOW:      'Low',
  INFO:     'Info',
};

export function SeverityBar({ counts }: { counts: SeverityCounts }) {
  const visible = SEVERITY_ORDER.filter((s) => counts[s] > 0);
  if (visible.length === 0) {
    return <span className="text-xs text-zinc-500">No issues</span>;
  }
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-700">
      {visible.map((severity) => (
        <li key={severity} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className={`inline-block size-2 rounded-full ${DOT_COLOR[severity]}`}
          />
          <span className="tabular-nums font-medium">{counts[severity]}</span>
          <span className="text-zinc-500">{LABEL[severity]}</span>
        </li>
      ))}
    </ul>
  );
}
