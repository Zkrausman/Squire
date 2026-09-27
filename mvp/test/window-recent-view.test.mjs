import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRecentOutcomes } from '../window-view.mjs';
import { createWindowWebServer } from '../window-web.mjs';
const now=2_000_000_000_000;
const first='squire-1790368585736-119d4f40d2';
const second='squire-1790368206187-0234ba2f1c';
const nextGate='Independent review and external tests/CI required';
const row=(runId,extra={})=>({runId,ticketId:'AIDEV-339',ticketName:'Dashboard',completedAtMs:now-10_000,status:'UNVERIFIED',nextGate,...extra});

test('recent projection is terminal-only, bounded, distinct from active and never promotes a candidate',()=>{
  assert.deepEqual(projectRecentOutcomes([],[],now),[]);
  assert.deepEqual(projectRecentOutcomes([row(first),row(second,{ticketId:'ZAR-219'})],[],now).map(x=>x.runId),[second,first]);
  assert.deepEqual(projectRecentOutcomes([row(first),row(second)], [first],now).map(x=>x.runId),[second]);
  for(const broken of [row(first,{status:'VERIFIED'}),row(first,{nextGate:'Install automatically'}),
    row(first,{ticketName:'private\nsecret'}),row(first,{completedAtMs:now-86_400_001}),
    row(first,{completedAtMs:now+3000}),row(first,{privatePath:'C:/private'})]) {
    assert.deepEqual(projectRecentOutcomes([broken],[],now),[]);
  }
  assert.throws(()=>projectRecentOutcomes(Array(9).fill(row(first)),[],now),/Invalid recent/);
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
