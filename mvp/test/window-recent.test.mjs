import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRecentOutcomes, writeCandidateOutcome } from '../window-recent.mjs';
import { WindowPresence } from '../window-state.mjs';
import { createWindowWebServer } from '../window-web.mjs';

const first='squire-1790368585736-119d4f40d2';
const second='squire-1790368206187-0234ba2f1c';
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'squire-recent-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
function candidate(root,runId,completedAtMs=Date.now()){return {root,runId,ticketId:'AIDEV-339',ticketName:'Focused dashboard',completedAtMs}}
async function writeLegacyReceipt(root,fileRunId,receiptRunId,completedAtMs){
  const value={version:1,runId:receiptRunId,ticketId:'AIDEV-339',ticketName:'Legacy candidate',completedAtMs,status:'UNVERIFIED'};
  const key=await readFile(path.join(root,'.recent-outcomes-key-v1'));
  value.mac=createHmac('sha256',key).update(JSON.stringify(value)).digest('hex');
  await writeFile(path.join(root,'recent-outcomes-v1',`${fileRunId}.json`),`${JSON.stringify(value)}\n`);
}

test('zero active and two terminal candidate receipts remain neutral across restart',async t=>{
  const root=await fixture(t);
  const now=Date.now();
  assert.deepEqual(await readRecentOutcomes(root,now),[]);
  const presence=new WindowPresence({root,runId:first,ticketId:'AIDEV-339',ticketName:'Focused dashboard',phase:'artifact'});
  await presence.queue();
  await presence.recordCandidate(now-1000);
  await presence.stop();
  await writeCandidateOutcome(candidate(root,second,now));
  const outcomes=await readRecentOutcomes(root,now);
  assert.deepEqual(outcomes.map(r=>r.runId),[second,first]);
  assert.ok(outcomes.every(r=>r.status==='Code candidate created'
    && r.nextGate==='Independent review, applicable tests, and exact-head hosted CI'));
  assert.equal(JSON.stringify(outcomes).includes('UNVERIFIED'),false);
  assert.equal(JSON.stringify(outcomes).includes(root),false);
  assert.deepEqual((await readRecentOutcomes(root,now)).map(r=>r.runId),[second,first]);
  const {server,url}=await createWindowWebServer({root,token:'b'.repeat(48),getRows:async()=>[]});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  assert.deepEqual((await (await fetch(`${url()}api/recent`)).json()).map(r=>r.runId),[second,first]);
  assert.deepEqual(await readRecentOutcomes(root,now+24*60*60_000+1),[]);
});

test('authentic v1 UNVERIFIED candidate receipts normalize neutrally and remain short-lived',async t=>{
  const root=await fixture(t),now=Date.now();
  await writeCandidateOutcome(candidate(root,first,now));
  const target=path.join(root,'recent-outcomes-v1',`${first}.json`);
  await writeLegacyReceipt(root,first,first,now);
  assert.deepEqual((await readRecentOutcomes(root,now)).map(({runId,status})=>({runId,status})),[
    {runId:first,status:'Code candidate created'},
  ]);

  const authentic=JSON.parse(await readFile(target,'utf8'));
  await writeFile(target,JSON.stringify({...authentic,ticketName:'Tampered candidate'}));
  assert.deepEqual(await readRecentOutcomes(root,now),[]);

  await writeLegacyReceipt(root,first,second,now);
  assert.deepEqual(await readRecentOutcomes(root,now),[],'a correctly signed receipt for another run is rejected');

  await writeLegacyReceipt(root,first,first,now-24*60*60_000-1);
  assert.deepEqual(await readRecentOutcomes(root,now),[],'authentic expired legacy evidence is rejected');

  await rm(target);
  assert.deepEqual(await readRecentOutcomes(root,now),[],'missing receipts do not backfill outcomes');
});

test('malformed, cross-run, expired, oversized, linked and secret-bearing records fail closed',async t=>{
  const root=await fixture(t),dir=path.join(root,'recent-outcomes-v1'),now=Date.now();
  await writeCandidateOutcome(candidate(root,first,now));
  const target=path.join(dir,`${first}.json`);
  assert.equal((await readRecentOutcomes(root,now)).length,1);
  const valid={version:1,runId:first,ticketId:'AIDEV-339',ticketName:'Dashboard',completedAtMs:now,status:'UNVERIFIED'};
  for(const value of [
    {...valid,runId:second}, {...valid,status:'VERIFIED'}, {...valid,ticketName:'private\ntoken'},
    {...valid,privatePath:'C:/private'}, {...valid,completedAtMs:now+5000},
    {...valid,completedAtMs:now-24*60*60_000-1},
  ]){
    await writeFile(target,JSON.stringify(value));
    assert.deepEqual(await readRecentOutcomes(root,now),[]);
  }
  await writeFile(target,'x'.repeat(1030));
  assert.deepEqual(await readRecentOutcomes(root,now),[]);
  await rm(target);
  await writeFile(path.join(root,'secret.json'),JSON.stringify(valid));
  await symlink(path.join(root,'secret.json'),target);
  assert.deepEqual(await readRecentOutcomes(root,now),[]);
});

test('candidate writer stores only bounded signed fields and rejects invalid identity',async t=>{
  const root=await fixture(t);
  await assert.rejects(writeCandidateOutcome({...candidate(root,first),ticketName:'\nsecret'}));
  await writeCandidateOutcome(candidate(root,first));
  const raw=JSON.parse(await readFile(path.join(root,'recent-outcomes-v1',`${first}.json`),'utf8'));
  assert.deepEqual(Object.keys(raw).sort(),['completedAtMs','mac','runId','status','ticketId','ticketName','version']);
  assert.equal(raw.version,2);
  assert.equal(raw.status,'CANDIDATE_CREATED');
  assert.match(raw.mac,/^[a-f0-9]{64}$/);
  await writeFile(path.join(root,'recent-outcomes-v1',`${second}.json`),JSON.stringify({...raw,runId:second}));
  assert.deepEqual((await readRecentOutcomes(root)).map(x=>x.runId),[first],
    'a syntactically plausible forged/cross-run record cannot authenticate');
});

test('a surplus of old receipts is pruned and never permanently hides new outcomes',async t=>{
  const root=await fixture(t),now=Date.now();
  for(let n=0;n<130;n++) {
    const id=`squire-${1790368585736+n}-${(0x8000000000+n).toString(16)}`;
    await writeCandidateOutcome(candidate(root,id,now-1000+n));
  }
  const rows=await readRecentOutcomes(root,now+1000);
  assert.equal(rows.length,8);
  assert.ok(rows.some(row=>row.runId==='squire-1790368585865-8000000081'));
  const names=await (await import('node:fs/promises')).readdir(path.join(root,'recent-outcomes-v1'));
  assert.ok(names.length<=64);
});
