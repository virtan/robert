/** Offset of `tz` from UTC at the given instant, in milliseconds. */
function tzOffset(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Parses an ISO-like date/time. Without an explicit offset ("2026-10-24 09:00") it's read as wall
 * time in `tz`. Returns unix seconds, or null if unparseable.
 */
export function parseWhen(input: string, tz: string): number | null {
  const s = input.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 9), +(m[5] ?? 0), +(m[6] ?? 0));
  // Two passes settle the offset across DST transitions.
  let utc = wall - tzOffset(wall, tz);
  utc = wall - tzOffset(utc, tz);
  return Math.floor(utc / 1000);
}
