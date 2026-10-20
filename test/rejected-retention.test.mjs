import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {dirname} from 'node:path';
import {createCodegenStreamCollector} from '../src/limited-stream-collector.mjs';
import {runForeground} from '../src/internal/limited-core.mjs';
import {takeRejectedCapture,publicRetention} from '../src/internal/rejected-capture.mjs';
import {createLocalRejectedRetention} from '../src/internal/local-rejected-retention.mjs';
import {runBoundedCodegenTask} from '../src/limited-runner.mjs';
import {runCodegenCampaign} from '../src/bounded-codegen-campaign.mjs';
import {buildFreeze} from '../fixtures/q218/freeze.mjs';
const enc=x=>new TextEncoder().encode(x),decode=b=>new TextDecoder().decode(b),flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const job='12345678-1234-4abc-8def-123456789abc',token=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let rootId=0;
function fakeFS(){
 let ino=1;const nodes=new Map(),calls=[];const err=code=>Object.assign(Error('SYNTHETIC_PRIVATE_CANARY'),{code});
 const addDir=p=>{if(p!=='/')addDirIf(dirname(p));nodes.set(p,{dir:true,mode:0o700,uid:42,ino:ino++});};
 const addDirIf=p=>{if(!nodes.has(p))addDir(p);};addDir('/');addDir('/private');
 const fs={async lstat(p){const n=nodes.get(p);if(!n)throw err('ENOENT');return {...n,size:n.bytes?.length??0,isDirectory:()=>n.dir===true,isFile:()=>!n.dir,isSymbolicLink:()=>n.symlink===true};},
  async mkdir(p,{mode}){calls.push(['mkdir',p]);if(nodes.has(p))throw err('EEXIST');if(!nodes.get(dirname(p))?.dir)throw err('ENOENT');nodes.set(p,{dir:true,mode,uid:42,ino:ino++});},
  async opendir(p){const names=[...nodes.keys()].filter(x=>x!==p&&dirname(x)===p).map(x=>x.slice(p.length+1));let i=0;return {async read(){return i<names.length?{name:names[i++]}:null;},async close(){}};},
  async open(p,flags,mode){calls.push(['open',p,flags]);if(flags==='wx'){if(nodes.has(p))throw err('EEXIST');nodes.set(p,{mode,uid:42,ino:ino++,bytes:new Uint8Array()});}else if(!nodes.has(p))throw err('ENOENT');const n=nodes.get(p);return {
   async writeFile(b){n.bytes=new Uint8Array(b);},async read(b,offset,length,position){const v=n.bytes.slice(position,position+length);b.set(v,offset);return {bytesRead:v.length};},async close(){}};},
  async link(a,b){calls.push(['link',a,b]);if(nodes.has(b))throw err('EEXIST');nodes.set(b,nodes.get(a));},async unlink(p){calls.push(['unlink',p]);if(!nodes.delete(p))throw err('ENOENT');}};
 return {fs,nodes,calls,addDir};
}
function store(f=fakeFS()){
 const root='/private/store-'+(++rootId);let time=0,seq=0;
 const adapter=createLocalRejectedRetention({fs:f.fs,root,uid:42,now:()=>time,randomUUID:()=>token(++seq),job_id:job});
 return {...f,root,adapter,setTime:n=>{time=n;}};
}
function collected(response){const c=createCodegenStreamCollector();c.chunk('stdout',enc(JSON.stringify({status:'SUCCESS',response})));c.eof('stdout');c.eof('stderr');assert.throws(()=>c.decode({exit_code:0,exit_signal:null}));return c;}
function capture(response='SYNTHETIC_PUBLIC_CANARY'){return takeRejectedCapture(collected(response));}
function foreground({response='SYNTHETIC_PUBLIC_CANARY',retain,mode='normal',hook,collectorHook,nowHook}={}){
 let time=0,calls=0,reads=0;const timers=[],controller=new AbortController(),child=new EventEmitter();child.pid=42;child.unref=()=>{};child.kill=()=>true;
 for(const k of ['stdout','stderr']){child[k]=new EventEmitter();child[k].destroy=()=>{};}
 const clock={now:()=>{reads++;nowHook?.(reads);return time;},schedule(ms,cb){calls++;hook?.(calls,controller);const t={at:time+ms,cb,active:true};timers.push(t);return()=>{t.active=false;};}};
 let invoked=0,writes=0;if(mode==='already_aborted')controller.abort();
 const ports={clock,environment:{},createCollector:()=>{const c=createCodegenStreamCollector();return collectorHook?collectorHook(c):c;},persist:async()=>{writes++;},retainRejected:retain,
 spawn(){invoked++;queueMicrotask(()=>{child.emit('spawn');child.stdout.emit('data',enc(JSON.stringify({status:'SUCCESS',response})));child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',0,null);});return child;}};
 const result=runForeground({job_id:job,task_scope:'/synthetic',requested_model:'gemini-3.8-flash-high',max_wall_clock_sec:120,task_class:'BOUNDED_CODEGEN_SUMMARIZER_V5'},
 {executable:'/fake',args:[]},{clock,shutdown:{term_grace_ms:10,kill_grace_ms:10,stream_drain_timeout_ms:10,persistence_timeout_ms:10},output_path:'/synthetic/source',abortSignal:controller.signal,enableDiagnosticRetention:true},ports);
 return {result,controller,invoked:()=>invoked,writes:()=>writes,async tick(n){time=n;for(const t of [...timers])if(t.active&&t.at<=n){t.active=false;t.cb();}await flush();}};
}
test('exact decoded response lengths are independent of envelope bytes and preserve zero',()=>{
 for(const [text,length]of [['',0],['x'.repeat(87),87],['```'+ 'é'.repeat(40),83],['x'.repeat(70000),70000]]){
  const c=collected(text),v=takeRejectedCapture(c);assert.equal(v.exact_response_bytes,length);assert.equal(v.response_bytes.length,Math.min(length,65536));assert.ok(!JSON.stringify(c.diagnosticReport()).includes(text||'SYNTHETIC_NONMATCH'));c.close();assert.equal(c.diagnosticCapture(),null);
 }
});
test('prefix truncation can split UTF8 bytes without changing exact full length',()=>{
 const text='x'.repeat(65535)+'é'.repeat(10),v=capture(text);assert.equal(v.exact_response_bytes,65555);assert.equal(v.response_bytes.length,65536);assert.equal(v.response_bytes[65535],0xc3);
});
test('malformed envelope and invalid Unicode remain unavailable without lossy capture',()=>{
 for(const text of ['\ud800','\0','\uFEFF']){const v=capture(text);assert.equal(v?.eligible??false,false);assert.equal(v?.exact_response_bytes??null,null);}
 const c=createCodegenStreamCollector();c.chunk('stdout',enc('{'));c.eof('stdout');c.eof('stderr');assert.throws(()=>c.decode({}));assert.equal(c.diagnosticCapture(),null);
});
test('five slots bound raw storage, claims and concurrent admissions; no unowned eviction',async()=>{
 const s=store();assert.equal((await s.adapter.prepare()).available_slots,5);
 const results=await Promise.all(Array.from({length:5},()=>s.adapter.retainRejected(capture(),new AbortController().signal)));
 assert.equal(results.filter(x=>x.retention_status==='PUBLISHED').length,5);
 const sixth=await s.adapter.retainRejected(capture(),new AbortController().signal);assert.equal(sixth.retention_error,'RETENTION_CAPACITY_EXCEEDED');
 assert.equal([...s.nodes.keys()].filter(p=>p.endsWith('/claim.json')).length,5);assert.equal([...s.nodes.keys()].filter(p=>p.endsWith('/rejected-payload.bin')).length,5);
 for(const [p,n]of s.nodes)if(!n.dir){assert.equal(n.mode,0o600);assert.ok(n.bytes.length<=65536);if(p.endsWith('.json'))assert.ok(n.bytes.length<=1024);}
 assert.equal(s.calls.filter(x=>x[0]==='unlink'&&!x[1].includes('/.stage-')).length,0);
});
test('only positively settled expired owned entries may be reclaimed',async()=>{
 const s=store();await s.adapter.prepare();await s.adapter.retainRejected(capture('x'.repeat(87)),new AbortController().signal);s.setTime(86400000);
 assert.equal((await s.adapter.prepare()).available_slots,5);assert.ok(s.calls.some(x=>x[0]==='unlink'&&x[1].endsWith('/claim.json')));
 const active=store();await active.adapter.prepare();const path=active.root+'/slot-0/claim.json';active.nodes.set(path,{uid:42,mode:0o600,bytes:enc(JSON.stringify({version:1,token:token(1),job_id:job,created_ms:0}))});active.setTime(86400001);
 assert.equal((await active.adapter.prepare()).available_slots,4);assert.ok(active.nodes.has(path));
 active.nodes.set(active.root+'/slot-0/state.json',{uid:42,mode:0o600,bytes:enc(JSON.stringify({version:1,token:token(1),settlement:'UNKNOWN'}))});
 assert.equal((await active.adapter.prepare()).available_slots,4);assert.ok(active.nodes.has(path));
});
test('detected private ancestor mode/symlink/ownership anomaly denies without chmod or raw output',async()=>{
 for(const change of [{mode:0o777},{symlink:true},{uid:999}]){const s=store();Object.assign(s.nodes.get('/private'),change);assert.equal((await s.adapter.prepare()).capability_status,'UNAVAILABLE');assert.ok(!s.calls.some(x=>x[0]==='open'));}
});
test('publication/link uncertainty is fenced and never deletes final or leaks private fields',async()=>{
 const s=store();await s.adapter.prepare();const original=s.fs.link;s.fs.link=async(a,b)=>{await original(a,b);throw Error('SYNTHETIC_PRIVATE_CANARY');};
 const result=await s.adapter.retainRejected(capture(),new AbortController().signal);assert.equal(result.retention_status,'UNKNOWN');assert.ok(!JSON.stringify(result).includes('CANARY'));assert.ok([...s.nodes.keys()].some(x=>x.endsWith('/rejected-payload.bin')));
 assert.equal((await s.adapter.prepare()).capability_status,'UNAVAILABLE');
});
test('retention survives actual core wiring, keeps closed source custody and public projection',async()=>{
 const s=store();await s.adapter.prepare();const f=foreground({retain:s.adapter.retainRejected});const r=await f.result;
 assert.equal(r.record.lifecycle_status,'LIMITED_PARSER_ERROR');assert.equal(r.diagnostic_retention.retention_status,'PUBLISHED');assert.equal(r.diagnostic_retention.exact_response_bytes,23);assert.equal(r.diagnostic_retention.retained_bytes_count,23);assert.equal(r.record.output_custody.persisted,false);assert.equal(f.writes(),0);
 const raw=JSON.stringify(r);assert.ok(!raw.includes('SYNTHETIC_PUBLIC_CANARY'));assert.ok(!raw.includes(s.root));assert.deepEqual(Object.keys(r.diagnostic_retention),Object.keys(publicRetention()));
});
test('pending retention returns UNKNOWN at original deadline and keeps its copy until late settlement',async()=>{
 let release,owned;const f=foreground({retain:(v)=>{owned=v.response_bytes;return new Promise(resolve=>{release=resolve;});}});await flush();assert.ok(owned.some(x=>x!==0));await f.tick(120000);
 const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_TIMEOUT');assert.equal(r.diagnostic_retention.retention_status,'UNKNOWN');assert.ok(owned.some(x=>x!==0));release({retention_status:'PUBLISHED',retention_error:null});await flush();assert.ok(owned.every(x=>x===0));assert.equal(r.diagnostic_retention.retention_status,'UNKNOWN');
});
test('already-aborted and retention-scheduler reentrant abort never invoke retention port',async()=>{
 for(const mode of ['already_aborted','reentrant']){let retains=0;const f=foreground({mode,hook:(n,c)=>{if(mode==='reentrant'&&n===3)c.abort();},retain:async()=>{retains++;return {retention_status:'PUBLISHED',retention_error:null};}});const r=await f.result;assert.equal(r.record.lifecycle_status,'LIMITED_USER_ABORT');assert.equal(retains,0);}
});
test('throwing capture/report and private port-result properties cannot strand completion or leak',async()=>{
 const getter=()=>{throw Error('SYNTHETIC_PRIVATE_CANARY');};
 for(const value of [new Proxy({}, {get:getter}),Object.defineProperty({},'retention_status',{get:getter}),{retention_status:'SYNTHETIC_PRIVATE_CANARY',retention_error:null}]){
  const f=foreground({retain:async()=>value}),r=await f.result;assert.equal(r.diagnostic_retention.retention_status,'FAILED');assert.ok(!JSON.stringify(r).includes('CANARY'));}
 const f=foreground({collectorHook:c=>({...c,diagnosticCapture(){throw Error('SYNTHETIC_PRIVATE_CANARY');}}),retain:async()=>{throw Error('must not run');}});assert.equal((await f.result).diagnostic_retention.retention_error,'RETENTION_INVALID_CAPTURE');
});
test('runner, collector, retention and campaign compose without generation-only success',async()=>{
 const s=store();await s.adapter.prepare();const scope='/synthetic/task';s.addDir(scope);
 const child=new EventEmitter();child.pid=42;child.unref=()=>{};for(const k of ['stdout','stderr']){child[k]=new EventEmitter();child[k].destroy=()=>{};}
 const clock={now:()=>0,schedule:()=>()=>{}};let starts=0,later=0;
 const generate=()=>runBoundedCodegenTask({job_id:token(999),task_scope:scope,requested_model:'gemini-3.8-flash-high',effort:'high',max_wall_clock_sec:120,prompt_bytes:enc('public task')},
  {clock,shutdown:{term_grace_ms:10,kill_grace_ms:10,poll_interval_ms:10,stream_drain_timeout_ms:10,persistence_timeout_ms:10},output_path:scope+'/output/run-'+token(999)+'/workspace/src/summarizer.mjs',enableDiagnosticRetention:true},
  {fs:s.fs,retainRejected:s.adapter.retainRejected,spawn(){starts++;queueMicrotask(()=>{child.emit('spawn');child.stdout.emit('data',enc(JSON.stringify({status:'SUCCESS',response:'PUBLIC_FAKE'})));child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',0,null);});return child;}});
 const r=await runCodegenCampaign({fixtures:buildFreeze().fixtures},{clock,generate,inspectSource(){later++;},syntax(){later++;},execute(){later++;}});
 assert.equal(starts,1);assert.equal(later,0);assert.equal(r.status,'FAIL');assert.equal(r.generation.diagnostic_retention.retention_status,'PUBLISHED');assert.equal(r.generation.physical_source_witness,null);assert.equal(r.fixtures.filter(x=>x.status==='NOT_RUN').length,17);
 assert.ok(!JSON.stringify(r).includes('PUBLIC_FAKE'));assert.ok(!JSON.stringify(r).includes(s.root));
});
test('raw bytes across all five slots are bounded, including max-prefix publication aliases',async()=>{
 const s=store();await s.adapter.prepare();for(let i=0;i<5;i++)assert.equal((await s.adapter.retainRejected(capture('x'.repeat(70000)),new AbortController().signal)).retention_status,'PUBLISHED');
 const raw=[...s.nodes.entries()].filter(([p,n])=>p.endsWith('.bin')||p.includes('/.stage-'));assert.equal(raw.reduce((n,[,v])=>n+v.bytes.length,0),327680);
});
test('empty capture publishes zero bytes; partial claim writes are UNKNOWN and fenced',async()=>{
 const s=store();await s.adapter.prepare();assert.equal((await s.adapter.retainRejected(capture(''),new AbortController().signal)).retention_status,'PUBLISHED');assert.equal(s.nodes.get(s.root+'/slot-0/rejected-payload.bin').bytes.length,0);
 const f=store();await f.adapter.prepare();const open=f.fs.open;f.fs.open=async(p,...rest)=>{const h=await open(p,...rest);if(p.endsWith('/claim.json'))h.writeFile=async()=>{throw Error('SYNTHETIC_PRIVATE_CANARY');};return h;};
 assert.equal((await f.adapter.retainRejected(capture(),new AbortController().signal)).retention_status,'UNKNOWN');assert.equal((await f.adapter.prepare()).capability_status,'UNAVAILABLE');
});

 test('intrinsic byte bounds ignore length and iterator canaries without unbounded copy',async()=>{
  let accessed=0;const s=store();await s.adapter.prepare();
  const bytes=enc('PUBLIC_FAKE');Object.defineProperty(bytes,'length',{get(){accessed++;return 999999;}});bytes[Symbol.iterator]=()=>{accessed++;throw Error('SYNTHETIC_PRIVATE_CANARY');};
  const v=Object.freeze({eligible:true,reason:'CODEGEN_PAYLOAD_TOO_SMALL',exact_response_bytes:11,response_bytes:bytes});assert.equal((await s.adapter.retainRejected(v,new AbortController().signal)).retention_status,'PUBLISHED');assert.equal(accessed,0);
  const huge=new Uint8Array(70000);Object.defineProperty(huge,'length',{value:1});const r=await s.adapter.retainRejected({response_bytes:huge,exact_response_bytes:1},new AbortController().signal);assert.equal(r.retention_status,'FAILED');
 });
 test('failed pre-port clock recheck prevents retention and completes with UNKNOWN',async()=>{
  let calls=0;const f=foreground({nowHook:n=>{if(n===7)throw Error('SYNTHETIC_CLOCK_FAILURE');},retain:async()=>{calls++;return {retention_status:'PUBLISHED',retention_error:null};}});
  const r=await f.result;assert.equal(calls,0);assert.equal(r.diagnostic_retention.retention_status,'UNKNOWN');
 });
 test('unowned colliding stage is never deleted on exclusive-open failure',async()=>{
  const s=store();await s.adapter.prepare();const original=s.fs.open;let collision;
  s.fs.open=async(p,flags,...rest)=>{if(p.includes('/.stage-')){collision=p;s.nodes.set(p,{mode:0o600,uid:42,bytes:enc('UNOWNED_SYNTHETIC')});throw Object.assign(Error('collision'),{code:'EEXIST'});}return original(p,flags,...rest);};
  assert.equal((await s.adapter.retainRejected(capture(),new AbortController().signal)).retention_status,'UNKNOWN');assert.ok(s.nodes.has(collision));assert.ok(!s.calls.some(x=>x[0]==='unlink'&&x[1]===collision));
 });

 test('failed post-I/O deadline observation cannot report PUBLISHED',async()=>{
  let calls=0;const f=foreground({nowHook:n=>{if(n===8)throw Error('SYNTHETIC_CLOCK_FAILURE');},retain:async()=>{calls++;return {retention_status:'PUBLISHED',retention_error:null};}});
  const r=await f.result;assert.equal(calls,1);assert.equal(r.diagnostic_retention.retention_status,'UNKNOWN');
 });

 test('UNKNOWN after settled write plus failed marker cannot become reclaimable in a later adapter',async()=>{
  const s=store();await s.adapter.prepare();const original=s.fs.open,controller=new AbortController();
  s.fs.open=async(p,...rest)=>{if(p.endsWith('/uncertain.json'))throw Error('SYNTHETIC_MARKER_FAILURE');const h=await original(p,...rest);if(p.endsWith('/state.json')){const close=h.close;h.close=async()=>{await close();controller.abort();};}return h;};
  assert.equal((await s.adapter.retainRejected(capture(),controller.signal)).retention_status,'UNKNOWN');
  const later=createLocalRejectedRetention({fs:s.fs,root:s.root,uid:42,now:()=>86400001,randomUUID:()=>token(99),job_id:job});
  const before=s.calls.length;const state=await later.prepare();assert.notEqual(state.available_slots,5);assert.ok(!s.calls.slice(before).some(x=>x[0]==='unlink'&&x[1].endsWith('/claim.json')));
 });
 test('persisted SETTLED alone and post-return aborted ownership never authorize TTL reuse',async()=>{
  const s=store();await s.adapter.prepare();const controller=new AbortController();await s.adapter.retainRejected(capture(),controller.signal);
  const later=createLocalRejectedRetention({fs:s.fs,root:s.root,uid:42,now:()=>86400001,randomUUID:()=>token(99),job_id:job});assert.equal((await later.prepare()).available_slots,4);
  controller.abort();s.setTime(86400001);assert.equal((await s.adapter.prepare()).capability_status,'UNAVAILABLE');
 });

 test('expired cleanup rechecks original positive signal before destructive unlink',async()=>{
  for(const point of ['payload_read','cleanup_close']){
   const s=store();await s.adapter.prepare();const controller=new AbortController();await s.adapter.retainRejected(capture(),controller.signal);s.setTime(86400001);
   const original=s.fs.open;s.fs.open=async(p,flags,...rest)=>{const h=await original(p,flags,...rest);
    if(point==='payload_read'&&p.endsWith('/rejected-payload.bin')&&flags==='r'){const read=h.read;h.read=async(...args)=>{const r=await read(...args);controller.abort();return r;};}
    if(point==='cleanup_close'&&p.endsWith('/cleanup.json')){const close=h.close;h.close=async()=>{await close();controller.abort();};}return h;};
   const before=s.calls.length;assert.equal((await s.adapter.prepare()).capability_status,'UNAVAILABLE');assert.ok(!s.calls.slice(before).some(x=>x[0]==='unlink'&&(x[1].endsWith('/rejected-payload.bin')||x[1].endsWith('/claim.json'))));
  }
 });

 test('prepare cannot advertise READY if ownership fences during final slot inspection',async()=>{
  const s=store();await s.adapter.prepare();const controller=new AbortController();await s.adapter.retainRejected(capture(),controller.signal);
  const opendir=s.fs.opendir;s.fs.opendir=async p=>{const d=await opendir(p);if(p.endsWith('/slot-4')){const close=d.close;d.close=async()=>{await close();controller.abort();};}return d;};
  assert.equal((await s.adapter.prepare()).capability_status,'UNAVAILABLE');
 });
function bootstrapFixture(){
 const f=fakeFS(),root='/private/application-'+(++rootId)+'/diagnostics',parent=dirname(root),controller=new AbortController();
 const adapter=createLocalRejectedRetention({fs:f.fs,root,uid:42,now:()=>0,randomUUID:()=>token(1),job_id:job});
 return {...f,root,parent,controller,adapter};
}
test('bootstrap creates only the one absent app parent then strict root and five slots',async()=>{
 const f=bootstrapFixture();assert.equal((await f.adapter.prepare()).capability_status,'READY');
 assert.equal(f.nodes.get(f.parent).mode,0o700);assert.equal(f.nodes.get(f.parent).uid,42);
 assert.deepEqual(f.calls.filter(x=>x[0]==='mkdir').map(x=>x[1]),[f.parent,f.root,...Array.from({length:5},(_,i)=>f.root+'/slot-'+i)]);
});
test('missing or unsafe higher ancestor prevents all mkdir and cannot trigger recursive repair',async()=>{
 for(const change of ['missing','symlink','unsafe','foreign']){
  const f=bootstrapFixture();if(change==='missing')f.nodes.delete('/private');else Object.assign(f.nodes.get('/private'),change==='symlink'?{symlink:true}:change==='unsafe'?{mode:0o777}:{uid:999});
  assert.equal((await f.adapter.prepare()).capability_status,'UNAVAILABLE');assert.equal(f.calls.filter(x=>x[0]==='mkdir').length,0);
 }
});
test('existing valid app parent ownership and mode are preserved without stricter 0700 requirement',async()=>{
 for(const uid of [0,42])for(const mode of [0o700,0o755]){
  const f=bootstrapFixture();f.addDir(f.parent);Object.assign(f.nodes.get(f.parent),{uid,mode});const original={...f.nodes.get(f.parent)};
  assert.equal((await f.adapter.prepare()).capability_status,'READY');assert.deepEqual(f.nodes.get(f.parent),original);assert.equal(f.calls.filter(x=>x[0]==='mkdir'&&x[1]===f.parent).length,1);
 }
});
test('unsafe existing app parent fails as-is without chmod/chown/unlink or child creation',async()=>{
 for(const change of [{mode:0o777},{mode:0o775},{uid:999},{symlink:true},{dir:false}]){
  const f=bootstrapFixture();f.addDir(f.parent);Object.assign(f.nodes.get(f.parent),change);const original={...f.nodes.get(f.parent)};
  assert.equal((await f.adapter.prepare()).capability_status,'UNAVAILABLE');assert.deepEqual(f.nodes.get(f.parent),original);assert.equal(f.calls.filter(x=>x[0]==='mkdir').length,1);assert.ok(!f.calls.some(x=>x[0]==='unlink'));
 }
});
test('concurrent parent EEXIST permits one validation only; valid and unsafe racers remain distinct',async()=>{
 for(const safe of [true,false]){
  const f=bootstrapFixture(),mkdir=f.fs.mkdir;let parentCalls=0;
  f.fs.mkdir=async(p,opts)=>{if(p===f.parent){parentCalls++;f.addDir(p);if(!safe)f.nodes.get(p).mode=0o777;throw Object.assign(Error('synthetic race'),{code:'EEXIST'});}return mkdir(p,opts);};
  assert.equal((await f.adapter.prepare()).capability_status,safe?'READY':'UNAVAILABLE');assert.equal(parentCalls,1);
 }
});
test('parent EACCES/EPERM fences initialization with no second mkdir or fallback',async()=>{
 for(const code of ['EACCES','EPERM']){
  const f=bootstrapFixture();let attempts=0;f.fs.mkdir=async()=>{attempts++;throw Object.assign(Error('synthetic denial'),{code});};
  assert.equal((await f.adapter.prepare()).capability_status,'UNAVAILABLE');assert.equal(attempts,1);assert.equal((await f.adapter.prepare()).capability_status,'UNAVAILABLE');assert.equal(attempts,1);
 }
});
test('filesystem-root parent is never a bootstrap target',async()=>{
 const f=fakeFS(),adapter=createLocalRejectedRetention({fs:f.fs,root:'/diagnostics',uid:42,now:()=>0,randomUUID:()=>token(1),job_id:job});
 assert.equal((await adapter.prepare()).capability_status,'UNAVAILABLE');assert.equal(f.calls.length,0);
});
test('abort before or during parent bootstrap prevents every later creation',async()=>{
 for(const point of ['already','ancestor','parent']){
  const f=bootstrapFixture();if(point==='already')f.controller.abort();
  if(point==='ancestor'){const lstat=f.fs.lstat;f.fs.lstat=async p=>{const s=await lstat(p);if(p==='/private')f.controller.abort();return s;};}
  if(point==='parent'){const mkdir=f.fs.mkdir;f.fs.mkdir=async(p,opts)=>{await mkdir(p,opts);if(p===f.parent)f.controller.abort();};}
  assert.equal((await f.adapter.prepare(f.controller.signal)).capability_status,'UNAVAILABLE');assert.equal(f.calls.filter(x=>x[0]==='mkdir').length,point==='parent'?1:0);
 }
});
