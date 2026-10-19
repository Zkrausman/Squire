import {isAbsolute, resolve} from 'node:path';
import {validateJobSpec, closed, own, fail, nonnegative, text} from '../../src/job-spec.mjs';
import {startProcess} from '../../src/execution-wrapper.mjs';

export const DIRECT_CHILD_CASES = Object.freeze([
  Object.freeze({id: 'native-exit7-v1', program: 'process.exit(7)'}),
  Object.freeze({id: 'native-abort-v1', program: 'setTimeout(() => process.exit(0), 250)'})
]);
const SHUTDOWN = Object.freeze({term_grace_ms: 50, kill_grace_ms: 50, poll_interval_ms: 5});

// No default native port/clock or CLI. Source/fake-test readiness is not permission
// to execute native cases or proof of the required external cleanup qualification.
export async function runDirectChildAcceptance(input) {
  closed(input, ['executable', 'jobs', 'port', 'clock'], [], 'direct_child_acceptance');
  if (!text(input.executable) || !isAbsolute(input.executable)) fail('executable');
  const executable = input.executable;
  closed(input.jobs, ['exit', 'abort'], [], 'acceptance_jobs');
  const jobs = Object.freeze([validateJobSpec(input.jobs.exit), validateJobSpec(input.jobs.abort)]);
  if (jobs.some(job => job.max_wall_clock_sec !== 1 || job.max_steps !== 1 ||
      !isAbsolute(job.task_scope) || resolve(job.task_scope) === '/' || own(job, 'fenced_history_ref')) ||
      jobs[0].job_id === jobs[1].job_id || resolve(jobs[0].task_scope) === resolve(jobs[1].task_scope)) fail('acceptance_jobs');
  closed(input.port, ['spawn'], [], 'port'); closed(input.clock, ['now', 'schedule'], [], 'clock');
  if (typeof input.port.spawn !== 'function' || ['now', 'schedule'].some(key => typeof input.clock[key] !== 'function')) fail('acceptance_ports');
  const spawn = input.port.spawn.bind(input.port);
  const clock = Object.freeze({now: input.clock.now.bind(input.clock), schedule: input.clock.schedule.bind(input.clock)});
  const started = clock.now();
  if (!nonnegative(started) || !Number.isSafeInteger(started + 3000)) fail('acceptance_clock');
  const cases = [];
  let ended = false, deadlineExpired = false, cancelCaseTimer = null;
  let expire;
  const expired = new Promise(resolve => { expire = resolve; });
  const cancelOverall = clock.schedule(3000, () => {
    if (!ended) { deadlineExpired = true; expire(null); }
  });
  if (typeof cancelOverall !== 'function') fail('acceptance_clock.schedule');
  function report(status) {
    ended = true; cancelCaseTimer?.(); cancelCaseTimer = null; cancelOverall();
    const rows = DIRECT_CHILD_CASES.map((item, index) => cases[index] ?? Object.freeze({case_id: item.id, status: 'NOT_REACHED', observation: null}));
    return Object.freeze({status, cases: Object.freeze(rows), runtime_qualification: 'NOT_ESTABLISHED_BY_HARNESS'});
  }
  try {
    for (let index = 0; index < DIRECT_CHILD_CASES.length; index++) {
      if (deadlineExpired) return report('TIMEOUT');
      const job = jobs[index], fixture = DIRECT_CHILD_CASES[index];
      const controller = new AbortController(); let abortArmed = false, abortIssued = false;
      const port = Object.freeze({spawn(spec, invocation, events) {
        return spawn(spec, invocation, Object.freeze({
          onSpawn(value) {
            events.onSpawn(value);
            if (index === 1 && !ended && !deadlineExpired && !abortArmed) {
              abortArmed = true;
              cancelCaseTimer = clock.schedule(20, () => {
                if (!ended && !deadlineExpired) { abortIssued = true; controller.abort(); }
              });
              if (typeof cancelCaseTimer !== 'function') fail('acceptance_clock.schedule');
            }
          },
          onExit: value => events.onExit(value), onError: value => events.onError(value)
        }));
      }});
      const invocation = Object.freeze({executable, args: Object.freeze(['-e', fixture.program]),
        env: Object.freeze({TMPDIR: job.task_scope, LANG: 'C', TZ: 'UTC'}), stdio: Object.freeze(['ignore', 'ignore', 'ignore'])});
      const session = startProcess(job, invocation, {port, clock, shutdown: SHUTDOWN, signal: controller.signal});
      const completed = (async () => {
        await session.exit;
        if (ended || deadlineExpired) return null;
        return session.settle();
      })();
      const observation = await Promise.race([completed, expired]);
      cancelCaseTimer?.(); cancelCaseTimer = null;
      if (deadlineExpired || observation === null) {
        cases.push(Object.freeze({case_id: fixture.id, status: 'TIMEOUT', observation: null}));
        return report('TIMEOUT');
      }
      const elapsed = clock.now() - started;
      if (!nonnegative(elapsed) || elapsed > 3000) {
        cases.push(Object.freeze({case_id: fixture.id, status: 'TIMEOUT', observation}));
        return report('TIMEOUT');
      }
      const observed = observation.process_group_allocated === true && Number.isSafeInteger(observation.pid) && observation.pid > 1 &&
        nonnegative(observation.process_wall_ms) && observation.failure_codes.length === 0;
      const passed = observed && (index === 0 ?
        observation.process_exit_code === 7 && observation.signal === null && !observation.canceled && observation.settlement_status === 'CLEAN' :
        abortIssued && observation.termination_reason === 'aborted' && observation.canceled && ['CLEAN', 'ORPHAN_KILLED'].includes(observation.settlement_status));
      cases.push(Object.freeze({case_id: fixture.id, status: passed ? 'PASS' : 'FAIL', observation}));
      if (!passed) return report('FAIL');
    }
    return report('PASS');
  } finally {
    ended = true; cancelCaseTimer?.(); cancelOverall();
  }
}
