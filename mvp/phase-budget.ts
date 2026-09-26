import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { decideCommand, validateBudget } from './phase-budget-policy.mjs';

export default function (pi: ExtensionAPI) {
  // Explicitly loaded from the trusted Squire build, never the model's candidate.
  const policy = validateBudget(JSON.parse(process.env.SQUIRE_BUDGET_POLICY ?? 'null'));
  const deadline = Number(process.env.SQUIRE_BUDGET_DEADLINE);
  const receipt = process.env.SQUIRE_BUDGET_RECEIPT;
  const ready = process.env.SQUIRE_BUDGET_READY;
  const nonce = process.env.SQUIRE_BUDGET_NONCE;
  if (!Number.isSafeInteger(deadline) || !receipt || !ready || !/^[a-f0-9]{64}$/.test(nonce ?? ''))
    throw new Error('Missing trusted phase budget inputs');
  const initialRemaining = deadline - Date.now();
  if (initialRemaining <= 0 || initialRemaining > policy.minutes * 60000) throw new Error('Invalid phase budget deadline');
  const start = performance.now();
  let count = 0;
  pi.on('tool_call', event => {
    if (event.toolName !== 'bash') return;
    const command = event.input.command;
    const remaining = initialRemaining - (performance.now() - start);
    const decision = decideCommand(policy, command, remaining);
    if (decision.allowed) {
      event.input.timeout = decision.timeoutSeconds;
      return;
    }
    if (++count > 100) {
      process.exitCode = 1;
      throw new Error('Command deferral receipt capacity exceeded');
    }
    try {
      // No raw shell commands or tool output in receipts: these may contain secrets.
      appendFileSync(receipt, JSON.stringify({ status: 'not_run', reason: decision.reason,
        commandSha256: createHash('sha256').update(command).digest('hex'), at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    } catch {
      process.exitCode = 1;
      throw new Error('Could not persist command deferral; run must fail closed');
    }
    return { block: true, reason: `Squire command not run (${decision.reason}); preserve handoff. External verification is still required.` };
  });
  // Written only after registering the hook; the host rejects a settled Pi session without it.
  writeFileSync(ready, JSON.stringify({ version: 1, nonce }), { flag: 'wx', mode: 0o600 });
}
