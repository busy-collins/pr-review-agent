import type { Severity } from '@/lib/types';

const STYLES: Record<Severity, string> = {
  CRITICAL: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  HIGH:     'bg-orange-50 text-orange-700 ring-orange-600/20',
  MEDIUM:   'bg-amber-50 text-amber-800 ring-amber-600/20',
  LOW:      'bg-sky-50 text-sky-700 ring-sky-600/20',
  INFO:     'bg-zinc-100 text-zinc-700 ring-zinc-500/20',
};

export function SeverityChip({ severity }: { severity: Severity }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${STYLES[severity]}`}
    >
      {severity}
    </span>
  );
}
