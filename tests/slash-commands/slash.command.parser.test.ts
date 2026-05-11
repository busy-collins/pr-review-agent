import { describe, expect, it } from 'vitest';
import {
  buildStatusResponse,
  parseSlashCommand,
  SLASH_COMMANDS,
  UNKNOWN_COMMAND_HELP,
} from '../../api/slash-commands/slash.command.parser';

const baseInput = {
  triggeredBy: 'octocat',
  repo: 'myorg/myrepo',
  prNumber: 42,
};

describe('parseSlashCommand — happy paths', () => {
  it.each(Object.entries(SLASH_COMMANDS))(
    'parses %s into the matching command',
    (_key, command) => {
      const result = parseSlashCommand({ ...baseInput, commentBody: command });
      expect(result.valid).toBe(true);
      expect(result.command).toBe(command);
      expect(result.error).toBeNull();
    }
  );

  it('parses a command with trailing whitespace + arguments after it', () => {
    const result = parseSlashCommand({
      ...baseInput,
      commentBody: '/review security please',
    });
    expect(result.valid).toBe(true);
    expect(result.command).toBe('/review security');
  });

  it('normalizes case — uppercase invocations are accepted', () => {
    const result = parseSlashCommand({
      ...baseInput,
      commentBody: '/REVIEW FULL',
    });
    expect(result.valid).toBe(true);
    expect(result.command).toBe('/review full');
  });

  it('strips leading/trailing whitespace before matching', () => {
    const result = parseSlashCommand({
      ...baseInput,
      commentBody: '   /review style   ',
    });
    expect(result.valid).toBe(true);
    expect(result.command).toBe('/review style');
  });

  it('returns the matching CommandAction for review-triggering commands', () => {
    const result = parseSlashCommand({
      ...baseInput,
      commentBody: '/review security',
    });
    expect(result.action?.subagents).toEqual(['security']);
    expect(result.action?.resetSession).toBe(false);
    expect(result.action?.statusOnly).toBe(false);
  });

  it('marks /review status as statusOnly', () => {
    const result = parseSlashCommand({
      ...baseInput,
      commentBody: '/review status',
    });
    expect(result.action?.statusOnly).toBe(true);
    expect(result.action?.subagents).toEqual([]);
  });

  it('marks /review reset with resetSession=true', () => {
    const result = parseSlashCommand({
      ...baseInput,
      commentBody: '/review reset',
    });
    expect(result.action?.resetSession).toBe(true);
  });
});

describe('parseSlashCommand — invalid inputs', () => {
  it('rejects comments that do not start with /review', () => {
    const result = parseSlashCommand({
      ...baseInput,
      commentBody: 'hey nice PR',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not start with \/review/);
  });

  it('rejects unknown subcommands and lists valid alternatives in the error', () => {
    const result = parseSlashCommand({
      ...baseInput,
      commentBody: '/review nonsense',
    });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unknown command/);
    expect(result.error).toMatch(/\/review full/);
  });

  it('rejects /review with no subcommand', () => {
    const result = parseSlashCommand({ ...baseInput, commentBody: '/review' });
    expect(result.valid).toBe(false);
  });

  it('preserves the raw input on the result for logging', () => {
    const result = parseSlashCommand({
      ...baseInput,
      commentBody: '/review nope extra',
    });
    expect(result.rawInput).toBe('/review nope extra');
  });
});

describe('buildStatusResponse', () => {
  it('renders required fields', () => {
    const out = buildStatusResponse({
      sessionId: 'pr-myorg-myrepo-42-1000',
      stage: 'SECURITY',
      status: 'IN_PROGRESS',
    });
    expect(out).toContain('pr-myorg-myrepo-42-1000');
    expect(out).toContain('SECURITY');
    expect(out).toContain('IN_PROGRESS');
  });

  it('formats confidence to 2 decimals when provided', () => {
    const out = buildStatusResponse({
      sessionId: 's',
      stage: 'AGGREGATOR',
      status: 'COMPLETED',
      confidence: 0.8765,
    });
    expect(out).toMatch(/0\.88/);
  });

  it('omits confidence and iterations rows when not provided', () => {
    const out = buildStatusResponse({
      sessionId: 's',
      stage: 'ORCHESTRATOR',
      status: 'IN_PROGRESS',
    });
    expect(out).not.toMatch(/Confidence:/);
    expect(out).not.toMatch(/Ralph loop iterations/);
  });
});

describe('UNKNOWN_COMMAND_HELP', () => {
  it('lists every review-triggering command', () => {
    for (const cmd of ['/review full', '/review security', '/review style', '/review status', '/review reset']) {
      expect(UNKNOWN_COMMAND_HELP).toContain(cmd);
    }
  });
});
