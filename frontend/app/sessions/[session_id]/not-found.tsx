import Link from 'next/link';

export default function SessionNotFound() {
  return (
    <div className="rounded-lg border border-dashed border-zinc-200 bg-white p-10 text-center">
      <h1 className="text-base font-semibold text-zinc-900">
        Session not found
      </h1>
      <p className="mt-2 text-sm text-zinc-500">
        That session id doesn&apos;t match any review in the current dataset.
      </p>
      <Link
        href="/"
        className="mt-4 inline-block text-sm font-medium text-zinc-700 underline-offset-2 hover:text-zinc-900 hover:underline"
      >
        ← Back to all reviews
      </Link>
    </div>
  );
}
