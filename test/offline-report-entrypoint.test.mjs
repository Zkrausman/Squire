import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {serializeOfflineReportCapabilities} from '../bin/squire-report.mjs';

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
