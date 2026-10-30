// Explicit private phase observations. No dispatch, scheduling, filesystem I/O,
// input interception, raw logs, exception text or provider-attestation claims.
import {types} from 'node:util';
import {parseProjectJson} from './project-task.mjs';
import {createProjectFailureBinding} from './project-failure-diagnostics.mjs';
export {writeProjectPhaseDiagnostics} from './project-failure-diagnostics.mjs';

const SCHEMA='SQUIRE_PRIVATE_PHASE_EVIDENCE_V1';
// These byte counters match the current project collector. The JSONL scanner,
// line buffer and parse-attempt limits are separate diagnostic bounds.
const OUT_CAP=1048576,ERR_CAP=65536,SCAN_CAP=1048576,LINE_CAP=65536;
const FRAME_CAP=256;
const lengthOf=Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),'byteLength'
).get;
const milestones=Object.freeze([
  'spawn_attempt_beforeports_spawn','spawn_returned','child_spawn_event',
  'stdin_drain_event','stdin_finish_event','stdin_close_event','stdin_error_event',
  'first_stdout_data','last_stdout_data','stdout_end','stdout_close','stdout_error',
  'first_stderr_data','last_stderr_data','stderr_end','stderr_close','stderr_error',
  'child_exit_event','child_close_event','child_error_event',
  'primary_result_returned','sealed'
]);
const kinds=Object.freeze([
  'THREAD_STARTED','TURN_STARTED','ITEM_STARTED','ITEM_UPDATED',
  'AGENT_MESSAGE_COMPLETED','OTHER_ITEM_COMPLETED','TURN_COMPLETED',
  'TURN_FAILED','ERROR','OTHER'
]);
const qualityKeys=Object.freeze([
  'scanned_bytes','complete_frames_seen','frames_parsed','malformed_frames',
  'oversized_line_skipped','event_parse_cap_reached','scan_truncated',
  'event_counts_overflow','terminal_seen','terminal_conflict'
]);
const usageKeys=Object.freeze(['availability','input','output','cache_read','reasoning']);
const counterKeys=Object.freeze(['input','output','cache_read','reasoning']);
const available=Object.freeze(['UNKNOWN','MISSING','PRESENT']);
const observerErrors=Object.freeze([
  'NONE','CLOCK_UNAVAILABLE','CLOCK_REGRESSED','OBSERVER_ERROR'
]);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const time=value=>value===null||integer(value);

function ownData(target,key){
  if(!target||typeof target!=='object'||types.isProxy(target))throw 0;
  const descriptor=Object.getOwnPropertyDescriptor(target,key);
  if(!descriptor||!Object.hasOwn(descriptor,'value'))throw 0;
  return descriptor.value;
}
function fields(value,keys){
  if(!value||typeof value!=='object'||types.isProxy(value)||
     ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw 0;
  const names=Reflect.ownKeys(value);
  if(names.length!==keys.length||names.some(key=>!keys.includes(key)))throw 0;
  return Object.fromEntries(keys.map(key=>[key,ownData(value,key)]));
}
function data(target,key){
  if(!target||typeof target!=='object'&&typeof target!=='function'||
     types.isProxy(target))throw 0;
  let current=target;
  for(let depth=0;current!==null&&depth<32;depth++){
    if(types.isProxy(current))throw 0;
    const descriptor=Object.getOwnPropertyDescriptor(current,key);
    if(descriptor){
      if(!Object.hasOwn(descriptor,'value'))throw 0;
      return descriptor.value;
    }
    current=Object.getPrototypeOf(current);
  }
  throw 0;
}
function method(target,key){
  const value=data(target,key);
  if(typeof value!=='function'||types.isProxy(value))throw 0;
  return (...args)=>Reflect.apply(value,target,args);
}
function freeze(value){
  for(const item of Object.values(value)){
    if(item!==null&&typeof item==='object')freeze(item);
  }
  return Object.freeze(value);
}
function unknownUsage(availability='NOT_OBSERVED'){
  return {availability,input:'UNKNOWN',output:'UNKNOWN',
    cache_read:'UNKNOWN',reasoning:'UNKNOWN'};
}

// Establish counters from lexical evidence, never rounded Number conversion.
// Accept canonical nonnegative integer tokens through MAX_SAFE_INTEGER, plus
// syntactically valid zero tokens whose mantissa contains only zero digits.
// Conservatively map every other valid numeric token to a negative sentinel.
// Nonzero decimal/exponent notation is therefore INVALID even if mathematically
// integral. Zero exponents require no exponent evaluation or allocation.
// Preserve parseProjectJson's UTF-8, grammar, duplicate-key and structure checks.
// Quoted strings are unchanged; malformed whole numeric tokens remain unchanged
// so normalization cannot repair them into valid JSON.
function parseFrame(bytes){
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  const pieces=[];
  for(let index=0;index<text.length;){
    const start=index,character=text[index];
    if(character==='"'){
      index++;
      while(index<text.length){
        if(text[index]==='\\'){index+=2;continue;}
        if(text[index++]==='"')break;
      }
      pieces.push(text.slice(start,index));
    }else if(character==='-'||character>='0'&&character<='9'){
      while(index<text.length&&!/[\x20\t\r\n,\]}]/.test(text[index]))index++;
      const token=text.slice(start,index);
      const numeric=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(token);
      if(!numeric)pieces.push(token);
      else{
        const zero=/^-?0(?:\.0+)?(?:[eE][+-]?[0-9]+)?$/.test(token);
        const canonical=/^(?:0|[1-9][0-9]*)$/.test(token);
        const safe=canonical&&(token.length<16||
          token.length===16&&token<='9007199254740991');
        pieces.push(zero?'0':safe?token:'-1');
      }
    }else{
      pieces.push(character);index++;
    }
  }
  const normalized=new TextEncoder().encode(pieces.join(''));
  try{return parseProjectJson(normalized,LINE_CAP);}
  finally{normalized.fill(0);}
}
function eventKind(event){
  if(!event||typeof event!=='object'||Array.isArray(event))return 'OTHER';
  switch(event.type){
    case 'thread.started':return 'THREAD_STARTED';
    case 'turn.started':return 'TURN_STARTED';
    case 'item.started':return 'ITEM_STARTED';
    case 'item.updated':return 'ITEM_UPDATED';
    case 'item.completed':
      return event.item&&typeof event.item==='object'&&
        !Array.isArray(event.item)&&event.item.type==='agent_message'?
        'AGENT_MESSAGE_COMPLETED':'OTHER_ITEM_COMPLETED';
    case 'turn.completed':return 'TURN_COMPLETED';
    case 'turn.failed':return 'TURN_FAILED';
    case 'error':return 'ERROR';
    default:return 'OTHER';
  }
}
function terminalUsage(event){
  if(!Object.hasOwn(event,'usage'))return unknownUsage();
  const source=event.usage;
  if(!source||typeof source!=='object'||Array.isArray(source)){
    return unknownUsage('INVALID');
  }
  const result=unknownUsage('VALID');
  for(const [key,sourceKey]of [
    ['input','input_tokens'],['output','output_tokens'],
    ['cache_read','cached_input_tokens'],['reasoning','reasoning_output_tokens']
  ]){
    if(!Object.hasOwn(source,sourceKey))continue;
    if(integer(source[sourceKey]))result[key]=source[sourceKey];
    else result.availability='INVALID';
  }
  return result;
}

// origin is captured synchronously by the opt-in wrapper, before its first
// await. The trusted clock is sampled only; schedule is never obtained or used.
export function createProjectPhaseObserver(clock,origin){
  let clockStatus=integer(origin)?'OK':'UNAVAILABLE',last=origin;
  let observerError=clockStatus==='OK'?'NONE':'CLOCK_UNAVAILABLE';
  let readNow=null,sealed=false,observed=false,snapshot=null,registrations=0;
  let line=new Uint8Array(LINE_CAP),used=0,discard=false,pendingLine=false;
  let attempts=0,terminals=0;
  let usage=unknownUsage();
  const attached=[];
  const marks=Object.fromEntries(milestones.map(key=>[
    key,{observed:false,elapsed_ms:null}
  ]));
  const streams={
    stdin:{availability:'UNKNOWN'},
    stdout:{availability:'UNKNOWN',bytes:0,eof:false,close:false,error:false},
    stderr:{availability:'UNKNOWN',bytes:0,eof:false,close:false,error:false}
  };
  const counts=Object.fromEntries(kinds.map(key=>[key,0]));
  const quality={
    scanned_bytes:0,complete_frames_seen:0,frames_parsed:0,malformed_frames:0,
    oversized_line_skipped:false,event_parse_cap_reached:false,
    scan_truncated:false,event_counts_overflow:false,
    terminal_seen:false,terminal_conflict:false
  };
  const failed=()=>{if(!snapshot)observerError='OBSERVER_ERROR';};
  try{readNow=method(clock,'now');}catch{clockStatus='UNAVAILABLE';failed();}
  function elapsed(){
    if(clockStatus!=='OK')return null;
    try{
      const value=readNow();
      if(!integer(value))throw 0;
      if(value<last){
        clockStatus='REGRESSED';
        if(observerError==='NONE')observerError='CLOCK_REGRESSED';
        return null;
      }
      last=value;
      return value-origin;
    }catch{
      clockStatus='UNAVAILABLE';
      if(observerError==='NONE')observerError='CLOCK_UNAVAILABLE';
      return null;
    }
  }
  function mark(key,replace=false){
    if(!replace&&marks[key].observed)return;
    marks[key]={observed:true,elapsed_ms:elapsed()};
  }
  function guarded(callback){
    return (...args)=>{
      if(sealed)return;
      try{callback(...args);}catch{failed();}
    };
  }
  function attach(target,event,callback){
    if(sealed)return;
    const on=method(target,'on'),remove=method(target,'removeListener');
    const listener=guarded(callback);
    // Record before registration: even a throwing/reentrant trusted method
    // cannot cause the observer to remove another component's listener.
    attached.push({remove,event,listener});
    registrations++;
    try{on(event,listener);}
    finally{
      // EventEmitter emits newListener before installing this listener. A seal
      // during that notification cannot remove the not-yet-installed listener;
      // remove our exact listener again after registration crosses the seal.
      // Such a seal already records OBSERVER_ERROR: this best-effort removal
      // may fail after the immutable snapshot has been published.
      if(sealed){
        try{remove(event,listener);}catch{failed();}
      }
      registrations--;
    }
  }
  function frame(){
    quality.complete_frames_seen=Math.min(SCAN_CAP,quality.complete_frames_seen+1);
    if(discard)return;
    if(attempts===FRAME_CAP){quality.event_parse_cap_reached=true;return;}
    attempts++;
    if(attempts===FRAME_CAP)quality.event_parse_cap_reached=true;
    let event;
    try{event=parseFrame(line.subarray(0,used));}
    catch{quality.malformed_frames++;return;}
    quality.frames_parsed++;
    const kind=eventKind(event);
    if(counts[kind]===255)quality.event_counts_overflow=true;
    else counts[kind]++;
    if(kind==='TURN_COMPLETED'||kind==='TURN_FAILED'){
      terminals++;
      quality.terminal_seen=true;
      if(terminals>1){
        quality.terminal_conflict=true;
        usage=unknownUsage('AMBIGUOUS');
      }else if(kind==='TURN_COMPLETED')usage=terminalUsage(event);
    }
  }
  function clearLine(){
    if(used!==0)line.fill(0,0,used);
    used=0;discard=false;pendingLine=false;
  }
  function outputChunk(name,input){
    const stream=streams[name];
    if(stream.eof||types.isProxy(input)||!types.isUint8Array(input))throw 0;
    const size=Reflect.apply(lengthOf,input,[]);
    const cap=name==='stdout'?OUT_CAP:ERR_CAP;
    stream.bytes=Math.min(cap+1,stream.bytes+size);
    mark('first_'+name+'_data');
    mark('last_'+name+'_data',true);
    if(name!=='stdout')return;
    const count=Math.min(size,SCAN_CAP-quality.scanned_bytes);
    for(let index=0;index<count;index++){
      const byte=input[index];
      if(byte===10){
        frame();
        if(pendingLine||discard||used!==0)clearLine();
      }else{
        // Continue bounded LF/EOF frame accounting after the parse cap, but
        // retain no further line bytes and perform no further parsing.
        pendingLine=true;
        if(attempts<FRAME_CAP&&!discard){
          if(used===LINE_CAP){
            quality.oversized_line_skipped=true;
            line.fill(0,0,used);used=0;discard=true;
          }else line[used++]=byte;
        }
      }
    }
    quality.scanned_bytes+=count;
    if(count<size){
      quality.scan_truncated=true;
      // Omitted bytes may contain LF. Never join through the omitted suffix,
      // nor parse this partial line as an EOF-terminated complete frame.
      clearLine();
    }
  }
  function outputEnd(name){
    const stream=streams[name];
    if(stream.eof)return;
    stream.eof=true;mark(name+'_end');
    if(name==='stdout'){
      if(!quality.scan_truncated&&pendingLine)frame();
      clearLine();
    }
  }
  function observeStream(child,name){
    if(sealed)return;
    try{
      const stream=data(child,name);
      if(stream===null||stream===undefined){
        streams[name].availability='MISSING';return;
      }
      streams[name].availability='PRESENT';
      if(name==='stdin'){
        for(const event of ['drain','finish','close','error']){
          if(sealed)break;
          attach(stream,event,()=>mark('stdin_'+event+'_event'));
        }
      }else{
        attach(stream,'data',input=>outputChunk(name,input));
        if(sealed)return;
        attach(stream,'end',()=>outputEnd(name));
        if(sealed)return;
        attach(stream,'close',()=>{
          streams[name].close=true;mark(name+'_close');
        });
        if(sealed)return;
        attach(stream,'error',()=>{
          streams[name].error=true;mark(name+'_error');
        });
      }
    }catch{failed();}
  }
  return Object.freeze({
    spawnAttempt(){
      if(sealed)return;
      try{mark('spawn_attempt_beforeports_spawn');}catch{failed();}
    },
    observe(child){
      if(sealed||observed)return;
      observed=true;
      try{mark('spawn_returned');}catch{failed();}
      try{
        for(const [event,key]of [
          ['spawn','child_spawn_event'],['exit','child_exit_event'],
          ['close','child_close_event'],['error','child_error_event']
        ]){
          if(sealed)break;
          attach(child,event,()=>mark(key));
        }
      }catch{failed();}
      for(const name of ['stdin','stdout','stderr']){
        if(sealed)break;
        observeStream(child,name);
      }
    },
    primaryResultReturned(){
      if(sealed)return;
      try{mark('primary_result_returned');}catch{failed();}
    },
    seal(){
      // Recursive sealing during removal has no completed snapshot yet. Do
      // not restart cleanup, sample the clock again or touch the line buffer.
      if(sealed)return snapshot;
      sealed=true;
      // An in-flight on() can install a listener after cleanup and snapshot
      // construction. Conservatively record uncertainty before freezing,
      // regardless of whether its later exact-listener removal succeeds.
      if(registrations!==0)failed();
      try{mark('sealed');}catch{failed();}
      for(const {remove,event,listener}of attached){
        try{remove(event,listener);}catch{failed();}
      }
      attached.length=0;
      clearLine();line=null;readNow=null;
      snapshot=freeze({
        clock:{
          origin:'WRAPPER_ENTRY',status:clockStatus,
          observed_elapsed_ms:clockStatus==='OK'?marks.sealed.elapsed_ms:null
        },
        observer_error:observerError,milestones:marks,streams,
        stdout_event_counts:counts,stdout_frame_quality:quality,
        terminal_usage:usage
      });
      return snapshot;
    }
  });
}

function bindingProjection(value){
  const v=fields(value,['job_id','outcome','lifecycle','declared_prompt_bytes']);
  const binding=createProjectFailureBinding({job_id:v.job_id},{
    status:v.outcome,generation:{record:{lifecycle_status:v.lifecycle}}
  });
  if(binding.outcome!==v.outcome||binding.lifecycle!==v.lifecycle||
     !integer(v.declared_prompt_bytes)||v.declared_prompt_bytes>32768)throw 0;
  return {...binding,declared_prompt_bytes:v.declared_prompt_bytes};
}
export function createProjectPhaseBinding(config,result){
  const binding=createProjectFailureBinding(config,result);
  const prompt=ownData(config,'prompt'),bytes=ownData(prompt,'bytes');
  return freeze(bindingProjection({...binding,declared_prompt_bytes:bytes}));
}
function observationProjection(value){
  const v=fields(value,[
    'clock','observer_error','milestones','streams','stdout_event_counts',
    'stdout_frame_quality','terminal_usage'
  ]);
  const clock=fields(v.clock,['origin','status','observed_elapsed_ms']);
  if(clock.origin!=='WRAPPER_ENTRY'||
     !['OK','UNAVAILABLE','REGRESSED'].includes(clock.status)||
     !time(clock.observed_elapsed_ms)||
     clock.status!=='OK'&&clock.observed_elapsed_ms!==null||
     !observerErrors.includes(v.observer_error))throw 0;
  const sourceMarks=fields(v.milestones,milestones),marks={};
  for(const key of milestones){
    const item=fields(sourceMarks[key],['observed','elapsed_ms']);
    if(typeof item.observed!=='boolean'||!time(item.elapsed_ms)||
       !item.observed&&item.elapsed_ms!==null||
       clock.observed_elapsed_ms!==null&&item.elapsed_ms!==null&&
         item.elapsed_ms>clock.observed_elapsed_ms)throw 0;
    marks[key]=item;
  }
  if(!marks.sealed.observed||
     clock.status==='OK'&&marks.sealed.elapsed_ms!==clock.observed_elapsed_ms)throw 0;
  const sourceStreams=fields(v.streams,['stdin','stdout','stderr']);
  const stdin=fields(sourceStreams.stdin,['availability']);
  if(!available.includes(stdin.availability))throw 0;
  const streams={stdin};
  for(const name of ['stdout','stderr']){
    const stream=fields(sourceStreams[name],['availability','bytes','eof','close','error']);
    if(!available.includes(stream.availability)||!integer(stream.bytes)||
       stream.bytes>(name==='stdout'?OUT_CAP:ERR_CAP)+1||
       ['eof','close','error'].some(key=>typeof stream[key]!=='boolean')||
       stream.availability!=='PRESENT'&&
         (stream.bytes!==0||stream.eof||stream.close||stream.error)||
       stream.eof!==marks[name+'_end'].observed||
       stream.close!==marks[name+'_close'].observed||
       stream.error!==marks[name+'_error'].observed)throw 0;
    streams[name]=stream;
  }
  if(stdin.availability!=='PRESENT'&&
     ['drain','finish','close','error'].some(
       event=>marks['stdin_'+event+'_event'].observed
     ))throw 0;
  const counts=fields(v.stdout_event_counts,kinds);
  for(const key of kinds){
    if(!integer(counts[key])||counts[key]>255)throw 0;
  }
  const quality=fields(v.stdout_frame_quality,qualityKeys);
  for(const key of ['scanned_bytes','complete_frames_seen','frames_parsed','malformed_frames']){
    if(!integer(quality[key]))throw 0;
  }
  for(const key of qualityKeys.slice(4)){
    if(typeof quality[key]!=='boolean')throw 0;
  }
  const counted=Object.values(counts).reduce((sum,count)=>sum+count,0);
  const terminalCount=counts.TURN_COMPLETED+counts.TURN_FAILED;
  if(quality.scanned_bytes>SCAN_CAP||
     quality.scanned_bytes>streams.stdout.bytes||
     quality.complete_frames_seen>SCAN_CAP||
     quality.frames_parsed+quality.malformed_frames>FRAME_CAP||
     quality.frames_parsed+quality.malformed_frames>quality.complete_frames_seen||
     counted>quality.frames_parsed||
     quality.event_counts_overflow!==(counted<quality.frames_parsed)||
     quality.terminal_seen!==(terminalCount>0)||
     quality.terminal_conflict!==(terminalCount>1)||
     quality.scan_truncated&&quality.scanned_bytes!==SCAN_CAP||
     quality.event_parse_cap_reached!==
       (quality.frames_parsed+quality.malformed_frames===FRAME_CAP))throw 0;
  const usage=fields(v.terminal_usage,usageKeys);
  if(!['NOT_OBSERVED','VALID','INVALID','AMBIGUOUS'].includes(usage.availability)||
     (usage.availability==='AMBIGUOUS')!==quality.terminal_conflict||
     !quality.terminal_seen&&usage.availability!=='NOT_OBSERVED')throw 0;
  for(const key of counterKeys){
    if(usage[key]!=='UNKNOWN'&&!integer(usage[key]))throw 0;
    if(['NOT_OBSERVED','AMBIGUOUS'].includes(usage.availability)&&
       usage[key]!=='UNKNOWN')throw 0;
  }
  return {clock,observer_error:v.observer_error,milestones:marks,streams,
    stdout_event_counts:counts,stdout_frame_quality:quality,terminal_usage:usage};
}

// Rebuild every level; no caller object, accessor, proxy, toJSON hook, unknown
// key, event string or payload reference enters the returned evidence.
export function createProjectPhaseEvidence(binding,observation){
  return freeze({
    schema:SCHEMA,binding:bindingProjection(binding),
    observation:observationProjection(observation)
  });
}
