/** Operator-declared exact bash commands; never treat shell text as a security sandbox. */
export function validateBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid implementationBudget');
  const keys = ['minutes', 'reserveMinutes', 'commands'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid implementationBudget field');
  if (!Number.isSafeInteger(value.minutes) || value.minutes < 20 || value.minutes > 240) throw new Error('implementationBudget.minutes must be 20..240');
  if (!Number.isSafeInteger(value.reserveMinutes) || value.reserveMinutes < 1 || value.reserveMinutes > 30 || value.reserveMinutes * 2 >= value.minutes) throw new Error('Invalid handoff reserve');
  if (!Array.isArray(value.commands) || !value.commands.length || value.commands.length > 50) throw new Error('Declare 1..50 exact bash commands');
  const seen = new Set();
  for (const entry of value.commands) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['command', 'maxSeconds'].includes(key))
      || typeof entry.command !== 'string' || !entry.command.length || entry.command.length > 2048 || /[\x00-\x1f\x7f]/.test(entry.command)
      || !Number.isSafeInteger(entry.maxSeconds) || entry.maxSeconds < 1 || entry.maxSeconds > 3600
      || seen.has(entry.command)) throw new Error('Invalid or duplicate budgeted command');
    seen.add(entry.command);
  }
  return value;
}
export function decideCommand(policy, command, remainingMs) {
  const budget = policy.commands.find(entry => entry.command === command);
  if (!budget) return { allowed: false, reason: 'unlisted_command' };
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { allowed: false, reason: 'deadline' };
  if (remainingMs < budget.maxSeconds * 1000 + policy.reserveMinutes * 60000) return { allowed: false, reason: 'deferred_for_handoff' };
  return { allowed: true, timeoutSeconds: budget.maxSeconds };
}
