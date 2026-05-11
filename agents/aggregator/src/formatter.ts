import type {
  SecurityFinding,
  Severity,
  StyleFinding,
  TaggedFinding,
  Verdict,
} from '../../../shared/types';

// ============================================================
// GitHub comment formatter. Pure rendering — no I/O. Follows the
// output template defined in CLAUDE.md.
// ============================================================

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

const SEVERITY_BADGE: Record<Severity, string> = {
  CRITICAL: '🔴 **CRITICAL**',
  HIGH:     '🟠 **HIGH**',
  MEDIUM:   '🟡 **MEDIUM**',
  LOW:      '🔵 **LOW**',
  INFO:     '⚪ **INFO**',
};

const VERDICT_DISPLAY: Record<Verdict, string> = {
  APPROVED:           '✅ **APPROVED**',
  CHANGES_REQUESTED:  '⚠️ **CHANGES REQUESTED**',
  ESCALATED:          '🚨 **ESCALATED** — Human review required',
};

export interface FormatterInput {
  sessionId: string;
  findings: TaggedFinding[];
  finalVerdict: Verdict;
  overallConfidence: number;
  blockingCount: number;
  nonBlockingCount: number;
  summary: string;
}

export function formatGitHubComment(input: FormatterInput): string {
  const lines: string[] = [];
  lines.push('## 🤖 Automated PR Review');
  lines.push('');
  lines.push('### Summary');
  lines.push(input.summary);
  lines.push('');
  lines.push('### Issues Found');
  lines.push(formatFindingsSection(input.findings));
  lines.push('');
  lines.push('### Verdict');
  lines.push(VERDICT_DISPLAY[input.finalVerdict]);
  lines.push('');
  lines.push(
    `**Blocking issues:** ${input.blockingCount} | **Non-blocking:** ${input.nonBlockingCount}`
  );
  lines.push('');
  lines.push('---');
  lines.push(
    `_Reviewed by PR Review Agent | Session: \`${input.sessionId}\` | Confidence: \`${input.overallConfidence.toFixed(2)}\`_`
  );
  return lines.join('\n');
}

// ============================================================
// Default summary builder — used when the handler doesn't supply
// a model-written summary.
// ============================================================
export function buildDefaultSummary(input: {
  findings: TaggedFinding[];
  blockingCount: number;
  nonBlockingCount: number;
  finalVerdict: Verdict;
}): string {
  if (input.findings.length === 0) {
    return 'No issues found in the changed lines. The PR looks clean from both security and style perspectives.';
  }
  if (input.finalVerdict === 'ESCALATED') {
    return `Found ${input.blockingCount} blocking issue(s) and ${input.nonBlockingCount} suggestion(s). This PR requires human review — see issues below.`;
  }
  if (input.finalVerdict === 'CHANGES_REQUESTED') {
    return `Found ${input.blockingCount} blocking issue(s) and ${input.nonBlockingCount} suggestion(s). Please address the blocking items before merging.`;
  }
  return `No blocking issues, ${input.nonBlockingCount} non-blocking suggestion(s). These are advisory; the PR is not blocked.`;
}

// ============================================================
// Severity-grouped findings section
// ============================================================
function formatFindingsSection(findings: TaggedFinding[]): string {
  if (findings.length === 0) {
    return '_No issues to report._';
  }

  const bySeverity = groupBySeverity(findings);
  const sections: string[] = [];

  for (const severity of SEVERITY_ORDER) {
    const items = bySeverity.get(severity);
    if (!items || items.length === 0) continue;
    sections.push(`#### ${SEVERITY_BADGE[severity]} (${items.length})`);
    sections.push('');
    for (const item of items) {
      sections.push(formatFinding(item));
      sections.push('');
    }
  }
  return sections.join('\n');
}

function groupBySeverity(findings: TaggedFinding[]): Map<Severity, TaggedFinding[]> {
  const map = new Map<Severity, TaggedFinding[]>();
  for (const tagged of findings) {
    const list = map.get(tagged.finding.severity) ?? [];
    list.push(tagged);
    map.set(tagged.finding.severity, list);
  }
  return map;
}

function formatFinding(tagged: TaggedFinding): string {
  const f = tagged.finding;
  const agentLabel = tagged.agent === 'security' ? '🔒 Security' : '✨ Style';
  const parts: string[] = [];
  parts.push(`- **\`${f.category}\`** in \`${f.file}:${f.line}\`  _(${agentLabel})_`);
  parts.push(`  - ${f.description}`);
  parts.push(`  - **Fix:** ${f.suggestion}`);

  // Security-only optional fields
  if (tagged.agent === 'security') {
    const sec = f as SecurityFinding;
    if (sec.owasp_reference) {
      parts.push(`  - **Reference:** ${sec.owasp_reference}`);
    }
    if (sec.code_example) {
      parts.push('  - **Example:**');
      parts.push('    ```');
      // Indent code example so it renders as a nested code block
      for (const codeLine of sec.code_example.split('\n')) {
        parts.push(`    ${codeLine}`);
      }
      parts.push('    ```');
    }
  }

  return parts.join('\n');
}

// Re-export for the handler so it doesn't need a separate import
export type { SecurityFinding, StyleFinding, TaggedFinding };
