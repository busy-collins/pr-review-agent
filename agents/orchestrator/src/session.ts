import type { EscalationReason, SlashCommand } from '../../../shared/types';

// ============================================================
// Pure helpers used by the Orchestrator handler. Kept side-effect
// free so they can be exhaustively unit-tested without AWS mocks.
// ============================================================

const MAX_DIFF_LINES = parseInt(process.env.MAX_DIFF_LINES || '3000', 10);

// File-path patterns treated as auto-generated and excluded from
// the reviewable-line count when assessing PR size.
const GENERATED_FILE_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /\.lock$/,
  /\.min\.(js|css|map)$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)out\//,
];

export function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE_PATTERNS.some((re) => re.test(path));
}

// ============================================================
// Session ID generator. Output must match the schema pattern
// ^pr-[a-zA-Z0-9_.-]+-[0-9]+-[0-9]+$ so we sanitize owner/repo.
// ============================================================
export function generateSessionId(
  repo: string,
  prNumber: number,
  now: number = Date.now()
): string {
  const safeRepo = repo.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `pr-${safeRepo}-${prNumber}-${Math.floor(now / 1000)}`;
}

// ============================================================
// Diff size assessment. Counts added + removed lines, excluding
// generated files from the reviewable total.
// ============================================================
export interface DiffSizeAssessment {
  totalLines: number;
  reviewableLines: number;
  skippedLines: number;
  exceedsLimit: boolean;
}

export function assessDiffSize(
  diff: string,
  maxLines: number = MAX_DIFF_LINES
): DiffSizeAssessment {
  let totalLines = 0;
  let skippedLines = 0;
  let inGenerated = false;
  let inHunk = false;

  for (const line of diff.split('\n')) {
    const headerMatch = line.match(/^diff --git a\/(\S+)\s+b\/(\S+)/);
    if (headerMatch) {
      inGenerated = isGeneratedFile(headerMatch[2] ?? '');
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    const isAddition = line.startsWith('+') && !line.startsWith('+++');
    const isDeletion = line.startsWith('-') && !line.startsWith('---');
    if (!isAddition && !isDeletion) continue;

    totalLines++;
    if (inGenerated) skippedLines++;
  }

  const reviewableLines = totalLines - skippedLines;
  return {
    totalLines,
    reviewableLines,
    skippedLines,
    exceedsLimit: reviewableLines > maxLines,
  };
}

// ============================================================
// Escalation classifier. Inspects changed file paths for auth,
// payment, and schema-migration touchpoints per CLAUDE.md.
// Priority: SCHEMA_MIGRATION > AUTH_LOGIC_CHANGE > PAYMENT_LOGIC_CHANGE.
// ============================================================
const SENSITIVE_PATH_PATTERNS = {
  AUTH_LOGIC_CHANGE:
    /\b(auth|login|signin|signup|session|jwt|oauth|saml|password|credential|token)\b/i,
  PAYMENT_LOGIC_CHANGE:
    /\b(payment|billing|charge|invoice|subscription|stripe|paypal|checkout)\b/i,
  SCHEMA_MIGRATION:
    /(^|\/)(migrations?|alembic|prisma\/migrations|knex.*migrations)(\/|$)|schema\.sql$/,
} as const;

export function classifyEscalation(diff: string): EscalationReason | null {
  const paths = extractChangedPaths(diff);
  const found = new Set<EscalationReason>();
  for (const path of paths) {
    if (SENSITIVE_PATH_PATTERNS.SCHEMA_MIGRATION.test(path)) found.add('SCHEMA_MIGRATION');
    if (SENSITIVE_PATH_PATTERNS.AUTH_LOGIC_CHANGE.test(path)) found.add('AUTH_LOGIC_CHANGE');
    if (SENSITIVE_PATH_PATTERNS.PAYMENT_LOGIC_CHANGE.test(path)) found.add('PAYMENT_LOGIC_CHANGE');
  }
  if (found.has('SCHEMA_MIGRATION')) return 'SCHEMA_MIGRATION';
  if (found.has('AUTH_LOGIC_CHANGE')) return 'AUTH_LOGIC_CHANGE';
  if (found.has('PAYMENT_LOGIC_CHANGE')) return 'PAYMENT_LOGIC_CHANGE';
  return null;
}

function extractChangedPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^diff --git a\/(\S+)\s+b\/(\S+)/);
    if (m && m[2]) paths.push(m[2]);
  }
  return paths;
}

// ============================================================
// Slash command → SubAgents selection.
// ============================================================
export function selectSubAgents(
  slash: SlashCommand | undefined
): Array<'security' | 'style'> {
  switch (slash) {
    case '/review security': return ['security'];
    case '/review style':    return ['style'];
    case '/review full':
    case '/review reset':
    case '/review status':
    case null:
    case undefined:
    default:
      return ['security', 'style'];
  }
}
