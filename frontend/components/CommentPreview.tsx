// Renders the raw Markdown body that the Aggregator posts to GitHub.
// We deliberately don't render the Markdown here — operators want to see
// exactly what was posted, not a re-rendered version.
export function CommentPreview({ body }: { body: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-white p-4 font-mono text-xs leading-5 text-zinc-800 whitespace-pre-wrap">
      {body}
    </pre>
  );
}
