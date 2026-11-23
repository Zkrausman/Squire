import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runOfflineReportCli,runOfflineReportExecutable,serializeOfflineReportCapabilities} from '../bin/squire-report.mjs';

const cli=fileURLToPath(new URL('../bin/squire-report.mjs',import.meta.url));
const preload=source=>'data:text/javascript,'+encodeURIComponent(source);
const waitForInput="await new Promise(resolve=>{process.stdin.on('end',resolve);process.stdin.resume();});";
// Every child is the trusted offline reporter, never candidate or provider code.
async function child(args,{before='',closed=null}={}){
 const cp=spawn(process.execPath,['--import',preload(waitForInput+before),cli,...args],{stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='',timedOut=false,overflow=false;
 const capture=key=>data=>{if(key==='stdout')stdout+=data;else stderr+=data;
  if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>65536){overflow=true;cp.kill('SIGKILL');}};
 cp.stdout.on('data',capture('stdout'));cp.stderr.on('data',capture('stderr'));
 const done=new Promise((resolve,reject)=>{
  cp.once('error',()=>reject(Error('OFFLINE_FIXTURE_LAUNCH_FAILED')));
  cp.once('close',(code,signal)=>resolve({code,signal,stdout,stderr,timedOut,overflow}));
 });
 const timer=setTimeout(()=>{timedOut=true;cp.kill('SIGKILL');},10000);
 try{
  if(closed){const stream=cp[closed];await new Promise(resolve=>{stream.once('close',resolve);stream.destroy();});}
  // Parent read endpoint is closed before releasing the reporter's preload.
  cp.stdin.end();
  const result=await done;assert.equal(result.timedOut,false);assert.equal(result.overflow,false);return result;
 }finally{clearTimeout(timer);}
}
for(const [channel,args] of [['stdout',['--capabilities','--json']],['stderr',[]]]){
 test(`executable real closed ${channel} returns2 without an uncaught stream error`,async()=>{
  const r=await child(args,{closed:channel});assert.equal(r.signal,null);assert.equal(r.code,2);
  assert.equal(r.stderr,'');assert.equal(r.stdout,'');
 });
}
for(const channel of ['stdout','stderr'])for(const timing of ['early','late']){
 test(`executable ${channel} ${timing} error stays latched without error diagnostics`,async()=>{
  const original=channel==='stdout'?'--capabilities':'usage';
  const source=`const stream=process.${channel};const write=stream.write.bind(stream);
   stream.write=(...args)=>{const result=write(...args);
    ${timing==='early'?"stream.emit('error',Error('PRIVATE_STREAM_SENTINEL'));":"setImmediate(()=>stream.emit('error',Error('PRIVATE_STREAM_SENTINEL')));"}
    return result;};`;
  const r=await child(original==='usage'?[]:['--capabilities','--json'],{before:source});
  assert.equal(r.signal,null);assert.equal(r.code,2);
  if(channel==='stdout'){assert.equal(r.stdout,serializeOfflineReportCapabilities());assert.equal(r.stderr,'');}
  else{assert.equal(r.stdout,'');assert.equal(r.stderr,'Usage: node bin/squire-report.mjs <receipt-path>\n');}
  assert.doesNotMatch(r.stdout+r.stderr,/PRIVATE_STREAM_SENTINEL|Unhandled|Error:/);
 });
}
test('executable successful capabilities and usage retain exact bytes and exits',async()=>{
 const capabilities=await child(['--capabilities','--json']);assert.equal(capabilities.code,0);assert.equal(capabilities.signal,null);
 assert.equal(capabilities.stdout,serializeOfflineReportCapabilities());assert.equal(capabilities.stderr,'');
 const usage=await child([]);assert.equal(usage.code,2);assert.equal(usage.signal,null);assert.equal(usage.stdout,'');
 assert.equal(usage.stderr,'Usage: node bin/squire-report.mjs <receipt-path>\n');
});
test('executable rejects the public schema-only project example with fixed output',async()=>{
 const receipt=fileURLToPath(new URL('../examples/offline-report/project-schema-only.json',import.meta.url));
 const {code,signal,stdout,stderr}=await child([receipt]);
 assert.deepEqual({code,signal,stdout,stderr},{
  code:2,signal:null,
  stdout:'Squire offline project result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n',
  stderr:'SCHEMA_MISMATCH\n'
 });
});
const discoveryUsage='Usage: node bin/squire-report.mjs <receipt-path>\n'+
 '       node bin/squire-report.mjs --capabilities --json\n';

const capabilityArgs=['--capabilities','--json'];
const reportFixture=raw=>{
 const bytes=Buffer.from(JSON.stringify(raw)),reads=[];
 const stat=path=>{reads.push(['stat',path]);return {isFile:()=>true,size:bytes.length};};
 const readFile=path=>{reads.push(['read',path]);return bytes;};
 return {reads,ports:{stat,readFile}};
};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function pendingReport(argv,ports={},throwChannel){
 const writes=[];
 const output=channel=>({write(text,complete){
  writes.push({channel,text,complete});
  if(channel===throwChannel)throw Error('SYNTHETIC_WRITE_FAILURE');
  return false;
 }});
 let settled=false;
 const result=runOfflineReportExecutable(argv,{
  ...ports,stdout:output('stdout'),stderr:output('stderr')
 }).then(code=>{settled=true;return code;});
 return {writes,result,settled:()=>settled};
}

test('offline report write completion preserves codes 0 and 1 and rejects delayed callback errors',async()=>{
 const argv=['/synthetic/receipt'];
 const raw={schema:'SQUIRE2_SINGLE_JS_DRY_RUN_V1',status:'DRY_RUN_NATIVE_DISABLED',
  direct_child_invocations:0,task_correctness:'NOT_EVALUATED',runtime_admitted:false};
 const legacy=[];
 const control=reportFixture(raw);
 assert.equal(await runOfflineReportCli(argv,{
  ...control.ports,stdout:{write:text=>legacy.push(text)},stderr:{write(){assert.fail('unexpected stderr');}}
 }),1);
 for(const [args,code,text] of [[capabilityArgs,0,serializeOfflineReportCapabilities()],[argv,1,legacy[0]]]){
  for(const failed of [false,true]){
   const f=reportFixture(raw),p=pendingReport(args,f.ports);
   await turn();
   assert.equal(p.settled(),false);
   assert.deepEqual(p.writes.map(({channel,text})=>[channel,text]),[['stdout',text]]);
   p.writes[0].complete(failed?Error('SYNTHETIC_DELAYED_WRITE_FAILURE'):undefined);
   assert.equal(await p.result,failed?2:code);
   assert.equal(p.writes.length,1);
   assert.deepEqual(f.reads,code===0?[]:[['stat',argv[0]],['read',argv[0]]]);
  }
 }
});

test('offline report write completion preserves both channels and waits in either callback order',async()=>{
 const argv=['/synthetic/receipt'],raw={schema:'SQUIRE2_SINGLE_JS_RESULT_V1'},expected=[];
 const control=reportFixture(raw);
 assert.equal(await runOfflineReportCli(argv,{
  ...control.ports,stdout:{write:text=>expected.push(['stdout',text])},stderr:{write:text=>expected.push(['stderr',text])}
 }),2);
 assert.deepEqual(expected.map(([channel])=>channel),['stdout','stderr']);
 for(const first of [0,1]){
  const f=reportFixture(raw),p=pendingReport(argv,f.ports);
  await turn();
  assert.deepEqual(p.writes.map(({channel,text})=>[channel,text]),expected);
  p.writes[first].complete(Error('SYNTHETIC_CHANNEL_FAILURE'));
  await turn();
  assert.equal(p.settled(),false);
  p.writes[1-first].complete();
  assert.equal(await p.result,2);
  assert.equal(p.writes.length,2);
  assert.deepEqual(f.reads,[['stat',argv[0]],['read',argv[0]]]);
 }
});

test('offline report write completion preserves synchronous capability fallback and stderr-only usage',async()=>{
 const f=reportFixture({}),fallback=pendingReport(capabilityArgs,f.ports,'stdout');
 await turn();
 assert.equal(fallback.settled(),false);
 assert.deepEqual(fallback.writes.map(({channel,text})=>[channel,text]),[
  ['stdout',serializeOfflineReportCapabilities()],['stderr','CAPABILITIES_INTERNAL_ERROR\n']
 ]);
 fallback.writes[1].complete();
 assert.equal(await fallback.result,2);
 assert.equal(fallback.writes.length,2);
 const usage=pendingReport([],f.ports);
 await turn();
 assert.equal(usage.settled(),false);
 assert.deepEqual(usage.writes.map(({channel,text})=>[channel,text]),[
  ['stderr','Usage: node bin/squire-report.mjs <receipt-path>\n']
 ]);
 usage.writes[0].complete();
 assert.equal(await usage.result,2);
 assert.deepEqual(f.reads,[]);
});

test('exact --help writes usage to stdout without accessing receipts',async()=>{
 const accesses=[],writes=[];
 const ports={
  stat:path=>{accesses.push(['stat',path]);throw new Error('Unexpected stat');},
  readFile:path=>{accesses.push(['readFile',path]);throw new Error('Unexpected read');},
  stdout:{write:bytes=>writes.push(['stdout',bytes])},
  stderr:{write:bytes=>writes.push(['stderr',bytes])},
 };
 assert.equal(await runOfflineReportCli(['--help'],ports),0);
 assert.deepEqual(accesses,[]);
 assert.deepEqual(writes,[['stdout',discoveryUsage]]);

 writes.length=0;
 ports.stdout.write=bytes=>{writes.push(['stdout',bytes]);throw new Error('Output failed');};
 assert.equal(await runOfflineReportCli(['--help'],ports),2);
 assert.deepEqual(accesses,[]);
 assert.deepEqual(writes,[['stdout',discoveryUsage]]);
});

test('explicit relative --help path still reaches the receipt reader',async()=>{
 const accesses=[];
 await runOfflineReportCli(['./--help'],{
  stat:path=>{accesses.push(['stat',path]);return {isFile:()=>true,size:2};},
  readFile:path=>{accesses.push(['readFile',path]);return Buffer.from('{}');},
  stdout:{write:()=>{}},
  stderr:{write:()=>{}},
 });
 assert.deepEqual(accesses,[['stat','./--help'],['readFile','./--help']]);
});

test('plain import does not install stdio handlers or change process output/exit state',async()=>{
 const source=`const before=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];
 await import(${JSON.stringify(new URL('../bin/squire-report.mjs',import.meta.url).href)});
 const after=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('IMPORT_CHANGED_PROCESS');`;
 const cp=spawn(process.execPath,['--input-type=module','--eval',source],{stdio:['ignore','pipe','pipe']});
 let out='',err='';cp.stdout.on('data',b=>out+=b);cp.stderr.on('data',b=>err+=b);
 const timer=setTimeout(()=>cp.kill('SIGKILL'),10000);
 try{const [code,signal]=await new Promise((resolve,reject)=>{cp.once('error',reject);cp.once('close',(...args)=>resolve(args));});
 assert.equal(code,0);assert.equal(signal,null);assert.equal(out,'');assert.equal(err,'');}finally{clearTimeout(timer);}
});
