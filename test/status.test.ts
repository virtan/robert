import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLaunchctl, parsePs } from '../src/status.ts';

test('finds robert processes in ps output', () => {
  const out = [
    '  101 /usr/bin/node /srv/robert/bin/robert.ts start',
    '  102 npm start',
    '  103 node bin/robert.ts start',
    '  104 node bin/robert.ts status',
    '  105 grep robert.ts start',
    '  106 vim src/robert.ts',
  ].join('\n');
  assert.deepEqual(parsePs(out, 104).map((p) => p.pid), [101, 103]);
});

test('reads the pid from launchctl print', () => {
  assert.equal(parseLaunchctl('gui/501/dev.robert.bot = {\n\tstate = running\n\tpid = 4242\n}'), 4242);
  assert.equal(parseLaunchctl('gui/501/dev.robert.bot = {\n\tstate = not running\n}'), undefined);
});
