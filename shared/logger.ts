// ============================================================
// Structured JSON logger used by every agent and middleware.
// CloudWatch parses these as queryable fields.
// ============================================================

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export type Service =
  | 'orchestrator'
  | 'security-agent'
  | 'style-agent'
  | 'aggregator'
  | 'webhook'
  | 'github-mcp-client'
  | 'slack-mcp-client'
  | 'rate-limiter'
  | 'webhook-middleware'
  | 'slash-command-parser'
  | 'dynamo';

export interface LogContext {
  sessionId?: string;
  prNumber?: number;
  repo?: string;
  [key: string]: unknown;
}

export function log(
  level: Level,
  service: Service,
  message: string,
  context: LogContext = {}
): void {
  const entry = {
    level,
    service,
    message,
    ...context,
    timestamp: new Date().toISOString(),
  };
  const out = JSON.stringify(entry);
  if (level === 'ERROR') console.error(out);
  else if (level === 'WARN') console.warn(out);
  else console.log(out);
}
