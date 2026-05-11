// ============================================================
// Small formatting helpers. Server-rendered, so the time format
// is locale-stable (no `toLocaleString` drift between SSR and CSR).
// ============================================================

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(isoTimestamp: string, now: number = Date.now()): string {
  const delta = now - Date.parse(isoTimestamp);
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  const days = Math.floor(delta / DAY);
  if (days < 30) return `${days}d ago`;
  // For older sessions, fall back to the date itself (UTC, ISO-flavored)
  return isoTimestamp.slice(0, 10);
}

export function durationBetween(startIso: string, endIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (ms < 1000) return '<1s';
  if (ms < MINUTE) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / MINUTE)}m ${Math.round((ms % MINUTE) / 1000)}s`;
}
