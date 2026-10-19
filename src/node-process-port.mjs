import {spawn as nativeSpawn} from 'node:child_process';
import {hrtime, platform} from 'node:process';
import {closed, fail} from './job-spec.mjs';

// Importing this module launches nothing. No implicit environment, shell, pipes or retry.
// Required ownedGroup controls must establish identity and complete descendant coverage;
// no kill(0), leader-exit or numeric-PID-only fallback is supplied here.
export function createNodeProcessPort(ownedGroup, operations = {spawn: nativeSpawn, platform}) {
  closed(ownedGroup, ['observe', 'signal'], [], 'owned_group_controls');
  closed(operations, ['spawn', 'platform'], [], 'native_operations');
  if (typeof ownedGroup.observe !== 'function' || typeof ownedGroup.signal !== 'function' ||
      typeof operations.spawn !== 'function' || operations.platform !== 'linux') fail('native_process_port');
  const observe = ownedGroup.observe.bind(ownedGroup); const send = ownedGroup.signal.bind(ownedGroup);
  const launch = operations.spawn;
  return Object.freeze({spawn(spec, invocation, events) {
    const child = launch(invocation.executable, [...invocation.args], {
      cwd: spec.task_scope, env: {...invocation.env}, stdio: [...invocation.stdio], shell: false, detached: true
    });
    const pid = Number.isSafeInteger(child.pid) && child.pid > 1 ? child.pid : null;
    const identity = Object.freeze({});
    const group = Object.freeze({job_id: spec.job_id, pgid: pid, identity});
    let spawned = false, released = false;
    const onSpawn = () => { spawned = true; if (!released) events.onSpawn({pid: child.pid}); };
    const onExit = (code, signal) => { if (!released) events.onExit({code, signal}); };
    // Retain a passive error listener after release: late ChildProcess errors must not
    // become uncaught exceptions or rewrite already delivered metadata.
    const onError = () => { if (!released) events.onError({spawn_failed: !spawned && pid === null}); };
    child.on('spawn', onSpawn); child.on('exit', onExit); child.on('error', onError);
    return Object.freeze({pid, identity,
      observe: () => observe(group),
      sendSignal: (signal, observation) => {
        if (!['SIGTERM', 'SIGKILL'].includes(signal) || observation.identity !== identity ||
            observation.pgid !== pid || observation.job_id !== spec.job_id || observation.signal_safe !== true) fail('signal_target');
        return send(group, signal, observation);
      },
      release() { released = true; child.removeListener('spawn', onSpawn); child.removeListener('exit', onExit); }
    });
  }});
}

export function createMonotonicClock() {
  return Object.freeze({
    now: () => Number(hrtime.bigint() / 1_000_000n),
    schedule(delay, callback) {
      if (!Number.isSafeInteger(delay) || delay < 0 || typeof callback !== 'function') fail('timer');
      // Node clamps oversized delays to 1ms; chunk long waits, then the wrapper
      // checks the original absolute deadline again rather than changing it.
      const timer = setTimeout(callback, Math.min(Math.max(1, delay), 2_147_483_647));
      return () => clearTimeout(timer);
    }
  });
}
