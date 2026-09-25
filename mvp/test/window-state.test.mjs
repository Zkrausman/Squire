import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WindowPresence, readWindowRecords, selectActive, validateWindowConfig, windowsProcessStarts } from '../window-state.mjs';
import { createWindowWebServer } from '../window-web.mjs';

const execFileAsync = promisify(execFile);
const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../window-state.mjs');
const one = 'squire-1790368585736-119d4f40d2';
const two = 'squire-1790368206187-0234ba2f1c';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'squire-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function record(runId, overrides = {}) {
  return { version: 1, runId, ticketId: 'AIDEV-335', ticketName: 'Active ticket window',
    pid: 24680, processStartMs: 1_000_000, phase: 'implement', updatedAtMs: 2_000_000, ...overrides };
}

async function put(root, value) {
  await writeFile(path.join(root, `${value.runId}.json`), JSON.stringify(value));
}

test('trusted ticket identity is required and cannot contain control characters', () => {
  assert.deepEqual(validateWindowConfig({ ticketId: 'ZAR-218', ticketName: '  Order history  ' }),
    { ticketId: 'ZAR-218', ticketName: 'Order history' });
  for (const value of [null, {}, {ticketId:'ZAR-218'}, {ticketId:'zar-218',ticketName:'name'},
    {ticketId:'ZAR-218',ticketName:'\nsecret'}, {ticketId:'ZAR-218',ticketName:'n',extra:true}]) {
    assert.throws(() => validateWindowConfig(value));
  }
});

test('zero, one, and two distinct active runs and same-ticket concurrent runs', async t => {
  const root = await fixture(t);
  assert.deepEqual(await readWindowRecords(root), []);
  await put(root, record(one));
  await put(root, record(two, { pid: 24681, processStartMs: 1_001_000, ticketId: 'ZAR-218', ticketName: 'History' }));
  const starts = new Map([[24680,1_000_000],[24681,1_001_000]]);
  const rows = selectActive(await readWindowRecords(root), starts, 2_001_000);
  assert.deepEqual(rows.map(item => item.ticketId), ['AIDEV-335', 'ZAR-218']);
  assert.equal(rows[0].phase, 'implement');
  await put(root, record(two, { pid: 24681, processStartMs: 1_001_000 }));
  assert.equal(selectActive(await readWindowRecords(root), starts, 2_001_000).length, 2,
    'two distinct runs of the same ticket remain visible');
});

test('stale, future, dead, and reused PID records disappear without deleting evidence', async t => {
  const root = await fixture(t);
  await put(root, record(one));
  const records = await readWindowRecords(root);
  assert.deepEqual(selectActive(records, new Map(), 2_001_000), []);
  assert.deepEqual(selectActive(records, new Map([[24680, 1_010_000]]), 2_001_000), []);
  assert.deepEqual(selectActive(records, new Map([[24680, 1_000_000]]), 2_020_000), []);
  assert.deepEqual(selectActive(records, new Map([[24680, 1_000_000]]), 1_990_000), []);
  assert.equal((await readdir(root)).length, 1);
});

test('malformed, oversized, terminal and linked records are never rendered', async t => {
  const root = await fixture(t);
  await put(root, record(one, { phase: 'candidate' }));
  await writeFile(path.join(root, `${two}.json`), 'x'.repeat(13_000));
  await writeFile(path.join(root, 'squire-1790368585736-0000000000.json'), '{broken');
  await writeFile(path.join(root, 'unrelated.json'), JSON.stringify(record(two)));
  assert.deepEqual(await readWindowRecords(root), []);
  await rm(path.join(root, `${one}.json`));
  await symlink(path.join(root, `${two}.json`), path.join(root, `${one}.json`));
  assert.deepEqual(await readWindowRecords(root), []);
});

test('presence writes one bounded atomic per-run record and removes it on stop', async t => {
  const root = await fixture(t);
  const presence = new WindowPresence({root, runId:one, ticketId:'AIDEV-335',ticketName:'Window',phase:'plan'});
  await presence.queue();
  await Promise.all([presence.queue('implement'), presence.queue('artifact'), presence.queue('implement')]);
  const entries = await readdir(root);
  assert.deepEqual(entries, [`${one}.json`]);
  const info = await lstat(path.join(root, entries[0]));
  assert.ok(info.size < 4096);
  assert.equal(JSON.parse(await readFile(path.join(root, entries[0]), 'utf8')).phase, 'implement');
  await presence.stop();
  assert.deepEqual(await readdir(root), []);
});

test('only a bounded Luna report is projected into the window, and phase changes clear it', async t => {
  const root = await fixture(t);
  const presence = new WindowPresence({root, runId:one, ticketId:'AIDEV-335',ticketName:'Window',phase:'plan'});
  // Projection is independent of a slow OS process query; the snapshot identity path has its own test.
  const report = {phase:'plan',status:'complete',number:1,finishedAtMs:Date.now(),report:{
    currentAction:'Reading tests',evidence:['One read completed'],risks:[],stalls:[],confidence:'medium',
    secret:'SHOULD_NOT_APPEAR',completionPercent:'unknown',eta:'unknown'}};
  await presence.setReport(report);
  let rows = await readWindowRecords(root);
  assert.equal(rows[0].report.currentAction, 'Reading tests');
  assert.equal(JSON.stringify(rows).includes('SHOULD_NOT_APPEAR'), false);
  assert.equal(JSON.stringify(rows).includes('completionPercent'), false);
  assert.equal(selectActive(rows, new Map([[process.pid,presence.record.processStartMs]])).at(0).report.confidence, 'medium');
  await presence.queue('implement');
  await presence.setReport(report);
  rows = await readWindowRecords(root);
  assert.equal(rows[0].report, null, 'an old Plan report must not look current in Implement');
  await presence.setReport({...report,phase:'implement',report:{...report.report,currentAction:'\nprivate command'}});
  assert.equal((await readWindowRecords(root))[0].report, null, 'invalid model text is not rendered');
  await presence.setReport({...report,phase:'implement',number:2,report:{...report.report,currentAction:'Testing fixture'}});
  const projected = selectActive(await readWindowRecords(root), new Map([[process.pid,presence.record.processStartMs]]));
  assert.equal(projected[0].report.currentAction, 'Testing fixture');
  assert.equal(projected[0].report.number, 2);
  await presence.stop();
});

test('a local web view serves only token-scoped read-only assets and status', async t => {
  const root = await fixture(t);
  const token = 'a'.repeat(48);
  const rows = [{runId:one,ticketId:'AIDEV-335',ticketName:'Window',phase:'plan',report:null}];
  const {server,url} = await createWindowWebServer({root,token,getRows:async()=>rows});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const page = await fetch(url());
  assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await page.text(), /Squire · Active tickets/);
  const script = await (await fetch(`${url()}app.js`)).text();
  assert.match(script,/textContent/);
  assert.doesNotMatch(script,/innerHTML/);
  const response = await fetch(`${url()}api/runs`);
  assert.deepEqual(await response.json(),rows);
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.equal((await fetch(`${url()}api/runs`,{method:'POST'})).status,404);
  assert.equal((await fetch(`${url().replace(token,'b'.repeat(48))}api/runs`)).status,404);
  assert.equal((await fetch(`${url()}unrelated`)).status,404);
  const wrongHost = await new Promise((resolve,reject) => http.get(`${url()}api/runs`,
    {headers:{Host:'other.local'}},response => { response.resume(); resolve(response.statusCode); }).on('error',reject));
  assert.equal(wrongHost,404);
});

test('newer crashed records do not hide an older live run', async t => {
  const root = await fixture(t);
  const now = Date.now();
  await put(root,record(one,{updatedAtMs:now,pid:24680,processStartMs:1_000_000}));
  for(let n=0;n<129;n++) {
    await put(root,record(`squire-1790368585736-${(0x8000000000+n).toString(16)}`,
      {updatedAtMs:now-30_000,pid:24681,processStartMs:1_001_000}));
  }
  const selected = selectActive(await readWindowRecords(root),new Map([[24680,1_000_000]]),now);
  assert.deepEqual(selected.map(item=>item.runId),[one]);
});

test('Windows snapshot confirms current process start before showing the row', {skip:process.platform !== 'win32'}, async t => {
  const root = await fixture(t);
  const presence = new WindowPresence({root, runId:one, ticketId:'AIDEV-335',ticketName:'Window',phase:'plan'});
  presence.record.processStartMs = (await windowsProcessStarts([process.pid])).get(process.pid);
  await presence.queue();
  const {stdout} = await execFileAsync(process.execPath, [modulePath, '--snapshot', root], {timeout:10_000});
  assert.deepEqual(JSON.parse(stdout).map(item => item.ticketId), ['AIDEV-335']);
  await presence.stop();
});
