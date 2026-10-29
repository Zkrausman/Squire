import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {buildProjectCodegenPrompt} from '../src/project-task.mjs';
import {runProjectCodexTask} from '../src/project-runner.mjs';
import {GENERATION_SHUTDOWN} from '../src/bounded-codegen-plan.mjs';
import {createProjectResultReceipt, writeProjectResultReceipt} from '../src/project-result-receipt.mjs';
import {REPORT_MAX_BYTES, parseReceiptJson} from '../src/offline-run-summary.mjs';
import {readReceiptBytes, runOfflineReportCli} from '../bin/squire-report.mjs';
import {projectProjectRunSummary, formatProjectSummaryTerminal} from '../src/project-summary.mjs';

const PRIVATE = 'PRIVATE_SENTINEL_RECEIPT';
const MODEL = 'synthetic-project-model';
const EFFORT = 'synthetic-project-effort';
const PRIVATE_ERROR = 'PRIVATE_SENTINEL_ERROR_BODY';
const authorization = {operator_receipt: PRIVATE, supported_tuples: [{model: MODEL, effort: EFFORT}]};
const request = {
  schema: 'SQUIRE2_PROJECT_REQUEST_V1',
  task_id: 'synthetic-project-task',
  task_prompt: 'Return the fixed synthetic project envelope.',
  runtime_target: 'node24-esm',
  stage_target: 'multifile-candidate'
};
const encode = value => new TextEncoder().encode(value);
let serial = 1;
const jobId = () => `f62b59c1-874d-41b1-a632-${String(serial++).padStart(12, '0')}`;

function nullGenerationResult() {
  return {
    schema: 'SQUIRE2_PROJECT_RESULT_V1', status: 'INCOMPLETE', reason: 'CANCELED',
    generation: null, staging: null, task_correctness: 'NOT_EVALUATED',
    task_outcome_evaluated: false, runtime_admitted: false, operator_admitted: false,
    workspace_disposition: 'QUARANTINED', descendant_guarantee: 'NONE',
    operator_receipt: PRIVATE, direct_child_invocations: {generation: 0},
    outer_observation_target_ms: 140000, event_loop_condition: 'RESPONSIVE_PARENT_EVENT_LOOP'
  };
}

async function owned(run) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'squire-result-receipt-'));
  await fs.chmod(directory, 0o700);
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
}

function fileSystemPort(io = fs) {
  return {lstat: io.lstat.bind(io), open: io.open.bind(io)};
}

function controlledFileSystem({lstat, open, unlink} = {}) {
  return {
    async lstat(path, ...args) {
      const value = await fs.lstat(path, ...args);
      return lstat ? lstat(path, value) : value;
    },
    async open(path, ...args) {
      const handle = await fs.open(path, ...args);
      return open ? open(path, handle) : handle;
    },
    async unlink(path) {
      if (unlink) return unlink(path);
      return fs.unlink(path);
    }
  };
}

function statData(stat, changes = {}) {
  return {
    dev: changes.dev ?? stat.dev, ino: changes.ino ?? stat.ino,
    uid: changes.uid ?? stat.uid, nlink: changes.nlink ?? stat.nlink,
    mode: changes.mode ?? stat.mode, size: changes.size ?? stat.size,
    mtimeMs: changes.mtimeMs ?? stat.mtimeMs, ctimeMs: changes.ctimeMs ?? stat.ctimeMs,
    isFile: () => stat.isFile(), isDirectory: () => stat.isDirectory(),
    isSymbolicLink: () => stat.isSymbolicLink()
  };
}

function wrappedHandle(handle, {stat, read, writeFile, close} = {}) {
  let statCalls = 0;
  return {
    async stat() {
      const value = await handle.stat();
      return stat ? stat(value, statCalls++) : value;
    },
    async writeFile(bytes) {
      return writeFile ? writeFile(handle, bytes) : handle.writeFile(bytes);
    },
    async read(...args) {
      return read ? read(handle, ...args) : handle.read(...args);
    },
    async close() {
      return close ? close(handle) : handle.close();
    }
  };
}

function fakeRuntime(response, {aborted = false} = {}) {
  let time = 0;
  const timers = [];
  const controller = new AbortController();
  if (aborted) controller.abort();
  const child = new EventEmitter();
  child.pid = 123;
  child.unref = () => {};
  child.kill = () => true;
  for (const name of ['stdout', 'stderr', 'stdin']) {
    child[name] = new EventEmitter();
    child[name].destroy = () => {};
  }
  child.stdin.write = (_bytes, callback) => { callback(); return true; };
  child.stdin.end = callback => {
    callback();
    if (!aborted) queueMicrotask(() => {
      child.stdout.emit('data', encode(response));
      child.stdout.emit('end');
      child.stderr.emit('end');
      child.emit('exit', 0, null);
    });
  };
  const calls = [];
  return {
    controller, calls,
    clock: {
      now: () => time,
      schedule(delay, callback) {
        const timer = {at: time + delay, callback, active: true};
        timers.push(timer);
        return () => { timer.active = false; };
      }
    },
    spawn(...args) {
      calls.push(args);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  };
}

async function boundedAdverseTurns(maxTurns = 32) {
  for (let turn = 0; turn < maxTurns; turn++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function waitForAdverseSpawn(runtime) {
  await runtime.spawnSignal;
  assert.equal(runtime.spawnObserved, true, 'synthetic spawn observed');
}

function adverseRuntime(mode) {
  let time = 0;
  const timers = [];
  const controller = new AbortController();
  const child = new EventEmitter();
  child.pid = 123;
  child.unref = () => {};
  child.kill = signal => {
    child.signals.push(signal);
    return true;
  };
  child.signals = [];
  for (const name of ['stdout', 'stderr', 'stdin']) {
    child[name] = new EventEmitter();
    child[name].destroy = () => {};
  }
  child.stdin.write = (_bytes, callback) => {
    callback();
    return true;
  };
  child.stdin.end = callback => {
    callback();
    if (['nonzero-exit', 'stage-exists', 'outer-cleanup-throws-after-ACK'].includes(mode)) {
      queueMicrotask(() => {
        child.stdout.emit('data', encode(projectStream()));
        child.stdout.emit('end');
        child.stderr.emit('end');
        child.emit('exit', mode === 'nonzero-exit' ? 3 : 0, null);
      });
    }
  };
  const calls = [];
  let spawnObserved = false;
  let resolveSpawnSignal;
  const spawnSignal = new Promise(resolve => { resolveSpawnSignal = resolve; });
  return {
    controller,
    calls,
    child,
    spawnSignal,
    get spawnObserved() { return spawnObserved; },
    clock: {
      now: () => time,
      schedule(delay, callback) {
        const timer = {at: time + delay, callback, active: true};
        timers.push(timer);
        return () => {
          if (mode === 'outer-cleanup-throws-after-ACK' && delay === 140000) {
            throw Error(PRIVATE_ERROR);
          }
          timer.active = false;
        };
      }
    },
    spawn(...args) {
      calls.push(args);
      if (mode === 'spawn-throws') throw Error(PRIVATE_ERROR);
      queueMicrotask(() => {
        spawnObserved = true;
        child.emit('spawn');
        resolveSpawnSignal();
      });
      return child;
    },
    async advance(to) {
      assert.ok(Number.isSafeInteger(to) && to >= time);
      time = to;
      for (let turn = 0; turn < 32; turn++) {
        const next = timers
          .filter(timer => timer.active && timer.at <= time)
          .sort((left, right) => left.at - right.at)[0];
        if (!next) break;
        next.active = false;
        next.callback();
        await Promise.resolve();
      }
      assert.equal(timers.some(timer => timer.active && timer.at <= time), false,
        'all due synthetic timers settled within 32 transitions');
      await boundedAdverseTurns();
    }
  };
}

function projectStream() {
  const envelope = JSON.stringify({
    schema: 'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',
    files: [{
      path: 'src/index.mjs', classification: 'SOURCE', encoding: 'utf-8',
      content: 'export const synthetic = 1;\n'
    }]
  });
  const events = [
    {type: 'turn.started'},
    {type: 'item.completed', item: {type: 'agent_message', text: envelope}},
    {type: 'turn.completed', usage: {input_tokens: 0, output_tokens: 3, cached_input_tokens: 0, reasoning_output_tokens: 1}}
  ];
  return `${events.map(value => JSON.stringify(value)).join('\n')}\n`;
}

function runnerInputs(directory, runtime) {
  const specification = {
    job_id: jobId(), task_scope: directory, requested_model: MODEL, effort: EFFORT,
    max_wall_clock_sec: 120, prompt_bytes: buildProjectCodegenPrompt(request)
  };
  return {
    specification,
    options: {clock: runtime.clock, shutdown: GENERATION_SHUTDOWN, abortSignal: runtime.controller.signal},
    ports: {
      fs, uid: process.getuid(), spawn: runtime.spawn, executable: '/synthetic/codex',
      codex: {observed_cli_version: '0.160.0', authorization, permissions: {sandbox: 'read-only', approval_mode: 'never', output_contract: 'CODEX_JSONL_SINGLE_AGENT_V1'}}, environment: {PUBLIC: 'synthetic'}
    }
  };
}

async function reportFile(path) {
  let stdout = '', stderr = '';
  const code = await runOfflineReportCli([path], {
    stdout: {write: value => { stdout += value; }},
    stderr: {write: value => { stderr += value; }}
  });
  return {code, stdout, stderr};
}

test('injected staged and early-null runner results round-trip through private write and offline reporting', async () => {
  for (const scenario of [
    {name: 'staged', aborted: false, status: 'CANDIDATE_STAGED', generation: true, calls: 1},
    {name: 'early-null', aborted: true, status: 'INCOMPLETE', generation: false, calls: 0}
  ]) {
    await owned(async directory => {
      const runtime = fakeRuntime(projectStream(), {aborted: scenario.aborted});
      const input = runnerInputs(directory, runtime);
      const live = await runProjectCodexTask(input.specification, input.options, input.ports);
      assert.equal(live.status, scenario.status, scenario.name);
      assert.equal(live.generation !== null, scenario.generation);
      assert.equal(projectProjectRunSummary(live).readiness,
        scenario.generation ? 'INVALID_RECEIPT' : scenario.status);
      assert.equal(live.task_correctness, 'NOT_EVALUATED');
      assert.equal(live.task_outcome_evaluated, false);
      assert.equal(runtime.calls.length, scenario.calls);

      const receipt = createProjectResultReceipt(live);
      assert.equal(Object.isFrozen(receipt), true);
      assert.equal(receipt.operator_receipt, PRIVATE);
      assert.equal(receipt.task_correctness, 'NOT_EVALUATED');
      assert.equal(Object.hasOwn(receipt.generation ?? {}, 'late_observations'), false);
      if (scenario.generation) {
        assert.equal(live.generation.record.provider_metadata.usage_tokens.input, 0);
        assert.equal(live.generation.record.provider_metadata.usage_tokens.cache_read, 0);
      }
      const path = join(directory, `${scenario.name}.json`);
      const acknowledgement = await writeProjectResultReceipt(
        live, {directory, filename: `${scenario.name}.json`},
        {fs: fileSystemPort(), uid: process.getuid()}
      );
      assert.deepEqual(Object.keys(acknowledgement), [
        'schema', 'status', 'byte_count', 'sha256', 'crash_durability', 'source_authenticity'
      ]);
      assert.equal(acknowledgement.status, 'RECORDED');
      assert.equal(acknowledgement.crash_durability, 'NOT_ESTABLISHED');
      assert.equal(acknowledgement.source_authenticity, 'NOT_ESTABLISHED');
      assert.equal(JSON.stringify(acknowledgement).includes(PRIVATE), false);

      const bytes = await readReceiptBytes(path);
      assert.equal(bytes.length, acknowledgement.byte_count);
      assert.ok(bytes.length <= REPORT_MAX_BYTES);
      const parsed = parseReceiptJson(bytes);
      const summary = projectProjectRunSummary(parsed);
      assert.equal(summary.readiness, scenario.status);
      assert.equal(summary.has_operator_receipt, true);
      if (scenario.generation) {
        assert.equal(summary.generation.provider_metadata.usage_tokens.input, 0);
        assert.equal(summary.generation.provider_metadata.usage_tokens.cache_read, 0);
        assert.equal(summary.generation.provider_metadata.usage_tokens.thinking, null);
        assert.equal(summary.generation.provider_metadata.usage_tokens.total, null);
      }
      assert.doesNotMatch(
        JSON.stringify(summary) + formatProjectSummaryTerminal(summary),
        /PRIVATE_SENTINEL_RECEIPT|synthetic-project-model/
      );
      assert.match(formatProjectSummaryTerminal(summary), new RegExp(scenario.status));
      const cli = await reportFile(path);
      assert.equal(cli.code, 1);
      assert.match(cli.stdout, new RegExp(scenario.status));
      assert.equal(cli.stderr, '');
      assert.doesNotMatch(cli.stdout + cli.stderr, /PRIVATE_SENTINEL_RECEIPT|synthetic-project-model/);
      const invalidPath = join(directory, 'invalid.json');
      await fs.writeFile(invalidPath,
        `${JSON.stringify({...nullGenerationResult(), hidden: PRIVATE})}\n`, {mode: 0o600});
      const invalidCli = await reportFile(invalidPath);
      assert.equal(invalidCli.code, 2);
      assert.equal(invalidCli.stderr, 'SCHEMA_MISMATCH\n');
      assert.doesNotMatch(invalidCli.stdout + invalidCli.stderr, /PRIVATE_SENTINEL_RECEIPT/);
      const parent = await fs.stat(directory);
      const leaf = await fs.stat(path);
      assert.equal(parent.mode & 0o7777, 0o700);
      assert.equal(leaf.mode & 0o7777, 0o600);

      if (scenario.name === 'staged') {
        assert.equal(typeof live.generation.late_observations, 'function');
        let lateEffects = 0, invalidIoCalls = 0;
        const invalidFs = {
          async lstat() { invalidIoCalls++; },
          async open() { invalidIoCalls++; }
        };
        const proxiedLate = {
          ...live,
          generation: {
            ...live.generation,
            late_observations: new Proxy(live.generation.late_observations, {
              apply() { lateEffects++; }
            })
          }
        };
        const accessorGeneration = {
          record: live.generation.record,
          runtime_evidence: live.generation.runtime_evidence,
          diagnostic_retention: live.generation.diagnostic_retention
        };
        Object.defineProperty(accessorGeneration, 'late_observations', {
          get() { lateEffects++; return live.generation.late_observations; }
        });
        const accessorLate = {...live, generation: accessorGeneration};
        for (const invalidLive of [proxiedLate, accessorLate]) {
          assert.throws(() => createProjectResultReceipt(invalidLive),
            error => error.code === 'INVALID_INPUT');
          await assert.rejects(writeProjectResultReceipt(
            invalidLive, {directory, filename: 'invalid-live.json'},
            {fs: invalidFs, uid: process.getuid()}
          ), error => error.code === 'INVALID_INPUT' && error.message === 'INVALID_INPUT');
        }
        assert.equal(lateEffects, 0);
        assert.equal(invalidIoCalls, 0);
        let invoked = 0;
        const caller = {
          ...live,
          generation: {
            ...live.generation,
            record: {...live.generation.record},
            late_observations: () => { invoked++; }
          }
        };
        const independent = createProjectResultReceipt(caller);
        caller.generation.record.requested_model = 'changed-after-capture';
        assert.equal(invoked, 0);
        assert.equal(independent.generation.record.requested_model, live.generation.record.requested_model);
        assert.equal(independent.operator_receipt, PRIVATE);
        assert.equal(Object.hasOwn(independent.generation, 'late_observations'), false);
        assert.doesNotMatch(JSON.stringify(independent), /late_observations/);
      }
    });
  }
});

test('closed capture rejects hostile descriptors, proxies, symbols, cycles, functions, and oversized strings before IO', async () => {
  let effects = 0;
  const hostile = [
    ['getter', value => Object.defineProperty(value, 'status', {get() { effects++; throw Error(PRIVATE); }})],
    ['symbol', value => { value[Symbol('hidden')] = 1; }],
    ['hidden extra', value => Object.defineProperty(value, 'hidden', {value: PRIVATE})],
    ['function and toJSON', value => { value.toJSON = () => { effects++; }; }],
    ['cycle', value => { value.operator_receipt = value; }],
    // Keep the current closed profile and text budgets; do not invent a larger valid receipt to reach its encoded cap.
    ['oversized text', value => { value.operator_receipt = 'x'.repeat(4097); }]
  ];
  await owned(async directory => {
    let ioCalls = 0;
    const io = {
      lstat: async () => { ioCalls++; throw Error(PRIVATE); },
      open: async () => { ioCalls++; throw Error(PRIVATE); }
    };
    for (const [name, mutate] of hostile) {
      const value = nullGenerationResult();
      mutate(value);
      assert.throws(() => createProjectResultReceipt(value), error =>
        error.code === 'INVALID_INPUT' && error.message === 'INVALID_INPUT', name);
      await assert.rejects(writeProjectResultReceipt(
        value, {directory, filename: 'invalid.json'}, {fs: io, uid: process.getuid()}
      ), error => error.code === 'INVALID_INPUT' && error.message === 'INVALID_INPUT', name);
    }
    const proxy = new Proxy(nullGenerationResult(), {
      get() { effects++; throw Error(PRIVATE); },
      ownKeys() { effects++; throw Error(PRIVATE); }
    });
    assert.throws(() => createProjectResultReceipt(proxy), error => error.code === 'INVALID_INPUT');
    await assert.rejects(
      writeProjectResultReceipt(proxy, {directory, filename: 'x.json'}, {fs: io, uid: process.getuid()}),
      error => error.code === 'INVALID_INPUT' && error.message === 'INVALID_INPUT'
    );
    assert.equal(ioCalls, 0);
  });
  assert.equal(effects, 0);
});

test('saved copy preserves caller data independently and keeps null, zero, and spawn-failure compatibility exact', async () => {
  const source = nullGenerationResult();
  source.direct_child_invocations.generation = 0;
  const saved = createProjectResultReceipt(source);
  source.operator_receipt = 'mutated';
  source.direct_child_invocations.generation = 1;
  assert.equal(saved.operator_receipt, PRIVATE);
  assert.equal(saved.direct_child_invocations.generation, 0);
  assert.equal(Object.isFrozen(saved.direct_child_invocations), true);
  assert.equal(projectProjectRunSummary(saved).readiness, 'INCOMPLETE');

  const success = nullGenerationResult();
  success.status = 'GENERATION_REJECTED';
  success.reason = 'GENERATION_REJECTED';
  success.direct_child_invocations.generation = 1;
  const spawnFailure = {
    record: {
      job_id: '8d9ee341-6fa3-4acc-8b93-000000000001',
      task_class: 'PROJECT_CODEGEN_V1', lifecycle_status: 'LIMITED_SPAWN_FAILED',
      requested_model: 'gpt-6-luna', reported_model: 'UNKNOWN',
      process_exit: {pid: null, exit_code: null, exit_signal: null, process_wall_ms: 0, observed_termination: false},
      io_state: {stdout_bytes_observed: 0, stderr_bytes_observed: 0, stdout_eof: false, stderr_eof: false, io_drained: false},
      containment_evidence: {containment_level: 'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING', settlement_status: 'UNKNOWN', descendant_guarantee: 'NONE'},
      provider_metadata: {provider_reported_status: null, duration_seconds: null, usage_tokens: {input: 'UNKNOWN', output: 'UNKNOWN', cache_read: 'UNKNOWN', thinking: 'UNKNOWN', total: 'UNKNOWN'}},
      output_custody: {persisted: false, path: null, byte_count: null, persistence_error: null},
      task_outcome_evaluated: false, task_payload_valid: false,
      error_details: {code: null, classification: null, message: null}
    },
    runtime_evidence: {
      deadline_ms: 0, timeout_latched: false, abort_latched: false, signal_attempts: [],
      event_loop_condition: 'RESPONSIVE_PARENT_EVENT_LOOP', workspace_reuse: 'NOT_AUTHORIZED',
      workspace_disposition: 'QUARANTINED', max_steps: 'UNSUPPORTED'
    },
    diagnostic_retention: {
      retention_status: 'NOT_REQUESTED', rejection_stage: null, rejection_reason: null,
      exact_response_bytes: null, retained_bytes_count: null, retained_truncated: false, retention_error: null
    }
  };
  success.generation = spawnFailure;
  const accepted = createProjectResultReceipt(success);
  assert.equal(projectProjectRunSummary(accepted).readiness, 'GENERATION_REJECTED');
  success.direct_child_invocations.generation = 0;
  assert.equal(projectProjectRunSummary(success).readiness, 'INVALID_RECEIPT');
  assert.throws(() => createProjectResultReceipt(success), error => error.code === 'INVALID_RECEIPT');
  await owned(async directory => {
    let ioCalls = 0;
    const io = {
      async lstat() { ioCalls++; },
      async open() { ioCalls++; }
    };
    await assert.rejects(writeProjectResultReceipt(
      success, {directory, filename: 'incompatible.json'}, {fs: io, uid: process.getuid()}
    ), error => error.code === 'INVALID_RECEIPT' && error.message === 'INVALID_RECEIPT');
    assert.equal(ioCalls, 0);
  });
});

test('destination and injected ports are closed and rejected before filesystem access', async () => {
  await owned(async directory => {
    let calls = 0;
    const io = {lstat: async () => { calls++; }, open: async () => { calls++; }};
    const valid = nullGenerationResult();
    for (const destination of [
      {directory: '/', filename: 'receipt.json'},
      {directory: `${directory}/..`, filename: 'receipt.json'},
      {directory, filename: '.'},
      {directory, filename: '..'},
      {directory, filename: 'a/b'},
      {directory, filename: 'bad\u0000name'},
      {directory, filename: 'é.json'},
      {directory, filename: 'x'.repeat(129)}
    ]) {
      await assert.rejects(writeProjectResultReceipt(valid, destination, {fs: io, uid: process.getuid()}),
        error => error.code === 'INVALID_DESTINATION' && error.message === 'INVALID_DESTINATION');
    }
    await assert.rejects(writeProjectResultReceipt(valid, {directory, filename: 'receipt.json'}, {fs: io, uid: -1}),
      error => error.code === 'INVALID_PORTS' && error.message === 'INVALID_PORTS');
    assert.equal(calls, 0);
  });
});

test('exclusive create preserves existing leaves, symlinks, and directories without overwrite or cleanup', async () => {
  await owned(async directory => {
    const valid = nullGenerationResult();
    const existing = join(directory, 'existing.json');
    await fs.writeFile(existing, 'PREEXISTING_SENTINEL', {mode: 0o600});
    await assert.rejects(writeProjectResultReceipt(valid, {directory, filename: 'existing.json'},
      {fs: fileSystemPort(), uid: process.getuid()}), error => error.code === 'WRITE_FAILED');
    assert.equal(await fs.readFile(existing, 'utf8'), 'PREEXISTING_SENTINEL');

    const target = join(directory, 'target.txt');
    await fs.writeFile(target, 'SYMLINK_TARGET_SENTINEL', {mode: 0o600});
    await fs.symlink(target, join(directory, 'link.json'));
    await assert.rejects(writeProjectResultReceipt(valid, {directory, filename: 'link.json'},
      {fs: fileSystemPort(), uid: process.getuid()}), error => error.code === 'WRITE_FAILED');
    assert.equal((await fs.lstat(join(directory, 'link.json'))).isSymbolicLink(), true);
    assert.equal(await fs.readFile(target, 'utf8'), 'SYMLINK_TARGET_SENTINEL');

    await fs.mkdir(join(directory, 'directory.json'), {mode: 0o700});
    await assert.rejects(writeProjectResultReceipt(valid, {directory, filename: 'directory.json'},
      {fs: fileSystemPort(), uid: process.getuid()}), error => error.code === 'WRITE_FAILED');
    assert.deepEqual(await fs.readdir(join(directory, 'directory.json')), []);
    assert.doesNotMatch(PRIVATE, /WRITE_FAILED/);
  });
});

test('parent and leaf owner, mode, identity, and every special permission bit are checked from metadata', async () => {
  const owner = process.getuid();
  for (const scenario of [
    {name: 'parent mode', lstat: (directory, path, stat) => path === directory ? statData(stat, {mode: stat.mode & ~0o0200}) : stat},
    {name: 'parent owner', lstat: (directory, path, stat) => path === directory ? statData(stat, {uid: owner + 1}) : stat},
    {name: 'leaf mode', handleStat: (path, stat, index) => index === 0 ? statData(stat, {mode: stat.mode & ~0o0200}) : stat},
    {name: 'leaf owner', handleStat: (path, stat, index) => index === 0 ? statData(stat, {uid: owner + 1}) : stat}
  ]) {
    await owned(async directory => {
      let parentChecks = 0;
      const io = controlledFileSystem({
        lstat: (path, stat) => scenario.lstat
          ? scenario.lstat(directory, path, stat, parentChecks++)
          : stat,
        open: (path, handle) => wrappedHandle(handle, {stat: (stat, index) =>
          scenario.handleStat ? scenario.handleStat(path, stat, index) : stat})
      });
      await assert.rejects(writeProjectResultReceipt(nullGenerationResult(),
        {directory, filename: 'metadata.json'}, {fs: io, uid: owner}),
      error => error.code === 'WRITE_FAILED' && error.message === 'WRITE_FAILED', scenario.name);
    });
  }

  for (const bit of [0o1000, 0o2000, 0o4000]) {
    for (const target of ['parent identity', 'leaf read identity', 'final leaf identity']) {
      await owned(async directory => {
        let parentChecks = 0;
        let unlinks = 0;
        const leaf = join(directory, 'special.json');
        const io = controlledFileSystem({
          lstat: (path, stat) => {
            if (target === 'parent identity' && path === directory && ++parentChecks === 2)
              return statData(stat, {mode: stat.mode | bit});
            if (target === 'final leaf identity' && path === leaf)
              return statData(stat, {mode: stat.mode | bit});
            return stat;
          },
          open: (path, handle) => wrappedHandle(handle, {stat: (stat, index) =>
            target === 'leaf read identity' && index === 2 ? statData(stat, {mode: stat.mode | bit}) : stat}),
          unlink: async path => { unlinks++; return fs.unlink(path); }
        });
        await assert.rejects(writeProjectResultReceipt(nullGenerationResult(),
          {directory, filename: 'special.json'}, {fs: io, uid: owner}),
        error => error.code === 'WRITE_FAILED' && error.message === 'WRITE_FAILED', `${target} ${bit}`);
        const remaining = await fs.lstat(leaf).catch(() => null);
        assert.ok(remaining?.isFile() && !remaining.isSymbolicLink(), `${target} ${bit}`);
        assert.equal(remaining.mode & 0o7777, 0o600, `${target} ${bit}`);
        assert.equal(unlinks, 0, `${target} ${bit}`);
      });
    }
  }
});

test('bounded readback requires observed EOF and rejects 65 positive partial reads without retry', async () => {
  await owned(async directory => {
    const value = nullGenerationResult();
    const bytes = encode(`${JSON.stringify(createProjectResultReceipt(value))}\n`);
    assert.ok(bytes.length > 64);
    const step = Math.floor((bytes.length - 1) / 64);
    let reads = 0, unlinks = 0;
    const io = controlledFileSystem({
      open: (path, handle) => wrappedHandle(handle, {
        read: async (target, buffer, offset, length, position) => {
          reads++;
          const limit = reads <= 64 ? step : length;
          return target.read(buffer, offset, Math.min(length, limit), position);
        }
      }),
      unlink: async path => { unlinks++; return fs.unlink(path); }
    });
    await assert.rejects(writeProjectResultReceipt(value, {directory, filename: 'partial.json'},
      {fs: io, uid: process.getuid()}), error => error.code === 'WRITE_FAILED');
    assert.equal(reads, 65);
    assert.equal(unlinks, 0);
    assert.equal((await fs.stat(join(directory, 'partial.json'))).size, bytes.length);
  });
});

test('writer rejects identity, read-result, and filesystem faults with fixed errors and one close', async () => {
  const failures = [
    'parent-identity', 'leaf-identity', 'read-state',
    'read-negative', 'read-fractional', 'read-unsafe', 'read-overrequested', 'read-zero',
    'read-missing', 'read-getter', 'read-proxy',
    'lstat', 'open', 'stat', 'read'
  ];
  for (const failure of failures) {
    await owned(async directory => {
      const leaf = join(directory, 'fault.json');
      let parentChecks = 0, openAttempts = 0, returnedHandles = 0, closes = 0;
      let unlinks = 0, reads = 0, resultEffects = 0, promiseThenChecks = 0;
      const unlink = async path => { unlinks++; return fs.unlink(path); };
      const lstatHook = (path, stat) => {
        if (failure === 'lstat') throw Error(PRIVATE);
        if (path === directory) {
          parentChecks++;
          if (failure === 'parent-identity' && parentChecks === 2)
            return statData(stat, {ino: stat.ino + 1});
        }
        if (failure === 'leaf-identity' && path === leaf)
          return statData(stat, {ino: stat.ino + 1});
        return stat;
      };
      const io = failure === 'open'
        ? {
            lstat: path => fs.lstat(path),
            async open() { openAttempts++; throw Error(PRIVATE); },
            unlink
          }
        : controlledFileSystem({
            lstat: lstatHook,
            open: (path, handle) => {
              openAttempts++;
              returnedHandles++;
              return wrappedHandle(handle, {
                stat: (stat, index) => {
                  if (failure === 'stat' && index === 0) throw Error(PRIVATE);
                  if (failure === 'read-state' && index === 2)
                    return statData(stat, {mtimeMs: stat.mtimeMs + 1});
                  return stat;
                },
                read: async (target, buffer, offset, length, position) => {
                  reads++;
                  if (failure === 'read') throw Error(PRIVATE);
                  if (failure === 'read-negative') return {bytesRead: -1};
                  if (failure === 'read-fractional') return {bytesRead: 0.5};
                  if (failure === 'read-unsafe') return {bytesRead: Number.MAX_SAFE_INTEGER + 1};
                  if (failure === 'read-overrequested') return {bytesRead: length + 1};
                  if (failure === 'read-zero') return {bytesRead: 0};
                  if (failure === 'read-missing') return {};
                  if (failure === 'read-getter') {
                    const result = {};
                    Object.defineProperty(result, 'bytesRead', {
                      get() { resultEffects++; throw Error(PRIVATE); }
                    });
                    return result;
                  }
                  if (failure === 'read-proxy') return new Proxy({bytesRead: 1}, {
                    get(_target, key) {
                      if (key === 'then') { promiseThenChecks++; return undefined; }
                      resultEffects++;
                      throw Error(PRIVATE);
                    },
                    getOwnPropertyDescriptor() {
                      resultEffects++;
                      throw Error(PRIVATE);
                    }
                  });
                  return target.read(buffer, offset, length, position);
                },
                close: async target => { closes++; return target.close(); }
              });
            },
            unlink
          });
      await assert.rejects(writeProjectResultReceipt(
        nullGenerationResult(), {directory, filename: 'fault.json'}, {fs: io, uid: process.getuid()}
      ), error => error.code === 'WRITE_FAILED' && error.message === 'WRITE_FAILED' &&
        error.cause === undefined, failure);
      assert.equal(openAttempts, failure === 'lstat' ? 0 : 1, failure);
      assert.equal(closes, returnedHandles, failure);
      assert.equal(unlinks, 0, failure);
      assert.equal(resultEffects, 0, failure);
      if (failure === 'read-proxy') assert.ok(promiseThenChecks >= 1, failure);
      const remaining = await fs.lstat(leaf).catch(() => null);
      assert.equal(remaining !== null, returnedHandles === 1, failure);
      if (remaining) {
        assert.equal(remaining.isFile(), true, failure);
        assert.equal(remaining.mode & 0o7777, 0o600, failure);
      }
      if (failure === 'stat') assert.equal(reads, 0);
    });
  }
});

test('writer never inspects injected IO errors and leaves one private remnant after write failure', async () => {
  for (const kind of ['proxy', 'ordinary', 'primitive']) {
    await owned(async directory => {
      let inspections = 0, opens = 0, writes = 0, closes = 0, unlinks = 0;
      const thrown = kind === 'proxy'
        ? new Proxy({}, {
            getPrototypeOf() { inspections++; throw Error(PRIVATE); },
            get() { inspections++; throw Error(PRIVATE); }
          })
        : kind === 'ordinary' ? Error(PRIVATE) : PRIVATE;
      const io = controlledFileSystem({
        open: (path, handle) => {
          opens++;
          return wrappedHandle(handle, {
            writeFile: async () => { writes++; throw thrown; },
            close: async target => { closes++; return target.close(); }
          });
        },
        unlink: async path => { unlinks++; return fs.unlink(path); }
      });
      await assert.rejects(writeProjectResultReceipt(
        nullGenerationResult(), {directory, filename: `${kind}.json`}, {fs: io, uid: process.getuid()}
      ), error => error.code === 'WRITE_FAILED' && error.message === 'WRITE_FAILED' &&
        error.cause === undefined && !error.message.includes(PRIVATE), kind);
      assert.equal(inspections, 0, kind);
      assert.equal(opens, 1, kind);
      assert.equal(writes, 1, kind);
      assert.equal(closes, 1, kind);
      assert.equal(unlinks, 0, kind);
      const remaining = await fs.stat(join(directory, `${kind}.json`));
      assert.equal(remaining.isFile(), true, kind);
      assert.equal(remaining.mode & 0o7777, 0o600, kind);
    });
  }
});

test('write, readback, and close failures expose fixed errors and may leave private remnants', async () => {
  for (const failure of ['write', 'read', 'close']) {
    await owned(async directory => {
      let writes = 0, reads = 0, closes = 0, opens = 0, unlinks = 0;
      const io = controlledFileSystem({
        open: async (path, handle) => {
          opens++;
          return wrappedHandle(handle, {
            writeFile: async (target, bytes) => {
              writes++;
              if (failure === 'write') {
                await target.writeFile(bytes.subarray(0, Math.min(8, bytes.length)));
                throw Error(PRIVATE);
              }
              return target.writeFile(bytes);
            },
            read: async (target, ...args) => {
              reads++;
              const result = await target.read(...args);
              if (failure === 'read' && reads === 1 && result.bytesRead) args[0][args[1]] ^= 1;
              return result;
            },
            close: async target => {
              closes++;
              await target.close();
              if (failure === 'close') throw Error(PRIVATE);
            }
          });
        },
        unlink: async path => { unlinks++; return fs.unlink(path); }
      });
      await assert.rejects(writeProjectResultReceipt(nullGenerationResult(),
        {directory, filename: `${failure}.json`}, {fs: io, uid: process.getuid()}),
      error => error.code === 'WRITE_FAILED' && error.message === 'WRITE_FAILED' && !error.message.includes(PRIVATE));
      assert.equal(opens, 1);
      assert.equal(writes, 1);
      assert.equal(closes, 1);
      assert.equal(unlinks, 0);
      assert.equal((await fs.stat(join(directory, `${failure}.json`))).isFile(), true);
      if (failure === 'read') assert.ok(reads <= 65);
    });
  }
});

test('six injected adverse producer results round-trip through the private saved receipt and offline reports',
  {timeout: 5000}, async () => {
    const scenarios = [
      {
        id: 'spawn-throws', status: 'GENERATION_REJECTED', reason: 'GENERATION_REJECTED',
        lifecycle: 'LIMITED_SPAWN_FAILED', calls: 1, staging: false,
        settlement: 'UNKNOWN', processObserved: false, hasProviderStream: false
      },
      {
        id: 'nonzero-exit', status: 'GENERATION_REJECTED', reason: 'GENERATION_REJECTED',
        lifecycle: 'LIMITED_PROCESS_FAILED', calls: 1, staging: false,
        settlement: 'SETTLED_DIRECT_CHILD_EXIT', processObserved: true, hasProviderStream: true
      },
      {
        id: 'timeout-unsettled', status: 'INCOMPLETE', reason: 'GENERATION_REJECTED',
        lifecycle: 'LIMITED_TIMEOUT', calls: 1, staging: false,
        settlement: 'ABANDONED_UNSETTLED', processObserved: false, hasProviderStream: false
      },
      {
        id: 'caller-abort-after-spawn', status: 'INCOMPLETE', reason: 'CANCELED',
        lifecycle: 'LIMITED_USER_ABORT', calls: 1, staging: false,
        settlement: 'ABANDONED_UNSETTLED', processObserved: false, hasProviderStream: false
      },
      {
        id: 'stage-exists', status: 'STAGING_REJECTED',
        reason: 'STAGING:DESTINATION_ALREADY_EXISTS',
        lifecycle: 'LIMITED_SUCCESS', calls: 1, staging: false,
        settlement: 'SETTLED_DIRECT_CHILD_EXIT', processObserved: true, hasProviderStream: true
      },
      {
        id: 'outer-cleanup-throws-after-ACK', status: 'FAILED',
        reason: 'CLEANUP_FAILED_OR_UNCERTAIN',
        lifecycle: 'LIMITED_SUCCESS', calls: 1, staging: true,
        settlement: 'SETTLED_DIRECT_CHILD_EXIT', processObserved: true, hasProviderStream: true
      }
    ];

    await owned(async directory => {
      let spawnFailureLive;
      for (const scenario of scenarios) {
        const scope = join(directory, `scope-${scenario.id}`);
        await fs.mkdir(scope, {mode: 0o700});
        const runtime = adverseRuntime(scenario.id);
        const input = runnerInputs(scope, runtime);
        if (scenario.id === 'stage-exists') {
          const runDirectory = join(scope, 'output', `run-${input.specification.job_id}`);
          input.ports.fs = {
            ...fs,
            async mkdir(path, ...args) {
              const result = await fs.mkdir(path, ...args);
              if (path === runDirectory) await fs.mkdir(join(path, 'stage'), {mode: 0o700});
              return result;
            }
          };
        }

        const pending = runProjectCodexTask(input.specification, input.options, input.ports);
        if (scenario.id === 'timeout-unsettled') {
          await waitForAdverseSpawn(runtime);
          await runtime.advance(120000);
          await runtime.advance(123000);
          await runtime.advance(125000);
        } else if (scenario.id === 'caller-abort-after-spawn') {
          await waitForAdverseSpawn(runtime);
          runtime.controller.abort();
          await runtime.advance(3000);
          await runtime.advance(5000);
        }
        const live = await pending;
        if (scenario.id === 'spawn-throws') spawnFailureLive = live;

        assert.equal(live.schema, 'SQUIRE2_PROJECT_RESULT_V1', scenario.id);
        assert.equal(live.status, scenario.status, scenario.id);
        assert.equal(live.reason, scenario.reason, scenario.id);
        assert.equal(live.task_correctness, 'NOT_EVALUATED', scenario.id);
        assert.equal(live.task_outcome_evaluated, false, scenario.id);
        assert.equal(live.runtime_admitted, false, scenario.id);
        assert.equal(live.operator_admitted, false, scenario.id);
        assert.equal(live.workspace_disposition, 'QUARANTINED', scenario.id);
        assert.equal(runtime.calls.length, scenario.calls, scenario.id);
        assert.equal(live.direct_child_invocations.generation, scenario.calls, scenario.id);
        assert.equal(live.generation.record.lifecycle_status, scenario.lifecycle, scenario.id);
        assert.equal(live.generation.record.containment_evidence.settlement_status,
          scenario.settlement, scenario.id);
        assert.equal(live.generation.record.process_exit.observed_termination,
          scenario.processObserved, scenario.id);
        assert.equal(live.staging !== null, scenario.staging, scenario.id);
        assert.equal(typeof live.generation.late_observations, 'function', scenario.id);

        const receipt = createProjectResultReceipt(live);
        assert.equal(Object.isFrozen(receipt), true, scenario.id);
        assert.equal(receipt.generation !== live.generation, true, scenario.id);
        assert.equal(typeof live.generation.late_observations, 'function', scenario.id);
        assert.deepEqual(Object.keys(receipt.generation).sort(),
          ['diagnostic_retention', 'record', 'runtime_evidence'], scenario.id);
        assert.doesNotMatch(JSON.stringify(receipt), /late_observations/, scenario.id);
        for (const key of ['record', 'runtime_evidence', 'diagnostic_retention']) {
          assert.equal(JSON.stringify(receipt.generation[key]),
            JSON.stringify(live.generation[key]), `${scenario.id} preserves ${key}`);
        }
        assert.equal(receipt.task_correctness, 'NOT_EVALUATED', scenario.id);
        assert.equal(receipt.task_outcome_evaluated, false, scenario.id);
        assert.equal(receipt.operator_receipt, PRIVATE, scenario.id);

        const receiptPath = join(directory, `saved-${scenario.id}.json`);
        const acknowledgement = await writeProjectResultReceipt(
          live, {directory, filename: `saved-${scenario.id}.json`},
          {fs: fileSystemPort(), uid: process.getuid()}
        );
        assert.deepEqual(Object.keys(acknowledgement), [
          'schema', 'status', 'byte_count', 'sha256', 'crash_durability', 'source_authenticity'
        ], scenario.id);
        assert.equal(acknowledgement.status, 'RECORDED', scenario.id);
        assert.equal(acknowledgement.crash_durability, 'NOT_ESTABLISHED', scenario.id);
        assert.equal(acknowledgement.source_authenticity, 'NOT_ESTABLISHED', scenario.id);
        assert.equal(JSON.stringify(acknowledgement).includes(PRIVATE), false, scenario.id);

        const bytes = await readReceiptBytes(receiptPath);
        assert.equal(bytes.length, acknowledgement.byte_count, scenario.id);
        const parsed = parseReceiptJson(bytes);
        assert.equal(JSON.stringify(parsed), JSON.stringify(receipt), scenario.id);
        assert.ok(JSON.stringify(parsed).includes(PRIVATE), scenario.id);
        assert.ok(JSON.stringify(parsed).includes(MODEL), scenario.id);
        const privatePath = live.generation.record.output_custody.path;
        if (typeof privatePath === 'string') {
          assert.ok(JSON.stringify(parsed).includes(privatePath), scenario.id);
        }
        const savedStat = await fs.stat(receiptPath);
        assert.equal(savedStat.mode & 0o7777, 0o600, scenario.id);

        const summary = projectProjectRunSummary(parsed);
        assert.equal(summary.readiness, scenario.status, scenario.id);
        assert.equal(summary.reason, scenario.reason, scenario.id);
        assert.equal(summary.task_correctness, 'NOT_EVALUATED', scenario.id);
        assert.equal(summary.task_outcome_evaluated, false, scenario.id);
        assert.equal(summary.runtime_admitted_marker, false, scenario.id);
        assert.equal(summary.operator_admitted_marker, false, scenario.id);
        assert.equal(summary.direct_child_invocations.generation, scenario.calls, scenario.id);
        assert.equal(summary.generation.lifecycle_status, scenario.lifecycle, scenario.id);
        assert.equal(summary.generation.containment_evidence.settlement_status,
          scenario.settlement, scenario.id);
        assert.equal(summary.generation.process_exit.observed_termination,
          scenario.processObserved, scenario.id);
        assert.equal(summary.staging !== null, scenario.staging, scenario.id);
        assert.equal(summary.staging?.operation_acknowledgement ?? null,
          scenario.staging ? 'ACKNOWLEDGED' : null, scenario.id);
        assert.equal(summary.has_operator_receipt, true, scenario.id);

        const rawTokens = parsed.generation.record.provider_metadata.usage_tokens;
        const projectedTokens = summary.generation.provider_metadata.usage_tokens;
        if (scenario.hasProviderStream) {
          assert.equal(rawTokens.input, 0, scenario.id);
          assert.equal(rawTokens.output, 3, scenario.id);
          assert.equal(rawTokens.cache_read, 0, scenario.id);
          assert.equal(rawTokens.thinking, 'UNKNOWN', scenario.id);
          assert.equal(rawTokens.total, 'UNKNOWN', scenario.id);
          assert.equal(projectedTokens.input, 0, scenario.id);
          assert.equal(projectedTokens.cache_read, 0, scenario.id);
          assert.equal(projectedTokens.thinking, null, scenario.id);
          assert.equal(projectedTokens.total, null, scenario.id);
        } else {
          assert.equal(rawTokens.input, 'UNKNOWN', scenario.id);
          assert.equal(rawTokens.output, 'UNKNOWN', scenario.id);
          assert.equal(rawTokens.cache_read, 'UNKNOWN', scenario.id);
          assert.equal(projectedTokens.input, null, scenario.id);
          assert.equal(projectedTokens.output, null, scenario.id);
          assert.equal(projectedTokens.cache_read, null, scenario.id);
        }

        const terminal = formatProjectSummaryTerminal(summary);
        assert.match(terminal, new RegExp(`Squire offline project result: ${scenario.status}`), scenario.id);
        assert.match(terminal, new RegExp(`Reason: ${scenario.reason.replaceAll(':', '\\:')}`), scenario.id);
        assert.match(terminal, new RegExp(`Generation: ${scenario.lifecycle}`), scenario.id);
        assert.match(terminal, /Task correctness: NOT_EVALUATED/, scenario.id);
        assert.match(terminal, /Task outcome evaluated: false/, scenario.id);
        assert.match(terminal, /Direct child invocations: generation=1;/, scenario.id);
        assert.match(terminal, new RegExp(
          `observed termination: ${scenario.processObserved ? 'true' : 'false'}`), scenario.id);
        assert.match(terminal, new RegExp(
          `operation=${scenario.staging ? 'ACKNOWLEDGED' : 'NONE'}`), scenario.id);

        const cli = await reportFile(receiptPath);
        assert.equal(cli.code, 1, scenario.id);
        assert.equal(cli.stdout, terminal, scenario.id);
        assert.equal(cli.stderr, '', scenario.id);
        const publicOutput = JSON.stringify(summary) + terminal +
          JSON.stringify(acknowledgement) + cli.stdout + cli.stderr;
        for (const sentinel of [PRIVATE, MODEL, PRIVATE_ERROR, privatePath].filter(Boolean)) {
          assert.equal(publicOutput.includes(sentinel), false, `${scenario.id} omits ${sentinel}`);
        }
      }

      assert.equal(spawnFailureLive.direct_child_invocations.generation, 1);
      const incompatible = {
        ...spawnFailureLive,
        direct_child_invocations: {...spawnFailureLive.direct_child_invocations, generation: 0}
      };
      assert.throws(() => createProjectResultReceipt(incompatible),
        error => error.code === 'INVALID_RECEIPT');
      let invalidIoCalls = 0;
      const invalidFs = {
        async lstat() { invalidIoCalls++; },
        async open() { invalidIoCalls++; }
      };
      await assert.rejects(writeProjectResultReceipt(
        incompatible, {directory, filename: 'count-zero-incompatible.json'},
        {fs: invalidFs, uid: process.getuid()}
      ), error => error.code === 'INVALID_RECEIPT' && error.message === 'INVALID_RECEIPT');
      assert.equal(invalidIoCalls, 0);
      assert.equal(spawnFailureLive.direct_child_invocations.generation, 1);
    });
  });

