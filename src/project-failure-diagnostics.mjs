// Explicit private observations and a separately awaited trusted writer.
// No raw log, exception text, arbitrary-byte digest or cause verdict is exported.
import {constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {types} from 'node:util';

const OBSERVATION_SCHEMA='SQUIRE_PRIVATE_FAILURE_DIAGNOSTICS_V1';
const EVIDENCE_SCHEMA='SQUIRE_PRIVATE_FAILURE_EVIDENCE_V1';
const CAP=65536;
const patterns=Object.freeze({
  STREAM_DISCONNECTED:'stream disconnected',
  ERROR_SENDING_REQUEST:'error sending request',
  RETRYING:'retrying',
  RECONNECTING:'reconnecting',
  CONNECTION_RESET:'connection reset',
  TIMED_OUT:'timed out',
  UNAUTHORIZED_401:'401 unauthorized',
  FORBIDDEN_403:'403 forbidden',
  TOO_MANY_REQUESTS_429:'429 too many requests',
  RATE_LIMIT:'rate limit',
  QUOTA:'quota',
  CLAMPING_INTERRUPT_HOOK_TIMEOUT:'clamping interrupt hook timeout'
});
const markerKeys=Object.keys(patterns);
const carryLimit=Math.max(...Object.values(patterns).map(value=>value.length))-1;
const lengthOf=Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),'byteLength'
).get;
const observationKeys=[
  'schema','stream','byte_count','byte_count_saturated','scanned_bytes',
  'truncated','eof','completeness','observer_error','markers'
];
const outcomes=Object.freeze([
  'UNKNOWN','CANDIDATE_STAGED','INCOMPLETE','GENERATION_REJECTED',
  'FAILED','STAGING_REJECTED'
]);
const lifecycles=Object.freeze([
  'UNKNOWN','LIMITED_SUCCESS','LIMITED_TIMEOUT','LIMITED_USER_ABORT',
  'LIMITED_SPAWN_FAILED','LIMITED_PROCESS_FAILED','LIMITED_INTERNAL_ERROR',
  'LIMITED_PARSER_ERROR','LIMITED_CAPACITY_EXCEEDED','LIMITED_PERSISTENCE_FAILED'
]);
const uuid=value=>typeof value==='string'&&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

function ownData(target,key){
  if(!target||typeof target!=='object'||types.isProxy(target))throw 0;
  const descriptor=Object.getOwnPropertyDescriptor(target,key);
  if(!descriptor||!Object.hasOwn(descriptor,'value'))throw 0;
  return descriptor.value;
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
function fields(value,keys){
  if(!value||typeof value!=='object'||types.isProxy(value)||
     ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw 0;
  const names=Reflect.ownKeys(value);
  if(names.length!==keys.length||names.some(key=>!keys.includes(key)))throw 0;
  const result=Object.create(null);
  for(const key of keys)result[key]=ownData(value,key);
  return result;
}
function completeness(stream,bytes,eof,truncated,error){
  if(error!=='NONE')return 'OBSERVER_ERROR';
  if(stream==='UNKNOWN')return 'UNKNOWN';
  if(stream==='MISSING')return 'MISSING';
  if(truncated)return 'TRUNCATED';
  if(!eof)return 'PARTIAL';
  return bytes===0?'EMPTY_COMPLETE':'COMPLETE';
}

// The fixed wrapper observes only the returned child's stderr. Callback bodies
// never throw, inspect error messages, decode UTF-8 or alter child settlement.
export function createProjectFailureObserver(){
  let stream='UNKNOWN',bytes=0,saturated=false,scanned=0,truncated=false;
  let eof=false,error='NONE',carry='',sealed=false,snapshot=null;
  let target=null,remove=null;
  const attached=[];
  const markers=Object.fromEntries(markerKeys.map(key=>[key,0]));
  const failed=kind=>{if(error==='NONE')error=kind;carry='';};
  function chunk(input){
    if(sealed)return;
    try{
      if(eof||types.isProxy(input)||!types.isUint8Array(input))throw 0;
      const size=Reflect.apply(lengthOf,input,[]);
      if(size>Number.MAX_SAFE_INTEGER-bytes){
        bytes=Number.MAX_SAFE_INTEGER;saturated=true;
      }else bytes+=size;
      const count=Math.min(size,CAP-scanned);
      if(count<size)truncated=true;
      for(let index=0;index<count;index++){
        const byte=input[index];
        // Non-ASCII bytes, including invalid UTF-8, break literal matching.
        const character=byte<128?String.fromCharCode(
          byte>=65&&byte<=90?byte+32:byte
        ):'\0';
        const window=carry+character;
        for(const key of markerKeys){
          if(window.endsWith(patterns[key]))markers[key]=Math.min(255,markers[key]+1);
        }
        carry=window.slice(-carryLimit);
      }
      scanned+=count;
      // Never join a marker across omitted bytes.
      if(count<size)carry='';
    }catch{failed('OBSERVER_ERROR');}
  }
  const end=()=>{if(!sealed){eof=true;carry='';}};
  const streamError=()=>{if(!sealed)failed('STREAM_ERROR');};
  return Object.freeze({
    observe(child){
      if(sealed||target!==null)return;
      try{
        const stderr=data(child,'stderr');
        if(stderr===null||stderr===undefined){stream='MISSING';return;}
        const on=method(stderr,'on');
        remove=method(stderr,'removeListener');
        target=stderr;stream='PRESENT';
        for(const [event,callback]of [
          ['error',streamError],['end',end],['data',chunk]
        ]){
          attached.push([event,callback]);
          on(event,callback);
        }
      }catch{failed('OBSERVER_ERROR');}
    },
    seal(){
      if(snapshot)return snapshot;
      sealed=true;
      for(const [event,callback]of attached){
        try{remove(event,callback);}catch{failed('OBSERVER_ERROR');}
      }
      attached.length=0;target=null;remove=null;carry='';
      snapshot=Object.freeze({
        schema:OBSERVATION_SCHEMA,stream,byte_count:bytes,
        byte_count_saturated:saturated,scanned_bytes:scanned,truncated,eof,
        completeness:completeness(stream,bytes,eof,truncated,error),
        observer_error:error,markers:Object.freeze({...markers})
      });
      return snapshot;
    }
  });
}

function bindingProjection(value){
  const v=fields(value,['job_id','outcome','lifecycle']);
  if(!uuid(v.job_id)||!outcomes.includes(v.outcome)||
     !lifecycles.includes(v.lifecycle))throw 0;
  return {job_id:v.job_id,outcome:v.outcome,lifecycle:v.lifecycle};
}

// The wrapper supplies its validated config and actual returned primary result.
// Missing or unreadable primary fields remain UNKNOWN; no strings are copied
// from errors or other unselected result fields.
export function createProjectFailureBinding(config,result){
  const job_id=ownData(config,'job_id');
  if(!uuid(job_id))throw 0;
  let outcome='UNKNOWN',lifecycle='UNKNOWN';
  try{
    const value=ownData(result,'status');
    if(outcomes.includes(value))outcome=value;
  }catch{}
  try{
    const generation=ownData(result,'generation');
    if(generation!==null){
      const record=ownData(generation,'record');
      const value=ownData(record,'lifecycle_status');
      if(lifecycles.includes(value))lifecycle=value;
    }
  }catch{}
  return Object.freeze(bindingProjection({job_id,outcome,lifecycle}));
}

// Rebuild closed data before serialization. Caller objects, toJSON hooks,
// accessors and proxies never enter the encoded representation.
function observationProjection(value){
  const v=fields(value,observationKeys),m=fields(v.markers,markerKeys);
  if(v.schema!==OBSERVATION_SCHEMA||
     !['UNKNOWN','MISSING','PRESENT'].includes(v.stream)||
     !Number.isSafeInteger(v.byte_count)||v.byte_count<0||
     !Number.isSafeInteger(v.scanned_bytes)||v.scanned_bytes<0||
     v.scanned_bytes>CAP||v.scanned_bytes>v.byte_count||
     typeof v.byte_count_saturated!=='boolean'||typeof v.truncated!=='boolean'||
     typeof v.eof!=='boolean'||
     !['NONE','OBSERVER_ERROR','STREAM_ERROR'].includes(v.observer_error)||
     v.byte_count_saturated&&v.byte_count!==Number.MAX_SAFE_INTEGER||
     v.completeness!==completeness(
       v.stream,v.byte_count,v.eof,v.truncated,v.observer_error
     ))throw 0;
  if(v.stream!=='PRESENT'&&
     (v.byte_count!==0||v.scanned_bytes!==0||v.eof||v.truncated||
      v.byte_count_saturated))throw 0;
  if(v.observer_error==='NONE'&&v.stream==='PRESENT'&&
     (v.scanned_bytes!==Math.min(CAP,v.byte_count)||
      v.truncated!==(v.byte_count>CAP)))throw 0;
  for(const key of markerKeys){
    if(!Number.isSafeInteger(m[key])||m[key]<0||m[key]>255||
       m[key]>v.scanned_bytes)throw 0;
  }
  return {
    schema:OBSERVATION_SCHEMA,stream:v.stream,byte_count:v.byte_count,
    byte_count_saturated:v.byte_count_saturated,scanned_bytes:v.scanned_bytes,
    truncated:v.truncated,eof:v.eof,completeness:v.completeness,
    observer_error:v.observer_error,
    markers:Object.fromEntries(markerKeys.map(key=>[key,m[key]]))
  };
}
function evidenceProjection(value){
  const v=fields(value,['schema','binding','observation']);
  if(v.schema!==EVIDENCE_SCHEMA)throw 0;
  const binding=bindingProjection(v.binding);
  if(binding.outcome==='CANDIDATE_STAGED')throw 0;
  return {
    schema:EVIDENCE_SCHEMA,binding,
    observation:observationProjection(v.observation)
  };
}
export function createProjectFailureEvidence(binding,observation){
  const projected=evidenceProjection({schema:EVIDENCE_SCHEMA,binding,observation});
  Object.freeze(projected.binding);
  Object.freeze(projected.observation.markers);
  Object.freeze(projected.observation);
  return Object.freeze(projected);
}

function statView(stat){
  const view={};
  for(const key of ['dev','ino','uid','nlink','mode','size','mtimeMs','ctimeMs']){
    view[key]=ownData(stat,key);
  }
  for(const key of ['dev','ino','uid','nlink','mode','size']){
    if(!Number.isSafeInteger(view[key])||view[key]<0)throw 0;
  }
  if(!Number.isFinite(view.mtimeMs)||!Number.isFinite(view.ctimeMs))throw 0;
  for(const [key,name]of [
    ['file','isFile'],['directory','isDirectory'],['symlink','isSymbolicLink']
  ]){
    view[key]=method(stat,name)();
    if(typeof view[key]!=='boolean')throw 0;
  }
  return view;
}
function sameIdentity(a,b){
  return ['dev','ino','uid','nlink','mode'].every(key=>a[key]===b[key]);
}
function sameFile(a,b){
  return sameIdentity(a,b)&&['size','mtimeMs','ctimeMs'].every(key=>a[key]===b[key]);
}
function directory(stat,uid,privateParent){
  const v=statView(stat);
  if(!v.directory||v.file||v.symlink||
     (privateParent?v.uid!==uid:v.uid!==0&&v.uid!==uid)||
     (privateParent?(v.mode&0o7777)!==0o700:(v.mode&0o7022)!==0))throw 0;
  return v;
}
function leaf(stat,uid,size,identity){
  const v=statView(stat);
  if(!v.file||v.directory||v.symlink||v.uid!==uid||v.nlink!==1||
     (v.mode&0o7777)!==0o600||v.size!==size||
     identity&&!sameIdentity(v,identity))throw 0;
  return v;
}
function destination(value){
  const v=fields(value,['scope','job_id']);
  if(typeof v.scope!=='string'||v.scope==='/'||!v.scope.startsWith('/')||
     resolve(v.scope)!==v.scope||v.scope.includes('\0')||!uuid(v.job_id))throw 0;
  return {job_id:v.job_id,directory:join(v.scope,'output','run-'+v.job_id)};
}

// Separate explicit trusted API. The caller must await this under its separately
// accepted remaining external observation window. There is no internal hard FS
// deadline, abort, background dispatch, process dispatch or primary-job extension.
export async function writeProjectFailureDiagnostics(value,run,ports){
  return writeDiagnostics('FAILURE',value,run,ports);
}
// A second literal entrypoint shares the existing private custody mechanics.
// The new projection is loaded only for this explicit kind. Neither entrypoint
// accepts a validator, filename, callback or persistence destination override.
export async function writeProjectPhaseDiagnostics(value,run,ports){
  return writeDiagnostics('PHASE',value,run,ports);
}
async function writeDiagnostics(kind,value,run,ports){
  let handle=null,encoded=null,back=null;
  let possibleMutation=false,status='FAILED';
  try{
    const target=destination(run),p=fields(ports,['fs','uid']);
    if(!Number.isSafeInteger(p.uid)||p.uid<0)throw 0;
    const lstat=method(p.fs,'lstat'),open=method(p.fs,'open');
    let evidence;
    if(kind==='FAILURE')evidence=evidenceProjection(value);
    else{
      const v=fields(value,['schema','binding','observation']);
      if(v.schema!=='SQUIRE_PRIVATE_PHASE_EVIDENCE_V1')throw 0;
      const {createProjectPhaseEvidence}=await import('./project-phase-diagnostics.mjs');
      evidence=createProjectPhaseEvidence(v.binding,v.observation);
    }
    if(evidence.binding.job_id!==target.job_id)throw 0;
    encoded=new TextEncoder().encode(JSON.stringify(evidence)+'\n');
    if(encoded.length>4096)throw 0;
    const paths=[];
    for(let path=target.directory;;path=dirname(path)){
      paths.push(path);if(path==='/')break;
    }
    paths.reverse();
    const ancestors=[];
    for(const path of paths){
      ancestors.push(directory(await lstat(path),p.uid,path===target.directory));
    }
    const recheck=async()=>{
      for(let index=0;index<paths.length;index++){
        const current=directory(
          await lstat(paths[index]),p.uid,paths[index]===target.directory
        );
        if(!sameIdentity(current,ancestors[index]))throw 0;
      }
    };
    const path=join(target.directory,kind==='FAILURE'?
      'failure-diagnostics.json':'phase-diagnostics.json');
    // A rejected open can still leave creation uncertain. Latch before calling
    // or awaiting the trusted port; never infer absence from exception details.
    possibleMutation=true;
    handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|
      constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    const stat=method(handle,'stat'),write=method(handle,'writeFile');
    const read=method(handle,'read');
    const initial=leaf(await stat(),p.uid,0);
    await recheck();
    await write(encoded);
    const before=leaf(await stat(),p.uid,encoded.length,initial);
    back=new Uint8Array(encoded.length+1);
    let offset=0,eof=false;
    // Bound even a hostile short-read port.
    for(let attempts=0;attempts<=4096&&offset<back.length;attempts++){
      const requested=back.length-offset;
      const result=await read(back,offset,requested,offset);
      const count=ownData(result,'bytesRead');
      if(!Number.isSafeInteger(count)||count<0||count>requested)throw 0;
      if(count===0){eof=true;break;}
      offset+=count;
      if(offset>encoded.length)throw 0;
    }
    if(!eof||offset!==encoded.length)throw 0;
    for(let index=0;index<offset;index++){
      if(back[index]!==encoded[index])throw 0;
    }
    const after=leaf(await stat(),p.uid,encoded.length,initial);
    if(!sameFile(before,after))throw 0;
    await recheck();
    if(!sameFile(after,leaf(await lstat(path),p.uid,encoded.length,initial)))throw 0;
    if(!sameFile(after,leaf(await stat(),p.uid,encoded.length,initial)))throw 0;
    const close=method(handle,'close');
    // Attempt close once. A throwing close leaves custody uncertain.
    handle=null;
    await close();
    await recheck();
    if(!sameFile(after,leaf(await lstat(path),p.uid,encoded.length,initial)))throw 0;
    status='RECORDED';
  }catch{
    status=possibleMutation?'UNKNOWN':'FAILED';
  }finally{
    if(handle!==null){
      try{await method(handle,'close')();}catch{status='UNKNOWN';}
    }
    encoded?.fill(0);back?.fill(0);
  }
  return Object.freeze({status});
}
