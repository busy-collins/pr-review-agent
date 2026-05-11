import type { Finding } from '@/lib/types';
import { SeverityChip } from './SeverityChip';

export function FindingItem({ finding }: { finding: Finding }) {
  return (
    <article className="rounded-md border border-zinc-200 bg-white p-4">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <SeverityChip severity={finding.severity} />
        <code className="text-xs font-semibold text-zinc-800">
          {finding.category}
        </code>
        <span className="font-mono text-xs text-zinc-500">
          {finding.file}:{finding.line}
        </span>
        {finding.blocks_pr && (
          <span className="ml-auto rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
            Blocks PR
          </span>
        )}
      </header>

      <p className="mt-2 text-sm leading-6 text-zinc-800">
        {finding.description}
      </p>

      <div className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-sm leading-6 text-zinc-700">
        <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Fix
        </span>
        {finding.suggestion}
      </div>

      {finding.code_example && (
        <pre className="mt-3 overflow-x-auto rounded-md bg-zinc-900 p-3 text-xs leading-5 text-zinc-100">
          <code>{finding.code_example}</code>
        </pre>
      )}

      {finding.owasp_reference && (
        <p className="mt-3 text-xs text-zinc-500">
          <span className="font-medium text-zinc-600">Reference:</span>{' '}
          {finding.owasp_reference}
        </p>
      )}
    </article>
  );
}
