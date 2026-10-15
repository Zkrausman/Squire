import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectDelivery } from '../src/inspect-delivery.mjs';

const H = 'a'.repeat(40), B = 'b'.repeat(40), T = 'c'.repeat(40), M = 'd'.repeat(40), WRONG = 'e'.repeat(40);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const check = { name: 'test', appId: 17 };

function configFor(root, names = [check], localNames = names) {
  return { version: 1, id: 'project', stateDir: root, tickets: [{ id: 'ticket', service: 'app' }], services: {
    app: { source: 'https://github.com/owner/repo', branch: 'main', delivery: {
      kind: 'github', repository: 'owner/repo', mergeMethod: 'squash', requiredChecks: names.map(item => ({ ...item }))
    }, checks: localNames.map(({ name }) => ({ name, argv: ['node', 'check.mjs'], timeoutSeconds: 30 })) }
  } };
}

function fixture(t, { withProject = true, names = [check], localNames = names, duplicateTicket = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'squire-inspect-delivery-'));
  const projectRoot = path.join(root, 'projects', 'project');
  mkdirSync(projectRoot, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 10 }));
  const config = configFor(root, names, localNames);
  const ticket = { spec: { id: 'ticket', service: 'app' }, headSha: H, baseSha: B, treeSha: T,
    generation: 1, branch: 'squire/project/ticket', deliveryEvidence: null };
  const state = { id: 'project', config, tickets: [ticket], status: 'blocked' };
  if (duplicateTicket) state.tickets.push(structuredClone(ticket));
  const dbPath = path.join(root, 'squire.sqlite');
  function save({ schema = true } = {}) {
    const db = new DatabaseSync(dbPath);
    if (schema) db.exec('CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    if (withProject) db.prepare('INSERT INTO project(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state')
      .run('project', JSON.stringify(state));
    db.close();
  }
  if (withProject) save();
  return { root, projectRoot, config, state, save, dbPath };
}

function identityFor(f, scopeId, overrides = {}) {
  const policyDigest = sha256(Buffer.from(JSON.stringify(f.state.config)));
  return { projectId: 'project', ticketId: 'ticket', service: 'app', repository: 'owner/repo',
    branch: f.state.tickets[0].branch, generation: f.state.tickets[0].generation,
    headSha: f.state.tickets[0].headSha, baseSha: f.state.tickets[0].baseSha,
    treeSha: f.state.tickets[0].treeSha, policyDigest, scopeId, ...overrides };
}

// Build protocol files literally with native crypto/fs. Production receipt helpers
// and the hardened reader are deliberately not used to construct fixture bytes.
function chain(f, nodes, { pointerOverride = undefined } = {}) {
  let previous = null;
  const refs = [];
  for (const node of nodes) {
    const scopeId = node.scopeId ?? randomUUID();
    const refScope = node.refScope ?? scopeId;
    const identity = identityFor(f, scopeId, node.identity ?? {});
    const receipt = { version: 1, identity, fact: structuredClone(node.fact), operations: [], previous,
      ...(node.extra ?? {}) };
    const bytes = Buffer.from(JSON.stringify(receipt));
    assert.ok(bytes.length > 0 && bytes.length <= 128 * 1024, 'fixture receipt respects the reader file cap');
    const file = `${randomUUID()}.json`;
    const directory = path.join(f.projectRoot, 'delivery-evidence', refScope);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, file), bytes, { flag: 'wx', mode: 0o600 });
    const ref = { scopeId: refScope, file, bytes: bytes.length, sha256: sha256(bytes) };
    refs.push(ref);
    previous = ref;
  }
  if (pointerOverride !== undefined) previous = pointerOverride;
  f.state.tickets[0].deliveryEvidence = previous;
  f.save();
  return { anchor: previous, refs };
}

function observation(passed, overrides = {}) {
  return { kind: 'postmerge.observed', mergeSha: M, treeSha: T, passed,
    after: { headSha: passed ? M : WRONG, treeSha: passed ? T : WRONG, dirty: !passed },
    results: [{ name: 'private-command-name', passed, exitCode: passed ? 0 : 1, stopped: false,
      timedOut: false, outputExceeded: false, launchError: false, failureTail: 'private log contents' }], ...overrides };
}

function sourceFingerprint(root) {
  const records = [];
  function walk(current, relative = '') {
    const entries = readdirSync(current).sort();
    const stat = lstatSync(current, { bigint: true });
    records.push([relative || '.', 'directory', String(stat.dev), String(stat.ino), String(stat.mode), String(stat.mtimeNs), String(stat.ctimeNs)]);
    for (const name of entries) {
      const file = path.join(current, name), rel = path.join(relative, name), item = lstatSync(file, { bigint: true });
      if (item.isDirectory() && !item.isSymbolicLink()) walk(file, rel);
      else records.push([rel, String(item.mode), String(item.size), String(item.mtimeNs), String(item.ctimeNs),
        sha256(readFileSync(file))]);
    }
  }
  walk(root);
  return records;
}

function receipt(identity, fact, previous = null) {
  return { version: 1, identity, fact, operations: [], previous };
}

test('resolves a multi-scope chain, classifies a selected synthetic merge, and projects no private extras', async t => {
  const f = fixture(t), synthetic = 'f'.repeat(40);
  chain(f, [
    { scopeId: '00000000-0000-4000-8000-000000000001', fact: { kind: 'ci.merge_candidate', sha: synthetic,
      treeSha: T, parents: [B, H], privateMarker: 'NEVER-OUTPUT-CANDIDATE' }, extra: { sourcePath: '/private/receipt/path' } },
    { scopeId: '00000000-0000-4000-8000-000000000002', fact: { kind: 'ci.selected', required: check,
      selected: { id: 91, name: 'test', appId: 17, headSha: synthetic, status: 'completed', conclusion: 'success', url: 'https://private.invalid' },
      stdout: 'NEVER-OUTPUT-LOG' } },
    { scopeId: '00000000-0000-4000-8000-000000000003', fact: { kind: 'publication.observed', number: 12,
      headSha: H, branch: 'squire/project/ticket', baseSha: WRONG, baseBranch: 'main', repository: 'owner/repo',
      state: 'open', merged: false, mergeSha: null } }
  ]);
  const before = sourceFingerprint(f.root);
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.deepEqual(sourceFingerprint(f.root), before);
  assert.equal(value.status, 'resolved');
  assert.equal(value.chainIntegrity, 'verified');
  assert.deepEqual(value.acceptance, 'not_evaluated');
  assert.equal(value.liveness, 'unknown');
  assert.equal(value.remoteState, 'not_observed');
  assert.equal(value.snapshot.sha256.length, 64);
  const selected = value.facts.find(item => item.kind === 'ci.selected');
  assert.equal(selected.currentness, 'current');
  assert.equal(selected.evidence.selectedAssessment, 'matching_synthetic_merge');
  assert.equal(selected.evidence.selected.headSha, synthetic);
  assert.equal(value.facts.find(item => item.kind === 'ci.merge_candidate').evidence.matchesSyntheticMergeIdentity, true);
  assert.equal(value.facts.find(item => item.kind === 'publication.observed').evidence.baseMatchesIdentity, false);
  assert.equal(JSON.stringify(value).includes('NEVER-OUTPUT'), false);
  assert.equal(JSON.stringify(value).includes('private-command-name'), false);
  assert.equal(JSON.stringify(value).includes('https://'), false);
  assert.equal(JSON.stringify(value).includes('/private/'), false);
});

test('resolves all seven known fact kinds with merge tree and ancestry consistency', async t => {
  const f = fixture(t), synthetic = 'f'.repeat(40);
  chain(f, [
    { fact: { kind: 'publication.intent' } },
    { fact: { kind: 'publication.observed', number: 12, headSha: H, branch: 'squire/project/ticket', baseSha: B,
      baseBranch: 'main', repository: 'owner/repo', state: 'open', merged: false, mergeSha: null } },
    { fact: { kind: 'ci.merge_candidate', sha: synthetic, treeSha: T, parents: [B, H] } },
    { fact: { kind: 'ci.selected', required: check, selected: { id: 91, name: 'test', appId: 17,
      headSha: synthetic, status: 'completed', conclusion: 'success' } } },
    { fact: { kind: 'merge.intent', number: 12, headSha: H, method: 'squash' } },
    { fact: { kind: 'merge.verified', mergeSha: M, treeSha: T, parents: [B] } },
    { fact: observation(true) }
  ]);
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'resolved');
  assert.deepEqual(new Set(value.facts.map(item => item.kind)), new Set([
    'publication.intent', 'publication.observed', 'ci.merge_candidate', 'ci.selected',
    'merge.intent', 'merge.verified', 'postmerge.observed'
  ]));
  assert.equal(value.facts.find(item => item.kind === 'ci.selected').evidence.selectedAssessment, 'matching_synthetic_merge');
  assert.equal(value.facts.find(item => item.kind === 'merge.verified').evidence.ancestry, 'squash');
});

test('preserves negative candidate and postmerge observations without turning them into acceptance', async t => {
  const f = fixture(t), synthetic = 'f'.repeat(40);
  chain(f, [
    { fact: { kind: 'publication.observed', number: 9, headSha: H, branch: 'squire/project/ticket', baseSha: WRONG,
      baseBranch: 'main', repository: 'owner/repo', state: 'open', merged: false, mergeSha: null } },
    { fact: { kind: 'ci.merge_candidate', sha: synthetic, treeSha: WRONG, parents: [B, WRONG] } },
    { fact: observation(false) }
  ]);
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  const candidate = value.facts.find(item => item.kind === 'ci.merge_candidate');
  const postmerge = value.facts.find(item => item.kind === 'postmerge.observed');
  assert.equal(value.status, 'resolved');
  assert.equal(candidate.evidence.matchesSyntheticMergeIdentity, false);
  assert.equal(value.facts.find(item => item.kind === 'publication.observed').evidence.baseMatchesIdentity, false);
  assert.equal(postmerge.evidence.passed, false);
  assert.equal(postmerge.evidence.after.dirty, true);
  assert.equal(postmerge.evidence.after.headMatchesMerge, false);
  assert.equal(postmerge.evidence.after.treeMatchesIdentity, false);
  assert.deepEqual(value.acceptance, 'not_evaluated');
});

test('a non-null selected check without a matching candidate or retained synthetic merge is incomplete', async t => {
  const f = fixture(t), synthetic = 'f'.repeat(40);
  chain(f, [{ fact: { kind: 'ci.selected', required: check, selected: { id: 92, name: 'test', appId: 17,
    headSha: synthetic, status: 'pending', conclusion: null } } }]);
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'incomplete');
  assert.equal(value.reasonCode, 'chain_incomplete');
  assert.deepEqual(value.facts, []);
});

test('latest current fact supersedes earlier success or failure; changed head, generation and policy remain historical', async t => {
  for (const changed of ['headSha', 'generation', 'policy']) await t.test(changed, async t2 => {
    const f = fixture(t2);
    chain(f, [{ fact: observation(false) }, { fact: observation(true) }]);
    if (changed === 'headSha') f.state.tickets[0].headSha = WRONG;
    if (changed === 'generation') f.state.tickets[0].generation = 2;
    if (changed === 'policy') f.state.config.services.app.delivery.requiredChecks = [{ name: 'renamed-test', appId: 18 }];
    f.save();
    const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
    assert.equal(value.status, 'resolved');
    const facts = value.facts.filter(item => item.kind === 'postmerge.observed');
    if (changed === 'policy' || changed === 'headSha' || changed === 'generation') {
      assert.ok(facts.every(item => item.currentness === 'historical'));
    }
  });
  const f = fixture(t);
  chain(f, [{ fact: observation(true) }, { fact: observation(false) }]);
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  const observations = value.facts.filter(item => item.kind === 'postmerge.observed');
  assert.equal(observations[0].currentness, 'current');
  assert.equal(observations[0].evidence.passed, false);
  assert.equal(observations[1].currentness, 'superseded');
  assert.equal(observations[1].evidence.passed, true);
});

test('historical selected check with changed configured name is retained and masked', async t => {
  const f = fixture(t), oldIdentity = identityFor(f, randomUUID());
  const fact = { kind: 'ci.selected', required: check, selected: { id: 31, name: 'test', appId: 17,
    headSha: H, status: 'completed', conclusion: 'failure' } };
  const item = { fact, identity: { policyDigest: oldIdentity.policyDigest } };
  const built = chain(f, [{ fact: item.fact, identity: item.identity }]);
  f.state.config.services.app.delivery.requiredChecks = [{ name: 'new-check', appId: 19 }]; f.save();
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'resolved');
  assert.equal(value.facts[0].currentness, 'historical');
  assert.equal(value.facts[0].evidence.requiredCheck.label, 'not_reported');
  assert.equal(value.facts[0].evidence.selected.conclusion, 'failure');
  assert.ok(built.anchor);
});

test('missing anchors, projects, tickets, duplicate tickets and unsafe schema are unavailable', async t => {
  const absentAnchor = fixture(t);
  let value = await inspectDelivery({ id: 'project', stateDir: absentAnchor.root, ticketId: 'ticket' });
  assert.equal(value.status, 'unavailable'); assert.equal(value.reasonCode, 'anchor_missing');
  assert.deepEqual(value.facts, []);

  const legacyAnchor = fixture(t);
  legacyAnchor.state.tickets[0].deliveryEvidence = { oldReceipt: 'private-reference' };
  legacyAnchor.save();
  value = await inspectDelivery({ id: 'project', stateDir: legacyAnchor.root, ticketId: 'ticket' });
  assert.equal(value.reasonCode, 'anchor_legacy');
  assert.equal(JSON.stringify(value).includes('private-reference'), false);

  const missingProject = fixture(t, { withProject: false });
  missingProject.save({ schema: true });
  value = await inspectDelivery({ id: 'project', stateDir: missingProject.root, ticketId: 'ticket' });
  assert.equal(value.reasonCode, 'project_missing');

  const missingTicket = fixture(t);
  value = await inspectDelivery({ id: 'project', stateDir: missingTicket.root, ticketId: 'other' });
  assert.equal(value.reasonCode, 'ticket_missing');

  const duplicate = fixture(t, { duplicateTicket: true });
  value = await inspectDelivery({ id: 'project', stateDir: duplicate.root, ticketId: 'ticket' });
  assert.equal(value.reasonCode, 'ticket_ambiguous');

  const unsafe = fixture(t, { withProject: false });
  const db = new DatabaseSync(unsafe.dbPath); db.exec('CREATE VIEW project AS SELECT 1 AS id, 2 AS state'); db.close();
  value = await inspectDelivery({ id: 'project', stateDir: unsafe.root, ticketId: 'ticket' });
  assert.equal(value.reasonCode, 'unsafe_state');

  const duplicateRows = fixture(t, { withProject: false });
  const duplicateDb = new DatabaseSync(duplicateRows.dbPath);
  duplicateDb.exec('CREATE TABLE project (id TEXT, state TEXT)');
  const stateText = JSON.stringify(duplicateRows.state);
  duplicateDb.prepare('INSERT INTO project(id,state) VALUES(?,?)').run('project', stateText);
  duplicateDb.prepare('INSERT INTO project(id,state) VALUES(?,?)').run('project', stateText);
  duplicateDb.close();
  value = await inspectDelivery({ id: 'project', stateDir: duplicateRows.root, ticketId: 'ticket' });
  assert.equal(value.reasonCode, 'unsafe_state');
});

test('malformed identity, reference, receipt kind or required fact shape withholds every fact', async t => {
  for (const [label, identity, fact] of [
    ['project', { projectId: 'other' }, { kind: 'publication.intent' }],
    ['ticket', { ticketId: 'other' }, { kind: 'publication.intent' }],
    ['service', { service: 'other' }, { kind: 'publication.intent' }],
    ['repository', { repository: 'elsewhere/repo' }, { kind: 'publication.intent' }],
    ['scope', { scopeId: '00000000-0000-4000-8000-000000000099' }, { kind: 'publication.intent' }],
    ['unknown-kind', {}, { kind: 'private.unknown' }],
    ['malformed merge', {}, { kind: 'merge.verified', mergeSha: M, treeSha: WRONG, parents: [B] }]
  ]) await t.test(label, async t2 => {
    const f = fixture(t2);
    chain(f, [{ fact, identity }]);
    const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
    assert.equal(value.status, 'incomplete');
    assert.equal(value.chainIntegrity, 'incomplete');
    assert.deepEqual(value.facts, []);
  });
});

test('corrupt, missing and symlinked receipt files produce incomplete output without partial facts', async t => {
  const f = fixture(t), { refs } = chain(f, [{ fact: { kind: 'publication.intent' } }, { fact: { kind: 'merge.intent', number: 7, headSha: H, method: 'squash' } }]);
  const before = sourceFingerprint(f.root);
  writeFileSync(path.join(f.projectRoot, 'delivery-evidence', refs[1].scopeId, refs[1].file), Buffer.alloc(refs[1].bytes));
  const corruptedBefore = sourceFingerprint(f.root);
  let value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'incomplete'); assert.deepEqual(value.facts, []);
  assert.deepEqual(sourceFingerprint(f.root), corruptedBefore);
  assert.notDeepEqual(corruptedBefore, before); // Only the deliberate fixture corruption changed bytes.

  const g = fixture(t); const built = chain(g, [{ fact: { kind: 'publication.intent' } }]);
  const receiptPath = path.join(g.projectRoot, 'delivery-evidence', built.anchor.scopeId, built.anchor.file);
  const outside = path.join(g.root, 'outside.json'); writeFileSync(outside, readFileSync(receiptPath));
  rmSync(receiptPath); symlinkSync(outside, receiptPath);
  value = await inspectDelivery({ id: 'project', stateDir: g.root, ticketId: 'ticket' });
  assert.equal(value.status, 'incomplete'); assert.deepEqual(value.facts, []);
});

test('missing prior reference and cycles reject the whole chain', async t => {
  const f = fixture(t), missing = { scopeId: randomUUID(), file: `${randomUUID()}.json`, bytes: 1, sha256: '0'.repeat(64) };
  chain(f, [{ fact: { kind: 'publication.intent' }, previous: missing }]);
  // A prior pointer is part of the receipt protocol and is verified by the real reader.
  const bytes = Buffer.from(JSON.stringify(receipt(identityFor(f, f.state.tickets[0].deliveryEvidence.scopeId),
    { kind: 'publication.intent' }, missing)));
  const anchor = f.state.tickets[0].deliveryEvidence;
  writeFileSync(path.join(f.projectRoot, 'delivery-evidence', anchor.scopeId, anchor.file), bytes);
  f.state.tickets[0].deliveryEvidence = { ...anchor, bytes: bytes.length, sha256: sha256(bytes) }; f.save();
  let value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'incomplete'); assert.deepEqual(value.facts, []);

  const g = fixture(t), scopeId = randomUUID();
  const ref = { scopeId, file: `${randomUUID()}.json`, bytes: 1, sha256: '1'.repeat(64) };
  g.state.tickets[0].deliveryEvidence = ref; g.save();
  const repeated = receipt(identityFor(g, scopeId), { kind: 'publication.intent' }, ref);
  value = await inspectDelivery({ id: 'project', stateDir: g.root, ticketId: 'ticket' }, {
    reader: async () => repeated, clock: () => 0
  });
  assert.equal(value.status, 'incomplete'); assert.deepEqual(value.facts, []);
});

test('oversized prior references, malformed previous pointers and receipt versions fail closed', async t => {
  const f = fixture(t), anchor = { scopeId: randomUUID(), file: `${randomUUID()}.json`, bytes: 1, sha256: '3'.repeat(64) };
  f.state.tickets[0].deliveryEvidence = anchor; f.save();
  let calls = 0;
  let value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' }, {
    reader: async (_root, reference) => {
      calls++;
      return receipt(identityFor(f, reference.scopeId), { kind: 'publication.intent' },
        { scopeId: randomUUID(), file: `${randomUUID()}.json`, bytes: 131073, sha256: '4'.repeat(64) });
    }, clock: () => 0
  });
  assert.equal(value.status, 'incomplete'); assert.equal(calls, 1); assert.deepEqual(value.facts, []);

  for (const variant of ['malformed_previous', 'bad_version']) {
    const g = fixture(t), ref = { scopeId: randomUUID(), file: `${randomUUID()}.json`, bytes: 1, sha256: '5'.repeat(64) };
    g.state.tickets[0].deliveryEvidence = ref; g.save();
    value = await inspectDelivery({ id: 'project', stateDir: g.root, ticketId: 'ticket' }, {
      reader: async (_root, reference) => ({ ...receipt(identityFor(g, reference.scopeId), { kind: 'publication.intent' }, null),
        ...(variant === 'malformed_previous' ? { previous: { scopeId: 'bad' } } : { version: 2 }) }),
      clock: () => 0
    });
    assert.equal(value.status, 'incomplete', variant);
    assert.deepEqual(value.facts, [], variant);
  }
});

test('node and cooperative time caps fail closed using the test seams', async t => {
  const f = fixture(t), ids = Array.from({ length: 129 }, () => randomUUID());
  const refs = ids.map(scopeId => ({ scopeId, file: `${randomUUID()}.json`, bytes: 1, sha256: '2'.repeat(64) }));
  f.state.tickets[0].deliveryEvidence = refs[128]; f.save();
  let reads = 0;
  const reader = async (_root, reference) => {
    reads++;
    const index = refs.findIndex(item => item.scopeId === reference.scopeId);
    return receipt(identityFor(f, reference.scopeId), { kind: 'publication.intent' }, index > 0 ? refs[index - 1] : null);
  };
  let value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' }, { reader, clock: () => 0 });
  assert.equal(value.status, 'incomplete'); assert.equal(value.reasonCode, 'node_limit_exceeded');
  assert.equal(reads, 128); assert.deepEqual(value.facts, []);

  let tick = 0;
  let timeReads = 0;
  value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' }, {
    reader: async (_root, reference) => { timeReads++; return receipt(identityFor(f, reference.scopeId), { kind: 'publication.intent' }, null); },
    clock: () => [0, 0, 2001][Math.min(tick++, 2)]
  });
  assert.equal(value.status, 'incomplete'); assert.equal(value.reasonCode, 'time_limit_exceeded');
  assert.equal(timeReads, 1);
  assert.deepEqual(value.facts, []);
});

test('fixed projects and project-id symlinks are rejected before receipt traversal', async t => {
  const f = fixture(t); chain(f, [{ fact: { kind: 'publication.intent' } }]);
  const projectPath = path.join(f.root, 'projects', 'project');
  const moved = path.join(f.root, 'moved-project');
  rmSync(projectPath, { recursive: true, force: true });
  mkdirSync(moved, { recursive: true });
  symlinkSync(moved, projectPath, process.platform === 'win32' ? 'junction' : 'dir');
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'unavailable');
  assert.deepEqual(value.facts, []);
});

test('64 KiB serialized output cap withholds all facts', async t => {
  const names = Array.from({ length: 30 }, (_, index) => ({ name: `Check${index}_${'x'.repeat(70)}`, appId: index + 1 }));
  const f = fixture(t, { names });
  const results = names.map(item => ({ name: item.name, passed: true, exitCode: 0, stopped: false,
    timedOut: false, outputExceeded: false, launchError: false }));
  chain(f, Array.from({ length: 30 }, () => ({ fact: observation(true, { results }) })));
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'incomplete'); assert.equal(value.reasonCode, 'output_limit_exceeded');
  assert.deepEqual(value.facts, []);
});

test('source database and retained evidence fingerprints stay unchanged on success and refusal', async t => {
  const f = fixture(t); chain(f, [{ fact: { kind: 'publication.intent' } }]);
  let before = sourceFingerprint(f.root);
  let value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'resolved'); assert.deepEqual(sourceFingerprint(f.root), before);

  const g = fixture(t); chain(g, [{ fact: { kind: 'unsupported.kind' } }]);
  before = sourceFingerprint(g.root);
  value = await inspectDelivery({ id: 'project', stateDir: g.root, ticketId: 'ticket' });
  assert.equal(value.status, 'incomplete'); assert.deepEqual(sourceFingerprint(g.root), before);
});

test('optional source WAL is captured without changing database, WAL or evidence metadata', async t => {
  const f = fixture(t); chain(f, [{ fact: { kind: 'publication.intent' } }]);
  const db = new DatabaseSync(f.dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  db.prepare('UPDATE project SET state=state || ? WHERE id=?').run(' ', 'project');
  const before = sourceFingerprint(f.root);
  assert.ok(readdirSync(f.root).includes('squire.sqlite-wal'));
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'resolved');
  assert.deepEqual(sourceFingerprint(f.root), before);
  db.close();
});

test('selected status and conclusion values are projected to fixed known strings', async t => {
  const f = fixture(t);
  chain(f, [{ fact: { kind: 'ci.selected', required: check, selected: { id: 2, name: 'test', appId: 17,
    headSha: H, status: 'provider-private-raw-status', conclusion: 'provider-private-raw-result' } } }]);
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'resolved');
  assert.equal(value.facts[0].evidence.selected.status, 'unknown');
  assert.equal(value.facts[0].evidence.selected.conclusion, 'unknown');
  assert.equal(JSON.stringify(value).includes('provider-private'), false);
});

test('postmerge labels use local configured checks while CI labels use required delivery checks', async t => {
  const f = fixture(t, { names: [{ name: 'required-ci', appId: 17 }], localNames: [{ name: 'local-lint' }] });
  chain(f, [
    { fact: { kind: 'ci.selected', required: { name: 'required-ci', appId: 17 },
      selected: { id: 4, name: 'required-ci', appId: 17, headSha: H, status: 'queued', conclusion: null } } },
    { fact: observation(false, { results: [
      { name: 'local-lint', passed: false, exitCode: 1, stopped: false, timedOut: false, outputExceeded: false, launchError: false },
      { name: 'unconfigured-private-check', passed: false, exitCode: 1, stopped: false, timedOut: false, outputExceeded: false, launchError: false }
    ] }) }
  ]);
  const value = await inspectDelivery({ id: 'project', stateDir: f.root, ticketId: 'ticket' });
  assert.equal(value.status, 'resolved');
  assert.equal(value.facts.find(item => item.kind === 'ci.selected').evidence.requiredCheck.label, 'required-ci');
  const postmerge = value.facts.find(item => item.kind === 'postmerge.observed');
  assert.deepEqual(postmerge.evidence.checks.map(item => item.label), ['local-lint', 'not_reported']);
  assert.equal(JSON.stringify(value).includes('unconfigured-private-check'), false);
});
