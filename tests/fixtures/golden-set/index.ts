import type {
  EscalationReason,
  SecurityFinding,
  SlashCommand,
  StyleFinding,
  Verdict,
} from '../../../shared/types';

// ============================================================
// Golden-set fixtures. Each fixture is a small synthetic PR diff
// plus the expected outcomes for the deterministic transforms
// (diff sizing, escalation classification, sub-agent routing) and
// — where useful — the expected aggregated verdict given a known
// set of findings. Add new fixtures here as real-world cases are
// captured.
// ============================================================

export interface GoldenFixture {
  id: string;
  description: string;
  diff: string;
  slashCommand?: SlashCommand;
  expected: {
    diffAssessment: {
      totalLines: number;
      reviewableLines: number;
      skippedLines: number;
      exceedsLimit: boolean;
    };
    escalation: EscalationReason | null;
    subAgents: Array<'security' | 'style'>;
    /** Optional — only set when the fixture also exercises the Aggregator. */
    findings?: {
      security: SecurityFinding[];
      style: StyleFinding[];
    };
    /** Optional — expected final verdict given `findings`. */
    finalVerdict?: Verdict;
  };
}

// ============================================================
// Fixture 1 — clean PR
// ============================================================
const cleanPr: GoldenFixture = {
  id: 'clean-pr',
  description: 'Small refactor in src/utils — no findings expected.',
  diff: [
    'diff --git a/src/utils/format.ts b/src/utils/format.ts',
    '--- a/src/utils/format.ts',
    '+++ b/src/utils/format.ts',
    '@@ -1,3 +1,4 @@',
    ' export function formatDate(d: Date): string {',
    '-  return d.toISOString();',
    '+  return d.toISOString().slice(0, 10);',
    ' }',
  ].join('\n'),
  expected: {
    diffAssessment: { totalLines: 2, reviewableLines: 2, skippedLines: 0, exceedsLimit: false },
    escalation: null,
    subAgents: ['security', 'style'],
  },
};

// ============================================================
// Fixture 2 — auth touch (escalation trigger)
// ============================================================
const authTouched: GoldenFixture = {
  id: 'auth-touched',
  description: 'Touches services/auth/login.ts — must escalate per CLAUDE.md.',
  diff: [
    'diff --git a/services/auth/login.ts b/services/auth/login.ts',
    '--- a/services/auth/login.ts',
    '+++ b/services/auth/login.ts',
    '@@ -10,1 +10,1 @@',
    '-  const token = signJwt(user);',
    '+  const token = signJwt(user, { expiresIn: \'24h\' });',
  ].join('\n'),
  expected: {
    diffAssessment: { totalLines: 2, reviewableLines: 2, skippedLines: 0, exceedsLimit: false },
    escalation: 'AUTH_LOGIC_CHANGE',
    subAgents: ['security', 'style'],
  },
};

// ============================================================
// Fixture 3 — payment touch (escalation trigger)
// ============================================================
const paymentTouched: GoldenFixture = {
  id: 'payment-touched',
  description: 'Touches services/billing/charge.ts — must escalate.',
  diff: [
    'diff --git a/services/billing/charge.ts b/services/billing/charge.ts',
    '--- a/services/billing/charge.ts',
    '+++ b/services/billing/charge.ts',
    '@@ -5,1 +5,1 @@',
    '-  amount: cents,',
    '+  amount: Math.round(cents),',
  ].join('\n'),
  expected: {
    diffAssessment: { totalLines: 2, reviewableLines: 2, skippedLines: 0, exceedsLimit: false },
    escalation: 'PAYMENT_LOGIC_CHANGE',
    subAgents: ['security', 'style'],
  },
};

// ============================================================
// Fixture 4 — schema migration (top-priority escalation)
// ============================================================
const schemaMigration: GoldenFixture = {
  id: 'schema-migration',
  description: 'Adds a Prisma migration — top-priority escalation.',
  diff: [
    'diff --git a/prisma/migrations/0042_add_email_index/migration.sql b/prisma/migrations/0042_add_email_index/migration.sql',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/prisma/migrations/0042_add_email_index/migration.sql',
    '@@ -0,0 +1,1 @@',
    '+CREATE INDEX idx_users_email ON users(email);',
  ].join('\n'),
  expected: {
    diffAssessment: { totalLines: 1, reviewableLines: 1, skippedLines: 0, exceedsLimit: false },
    escalation: 'SCHEMA_MIGRATION',
    subAgents: ['security', 'style'],
  },
};

// ============================================================
// Fixture 5 — oversized diff dominated by a lockfile
// (reviewable count after exclusion is still > the cap)
// ============================================================
const oversizedDiff: GoldenFixture = (() => {
  const lines = ['diff --git a/src/big.ts b/src/big.ts', '@@ -1,1 +1,1 @@'];
  for (let i = 0; i < 3001; i++) lines.push(`+line ${i}`);
  lines.push('diff --git a/package-lock.json b/package-lock.json');
  lines.push('@@ -1,1 +1,1 @@');
  for (let i = 0; i < 5000; i++) lines.push(`+lock ${i}`);
  return {
    id: 'oversized-diff',
    description:
      '3,001 real lines + 5,000 lockfile lines. Lockfile excluded; reviewable still over the cap.',
    diff: lines.join('\n'),
    expected: {
      diffAssessment: {
        totalLines: 8001,
        reviewableLines: 3001,
        skippedLines: 5000,
        exceedsLimit: true,
      },
      escalation: null,
      subAgents: ['security', 'style'],
    },
  };
})();

// ============================================================
// Fixture 6 — slash command narrowing
// ============================================================
const slashSecurityOnly: GoldenFixture = {
  id: 'slash-security-only',
  description: '/review security comment should narrow to security agent only.',
  diff: cleanPr.diff,
  slashCommand: '/review security',
  expected: {
    diffAssessment: cleanPr.expected.diffAssessment,
    escalation: null,
    subAgents: ['security'],
  },
};

// ============================================================
// Fixture 7 — aggregator end-to-end with a HIGH finding.
// Includes pre-computed findings so the Aggregator pipeline
// (mergeFindings → computeFinalVerdict → formatGitHubComment)
// can be exercised against a known input/output pair.
// ============================================================
const highSecurityFinding: GoldenFixture = {
  id: 'aggregator-high-security',
  description:
    'One HIGH security finding alongside two style suggestions. Expects CHANGES_REQUESTED.',
  diff: [
    'diff --git a/services/api/users.ts b/services/api/users.ts',
    '@@ -10,1 +10,1 @@',
    '+  const q = `SELECT * FROM users WHERE id = ${id}`;',
  ].join('\n'),
  expected: {
    diffAssessment: { totalLines: 1, reviewableLines: 1, skippedLines: 0, exceedsLimit: false },
    escalation: null,
    subAgents: ['security', 'style'],
    findings: {
      security: [
        {
          severity: 'HIGH',
          category: 'SQL_INJECTION',
          file: 'services/api/users.ts',
          line: 10,
          description: 'User-supplied id interpolated into SQL.',
          suggestion: 'Use parameterized queries.',
          blocks_pr: true,
        },
      ],
      style: [
        {
          severity: 'LOW',
          category: 'UNUSED_IMPORT',
          file: 'services/api/users.ts',
          line: 3,
          description: 'lodash imported but unused.',
          suggestion: 'Remove the import.',
          blocks_pr: false,
        },
      ],
    },
    finalVerdict: 'CHANGES_REQUESTED',
  },
};

export const goldenSet: GoldenFixture[] = [
  cleanPr,
  authTouched,
  paymentTouched,
  schemaMigration,
  oversizedDiff,
  slashSecurityOnly,
  highSecurityFinding,
];
