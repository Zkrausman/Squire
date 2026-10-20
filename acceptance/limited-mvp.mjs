// Explicit operator entrypoint. Never imported by npm test or automatic CI.
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createMonotonicClock} from '../src/node-process-port.mjs';
import {runLimitedAgyTask, runInertTimeoutAcceptanceProbe} from '../src/limited-runner.mjs';
import {ACCEPTANCE_TASK as task, ACCEPTANCE_SCOPE, ACCEPTANCE_OUTPUT} from './limited-task.mjs';

if (process.argv.length !== 3 || !['positive', 'timeout'].includes(process.argv[2])) throw Error('EXACT_GATE_REQUIRED');
const clock = createMonotonicClock();
const shutdown = {term_grace_ms: 3000, kill_grace_ms: 2000, poll_interval_ms: 200,
  stream_drain_timeout_ms: 1000, persistence_timeout_ms: 2000};
let result, began, elapsed;
if (process.argv[2] === 'positive') {
  // Operator must first verify signed-in subscription, effective CreditsOff,
  // current allowed catalog/model, version1.4.3 and normal permissions.
  await access('/home/zack/.local/bin/agy', constants.X_OK);
  began = clock.now();
  result = await runLimitedAgyTask({job_id: task.task_id, task_scope: ACCEPTANCE_SCOPE, requested_model: task.model,
    effort: task.effort, max_wall_clock_sec: 120, prompt_bytes: new TextEncoder().encode(task.prompt)},
    {clock, shutdown, output_path: ACCEPTANCE_OUTPUT});
  elapsed = clock.now() - began;
  if (result.record.lifecycle_status !== 'LIMITED_SUCCESS') process.exitCode = 1;
} else {
  // Execute only after operator accepted the separate positive gate.
  await access('/bin/sleep', constants.X_OK);
  began = clock.now();
  result = await runInertTimeoutAcceptanceProbe({clock, shutdown: {...shutdown, poll_interval_ms: 100, stream_drain_timeout_ms: 500}, task_scope: ACCEPTANCE_SCOPE});
  elapsed = clock.now() - began;
  const r = result.record, term = result.runtime_evidence.signal_attempts.find(x => x.signal === 'SIGTERM');
  if (!Number.isSafeInteger(r.process_exit.pid) || r.process_exit.pid <= 0 || elapsed < 1000 || elapsed > 4000 || r.lifecycle_status !== 'LIMITED_TIMEOUT' || r.process_exit.exit_signal !== 'SIGTERM' || !r.process_exit.observed_termination ||
      r.containment_evidence.settlement_status !== 'SETTLED_DIRECT_CHILD_EXIT' || !term || term.elapsed_ms < 1000 ||
      r.process_exit.process_wall_ms < 1000 || r.process_exit.process_wall_ms > 4000) process.exitCode = 1;
}
console.log(JSON.stringify({gate_elapsed_ms: elapsed, record: result.record, runtime_evidence: result.runtime_evidence}, null, 2));
