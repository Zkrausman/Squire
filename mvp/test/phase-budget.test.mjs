import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBudget, decideCommand } from '../phase-budget-policy.mjs';
const policy = validateBudget({ minutes: 120, reserveMinutes: 10, commands: [
  { command: 'npm --prefix v2 test', maxSeconds: 1200 },
  { command: 'npm --prefix v2 run build', maxSeconds: 180 },
] });
test('known long test is deferred with a handoff reserve and not credited', () => {
  assert.deepEqual(decideCommand(policy, 'npm --prefix v2 test', (14 * 60 + 45) * 1000),
    { allowed: false, reason: 'deferred_for_handoff' });
  assert.deepEqual(decideCommand(policy, 'npm --prefix v2 run build', (14 * 60 + 45) * 1000),
    { allowed: true, timeoutSeconds: 180 });
  assert.deepEqual(decideCommand(policy, 'cd v2 && npm test', 60 * 60 * 1000),
    { allowed: false, reason: 'unlisted_command' });
});
test('strict command budget rejects unknown, expired and unbounded configuration', () => {
  assert.equal(decideCommand(policy, 'npm --prefix v2 test', 0).reason, 'deadline');
  for (const value of [
    { minutes: 0, reserveMinutes: 10, commands: policy.commands },
    { minutes: 120, reserveMinutes: 61, commands: policy.commands },
    { minutes: 120, reserveMinutes: 10, commands: [] },
    { minutes: 120, reserveMinutes: 10, commands: [...policy.commands, policy.commands[0]] },
    { minutes: 120, reserveMinutes: 10, commands: [{ command: 'x', maxSeconds: 3601 }] },
  ]) assert.throws(() => validateBudget(value));
});
