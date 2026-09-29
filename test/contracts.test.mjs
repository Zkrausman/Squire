import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validateTickets, validateReview } from '../src/contracts.mjs';
import { ticket } from './support.mjs';
const services = { app: {} };
test('dependency graph rejects cycles, unknown predecessors and unknown services', () => {
  assert.throws(() => validateTickets([ticket('a', ['b']), ticket('b', ['a'])], services), /cycle/);
  assert.throws(() => validateTickets([ticket('a', ['missing'])], services), /Unknown dependency/);
  assert.throws(() => validateTickets([ticket('a', [], 'missing')], services), /Unknown service/);
  assert.throws(() => validateTickets([ticket('a'), ticket('a')], services), /Duplicate/);
  assert.equal(validateTickets([ticket('a'), ticket('b', ['a'])], services).length, 2);
});
test('review binds head and cannot pass with unresolved findings', () => {
  const sha = 'a'.repeat(40), review = { headSha: sha, verdict: 'pass', summary: 'fine', findings: [] };
  assert.equal(validateReview(review, sha), review);
  assert.throws(() => validateReview(review, 'b'.repeat(40)), /wrong-head/);
  assert.throws(() => validateReview({ ...review, findings: [{ priority: 'P1', file: 'a', line: 1, message: 'fix' }] }, sha), /unresolved/);
});
test('project rejects unknown authority fields, keys, paths and API runtime', () => {
  const config = { version: 1, id: 'p', stateDir: '/state', tickets: [ticket('a')], services: { app: { source: '/source', branch: 'main', delivery: { kind: 'local' }, checks: [{ name: 'test', argv: ['node', '--test'], timeoutSeconds: 10 }] } } };
  // Use platform-native absolute paths on Windows.
  if (process.platform === 'win32') { config.stateDir = 'C:\\state'; config.services.app.source = 'C:\\source'; }
  assert.throws(() => validateConfig({ ...config, apiKey: 'secret' }), /Unknown/);
  assert.throws(() => validateConfig({ ...config, runtime: { kind: 'api' } }), /adapter/);
  assert.throws(() => validateConfig({ ...config, stateDir: config.services.app.source }), /outside/);
  assert.throws(() => validateConfig({ ...config, limits: { maxParallel: 100 } }), /maxParallel/);
  assert.throws(() => validateConfig({ ...config, services: { app: { ...config.services.app, branch: '-main' } } }), /branch/);
});
