import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mapAppServerTurn} from '../src/app-server-turn-mapping.mjs';
import {createCodexLargeProjectStreamCollector} from '../src/project-stream-collector.mjs';
import {decodeCodexJsonl, iterateLargeProjectCodexJsonlFrames} from '../src/provider-metadata.mjs';

const THREAD = 'thread-selected-01';
const TURN = 'turn-selected-01';
const ITEM = 'item-final-01';
const OTHER_ITEM = 'item-commentary-01';
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value);
const line = value => JSON.stringify(value);
const jsonl = events => bytes(events.map(line).join('\n') + '\n');
const env = (method, params, extra = {}) => ({method, params, ...extra});
const agent = (id, text, phase = 'final_answer', extra = {}) => ({
  type: 'agentMessage', id, text, phase, memoryCitation: null, delivery: null, questions: null, ...extra
});
const turnValue = (id, status, items = [], extra = {}) => ({
  id, items, itemsView: 'full', status, error: null, startedAt: 1, completedAt: 2, durationMs: 100, ...extra
});
const startTurn = (threadId = THREAD, turnId = TURN, extra = {}) => env('turn/started', {
  threadId, turn: turnValue(turnId, 'inProgress', [], {completedAt: null, durationMs: null})
}, extra);
const startItem = (item, threadId = THREAD, turnId = TURN) => env('item/started', {
  item, threadId, turnId, startedAtMs: 10
});
const finishItem = (item, threadId = THREAD, turnId = TURN) => env('item/completed', {
  item, threadId, turnId, completedAtMs: 20
});
const usage = (threadId = THREAD, turnId = TURN, patch = {}) => env('thread/tokenUsage/updated', {
  threadId, turnId, tokenUsage: {
    total: {totalTokens: 120, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5},
    last: {totalTokens: 12, inputTokens: 10, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 1},
    modelContextWindow: 1000,
    ...patch
  }
});
const terminal = (status = 'completed', items = [], extra = {}) => env('turn/completed', {
  threadId: THREAD,
  turn: turnValue(TURN, status, items, {
    error: status === 'completed' ? null : {message: 'PRIVATE_ERROR_SENTINEL', codexErrorInfo: null, additionalDetails: null, misalignment: null},
    ...extra
  })
});
const serverError = (willRetry = false) => env('error', {
  error: {message: 'PRIVATE_ERROR_SENTINEL', codexErrorInfo: null, additionalDetails: 'PRIVATE_PATH_SENTINEL', misalignment: null},
  willRetry, threadId: THREAD, turnId: TURN
});

function successEvents(text = 'final result', {commentary = true, deltas = ['not authoritative', 'still not authoritative'], usageEvents = [], terminalItems, terminalView = 'full'} = {}) {
  const completed = [];
  const events = [startTurn()];
  if (commentary) {
    const comment = agent(OTHER_ITEM, 'internal commentary', 'commentary');
    events.push(startItem(agent(OTHER_ITEM, '', 'commentary')));
    events.push(finishItem(comment));
    completed.push(comment);
  }
  events.push(startItem(agent(ITEM, '', 'commentary')));
  for (const delta of deltas) events.push(env('item/agentMessage/delta', {threadId: THREAD, turnId: TURN, itemId: ITEM, delta}));
  const final = agent(ITEM, text, 'final_answer');
  events.push(finishItem(final));
  completed.push(final);
  events.push(...usageEvents);
  const items = terminalItems ?? completed;
  events.push(env('turn/completed', {threadId: THREAD, turn: turnValue(TURN, 'completed', items, {itemsView: terminalView})}));
  return events;
}
function mapEvents(events, overrides = {}) {
  return mapAppServerTurn({raw_payload_bytes: jsonl(events), thread_id: THREAD, turn_id: TURN, local_cancelled: false, ...overrides});
}
function assertShape(result, status, reason = null) {
  assert.deepEqual(Object.keys(result), ['status', 'reason', 'projected_bytes']);
  assert.equal(result.status, status);
  assert.match(result.reason, /^[A-Z][A-Z0-9_]{0,47}$/);
  if (reason !== null) assert.equal(result.reason, reason);
  if (status !== 'COMPLETED') assert.equal(result.projected_bytes, null);
  else {
    assert.ok(result.projected_bytes instanceof Uint8Array);
    assert.ok(result.projected_bytes.byteLength <= 1048576);
  }
}

test('successful final projection uses completed text after commentary and arbitrary deltas', () => {
  const text = 'authoritative final answer';
  const result = mapEvents(successEvents(text, {usageEvents: [usage(THREAD, TURN, {
    total: {totalTokens: 900, inputTokens: 800, cachedInputTokens: 700, cacheWriteInputTokens: 600, outputTokens: 100, reasoningOutputTokens: 90},
    last: {totalTokens: 9, inputTokens: 8, cachedInputTokens: 7, cacheWriteInputTokens: 6, outputTokens: 1, reasoningOutputTokens: 0}
  })]}));
  assertShape(result, 'COMPLETED', 'NONE');
  const frames = [...iterateLargeProjectCodexJsonlFrames(result.projected_bytes)];
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map(frame => frame.type), ['turn.started', 'item.completed', 'turn.completed']);
  assert.equal(frames[1].item.type, 'agent_message');
  assert.equal(frames[1].item.text, text);
  assert.equal(frames[2].usage, undefined);
  assert.equal(new TextDecoder().decode(result.projected_bytes).includes('internal commentary'), false);
  assert.equal(new TextDecoder().decode(result.projected_bytes).includes('not authoritative'), false);
  assert.equal(new TextDecoder().decode(result.projected_bytes).includes(String(900)), false);
  const metadata = decodeCodexJsonl({raw_payload_bytes: result.projected_bytes, max_response_bytes: 1048576,
    wrapper_exit_code: null, wrapper_signal: null, wrapper_wall_ms: null});
  assert.equal(metadata.provider_reported_status, 'turn.completed');
  assert.deepEqual(metadata.usage, {input: null, output: null, cache_read: null, thinking: null, total: null});
  assert.equal(metadata.raw_wrapper.exit_code, null);
  assert.equal(metadata.raw_wrapper.signal, null);
  assert.equal(metadata.raw_wrapper.wall_duration_ms, null);
});

test('synthetic explicit EOF and decode({}) handoff interoperates with the existing project collector', () => {
  const projectText = JSON.stringify({schema: 'SQUIRE2_PROJECT_FILE_ENVELOPE_V1', files: [
    {path: 'main.js', classification: 'SOURCE', encoding: 'utf-8', content: 'export default 1;'}
  ]});
  const result = mapEvents(successEvents(projectText));
  assertShape(result, 'COMPLETED', 'NONE');
  const collector = createCodexLargeProjectStreamCollector();
  assert.equal(collector.chunk('stdout', result.projected_bytes), true);
  collector.eof('stdout');
  collector.eof('stderr');
  assert.deepEqual(collector.snapshot(), {stdout_bytes_observed: result.projected_bytes.length,
    stderr_bytes_observed: 0, stdout_eof: true, stderr_eof: true, io_drained: true});
  const decoded = collector.decode({});
  assert.equal(decoded.payload.files.length, 1);
  assert.equal(decoded.metadata.provider_reported_status, 'turn.completed');
  assert.deepEqual(decoded.metadata.usage, {input: null, output: null, cache_read: null, thinking: null, total: null});
  assert.deepEqual(decoded.metadata.raw_wrapper, {exit_code: null, signal: null, wall_duration_ms: null});
  collector.close();
});

test('all terminal outcomes stay distinct and only completed with a null error can project', () => {
  const cases = [
    ['failed', 'FAILED'], ['interrupted', 'INTERRUPTED'], ['inProgress', 'UNKNOWN']
  ];
  for (const [providerStatus, expected] of cases) {
    const events = [startTurn(), terminal(providerStatus, [])];
    const result = mapEvents(events);
    assertShape(result, expected);
    assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR_SENTINEL'), false);
  }
  const completedWithError = terminal('completed', [], {error: {message: 'PRIVATE_ERROR_SENTINEL', codexErrorInfo: null,
    additionalDetails: null, misalignment: null}});
  assertShape(mapEvents([startTurn(), completedWithError]), 'UNKNOWN');
});

test('server errors, retries, interruption and local cancellation never become completed success', () => {
  const finalEvents = successEvents('private final');
  const cases = [
    {name: 'error without terminal remains unknown', events: [startTurn(), serverError(false)], status: 'UNKNOWN'},
    {name: 'retry followed by completed is failed', events: [startTurn(), serverError(true), ...finalEvents.slice(1)], status: 'FAILED', reason: 'SERVER_ERROR'},
    {name: 'non-retry error followed by completed is failed', events: [startTurn(), serverError(false), ...finalEvents.slice(1)], status: 'FAILED', reason: 'SERVER_ERROR'},
    {name: 'explicit interruption is not settlement', events: [startTurn(), terminal('interrupted', [])], status: 'INTERRUPTED', reason: 'TURN_INTERRUPTED'},
    {name: 'local cancellation is not server interruption', events: finalEvents, status: 'CANCELED', reason: 'LOCAL_CANCELLATION', overrides: {local_cancelled: true}}
  ];
  for (const item of cases) {
    const result = mapEvents(item.events, item.overrides);
    assertShape(result, item.status, item.reason ?? null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR_SENTINEL|PRIVATE_PATH_SENTINEL|private final/);
    assert.equal(Object.hasOwn(result, 'settled'), false);
  }
});

test('missing, repeated, contradictory, post-terminal, and malformed lifecycle sequences fail closed', () => {
  const base = successEvents('private final');
  const start = base[0], tail = base.at(-1), beforeTerminal = base.slice(1, -1);
  const cases = [
    ['missing terminal', [start, ...beforeTerminal], 'UNKNOWN'],
    ['terminal only', [tail], 'UNKNOWN'],
    ['missing start', [...base.slice(1)], 'UNKNOWN'],
    ['repeated start', [start, start, ...beforeTerminal, tail], 'UNKNOWN'],
    ['repeated terminal', [...base, tail], 'UNKNOWN'],
    ['contradictory terminal', [...base, terminal('failed', [])], 'UNKNOWN'],
    ['event after terminal', [...base, usage()], 'UNKNOWN'],
    ['orphan item completion', [start, finishItem(agent(ITEM, 'private final')), tail], 'UNKNOWN'],
    ['repeated item completion', [start, startItem(agent(ITEM, '', 'final_answer')),
      finishItem(agent(ITEM, 'private final')), finishItem(agent(ITEM, 'private final')), tail], 'UNKNOWN'],
    ['delta after item completion', [start, startItem(agent(ITEM, '', 'final_answer')),
      finishItem(agent(ITEM, 'private final')), env('item/agentMessage/delta',
        {threadId: THREAD, turnId: TURN, itemId: ITEM, delta: 'late'}),
      terminal('completed', [agent(ITEM, 'private final')])], 'UNKNOWN'],
    ['terminal with outstanding item', [start, startItem(agent(ITEM, '', 'final_answer')), tail], 'UNKNOWN'],
    ['terminal-only final message witness', [start, terminal('completed', [agent(ITEM, 'private final')])], 'UNKNOWN']
  ];
  for (const [name, events, status] of cases) {
    const result = mapEvents(events);
    assertShape(result, status);
    assert.doesNotMatch(JSON.stringify(result), /private final/ , name);
  }
});

test('selected identities bind every supported event and final response is unambiguous', () => {
  const base = successEvents('private identity response');
  const wrongThread = structuredClone(base);
  wrongThread[1].params.threadId = 'PRIVATE_THREAD_SENTINEL';
  const wrongTurn = structuredClone(base);
  wrongTurn[3].params.turnId = 'PRIVATE_TURN_SENTINEL';
  const wrongDeltaItem = structuredClone(base);
  wrongDeltaItem.find(event => event.method === 'item/agentMessage/delta').params.itemId = 'PRIVATE_ITEM_SENTINEL';
  const doubleFinal = successEvents('one').slice(0, -1);
  const second = agent('item-final-02', 'two', 'final_answer');
  doubleFinal.push(startItem(agent('item-final-02', '', 'commentary')), finishItem(second));
  doubleFinal.push(terminal('completed', [
    agent(OTHER_ITEM, 'internal commentary', 'commentary'), agent(ITEM, 'one'), second
  ]));
  const cases = [wrongThread, wrongTurn, wrongDeltaItem, doubleFinal];
  for (const events of cases) {
    const result = mapEvents(events);
    assertShape(result, 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_(?:THREAD|TURN|ITEM)_SENTINEL|private identity response/);
  }
  for (const overrides of [{thread_id: ''}, {turn_id: ''}, {thread_id: undefined}, {turn_id: undefined}]) {
    const result = mapEvents(base, overrides);
    assertShape(result, 'UNKNOWN');
  }
});

test('terminal full item witnesses must exactly match completed agent-message witnesses', () => {
  const complete = agent(ITEM, 'witness final', 'final_answer');
  const base = successEvents('witness final', {commentary: false});
  const cases = [
    successEvents('witness final', {commentary: false, terminalView: 'notLoaded'}),
    successEvents('witness final', {commentary: false, terminalView: 'summary'}),
    successEvents('witness final', {commentary: false, terminalItems: []}),
    successEvents('witness final', {commentary: false, terminalItems: [agent(ITEM, 'mismatch', 'final_answer')]}),
    successEvents('witness final', {commentary: false, terminalItems: [agent('wrong-item', 'witness final', 'final_answer')]}),
    successEvents('witness final', {commentary: false, terminalItems: [complete, complete]})
  ];
  assertShape(mapEvents(base), 'COMPLETED', 'NONE');
  for (const events of cases) assertShape(mapEvents(events), 'UNKNOWN');
});

test('only supported agentMessage lifecycle fields are admitted; phase and nullable fields fail closed', () => {
  const cases = [];
  for (const phase of [null, 'unknown', 'analysis']) {
    cases.push(successEvents('phase case', {commentary: false}).map((event, index) => {
      const clone = structuredClone(event);
      if (clone.method === 'item/started' && index === 1) clone.params.item.phase = phase;
      return clone;
    }));
  }
  for (const field of ['memoryCitation', 'delivery', 'questions']) {
    const events = successEvents('nullable case', {commentary: false});
    events[1].params.item[field] = field === 'questions' ? [] : 'async';
    cases.push(events);
  }
  for (const unsupported of [
    {type: 'reasoning', id: 'reasoning-1', summary: [], content: []},
    {type: 'functionCallOutput', id: 'tool-1', name: 'tool', namespace: null, output: {type: 'text', text: 'PRIVATE_TOOL_SENTINEL'}}
  ]) {
    cases.push([startTurn(), startItem(unsupported), finishItem(unsupported), terminal('completed', [unsupported])]);
  }
  for (const events of cases) assertShape(mapEvents(events), 'UNKNOWN');
});

test('unknown methods, envelope fields, statuses, shapes and error prose never leak', () => {
  const good = successEvents('must not escape');
  const unknownMethod = structuredClone(good);
  unknownMethod[2] = env('turn/plan/updated', {threadId: THREAD, turnId: TURN, plan: 'PRIVATE_PLAN_SENTINEL'});
  const unknownStatus = [startTurn(), terminal('PRIVATE_STATUS_SENTINEL', [])];
  const unknownShape = structuredClone(good);
  unknownShape[0].rpcId = 'PRIVATE_RPC_SENTINEL';
  const badErrorShape = [startTurn(), env('error', {message: 'PRIVATE_ERROR_SENTINEL', willRetry: false, threadId: THREAD, turnId: TURN})];
  const nullError = [startTurn(), env('error', {error: null, willRetry: false, threadId: THREAD, turnId: TURN})];
  for (const [events, expectedReason] of [
    [unknownMethod, null], [unknownStatus, null], [unknownShape, null], [badErrorShape, null],
    [nullError, 'ENVELOPE_REJECTED']
  ]) {
    const result = mapEvents(events);
    assertShape(result, 'UNKNOWN', expectedReason);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_(?:PLAN|STATUS|RPC|ERROR)_SENTINEL|must not escape/);
  }
});

test('usage fields validate as cumulative thread counters but never become projected turn usage', () => {
  const valid = usage();
  for (const value of [0, 9, 9007199254740991]) {
    const zeroOrLarge = usage(THREAD, TURN, {total: {totalTokens: value, inputTokens: value, cachedInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0},
    last: {totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0},
    modelContextWindow: null});
    assertShape(mapEvents(successEvents('safe', {commentary: false, usageEvents: [zeroOrLarge]})), 'COMPLETED', 'NONE');
  }
  const badCounters = [
    usage(THREAD, TURN, {total: {...valid.params.tokenUsage.total, inputTokens: -1}}),
    usage(THREAD, TURN, {last: {...valid.params.tokenUsage.last, outputTokens: 1.5}}),
    usage(THREAD, TURN, {modelContextWindow: -1}),
    usage(THREAD, TURN, {total: {...valid.params.tokenUsage.total, reasoningOutputTokens: 9007199254740992}})
  ];
  for (const bad of badCounters) assertShape(mapEvents(successEvents('safe', {commentary: false, usageEvents: [bad]})), 'UNKNOWN');
  const result = mapEvents(successEvents('safe', {commentary: false, usageEvents: [valid, valid]}));
  assertShape(result, 'COMPLETED', 'NONE');
  assert.doesNotMatch(new TextDecoder().decode(result.projected_bytes), /tokenUsage|totalTokens|inputTokens|usage/);
});

test('malformed UTF-8, malformed JSON, decoded duplicate keys and depth fail without leaking diagnostics', () => {
  const valid = jsonl(successEvents('private malformed marker'));
  const malformed = [
    new Uint8Array([0xff, 0x0a]),
    bytes('{"method":"turn/started","params":}\n'),
    bytes('{"method":"turn/started","params":{},"\\u006dethod":"turn/started"}\n'),
    bytes(' '.repeat(1) + '{"method":"turn/started","params":{"x":' + '['.repeat(80) + '0' + ']'.repeat(80) + '}}\n')
  ];
  assert.ok(new TextDecoder().decode(malformed[2]).includes('\\u006d'));
  assert.ok(valid.length > 0);
  for (const raw_payload_bytes of malformed) {
    const result = mapAppServerTurn({raw_payload_bytes, thread_id: THREAD, turn_id: TURN, local_cancelled: false});
    assertShape(result, 'UNKNOWN');
    assert.doesNotMatch(JSON.stringify(result), /private malformed marker|params|MALFORMED_UTF8/);
  }
});

test('raw transport and frame count are each bounded at 1 MiB and 4096 frames', () => {
  const successful = jsonl(successEvents('cap', {commentary: false}));
  const exactlyOneMiB = new Uint8Array(1048576); exactlyOneMiB.fill(0x20); exactlyOneMiB.set(successful);
  assertShape(mapAppServerTurn({raw_payload_bytes: exactlyOneMiB, thread_id: THREAD, turn_id: TURN, local_cancelled: false}), 'COMPLETED', 'NONE');
  const tooLarge = new Uint8Array(1048577); tooLarge.fill(0x20); tooLarge.set(successful);
  assertShape(mapAppServerTurn({raw_payload_bytes: tooLarge, thread_id: THREAD, turn_id: TURN, local_cancelled: false}), 'UNKNOWN');

  const eventList = [startTurn(), startItem(agent(ITEM, '', 'final_answer'))];
  for (let i = 0; i < 4092; i++) eventList.push(env('item/agentMessage/delta', {
    threadId: THREAD, turnId: TURN, itemId: ITEM, delta: 'x'
  }));
  eventList.push(finishItem(agent(ITEM, 'cap')));
  eventList.push(terminal('completed', [agent(ITEM, 'cap')]));
  assert.equal(eventList.length, 4096);
  assert.ok(jsonl(eventList).length < 1048576);
  assertShape(mapEvents(eventList), 'COMPLETED', 'NONE');
  eventList.splice(-2, 0, env('item/agentMessage/delta', {threadId: THREAD, turnId: TURN, itemId: ITEM, delta: 'x'}));
  assert.equal(eventList.length, 4097);
  assertShape(mapEvents(eventList), 'UNKNOWN');
});

test('JSON escaping and generated projection bytes remain bounded independently of the response text', () => {
  const text = 'quote:" slash:\\ control:\n ' + '"\\\n'.repeat(12000);
  const result = mapEvents(successEvents(text, {commentary: false, deltas: []}));
  assertShape(result, 'COMPLETED', 'NONE');
  assert.ok(encoder.encode(text).length <= 1048576);
  assert.ok(result.projected_bytes.byteLength <= 1048576);
  const frameText = new TextDecoder().decode(result.projected_bytes);
  assert.equal(frameText.includes(JSON.stringify(text)), true);
  const oversizedResponse = 'x'.repeat(1048577);
  assertShape(mapEvents(successEvents(oversizedResponse, {commentary: false, deltas: []})), 'UNKNOWN');
});

test('raw caller input is a closed value object and source remains outside all admission paths', async () => {
  const base = {raw_payload_bytes: jsonl(successEvents('safe')), thread_id: THREAD, turn_id: TURN, local_cancelled: false};
  for (const invalid of [
    {...base, extra: true}, {...base, raw_payload_bytes: 'not bytes'}, {...base, thread_id: ''},
    {...base, turn_id: ''}, {...base, local_cancelled: 0}
  ]) assertShape(mapAppServerTurn(invalid), 'UNKNOWN');
  const source = await readFile(new URL('../src/app-server-turn-mapping.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:project-runner|bounded-codegen-plan|preflight|admission|child_process|spawn\s*\(|execFile|fetch\s*\(|WebSocket)/i);
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.hasOwn(packageJson.exports, './app-server-turn-mapping'), false);
});
