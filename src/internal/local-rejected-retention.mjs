import {types} from 'node:util';
// Explicit filesystem ports only. Raw data, paths and digests never leave this adapter.
import {join,dirname,parse} from 'node:path';
import {createHash} from 'node:crypto';
import {ownData} from './rejected-capture.mjs';
const byteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
const TTL=86400000, MAX=65536, SLOTS=5, META=1024;
const fences=new Set();
const sha=b=>createHash('sha256').update(b).digest('hex');
const fixed=(status,error=null)=>Object.freeze({retention_status:status,retention_error:error});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export function createLocalRejectedRetention({fs,root,uid,now,randomUUID,job_id}){
 if(typeof root!=='string'||!root.startsWith('/')||!Number.isSafeInteger(uid)||uid<0||!uuid(job_id))throw Error('RETENTION_PRIVATE_ROOT_UNAVAILABLE');
 const positive=new Map();
 const check=s=>{if(s?.aborted)throw Error('RETENTION_ABORTED');};
 const read=async(p,limit,signal)=>{
  check(signal);const st=await fs.lstat(p);check(signal);
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==uid||(st.mode&0o777)!==0o600||st.size>limit)throw Error('RETENTION_PRIVATE_ROOT_UNAVAILABLE');
  const handle=await fs.open(p,'r');let bytes;
  try{check(signal);bytes=new Uint8Array(limit+1);const {bytesRead}=await handle.read(bytes,0,limit+1,0);check(signal);if(bytesRead>limit)throw Error('RETENTION_IO_FAILED');return {bytes:bytes.slice(0,bytesRead),st};}
  finally{bytes?.fill(0);await handle.close();}
 };
 const meta=async(p,signal)=>{const r=await read(p,META,signal);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.bytes));}finally{r.bytes.fill(0);}};
 const write=async(p,value,signal,onOpened)=>{
  const bytes=new TextEncoder().encode(JSON.stringify(value));if(bytes.length>META)throw Error('RETENTION_IO_FAILED');check(signal);
  const h=await fs.open(p,'wx',0o600);onOpened?.();try{check(signal);await h.writeFile(bytes);check(signal);}finally{await h.close();bytes.fill(0);}
 };
 const directory=async(p,exact=false)=>{const s=await fs.lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||![0,uid].includes(s.uid)||(s.mode&0o022)!==0||exact&&(s.uid!==uid||(s.mode&0o777)!==0o700))throw Error('RETENTION_PRIVATE_ROOT_UNAVAILABLE');};
 async function directories(signal){
  const parent=dirname(root);if(parent===parse(parent).root)throw Error('RETENTION_PRIVATE_ROOT_UNAVAILABLE');
  const ancestors=[];for(let p=dirname(parent);;p=dirname(p)){ancestors.unshift(p);if(p===parse(p).root)break;}
  for(const p of ancestors){check(signal);await directory(p);check(signal);}
  check(signal);try{await fs.mkdir(parent,{mode:0o700});}catch(e){if(e?.code!=='EEXIST')throw e;}
  check(signal);await directory(parent);check(signal);
  for(const p of [root,...Array.from({length:SLOTS},(_,i)=>join(root,'slot-'+i))]){
   check(signal);try{await fs.mkdir(p,{mode:0o700});}catch(e){if(e?.code!=='EEXIST')throw e;}
   check(signal);await directory(p,true);check(signal);
  }
 }
 async function names(slot){
  const d=await fs.opendir(slot),values=[];try{for(;;){const e=await d.read();if(e===null)break;values.push(e.name);if(values.length>6)throw Error('RETENTION_IO_FAILED');}}finally{await d.close();}return values;
 }
 async function inspect(index,signal){
  check(signal);const slot=join(root,'slot-'+index);await directory(slot,true);const entries=await names(slot);check(signal);
  if(entries.length===0)return {available:true,slot};
  if(!entries.includes('claim.json')||entries.includes('cleanup.json')||entries.includes('uncertain.json'))throw Error('RETENTION_IO_FAILED');
  const c=await meta(join(slot,'claim.json'),signal);
  if(Object.keys(c).sort().join()!=='created_ms,job_id,token,version'||c.version!==1||!uuid(c.token)||!uuid(c.job_id)||!Number.isSafeInteger(c.created_ms)||c.created_ms<0)throw Error('RETENTION_IO_FAILED');
  const allowed=new Set(['claim.json','state.json','rejected-payload.bin','.stage-'+c.token]);
  if(entries.some(x=>!allowed.has(x)))throw Error('RETENTION_IO_FAILED');
  const rawStats=[];for(const name of ['.stage-'+c.token,'rejected-payload.bin'])if(entries.includes(name)){
   const st=await fs.lstat(join(slot,name));check(signal);
   if(!st.isFile()||st.isSymbolicLink()||st.uid!==uid||(st.mode&0o777)!==0o600||!Number.isSafeInteger(st.size)||st.size<0||st.size>MAX)throw Error('RETENTION_IO_FAILED');rawStats.push(st);
  }
  if(rawStats.length===2&&(rawStats[0].ino!==rawStats[1].ino||rawStats[0].dev!==rawStats[1].dev))throw Error('RETENTION_IO_FAILED');
  // Active or uncertain state never becomes reclaimable through time alone.
  if(!entries.includes('state.json'))return {available:false,slot};
  const state=await meta(join(slot,'state.json'),signal);
  if(Object.keys(state).sort().join()!=='settlement,token,version'||state.version!==1||state.token!==c.token||!['SETTLED','UNKNOWN'].includes(state.settlement))throw Error('RETENTION_IO_FAILED');
  if(state.settlement!=='SETTLED'||positive.get(slot)?.token!==c.token)return {available:false,slot};
  if(entries.includes('.stage-'+c.token)||!entries.includes('rejected-payload.bin'))throw Error('RETENTION_IO_FAILED');
  const observed=positive.get(slot);
  const qualified=()=>{check(signal);if(fences.has(root)||positive.get(slot)!==observed||observed.signal.aborted)throw Error('RETENTION_IO_FAILED');};
  qualified();const p=await read(join(slot,'rejected-payload.bin'),MAX,signal);p.bytes.fill(0);qualified();
  const time=now();if(!Number.isSafeInteger(time)||time<c.created_ms)throw Error('RETENTION_IO_FAILED');
  if(time-c.created_ms<TTL)return {available:false,slot};
  // A tombstone fences interrupted cleanup. No automatic recovery or uncertain eviction.
  await write(join(slot,'cleanup.json'),{version:1,token:c.token},signal);qualified();
  try{for(const name of ['rejected-payload.bin','state.json','claim.json','cleanup.json']){qualified();await fs.unlink(join(slot,name));qualified();}}
  catch{fences.add(root);throw Error('RETENTION_IO_FAILED');}
  observed.signal.removeEventListener('abort',observed.abort);positive.delete(slot);
  return {available:true,slot};
 }
 async function prepare(signal){
  try{
   check(signal);if(fences.has(root))throw Error('RETENTION_IO_FAILED');await directories(signal);check(signal);
   let available=0;for(let i=0;i<SLOTS;i++)if((await inspect(i,signal)).available)available++;
   check(signal);if(fences.has(root))throw Error('RETENTION_IO_FAILED');
   return Object.freeze({capability_status:available?'READY':'CAPACITY_EXCEEDED',available_slots:available});
  }catch{fences.add(root);return Object.freeze({capability_status:'UNAVAILABLE',available_slots:0});}
 }
 async function retainRejected(capture,signal){
  let slot=null,stage=null,handle=null,claimed=false,ownedStage=false,bytes=null,token=null;
  try{
   check(signal);if(fences.has(root))throw Error('RETENTION_IO_FAILED');await directories(signal);check(signal);
   // These are internally minted captures; own-data reads still reject hostile injected ports.
   const input=ownData(capture,'response_bytes'),length=ownData(capture,'exact_response_bytes');
   if(!types.isUint8Array(input)||!Number.isSafeInteger(length)||length<0||length>1048576||Reflect.apply(byteLength,input,[])!==Math.min(length,MAX))throw Error('RETENTION_IO_FAILED');
   bytes=new Uint8Array(Math.min(length,MAX));Uint8Array.prototype.set.call(bytes,input);
   for(let i=0;i<SLOTS;i++){
    const s=await inspect(i,signal);if(!s.available)continue;
    token=randomUUID();if(!uuid(token))throw Error('RETENTION_IO_FAILED');
    const time=now();if(!Number.isSafeInteger(time)||time<0)throw Error('RETENTION_IO_FAILED');
    try{await write(join(s.slot,'claim.json'),{version:1,token,job_id,created_ms:time},signal,()=>{slot=s.slot;claimed=true;});break;}
    catch(e){if(claimed||e?.code!=='EEXIST')throw e;}
   }
   if(!claimed)return fixed('FAILED','RETENTION_CAPACITY_EXCEEDED');
   stage=join(slot,'.stage-'+token);check(signal);handle=await fs.open(stage,'wx',0o600);ownedStage=true;check(signal);
   await handle.writeFile(bytes);check(signal);await handle.close();handle=null;check(signal);
   const readback=await read(stage,MAX,signal);try{if(readback.bytes.length!==bytes.length||sha(readback.bytes)!==sha(bytes))throw Error('RETENTION_IO_FAILED');}finally{readback.bytes.fill(0);}
   check(signal);await fs.link(stage,join(slot,'rejected-payload.bin'));check(signal);
   await fs.unlink(stage);stage=null;ownedStage=false;check(signal);
   await write(join(slot,'state.json'),{version:1,token,settlement:'SETTLED'},signal);check(signal);
   const abort=()=>{positive.delete(slot);fences.add(root);};
   signal.addEventListener('abort',abort,{once:true});check(signal);
   positive.set(slot,{signal,abort,token});
   return fixed('PUBLISHED');
  }catch{
   if(claimed){
    positive.delete(slot);fences.add(root);
    // No destination deletion, replacement, recovery or release after uncertainty.
    if(handle)try{await handle.close();handle=null;}catch{}
    if(stage&&ownedStage)try{await fs.unlink(stage);ownedStage=false;}catch{}
    try{await write(join(slot,'uncertain.json'),{version:1,token,settlement:'UNKNOWN'},null);}catch{}
    return fixed('UNKNOWN',signal?.aborted?'RETENTION_TIMEOUT_OR_ABORTED':'RETENTION_IO_FAILED');
   }
   return fixed(signal?.aborted?'UNKNOWN':'FAILED',signal?.aborted?'RETENTION_TIMEOUT_OR_ABORTED':'RETENTION_IO_FAILED');
  }finally{if(handle)try{await handle.close();}catch{}bytes?.fill(0);}
 }
 return Object.freeze({prepare,retainRejected});
}
