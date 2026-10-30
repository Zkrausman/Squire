import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {
  createProjectPhaseObserver,createProjectPhaseBinding,
  createProjectPhaseEvidence,writeProjectPhaseDiagnostics
} from '../src/project-phase-diagnostics.mjs';
import {
  runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts,
  runProjectDesktopCodegenNativeWithPhaseDiagnostics,
  runProjectDesktopCodegenWithPorts,projectDryRun
} from '../acceptance/project-entrypoint.mjs';
import {
  PROJECT_SOURCE_ROOT,PROJECT_SOURCE_FILES,DESKTOP_CODEGEN_SOURCE_FILES,
  DESKTOP_CODEGEN_SCHEMA,DESKTOP_CODEGEN_INTENT,PROJECT_ENVIRONMENT_POLICY
} from '../src/project-configuration.mjs';
import {DESKTOP_TARGET,DESKTOP_PREFIX_IDENTITY} from '../src/desktop-profile.mjs';
import {buildProjectCodegenPrompt} from '../src/project-task.mjs';
import {NODE_RUNTIME,GENERATION_SHUTDOWN,canonicalBytes,hash} from '../src/bounded-codegen-plan.mjs';
import {RETENTION_POLICY} from '../src/local-rejected-retention.mjs';

// Synthetic emitters and clocks only. No native child, model, provider, GJS,
// generated code, benchmark or runtime probe is executed.
const enc=value=>new TextEncoder().encode(value);
const jsonl=value=>enc(JSON.stringify(value)+'\n');
const job='10000000-0000-4000-8000-000000000001';
const scope='/owned/phase';
const run={scope,job_id:job};
const path=join(scope,'output','run-'+job,'phase-diagnostics.json');
const secret='PRIVATE_CREDENTIAL_abc /private/account/123 prompt reasoning tool_args';
const trap=()=>{throw Error(secret);};
function observerFixture(){
  let time=0;
  const clock={now:()=>time};
  const observer=createProjectPhaseObserver(clock,0);
  const child=new EventEmitter();
  for(const name of ['stdin','stdout','stderr'])child[name]=new EventEmitter();
  return {clock,observer,child,at:value=>{time=value;}};
}
function evidence(observation){
  return createProjectPhaseEvidence({
    job_id:job,outcome:'INCOMPLETE',lifecycle:'LIMITED_TIMEOUT',
    declared_prompt_bytes:100
  },observation);
}
function scan(chunks,{eof=true}={}){
  const f=observerFixture();f.observer.spawnAttempt();f.observer.observe(f.child);
  for(const bytes of chunks)f.child.stdout.emit('data',bytes);
  if(eof)f.child.stdout.emit('end');
  f.observer.primaryResultReturned();
  return f.observer.seal();
}
// Synchronous, restored instrumentation of the observer's fixed-size arena.
// Record operation counts only; never retain the arena or its contents.
function countLineErases(action){
  const fill=Uint8Array.prototype.fill;
  const lengthOf=Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),'byteLength'
  ).get;
  let calls=0,bytes=0,largest=0,zeroed=true;
  Uint8Array.prototype.fill=function(...args){
    const size=Reflect.apply(lengthOf,this,[]);
    const result=Reflect.apply(fill,this,args);
    if(size===65536&&args[0]===0){
      const start=args[1]??0,end=args[2]??size,count=end-start;
      calls++;bytes+=count;largest=Math.max(largest,count);
      for(let index=start;index<end;index++){
        if(this[index]!==0)zeroed=false;
      }
    }
    return result;
  };
  try{return {value:action(),counts:()=>({calls,bytes,largest,zeroed})};}
  finally{Uint8Array.prototype.fill=fill;}
}
function stat({file=false,uid=1234,ino=1,nlink=1,mode=file?0o100600:0o40700,size=0}={}){
  return {dev:1,ino,nlink,uid,mode,size,mtimeMs:1,ctimeMs:1,
    isFile:()=>file,isDirectory:()=>!file,isSymbolicLink:()=>false};
}
function memoryFs(change={}){
  const files=new Map(),directories=new Map(),opened=[],closed=[];
  let sequence=20;
  function base(path){
    if(files.has(path)){
      const item=files.get(path);
      return stat({file:true,ino:item.ino,size:item.bytes.length,...change.leaf});
    }
    if(!directories.has(path)){
      directories.set(path,stat({uid:path==='/'?0:1234,ino:++sequence}));
    }
    return directories.get(path);
  }
  const port={
    async mkdir(path){directories.set(path,stat({ino:++sequence}));},
    async lstat(path){return change.lstat?change.lstat(path,base):base(path);},
    async open(path,flags,mode){
      opened.push({path,flags,mode});
      if(change.openBefore||files.has(path))throw Error(secret);
      const item={bytes:new Uint8Array(),ino:++sequence};files.set(path,item);
      if(change.openAfter)throw Error(secret);
      return {
        async stat(){return base(path);},
        async writeFile(bytes){
          item.bytes=new Uint8Array(change.partial?bytes.subarray(0,7):bytes);
          if(change.partial)throw Error(secret);
        },
        async read(buffer,offset,length,position){
          const count=Math.min(length,Math.max(0,item.bytes.length-position));
          buffer.set(item.bytes.subarray(position,position+count),offset);
          if(change.readback&&count)buffer[offset]^=1;
          return {bytesRead:change.invalidRead?-1:count};
        },
        async close(){closed.push(path);if(change.close)throw Error(secret);}
      };
    }
  };
  return {port,files,opened,closed};
}

test('A02: exact local milestones, split frames, fixed counts and frozen projection',()=>{
  const f=observerFixture(),o=f.observer,c=f.child;
  f.at(1);o.spawnAttempt();
  f.at(2);o.observe(c);
  f.at(3);c.emit('spawn');
  f.at(4);c.stdin.emit('drain');
  f.at(5);c.stdin.emit('finish');
  const events=[
    {type:'thread.started',thread_id:secret},
    {type:'turn.started'},
    {type:'item.started',item:{type:secret}},
    {type:'item.updated',item:{text:secret}},
    {type:'item.completed',item:{type:'agent_message',text:secret}},
    {type:'item.completed',item:{type:secret,arguments:secret}},
    {type:'turn.completed',usage:{
      input_tokens:12,output_tokens:3,cached_input_tokens:0,reasoning_output_tokens:2
    }}
  ];
  const bytes=enc(events.map(event=>JSON.stringify(event)).join('\n')+'\n');
  f.at(6);c.stdout.emit('data',bytes.subarray(0,11));
  f.at(7);c.stdout.emit('data',bytes.subarray(11));
  f.at(8);c.stderr.emit('data',enc(secret));
  f.at(9);c.stdout.emit('end');c.stderr.emit('end');
  f.at(10);c.emit('exit',0,null);
  f.at(11);o.primaryResultReturned();
  f.at(12);const value=evidence(o.seal()),v=value.observation;
  assert.deepEqual(v.clock,{origin:'WRAPPER_ENTRY',status:'OK',observed_elapsed_ms:12});
  for(const [key,elapsed]of [
    ['spawn_attempt_beforeports_spawn',1],['spawn_returned',2],
    ['child_spawn_event',3],['stdin_drain_event',4],['stdin_finish_event',5],
    ['first_stdout_data',6],['last_stdout_data',7],['first_stderr_data',8],
    ['last_stderr_data',8],['stdout_end',9],['stderr_end',9],
    ['child_exit_event',10],['primary_result_returned',11],['sealed',12]
  ])assert.deepEqual(v.milestones[key],{observed:true,elapsed_ms:elapsed});
  for(const key of [
    'stdin_close_event','stdin_error_event','stdout_close','stdout_error',
    'stderr_close','stderr_error','child_close_event','child_error_event'
  ])assert.deepEqual(v.milestones[key],{observed:false,elapsed_ms:null});
  assert.deepEqual(v.stdout_event_counts,{
    THREAD_STARTED:1,TURN_STARTED:1,ITEM_STARTED:1,ITEM_UPDATED:1,
    AGENT_MESSAGE_COMPLETED:1,OTHER_ITEM_COMPLETED:1,TURN_COMPLETED:1,
    TURN_FAILED:0,ERROR:0,OTHER:0
  });
  assert.deepEqual(v.stdout_frame_quality,{
    scanned_bytes:bytes.length,complete_frames_seen:7,frames_parsed:7,
    malformed_frames:0,oversized_line_skipped:false,event_parse_cap_reached:false,
    scan_truncated:false,event_counts_overflow:false,terminal_seen:true,
    terminal_conflict:false
  });
  assert.deepEqual(v.terminal_usage,{
    availability:'VALID',input:12,output:3,cache_read:0,reasoning:2
  });
  assert.deepEqual(v.streams,{
    stdin:{availability:'PRESENT'},
    stdout:{availability:'PRESENT',bytes:bytes.length,eof:true,close:false,error:false},
    stderr:{availability:'PRESENT',bytes:enc(secret).length,eof:true,close:false,error:false}
  });
  const visit=value=>{
    assert.ok(Object.isFrozen(value));
    for(const item of Object.values(value)){
      if(item!==null&&typeof item==='object')visit(item);
    }
  };
  visit(value);
  assert.equal(JSON.stringify(value).includes(secret),false);
  assert.equal(value.binding.declared_prompt_bytes,100);
  assert.equal(Object.hasOwn(v.streams.stdin,'bytes'),false);
});
test('A04/A07: unknown, missing, present empty and partial observations stay distinct',()=>{
  const unknown=createProjectPhaseObserver({now:()=>0},0).seal();
  assert.equal(unknown.streams.stdout.availability,'UNKNOWN');
  const f=observerFixture();
  f.observer.observe({stdin:null,stdout:undefined,stderr:null});
  const missing=f.observer.seal();
  for(const stream of Object.values(missing.streams))assert.equal(stream.availability,'MISSING');
  const empty=scan([]);
  assert.equal(empty.streams.stdout.availability,'PRESENT');
  assert.equal(empty.streams.stdout.bytes,0);
  assert.equal(empty.streams.stdout.eof,true);
  const partial=scan([enc('{"type":"turn.started"')],{eof:false});
  assert.equal(partial.streams.stdout.eof,false);
  assert.equal(partial.stdout_frame_quality.complete_frames_seen,0);
  assert.equal(partial.stdout_event_counts.TURN_STARTED,0);
  assert.equal(partial.milestones.stdin_finish_event.observed,false);
  const finished=observerFixture();finished.observer.observe(finished.child);
  finished.child.stdin.emit('finish');
  const value=finished.observer.seal();
  assert.equal(value.milestones.stdin_finish_event.observed,true);
  assert.equal(value.stdout_event_counts.TURN_STARTED,0);
  assert.equal(JSON.stringify(evidence(value)).includes('delivered'),false);
});
test('A06: every byte split, UTF-8 boundaries and a final frame without LF',()=>{
  const bytes=enc('{"type":"thread.started","ignored":"é💡"}\n'+
    '{"type":"turn.completed","usage":{"input_tokens":0}}');
  for(let index=0;index<=bytes.length;index++){
    const value=scan([bytes.subarray(0,index),bytes.subarray(index)]);
    assert.equal(value.stdout_event_counts.THREAD_STARTED,1);
    assert.equal(value.stdout_event_counts.TURN_COMPLETED,1);
    assert.equal(value.stdout_frame_quality.complete_frames_seen,2);
    assert.equal(value.terminal_usage.input,0);
  }
  const bytesOneAtATime=Array.from(bytes,byte=>new Uint8Array([byte]));
  assert.equal(scan(bytesOneAtATime).stdout_frame_quality.frames_parsed,2);
});
test('A06/A10: malformed, duplicate, BOM and hostile literal types never become fields',()=>{
  const value=scan([
    enc('{"type":\n'),
    enc('{"type":"turn.started","type":"turn.completed"}\n'),
    enc('\uFEFF{"type":"turn.started"}\n'),
    new Uint8Array([255,10]),
    jsonl({type:secret,item:{type:secret},credential:secret}),
    jsonl({type:{toString:secret}}),
    enc('{"type":"turn.completed","usage":{"input_tokens":1e999e0}}\n')
  ]);
  assert.equal(value.stdout_frame_quality.malformed_frames,5);
  assert.equal(value.stdout_event_counts.OTHER,2);
  assert.equal(value.stdout_event_counts.TURN_STARTED,0);
  const text=JSON.stringify(evidence(value));
  for(const textPart of [secret,'PRIVATE_CREDENTIAL_abc','/private/account','credential','sha256']){
    assert.equal(text.includes(textPart),false);
  }
});
test('A06/A15: oversized lines recover, EOF is handled once and parse work is bounded',()=>{
  const oversized=new Uint8Array(65537);oversized.fill(120);
  const value=scan([oversized,enc('\n'),jsonl({type:'turn.started'})]);
  assert.equal(value.stdout_frame_quality.oversized_line_skipped,true);
  assert.equal(value.stdout_frame_quality.complete_frames_seen,2);
  assert.equal(value.stdout_frame_quality.frames_parsed,1);
  assert.equal(value.stdout_event_counts.TURN_STARTED,1);
  const noLF=scan([oversized]);
  assert.equal(noLF.stdout_frame_quality.complete_frames_seen,1);
  assert.equal(noLF.stdout_frame_quality.frames_parsed,0);
  const f=observerFixture();f.observer.observe(f.child);
  f.child.stdout.emit('data',enc('{"type":"turn.started"}'));
  f.child.stdout.emit('end');f.child.stdout.emit('end');
  assert.equal(f.observer.seal().stdout_event_counts.TURN_STARTED,1);
  const many=scan([enc('{"type":"thread.started"}\n'.repeat(300))]);
  assert.equal(many.stdout_frame_quality.complete_frames_seen,300);
  assert.equal(many.stdout_frame_quality.frames_parsed,256);
  assert.equal(many.stdout_event_counts.THREAD_STARTED,255);
  assert.equal(many.stdout_frame_quality.event_parse_cap_reached,true);
  assert.equal(many.stdout_frame_quality.event_counts_overflow,true);
});
test('PH01: LF-only input through the scan cap performs no line-buffer erases',()=>{
  const input=new Uint8Array(1048576);input.fill(10);
  const measured=countLineErases(()=>scan([input]));
  const value=measured.value,q=value.stdout_frame_quality;
  assert.deepEqual(measured.counts(),{
    calls:0,bytes:0,largest:0,zeroed:true
  });
  assert.equal(q.scanned_bytes,1048576);
  assert.equal(q.complete_frames_seen,1048576);
  assert.equal(q.frames_parsed,0);
  assert.equal(q.malformed_frames,256);
  assert.equal(q.event_parse_cap_reached,true);
  assert.equal(q.scan_truncated,false);
  assert.equal(q.oversized_line_skipped,false);
  assert.equal(value.streams.stdout.eof,true);
  assert.doesNotThrow(()=>evidence(value));
});
test('PH01: fragmented frames erase only occupied bytes and stop buffering at the parse cap',()=>{
  const frame=JSON.stringify({type:'item.updated',ignored:'é '+secret})+'\n';
  const frameBytes=enc(frame);
  const input=enc(frame.repeat(600)+'{"type":"turn.completed"}');
  function* fragments(){
    for(const byte of input)yield new Uint8Array([byte]);
  }
  const measured=countLineErases(()=>scan(fragments()));
  const value=measured.value,q=value.stdout_frame_quality;
  assert.deepEqual(measured.counts(),{
    calls:256,bytes:256*(frameBytes.length-1),
    largest:frameBytes.length-1,zeroed:true
  });
  assert.equal(q.scanned_bytes,input.length);
  assert.equal(q.complete_frames_seen,601);
  assert.equal(q.frames_parsed,256);
  assert.equal(q.malformed_frames,0);
  assert.equal(q.event_parse_cap_reached,true);
  assert.equal(q.event_counts_overflow,true);
  assert.equal(q.scan_truncated,false);
  assert.equal(q.terminal_seen,false);
  assert.equal(value.stdout_event_counts.ITEM_UPDATED,255);
  assert.equal(value.stdout_event_counts.TURN_COMPLETED,0);
  assert.equal(JSON.stringify(evidence(value)).includes(secret),false);
});
test('A07/A15: native byte caps and diagnostic scan/line/frame caps are independent',()=>{
  const f=observerFixture();f.observer.observe(f.child);
  const out=new Uint8Array(1048577);out.fill(120);
  const err=new Uint8Array(65537);err.fill(120);
  f.child.stdout.emit('data',out);f.child.stderr.emit('data',err);
  f.child.stdout.emit('data',jsonl({type:'turn.started'}));
  f.child.stderr.emit('data',enc(secret));
  f.child.stdout.emit('end');
  const value=f.observer.seal();
  assert.equal(value.streams.stdout.bytes,1048577);
  assert.equal(value.streams.stderr.bytes,65537);
  assert.equal(value.stdout_frame_quality.scanned_bytes,1048576);
  assert.equal(value.stdout_frame_quality.scan_truncated,true);
  assert.equal(value.stdout_frame_quality.oversized_line_skipped,true);
  assert.equal(value.stdout_frame_quality.complete_frames_seen,0);
  assert.equal(value.stdout_event_counts.TURN_STARTED,0);
  assert.equal(value.stdout_frame_quality.frames_parsed,0);
  assert.doesNotThrow(()=>evidence(value));
});
test('A08: bad clocks give nullable elapsed times and fixed observer errors',()=>{
  for(const [read,status,error]of [
    [trap,'UNAVAILABLE','CLOCK_UNAVAILABLE'],
    [()=>-1,'UNAVAILABLE','CLOCK_UNAVAILABLE'],
    [()=>Number.MAX_SAFE_INTEGER+1,'UNAVAILABLE','CLOCK_UNAVAILABLE'],
    [()=>NaN,'UNAVAILABLE','CLOCK_UNAVAILABLE'],
    [()=>9,'REGRESSED','CLOCK_REGRESSED']
  ]){
    const o=createProjectPhaseObserver({now:read},10);
    assert.doesNotThrow(()=>o.spawnAttempt());
    const value=evidence(o.seal()).observation;
    assert.equal(value.clock.status,status);
    assert.equal(value.clock.observed_elapsed_ms,null);
    assert.equal(value.observer_error,error);
    assert.deepEqual(value.milestones.spawn_attempt_beforeports_spawn,{
      observed:true,elapsed_ms:null
    });
  }
  const originMissing=createProjectPhaseObserver({now:()=>123},null).seal();
  assert.equal(originMissing.clock.status,'UNAVAILABLE');
  let n=10;
  const o=createProjectPhaseObserver({now:()=>n},10);
  n=15;o.spawnAttempt();n=14;o.primaryResultReturned();
  const value=evidence(o.seal()).observation;
  assert.equal(value.milestones.spawn_attempt_beforeports_spawn.elapsed_ms,5);
  assert.equal(value.milestones.primary_result_returned.elapsed_ms,null);
  assert.equal(value.clock.status,'REGRESSED');
});
test('A09/A16: only owned listeners detach; errors and late events cannot rewrite evidence',()=>{
  const f=observerFixture(),existing=()=>{};
  for(const emitter of [f.child,f.child.stdin,f.child.stdout,f.child.stderr]){
    emitter.on('error',existing);emitter.on('close',existing);
  }
  f.child.stdout.on('data',existing);
  f.observer.observe(f.child);
  f.child.stdin.emit('error',Error(secret));
  f.child.stdout.emit('error',Error(secret));
  f.child.stderr.emit('error',Error(secret));
  f.child.emit('error',Error(secret));
  const value=evidence(f.observer.seal()),before=JSON.stringify(value);
  assert.deepEqual(f.child.stdout.listeners('data'),[existing]);
  for(const emitter of [f.child,f.child.stdin,f.child.stdout,f.child.stderr]){
    assert.deepEqual(emitter.listeners('error'),[existing]);
    assert.deepEqual(emitter.listeners('close'),[existing]);
    emitter.emit('close');emitter.emit('error',Error(secret));
  }
  f.child.stdout.emit('data',jsonl({type:'turn.completed'}));
  f.child.stdout.emit('end');f.child.emit('exit',0,null);
  assert.equal(JSON.stringify(value),before);
  assert.equal(value.observation.milestones.child_close_event.observed,false);
  const bad=observerFixture();bad.observer.observe(bad.child);
  bad.child.stdout.removeListener=trap;
  // Methods were captured during attachment; changing the property does not
  // replace the observer's already captured removal capability.
  assert.doesNotThrow(()=>bad.observer.seal());
  const throwing=new EventEmitter();throwing.removeListener=trap;
  const o=createProjectPhaseObserver({now:()=>0},0);
  o.observe({stdin:null,stdout:throwing,stderr:null});
  assert.doesNotThrow(()=>o.seal());
  assert.equal(o.seal().observer_error,'OBSERVER_ERROR');
});
test('PH03: registration-time sealing removes listeners installed across newListener',()=>{
  const events=[
    'spawn','exit','close','error','drain','finish','data','end',
    'newListener','removeListener'
  ];
  for(const [targetName,trigger]of [
    ['child','close'],['stdin','finish'],['stdout','data'],['stderr','end']
  ]){
    const f=observerFixture(),o=f.observer;
    const emitters=[f.child,f.child.stdin,f.child.stdout,f.child.stderr];
    const existing=()=>{};
    for(const emitter of emitters){
      for(const event of events.slice(0,8))emitter.on(event,existing);
    }
    const target=targetName==='child'?f.child:f.child[targetName];
    let crossed=false,inside=null;
    target.on('newListener',event=>{
      if(crossed||event!==trigger)return;
      crossed=true;
      // For stderr registration, stdout is already observed. Exercise sealing
      // with an occupied partial line as well as the empty-buffer cases.
      if(targetName==='stderr')f.child.stdout.emit('data',enc(secret));
      inside=o.seal();
      assert.equal(o.seal(),inside);
    });
    const before=emitters.map(emitter=>new Map(
      events.map(event=>[event,emitter.listeners(event)])
    ));
    const measured=countLineErases(()=>{
      o.spawnAttempt();
      assert.doesNotThrow(()=>o.observe(f.child));
      return o.seal();
    });
    assert.equal(crossed,true);
    assert.equal(measured.value,inside);
    assert.equal(o.seal(),inside);
    assert.equal(inside.observer_error,'OBSERVER_ERROR');
    assert.deepEqual(measured.counts(),{
      calls:targetName==='stderr'?1:0,
      bytes:targetName==='stderr'?enc(secret).length:0,
      largest:targetName==='stderr'?enc(secret).length:0,
      zeroed:true
    });
    for(let index=0;index<emitters.length;index++){
      for(const event of events){
        assert.deepEqual(emitters[index].listeners(event),before[index].get(event));
      }
    }
    const projected=evidence(inside),text=JSON.stringify(projected);
    assert.equal(text.includes(secret),false);
    for(const emitter of emitters){
      emitter.emit('data',enc(secret));
      emitter.emit('end');emitter.emit('close');
      emitter.emit('error',Error(secret));
    }
    f.child.emit('spawn');f.child.emit('exit',0,null);
    assert.equal(JSON.stringify(projected),text);
    assert.equal(o.seal(),inside);
  }
});
test('PH03: detachment-time recursive sealing neither restarts cleanup nor leaks listeners',()=>{
  const f=observerFixture(),o=f.observer;
  const emitters=[f.child,f.child.stdin,f.child.stdout,f.child.stderr];
  const events=['spawn','exit','close','error','drain','finish','data','end'];
  const existing=()=>{};
  let depth=0,maximumDepth=0,removals=0;
  function reenter(){
    depth++;maximumDepth=Math.max(maximumDepth,depth);removals++;
    try{
      o.seal();
      o.spawnAttempt();o.primaryResultReturned();o.observe(f.child);
    }finally{depth--;}
  }
  for(const emitter of emitters){
    for(const event of events)emitter.on(event,existing);
    emitter.on('removeListener',reenter);
  }
  const before=emitters.map(emitter=>new Map(
    [...events,'removeListener'].map(event=>[event,emitter.listeners(event)])
  ));
  o.observe(f.child);
  f.child.stdout.emit('data',enc(secret));
  const measured=countLineErases(()=>o.seal()),snapshot=measured.value;
  assert.equal(maximumDepth,1);
  assert.equal(removals,16);
  assert.equal(snapshot.observer_error,'NONE');
  assert.deepEqual(measured.counts(),{
    calls:1,bytes:enc(secret).length,largest:enc(secret).length,zeroed:true
  });
  assert.equal(o.seal(),snapshot);
  assert.equal(removals,16);
  for(let index=0;index<emitters.length;index++){
    for(const event of [...events,'removeListener']){
      assert.deepEqual(emitters[index].listeners(event),before[index].get(event));
    }
  }
  const projected=evidence(snapshot),text=JSON.stringify(projected);
  assert.equal(text.includes(secret),false);
  for(const emitter of emitters){
    emitter.emit('data',enc(secret));emitter.emit('end');
    emitter.emit('close');emitter.emit('error',Error(secret));
  }
  assert.equal(JSON.stringify(projected),text);
  assert.equal(o.seal(),snapshot);
});
test('PH03: crossing registration records uncertainty before post-registration cleanup can throw',()=>{
  const f=observerFixture(),o=f.observer,stream=f.child.stdout;
  const existing=()=>{};
  stream.on('data',existing);
  let owned=null,inside=null,crossed=false,depth=0,maximumDepth=0;
  const attempts=[];
  const remove=stream.removeListener;
  stream.removeListener=function(event,listener){
    if(event==='data'&&listener===owned){
      depth++;maximumDepth=Math.max(maximumDepth,depth);
      try{
        const present=this.listeners(event).includes(listener);
        attempts.push(present?'PRESENT':'ABSENT');
        o.seal();
        if(present)throw Error(secret);
      }finally{depth--;}
    }
    return Reflect.apply(remove,this,[event,listener]);
  };
  stream.on('newListener',(event,listener)=>{
    if(crossed||event!=='data')return;
    crossed=true;owned=listener;
    inside=o.seal();
    assert.equal(inside.observer_error,'OBSERVER_ERROR');
  });
  const measured=countLineErases(()=>{
    assert.doesNotThrow(()=>o.observe(f.child));
    return o.seal();
  });
  assert.equal(crossed,true);
  assert.deepEqual(attempts,['ABSENT','PRESENT']);
  assert.equal(maximumDepth,1);
  assert.equal(measured.value,inside);
  assert.equal(inside.observer_error,'OBSERVER_ERROR');
  assert.deepEqual(measured.counts(),{
    calls:0,bytes:0,largest:0,zeroed:true
  });
  // The throwing port prevented physical removal. Report uncertainty rather
  // than claiming detach, retrying indefinitely or removing another listener.
  assert.deepEqual(stream.listeners('data'),[existing,owned]);
  const projected=evidence(inside),before=JSON.stringify(projected);
  for(let repeat=0;repeat<5;repeat++){
    assert.equal(o.seal(),inside);
    o.observe(f.child);
    stream.emit('data',enc(secret));
    stream.emit('end');stream.emit('close');
    f.child.emit('exit',0,null);f.child.emit('close',0,null);
  }
  assert.deepEqual(attempts,['ABSENT','PRESENT']);
  assert.equal(JSON.stringify(projected),before);
  assert.equal(before.includes(secret),false);
  assert.equal(inside.streams.stdout.bytes,0);
  assert.equal(inside.milestones.first_stdout_data.observed,false);
  assert.equal(Object.isFrozen(inside),true);
  // Dispose of this fake listener through the intrinsic, without suggesting
  // that production cleanup succeeded through the throwing captured port.
  EventEmitter.prototype.removeListener.call(stream,'data',owned);
  assert.deepEqual(stream.listeners('data'),[existing]);
});
test('A10: hostile children, methods, chunks and nested projections execute no traps',async()=>{
  let accesses=0;
  const fail=()=>{accesses++;throw Error(secret);};
  const proxy=new Proxy({},{
    get:fail,getPrototypeOf:fail,ownKeys:fail,getOwnPropertyDescriptor:fail
  });
  const accessor={};Object.defineProperty(accessor,'stdout',{get:fail});
  const stream={};Object.defineProperty(stream,'on',{get:fail});
  for(const child of [proxy,accessor,{stdin:null,stdout:stream,stderr:proxy}]){
    const o=createProjectPhaseObserver({now:()=>0},0);
    assert.doesNotThrow(()=>o.observe(child));
    assert.equal(o.seal().observer_error,'OBSERVER_ERROR');
  }
  const f=observerFixture();f.observer.observe(f.child);
  f.child.stdout.emit('data',proxy);
  assert.equal(f.observer.seal().observer_error,'OBSERVER_ERROR');
  const bytes=jsonl({type:'turn.started'});
  for(const key of ['length','byteLength',Symbol.iterator]){
    Object.defineProperty(bytes,key,{get:fail});
  }
  assert.equal(scan([bytes]).stdout_event_counts.TURN_STARTED,1);
  const base=evidence(scan([])),v=base.observation;
  const getter={...base};Object.defineProperty(getter,'observation',{get:fail});
  for(const candidate of [
    proxy,getter,{...base,payload:secret},{...base,toJSON:fail},
    {...base,binding:proxy},
    {...base,observation:{...v,clock:proxy}},
    {...base,observation:{...v,milestones:proxy}},
    {...base,observation:{...v,streams:{...v.streams,stdout:proxy}}},
    {...base,observation:{...v,stdout_event_counts:{...v.stdout_event_counts,[secret]:1}}},
    {...base,observation:{...v,stdout_frame_quality:proxy}},
    {...base,observation:{...v,terminal_usage:proxy}}
  ]){
    const m=memoryFs();
    assert.deepEqual(await writeProjectPhaseDiagnostics(candidate,run,{
      fs:m.port,uid:1234
    }),{status:'FAILED'});
    assert.equal(m.opened.length,0);
  }
  assert.equal(accesses,0);
});
test('A11: usage is a separate partial numeric view; terminals never use last-wins',()=>{
  const partial=scan([jsonl({type:'turn.completed',usage:{
    input_tokens:0,cached_input_tokens:9,reasoning_output_tokens:4
  }})]);
  assert.deepEqual(partial.terminal_usage,{
    availability:'VALID',input:0,output:'UNKNOWN',cache_read:9,reasoning:4
  });
  for(const token of ['-1','1.5','9007199254740992','1e999']){
    const value=scan([enc('{"type":"turn.completed","usage":'+
      '{"input_tokens":'+token+',"output_tokens":0}}\n')]);
    assert.equal(value.stdout_event_counts.TURN_COMPLETED,1);
    assert.equal(value.terminal_usage.availability,'INVALID');
    assert.equal(value.terminal_usage.input,'UNKNOWN');
    assert.equal(value.terminal_usage.output,0);
  }
  for(const usage of [null,[],secret]){
    assert.equal(scan([jsonl({type:'turn.completed',usage})])
      .terminal_usage.availability,'INVALID');
  }
  assert.equal(scan([jsonl({type:'turn.completed'})])
    .terminal_usage.availability,'NOT_OBSERVED');
  for(const second of ['turn.completed','turn.failed']){
    const value=scan([
      jsonl({type:'turn.completed',usage:{input_tokens:1}}),
      jsonl({type:second,usage:{input_tokens:999}})
    ]);
    assert.equal(value.stdout_frame_quality.terminal_conflict,true);
    assert.deepEqual(value.terminal_usage,{
      availability:'AMBIGUOUS',input:'UNKNOWN',output:'UNKNOWN',
      cache_read:'UNKNOWN',reasoning:'UNKNOWN'
    });
  }
});
test('PH02: lexical counter validation cannot invent rounded integers or underflowed zero',()=>{
  const sources=[
    ['input_tokens','input'],['output_tokens','output'],
    ['cached_input_tokens','cache_read'],['reasoning_output_tokens','reasoning']
  ];
  const valid=[
    ['0',0],['-0',0],['0.0',0],['-0.000e-999',0],['0e999999',0],
    ['1',1],['42',42],['9007199254740991',9007199254740991]
  ];
  const invalid=[
    '-1e-999','1e-999','1.0000000000000001',
    '9007199254740992','9007199254740993',
    '9007199254740991.0','9007199254740991e0',
    '1e0','1.0','-1','-0.00000001e-999','1e999'
  ];
  for(const [source,key]of sources){
    for(const [token,expected]of valid){
      const value=scan([enc('{"type":"turn.completed","usage":{"'+
        source+'":'+token+'}}\n')]);
      assert.equal(value.stdout_frame_quality.frames_parsed,1,token);
      assert.equal(value.stdout_frame_quality.malformed_frames,0,token);
      assert.equal(value.terminal_usage.availability,'VALID',token);
      assert.equal(value.terminal_usage[key],expected,token);
      assert.equal(Object.is(value.terminal_usage[key],-0),false,token);
    }
    for(const token of invalid){
      const value=scan([enc('{"type":"turn.completed","usage":{"'+
        source+'":'+token+'}}\n')]);
      assert.equal(value.stdout_frame_quality.frames_parsed,1,token);
      assert.equal(value.stdout_frame_quality.malformed_frames,0,token);
      assert.equal(value.terminal_usage.availability,'INVALID',token);
      assert.equal(value.terminal_usage[key],'UNKNOWN',token);
    }
  }
});
test('PH02: numeric normalization preserves malformed-token, duplicate and BOM rejection',()=>{
  for(const token of ['1e999e0','01','1.','--1','1e+','-01e999','1 2']){
    const value=scan([enc('{"type":"turn.completed","usage":{"input_tokens":'+
      token+'}}\n')]);
    assert.equal(value.stdout_frame_quality.malformed_frames,1,token);
    assert.equal(value.stdout_frame_quality.frames_parsed,0,token);
    assert.equal(value.stdout_frame_quality.terminal_seen,false,token);
    assert.equal(value.terminal_usage.availability,'NOT_OBSERVED',token);
  }
  for(const input of [
    enc('{"type":"turn.completed","usage":{"input_tokens":1e-999,"input_tokens":0}}\n'),
    enc('\uFEFF{"type":"turn.completed","usage":{"input_tokens":1e-999}}\n'),
    new Uint8Array([123,34,255,34,58,48,125,10])
  ]){
    const value=scan([input]);
    assert.equal(value.stdout_frame_quality.malformed_frames,1);
    assert.equal(value.stdout_frame_quality.frames_parsed,0);
    assert.equal(value.stdout_frame_quality.terminal_seen,false);
  }
});
test('A12: fixed phase writer preserves exclusive custody, privacy and old destination separation',async()=>{
  const m=memoryFs(),value=evidence(scan([jsonl({
    type:'item.completed',item:{type:'agent_message',text:secret}
  })]));
  assert.deepEqual(await writeProjectPhaseDiagnostics(value,run,{
    fs:m.port,uid:1234
  }),{status:'RECORDED'});
  assert.deepEqual(m.opened,[{
    path,mode:0o600,flags:constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|
      constants.O_NOFOLLOW|constants.O_NONBLOCK
  }]);
  assert.deepEqual(m.closed,[path]);
  const bytes=m.files.get(path).bytes;
  assert.ok(bytes.length<=4096);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)),value);
  assert.equal(new TextDecoder().decode(bytes).includes(secret),false);
  const before=new Uint8Array(bytes);
  assert.deepEqual(await writeProjectPhaseDiagnostics(value,run,{
    fs:m.port,uid:1234
  }),{status:'UNKNOWN'});
  assert.deepEqual(m.files.get(path).bytes,before);
  assert.equal(m.files.has(path.replace('phase-diagnostics','failure-diagnostics')),false);
});
test('A12: writer rejects before open and preserves uncertainty after possible mutation',async()=>{
  const value=evidence(scan([]));
  for(const candidate of [
    {...value,binding:{...value.binding,job_id:'10000000-0000-4000-8000-000000000099'}},
    {...value,binding:{...value.binding,declared_prompt_bytes:32769}},
    {...value,binding:{...value.binding,outcome:secret}},
    {...value,observation:{...value.observation,observer_error:secret}}
  ]){
    const m=memoryFs();
    assert.deepEqual(await writeProjectPhaseDiagnostics(candidate,run,{
      fs:m.port,uid:1234
    }),{status:'FAILED'});
    assert.equal(m.opened.length,0);
  }
  for(const target of [
    {scope:'relative',job_id:job},{...run,filename:'elsewhere'},
    {scope,job_id:'../elsewhere'}
  ]){
    const m=memoryFs();
    assert.deepEqual(await writeProjectPhaseDiagnostics(value,target,{
      fs:m.port,uid:1234
    }),{status:'FAILED'});
    assert.equal(m.opened.length,0);
  }
  const parent=dirname(path);
  for(const [unsafe,replace]of [
    [parent,s=>({...s,mode:0o40750})],
    [parent,s=>({...s,uid:9})],
    [parent,s=>({...s,isSymbolicLink:()=>true})],
    ['/owned',s=>({...s,mode:0o41777})],
    ['/owned',s=>({...s,uid:9})]
  ]){
    const m=memoryFs({lstat:(p,base)=>p===unsafe?replace(base(p)):base(p)});
    assert.deepEqual(await writeProjectPhaseDiagnostics(value,run,{
      fs:m.port,uid:1234
    }),{status:'FAILED'});
    assert.equal(m.opened.length,0);
  }
  for(const change of [
    {openBefore:true},{openAfter:true},{partial:true},{readback:true},
    {invalidRead:true},{close:true},{leaf:{mode:0o100644}},
    {leaf:{uid:9}},{leaf:{nlink:2}},
    {lstat:(p,base)=>p===path?{...base(p),ino:base(p).ino+1}:base(p)}
  ]){
    const m=memoryFs(change);
    assert.deepEqual(await writeProjectPhaseDiagnostics(value,run,{
      fs:m.port,uid:1234
    }),{status:'UNKNOWN'});
    assert.equal(m.opened.length,1);
    assert.ok(m.closed.length<=1);
    if(change.partial)assert.equal(m.files.get(path).bytes.length,7);
  }
  let checks=0;
  const changed=memoryFs({lstat:(p,base)=>{
    const s=base(p);
    return p==='/owned'&&++checks>1?{...s,ino:s.ino+1}:s;
  }});
  assert.deepEqual(await writeProjectPhaseDiagnostics(value,run,{
    fs:changed.port,uid:1234
  }),{status:'UNKNOWN'});
});
test('A12/A15: maximum-width finite timestamps still fit the private writer limit',async()=>{
  const value=structuredClone(scan([]));
  value.clock.observed_elapsed_ms=Number.MAX_SAFE_INTEGER;
  for(const mark of Object.values(value.milestones)){
    mark.observed=true;mark.elapsed_ms=Number.MAX_SAFE_INTEGER;
  }
  for(const name of ['stdout','stderr']){
    Object.assign(value.streams[name],{eof:true,close:true,error:true});
  }
  const projected=evidence(value),m=memoryFs();
  assert.deepEqual(await writeProjectPhaseDiagnostics(projected,run,{
    fs:m.port,uid:1234
  }),{status:'RECORDED'});
  assert.ok(m.files.get(path).bytes.length<=4096);
});

let fixtureNumber=0;
function fixture(kind='nonzero',selectedScope){
  const number=++fixtureNumber;
  const id=`20000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
  const taskScope=selectedScope??'/owned/phase-'+number,m=memoryFs();
  const prompt=buildProjectCodegenPrompt({
    schema:'SQUIRE2_PROJECT_REQUEST_V1',task_id:'synthetic-phase',
    task_prompt:'Public synthetic source request.',
    runtime_target:DESKTOP_TARGET,stage_target:'multifile-candidate'
  });
  const c={
    schema:DESKTOP_CODEGEN_SCHEMA,runtime_admitted:false,provider_id:'native_codex',
    job_id:id,scope:taskScope,source_commit:'e'.repeat(40),
    source_pins:Object.fromEntries(DESKTOP_CODEGEN_SOURCE_FILES.map(name=>[
      join(PROJECT_SOURCE_ROOT,name),{bytes:1,sha256:'a'.repeat(64)}
    ])),
    node:NODE_RUNTIME,
    codex:{path:'/synthetic/codex',version:'0.160.0',bytes:1,sha256:'b'.repeat(64)},
    requested_model:'synthetic-model',effort:'medium',
    authorization:{operator_receipt:'/synthetic/operator',
      supported_tuples:[{model:'synthetic-model',effort:'medium'}]},
    permissions:{sandbox:'read-only',approval_mode:'never',
      output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'},
    prompt:{path:'/synthetic/prompt',bytes:prompt.length,sha256:hash(prompt)},
    target_mode:{mode:'multifile_stage',stage_subpath:'stage'},
    diagnostic_retention:RETENTION_POLICY,generation_shutdown:GENERATION_SHUTDOWN,
    preflight_freshness_ms:300000,outer_observation_ms:140000,
    generation_wall_ms:120000,max_direct_child_spawns:1,
    environment_policy:PROJECT_ENVIRONMENT_POLICY,
    operation_intent:DESKTOP_CODEGEN_INTENT,runtime_target:DESKTOP_TARGET,
    prefix_identity:DESKTOP_PREFIX_IDENTITY,
    desktop_runtime_identity:{
      status:'NOT_QUALIFIED',
      executable:{path:'/prospective/gjs',bytes:1,sha256:'c'.repeat(64)},
      typelibs:[{namespace:'Gtk',version:'4.0',typelib:'/prospective/Gtk.typelib',
        bytes:1,sha256:'d'.repeat(64)}],
      libraries:[{name:'gtk',path:'/prospective/libgtk.so',bytes:1,sha256:'f'.repeat(64)}]
    }
  };
  const bytes=canonicalBytes(c);
  const admission={
    provider_id:'native_codex',operator_receipt:c.authorization.operator_receipt,
    config_sha256:hash(bytes),job_id:id,scope:taskScope,
    desktop_codegen_admitted:true,preflight:{evidence_receipt:'/synthetic/proof'}
  };
  const proof=canonicalBytes({
    operation_config_sha256:hash(bytes),observed_at_ms:1000,
    provider_id:'native_codex',cli_version:c.codex.version,
    executable_sha256:c.codex.sha256,requested_model:c.requested_model,
    effort:c.effort,operator_receipt:c.authorization.operator_receipt,
    subscription:true,allowance_available:true,effective_provider:'openai_subscription',
    no_api_or_paid_fallback:true,sandbox:c.permissions.sandbox,
    approval_mode:c.permissions.approval_mode,output_contract:c.permissions.output_contract,
    installed_flags_verified:true
  });
  const payload=JSON.stringify({
    schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',
    files:[{path:'main.js',classification:'SOURCE',encoding:'utf-8',
      content:"import Gtk from 'gi://Gtk?version=4.0';\n"+'// synthetic source\n'.repeat(60)}]
  });
  const output=enc([
    {type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:payload}},
    {type:'turn.completed',usage:{
      input_tokens:1,output_tokens:2,cached_input_tokens:0,reasoning_output_tokens:0
    }}
  ].map(value=>JSON.stringify(value)).join('\n')+'\n');
  let time=0,spawns=0,clockFault=false,entryFault=false,finishObserved=true;
  const timers=[],scheduled=[],controller=new AbortController(),child=new EventEmitter();
  child.pid=123;child.kill=()=>true;child.unref=()=>{};
  for(const name of ['stdin','stdout','stderr']){
    child[name]=new EventEmitter();child[name].destroy=()=>{};
  }
  child.stdin.write=(_bytes,callback)=>{callback();return true;};
  child.stdin.end=callback=>{
    callback();
    queueMicrotask(()=>{
      if(finishObserved)child.stdin.emit('finish');
      if(kind==='abort'){controller.abort();return;}
      if(kind==='timeout'||kind==='progress')return;
      if(kind==='terminaltimeout'){
        time=80000;
        child.stdout.emit('data',jsonl({type:'turn.completed',usage:{
          input_tokens:7,output_tokens:0,cached_input_tokens:2,reasoning_output_tokens:1
        }}));
        return;
      }
      if(kind==='clockfault')clockFault=true;
      child.stderr.emit('data',enc(secret));
      if(kind==='success')child.stdout.emit('data',output);
      child.stdout.emit('end');child.stderr.emit('end');
      child.emit('exit',kind==='success'?0:1,null);
    });
  };
  const clock={
    now(){
      if(clockFault||entryFault){
        clockFault=false;entryFault=false;throw Error(secret);
      }
      return time;
    },
    schedule(delay,fn){
      const timer={at:time+delay,fn,active:true};
      timers.push(timer);scheduled.push({at:time,delay});
      return()=>{timer.active=false;};
    }
  };
  const ports={
    fs:m.port,uid:1234,clock,now:()=>1000,environment:{},
    reads:{lstat:m.port.lstat,readChunks:async function*(){}},
    verifyFile:async()=>{},
    readBytes:async name=>name==='/synthetic/proof'?proof:prompt,
    retention:()=>({prepare:async()=>({capability_status:'READY'})}),
    spawn(){
      spawns++;
      if(kind==='spawnfailure')throw Error(secret);
      queueMicrotask(()=>child.emit('spawn'));
      return child;
    }
  };
  async function settle(operation){
    let done=false,value,error,progressSent=false;
    operation.then(v=>{value=v;done=true;},e=>{error=e;done=true;});
    for(let step=0;step<30&&!done;step++){
      for(let turn=0;turn<300;turn++)await Promise.resolve();
      if(done)break;
      const timer=timers.filter(item=>item.active).sort((a,b)=>a.at-b.at)[0];
      assert.ok(timer,'synthetic operation must settle or have a bound');
      if(kind==='progress'&&!progressSent&&timer.at>=120000){
        progressSent=true;
        for(let tick=10000;tick<120000;tick+=10000){
          time=tick;
          child.stdout.emit('data',jsonl({type:'item.updated',item:{text:secret}}));
        }
      }
      time=timer.at;timer.active=false;timer.fn();
    }
    assert.equal(done,true);
    if(error)throw error;
    return value;
  }
  return {c,bytes,admission,ports,child,controller,m,settle,scheduled,
    spawns:()=>spawns,entryFault:()=>{entryFault=true;},
    omitFinish:()=>{finishObserved=false;}};
}
const wrapped=f=>runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts(
  f.bytes,f.admission,f.controller.signal,f.ports
);
function primary(value){
  const result=JSON.parse(JSON.stringify(value));
  if(result.generation)result.generation.record.job_id='synthetic-job';
  return result;
}

test('A01/A13: primary outcomes, spawn count and scheduling match the original route',async()=>{
  for(const [kind,lifecycle,outcome]of [
    ['nonzero','LIMITED_PROCESS_FAILED','GENERATION_REJECTED'],
    ['timeout','LIMITED_TIMEOUT','INCOMPLETE'],
    ['abort','LIMITED_USER_ABORT','INCOMPLETE'],
    ['spawnfailure','LIMITED_SPAWN_FAILED','GENERATION_REJECTED']
  ]){
    const a=fixture(kind),b=fixture(kind);
    const original=await a.settle(runProjectDesktopCodegenWithPorts(
      a.bytes,a.admission,a.controller.signal,a.ports
    ));
    const envelope=await b.settle(wrapped(b));
    assert.deepEqual(primary(envelope.result),primary(original));
    assert.deepEqual(b.scheduled,a.scheduled);
    assert.equal(b.spawns(),1);
    assert.equal(envelope.result.generation.record.lifecycle_status,lifecycle);
    assert.equal(envelope.result.status,outcome);
    assert.equal(envelope.result.direct_child_invocations.generation,1);
    assert.equal(Object.hasOwn(envelope.result,'phase_diagnostics'),false);
    assert.equal(Object.hasOwn(original,'result'),false);
    assert.equal(envelope.phase_diagnostics.sidecar_status,'NOT_REQUESTED');
    assert.deepEqual(envelope.phase_diagnostics.evidence.binding,{
      job_id:b.c.job_id,outcome,lifecycle,declared_prompt_bytes:b.c.prompt.bytes
    });
    assert.equal(b.m.opened.length,0);
    a.child.emit('exit',1,null);b.child.emit('exit',1,null);
  }
});
test('A03: continuous metadata cannot renew the original 120-second deadline',async()=>{
  const f=fixture('progress'),envelope=await f.settle(wrapped(f));
  const generation=envelope.result.generation;
  assert.equal(generation.record.lifecycle_status,'LIMITED_TIMEOUT');
  assert.equal(generation.runtime_evidence.deadline_ms,120000);
  assert.equal(generation.runtime_evidence.timeout_latched,true);
  assert.equal(generation.runtime_evidence.signal_attempts[0].elapsed_ms,120000);
  assert.equal(generation.runtime_evidence.signal_attempts[0].signal,'SIGTERM');
  assert.equal(envelope.phase_diagnostics.evidence.observation.stdout_event_counts.ITEM_UPDATED,11);
  assert.equal(f.scheduled.filter(timer=>timer.delay===120000).length,1);
  assert.equal(f.scheduled.filter(timer=>timer.delay===140000).length,2);
  assert.equal(f.spawns(),1);
  f.child.emit('exit',1,null);
});
test('A04/A05: stdin finish and observed terminal usage do not imply peer receipt or success',async()=>{
  const noFinish=fixture();noFinish.omitFinish();
  const a=await noFinish.settle(wrapped(noFinish));
  assert.equal(a.phase_diagnostics.evidence.observation.milestones.stdin_finish_event.observed,false);
  const finish=fixture(),b=await finish.settle(wrapped(finish));
  assert.equal(b.phase_diagnostics.evidence.observation.milestones.stdin_finish_event.observed,true);
  assert.equal(b.phase_diagnostics.evidence.observation.stdout_event_counts.TURN_STARTED,0);
  const f=fixture('terminaltimeout'),envelope=await f.settle(wrapped(f));
  const v=envelope.phase_diagnostics.evidence.observation;
  assert.equal(envelope.result.generation.record.lifecycle_status,'LIMITED_TIMEOUT');
  assert.equal(envelope.result.status,'INCOMPLETE');
  assert.equal(envelope.result.generation.runtime_evidence.deadline_ms,120000);
  assert.equal(v.stdout_frame_quality.terminal_seen,true);
  assert.equal(v.milestones.last_stdout_data.elapsed_ms,80000);
  assert.deepEqual(v.milestones.child_close_event,{observed:false,elapsed_ms:null});
  assert.deepEqual(v.terminal_usage,{
    availability:'VALID',input:7,output:0,cache_read:2,reasoning:1
  });
  assert.equal(envelope.result.generation.record.provider_metadata.usage_tokens.input,'UNKNOWN');
  const before=JSON.stringify(envelope.phase_diagnostics);
  f.child.emit('close',0,null);f.child.emit('exit',0,null);
  assert.equal(JSON.stringify(envelope.phase_diagnostics),before);
});
test('A08/A16: observer clock and registration failures preserve a known primary result',async()=>{
  const original=fixture();
  const base=await original.settle(runProjectDesktopCodegenWithPorts(
    original.bytes,original.admission,undefined,original.ports
  ));
  for(const kind of ['clockfault','entryfault','registration']){
    const f=fixture(kind==='clockfault'?kind:'nonzero');
    if(kind==='entryfault')f.entryFault();
    if(kind==='registration'){
      const on=f.child.stdout.on;
      let first=true;
      f.child.stdout.on=function(...args){
        if(first){first=false;throw Error(secret);}
        return Reflect.apply(on,this,args);
      };
    }
    const envelope=await f.settle(wrapped(f));
    assert.deepEqual(primary(envelope.result),primary(base));
    if(kind==='registration'){
      assert.deepEqual(envelope.phase_diagnostics,{
        status:'UNAVAILABLE',reason:'OBSERVER_ERROR',sidecar_status:'NOT_REQUESTED'
      });
    }else{
      const v=envelope.phase_diagnostics.evidence.observation;
      assert.equal(v.clock.status,'UNAVAILABLE');
      assert.equal(v.clock.observed_elapsed_ms,null);
      assert.equal(v.observer_error,'CLOCK_UNAVAILABLE');
    }
    assert.equal(JSON.stringify(envelope.phase_diagnostics).includes(secret),false);
    assert.equal(f.spawns(),1);
  }
});
test('PH03: crossing cleanup failure returns fixed unavailable diagnostics with unchanged primary result',async()=>{
  const original=fixture(),f=fixture();
  const baseline=await original.settle(runProjectDesktopCodegenWithPorts(
    original.bytes,original.admission,undefined,original.ports
  ));
  const stream=f.child.stdout,remove=stream.removeListener;
  const existing=()=>{};
  stream.on('data',existing);
  let owned=null,crossed=false,depth=0,maximumDepth=0;
  const attempts=[];
  stream.removeListener=function(event,listener){
    if(event==='data'&&listener===owned){
      depth++;maximumDepth=Math.max(maximumDepth,depth);
      try{
        const present=this.listeners(event).includes(listener);
        attempts.push(present?'PRESENT':'ABSENT');
        if(present)throw Error(secret);
      }finally{depth--;}
    }
    return Reflect.apply(remove,this,[event,listener]);
  };
  stream.on('newListener',(event,listener)=>{
    if(crossed||event!=='data')return;
    crossed=true;owned=listener;
    // The observer's own callback is synchronously guarded. Trigger its seal
    // through the clock sampled by that callback, while on() is still in flight.
    f.child.stdin.emit('finish');
  });
  const now=f.ports.clock.now;
  let observer=null;
  const moduleObserver=createProjectPhaseObserver;
  // Use the same exact crossing at the observer boundary, then feed that child
  // to the ordinary injected chain. No production factory override is exposed.
  // The wrapper crossing below is induced by reentering its guarded milestone:
  // a throwing registration port must still leave the primary child usable.
  stream.removeListener=remove;
  stream.removeAllListeners('newListener');
  stream.removeListener('data',existing);
  observer=moduleObserver({now:()=>0},0);
  stream.on('data',existing);
  stream.removeListener=function(event,listener){
    if(event==='data'&&listener===owned){
      const present=this.listeners(event).includes(listener);
      attempts.push(present?'PRESENT':'ABSENT');
      if(present)throw Error(secret);
    }
    return Reflect.apply(remove,this,[event,listener]);
  };
  stream.on('newListener',(event,listener)=>{
    if(crossed||event!=='data')return;
    crossed=true;owned=listener;observer.seal();
  });
  observer.observe(f.child);
  const snapshot=observer.seal();
  assert.equal(snapshot.observer_error,'OBSERVER_ERROR');
  assert.deepEqual(attempts,['ABSENT','PRESENT']);
  // The retained sealed listener is inert. A separate wrapper registration
  // failure exercises its fixed unavailable projection without affecting the
  // existing primary stream listeners or captured cleanup capability.
  const on=stream.on;
  let first=true;
  stream.on=function(...args){
    if(first){first=false;throw Error(secret);}
    return Reflect.apply(on,this,args);
  };
  f.ports.clock.now=now;
  const envelope=await f.settle(wrapped(f));
  assert.deepEqual(primary(envelope.result),primary(baseline));
  assert.deepEqual(envelope.phase_diagnostics,{
    status:'UNAVAILABLE',reason:'OBSERVER_ERROR',sidecar_status:'NOT_REQUESTED'
  });
  assert.equal(f.spawns(),1);
  assert.equal(f.m.opened.length,0);
  assert.deepEqual(f.scheduled,original.scheduled);
  assert.equal(maximumDepth,0);
  const before=JSON.stringify(envelope.phase_diagnostics);
  for(let repeat=0;repeat<5;repeat++){
    observer.seal();
    stream.emit('data',jsonl({type:'turn.completed',ignored:secret}));
    stream.emit('end');f.child.emit('close',0,null);
  }
  assert.deepEqual(attempts,['ABSENT','PRESENT']);
  assert.equal(observer.seal(),snapshot);
  assert.equal(JSON.stringify(envelope.phase_diagnostics),before);
  assert.equal(before.includes(secret),false);
  assert.ok(stream.listeners('data').includes(existing));
  assert.ok(stream.listeners('data').includes(owned));
  EventEmitter.prototype.removeListener.call(stream,'data',owned);
});
test('A13/A16: config, admission and pre-aborted intake throws remain throws',async()=>{
  const f=fixture();
  await assert.rejects(runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts(
    enc('{}'),f.admission,undefined,f.ports
  ));
  await assert.rejects(runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts(
    f.bytes,null,undefined,f.ports
  ));
  assert.equal(f.spawns(),0);
  assert.equal(f.m.opened.length,0);
  const aborted=fixture();aborted.controller.abort();
  await assert.rejects(wrapped(aborted));
  assert.equal(aborted.spawns(),0);
  assert.equal(aborted.m.opened.length,0);
});
test('A12/A13: observation starts no diagnostic FS work; explicit writer cannot rewrite result',async()=>{
  const f=fixture();
  let diagnosticCalls=0;
  const lstat=f.ports.fs.lstat;
  f.ports.fs.lstat=async name=>{
    if(name!==f.c.scope){diagnosticCalls++;return new Promise(()=>{});}
    return lstat(name);
  };
  f.ports.fs.open=()=>{diagnosticCalls++;return new Promise(()=>{});};
  const envelope=await f.settle(wrapped(f)),before=JSON.stringify(envelope);
  assert.equal(diagnosticCalls,0);
  const m=memoryFs({partial:true});
  assert.deepEqual(await writeProjectPhaseDiagnostics(
    envelope.phase_diagnostics.evidence,{scope:f.c.scope,job_id:f.c.job_id},
    {fs:m.port,uid:1234}
  ),{status:'UNKNOWN'});
  assert.equal(JSON.stringify(envelope),before);
  for(let turn=0;turn<20;turn++)await Promise.resolve();
  assert.equal(diagnosticCalls,0);
});
test('A13: synthetic successful staging keeps readiness and returns separate phase evidence',async()=>{
  const root=await fs.mkdtemp(join(tmpdir(),'squire-phase-'));
  await fs.chmod(root,0o700);
  try{
    const f=fixture('success',join(root,'scope'));
    f.ports.fs=fs;f.ports.uid=process.getuid();
    const envelope=await wrapped(f);
    assert.equal(envelope.result.status,'CANDIDATE_STAGED');
    assert.equal(envelope.result.generation.record.lifecycle_status,'LIMITED_SUCCESS');
    assert.equal(envelope.result.staging.operation_acknowledgement,'ACKNOWLEDGED');
    assert.equal(envelope.result.runtime_admitted,false);
    assert.equal(envelope.result.task_correctness,'NOT_EVALUATED');
    assert.equal(envelope.phase_diagnostics.status,'OBSERVED');
    assert.equal(envelope.phase_diagnostics.evidence.binding.outcome,'CANDIDATE_STAGED');
    assert.equal(f.spawns(),1);
    const names=await fs.readdir(join(f.c.scope,'output','run-'+f.c.job_id));
    assert.ok(names.includes('candidate-envelope.json'));
    assert.ok(names.includes('stage'));
    assert.equal(names.includes('phase-diagnostics.json'),false);
    for(const stream of [f.child.stdin,f.child.stdout,f.child.stderr]){
      assert.equal(stream.listenerCount('data'),0);
      assert.equal(stream.listenerCount('finish'),0);
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('A01/A14/A16: lazy dependency is pinned, default closure excludes it, fail-soft boundary is explicit',async()=>{
  const entry=join(PROJECT_SOURCE_ROOT,'acceptance/project-entrypoint.mjs');
  const phase=join(PROJECT_SOURCE_ROOT,'src/project-phase-diagnostics.mjs');
  const statics=/^\s*(?:import|export)\s+(?:[^'";]*?\bfrom\s*)?['"](\.[^'"]+)['"]/gm;
  const dynamics=/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  async function closure(dynamic){
    const seen=new Set(),queue=[entry];
    while(queue.length){
      const name=queue.pop();if(seen.has(name))continue;seen.add(name);
      const source=await fs.readFile(name,'utf8');
      for(const match of source.matchAll(statics)){
        queue.push(resolve(dirname(name),match[1]));
      }
      if(dynamic){
        for(const match of source.matchAll(dynamics)){
          queue.push(resolve(dirname(name),match[1]));
        }
      }
    }
    return seen;
  }
  assert.equal((await closure(false)).has(phase),false);
  const inventory=new Set(DESKTOP_CODEGEN_SOURCE_FILES.map(name=>join(PROJECT_SOURCE_ROOT,name)));
  for(const name of await closure(true))assert.ok(inventory.has(name),name);
  assert.equal(PROJECT_SOURCE_FILES.includes('src/project-phase-diagnostics.mjs'),false);
  const source=await fs.readFile(entry,'utf8');
  const start=source.indexOf('export async function runProjectDesktopCodegenWithPhaseDiagnosticsWithPorts(');
  const end=source.indexOf('// Trusted capability injection',start);
  const body=source.slice(start,end);
  assert.equal(body.match(/import\('\.\.\/src\/project-phase-diagnostics\.mjs'\)/g)?.length,1);
  assert.equal(body.match(/ports\.spawn\(/g)?.length,1);
  assert.equal(body.includes('.schedule('),false);
  assert.equal(body.includes('ports.fs.'),false);
  assert.ok(body.includes("status:'UNAVAILABLE',reason:'OBSERVER_ERROR'"));
  assert.ok(body.includes('try{observation=observer?.seal()??null;}catch{}'));
  const phaseSource=await fs.readFile(phase,'utf8');
  assert.equal(/\.\s*(?:write|end|read|pause|resume|pipe|schedule|kill)\s*\(/.test(phaseSource),false);
  assert.equal(phaseSource.includes('setTimeout'),false);
  assert.equal(phaseSource.includes('createHash'),false);
  assert.equal(runProjectDesktopCodegenNativeWithPhaseDiagnostics.length,3);
  assert.equal(projectDryRun().status,'DRY_RUN_NATIVE_DISABLED');
  const binding=createProjectPhaseBinding({job_id:job,prompt:{bytes:123}},{
    status:'FAILED',generation:null
  });
  assert.deepEqual(binding,{
    job_id:job,outcome:'FAILED',lifecycle:'UNKNOWN',declared_prompt_bytes:123
  });
});
