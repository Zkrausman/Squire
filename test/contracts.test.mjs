import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, validateTickets, validateReview, pathIsOwned, planSchema, reviewSchema } from '../src/contracts.mjs';
import { ticket } from './support.mjs';
const services = { app: {} };
const execution = () => ({
  version: 1,
  outcome: 'Add a small exportable helper.',
  ownedPaths: ['src/feature/', 'README.md'],
  contextPaths: ['src/contracts.mjs'],
  invariants: ['Keep the existing public API compatible.'],
  checklist: [{ id: 'api', assertion: 'The helper is exported and behaves as described.', steps: ['Import the helper.', 'Call it with representative input.'], evidence: 'Show the call and result.' }],
  stopWhen: 'Stop after the checklist passes or an external dependency blocks progress.',
  maxAttempts: 2
});
test('dependency graph rejects cycles, unknown predecessors and unknown services', () => {
  assert.throws(() => validateTickets([ticket('a', ['b']), ticket('b', ['a'])], services), /cycle/);
  assert.throws(() => validateTickets([ticket('a', ['missing'])], services), /Unknown dependency/);
  assert.throws(() => validateTickets([ticket('a', [], 'missing')], services), /Unknown service/);
  assert.throws(() => validateTickets([ticket('a'), ticket('a')], services), /Duplicate/);
  assert.equal(validateTickets([ticket('a'), ticket('b', ['a'])], services).length, 2);
});
test('structured execution tickets validate strictly while legacy tickets stay valid', () => {
  const structured = { ...ticket('structured'), execution: execution() };
  assert.equal(validateTickets([structured], services)[0], structured);
  assert.equal(validateTickets([ticket('legacy')], services).length, 1);
  assert.throws(() => validateTickets([{ ...structured, execution: { ...execution(), status: 'pass' } }], services), /Unknown ticket execution field/);
  assert.throws(() => validateTickets([{ ...structured, execution: { ...execution(), ownedPaths: ['/absolute/file'] } }], services), /safe relative path/);
  assert.throws(() => validateTickets([{ ...structured, execution: { ...execution(), contextPaths: ['src/../secret'] } }], services), /safe relative path/);
  assert.throws(() => validateTickets([{ ...structured, execution: { ...execution(), ownedPaths: ['src\\feature\\'] } }], services), /safe relative path/);
  assert.throws(() => validateTickets([{ ...structured, execution: { ...execution(), checklist: [execution().checklist[0], execution().checklist[0]] } }], services), /Duplicate checklist criterion id/);
  const missingEvidence = execution(); delete missingEvidence.checklist[0].evidence;
  assert.throws(() => validateTickets([{ ...structured, execution: missingEvidence }], services), /Missing checklist criterion field: evidence/);
  assert.throws(() => validateTickets([{ ...structured, execution: { ...execution(), maxAttempts: 5 } }], services), /maxAttempts must be 1..4/);
  assert.throws(() => validateTickets([{ ...structured, execution: { ...execution(), invariants: [] } }], services), /invariants must contain 1..10/);
});
test('ownership helper treats trailing slash entries as directory prefixes and others as exact files', () => {
  const paths = ['src/feature/', 'README.md'];
  assert.equal(pathIsOwned('src/feature/new.mjs', paths), true);
  assert.equal(pathIsOwned('src/features/new.mjs', paths), false);
  assert.equal(pathIsOwned('README.md', paths), true);
  assert.equal(pathIsOwned('README.md/child', paths), false);
  assert.equal(pathIsOwned('../README.md', paths), false);
});
test('generated plan schema requires the structured contract and has no mutable criterion status fields', () => {
  const item = planSchema.properties.tickets.items;
  assert.ok(item.required.includes('execution'));
  assert.deepEqual(item.properties.execution.required, ['version', 'outcome', 'ownedPaths', 'contextPaths', 'invariants', 'checklist', 'stopWhen', 'maxAttempts']);
  assert.equal(item.properties.execution.additionalProperties, false);
  assert.equal(item.properties.execution.properties.checklist.items.additionalProperties, false);
  assert.equal(item.properties.execution.properties.checklist.maxItems, 8);
  assert.equal(Object.hasOwn(item.properties.execution.properties.checklist.items.properties, 'status'), false);
  assert.equal(Object.hasOwn(reviewSchema.properties, 'checklist'), true);
  for (const ownedPath of ['src/../escape', `src/${String.fromCharCode(0)}escape`])
    assert.throws(() => validateTickets([{ ...ticket('unsafe'), execution: { ...execution(), ownedPaths: [ownedPath] } }], services), /safe relative path/);
});

test('provider response schemas require all object fields and avoid unsupported regex lookaround', () => {
  function inspect(schema) {
    if (schema.type === 'object') assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    if (schema.pattern) assert.doesNotMatch(schema.pattern, /\(\?[!=]|\(\?<(?=[!=])/);
    for (const child of Object.values(schema.properties ?? {})) inspect(child);
    if (schema.items) inspect(schema.items);
  }
  inspect(reviewSchema); inspect(planSchema);
});
test('review binds head and cannot pass with unresolved findings', () => {
  const sha = 'a'.repeat(40), review = { headSha: sha, verdict: 'pass', summary: 'fine', findings: [] };
  assert.equal(validateReview(review, sha), review);
  assert.throws(() => validateReview(review, 'b'.repeat(40)), /wrong-head/);
  assert.throws(() => validateReview({ ...review, findings: [{ priority: 'P1', file: 'a', line: 1, message: 'fix' }] }, sha), /unresolved/);
});
test('execution-aware passing review requires complete passing evidence; failed review can omit it', () => {
  const sha = 'a'.repeat(40), contract = execution();
  const review = { headSha: sha, verdict: 'pass', summary: 'checked', findings: [], checklist: [{ id: 'api', verdict: 'pass', evidence: 'Imported and called; returned expected output.' }] };
  assert.equal(validateReview(review, sha, contract), review);
  assert.throws(() => validateReview({ ...review, checklist: undefined }, sha, contract), /every execution checklist item/);
  assert.throws(() => validateReview({ ...review, checklist: [{ ...review.checklist[0], evidence: '  ' }] }, sha, contract), /evidence/);
  assert.throws(() => validateReview({ ...review, checklist: [{ ...review.checklist[0], verdict: 'fail' }] }, sha, contract), /passing checklist evidence/);
  assert.throws(() => validateReview({ ...review, checklist: [{ ...review.checklist[0], id: 'unknown' }] }, sha, contract), /Unknown review checklist id/);
  const failed = { ...review, verdict: 'fail', findings: [{ priority: 'P1', file: 'src/feature/api.mjs', line: 1, message: 'Missing behavior.' }], checklist: undefined };
  assert.equal(validateReview(failed, sha, contract), failed);
});
test('review evidence accepts ten corrected criteria but still requires every exact id and evidence', () => {
  const sha = 'c'.repeat(40), contract = execution();
  contract.checklist = Array.from({ length: 8 }, (_, index) => ({
    id: `base-${index}`, assertion: `Base criterion ${index} holds.`,
    steps: [`Exercise base criterion ${index}.`], evidence: `Observe base criterion ${index}.`
  }));
  const corrected = { ...contract, checklist: [...contract.checklist,
    { id: 'correction-one', assertion: 'One narrow boundary is fixed.', steps: ['Run its regression.'], evidence: 'Observe its expected result.' },
    { id: 'correction-two', assertion: 'A second boundary is fixed.', steps: ['Run its regression.'], evidence: 'Observe its expected result.' }
  ] };
  const review = { headSha: sha, verdict: 'pass', summary: 'All exact criteria pass.', findings: [],
    checklist: corrected.checklist.map(item => ({ id: item.id, verdict: 'pass', evidence: `Observed ${item.id} in the candidate.` })) };
  assert.equal(reviewSchema.properties.checklist.maxItems, 10);
  assert.equal(validateReview(review, sha, corrected), review);
  assert.throws(() => validateReview({ ...review, checklist: review.checklist.slice(1) }, sha, corrected), /every execution checklist item/);
  assert.throws(() => validateReview({ ...review, checklist: review.checklist.map((item, index) => index === 9 ? { ...item, id: 'unknown' } : item) }, sha, corrected), /Unknown review checklist id/);
  assert.throws(() => validateReview({ ...review, checklist: review.checklist.map((item, index) => index === 9 ? { ...item, evidence: '  ' } : item) }, sha, corrected), /requires evidence/);
  const nineBase = { ...contract, checklist: Array.from({ length: 9 }, (_, index) => ({
    id: `inherited-${index}`, assertion: `Inherited criterion ${index} holds.`,
    steps: [`Exercise inherited criterion ${index}.`], evidence: `Observe inherited criterion ${index}.`
  })) };
  assert.equal(validateTickets([{ ...ticket('nine-base'), execution: nineBase }], services)[0].execution.checklist.length, 9);
  const elevenBase = { ...nineBase, checklist: Array.from({ length: 11 }, (_, index) => ({ ...nineBase.checklist[index % 9], id: `inherited-${index}` })) };
  assert.throws(() => validateTickets([{ ...ticket('eleven-base'), execution: elevenBase }], services), /checklist must contain 1..10 criteria/);
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
