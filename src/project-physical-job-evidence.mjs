// Private evidence for one opted-in, bounded PROJECT_CODEGEN_V1 physical attempt.
// A readable bundle proves copy integrity, never that its original caller received an ACK.
import {constants} from 'node:fs';
import * as nativeFs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,join,parse,resolve} from 'node:path';
import {types} from 'node:util';
import {canonicalBytes,hash} from './bounded-codegen-plan.mjs';
import {createProjectResultReceipt,writeProjectResultReceipt} from './project-result-receipt.mjs';

const SCHEMA='SQUIRE_PROJECT_PHYSICAL_JOB_EVIDENCE_V1';
const OUT=1048576,ERR=65536,RECEIPT=262144,MANIFEST=16384,ATTEMPT=1572864;
const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const FILES=new Set(['stdout.bin','stderr.bin','result.json','manifest.json']);
class EvidenceError extends Error{constructor(code){super(code);this.name='ProjectPhysicalEvidenceError';this.code=code;delete this.stack;}}
const fail=code=>{throw new EvidenceError(code);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&!types.isProxy(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}
function fields(value,required,optional=[]){if(!plain(value)||Reflect.ownKeys(value).some(k=>typeof k!=='string'||![...required,...optional].includes(k))||required.some(k=>!Object.hasOwn(value,k)))fail('INVALID_EVIDENCE_SPEC');const out={};for(const k of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,k);if(!d||!Object.hasOwn(d,'value'))fail('INVALID_EVIDENCE_SPEC');out[k]=d.value;}return out;}
function absolute(path){return typeof path==='string'&&path.length>1&&path.length<=4096&&path.startsWith('/')&&resolve(path)===path&&path!==parse(path).root&&!/[\\\u0000-\u001f\u007f]/u.test(path);}
function statView(s){return s&&typeof s.isFile==='function'&&typeof s.isDirectory==='function'&&typeof s.isSymbolicLink==='function'&&Number.isSafeInteger(s.dev)&&Number.isSafeInteger(s.ino)&&Number.isSafeInteger(s.uid)&&Number.isSafeInteger(s.mode)&&Number.isSafeInteger(s.nlink)&&Number.isSafeInteger(s.size)?s:null;}
const isDir=s=>!!statView(s)&&s.isDirectory()&&!s.isSymbolicLink();
const isFile=s=>!!statView(s)&&s.isFile()&&!s.isSymbolicLink();
function same(a,b){return a&&b&&['dev','ino','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);}
async function lstat(fs,path){try{return statView(await fs.lstat(path));}catch{fail('EVIDENCE_IO_UNKNOWN');}}
async function ancestors(fs,path,uid){let cur=parse(path).root;const parts=dirname(path).slice(cur.length).split('/').filter(Boolean);for(const p of [cur,...parts.map(x=>{cur=join(cur,x);return cur;})]){const s=await lstat(fs,p);if(!isDir(s)||!((s.uid===uid||s.uid===0)&&(s.mode&0o022)===0||s.uid===0&&(s.mode&0o1000)===0o1000))fail('EVIDENCE_CUSTODY_REJECTED');}}
async function ownedDir(fs,path,uid){const s=await lstat(fs,path);if(!isDir(s)||s.uid!==uid||(s.mode&0o7777)!==0o700)fail('EVIDENCE_CUSTODY_REJECTED');let actual;try{actual=await fs.realpath(path);}catch{fail('EVIDENCE_IO_UNKNOWN');}if(actual!==path)fail('EVIDENCE_CUSTODY_REJECTED');return s;}
async function ensureDir(fs,path,uid){try{await fs.mkdir(path,{mode:0o700});}catch(e){if(e?.code!=='EEXIST')fail('EVIDENCE_IO_UNKNOWN');}return ownedDir(fs,path,uid);}
async function entries(fs,path,max){let h;const found=[];try{h=await fs.opendir(path,{bufferSize:1});for(;;){const e=await h.read();if(e===null)break;if(!e.name||e.name==='.'||e.name==='..'||e.name.includes('/')||found.length>=max)fail('EVIDENCE_CAPACITY_REJECTED');found.push(e.name);}}catch(e){if(e instanceof EvidenceError)throw e;fail('EVIDENCE_IO_UNKNOWN');}finally{if(h)try{await h.close();}catch{fail('EVIDENCE_IO_UNKNOWN');}}return found.sort();}
async function readExact(fs,path,max,uid){await ancestors(fs,path,uid);const before=await lstat(fs,path);if(!isFile(before)||before.uid!==uid||before.nlink!==1||(before.mode&0o7777)!==0o600||before.size>max)fail('EVIDENCE_CUSTODY_REJECTED');let h;try{h=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const opened=await h.stat();if(!same(before,opened))fail('EVIDENCE_IO_UNKNOWN');const bytes=Buffer.alloc(before.size+1);let off=0;while(off<bytes.length){const count=Math.min(65536,bytes.length-off),r=await h.read(bytes,off,count,off);if(!Number.isSafeInteger(r.bytesRead)||r.bytesRead<0||r.bytesRead>count)fail('EVIDENCE_IO_UNKNOWN');if(r.bytesRead===0)break;off+=r.bytesRead;if(off>max)fail('EVIDENCE_CAPACITY_REJECTED');}const after=await h.stat(),leaf=await lstat(fs,path);if(off!==before.size||!same(opened,after)||!same(opened,leaf))fail('EVIDENCE_IO_UNKNOWN');return bytes.subarray(0,off);}catch(e){if(e instanceof EvidenceError)throw e;fail('EVIDENCE_IO_UNKNOWN');}finally{if(h)try{await h.close();}catch{fail('EVIDENCE_IO_UNKNOWN');}}}
async function writeExact(fs,path,bytes,uid,check){let h,initial;try{await check();h=await fs.open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);initial=await h.stat();if(!isFile(initial)||initial.uid!==uid||initial.nlink!==1||(initial.mode&0o7777)!==0o600)fail('EVIDENCE_CUSTODY_REJECTED');await h.writeFile(bytes);await check();const closing=h;h=null;await closing.close();await check();const back=await readExact(fs,path,bytes.length,uid);if(!back.equals(bytes))fail('EVIDENCE_IO_UNKNOWN');await check();return Object.freeze({bytes:bytes.length,sha256:digest(bytes)});}catch(e){if(e instanceof EvidenceError)throw e;fail('EVIDENCE_IO_UNKNOWN');}finally{if(h){const closing=h;h=null;try{await closing.close();}catch{fail('EVIDENCE_IO_UNKNOWN');}}}}
const publicStatus=(status,reason,manifest=null)=>Object.freeze({status,reason,manifest_sha256:manifest?.sha256??null,manifest_bytes:manifest?.bytes??null,copy_integrity:'NOT_EVALUATED',acknowledgement:status==='ACKNOWLEDGED'?'ACKNOWLEDGED':'UNKNOWN'});
const UNKNOWN_REASONS=new Set(['CANCELED','CLOCK_UNAVAILABLE','CUTOFF_UNKNOWN','PREFLIGHT_UNKNOWN','PUBLICATION_UNKNOWN','RUNNER_UNKNOWN','EVIDENCE_BINDING_REJECTED','EVIDENCE_CAPACITY_REJECTED','EVIDENCE_CUSTODY_REJECTED','EVIDENCE_CUTOFF_UNKNOWN','EVIDENCE_INTEGRITY_REJECTED','EVIDENCE_IO_UNKNOWN','INVALID_EVIDENCE_SPEC']);
export const unknownPhysicalJobEvidence=reason=>publicStatus('UNKNOWN',UNKNOWN_REASONS.has(reason)?reason:'EVIDENCE_IO_UNKNOWN');
const keys=(value,expected)=>plain(value)&&Object.keys(value).sort().join('|')===expected.slice().sort().join('|');

export function projectPhysicalEvidenceConfigSha256(admittedSpec){
 const s=fields(admittedSpec,['job_id','task_scope','requested_model','effort','max_wall_clock_sec','prompt_bytes'],['runtime_target','prefix_identity','desktop_runtime_identity','execution_profile','output_profile']);
 const target=s.runtime_target??'node24-esm';
 if(!UUID.test(s.job_id)||!types.isUint8Array(s.prompt_bytes)||s.max_wall_clock_sec!==120||target!=='node24-esm'||Object.hasOwn(s,'execution_profile')||Object.hasOwn(s,'output_profile'))fail('INVALID_EVIDENCE_SPEC');
 return hash(canonicalBytes({job_id:s.job_id,task_scope:s.task_scope,requested_model:s.requested_model,effort:s.effort,max_wall_clock_sec:s.max_wall_clock_sec,runtime_target:target,prompt_sha256:hash(s.prompt_bytes)}));
}

export async function preparePhysicalJobEvidence(spec,admittedSpec,ports,signal,checkCutoff=()=>{}){
 const v=fields(spec,['root','operation_config_sha256']);
 if(!absolute(v.root)||!HEX.test(v.operation_config_sha256)||v.operation_config_sha256!==projectPhysicalEvidenceConfigSha256(admittedSpec)||!ports||!Number.isSafeInteger(ports.uid)||ports.uid!==process.getuid())fail('INVALID_EVIDENCE_SPEC');
 const fs=ports.fs??nativeFs,uid=ports.uid,root=v.root;
 if(!fs||['lstat','realpath','mkdir','opendir','open'].some(k=>typeof fs[k]!=='function'))fail('INVALID_EVIDENCE_SPEC');
 const check=()=>{checkCutoff();if(signal?.aborted)fail('EVIDENCE_CUTOFF_UNKNOWN');};
 check();await ancestors(fs,root,uid);const rootStat=await ownedDir(fs,root,uid);
 const slots=join(root,'slots'),attempts=join(root,'attempts');const slotsStat=await ensureDir(fs,slots,uid);check();const attemptsStat=await ensureDir(fs,attempts,uid);check();
 const rootEntries=await entries(fs,root,3);if(rootEntries.join('|')!=='attempts|slots')fail('EVIDENCE_CUSTODY_REJECTED');
 const oldSlots=await entries(fs,slots,17),oldAttempts=await entries(fs,attempts,17);
 if(oldSlots.some(x=>!/^(0[0-9]|1[0-5])$/.test(x))||oldAttempts.some(x=>!UUID.test(x))||oldAttempts.length>=16)fail('EVIDENCE_CAPACITY_REJECTED');
 for(const id of oldSlots){await ownedDir(fs,join(slots,id),uid);if((await entries(fs,join(slots,id),1)).length!==0)fail('EVIDENCE_CUSTODY_REJECTED');}
 for(const id of oldAttempts){const d=join(attempts,id);await ownedDir(fs,d,uid);const names=await entries(fs,d,5);if(names.some(n=>!FILES.has(n)))fail('EVIDENCE_CUSTODY_REJECTED');let total=0;for(const n of names){const s=await lstat(fs,join(d,n));if(!isFile(s)||s.uid!==uid||s.nlink!==1||(s.mode&0o7777)!==0o600)fail('EVIDENCE_CUSTODY_REJECTED');total+=s.size;}if(total>ATTEMPT)fail('EVIDENCE_CAPACITY_REJECTED');}
 if(oldAttempts.includes(admittedSpec.job_id))fail('EVIDENCE_CAPACITY_REJECTED');
 let slot=null;for(let i=0;i<16;i++){check();const id=String(i).padStart(2,'0');try{await fs.mkdir(join(slots,id),{mode:0o700});slot=id;break;}catch(e){if(e?.code!=='EEXIST')fail('EVIDENCE_IO_UNKNOWN');}}
 if(slot===null)fail('EVIDENCE_CAPACITY_REJECTED');check();await ownedDir(fs,join(slots,slot),uid);
 const attempt=join(attempts,admittedSpec.job_id);try{await fs.mkdir(attempt,{mode:0o700});}catch{fail('EVIDENCE_IO_UNKNOWN');}const attemptStat=await ownedDir(fs,attempt,uid);check();
 const privateDirs=[[root,rootStat],[slots,slotsStat],[attempts,attemptsStat],[attempt,attemptStat]];
 async function checkPrivateDirs(){for(const [path,expected] of privateDirs){const current=await ownedDir(fs,path,uid);if(current.dev!==expected.dev||current.ino!==expected.ino)fail('EVIDENCE_CUSTODY_REJECTED');}}
 const buffers={stdout:[],stderr:[]},counts={stdout:0,stderr:0},overflow={stdout:false,stderr:false};let captureFault=false,closed=false;
 function capture(name,chunk){try{if(!types.isUint8Array(chunk)||types.isProxy(chunk)){captureFault=true;return;}const n=chunk.byteLength,cap=name==='stdout'?OUT:ERR,room=Math.max(0,cap-counts[name]),take=Math.min(room,n);if(take){buffers[name].push(Buffer.from(chunk.subarray(0,take)));counts[name]+=take;}if(n>take)overflow[name]=true;}catch{captureFault=true;}}
 function collectorFactory(baseFactory){const base=baseFactory();return Object.freeze({chunk(name,chunk){if(name==='stdout'||name==='stderr')capture(name,chunk);return base.chunk(name,chunk);},eof:name=>base.eof(name),snapshot:()=>base.snapshot(),decode:raw=>base.decode(raw),diagnosticReport:()=>base.diagnosticReport(),diagnosticCapture:()=>base.diagnosticCapture(),close(){closed=true;base.close();}});}
 async function publish(result,publicationSignal){const guard=async()=>{checkCutoff();if(publicationSignal?.aborted)fail('EVIDENCE_CUTOFF_UNKNOWN');await checkPrivateDirs();checkCutoff();if(publicationSignal?.aborted)fail('EVIDENCE_CUTOFF_UNKNOWN');};let status=publicStatus('UNKNOWN','PUBLICATION_UNKNOWN');
  try{await guard();const g=result?.generation,record=g?.record,spawns=result?.direct_child_invocations?.generation;
   if(result?.schema!=='SQUIRE2_PROJECT_RESULT_V1'||!Number.isSafeInteger(spawns)||spawns<0||spawns>1||
     (record!==undefined&&record!==null&&record.job_id!==admittedSpec.job_id)||
     (result.staging!==null&&(result.staging?.schema_version!=='squire4.stage_receipt.v1'||result.staging?.stage_operation_id!==`stage-${admittedSpec.job_id}`||result.staging?.completion_status!=='COMPLETE'||result.staging?.operation_acknowledgement!=='ACKNOWLEDGED'||!HEX.test(result.staging?.manifest_sha256))))
     fail('EVIDENCE_BINDING_REJECTED');
   const io=record?.io_state??null;const stream={};let total=0;
   for(const name of ['stdout','stderr']){await guard();const bytes=Buffer.concat(buffers[name],counts[name]);const noChild=spawns===0||record?.lifecycle_status==='LIMITED_SPAWN_FAILED'&&record?.process_exit?.pid===null;
    const flag=noChild?'ABSENT':overflow[name]?'PREFIX_OVERFLOW':captureFault||!closed||io?.[`${name}_eof`]!==true?'INCOMPLETE':'COMPLETE';
    const w=await writeExact(fs,join(attempt,`${name}.bin`),bytes,uid,guard);stream[name]={leaf:`${name}.bin`,...w,flag};total+=w.bytes;bytes.fill(0);}
   await guard();let resultRef=null;try{const receipt=createProjectResultReceipt(result);const ack=await writeProjectResultReceipt(receipt,{directory:attempt,filename:'result.json'},{fs,uid});await guard();if(ack.status!=='RECORDED'||!Number.isSafeInteger(ack.byte_count)||ack.byte_count>RECEIPT||!HEX.test(ack.sha256))fail('EVIDENCE_BINDING_REJECTED');resultRef={leaf:'result.json',bytes:ack.byte_count,sha256:ack.sha256};total+=ack.byte_count;}catch(e){if(e instanceof EvidenceError)throw e;fail('EVIDENCE_IO_UNKNOWN');}
   const stage=result.staging?{manifest_sha256:result.staging.manifest_sha256,acknowledgement:'ACKNOWLEDGED'}:null;
   const manifest={schema:SCHEMA,profile:'PROJECT_CODEGEN_V1',job_id:admittedSpec.job_id,operation_config_sha256:v.operation_config_sha256,
     result_sha256:resultRef.sha256,record_status:record?.lifecycle_status??'UNKNOWN',process_exit:record?.process_exit??null,
     io_state:io,settlement_status:record?.containment_evidence?.settlement_status??'UNKNOWN',usage_tokens:record?.provider_metadata?.usage_tokens??null,
     streams:stream,result_receipt:resultRef,stage,completion:'COPY_PUBLISHED_NOT_ORIGIN_ACKNOWLEDGED',boundaries:['COPY_INTEGRITY_ONLY','DIRECT_CHILD_ONLY','NO_REPLAY_AUTHORITY']};
   const bytes=Buffer.from(JSON.stringify(manifest)+'\n');if(bytes.length>MANIFEST||total+bytes.length>ATTEMPT)fail('EVIDENCE_CAPACITY_REJECTED');await guard();const ack=await writeExact(fs,join(attempt,'manifest.json'),bytes,uid,guard);await guard();status=publicStatus('ACKNOWLEDGED','NONE',ack);return status;
  }catch(e){status=publicStatus('UNKNOWN',e instanceof EvidenceError?e.code:'EVIDENCE_IO_UNKNOWN');return status;}
  finally{for(const name of ['stdout','stderr'])for(const b of buffers[name])b.fill(0);}
 }
 return Object.freeze({collectorFactory,publish,attempt_dir:attempt,private_job_id:admittedSpec.job_id});
}

export async function verifyProjectPhysicalJobEvidence(attemptDir,expectedManifestSha256,ports={}){
 try{if(!absolute(attemptDir)||!UUID.test(parse(attemptDir).base)||parse(dirname(attemptDir)).base!=='attempts'||!HEX.test(expectedManifestSha256)||!plain(ports)||Reflect.ownKeys(ports).some(k=>!['fs','uid'].includes(k)))fail('INVALID_EVIDENCE_SPEC');const fs=ports.fs??nativeFs,uid=ports.uid??process.getuid();if(uid!==process.getuid())fail('INVALID_EVIDENCE_SPEC');await ancestors(fs,attemptDir,uid);await ownedDir(fs,dirname(dirname(attemptDir)),uid);await ownedDir(fs,dirname(attemptDir),uid);await ownedDir(fs,attemptDir,uid);
  const names=await entries(fs,attemptDir,5);if(names.join('|')!=='manifest.json|result.json|stderr.bin|stdout.bin')fail('EVIDENCE_INTEGRITY_REJECTED');const bytes=await readExact(fs,join(attemptDir,'manifest.json'),MANIFEST,uid);if(digest(bytes)!==expectedManifestSha256)fail('EVIDENCE_INTEGRITY_REJECTED');let m;try{m=JSON.parse(bytes.toString('utf8'));}catch{fail('EVIDENCE_INTEGRITY_REJECTED');}
  if(!keys(m,['schema','profile','job_id','operation_config_sha256','result_sha256','record_status','process_exit','io_state','settlement_status','usage_tokens','streams','result_receipt','stage','completion','boundaries'])||
    m.schema!==SCHEMA||m.profile!=='PROJECT_CODEGEN_V1'||m.completion!=='COPY_PUBLISHED_NOT_ORIGIN_ACKNOWLEDGED'||m.job_id!==parse(attemptDir).base||!HEX.test(m.operation_config_sha256)||!HEX.test(m.result_sha256)||
    !keys(m.streams,['stdout','stderr'])||!keys(m.result_receipt,['leaf','bytes','sha256'])||m.result_receipt.sha256!==m.result_sha256||
    !(m.stage===null||keys(m.stage,['manifest_sha256','acknowledgement'])&&HEX.test(m.stage.manifest_sha256)&&m.stage.acknowledgement==='ACKNOWLEDGED')||
    !Array.isArray(m.boundaries)||m.boundaries.join('|')!=='COPY_INTEGRITY_ONLY|DIRECT_CHILD_ONLY|NO_REPLAY_AUTHORITY'||Buffer.from(JSON.stringify(m)+'\n').compare(bytes)!==0)fail('EVIDENCE_INTEGRITY_REJECTED');let total=bytes.length;
  for(const [name,max] of [['stdout',OUT],['stderr',ERR]]){const row=m.streams[name];if(!keys(row,['leaf','bytes','sha256','flag'])||row.leaf!==`${name}.bin`||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>max||!HEX.test(row.sha256)||!['COMPLETE','PREFIX_OVERFLOW','INCOMPLETE','ABSENT'].includes(row.flag)||row.flag==='ABSENT'&&row.bytes!==0||row.flag==='PREFIX_OVERFLOW'&&row.bytes!==max)fail('EVIDENCE_INTEGRITY_REJECTED');const leaf=await readExact(fs,join(attemptDir,row.leaf),max,uid);if(leaf.length!==row.bytes||digest(leaf)!==row.sha256)fail('EVIDENCE_INTEGRITY_REJECTED');total+=leaf.length;}
  if(m.result_receipt.leaf!=='result.json'||!Number.isSafeInteger(m.result_receipt.bytes)||m.result_receipt.bytes<0||m.result_receipt.bytes>RECEIPT||!HEX.test(m.result_receipt.sha256))fail('EVIDENCE_INTEGRITY_REJECTED');const receipt=await readExact(fs,join(attemptDir,'result.json'),RECEIPT,uid);if(receipt.length!==m.result_receipt.bytes||digest(receipt)!==m.result_receipt.sha256||total+receipt.length>ATTEMPT)fail('EVIDENCE_INTEGRITY_REJECTED');
  let result;try{result=JSON.parse(receipt.toString('utf8'));}catch{fail('EVIDENCE_INTEGRITY_REJECTED');}
  if(!plain(result)||Buffer.from(JSON.stringify(result)+'\n').compare(receipt)!==0||result.schema!=='SQUIRE2_PROJECT_RESULT_V1'||
    result.generation?.record?.job_id!==m.job_id&&result.generation!==null||
    m.record_status!==(result.generation?.record?.lifecycle_status??'UNKNOWN')||
    JSON.stringify(m.process_exit)!==JSON.stringify(result.generation?.record?.process_exit??null)||
    JSON.stringify(m.io_state)!==JSON.stringify(result.generation?.record?.io_state??null)||
    m.settlement_status!==(result.generation?.record?.containment_evidence?.settlement_status??'UNKNOWN')||
    JSON.stringify(m.usage_tokens)!==JSON.stringify(result.generation?.record?.provider_metadata?.usage_tokens??null)||
    JSON.stringify(m.stage)!==JSON.stringify(result.staging?{manifest_sha256:result.staging.manifest_sha256,acknowledgement:'ACKNOWLEDGED'}:null))fail('EVIDENCE_INTEGRITY_REJECTED');
  return Object.freeze({status:'PHYSICAL_EVIDENCE_COPY_VERIFIED',manifest_sha256:expectedManifestSha256,manifest_bytes:bytes.length,copy_integrity:'VERIFIED',acknowledgement:'UNKNOWN'});
 }catch(e){if(e instanceof EvidenceError)throw e;fail('EVIDENCE_INTEGRITY_REJECTED');}
}
