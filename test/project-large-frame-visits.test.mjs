import assert from 'node:assert/strict';
import test from 'node:test';
import {createCodexLargeProjectStreamCollector} from '../src/project-stream-collector.mjs';
import {decodeLargeProjectCodexJsonl} from '../src/provider-metadata.mjs';
import {PROJECT_OUTPUT_LARGE_PROFILE} from '../src/project-coding-profile.mjs';

const encode = text => new TextEncoder().encode(text);

function drainedCollector(bytes) {
  const collector = createCodexLargeProjectStreamCollector();
  collector.chunk('stdout', bytes);
  collector.eof('stdout');
  collector.eof('stderr');
  return collector;
}

test('large collector decodes each nonblank transport frame exactly once', t => {
  const content = 'synthetic é\n';
  const envelope = JSON.stringify({
    schema: 'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',
    files: [{path: 'main.js', classification: 'SOURCE', encoding: 'utf-8', content}]
  });
  const frames = [
    {type: 'turn.started'},
    ...Array.from({length: 256}, () => ({type: 'notice'})),
    {type: 'item.completed', item: {type: 'agent_message', text: envelope}},
    {type: 'turn.completed', usage: {input_tokens: 0}}
  ].map((event, frame) => JSON.stringify({...event, frame}));
  const bytes = encode(frames.join('\n \t\r\n'));
  const metadata = decodeLargeProjectCodexJsonl({
    raw_payload_bytes: bytes,
    max_response_bytes: PROJECT_OUTPUT_LARGE_PROFILE.max_stdout_bytes,
    wrapper_exit_code: 0, wrapper_signal: null, wrapper_wall_ms: 7
  });
  const collector = drainedCollector(bytes);
  t.after(() => collector.close());

  // Count complete transport frames at the UTF-8 decoder. Payload decoding
  // also uses TextDecoder, so match only the unique serialized frame strings.
  const frameSet = new Set(frames);
  const visited = [];
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, 'decode', function (...args) {
    const text = Reflect.apply(decode, this, args);
    if (frameSet.has(text)) visited.push(text);
    return text;
  });
  const result = collector.decode({exit_code: 0, process_wall_ms: 7});
  assert.equal(visited.length, frames.length);
  assert.deepEqual(visited, frames);
  assert.deepEqual(result.bytes, encode(envelope));
  assert.deepEqual(result.payload.files[0].content, encode(content));
  assert.deepEqual(result.metadata, metadata);
  assert.deepEqual(metadata.usage, {input: 0, output: null, cache_read: null, thinking: null, total: null});
});

test('large collector preserves metadata and provider error precedence over response ordering', () => {
  const unordered = '{"type":"item.completed","item":{"type":"agent_message","text":"ignored"}}\n';
  const completed = '{"type":"turn.completed"}\n';
  const failed = '{"type":"turn.failed"}\n';
  for (const [suffix, reason] of [
    [completed + '{', 'MALFORMED_JSON'],
    [completed + completed + '{', 'MALFORMED_JSON'],
    [completed + failed + '{', 'CONFLICTING_TERMINAL_EVENTS'],
    [failed, 'TURN_FAILED'],
    ['', 'MISSING_TERMINAL'],
    [completed, 'ENVELOPE_PARSE_ERROR']
  ]) {
    const collector = drainedCollector(encode(unordered + suffix));
    try {
      assert.throws(() => collector.decode(), error => error.field === reason);
      assert.equal(collector.diagnosticReport().reason, reason);
      assert.equal(collector.diagnosticCapture(), null);
    } finally {
      collector.close();
    }
  }
});
