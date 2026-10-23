import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWhen } from '../src/time.ts';

test('parses wall time in a zone, across DST', () => {
  // 09:00 in Moscow (UTC+3, no DST) is 06:00 UTC.
  assert.equal(parseWhen('2026-10-24 09:00', 'Europe/Moscow'), Date.UTC(2026, 9, 24, 6) / 1000);
  // New York: EDT (UTC-4) in October, EST (UTC-5) in December.
  assert.equal(parseWhen('2026-10-24T09:00', 'America/New_York'), Date.UTC(2026, 9, 24, 13) / 1000);
  assert.equal(parseWhen('2026-12-24 09:00', 'America/New_York'), Date.UTC(2026, 11, 24, 14) / 1000);
});

test('honours explicit offsets and rejects junk', () => {
  assert.equal(parseWhen('2026-10-24T09:00:00Z', 'Asia/Tokyo'), Date.UTC(2026, 9, 24, 9) / 1000);
  assert.equal(parseWhen('2026-10-24T09:00+02:00', 'UTC'), Date.UTC(2026, 9, 24, 7) / 1000);
  assert.equal(parseWhen('tomorrow', 'UTC'), null);
});
