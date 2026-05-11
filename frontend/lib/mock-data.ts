import type { Finding, ReviewDetail, ReviewSummary, SeverityCounts } from './types';

// ============================================================
// Mock dashboard data. Shape mirrors what we'd Query out of the
// DynamoDB session table once the backend API is wired up.
// Replace this module with real fetch() calls when the read-API
// Lambda lands.
// ============================================================

const empty: SeverityCounts = {
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
  INFO: 0,
};

// ============================================================
// Per-session findings. Kept inline so it's easy to scan and edit.
// ============================================================
const paymentsCriticalFindings: Finding[] = [
  {
    agent: 'security',
    severity: 'CRITICAL',
    category: 'HARDCODED_SECRET',
    file: 'services/billing/stripe-client.ts',
    line: 14,
    description:
      'Stripe live secret key is hardcoded in the file. This key is now in git history and will be flagged by GitHub secret scanning.',
    suggestion:
      'Move the key to AWS Secrets Manager and read it via the existing secrets helper. Rotate the leaked key immediately.',
    blocks_pr: true,
    owasp_reference: 'A05:2021 — Security Misconfiguration',
    code_example:
      "const stripe = new Stripe(await getSecret('stripe/live-secret'));",
  },
  {
    agent: 'security',
    severity: 'MEDIUM',
    category: 'PII_EXPOSURE',
    file: 'services/billing/audit.ts',
    line: 88,
    description:
      'Customer email is logged at info level before the payment intent succeeds.',
    suggestion: 'Redact the email or drop the field — audit logs should never contain unhashed PII.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'MEDIUM',
    category: 'NO_ANY_TYPE',
    file: 'services/billing/stripe-client.ts',
    line: 22,
    description: '`error: any` in catch — widens the error contract and disables narrowing downstream.',
    suggestion: 'Type as `error: unknown` and narrow with `instanceof Stripe.errors.StripeError`.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'LOW',
    category: 'UNUSED_IMPORT',
    file: 'services/billing/audit.ts',
    line: 3,
    description: '`import { format } from "date-fns"` is no longer referenced after the timestamp refactor.',
    suggestion: 'Remove the import.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'LOW',
    category: 'CONSOLE_LOG_IN_PROD',
    file: 'services/billing/stripe-client.ts',
    line: 47,
    description: 'console.log left in after debugging the webhook retry path.',
    suggestion: 'Replace with the structured logger or remove.',
    blocks_pr: false,
  },
];

const ingestChangesFindings: Finding[] = [
  {
    agent: 'security',
    severity: 'HIGH',
    category: 'SQL_INJECTION',
    file: 'services/ingest/query-builder.ts',
    line: 134,
    description:
      'User-supplied `sortKey` is interpolated directly into the ORDER BY clause.',
    suggestion:
      'Whitelist allowed sort columns and reject any value not in the set before building the query.',
    blocks_pr: true,
    owasp_reference: 'A03:2021 — Injection',
    code_example:
      "const allowed = ['createdAt', 'updatedAt']; if (!allowed.includes(sortKey)) throw new Error('bad sort');",
  },
  {
    agent: 'security',
    severity: 'HIGH',
    category: 'AUTH_BYPASS',
    file: 'services/ingest/handlers/admin.ts',
    line: 19,
    description:
      'The admin handler reads `x-user-role` from request headers and trusts it.',
    suggestion:
      'Derive the role from the verified JWT claims, not from a client-set header.',
    blocks_pr: true,
    owasp_reference: 'A01:2021 — Broken Access Control',
  },
  {
    agent: 'style',
    severity: 'MEDIUM',
    category: 'FUNCTION_TOO_LONG',
    file: 'services/ingest/query-builder.ts',
    line: 60,
    description: '`buildAggregateQuery` is 74 lines; project standard is 40.',
    suggestion: 'Extract the GROUP BY assembly into a helper.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'LOW',
    category: 'COMMENTED_OUT_CODE',
    file: 'services/ingest/handlers/admin.ts',
    line: 7,
    description: 'Five lines of commented legacy auth check from the pre-JWT migration.',
    suggestion: 'Delete it — git history preserves it.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'LOW',
    category: 'SINGLE_LETTER_VARIABLE',
    file: 'services/ingest/query-builder.ts',
    line: 91,
    description: '`r` as a loop variable inside a 30-line block makes the body hard to follow.',
    suggestion: 'Rename to `row`.',
    blocks_pr: false,
  },
];

const webApprovedFindings: Finding[] = [
  {
    agent: 'style',
    severity: 'INFO',
    category: 'MISSING_TESTS',
    file: 'apps/web/components/UserMenu.tsx',
    line: 28,
    description: 'New keyboard-shortcut handler has no test coverage.',
    suggestion: 'Add a Vitest case verifying Escape and Tab focus management.',
    blocks_pr: false,
  },
];

const authEscalatedFindings: Finding[] = [
  {
    agent: 'security',
    severity: 'MEDIUM',
    category: 'JWT_BYPASS',
    file: 'services/auth/jwt.ts',
    line: 51,
    description:
      'Token verification uses `algorithm: \'HS256\'` but accepts tokens signed with `\'none\'` via fallback.',
    suggestion:
      'Pass `algorithms: [\'HS256\']` explicitly to jwt.verify and remove the fallback branch.',
    blocks_pr: false,
    owasp_reference: 'A02:2021 — Cryptographic Failures',
  },
  {
    agent: 'style',
    severity: 'LOW',
    category: 'MISSING_TYPE_HINT',
    file: 'services/auth/jwt.ts',
    line: 12,
    description: 'Return type of `decodePayload` is inferred but ambiguous.',
    suggestion: 'Annotate as `: JwtPayload | null` for downstream clarity.',
    blocks_pr: false,
  },
];

const billingHighFindings: Finding[] = [
  {
    agent: 'security',
    severity: 'HIGH',
    category: 'BOLA',
    file: 'services/billing/invoices.ts',
    line: 102,
    description:
      'Invoice fetch trusts `invoiceId` from the path without verifying it belongs to the requesting tenant.',
    suggestion:
      'Add a tenant-scope check: `WHERE invoiceId = $1 AND tenantId = $2`.',
    blocks_pr: true,
    owasp_reference: 'A01:2021 — Broken Access Control',
  },
  {
    agent: 'style',
    severity: 'MEDIUM',
    category: 'MISSING_ERROR_HANDLING',
    file: 'services/billing/invoices.ts',
    line: 88,
    description: 'The Stripe API call is not wrapped in try/catch.',
    suggestion: 'Catch StripeError and translate to a domain error before bubbling.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'MEDIUM',
    category: 'NO_ANY_TYPE',
    file: 'services/billing/invoices.ts',
    line: 12,
    description: '`invoice: any` parameter type.',
    suggestion: 'Use `Stripe.Invoice` from the SDK.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'MEDIUM',
    category: 'HARDCODED_URL',
    file: 'services/billing/webhook-handler.ts',
    line: 33,
    description: 'Production Stripe webhook URL hardcoded.',
    suggestion: 'Move to env var `STRIPE_WEBHOOK_URL`.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'LOW',
    category: 'PEP8_VIOLATION',
    file: 'scripts/reconcile.py',
    line: 14,
    description: 'Line length 121 exceeds project limit of 100.',
    suggestion: 'Break the dict literal across multiple lines.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'LOW',
    category: 'MISSING_DOCSTRING',
    file: 'scripts/reconcile.py',
    line: 4,
    description: '`reconcile_invoices` public function has no docstring.',
    suggestion: 'Add a one-paragraph summary describing inputs, outputs, and side effects.',
    blocks_pr: false,
  },
];

const cliLowFindings: Finding[] = [
  {
    agent: 'style',
    severity: 'LOW',
    category: 'UNUSED_IMPORT',
    file: 'packages/cli/src/commands/deploy.ts',
    line: 4,
    description: '`import chalk` is unused after the spinner refactor.',
    suggestion: 'Remove.',
    blocks_pr: false,
  },
  {
    agent: 'style',
    severity: 'LOW',
    category: 'CONSOLE_LOG_IN_PROD',
    file: 'packages/cli/src/commands/deploy.ts',
    line: 67,
    description: 'console.log for debug output mixed with production code path.',
    suggestion: 'Gate behind --verbose flag or remove.',
    blocks_pr: false,
  },
];

// ============================================================
// Comment-body templates. Mirror what the backend Aggregator
// renders via agents/aggregator/src/formatter.ts.
// ============================================================
function renderComment(opts: {
  verdict: ReviewSummary['final_verdict'];
  findings: Finding[];
  summary: string;
  sessionId: string;
  confidence: number;
  blockingCount: number;
  nonBlockingCount: number;
}): string {
  const verdictLine = {
    APPROVED: '✅ **APPROVED**',
    CHANGES_REQUESTED: '⚠️ **CHANGES REQUESTED**',
    ESCALATED: '🚨 **ESCALATED** — Human review required',
  }[opts.verdict];

  const findingsSection =
    opts.findings.length === 0
      ? '_No issues to report._'
      : opts.findings
          .map(
            (f) =>
              `- **\`${f.category}\`** in \`${f.file}:${f.line}\`  _(${f.agent === 'security' ? '🔒 Security' : '✨ Style'})_\n  - ${f.description}\n  - **Fix:** ${f.suggestion}`
          )
          .join('\n\n');

  return [
    '## 🤖 Automated PR Review',
    '',
    '### Summary',
    opts.summary,
    '',
    '### Issues Found',
    findingsSection,
    '',
    '### Verdict',
    verdictLine,
    '',
    `**Blocking issues:** ${opts.blockingCount} | **Non-blocking:** ${opts.nonBlockingCount}`,
    '',
    '---',
    `_Reviewed by PR Review Agent | Session: \`${opts.sessionId}\` | Confidence: \`${opts.confidence.toFixed(2)}\`_`,
  ].join('\n');
}

// ============================================================
// Mock review details. Detail objects extend the summary shape.
// ============================================================
const reviewsDetail: ReviewDetail[] = [
  {
    session_id: 'pr-acme-payments-1284-1746128400',
    repo: 'acme/payments',
    pr_number: 1284,
    sender: 'mira.l',
    status: 'ESCALATED',
    final_verdict: 'ESCALATED',
    overall_confidence: 0.92,
    security_confidence: 0.94,
    style_confidence: 0.9,
    blocking_count: 1,
    non_blocking_count: 4,
    severity_counts: { ...empty, CRITICAL: 1, MEDIUM: 2, LOW: 2 },
    security_iterations: 2,
    style_iterations: 1,
    created_at: '2026-05-11T13:50:00Z',
    updated_at: '2026-05-11T13:52:18Z',
    github_comment_url: 'https://github.com/acme/payments/pull/1284#issuecomment-901',
    security_findings: paymentsCriticalFindings.filter((f) => f.agent === 'security'),
    style_findings: paymentsCriticalFindings.filter((f) => f.agent === 'style'),
    github_comment_body: renderComment({
      verdict: 'ESCALATED',
      findings: paymentsCriticalFindings,
      summary:
        'Found 1 blocking issue and 4 suggestion(s). This PR requires human review — see issues below.',
      sessionId: 'pr-acme-payments-1284-1746128400',
      confidence: 0.92,
      blockingCount: 1,
      nonBlockingCount: 4,
    }),
  },
  {
    session_id: 'pr-acme-ingest-877-1746127200',
    repo: 'acme/ingest',
    pr_number: 877,
    sender: 'devon.k',
    status: 'COMPLETED',
    final_verdict: 'CHANGES_REQUESTED',
    overall_confidence: 0.88,
    security_confidence: 0.86,
    style_confidence: 0.9,
    blocking_count: 2,
    non_blocking_count: 3,
    severity_counts: { ...empty, HIGH: 2, MEDIUM: 1, LOW: 2 },
    security_iterations: 2,
    style_iterations: 1,
    created_at: '2026-05-11T13:30:00Z',
    updated_at: '2026-05-11T13:31:42Z',
    github_comment_url: 'https://github.com/acme/ingest/pull/877#issuecomment-902',
    security_findings: ingestChangesFindings.filter((f) => f.agent === 'security'),
    style_findings: ingestChangesFindings.filter((f) => f.agent === 'style'),
    github_comment_body: renderComment({
      verdict: 'CHANGES_REQUESTED',
      findings: ingestChangesFindings,
      summary:
        'Found 2 blocking issue(s) and 3 suggestion(s). Please address the blocking items before merging.',
      sessionId: 'pr-acme-ingest-877-1746127200',
      confidence: 0.88,
      blockingCount: 2,
      nonBlockingCount: 3,
    }),
  },
  {
    session_id: 'pr-acme-web-2210-1746124800',
    repo: 'acme/web',
    pr_number: 2210,
    sender: 'priya.s',
    status: 'COMPLETED',
    final_verdict: 'APPROVED',
    overall_confidence: 0.96,
    security_confidence: 0.97,
    style_confidence: 0.95,
    blocking_count: 0,
    non_blocking_count: 1,
    severity_counts: { ...empty, INFO: 1 },
    security_iterations: 1,
    style_iterations: 1,
    created_at: '2026-05-11T12:50:00Z',
    updated_at: '2026-05-11T12:51:09Z',
    github_comment_url: 'https://github.com/acme/web/pull/2210#issuecomment-903',
    security_findings: [],
    style_findings: webApprovedFindings,
    github_comment_body: renderComment({
      verdict: 'APPROVED',
      findings: webApprovedFindings,
      summary:
        'No blocking issues, 1 non-blocking suggestion. These are advisory; the PR is not blocked.',
      sessionId: 'pr-acme-web-2210-1746124800',
      confidence: 0.96,
      blockingCount: 0,
      nonBlockingCount: 1,
    }),
  },
  {
    session_id: 'pr-acme-platform-4471-1746118800',
    repo: 'acme/platform',
    pr_number: 4471,
    sender: 'noah.t',
    status: 'COMPLETED',
    final_verdict: 'APPROVED',
    overall_confidence: 0.99,
    security_confidence: 0.99,
    style_confidence: 0.99,
    blocking_count: 0,
    non_blocking_count: 0,
    severity_counts: { ...empty },
    security_iterations: 1,
    style_iterations: 1,
    created_at: '2026-05-11T11:20:00Z',
    updated_at: '2026-05-11T11:20:55Z',
    github_comment_url: 'https://github.com/acme/platform/pull/4471#issuecomment-904',
    security_findings: [],
    style_findings: [],
    github_comment_body: renderComment({
      verdict: 'APPROVED',
      findings: [],
      summary:
        'No issues found in the changed lines. The PR looks clean from both security and style perspectives.',
      sessionId: 'pr-acme-platform-4471-1746118800',
      confidence: 0.99,
      blockingCount: 0,
      nonBlockingCount: 0,
    }),
  },
  {
    session_id: 'pr-acme-auth-318-1746115200',
    repo: 'acme/auth',
    pr_number: 318,
    sender: 'sam.q',
    status: 'ESCALATED',
    final_verdict: 'ESCALATED',
    overall_confidence: 0.82,
    security_confidence: 0.78,
    style_confidence: 0.86,
    blocking_count: 0,
    non_blocking_count: 2,
    severity_counts: { ...empty, MEDIUM: 1, LOW: 1 },
    security_iterations: 3,
    style_iterations: 2,
    created_at: '2026-05-11T10:20:00Z',
    updated_at: '2026-05-11T10:24:11Z',
    github_comment_url: 'https://github.com/acme/auth/pull/318#issuecomment-905',
    security_findings: authEscalatedFindings.filter((f) => f.agent === 'security'),
    style_findings: authEscalatedFindings.filter((f) => f.agent === 'style'),
    github_comment_body: renderComment({
      verdict: 'ESCALATED',
      findings: authEscalatedFindings,
      summary:
        'Found 0 blocking issue(s) and 2 suggestion(s). This PR touches authentication logic — human review required regardless of agent verdict.',
      sessionId: 'pr-acme-auth-318-1746115200',
      confidence: 0.82,
      blockingCount: 0,
      nonBlockingCount: 2,
    }),
  },
  {
    session_id: 'pr-acme-billing-91-1746104400',
    repo: 'acme/billing',
    pr_number: 91,
    sender: 'jordan.f',
    status: 'COMPLETED',
    final_verdict: 'CHANGES_REQUESTED',
    overall_confidence: 0.9,
    security_confidence: 0.93,
    style_confidence: 0.87,
    blocking_count: 1,
    non_blocking_count: 5,
    severity_counts: { ...empty, HIGH: 1, MEDIUM: 3, LOW: 2 },
    security_iterations: 2,
    style_iterations: 2,
    created_at: '2026-05-11T07:20:00Z',
    updated_at: '2026-05-11T07:22:34Z',
    github_comment_url: 'https://github.com/acme/billing/pull/91#issuecomment-906',
    security_findings: billingHighFindings.filter((f) => f.agent === 'security'),
    style_findings: billingHighFindings.filter((f) => f.agent === 'style'),
    github_comment_body: renderComment({
      verdict: 'CHANGES_REQUESTED',
      findings: billingHighFindings,
      summary:
        'Found 1 blocking issue and 5 suggestion(s). Please address the blocking items before merging.',
      sessionId: 'pr-acme-billing-91-1746104400',
      confidence: 0.9,
      blockingCount: 1,
      nonBlockingCount: 5,
    }),
  },
  {
    session_id: 'pr-acme-cli-5527-1746086400',
    repo: 'acme/cli',
    pr_number: 5527,
    sender: 'wren.b',
    status: 'COMPLETED',
    final_verdict: 'APPROVED',
    overall_confidence: 0.94,
    security_confidence: 0.96,
    style_confidence: 0.92,
    blocking_count: 0,
    non_blocking_count: 2,
    severity_counts: { ...empty, LOW: 2 },
    security_iterations: 1,
    style_iterations: 1,
    created_at: '2026-05-11T02:20:00Z',
    updated_at: '2026-05-11T02:21:05Z',
    github_comment_url: 'https://github.com/acme/cli/pull/5527#issuecomment-907',
    security_findings: [],
    style_findings: cliLowFindings,
    github_comment_body: renderComment({
      verdict: 'APPROVED',
      findings: cliLowFindings,
      summary:
        'No blocking issues, 2 non-blocking suggestion(s). These are advisory; the PR is not blocked.',
      sessionId: 'pr-acme-cli-5527-1746086400',
      confidence: 0.94,
      blockingCount: 0,
      nonBlockingCount: 2,
    }),
  },
  {
    session_id: 'pr-acme-payments-1281-1746042000',
    repo: 'acme/payments',
    pr_number: 1281,
    sender: 'mira.l',
    status: 'FAILED',
    final_verdict: 'ESCALATED',
    overall_confidence: 0.71,
    security_confidence: 0.68,
    style_confidence: 0.74,
    blocking_count: 0,
    non_blocking_count: 0,
    severity_counts: { ...empty },
    security_iterations: 3,
    style_iterations: 3,
    created_at: '2026-05-10T14:00:00Z',
    updated_at: '2026-05-10T14:08:42Z',
    github_comment_url: null,
    security_findings: [],
    style_findings: [],
    github_comment_body:
      '## 🤖 Automated PR Review — Pipeline failure\n\nThe review pipeline did not complete after 3 Ralph loop iterations. Overall confidence (0.71) fell below the 0.75 threshold.\n\nManual review required.',
  },
];

// ============================================================
// Public API — replace with real fetch() calls in a follow-up.
// ============================================================
export function getReviews(): ReviewSummary[] {
  return [...reviewsDetail].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
  );
}

export function getReviewById(sessionId: string): ReviewDetail | null {
  return reviewsDetail.find((r) => r.session_id === sessionId) ?? null;
}

export function getAllSessionIds(): string[] {
  return reviewsDetail.map((r) => r.session_id);
}
