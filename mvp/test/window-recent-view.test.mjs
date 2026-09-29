import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectDashboard, projectRecentOutcomes } from '../window-view.mjs';
import { createWindowWebServer } from '../window-web.mjs';
const now=2_000_000_000_000;
const first='squire-1790368585736-119d4f40d2';
const second='squire-1790368206187-0234ba2f1c';
const nextGate='Independent review, applicable tests, and exact-head hosted CI';
const row=(runId,extra={})=>({runId,ticketId:'AIDEV-339',ticketName:'Dashboard',completedAtMs:now-10_000,status:'Code candidate created',nextGate,...extra});
const active=(runId,phase='implement')=>({runId,ticketId:'AIDEV-339',ticketName:'Dashboard',phase,
  processStartMs:now-60_000,updatedAtMs:now-10_000,report:null});

test('recent projection is terminal-only, bounded, distinct from active and never promotes a candidate',()=>{
  assert.deepEqual(projectRecentOutcomes([],[],now),[]);
  assert.deepEqual(projectRecentOutcomes([row(first),row(second,{ticketId:'ZAR-219'})],[],now).map(x=>x.runId),[second,first]);
  assert.deepEqual(projectRecentOutcomes([row(first),row(second)], [first],now).map(x=>x.runId),[second]);
  assert.deepEqual(projectRecentOutcomes([row(first,{status:'UNVERIFIED'}),row(second,{status:'DELIVERED'})],[],now),[]);
  for (const [count,expected] of [[0,2],[1,1],[2,0]]) {
    const activeRows=[active(first),active(second,'artifact')].slice(0,count);
    const projected=projectDashboard(activeRows,now).rows;
    assert.equal(projected.length,count);
    assert.equal(projectRecentOutcomes([row(first),row(second)],projected.map(item=>item.runId),now).length,expected);
  }
  for(const broken of [row(first,{status:'VERIFIED'}),row(first,{status:'DELIVERED'}),row(first,{status:'UNVERIFIED'}),row(first,{nextGate:'Install automatically'}),
    row(first,{ticketName:'private\nsecret'}),row(first,{completedAtMs:now-86_400_001}),
    row(first,{completedAtMs:now+3000}),row(first,{privatePath:'C:/private'})]) {
    assert.deepEqual(projectRecentOutcomes([broken],[],now),[]);
  }
  assert.throws(()=>projectRecentOutcomes(Array(9).fill(row(first)),[],now),/Invalid recent/);
});

test('dashboard copy distinguishes candidate creation from delivery and names pending gates',async()=>{
  const [script,html]=await Promise.all([
    readFile(new URL('../window-web.js',import.meta.url),'utf8'),
    readFile(new URL('../window-web.html',import.meta.url),'utf8'),
  ]);
  assert.match(script,/candidate artifact creation only—not delivery, verification, or ticket completion/);
  assert.match(html,/Code candidate created/);
  assert.doesNotMatch(html,/UNVERIFIED/);
  for(const gate of ['Independent review','Applicable tests','Exact-head hosted CI']) assert.ok(html.includes(gate));
  assert.match(html,/Pending external gate/);
  assert.match(html,/Delivered work/);
});

test('recent route remains exact token-scoped GET/HEAD loopback with no-store and no mutation',async t=>{
  const token='a'.repeat(48);
  const recent=[row(first,{completedAtMs:Date.now()})];
  const {server,url}=await createWindowWebServer({root:'C:/fake',token,getRows:async()=>[],getRecent:async()=>recent});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`${url()}api/recent`);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'),null);
  assert.deepEqual(await response.json(),recent);
  assert.equal((await fetch(`${url()}api/recent`,{method:'HEAD'})).status,200);
  assert.equal((await fetch(`${url()}api/recent`,{method:'POST'})).status,404);
  assert.equal((await fetch(`${url()}api/recent?runId=${first}`)).status,404);
  assert.equal((await fetch(url().replace(token,'b'.repeat(48))+'api/recent')).status,404);
});
