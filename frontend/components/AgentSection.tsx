import type { Finding } from '@/lib/types';
import { FindingItem } from './FindingItem';

interface AgentSectionProps {
  agent: 'security' | 'style';
  findings: Finding[];
  confidence: number;
  iterations: number;
}

const HEADERS: Record<AgentSectionProps['agent'], { title: string; icon: string }> = {
  security: { title: 'Security agent', icon: '🔒' },
  style:    { title: 'Style agent',    icon: '✨' },
};

export function AgentSection({ agent, findings, confidence, iterations }: AgentSectionProps) {
  const header = HEADERS[agent];

  return (
    <section className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-5">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
          <span aria-hidden>{header.icon}</span>
          {header.title}
        </h3>
        <div className="flex items-center gap-4 text-xs text-zinc-600">
          <span>
            <span className="text-zinc-500">Confidence</span>{' '}
            <span className="font-mono font-semibold tabular-nums text-zinc-900">
              {confidence.toFixed(2)}
            </span>
          </span>
          <span>
            <span className="text-zinc-500">Ralph iterations</span>{' '}
            <span className="font-mono font-semibold tabular-nums text-zinc-900">
              {iterations}
            </span>
          </span>
          <span>
            <span className="text-zinc-500">Findings</span>{' '}
            <span className="font-mono font-semibold tabular-nums text-zinc-900">
              {findings.length}
            </span>
          </span>
        </div>
      </header>

      {findings.length === 0 ? (
        <p className="rounded-md border border-dashed border-zinc-200 bg-white px-4 py-6 text-center text-sm text-zinc-500">
          No findings from this agent.
        </p>
      ) : (
        <ul className="space-y-3">
          {findings.map((f, idx) => (
            <li key={`${f.file}:${f.line}:${idx}`}>
              <FindingItem finding={f} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
