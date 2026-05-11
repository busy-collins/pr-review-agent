import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'PR Review Agent — Dashboard',
  description:
    'Observability for the automated PR review pipeline: history, findings, and per-agent diagnostics.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full antialiased">
        <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-8">
          {children}
        </div>
      </body>
    </html>
  );
}
