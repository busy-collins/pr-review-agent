import Anthropic from '@anthropic-ai/sdk';

// ============================================================
// Singleton Anthropic client. Lazy-init so unit tests can mock
// the module without triggering a real client construction.
// ============================================================

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
