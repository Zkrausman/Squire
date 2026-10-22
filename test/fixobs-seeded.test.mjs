import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAMMAR_VERSION, LIMITS, SEEDS, xorshift32, choose, encodeTrace,
  checkLedger, checkTransition, checkSummary, oracleFailureTrace,
  eligibleSetTimeChoices, possibleOwnLaunchPid, validFirstLaunchAckPid,
  isOracleFailure, runSeed,
} from './helpers/fixobs-seeded.mjs';

const IDS = Object.freeze({
  LAUNCH: 'op_launch_0', F0_CAPTURE: 'op_capture_F0',
  KEY_ACTION: 'op_action_SPACE', F1_CAPTURE: 'op_capture_F1',
  CLICK_ACTION: 'op_action_BUTTON1', F2_CAPTURE: 'op_capture_F2',
  STOP: 'op_stop_0', SETTLEMENT: 'op_settlement_0',
});
const corr = operation_id => ({
  run_id: 'seeded-run', job_id: 'seeded-job',
  generation_id: 'seeded-generation', operation_id,
});
function freezeTree(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
function oracleCase() {
  const ledger = {launches: 0, actions: 0, captures: 0, stops: 0,
    settlements: 0};
  const model = {observation: 'UNKNOWN', reason: 'CALLER_STOP',
    frames: ['NOT_RUN', 'NOT_RUN', 'NOT_RUN'],
    modeled_reservations: {launches: 0, logical_keys: 0,
      logical_clicks: 0, capture_attempts: 0}};
  const summary = {
    schema: 'squire.fixobs.lifecycle_harness_summary.v2',
    mode: 'SOURCE_SIMULATION', harness_status: 'STOPPED',
    harness_stop_reason: 'CALLER_STOP',
    correlation: {run_id: 'seeded-run', job_id: 'seeded-job',
      generation_id: 'seeded-generation'},
    model_snapshot: model, actual_port_calls: {...ledger},
    ports_summary: {
      launch: {correlation: corr(IDS.LAUNCH), status: 'NOT_RUN',
        t_ack_ms: null, injected_process_id: null, error_code: null},
      actions: [], captures: [],
      stop: {correlation: corr(IDS.STOP), status: 'NOT_RUN',
        t_stop_ms: null, direct_child_exit_observed: false,
        error_code: null},
      settlement: {correlation: corr(IDS.SETTLEMENT), status: 'NOT_RUN',
        t_observed_ms: null, scope_observation: null,
        fenced_scope_descriptors: [], error_code: null},
    },
    retained_owner_state: {abandoned_operations: [],
      orphaned_injected_process_ids: [], fenced_scopes: []},
    audit_events: [], runtime_admitted: false,
    qualified_observation: false, custody_established: false,
    process_ceiling_enforced: false,
  };
  return {summary, snapshot: {model_snapshot: model}, ledger,
    operations: {invalid: false,
      counts: Object.fromEntries(Object.values(IDS).map(id => [id, 0]))}};
}
function verdict(sample) {
  return checkSummary(freezeTree(sample.summary), sample.snapshot,
    sample.ledger, sample.operations);
}
function addActiveRow(sample, phase, status) {
  const ports = sample.summary.ports_summary;
  if (phase === 'LAUNCH') {
    ports.launch.status = status;
    ports.launch.t_ack_ms = status === 'ACK' ? 1000 : null;
    ports.launch.injected_process_id = status === 'ACK' ? 'PID-101' : null;
  } else if (phase.endsWith('_ACTION')) {
    ports.actions.push({correlation: corr(IDS[phase]),
      kind: phase === 'KEY_ACTION' ? 'SPACE_STROKE' :
        'BUTTON1_CENTER_STROKE',
      status, t_ack_ms: status === 'ACK' ? 1000 : null,
      error_code: null});
  } else {
    ports.captures.push({correlation: corr(IDS[phase]),
      phase: phase.slice(0, 2), status,
      t_acquired_ms: status === 'CAPTURED' ? 1000 : null,
      predicate: status === 'CAPTURED' ? 'MATCH' : 'NOT_RUN',
      error_code: null});
  }
}
function invoke(sample, phase) {
  const counter = phase === 'LAUNCH' ? 'launches' :
    phase.endsWith('_ACTION') ? 'actions' :
      phase.endsWith('_CAPTURE') ? 'captures' :
        phase === 'STOP' ? 'stops' : 'settlements';
  sample.operations.counts[IDS[phase]]++;
  sample.ledger[counter]++;
  sample.summary.actual_port_calls[counter]++;
}

test('seed encoding and independent ledger check are deterministic', () => {
  const left = xorshift32(18);
  const right = xorshift32(18);
  const choices = ['LAUNCH', 'POLL', 'ABORT', 'SETTLE'];
  const a = Array.from({length: 64}, () => choose(left, choices));
  const b = Array.from({length: 64}, () => choose(right, choices));
  assert.deepEqual(a, b);
  const trace = {grammar_version: GRAMMAR_VERSION, seed: 18,
    commands: [{op: 'POLL', at: 1100}]};
  assert.equal(encodeTrace(trace), encodeTrace(structuredClone(trace)));
  assert.equal(checkLedger(
    {launches: 2, actions: 0, captures: 0, stops: 0, settlements: 0},
    {launches: 1, actions: 0, captures: 0, stops: 0, settlements: 0}),
  'LEDGER_MISMATCH');
});

test('eight operation rows distinguish dispatch, success, and predispatch fault', () => {
  assert.equal(verdict(oracleCase()), null);
  for (const phase of Object.keys(IDS)) {
    const sample = oracleCase();
    invoke(sample, phase);
    if (phase.endsWith('_ACTION') || phase.endsWith('_CAPTURE'))
      addActiveRow(sample, phase, 'NOT_RUN');
    assert.equal(verdict(sample), 'PUBLIC_ENUM', phase);
  }
  for (const [phase, status] of [
    ['LAUNCH', 'ACK'], ['STOP', 'ACK'],
    ['SETTLEMENT', 'OBSERVED_CLEAN'],
  ]) {
    const sample = oracleCase();
    sample.summary.ports_summary[phase.toLowerCase()].status = status;
    assert.equal(verdict(sample), 'PUBLIC_ENUM', phase);
  }
  for (const [phase, key, value] of [
    ['launch', 'injected_process_id', 'PID-101'],
    ['stop', 'direct_child_exit_observed', true],
    ['settlement', 'fenced_scope_descriptors', ['fixed']],
  ]) {
    const sample = oracleCase();
    sample.summary.ports_summary[phase][key] = value;
    assert.equal(verdict(sample), 'PUBLIC_ENUM', phase);
  }
  const predispatch = oracleCase();
  predispatch.summary.ports_summary.launch.status = 'FAULT';
  predispatch.summary.ports_summary.launch.error_code = 'SCHEDULER_FAULT';
  assert.equal(verdict(predispatch), null);
});

test('canonical PR180 success and visible cleanup faults determine terminal status', () => {
  const nominal = oracleCase();
  nominal.summary.harness_status = 'COMPLETED';
  nominal.summary.harness_stop_reason =
    'THREE_BUFFER_PREDICATES_MATCH';
  assert.equal(verdict(nominal), 'SUCCESS_PROVENANCE');

  function canonical() {
    const sample = oracleCase();
    const model = sample.summary.model_snapshot;
    model.observation = 'BUFFER_SEQUENCE_MATCH';
    model.reason = 'THREE_BUFFER_PREDICATES_MATCH';
    model.frames = ['MATCH', 'MATCH', 'MATCH'];
    model.modeled_reservations = {launches: 1, logical_keys: 1,
      logical_clicks: 1, capture_attempts: 3};
    sample.summary.harness_stop_reason =
      'THREE_BUFFER_PREDICATES_MATCH';
    for (const phase of ['LAUNCH', 'F0_CAPTURE', 'KEY_ACTION',
      'F1_CAPTURE', 'CLICK_ACTION', 'F2_CAPTURE']) {
      invoke(sample, phase);
      addActiveRow(sample, phase,
        phase.endsWith('_CAPTURE') ? 'CAPTURED' : 'ACK');
    }
    invoke(sample, 'STOP');
    Object.assign(sample.summary.ports_summary.stop, {
      status: 'ACK', t_stop_ms: 1000,
      direct_child_exit_observed: true,
    });
    invoke(sample, 'SETTLEMENT');
    Object.assign(sample.summary.ports_summary.settlement, {
      status: 'OBSERVED_CLEAN', t_observed_ms: 1000,
      scope_observation: {scope_id: 'PID-101', launch_closed: true,
        coverage: 'FULL_INSPECTED', live_count: 0,
        conflicting_identities: []},
    });
    return sample;
  }
  const complete = canonical();
  complete.summary.harness_status = 'COMPLETED';
  assert.equal(verdict(complete), null);
  const wrongFrame = canonical();
  wrongFrame.summary.harness_status = 'COMPLETED';
  wrongFrame.summary.model_snapshot.frames[1] = 'UNKNOWN';
  assert.equal(verdict(wrongFrame), 'SUCCESS_PROVENANCE');
  const stopped = canonical();
  assert.equal(verdict(stopped), 'SUCCESS_PROVENANCE');
  const fault = canonical();
  fault.summary.harness_status = 'FAULT';
  fault.summary.ports_summary.stop.status = 'FAULT';
  fault.summary.ports_summary.stop.error_code = 'STOP_FAULT';
  assert.equal(verdict(fault), null);

  const falseCompleteStop = canonical();
  falseCompleteStop.summary.harness_status = 'COMPLETED';
  falseCompleteStop.summary.ports_summary.stop.status = 'FAULT';
  falseCompleteStop.summary.ports_summary.stop.error_code = 'STOP_FAULT';
  assert.equal(verdict(falseCompleteStop), 'SUCCESS_PROVENANCE');

  const falseCompleteTimeout = canonical();
  falseCompleteTimeout.summary.harness_status = 'COMPLETED';
  falseCompleteTimeout.summary.ports_summary.stop.status = 'TIMEOUT';
  falseCompleteTimeout.summary.ports_summary.stop.error_code =
    'CLEANUP_DEADLINE';
  assert.equal(verdict(falseCompleteTimeout), 'SUCCESS_PROVENANCE');

  const falseCompleteSettlement = canonical();
  falseCompleteSettlement.summary.harness_status = 'COMPLETED';
  falseCompleteSettlement.summary.ports_summary.settlement.status = 'UNKNOWN';
  falseCompleteSettlement.summary.ports_summary.settlement
    .scope_observation.coverage = 'PARTIAL';
  falseCompleteSettlement.summary.ports_summary.settlement.error_code =
    'SETTLEMENT_FAULT';
  assert.equal(verdict(falseCompleteSettlement), 'SUCCESS_PROVENANCE');

  const unsupportedFault = canonical();
  unsupportedFault.summary.harness_status = 'FAULT';
  assert.equal(verdict(unsupportedFault), 'SUCCESS_PROVENANCE');

  const settlementFault = canonical();
  settlementFault.summary.harness_status = 'FAULT';
  settlementFault.summary.ports_summary.settlement.status = 'UNKNOWN';
  settlementFault.summary.ports_summary.settlement.scope_observation.coverage =
    'PARTIAL';
  settlementFault.summary.ports_summary.settlement.error_code =
    'SETTLEMENT_FAULT';
  assert.equal(verdict(settlementFault), null);

  const unknownSettlement = canonical();
  unknownSettlement.summary.harness_status = 'COMPLETED';
  unknownSettlement.summary.ports_summary.stop.direct_child_exit_observed =
    false;
  unknownSettlement.summary.ports_summary.settlement.status = 'UNKNOWN';
  unknownSettlement.summary.ports_summary.settlement
    .scope_observation.coverage = 'PARTIAL';
  assert.equal(verdict(unknownSettlement), null);

  const nonemptySettlement = canonical();
  nonemptySettlement.summary.harness_status = 'COMPLETED';
  nonemptySettlement.summary.ports_summary.settlement.status =
    'OBSERVED_NONEMPTY';
  nonemptySettlement.summary.ports_summary.settlement
    .scope_observation.live_count = 1;
  assert.equal(verdict(nonemptySettlement), null);
});

test('invalid observations use the real bounded oracle-to-trace boundary', () => {
  const sentinel = 'RAW_PRIVATE_SENTINEL';
  let getterCalls = 0;
  let proxyCalls = 0;
  const observations = [
    {model_snapshot: {get frames() {
      getterCalls++;
      return [sentinel];
    }}},
    {model_snapshot: new Proxy({}, {ownKeys() {
      proxyCalls++;
      return [sentinel];
    }})},
    {harness_state: sentinel, model_snapshot: {
      reason: sentinel, frames: [sentinel],
      buffer: new Uint8Array([67, 68, 69])},
    retained_owner_state: {
      orphaned_injected_process_ids: [sentinel],
      fenced_scopes: [sentinel]}},
  ];
  const commands = [{op: 'POLL', at: 1100, private_path: sentinel},
    {op: 'SET_TIME', choice: sentinel, value: sentinel}];
  for (const observation of observations) {
    const code = checkTransition({}, observation, {});
    assert.equal(code, 'PUBLIC_RAW_DATA');
    const encoded = oracleFailureTrace(code, observation, 18, commands);
    assert.equal(encoded,
      oracleFailureTrace(code, observation, 18, commands));
    assert.equal(JSON.parse(encoded).invariant_code, 'PUBLIC_RAW_DATA');
    assert.deepEqual(JSON.parse(encoded).commands[0],
      {op: 'POLL', at: 1100});
    assert.ok(encoded.length < 4096);
    assert.equal(encoded.includes(sentinel), false);
    assert.equal(encoded.includes('buffer'), false);
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyCalls, 0);
});

test('ordinary clock eligibility and first launch ACK bounds', () => {
  assert.deepEqual(eligibleSetTimeChoices(11001,
    {phase_deadline_ms: 11000, cleanup_deadline_ms: null},
    ['CURRENT', 'PHASE_CAP', 'PHASE_CAP_PLUS_1']),
  ['CURRENT', 'PHASE_CAP_PLUS_1']);
  assert.deepEqual(eligibleSetTimeChoices(12000,
    {phase_deadline_ms: null, cleanup_deadline_ms: 11000},
    ['CLEANUP_CAP']), []);
  const ack = {correlation: corr(IDS.LAUNCH), status: 'ACK',
    t_ack_ms: 1100, injected_process_id: 'PID-101', error_code: null};
  assert.equal(validFirstLaunchAckPid(ack, 1000, 1200), 'PID-101');
  assert.equal(validFirstLaunchAckPid({...ack, t_ack_ms: 999},
    1000, 1200), null);
  assert.equal(validFirstLaunchAckPid({...ack, t_ack_ms: 1201},
    1000, 1200), null);
  const malformed = {...ack, t_ack_ms: 999, extra: 'fixed'};
  assert.equal(validFirstLaunchAckPid(malformed, 1000, 1200), null);
  assert.equal(possibleOwnLaunchPid(malformed), 'PID-101');
});

test('32 bounded source-simulation seeds', async () => {
  const commandSignatures = new Set();
  const operations = new Set();
  const failures = [];
  let count = 0;
  let n7Checks = 0;
  for (const seed of SEEDS) {
    try {
      const result = await runSeed(seed);
      assert.equal(result.seed, seed);
      assert.ok(result.count > 0 && result.count <= LIMITS.commands);
      count += result.count;
      n7Checks += result.n7Checks;
      commandSignatures.add(encodeTrace(result.commands));
      for (const command of result.commands) operations.add(command.op);
    } catch (error) {
      failures.push(
        isOracleFailure(error) ?
          error : new Error(`seed ${seed}: DRIVER_EXCEPTION`));
    }
  }
  if (failures.length)
    throw new AggregateError(failures,
      `${failures.length} of ${SEEDS.length} seeded runs failed`);
  assert.ok(count <= 1600);
  assert.ok(commandSignatures.size >= 8,
    `distinct command streams: ${commandSignatures.size}`);
  assert.ok(n7Checks >= 1);
  for (const op of ['STEP', 'SET_TIME', 'POLL', 'DELIVER_DEADLINE',
    'SETTLE_PENDING', 'REJECT_PENDING', 'ABORT', 'ARM_REENTRY',
    'TRY_INVALID_STEP', 'DUPLICATE_LAUNCH'])
    assert.ok(operations.has(op), `missing generated operation ${op}`);
  console.log(`seeded source simulation: seeds=32 commands=${count} ` +
    `distinct_command_streams=${commandSignatures.size} n7_checks=${n7Checks}`);
});
