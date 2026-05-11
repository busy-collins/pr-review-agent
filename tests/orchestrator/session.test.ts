import { describe, expect, it } from 'vitest';
import {
  assessDiffSize,
  classifyEscalation,
  generateSessionId,
  isGeneratedFile,
  selectSubAgents,
} from '../../agents/orchestrator/src/session';

describe('generateSessionId', () => {
  it('produces an id matching the schema pattern', () => {
    const id = generateSessionId('myorg/my-service', 412, 1_746_123_456_000);
    expect(id).toBe('pr-myorg-my-service-412-1746123456');
    expect(id).toMatch(/^pr-[a-zA-Z0-9_.-]+-[0-9]+-[0-9]+$/);
  });

  it('sanitizes characters not in the allowed alphabet', () => {
    const id = generateSessionId('owner/repo with spaces!', 1, 1000);
    expect(id).toMatch(/^pr-[a-zA-Z0-9_.-]+-[0-9]+-[0-9]+$/);
  });
});

describe('isGeneratedFile', () => {
  it.each([
    ['package-lock.json', true],
    ['yarn.lock', true],
    ['go.sum', true],
    ['dist/index.js', true],
    ['build/output.js', true],
    ['app.min.js', true],
    ['.next/cache/foo', true],
    ['nested/path/poetry.lock', true],
    ['src/index.ts', false],
    ['README.md', false],
    ['package.json', false],
    ['src/services/billing.ts', false],
  ])('isGeneratedFile(%s) === %s', (path, expected) => {
    expect(isGeneratedFile(path)).toBe(expected);
  });
});

describe('assessDiffSize', () => {
  it('counts added and removed lines inside hunks', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index abc..def 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,5 @@',
      ' unchanged',
      '+added one',
      '+added two',
      '-removed one',
      ' unchanged',
    ].join('\n');
    const r = assessDiffSize(diff);
    expect(r.totalLines).toBe(3);
    expect(r.reviewableLines).toBe(3);
    expect(r.skippedLines).toBe(0);
    expect(r.exceedsLimit).toBe(false);
  });

  it('subtracts generated files from the reviewable count', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,2 @@',
      '+real change',
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1,1 +1,5 @@',
      '+generated 1',
      '+generated 2',
      '+generated 3',
      '+generated 4',
    ].join('\n');
    const r = assessDiffSize(diff);
    expect(r.totalLines).toBe(5);
    expect(r.skippedLines).toBe(4);
    expect(r.reviewableLines).toBe(1);
    expect(r.exceedsLimit).toBe(false);
  });

  it('exceeds limit when reviewable count crosses the cap', () => {
    const lines = ['diff --git a/src/big.ts b/src/big.ts', '@@ -1,1 +1,1 @@'];
    for (let i = 0; i < 101; i++) lines.push(`+line ${i}`);
    const r = assessDiffSize(lines.join('\n'), 100);
    expect(r.reviewableLines).toBe(101);
    expect(r.exceedsLimit).toBe(true);
  });

  it('does not double-count the +++/--- file header lines', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '+a',
    ].join('\n');
    expect(assessDiffSize(diff).totalLines).toBe(1);
  });
});

describe('classifyEscalation', () => {
  it('flags auth path changes', () => {
    const diff = 'diff --git a/src/auth/login.ts b/src/auth/login.ts\n@@ -1 +1 @@\n+x';
    expect(classifyEscalation(diff)).toBe('AUTH_LOGIC_CHANGE');
  });

  it('flags payment path changes', () => {
    const diff =
      'diff --git a/src/billing/charge.ts b/src/billing/charge.ts\n@@ -1 +1 @@\n+x';
    expect(classifyEscalation(diff)).toBe('PAYMENT_LOGIC_CHANGE');
  });

  it('flags schema migrations', () => {
    const diff =
      'diff --git a/db/migrations/001_init.sql b/db/migrations/001_init.sql\n@@ -1 +1 @@\n+x';
    expect(classifyEscalation(diff)).toBe('SCHEMA_MIGRATION');
  });

  it('returns null for innocuous changes', () => {
    const diff = 'diff --git a/README.md b/README.md\n@@ -1 +1 @@\n+typo fix';
    expect(classifyEscalation(diff)).toBeNull();
  });

  it('prioritizes SCHEMA_MIGRATION over AUTH when both touched', () => {
    const diff = [
      'diff --git a/src/auth/foo.ts b/src/auth/foo.ts',
      'diff --git a/db/migrations/x.sql b/db/migrations/x.sql',
    ].join('\n');
    expect(classifyEscalation(diff)).toBe('SCHEMA_MIGRATION');
  });

  it('prioritizes AUTH over PAYMENT when both touched', () => {
    const diff = [
      'diff --git a/src/billing/foo.ts b/src/billing/foo.ts',
      'diff --git a/src/auth/bar.ts b/src/auth/bar.ts',
    ].join('\n');
    expect(classifyEscalation(diff)).toBe('AUTH_LOGIC_CHANGE');
  });
});

describe('selectSubAgents', () => {
  it('runs both agents by default', () => {
    expect(selectSubAgents(null)).toEqual(['security', 'style']);
    expect(selectSubAgents(undefined)).toEqual(['security', 'style']);
  });

  it('runs only security for /review security', () => {
    expect(selectSubAgents('/review security')).toEqual(['security']);
  });

  it('runs only style for /review style', () => {
    expect(selectSubAgents('/review style')).toEqual(['style']);
  });

  it('runs both for /review full and /review reset', () => {
    expect(selectSubAgents('/review full')).toEqual(['security', 'style']);
    expect(selectSubAgents('/review reset')).toEqual(['security', 'style']);
  });
});
