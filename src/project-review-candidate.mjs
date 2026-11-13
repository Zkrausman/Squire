// Local-only bridge from an acknowledged large-project stage to a fresh
// review commit. It never executes generated content or mutates the base repo.
import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,dirname,join,parse,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {types} from 'node:util';
import {closed} from './job-spec.mjs';
import {parseReceiptJson} from './offline-run-summary.mjs';
import {projectNativeProjectRunSummary,projectNativeProjectLargeObservationReceiptBytesSummary} from './project-summary.mjs';
import {
  PROJECT_OUTPUT_LARGE_PROFILE,PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA,
  validateProjectOutputLargeProfile
} from './project-coding-profile.mjs';
import {verifyStage,verifyLargeProjectStage} from './multifile-staging.mjs';
import {buildExport,verifyExport,buildLargeProjectExport,verifyLargeProjectExport} from './multifile-export.mjs';
import {readReceiptBytes} from '../bin/squire-report.mjs';

const SPEC_SCHEMA='SQUIRE_PROJECT_REVIEW_IMPORT_V1';
const STANDARD_SPEC_SCHEMA='SQUIRE_STANDARD_PROJECT_REVIEW_IMPORT_V1';
const RESULT_SCHEMA='SQUIRE_PROJECT_REVIEW_CANDIDATE_V1';
const MAX_RECEIPT_BYTES=262144;
const MAX_SPEC_BYTES=65536;
const MAX_STAGE_MANIFEST_BYTES=65536;
const MAX_EXPORT_MANIFEST_BYTES=131072;
const MAX_PROJECT_BYTES=4194304;
const MAX_BASE_ENTRIES=2048;
const MAX_BASE_METADATA_BYTES=4194304;
const MAX_BASE_TREE_RECORDS=131072;
const MAX_CANDIDATE_ENTRIES=MAX_BASE_ENTRIES+50;
const MAX_CANDIDATE_METADATA_BYTES=MAX_BASE_METADATA_BYTES+50*512;
const TOKEN=/^[A-Za-z0-9_-]{1,64}$/;
const SHA256=/^[a-f0-9]{64}$/;
const SHA1=/^[a-f0-9]{40}$/;
const ZERO_OID='0000000000000000000000000000000000000000';
const SPEC_KEYS=[
  'schema','operation_id','caller_label','receipt_bytes','receipt_sha256',
  'stage_dir','stage_manifest_sha256','snapshot_dir','base_git_dir',
  'base_git_identity','base_commit','base_tree','candidate_dir','allowed_changes'
];
const PORT_KEYS=['fs','uid','git'];
const OPTIONAL_PORT_KEYS=['signal'];
const FS_KEYS=['open','mkdir','lstat','chmod','readdir','realpath'];
const GIT_KEYS=[
  'inspectCommit','inspectTree','readBlob','initBare','writeBlob',
  'writeTree','writeCommit','readRef','createRef'
];
const PROJECT_CLASSES=Object.freeze({
  SOURCE:Object.freeze({count:25,file:524288,total:2097152}),
  LOCAL_ASSET:Object.freeze({count:20,file:524288,total:2097152}),
  DOC:Object.freeze({count:5,file:65536,total:131072})
});
// Explicit internal profiles; callers cannot select or mutate these capabilities.
const LARGE_IMPORT=Object.freeze({
  receiptSchema:PROJECT_LARGE_OBSERVATION_RECEIPT_SCHEMA,
  stageSchema:'squire4.large_project_stage_receipt.v1',
  exportSchema:'squire4.large_project_export_manifest.v1',
  classes:PROJECT_CLASSES,maxBytes:MAX_PROJECT_BYTES,
  verifyStage:verifyLargeProjectStage,buildExport:buildLargeProjectExport,
  verifyExport:verifyLargeProjectExport,large:true
});
const STANDARD_IMPORT=Object.freeze({
  receiptSchema:'SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1',
  stageSchema:'squire4.stage_receipt.v1',exportSchema:'squire4.export_manifest.v1',
  classes:Object.freeze({
    SOURCE:Object.freeze({count:25,file:65536,total:524288}),
    LOCAL_ASSET:Object.freeze({count:20,file:524288,total:2097152}),
    DOC:Object.freeze({count:5,file:65536,total:131072})
  }),maxBytes:1048576,
  verifyStage,buildExport,verifyExport,large:false
});
const ABORTED_GETTER=Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,'aborted'
).get;
const ADD_EVENT_LISTENER=EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER=EventTarget.prototype.removeEventListener;
const signalPrototype=AbortSignal.prototype;
const encoder=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

class ReviewCandidateError extends Error{
  constructor(code){super(code);this.name='ReviewCandidateError';this.code=code;delete this.stack;}
}
const invalid=()=>{throw new ReviewCandidateError('INVALID_PROJECT_REVIEW_SPEC');};
const rejected=()=>{throw new ReviewCandidateError('PROJECT_REVIEW_CANDIDATE_REJECTED');};
function signalAborted(signal){
  if(signal===undefined)return false;
  if(!signal||typeof signal!=='object'||types.isProxy(signal))invalid();
  let current=signal,found=false;
  while(current!==null){
    if(types.isProxy(current))invalid();
    let descriptor,next;
    try{descriptor=Object.getOwnPropertyDescriptor(current,'aborted');next=Object.getPrototypeOf(current);}
    catch{invalid();}
    if(current===signal&&descriptor)invalid();
    if(current===signalPrototype){
      if(!descriptor||!Object.hasOwn(descriptor,'get')||descriptor.get!==ABORTED_GETTER)invalid();
      found=true;
    }else if(descriptor)invalid();
    current=next;
  }
  if(!found)invalid();
  try{return Reflect.apply(ABORTED_GETTER,signal,[]);}catch{invalid();}
}
function checkAbort(signal){if(signalAborted(signal))throw new ReviewCandidateError('PROJECT_REVIEW_CANDIDATE_ABORTED');}
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function gitObjectId(type,bytes){
  const header=Buffer.from(`${type} ${bytes.byteLength}\0`,'ascii');
  return createHash('sha1').update(header).update(bytes).digest('hex');
}
function plainBytes(value,max){
  if(types.isProxy(value)||!types.isUint8Array(value)||
     Object.getPrototypeOf(value)!==Uint8Array.prototype)invalid();
  let length;
  try{length=Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),'byteLength'
  ).get.call(value);}catch{invalid();}
  if(!Number.isSafeInteger(length)||length>max)invalid();
  const copy=new Uint8Array(length);
  Uint8Array.prototype.set.call(copy,value);
  return copy;
}
function denseArray(value,max){
  if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)invalid();
  const length=Object.getOwnPropertyDescriptor(value,'length')?.value;
  const keys=Reflect.ownKeys(value);
  if(!Number.isSafeInteger(length)||length<0||length>max||keys.length!==length+1)invalid();
  const result=[];
  for(let i=0;i<length;i++){
    const item=Object.getOwnPropertyDescriptor(value,String(i));
    if(!item||!Object.hasOwn(item,'value'))invalid();
    result.push(item.value);
  }
  return result;
}
function absolutePath(value){
  return typeof value==='string'&&value.length>1&&value.length<=4096&&
    value.startsWith('/')&&!/[\\\u0000-\u001f\u007f]/u.test(value)&&
    resolve(value)===value&&value!==parse(value).root;
}
function pathsOverlap(left,right){
  return left===right||left.startsWith(`${right}/`)||right.startsWith(`${left}/`);
}
function stageRelative(path){
  if(typeof path!=='string'||!path||path.length>256||
     !/^[A-Za-z0-9._/-]+$/.test(path)||path.startsWith('/')||path.endsWith('/'))return false;
  const parts=path.split('/');
  if(parts.length>7||parts.some(part=>!part||part==='.'||part==='..'||part.length>64||
     /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)||
     ['stage-manifest.json','export-manifest.json','package-manifest.json','.git'].includes(part.toLowerCase()))||
     ['project','evidence','frames'].includes(parts[0].toLowerCase()))return false;
  return true;
}
function baseRelative(path){
  if(typeof path!=='string'||!path||path.length>4096||path.startsWith('/')||path.endsWith('/')||
     !/^[A-Za-z0-9._/-]+$/.test(path))return false;
  const parts=path.split('/');
  return parts.length<=64&&parts.every(part=>part&&part!=='.'&&part!=='..'&&part.length<=255&&
    part.toLowerCase()!=='.git'&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function checkPathCollisions(paths){
  const exact=new Set(),folded=new Map();
  for(const path of paths){
    const prior=folded.get(path.toLowerCase());
    if(prior!==undefined&&prior!==path)invalid();
    folded.set(path.toLowerCase(),path);exact.add(path);
  }
  for(const path of exact){
    const parts=path.toLowerCase().split('/');
    for(let i=1;i<parts.length;i++)if(folded.has(parts.slice(0,i).join('/')))invalid();
  }
}
function captureSpec(value,schema=SPEC_SCHEMA){
  try{closed(value,SPEC_KEYS,['signal'],'project_review_spec');}catch{invalid();}
  const out=Object.create(null);
  for(const key of [...SPEC_KEYS,...(Object.hasOwn(value,'signal')?['signal']:[])]){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value'))invalid();
    out[key]=descriptor.value;
  }
  if(out.schema!==schema||typeof out.operation_id!=='string'||!TOKEN.test(out.operation_id)||
     typeof out.caller_label!=='string'||!TOKEN.test(out.caller_label)||
     typeof out.receipt_sha256!=='string'||!SHA256.test(out.receipt_sha256)||
     typeof out.stage_manifest_sha256!=='string'||!SHA256.test(out.stage_manifest_sha256)||
     typeof out.base_commit!=='string'||!SHA1.test(out.base_commit)||
     typeof out.base_tree!=='string'||!SHA1.test(out.base_tree))invalid();
  out.receipt_bytes=plainBytes(out.receipt_bytes,MAX_RECEIPT_BYTES);
  if(sha256(out.receipt_bytes)!==out.receipt_sha256)invalid();
  for(const key of ['stage_dir','snapshot_dir','base_git_dir','candidate_dir']){
    if(!absolutePath(out[key]))invalid();
  }
  if(basename(out.candidate_dir)==='.git')invalid();
  const protectedBase=basename(out.base_git_dir)==='.git'?dirname(out.base_git_dir):out.base_git_dir;
  const roots=[out.stage_dir,out.snapshot_dir,protectedBase,out.candidate_dir];
  for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++){
    if(pathsOverlap(roots[i],roots[j]))invalid();
  }
  try{closed(out.base_git_identity,['dev','ino'],[],'base_git_identity');}catch{invalid();}
  if(!Number.isSafeInteger(out.base_git_identity.dev)||out.base_git_identity.dev<0||
     !Number.isSafeInteger(out.base_git_identity.ino)||out.base_git_identity.ino<0)invalid();
  out.base_git_identity=Object.freeze({dev:out.base_git_identity.dev,ino:out.base_git_identity.ino});
  const allowed=denseArray(out.allowed_changes,50);
  if(allowed.length===0)invalid();
  out.allowed_changes=allowed.map(item=>{
    try{closed(item,['path','original'],[],'allowed_change');}catch{invalid();}
    if(!stageRelative(item.path))invalid();
    let original=null;
    if(item.original!==null){
      try{closed(item.original,['blob','bytes','sha256'],[],'original_blob');}catch{invalid();}
      if(typeof item.original.blob!=='string'||!SHA1.test(item.original.blob)||!Number.isSafeInteger(item.original.bytes)||
         item.original.bytes<0||item.original.bytes>MAX_PROJECT_BYTES||
         typeof item.original.sha256!=='string'||!SHA256.test(item.original.sha256))invalid();
      original=Object.freeze({blob:item.original.blob,bytes:item.original.bytes,sha256:item.original.sha256});
    }
    return Object.freeze({path:item.path,original});
  });
  if(new Set(out.allowed_changes.map(item=>item.path)).size!==out.allowed_changes.length)invalid();
  checkPathCollisions(out.allowed_changes.map(item=>item.path));
  if(Object.hasOwn(out,'signal'))signalAborted(out.signal);
  return Object.freeze(out);
}
// A revision deliberately consumes an original producer candidate, not an
// arbitrary revision chain. Its original receipt/stage are revalidated below.
function captureRevisionSpec(value){
  try{closed(value,['schema','original','prior_candidate','corrections'],[],'project_revision_spec');}catch{invalid();}
  if(value.schema!=='SQUIRE_PROJECT_REVIEW_REVISION_V1')invalid();
  const original=captureSpec(value.original);
  const corrections=[];
  try{
    const prior=value.prior_candidate;
    try{closed(prior,['git_dir','identity','operation_id','commit','tree'],[],'prior_candidate');
      closed(prior.identity,['dev','ino'],[],'prior_identity');}catch{invalid();}
    if(!absolutePath(prior.git_dir)||basename(prior.git_dir)==='.git'||
       typeof prior.operation_id!=='string'||!TOKEN.test(prior.operation_id)||
       prior.operation_id===original.operation_id||
       typeof prior.commit!=='string'||!SHA1.test(prior.commit)||
       typeof prior.tree!=='string'||!SHA1.test(prior.tree)||
       !Number.isSafeInteger(prior.identity.dev)||prior.identity.dev<0||
       !Number.isSafeInteger(prior.identity.ino)||prior.identity.ino<0)invalid();
    const priorCandidate=Object.freeze({git_dir:prior.git_dir,
      identity:Object.freeze({dev:prior.identity.dev,ino:prior.identity.ino}),
      operation_id:prior.operation_id,commit:prior.commit,tree:prior.tree});
    const protectedBase=basename(original.base_git_dir)==='.git'?dirname(original.base_git_dir):original.base_git_dir;
    for(const path of [protectedBase,original.stage_dir,original.snapshot_dir,original.candidate_dir]){
      if(pathsOverlap(priorCandidate.git_dir,path))invalid();
    }
    const items=denseArray(value.corrections,50);
    if(items.length===0)invalid();
    let total=0;
    for(const item of items){
      try{closed(item,['path','original','bytes_data'],[],'revision_correction');
        closed(item.original,['blob','bytes','sha256'],[],'revision_original');}catch{invalid();}
      if(!stageRelative(item.path)||!original.allowed_changes.some(allow=>allow.path===item.path)||
         typeof item.original.blob!=='string'||!SHA1.test(item.original.blob)||
         !Number.isSafeInteger(item.original.bytes)||item.original.bytes<0||item.original.bytes>524288||
         typeof item.original.sha256!=='string'||!SHA256.test(item.original.sha256))invalid();
      const bytes=plainBytes(item.bytes_data,Math.min(524288,MAX_PROJECT_BYTES-total));
      corrections.push(Object.freeze({path:item.path,original:Object.freeze({
        blob:item.original.blob,bytes:item.original.bytes,sha256:item.original.sha256
      }),bytes_data:bytes}));
      total+=bytes.length;if(total>MAX_PROJECT_BYTES)invalid();
    }
    if(new Set(corrections.map(item=>item.path)).size!==corrections.length)invalid();
    checkPathCollisions(corrections.map(item=>item.path));
    return Object.freeze({schema:'SQUIRE_PROJECT_REVIEW_REVISION_V1',original,prior_candidate:priorCandidate,corrections:Object.freeze(corrections)});
  }catch(error){original.receipt_bytes.fill(0);for(const item of corrections)item.bytes_data.fill(0);throw error;}
}

function capturePorts(value,specSignal){
  try{closed(value,PORT_KEYS,OPTIONAL_PORT_KEYS,'project_review_ports');}catch{invalid();}
  if(Object.hasOwn(value,'signal')&&value.signal!==specSignal)invalid();
  if(specSignal!==undefined&&!Object.hasOwn(value,'signal'))invalid();
  const suppliedFs=value.fs,suppliedGit=value.git;
  try{closed(suppliedFs,FS_KEYS,[],'project_review_fs');closed(suppliedGit,GIT_KEYS,[],'project_review_git');}catch{invalid();}
  if(!Number.isSafeInteger(value.uid)||value.uid<0)invalid();
  const fsMethods=Object.create(null),gitMethods=Object.create(null);
  for(const key of FS_KEYS){
    const method=suppliedFs[key];
    if(typeof method!=='function'||types.isProxy(method))invalid();
    fsMethods[key]=(...args)=>Reflect.apply(method,suppliedFs,args);
  }
  for(const key of GIT_KEYS){
    const method=suppliedGit[key];
    if(typeof method!=='function'||types.isProxy(method))invalid();
    gitMethods[key]=(...args)=>Reflect.apply(method,suppliedGit,args);
  }
  const signal=Object.hasOwn(value,'signal')?value.signal:undefined;
  if(signal!==undefined)signalAborted(signal);
  return Object.freeze({fs:Object.freeze(fsMethods),git:Object.freeze(gitMethods),uid:value.uid,signal});
}
async function checked(ports,operation){
  checkAbort(ports.signal);
  let value;
  try{value=await operation();}catch(error){checkAbort(ports.signal);throw error;}
  checkAbort(ports.signal);
  return value;
}
function statKind(stat,kind){
  if(!stat||typeof stat!=='object'||types.isProxy(stat)||
     typeof stat.isDirectory!=='function'||typeof stat.isFile!=='function'||
     typeof stat.isSymbolicLink!=='function')return false;
  try{
    if(stat.isSymbolicLink())return false;
    return kind==='directory'?stat.isDirectory()===true:stat.isFile()===true;
  }catch{return false;}
}
function stable(a,b){
  return ['dev','ino','size','mtimeMs','ctimeMs'].every(key=>
    typeof a?.[key]==='number'&&Number.isFinite(a[key])&&a[key]===b?.[key]
  );
}
async function lstat(ports,path){return checked(ports,()=>ports.fs.lstat(path));}
async function ancestorChecks(ports,target,allowStickyRoot=true){
  const parent=dirname(target),root=parse(parent).root,parts=parent.slice(root.length).split('/').filter(Boolean);
  const paths=[root];let current=root;
  for(const part of parts){current=join(current,part);paths.push(current);}
  for(const path of paths){
    const stat=await lstat(ports,path);
    if(!statKind(stat,'directory')||!Number.isSafeInteger(stat.uid)||!Number.isSafeInteger(stat.mode))rejected();
    const ownerSafe=(stat.uid===ports.uid||stat.uid===0)&&(stat.mode&0o022)===0;
    const stickyRoot=allowStickyRoot&&stat.uid===0&&(stat.mode&0o1000)===0o1000;
    if(!ownerSafe&&!stickyRoot)rejected();
  }
}
async function realPathIsSelf(ports,path){
  const real=await checked(ports,()=>ports.fs.realpath(path));
  if(real!==path)rejected();
}
async function absent(ports,path){
  try{await lstat(ports,path);return false;}
  catch(error){
    try{return Object.getOwnPropertyDescriptor(error,'code')?.value==='ENOENT';}catch{return false;}
  }
}
async function validateBaseDirectory(spec,ports){
  await ancestorChecks(ports,spec.base_git_dir);
  const stat=await lstat(ports,spec.base_git_dir);
  if(!statKind(stat,'directory')||stat.uid!==ports.uid||
     (stat.mode&0o022)!==0||stat.dev!==spec.base_git_identity.dev||
     stat.ino!==spec.base_git_identity.ino)rejected();
  await realPathIsSelf(ports,spec.base_git_dir);
  const objects=join(spec.base_git_dir,'objects');
  const objectsStat=await lstat(ports,objects);
  if(!statKind(objectsStat,'directory')||objectsStat.uid!==ports.uid||(objectsStat.mode&0o022)!==0)rejected();
  const info=join(objects,'info');
  if(!await absent(ports,info)){
    const infoStat=await lstat(ports,info);
    if(!statKind(infoStat,'directory')||infoStat.uid!==ports.uid||(infoStat.mode&0o022)!==0)rejected();
    if(!await absent(ports,join(info,'alternates')))rejected();
  }
  if(!await absent(ports,join(spec.base_git_dir,'commondir')))rejected();
  if(!await absent(ports,join(spec.base_git_dir,'gitdir')))rejected();
  return objects;
}
async function readStableFile(ports,path,maxBytes,expectedMode=0o400){
  await ancestorChecks(ports,path);
  let handle=null,bytes=null,scratch=null;
  try{
    const before=await lstat(ports,path);
    if(!statKind(before,'file')||before.uid!==ports.uid||before.nlink!==1||
       (before.mode&0o777)!==expectedMode||!Number.isSafeInteger(before.size)||
       before.size<0||before.size>maxBytes)rejected();
    checkAbort(ports.signal);
    handle=await ports.fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    checkAbort(ports.signal);
    const opened=await checked(ports,()=>handle.stat());
    if(!statKind(opened,'file')||opened.uid!==ports.uid||opened.nlink!==1||
       (opened.mode&0o777)!==expectedMode||!stable(before,opened))rejected();
    scratch=new Uint8Array(before.size+1);
    let offset=0;
    while(offset<scratch.length){
      const size=Math.min(65536,scratch.length-offset);
      const result=await checked(ports,()=>handle.read(scratch,offset,size,offset));
      if(!Number.isSafeInteger(result.bytesRead)||result.bytesRead<0||result.bytesRead>size)rejected();
      if(result.bytesRead===0)break;
      offset+=result.bytesRead;
      if(offset>maxBytes)rejected();
    }
    const after=await checked(ports,()=>handle.stat()),leaf=await lstat(ports,path);
    if(offset!==before.size||!stable(opened,after)||!stable(opened,leaf)||
       !statKind(leaf,'file')||leaf.uid!==ports.uid||leaf.nlink!==1||
       (leaf.mode&0o777)!==expectedMode)rejected();
    bytes=scratch.slice(0,offset);
  }finally{
    scratch?.fill(0);
    if(handle){
      try{await handle.close();}catch(error){bytes?.fill(0);throw error;}
    }
  }
  return bytes;
}
async function reserveDirectory(ports,path){
  await ancestorChecks(ports,path);
  if(!await absent(ports,path))rejected();
  await checked(ports,()=>ports.fs.mkdir(path,{recursive:false,mode:0o700}));
  const stat=await lstat(ports,path);
  if(!statKind(stat,'directory')||stat.uid!==ports.uid||(stat.mode&0o777)!==0o700)rejected();
}
async function writePrivateFile(ports,path,bytes){
  let handle=null;
  try{
    checkAbort(ports.signal);
    handle=await ports.fs.open(path,
      constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    checkAbort(ports.signal);
    await checked(ports,()=>handle.writeFile(bytes));
  }finally{if(handle)await handle.close();}
  const stat=await lstat(ports,path);
  if(!statKind(stat,'file')||stat.uid!==ports.uid||stat.nlink!==1||
     (stat.mode&0o777)!==0o600||stat.size!==bytes.length)rejected();
}
async function installBaseAlternate(spec,ports,objects){
  const info=join(spec.candidate_dir,'objects','info');
  const infoStat=await lstat(ports,info);
  if(!statKind(infoStat,'directory')||infoStat.uid!==ports.uid||(infoStat.mode&0o022)!==0)rejected();
  const alternate=join(objects,'');
  if(/[\\\r\n\u0000]/u.test(alternate)||!alternate.startsWith('/'))rejected();
  await writePrivateFile(ports,join(info,'alternates'),encoder.encode(`${alternate}\n`));
}
function parseRawCommit(bytes,oid){
  if(gitObjectId('commit',bytes)!==oid)rejected();
  let text;
  try{text=decoder.decode(bytes);}catch{rejected();}
  const split=text.indexOf('\n\n');
  if(split<0)rejected();
  const headers=text.slice(0,split).split('\n');
  let tree=null,lastKey=null;const parents=[];
  for(const line of headers){
    if(line.startsWith(' ')){
      if(lastKey===null||lastKey==='tree'||lastKey==='parent')rejected();
      continue;
    }
    const field=/^([a-zA-Z0-9-]+) (.+)$/.exec(line);
    if(!field)rejected();
    lastKey=field[1];
    if(lastKey==='tree'){
      if(tree!==null||!SHA1.test(field[2]))rejected();
      tree=field[2];
    }else if(lastKey==='parent'){
      const parent=field[2];if(!SHA1.test(parent)||parents.length>=16)rejected();parents.push(parent);
    }
  }
  if(tree===null)rejected();
  return Object.freeze({tree,parents:Object.freeze(parents)});
}
function parseTreeListing(value,maxEntries,maxMetadataBytes){
  try{closed(value,['object_format','entries'],[],'git_tree_listing');}catch{rejected();}
  if(value.object_format!=='sha1')rejected();
  let entries;
  try{entries=denseArray(value.entries,MAX_BASE_TREE_RECORDS);}catch{rejected();}
  let metadataBytes=0;
  const files=[],trees=[],seen=new Map();
  for(const entry of entries){
    try{closed(entry,['path','mode','type','oid'],[],'git_tree_entry');}catch{rejected();}
    if(!baseRelative(entry.path)||typeof entry.oid!=='string'||!SHA1.test(entry.oid))rejected();
    const folded=entry.path.toLowerCase();
    if(seen.has(folded))rejected();
    seen.set(folded,entry.path);
    if(entry.type==='blob'&&['100644','100755'].includes(entry.mode)){
      files.push(Object.freeze({path:entry.path,mode:entry.mode,oid:entry.oid}));
    }else if(entry.type==='tree'&&['040000','40000'].includes(entry.mode)){
      trees.push(Object.freeze({path:entry.path,oid:entry.oid}));
    }else rejected();
    metadataBytes+=encoder.encode(entry.path).length+entry.mode.length+entry.type.length+entry.oid.length+4;
    if(!Number.isSafeInteger(metadataBytes)||metadataBytes>maxMetadataBytes)rejected();
  }
  if(files.length>maxEntries)rejected();
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  trees.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const filePaths=new Set(files.map(entry=>entry.path));
  const treePaths=new Set(trees.map(entry=>entry.path));
  const nonemptyDirectories=new Set();
  for(const file of files){
    const parts=file.path.split('/');
    for(let i=1;i<parts.length;i++)nonemptyDirectories.add(parts.slice(0,i).join('/'));
  }
  if(filePaths.size!==files.length||treePaths.size!==trees.length)rejected();
  checkPathCollisions(files.map(entry=>entry.path));
  for(const tree of trees){
    if(filePaths.has(tree.path)||!nonemptyDirectories.has(tree.path))rejected();
    const parts=tree.path.split('/');
    for(let i=1;i<parts.length;i++){
      const prefix=parts.slice(0,i).join('/');
      if(filePaths.has(prefix)||!treePaths.has(prefix))rejected();
    }
  }
  for(const file of files){
    const parts=file.path.split('/');
    for(let i=1;i<parts.length;i++)if(!treePaths.has(parts.slice(0,i).join('/')))rejected();
  }
  return Object.freeze({files:Object.freeze(files),trees:Object.freeze(trees)});
}
function validateManifest(value,verification,spec,stageAck,profile){
  try{closed(value,[
    'schema_version',...(profile.large?['output_profile']:[]),'export_operation_id','caller_label',
    'stage_binding','file_counts','total_files','total_bytes','files'
  ],[],'large_export_manifest');}catch{rejected();}
  try{
    closed(value.stage_binding,['stage_operation_id','stage_manifest_sha256'],[],'stage_binding');
    closed(value.file_counts,[
      'source','local_asset','doc','evidence_log','frame_capture'
    ],[],'file_counts');
  }catch{rejected();}
  if(profile.large)try{validateProjectOutputLargeProfile(value.output_profile);}catch{rejected();}
  if(value.schema_version!==profile.exportSchema||
     value.export_operation_id!==spec.operation_id||
     value.stage_binding?.stage_operation_id!==stageAck.stage_operation_id||
     value.stage_binding?.stage_manifest_sha256!==spec.stage_manifest_sha256||
     value.total_files!==verification.total_files||value.total_bytes!==verification.total_bytes||
     !Number.isSafeInteger(value.total_files)||value.total_files<1||value.total_files>50||
     !Number.isSafeInteger(value.total_bytes)||value.total_bytes<0||value.total_bytes>profile.maxBytes)rejected();
  const files=denseArray(value.files,50);
  if(files.length!==value.total_files)rejected();
  const counts={SOURCE:0,LOCAL_ASSET:0,DOC:0};
  const totals={SOURCE:0,LOCAL_ASSET:0,DOC:0};
  let total=0;
  const captured=files.map(file=>{
    try{closed(file,['path','classification','bytes','sha256','export_subpath'],[],'export_file');}catch{rejected();}
    const caps=profile.classes[file.classification];
    if(!caps||!stageRelative(file.path)||file.export_subpath!==`project/${file.path}`||
       !Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>caps.file||
       !SHA256.test(file.sha256))rejected();
    counts[file.classification]++;totals[file.classification]+=file.bytes;total+=file.bytes;
    if(counts[file.classification]>caps.count||totals[file.classification]>caps.total||total>profile.maxBytes)rejected();
    return Object.freeze({path:file.path,classification:file.classification,bytes:file.bytes,sha256:file.sha256});
  });
  checkPathCollisions(captured.map(file=>file.path));
  if(total!==value.total_bytes||
     value.file_counts.evidence_log!==0||value.file_counts.frame_capture!==0||
     Object.keys(counts).some(key=>value.file_counts?.[key.toLowerCase()]!==counts[key]))rejected();
  return Object.freeze(captured);
}
async function loadSnapshot(spec,ports,verification,stageAck,profile){
  const manifestBytes=await readStableFile(ports,join(spec.snapshot_dir,'export-manifest.json'),MAX_EXPORT_MANIFEST_BYTES);
  try{
    if(sha256(manifestBytes)!==verification.manifest_sha256)rejected();
    const manifest=parseReceiptJson(manifestBytes);
    const files=validateManifest(manifest,verification,spec,stageAck,profile);
    const contents=[];let retained=false;
    try{
      for(const file of files){
        const cap=profile.classes[file.classification].file;
        const bytes=await readStableFile(ports,join(spec.snapshot_dir,'project',file.path),cap);
        if(bytes.length!==file.bytes||sha256(bytes)!==file.sha256){bytes.fill(0);rejected();}
        contents.push(Object.freeze({...file,bytes_data:bytes}));
      }
      retained=true;
      return Object.freeze({files:Object.freeze(contents),manifest_sha256:verification.manifest_sha256,total_bytes:verification.total_bytes});
    }finally{if(!retained)for(const file of contents)file.bytes_data.fill(0);}
  }finally{manifestBytes.fill(0);}
}
function compareSnapshotToAllowed(snapshot,spec){
  if(snapshot.files.length!==spec.allowed_changes.length)rejected();
  const files=[...snapshot.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const allowed=[...spec.allowed_changes].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  for(let i=0;i<files.length;i++)if(files[i].path!==allowed[i].path)rejected();
  return files;
}
async function inspectBase(spec,ports){
  const raw=await checked(ports,()=>ports.git.inspectCommit({
    git_dir:spec.base_git_dir,oid:spec.base_commit,max_bytes:65536
  }));
  const commitBytes=plainBytes(raw,65536);
  try{
    const commit=parseRawCommit(commitBytes,spec.base_commit);
    if(commit.tree!==spec.base_tree)rejected();
    const rawListing=await checked(ports,()=>ports.git.inspectTree({
      git_dir:spec.base_git_dir,oid:spec.base_tree,
      max_entries:MAX_BASE_ENTRIES,max_metadata_bytes:MAX_BASE_METADATA_BYTES
    }));
    const listing=parseTreeListing(rawListing,MAX_BASE_ENTRIES,MAX_BASE_METADATA_BYTES);
    const entries=listing.files;
    const byPath=new Map(entries.map(entry=>[entry.path,entry]));
    return Object.freeze({commit,entries,trees:listing.trees,byPath});
  }finally{commitBytes.fill(0);}
}
async function verifyBasePreimages(spec,ports,base){
  checkPathCollisions([...base.entries.map(entry=>entry.path),...spec.allowed_changes.map(item=>item.path)]);
  for(const allow of spec.allowed_changes){
    const prior=base.byPath.get(allow.path);
    if(allow.original===null){if(prior)rejected();continue;}
    if(!prior||prior.oid!==allow.original.blob)rejected();
    const bytes=plainBytes(await checked(ports,()=>ports.git.readBlob({
      git_dir:spec.base_git_dir,oid:prior.oid,max_bytes:allow.original.bytes
    })),MAX_PROJECT_BYTES);
    try{
      if(bytes.length!==allow.original.bytes||sha256(bytes)!==allow.original.sha256||
         gitObjectId('blob',bytes)!==allow.original.blob)rejected();
    }finally{bytes.fill(0);}
  }
}
function bytesEqual(left,right){
  if(left.length!==right.length)return false;
  for(let i=0;i<left.length;i++)if(left[i]!==right[i])return false;
  return true;
}
async function deriveOverlay(spec,ports,base,snapshotFiles){
  const overlay=[];
  for(const file of snapshotFiles){
    const allow=spec.allowed_changes.find(item=>item.path===file.path);
    if(!allow)rejected();
    const prior=base.byPath.get(file.path);
    if(allow.original===null){if(prior)rejected();}
    else{
      if(!prior||prior.oid!==allow.original.blob)rejected();
      const bytes=plainBytes(await checked(ports,()=>ports.git.readBlob({
        git_dir:spec.base_git_dir,oid:prior.oid,max_bytes:allow.original.bytes
      })),MAX_PROJECT_BYTES);
      try{
        if(bytes.length!==allow.original.bytes||sha256(bytes)!==allow.original.sha256||
           gitObjectId('blob',bytes)!==allow.original.blob)rejected();
        if(bytesEqual(bytes,file.bytes_data)){
          overlay.push(Object.freeze({...prior}));
        }else{
          overlay.push(Object.freeze({path:file.path,mode:'100644',oid:null,bytes_data:file.bytes_data}));
        }
      }finally{bytes.fill(0);}
    }
    if(allow.original===null)overlay.push(Object.freeze({
      path:file.path,mode:'100644',oid:null,bytes_data:file.bytes_data
    }));
  }
  return Object.freeze(overlay);
}
function mergeEntries(base,overlay){
  const changedByPath=new Map(overlay.map(item=>[item.path,item]));
  const final=[];
  for(const entry of base.entries){
    const changed=changedByPath.get(entry.path);
    final.push(changed?Object.freeze({path:entry.path,mode:changed.mode,oid:changed.oid,bytes_data:changed.bytes_data}):entry);
    changedByPath.delete(entry.path);
  }
  for(const changed of changedByPath.values())final.push(changed);
  final.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return Object.freeze(final);
}
function changedPaths(baseEntries,finalEntries){
  const before=new Map(baseEntries.map(entry=>[entry.path,entry]));
  const after=new Map(finalEntries.map(entry=>[entry.path,entry]));
  const paths=[...new Set([...before.keys(),...after.keys()])];
  return Object.freeze(paths.filter(path=>{
    const a=before.get(path),b=after.get(path);
    return !a||!b||a.mode!==b.mode||a.oid!==b.oid;
  }).sort());
}
function expectedTreePaths(entries){
  const paths=new Set();
  for(const entry of entries){
    const parts=entry.path.split('/');
    for(let i=1;i<parts.length;i++)paths.add(parts.slice(0,i).join('/'));
  }
  return [...paths].sort();
}
async function createCandidateTree(spec,ports,entries,baseObjects){
  await reserveDirectory(ports,spec.candidate_dir);
  await checked(ports,()=>ports.git.initBare({git_dir:spec.candidate_dir}));
  await installBaseAlternate(spec,ports,baseObjects);
  const resolved=[];
  for(const entry of entries){
    if(entry.bytes_data){
      const expected=gitObjectId('blob',entry.bytes_data);
      const written=await checked(ports,()=>ports.git.writeBlob({
        git_dir:spec.candidate_dir,bytes:plainBytes(entry.bytes_data,MAX_PROJECT_BYTES)
      }));
      if(!SHA1.test(written)||written!==expected)rejected();
      resolved.push(Object.freeze({path:entry.path,mode:'100644',oid:written}));
    }else resolved.push(Object.freeze({path:entry.path,mode:entry.mode,oid:entry.oid}));
  }
  const tree=await checked(ports,()=>ports.git.writeTree({git_dir:spec.candidate_dir,entries:resolved}));
  if(!SHA1.test(tree))rejected();
  const listing=await checked(ports,()=>ports.git.inspectTree({
    git_dir:spec.candidate_dir,oid:tree,max_entries:MAX_CANDIDATE_ENTRIES,
    max_metadata_bytes:MAX_CANDIDATE_METADATA_BYTES
  }));
  const observed=parseTreeListing(listing,MAX_CANDIDATE_ENTRIES,MAX_CANDIDATE_METADATA_BYTES);
  const expectedDirs=expectedTreePaths(resolved),actualDirs=observed.trees.map(entry=>entry.path);
  if(observed.files.length!==resolved.length||observed.files.some((entry,index)=>
    entry.path!==resolved[index].path||entry.mode!==resolved[index].mode||entry.oid!==resolved[index].oid
  )||actualDirs.length!==expectedDirs.length||actualDirs.some((path,index)=>path!==expectedDirs[index]))rejected();
  return Object.freeze({tree,entries:Object.freeze(resolved)});
}
async function buildCommit(spec,ports,tree){
  const commit=await checked(ports,()=>ports.git.writeCommit({
    git_dir:spec.candidate_dir,tree,parent:spec.base_commit
  }));
  if(!SHA1.test(commit))rejected();
  const raw=plainBytes(await checked(ports,()=>ports.git.inspectCommit({
    git_dir:spec.candidate_dir,oid:commit,max_bytes:65536
  })),65536);
  try{
    const parsed=parseRawCommit(raw,commit);
    if(parsed.tree!==tree||parsed.parents.length!==1||parsed.parents[0]!==spec.base_commit)rejected();
  }finally{raw.fill(0);}
  return commit;
}
// Git tree IDs can be derived from already-verified entries without writing
// any object or ref to the prior candidate or to the base repository.
function entriesTreeOid(entries){
  const root={files:[],dirs:new Map()};
  for(const entry of entries){
    const parts=entry.path.split('/');let node=root;
    for(const part of parts.slice(0,-1)){
      if(!node.dirs.has(part))node.dirs.set(part,{files:[],dirs:new Map()});
      node=node.dirs.get(part);
    }
    node.files.push({name:parts.at(-1),mode:entry.mode,oid:entry.oid??gitObjectId('blob',entry.bytes_data),directory:false});
  }
  const visit=node=>{
    const rows=[...node.files];
    for(const [name,child] of node.dirs)rows.push({name,mode:'40000',oid:visit(child),directory:true});
    rows.sort((a,b)=>Buffer.compare(Buffer.from(`${a.name}${a.directory?'/':'\0'}`),Buffer.from(`${b.name}${b.directory?'/':'\0'}`)));
    return gitObjectId('tree',Buffer.concat(rows.flatMap(row=>[
      Buffer.from(`${row.mode} ${row.name}\0`,'utf8'),Buffer.from(row.oid,'hex')
    ])));
  };
  return visit(root);
}
async function validatePriorCandidate(spec,ports,revision,baseEntries,snapshotFiles){
  const prior=revision.prior_candidate;
  await ancestorChecks(ports,prior.git_dir);
  const stat=await lstat(ports,prior.git_dir);
  if(!statKind(stat,'directory')||stat.uid!==ports.uid||(stat.mode&0o022)!==0||
     stat.dev!==prior.identity.dev||stat.ino!==prior.identity.ino)rejected();
  await realPathIsSelf(ports,prior.git_dir);
  for(const name of ['commondir','gitdir'])if(!await absent(ports,join(prior.git_dir,name)))rejected();
  for(const path of [join(prior.git_dir,'objects'),join(prior.git_dir,'objects','info')]){
    const item=await lstat(ports,path);
    if(!statKind(item,'directory')||item.uid!==ports.uid||(item.mode&0o022)!==0)rejected();
    await realPathIsSelf(ports,path);
  }
  const alternate=await readStableFile(ports,join(prior.git_dir,'objects','info','alternates'),4096,0o600);
  try{if(!bytesEqual(alternate,encoder.encode(`${join(spec.base_git_dir,'objects')}\n`)))rejected();}
  finally{alternate.fill(0);}
  const expectedEntries=baseEntries.map(entry=>Object.freeze({
    path:entry.path,mode:entry.mode,oid:entry.oid??gitObjectId('blob',entry.bytes_data)
  }));
  if(entriesTreeOid(expectedEntries)!==prior.tree)rejected();
  const raw=plainBytes(await checked(ports,()=>ports.git.inspectCommit({
    git_dir:prior.git_dir,oid:prior.commit,max_bytes:65536
  })),65536);
  try{
    const commit=parseRawCommit(raw,prior.commit);
    if(commit.tree!==prior.tree||commit.parents.length!==1||commit.parents[0]!==spec.base_commit)rejected();
  }finally{raw.fill(0);}
  const observed=parseTreeListing(await checked(ports,()=>ports.git.inspectTree({
    git_dir:prior.git_dir,oid:prior.tree,max_entries:MAX_CANDIDATE_ENTRIES,
    max_metadata_bytes:MAX_CANDIDATE_METADATA_BYTES
  })),MAX_CANDIDATE_ENTRIES,MAX_CANDIDATE_METADATA_BYTES);
  if(observed.files.length!==expectedEntries.length||observed.files.some((entry,index)=>
    entry.path!==expectedEntries[index].path||entry.mode!==expectedEntries[index].mode||entry.oid!==expectedEntries[index].oid
  )||observed.trees.map(entry=>entry.path).join('\0')!==expectedTreePaths(expectedEntries).join('\0'))rejected();
  const ref=`refs/heads/candidate-${prior.operation_id}`;
  if(await checked(ports,()=>ports.git.readRef({git_dir:prior.git_dir,ref}))!==prior.commit)rejected();
  for(const file of snapshotFiles){
    const oid=gitObjectId('blob',file.bytes_data);
    const bytes=plainBytes(await checked(ports,()=>ports.git.readBlob({
      git_dir:prior.git_dir,oid,max_bytes:file.bytes
    })),MAX_PROJECT_BYTES);
    try{if(!bytesEqual(bytes,file.bytes_data)||gitObjectId('blob',bytes)!==oid)rejected();}
    finally{bytes.fill(0);}
  }
  const after=await lstat(ports,prior.git_dir);
  if(!stable(stat,after)||!statKind(after,'directory')||after.uid!==ports.uid||(after.mode&0o022)!==0)rejected();
}
function revisedSnapshotFiles(revision,snapshotFiles){
  const counts={SOURCE:0,LOCAL_ASSET:0,DOC:0},totals={SOURCE:0,LOCAL_ASSET:0,DOC:0};
  let total=0;
  return snapshotFiles.map(file=>{
    const correction=revision.corrections.find(item=>item.path===file.path);
    const caps=PROJECT_CLASSES[file.classification];
    let bytes=file.bytes_data;
    if(correction){
      if(correction.original.blob!==gitObjectId('blob',bytes)||
         correction.original.bytes!==bytes.length||correction.original.sha256!==sha256(bytes)||
         bytesEqual(bytes,correction.bytes_data))rejected();
      bytes=correction.bytes_data;
    }
    counts[file.classification]++;totals[file.classification]+=bytes.length;total+=bytes.length;
    if((file.classification==='SOURCE'&&bytes.length===0)||bytes.length>caps.file||counts[file.classification]>caps.count||totals[file.classification]>caps.total||total>MAX_PROJECT_BYTES)rejected();
    return Object.freeze({...file,bytes_data:bytes,bytes:bytes.length,sha256:sha256(bytes)});
  });
}
function revisionResult(spec,stageAck,tree,commit,paths,revision){
  return Object.freeze({...resultValue(spec,stageAck,tree,commit,paths),
    schema:'SQUIRE_PROJECT_REVISION_CANDIDATE_V1',status:'SOURCE_REVISION_CANDIDATE_CREATED',
    correction_origin:'OPERATOR_SUPPLIED',
    revision_of:Object.freeze({commit:revision.prior_candidate.commit,tree:revision.prior_candidate.tree}),
    revised_blobs:Object.freeze([...revision.corrections].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(item=>Object.freeze({
      path:item.path,previous_blob:item.original.blob,previous_bytes:item.original.bytes,
      previous_sha256:item.original.sha256,blob:gitObjectId('blob',item.bytes_data),
      bytes:item.bytes_data.length,sha256:sha256(item.bytes_data)
    })))
  });
}

function resultValue(spec,stageAck,candidateTree,commit,paths){
  return Object.freeze({
    schema:RESULT_SCHEMA,status:'SOURCE_CANDIDATE_CREATED',operation_id:spec.operation_id,
    candidate_ref:`refs/heads/candidate-${spec.operation_id}`,
    base_commit:spec.base_commit,base_tree:spec.base_tree,
    candidate_commit:commit,candidate_tree:candidateTree,
    receipt_sha256:spec.receipt_sha256,stage_manifest_sha256:stageAck.manifest_sha256,
    changed_paths:Object.freeze([...paths]),task_correctness:'NOT_EVALUATED',
    human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',
    benchmark_acceptance:'NOT_ESTABLISHED',origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',
    base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'
  });
}
async function runImport(spec,ports,revision=null,profile=LARGE_IMPORT){
  let parsedReceipt=null,snapshot=null,finalSnapshot=null;
  try{
    checkAbort(ports.signal);
    if(spec.signal!==undefined&&spec.signal!==ports.signal)invalid();
    parsedReceipt=parseReceiptJson(spec.receipt_bytes);
    const summary=profile.large
      ?projectNativeProjectLargeObservationReceiptBytesSummary(spec.receipt_bytes)
      :projectNativeProjectRunSummary(parsedReceipt);
    if(summary?.readiness!=='CANDIDATE_STAGED'||summary.task_correctness!=='NOT_EVALUATED'||
       summary.task_outcome_evaluated!==false||summary.staging===null)rejected();
    if(profile.large)validateProjectOutputLargeProfile(summary.output_profile);
    if(summary.staging.completion_status!=='COMPLETE'||
       summary.staging.operation_acknowledgement!=='ACKNOWLEDGED'||
       summary.staging.manifest_sha256!==spec.stage_manifest_sha256)rejected();
    if(parsedReceipt?.schema!==profile.receiptSchema||
       !parsedReceipt.result||parsedReceipt.result.status!=='CANDIDATE_STAGED')rejected();
    const stageAck=parsedReceipt.result.staging;
    try{closed(stageAck,[
      'schema_version',...(profile.large?['output_profile']:[]),'stage_operation_id','caller_label',
      'completion_status','manifest_sha256','file_count','total_bytes',
      'operation_acknowledgement','provenance_authenticity','crash_durability'
    ],[],'stage_ack');}catch{rejected();}
    if(stageAck.schema_version!==profile.stageSchema||
       stageAck.caller_label!=='project_candidate_stager'||
       stageAck.completion_status!=='COMPLETE'||
       stageAck.operation_acknowledgement!=='ACKNOWLEDGED'||
       stageAck.manifest_sha256!==spec.stage_manifest_sha256||
       stageAck.manifest_sha256!==summary.staging.manifest_sha256||
       stageAck.file_count!==summary.staging.file_count||
       stageAck.total_bytes!==summary.staging.total_bytes||
       stageAck.provenance_authenticity!=='NOT_ESTABLISHED'||
       stageAck.crash_durability!=='NOT_ESTABLISHED'||!TOKEN.test(stageAck.stage_operation_id))rejected();
    if(profile.large)validateProjectOutputLargeProfile(stageAck.output_profile);

    // Pin and verify the complete explicit base before reading stage content or
    // creating the export snapshot. These checks bind every declared preimage.
    const baseObjects=await validateBaseDirectory(spec,ports);
    const base=await inspectBase(spec,ports);
    await verifyBasePreimages(spec,ports,base);

    const stageVerification=await checked(ports,()=>profile.verifyStage(
      spec.stage_dir,{fs:ports.fs,uid:ports.uid,signal:ports.signal}
    ));
    if(stageVerification.status!=='VERIFIED'||
       stageVerification.stage_operation_id!==stageAck.stage_operation_id||
       stageVerification.manifest_sha256!==stageAck.manifest_sha256||
       stageVerification.file_count!==stageAck.file_count||
       stageVerification.total_bytes!==stageAck.total_bytes)rejected();

    await checked(ports,()=>profile.buildExport({
      export_operation_id:spec.operation_id,caller_label:'project_review_candidate',
      ...(profile.large?{output_profile:PROJECT_OUTPUT_LARGE_PROFILE}:{}),stage_dir:spec.stage_dir,
      export_dir:spec.snapshot_dir,stage_manifest_sha256:spec.stage_manifest_sha256,
      evidence_files:[]
    },{fs:ports.fs,uid:ports.uid,signal:ports.signal}));
    const exportVerification=await checked(ports,()=>profile.verifyExport(
      spec.snapshot_dir,{fs:ports.fs,uid:ports.uid,signal:ports.signal}
    ));
    if(exportVerification.status!=='VERIFIED'||
       exportVerification.stage_binding?.stage_operation_id!==stageAck.stage_operation_id||
       exportVerification.stage_binding?.stage_manifest_sha256!==spec.stage_manifest_sha256||
       exportVerification.total_files!==stageAck.file_count||
       exportVerification.total_bytes!==stageAck.total_bytes)rejected();
    snapshot=await loadSnapshot(spec,ports,exportVerification,stageAck,profile);
    const snapshotFiles=compareSnapshotToAllowed(snapshot,spec);

    const originalOverlay=await deriveOverlay(spec,ports,base,snapshotFiles);
    const originalEntries=mergeEntries(base,originalOverlay);
    if(revision){
      if(changedPaths(base.entries,originalEntries).length===0)rejected();
      await validatePriorCandidate(spec,ports,revision,originalEntries,snapshotFiles);
    }
    const overlay=revision
      ?await deriveOverlay(spec,ports,base,revisedSnapshotFiles(revision,snapshotFiles))
      :originalOverlay;
    const finalEntries=mergeEntries(base,overlay);
    const changes=changedPaths(base.entries,finalEntries);
    if(changes.length===0||changes.some(path=>!spec.allowed_changes.some(item=>item.path===path)))rejected();

    const tree=await createCandidateTree(spec,ports,finalEntries,baseObjects);
    const commit=await buildCommit(spec,ports,tree.tree);

    const finalStage=await checked(ports,()=>profile.verifyStage(
      spec.stage_dir,{fs:ports.fs,uid:ports.uid,signal:ports.signal}
    ));
    if(finalStage.status!=='VERIFIED'||finalStage.stage_operation_id!==stageAck.stage_operation_id||
       finalStage.manifest_sha256!==stageAck.manifest_sha256||
       finalStage.file_count!==stageAck.file_count||finalStage.total_bytes!==stageAck.total_bytes)rejected();
    const finalExport=await checked(ports,()=>profile.verifyExport(
      spec.snapshot_dir,{fs:ports.fs,uid:ports.uid,signal:ports.signal}
    ));
    if(finalExport.status!=='VERIFIED'||finalExport.manifest_sha256!==snapshot.manifest_sha256||
       finalExport.stage_binding?.stage_operation_id!==stageAck.stage_operation_id||
       finalExport.stage_binding?.stage_manifest_sha256!==spec.stage_manifest_sha256)rejected();
    finalSnapshot=await loadSnapshot(spec,ports,finalExport,stageAck,profile);
    if(finalSnapshot.manifest_sha256!==snapshot.manifest_sha256||
       finalSnapshot.files.length!==snapshot.files.length||
       finalSnapshot.files.some((file,index)=>file.path!==snapshot.files[index].path||
         file.bytes!==snapshot.files[index].bytes||file.sha256!==snapshot.files[index].sha256||
         gitObjectId('blob',file.bytes_data)!==gitObjectId('blob',snapshot.files[index].bytes_data)))rejected();

    const observedCommitBytes=plainBytes(await checked(ports,()=>ports.git.inspectCommit({
      git_dir:spec.candidate_dir,oid:commit,max_bytes:65536
    })),65536);
    try{
      const candidateCommit=parseRawCommit(observedCommitBytes,commit);
      if(candidateCommit.tree!==tree.tree||candidateCommit.parents.length!==1||candidateCommit.parents[0]!==spec.base_commit)rejected();
    }finally{observedCommitBytes.fill(0);}
    const observedTree=parseTreeListing(await checked(ports,()=>ports.git.inspectTree({
      git_dir:spec.candidate_dir,oid:tree.tree,max_entries:MAX_CANDIDATE_ENTRIES,
      max_metadata_bytes:MAX_CANDIDATE_METADATA_BYTES
    })),MAX_CANDIDATE_ENTRIES,MAX_CANDIDATE_METADATA_BYTES);
    const expectedDirs=expectedTreePaths(tree.entries),actualDirs=observedTree.trees.map(entry=>entry.path);
    if(observedTree.files.length!==tree.entries.length||observedTree.files.some((entry,index)=>
      entry.path!==tree.entries[index].path||entry.mode!==tree.entries[index].mode||entry.oid!==tree.entries[index].oid
    )||actualDirs.length!==expectedDirs.length||actualDirs.some((path,index)=>path!==expectedDirs[index]))rejected();

    if(revision)await validatePriorCandidate(spec,ports,revision,originalEntries,snapshotFiles);

    const ref=`refs/heads/candidate-${spec.operation_id}`;
    if(await checked(ports,()=>ports.git.readRef({git_dir:spec.candidate_dir,ref}))!==null)rejected();
    checkAbort(ports.signal);
    await checked(ports,()=>ports.git.createRef({
      git_dir:spec.candidate_dir,ref,oid:commit,old_oid:ZERO_OID
    }));
    if(await checked(ports,()=>ports.git.readRef({git_dir:spec.candidate_dir,ref}))!==commit)rejected();
    checkAbort(ports.signal);
    return revision?revisionResult(spec,stageAck,tree.tree,commit,changes,revision):resultValue(spec,stageAck,tree.tree,commit,changes);
  }finally{
    spec.receipt_bytes.fill(0);
    for(const snapshotValue of [snapshot,finalSnapshot]){
      for(const file of snapshotValue?.files??[])file.bytes_data.fill(0);
    }
  }
}

/** Injected local-only bridge. Injected filesystem and Git ports are trusted capabilities. */
export async function buildProjectReviewCandidate(spec,ports){
  let captured=null,capabilities=null;
  try{
    captured=captureSpec(spec);
    capabilities=capturePorts(ports,captured.signal);
    return await runImport(captured,capabilities);
  }catch(error){
    if(error instanceof ReviewCandidateError)throw error;
    if(capabilities?.signal&&signalAborted(capabilities.signal))throw new ReviewCandidateError('PROJECT_REVIEW_CANDIDATE_ABORTED');
    throw new ReviewCandidateError('PROJECT_REVIEW_CANDIDATE_REJECTED');
  }finally{captured?.receipt_bytes.fill(0);}
}

/** Standard native receipt/stage intake. The existing large entry points stay distinct. */
export async function buildStandardProjectReviewCandidate(spec,ports){
  let captured=null,capabilities=null;
  try{
    captured=captureSpec(spec,STANDARD_SPEC_SCHEMA);
    capabilities=capturePorts(ports,captured.signal);
    return await runImport(captured,capabilities,null,STANDARD_IMPORT);
  }catch(error){
    if(error instanceof ReviewCandidateError)throw error;
    if(capabilities?.signal&&signalAborted(capabilities.signal))throw new ReviewCandidateError('PROJECT_REVIEW_CANDIDATE_ABORTED');
    throw new ReviewCandidateError('PROJECT_REVIEW_CANDIDATE_REJECTED');
  }finally{captured?.receipt_bytes.fill(0);}
}

/** First owner revision of an exact original stage-derived candidate. */
export async function buildProjectRevisionCandidate(spec,ports){
  let revision=null,capabilities=null;
  try{
    revision=captureRevisionSpec(spec);
    capabilities=capturePorts(ports,revision.original.signal);
    return await runImport(revision.original,capabilities,revision);
  }catch(error){
    if(error instanceof ReviewCandidateError)throw error;
    if(capabilities?.signal&&signalAborted(capabilities.signal))throw new ReviewCandidateError('PROJECT_REVIEW_CANDIDATE_ABORTED');
    throw new ReviewCandidateError('PROJECT_REVIEW_CANDIDATE_REJECTED');
  }finally{
    revision?.original.receipt_bytes.fill(0);
    for(const item of revision?.corrections??[])item.bytes_data.fill(0);
  }
}

const FIXED_GIT_CONFIG=Object.freeze([
  '-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
  '-c','protocol.allow=never','-c','commit.gpgsign=false',
  '-c','core.attributesFile=/dev/null','-c','core.autocrlf=false',
  '-c','gc.auto=0'
]);
function gitEnvironment(gitDir,init=false,extra={}){
  const env={
    PATH:'/usr/bin:/bin',HOME:'/nonexistent',GIT_PAGER:'cat',PAGER:'cat',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',
    GIT_NO_LAZY_FETCH:'1',...extra
  };
  if(!init){
    env.GIT_DIR=gitDir;
    if(basename(gitDir)==='.git')env.GIT_WORK_TREE=dirname(gitDir);
  }
  return env;
}
async function runGit(
  gitDir,args,input,maxStdout=4194304,maxStderr=65536,signal,init=false,
  extraEnv={},allowedCodes=[0]
){
  checkAbort(signal);
  const stdout=[],stderr=[];
  let outBytes=0,errBytes=0,overflow=false,childError=false,inputFailed=false;
  let stdoutEnded=false,stderrEnded=false,stdinFinished=false,listenerFailed=false;
  let child,inputBuffer=null;
  try{
    child=spawn('/usr/bin/git',[...FIXED_GIT_CONFIG,...args],{
      cwd:gitDir,env:gitEnvironment(gitDir,init,extraEnv),shell:false,
      windowsHide:true,stdio:['pipe','pipe','pipe']
    });
  }catch{rejected();}
  let closed=false,listening=false;
  let resolveClose;
  const closePromise=new Promise(resolvePromise=>{resolveClose=resolvePromise;});
  child.once('close',(code,signalName)=>{closed=true;resolveClose({code,signalName});});
  const failChild=()=>{childError=true;try{child.kill('SIGTERM');}catch{}};
  child.on('error',failChild);
  child.stdout.on('error',failChild);
  child.stderr.on('error',failChild);
  child.stdout.on('data',chunk=>{
    outBytes+=chunk.length;
    if(outBytes>maxStdout){overflow=true;try{child.kill('SIGKILL');}catch{};return;}
    stdout.push(Buffer.from(chunk));
  });
  child.stderr.on('data',chunk=>{
    errBytes+=chunk.length;
    if(errBytes>maxStderr){overflow=true;try{child.kill('SIGKILL');}catch{};return;}
    stderr.push(Buffer.from(chunk));
  });
  child.stdout.once('end',()=>{stdoutEnded=true;});
  child.stderr.once('end',()=>{stderrEnded=true;});
  child.stdin.once('finish',()=>{stdinFinished=true;});
  child.stdin.on('error',()=>{inputFailed=true;});
  const abort=()=>{try{child.kill('SIGTERM');}catch{}};
  if(signal!==undefined){
    try{Reflect.apply(ADD_EVENT_LISTENER,signal,['abort',abort,{once:true}]);listening=true;}
    catch{listenerFailed=true;try{child.kill('SIGKILL');}catch{}}
    try{if(signalAborted(signal))abort();}catch{listenerFailed=true;try{child.kill('SIGKILL');}catch{}}
  }
  try{
    if(input!==null&&input!==undefined)inputBuffer=Buffer.from(input);
    child.stdin.end(inputBuffer??undefined);
  }
  catch{inputFailed=true;try{child.kill('SIGKILL');}catch{}}
  const closedResult=await closePromise;
  inputBuffer?.fill(0);inputBuffer=null;
  if(listening){try{Reflect.apply(REMOVE_EVENT_LISTENER,signal,['abort',abort]);}catch{listenerFailed=true;}}
  checkAbort(signal);
  if(!closed||childError||overflow||inputFailed||listenerFailed||!stdoutEnded||!stderrEnded||
     !stdinFinished||!allowedCodes.includes(closedResult.code)||closedResult.signalName!==null)rejected();
  return Object.freeze({
    code:closedResult.code,
    stdout:Buffer.concat(stdout,outBytes),stderr:Buffer.concat(stderr,errBytes)
  });
}
function outputOid(bytes){
  let text;
  try{text=decoder.decode(bytes);}catch{rejected();}
  const match=/^([a-f0-9]{40})\n$/.exec(text);
  if(!match)rejected();
  return match[1];
}
function checkGitDir(gitDir){
  if(typeof gitDir!=='string'||!absolutePath(gitDir)||/[\r\n\\]/u.test(gitDir))rejected();
}
async function nativeVerifyRepositoryProfile(gitDir,signal){
  const expectedBare=basename(gitDir)!=='.git';
  const bare=await runGit(gitDir,['rev-parse','--is-bare-repository'],null,64,4096,signal);
  if(bare.stdout.toString('ascii')!==`${expectedBare?'true':'false'}\n`)rejected();
  if(!expectedBare){
    const top=await runGit(gitDir,['rev-parse','--show-toplevel'],null,4096,4096,signal);
    if(top.stdout.toString('utf8')!==`${dirname(gitDir)}\n`)rejected();
  }
  const format=await runGit(gitDir,['rev-parse','--show-object-format'],null,64,4096,signal);
  if(format.stdout.toString('ascii')!=='sha1\n')rejected();
}
async function nativeInspectCommit({git_dir,oid,max_bytes},signal){
  checkGitDir(git_dir);if(!SHA1.test(oid)||max_bytes!==65536)rejected();
  await nativeVerifyRepositoryProfile(git_dir,signal);
  const result=await runGit(git_dir,['cat-file','commit',oid],null,max_bytes,4096,signal);
  return new Uint8Array(result.stdout);
}
function parseLsTree(bytes,maxEntries){
  const entries=[];let offset=0,files=0;
  while(offset<bytes.length){
    const end=bytes.indexOf(0,offset);if(end<0)rejected();
    const record=bytes.subarray(offset,end),tab=record.indexOf(9);if(tab<0)rejected();
    let header,path;
    try{header=decoder.decode(record.subarray(0,tab));path=decoder.decode(record.subarray(tab+1));}catch{rejected();}
    const match=/^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})$/.exec(header);if(!match)rejected();
    entries.push({path,mode:match[1],type:match[2],oid:match[3]});
    if(match[2]==='blob')files++;
    offset=end+1;
    if(entries.length>MAX_BASE_TREE_RECORDS||files>maxEntries)rejected();
  }
  return entries;
}
async function nativeInspectTree({git_dir,oid,max_entries,max_metadata_bytes},signal){
  checkGitDir(git_dir);if(!SHA1.test(oid)||!Number.isSafeInteger(max_entries)||max_entries<0||
     max_entries>MAX_CANDIDATE_ENTRIES||!Number.isSafeInteger(max_metadata_bytes)||
     max_metadata_bytes<0||max_metadata_bytes>MAX_CANDIDATE_METADATA_BYTES)rejected();
  await nativeVerifyRepositoryProfile(git_dir,signal);
  const output=await runGit(git_dir,['ls-tree','-rtz','--full-tree',oid],null,max_metadata_bytes,4096,signal);
  const entries=parseLsTree(output.stdout,max_entries);
  return Object.freeze({object_format:'sha1',entries:Object.freeze(entries.map(entry=>Object.freeze(entry)))});
}
async function nativeReadBlob({git_dir,oid,max_bytes},signal){
  checkGitDir(git_dir);if(!SHA1.test(oid)||!Number.isSafeInteger(max_bytes)||max_bytes<0||max_bytes>MAX_PROJECT_BYTES)rejected();
  const output=await runGit(git_dir,['cat-file','blob',oid],null,max_bytes+1,4096,signal);
  if(output.stdout.length>max_bytes)rejected();
  return new Uint8Array(output.stdout);
}
async function nativeInitBare({git_dir},signal){
  checkGitDir(git_dir);
  await runGit(git_dir,['init','--bare','--shared=0600','--template=','--object-format=sha1'],null,4096,65536,signal,true);
  await nativeVerifyRepositoryProfile(git_dir,signal);
}
async function nativeWriteBlob({git_dir,bytes},signal){
  checkGitDir(git_dir);const copy=plainBytes(bytes,MAX_PROJECT_BYTES);
  try{
    const output=await runGit(git_dir,['hash-object','--no-filters','-w','--stdin'],copy,128,4096,signal);
    return outputOid(new Uint8Array(output.stdout));
  }finally{copy.fill(0);}
}
function treeSortKey(entry){return `${entry.path}${entry.type==='tree'?'/':'\0'}`;}
async function nativeWriteTree({git_dir,entries},signal){
  checkGitDir(git_dir);
  const list=denseArray(entries,MAX_CANDIDATE_ENTRIES).map(entry=>{
    try{closed(entry,['path','mode','oid'],[],'write_tree_entry');}catch{rejected();}
    if(!baseRelative(entry.path)||!['100644','100755'].includes(entry.mode)||!SHA1.test(entry.oid))rejected();
    return {path:entry.path,mode:entry.mode,oid:entry.oid};
  });
  checkPathCollisions(list.map(entry=>entry.path));
  if(new Set(list.map(entry=>entry.path)).size!==list.length)rejected();
  const root={files:[],dirs:new Map()};
  for(const entry of list){
    const parts=entry.path.split('/');let node=root;
    for(const part of parts.slice(0,-1)){
      if(!node.dirs.has(part))node.dirs.set(part,{files:[],dirs:new Map()});
      node=node.dirs.get(part);
    }
    node.files.push({name:parts.at(-1),type:'blob',mode:entry.mode,oid:entry.oid});
  }
  const writeNode=async node=>{
    const rows=[...node.files];
    for(const [name,child] of node.dirs)rows.push({name,type:'tree',mode:'040000',oid:await writeNode(child)});
    rows.sort((a,b)=>treeSortKey(a)<treeSortKey(b)?-1:treeSortKey(a)>treeSortKey(b)?1:0);
    const chunks=[];
    for(const row of rows)chunks.push(Buffer.from(`${row.mode} ${row.type} ${row.oid}\t${row.name}\0`,'utf8'));
    const input=Buffer.concat(chunks);
    const output=await runGit(git_dir,['mktree','-z'],input,128,4096,signal);
    return outputOid(new Uint8Array(output.stdout));
  };
  return writeNode(root);
}
async function nativeWriteCommit({git_dir,tree,parent},signal){
  checkGitDir(git_dir);if(!SHA1.test(tree)||!SHA1.test(parent))rejected();
  const date=new Date().toISOString();
  const args=[
    '-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',
    '-c','user.name=Squire Project Review','-c','user.email=squire-review@invalid.example',
    'commit-tree',tree,'-p',parent,'-F','-'
  ];
  const env={
    GIT_AUTHOR_NAME:'Squire Project Review',GIT_AUTHOR_EMAIL:'squire-review@invalid.example',
    GIT_COMMITTER_NAME:'Squire Project Review',GIT_COMMITTER_EMAIL:'squire-review@invalid.example',
    GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date
  };
  const message=encoder.encode('Squire local project review candidate\n');
  const output=await runGit(git_dir,args,message,128,4096,signal,false,env);
  return outputOid(new Uint8Array(output.stdout));
}
async function nativeReadRef({git_dir,ref},signal){
  checkGitDir(git_dir);if(!/^refs\/heads\/candidate-[A-Za-z0-9_-]{1,64}$/.test(ref))rejected();
  const output=await runGit(git_dir,['rev-parse','--verify','--quiet',ref],null,64,4096,signal,false,{},[0,1]);
  if(output.code===1&&output.stdout.length===0&&output.stderr.length===0)return null;
  return outputOid(new Uint8Array(output.stdout));
}
async function nativeCreateRef({git_dir,ref,oid,old_oid},signal){
  checkGitDir(git_dir);
  if(!/^refs\/heads\/candidate-[A-Za-z0-9_-]{1,64}$/.test(ref)||!SHA1.test(oid)||old_oid!==ZERO_OID)rejected();
  await runGit(git_dir,['-c','core.hooksPath=/dev/null','update-ref',ref,oid,old_oid],null,0,4096,signal);
}
function createNativeProjectReviewGitPort(signal){
  return Object.freeze({
    inspectCommit:args=>nativeInspectCommit(args,signal),
    inspectTree:args=>nativeInspectTree(args,signal),
    readBlob:args=>nativeReadBlob(args,signal),
    initBare:args=>nativeInitBare(args,signal),
    writeBlob:args=>nativeWriteBlob(args,signal),
    writeTree:args=>nativeWriteTree(args,signal),
    writeCommit:args=>nativeWriteCommit(args,signal),
    readRef:args=>nativeReadRef(args,signal),
    createRef:args=>nativeCreateRef(args,signal)
  });
}
function nativeArtifactCheckPorts(signal){
  const git=createNativeProjectReviewGitPort(signal);
  return Object.freeze({...nativeArtifactCheckPortsImpl(signal),git});
}
function nativeArtifactCheckPortsImpl(signal){
  const check=()=>checkAbort(signal);
  const readdir=async path=>{
    let directory=null,failed=false,failure;const names=[];
    try{
      check();directory=await fs.opendir(path,{bufferSize:1});check();
      while(true){check();const entry=await directory.read();check();if(entry===null)break;
        if(names.length===71)throw new Error('DIRECTORY_LIMIT');names.push(entry.name);}
    }catch(error){failed=true;failure=error;}
    finally{if(directory!==null){try{await directory.close();}catch(error){if(!failed){failed=true;failure=error;}}}}
    check();if(failed)throw failure;return names;
  };
  return Object.freeze({
    fs:Object.freeze({open:fs.open,mkdir:fs.mkdir,lstat:fs.lstat,chmod:fs.chmod,readdir,realpath:fs.realpath}),
    uid:process.getuid(),signal
  });
}
/** Fixed native filesystem/Git bridge. No source content is executed. */
export async function buildProjectReviewCandidateNative(spec){
  const captured=captureSpec(spec);
  const native=nativeArtifactCheckPorts(captured.signal);
  try{return await buildProjectReviewCandidate(captured,{...native,signal:captured.signal});}
  finally{captured.receipt_bytes.fill(0);}
}

/** Fixed native standard adapter; no generated source is executed. */
export async function buildStandardProjectReviewCandidateNative(spec){
  const captured=captureSpec(spec,STANDARD_SPEC_SCHEMA);
  const native=nativeArtifactCheckPorts(captured.signal);
  try{return await buildStandardProjectReviewCandidate(captured,{...native,signal:captured.signal});}
  finally{captured.receipt_bytes.fill(0);}
}

/** Fixed native revision adapter; only fresh output receives Git writes. */
export async function buildProjectRevisionCandidateNative(spec){
  const captured=captureRevisionSpec(spec);
  const native=nativeArtifactCheckPorts(captured.original.signal);
  try{return await buildProjectRevisionCandidate(captured,{...native,signal:captured.original.signal});}
  finally{captured.original.receipt_bytes.fill(0);for(const item of captured.corrections)item.bytes_data.fill(0);}
}

function cliSpec(value){
  const allowed=[...SPEC_KEYS.filter(key=>key!=='receipt_bytes'),'receipt_path'];
  try{closed(value,allowed,[],'project_review_cli_spec');}catch{invalid();}
  if(typeof value.receipt_path!=='string'||!absolutePath(value.receipt_path))invalid();
  const descriptor=Object.getOwnPropertyDescriptor(value,'receipt_path');
  if(!descriptor||!Object.hasOwn(descriptor,'value'))invalid();
  return value.receipt_path;
}
function captureCliPorts(value){
  const keys=['readReceiptBytes','readCorrectionBytes','build','revise','stdout','stderr'];
  try{closed(value,[],keys,'project_review_cli_ports');}catch{invalid();}
  const output=key=>{
    const stream=value[key]??process[key];
    if(!stream||typeof stream.write!=='function'||types.isProxy(stream.write))invalid();
    return (...args)=>Reflect.apply(stream.write,stream,args);
  };
  const readMethod=value.readReceiptBytes??readReceiptBytes;
  const correctionMethod=value.readCorrectionBytes??readCorrectionBytes;
  const buildMethod=value.build??buildProjectReviewCandidateNative;
  const reviseMethod=value.revise??buildProjectRevisionCandidateNative;
  if(typeof readMethod!=='function'||types.isProxy(readMethod)||
     typeof buildMethod!=='function'||types.isProxy(buildMethod)||
     typeof reviseMethod!=='function'||types.isProxy(reviseMethod)||
     typeof correctionMethod!=='function'||types.isProxy(correctionMethod))invalid();
  return Object.freeze({
    read:(...args)=>Reflect.apply(readMethod,value,args),
    readCorrection:(...args)=>Reflect.apply(correctionMethod,value,args),
    build:(...args)=>Reflect.apply(buildMethod,value,args),
    revise:(...args)=>Reflect.apply(reviseMethod,value,args),
    stdout:output('stdout'),stderr:output('stderr')
  });
}
function validateCliResult(value){
  const keys=[
    'schema','status','operation_id','candidate_ref','base_commit','base_tree',
    'candidate_commit','candidate_tree','receipt_sha256','stage_manifest_sha256',
    'changed_paths','task_correctness','human_review','native_acceptance',
    'benchmark_acceptance','origin_authenticity','base_alternate_dependency'
  ];
  try{closed(value,keys,[],'project_review_result');}catch{rejected();}
  if(value.schema!==RESULT_SCHEMA||value.status!=='SOURCE_CANDIDATE_CREATED'||
     typeof value.operation_id!=='string'||!TOKEN.test(value.operation_id)||
     value.candidate_ref!==`refs/heads/candidate-${value.operation_id}`||
     typeof value.base_commit!=='string'||!SHA1.test(value.base_commit)||
     typeof value.base_tree!=='string'||!SHA1.test(value.base_tree)||
     typeof value.candidate_commit!=='string'||!SHA1.test(value.candidate_commit)||
     typeof value.candidate_tree!=='string'||!SHA1.test(value.candidate_tree)||
     typeof value.receipt_sha256!=='string'||!SHA256.test(value.receipt_sha256)||
     typeof value.stage_manifest_sha256!=='string'||!SHA256.test(value.stage_manifest_sha256)||
     value.task_correctness!=='NOT_EVALUATED'||value.human_review!=='PENDING'||
     value.native_acceptance!=='NOT_ESTABLISHED'||value.benchmark_acceptance!=='NOT_ESTABLISHED'||
     value.origin_authenticity!=='SUPPLIED_NOT_AUTHENTICATED'||
     value.base_alternate_dependency!=='READ_ONLY_BASE_OBJECT_ALTERNATE')rejected();
  let paths;
  try{paths=denseArray(value.changed_paths,50);}catch{rejected();}
  if(paths.length===0||paths.some(path=>!stageRelative(path)))rejected();
  for(let i=1;i<paths.length;i++)if(paths[i-1]>=paths[i])rejected();
  return paths.length;
}
// Correction files share the protected no-follow/stable-read policy, but not
// the receipt reader's independent 256KiB serialization cap.
async function readCorrectionBytes(path,maxBytes){
  if(!absolutePath(path)||!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>524288)invalid();
  return readStableFile(nativeArtifactCheckPortsImpl(undefined),path,maxBytes,0o400);
}
function validateRevisedBlobs(value){
  let items;
  try{items=denseArray(value,50);}catch{rejected();}
  if(items.length===0)rejected();
  let total=0,previousTotal=0,last=null;
  for(const item of items){
    try{closed(item,['path','previous_blob','previous_bytes','previous_sha256','blob','bytes','sha256'],[],'revised_blob');}catch{rejected();}
    if(!stageRelative(item.path)||(last!==null&&last>=item.path)||
       typeof item.previous_blob!=='string'||!SHA1.test(item.previous_blob)||
       typeof item.blob!=='string'||!SHA1.test(item.blob)||
       typeof item.previous_sha256!=='string'||!SHA256.test(item.previous_sha256)||
       typeof item.sha256!=='string'||!SHA256.test(item.sha256)||
       !Number.isSafeInteger(item.previous_bytes)||item.previous_bytes<0||item.previous_bytes>524288||
       !Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>524288||item.previous_blob===item.blob)rejected();
    total+=item.bytes;previousTotal+=item.previous_bytes;
    if(total>MAX_PROJECT_BYTES||previousTotal>MAX_PROJECT_BYTES)rejected();last=item.path;
  }
}

async function revisionCli(value,cli){
  try{closed(value,['schema','original','prior_candidate','corrections'],[],'revision_cli_spec');}catch{invalid();}
  const receiptPath=cliSpec(value.original),corrections=[];
  let receipt=null,total=0;
  try{
    receipt=plainBytes(await cli.read(receiptPath,MAX_RECEIPT_BYTES),MAX_RECEIPT_BYTES);
    for(const item of denseArray(value.corrections,50)){
      try{closed(item,['path','original','content_path'],[],'revision_cli_correction');}catch{invalid();}
      if(!absolutePath(item.content_path))invalid();
      const remaining=Math.min(524288,MAX_PROJECT_BYTES-total);
      const bytes=plainBytes(await cli.readCorrection(item.content_path,remaining),remaining);
      corrections.push({path:item.path,original:item.original,bytes_data:bytes});
      total+=bytes.length;if(total>MAX_PROJECT_BYTES)invalid();
    }
    const original={...value.original,receipt_bytes:receipt};delete original.receipt_path;
    const result=await cli.revise({schema:value.schema,original,prior_candidate:value.prior_candidate,corrections});
    try{closed(result,[
      'schema','status','operation_id','candidate_ref','base_commit','base_tree',
      'candidate_commit','candidate_tree','receipt_sha256','stage_manifest_sha256',
      'changed_paths','task_correctness','human_review','native_acceptance',
      'benchmark_acceptance','origin_authenticity','base_alternate_dependency',
      'correction_origin','revision_of','revised_blobs'
    ],[],'revision_cli_result');}catch{rejected();}
    if(result.schema!=='SQUIRE_PROJECT_REVISION_CANDIDATE_V1'||result.status!=='SOURCE_REVISION_CANDIDATE_CREATED'||
       result.correction_origin!=='OPERATOR_SUPPLIED')rejected();
    try{closed(result.revision_of,['commit','tree'],[],'revision_of');}catch{rejected();}
    if(typeof result.revision_of.commit!=='string'||!SHA1.test(result.revision_of.commit)||
       typeof result.revision_of.tree!=='string'||!SHA1.test(result.revision_of.tree))rejected();
    validateRevisedBlobs(result.revised_blobs);
    const {correction_origin,revision_of,revised_blobs,...common}=result;
    const count=validateCliResult({...common,schema:RESULT_SCHEMA,status:'SOURCE_CANDIDATE_CREATED'});
    cli.stdout([
      'SOURCE_REVISION_CANDIDATE_CREATED',`Base commit: ${result.base_commit}`,`Base tree: ${result.base_tree}`,
      `Candidate commit: ${result.candidate_commit}`,`Candidate tree: ${result.candidate_tree}`,
      `Revision of commit: ${revision_of.commit}`,`Revision of tree: ${revision_of.tree}`,`Changed path count: ${count}`,''
    ].join('\n'));
    return 0;
  }finally{receipt?.fill(0);for(const item of corrections)item.bytes_data.fill(0);}
}

export async function runProjectReviewCandidateCli(argv,ports={}){
  const cli=captureCliPorts(ports);
  if(!Array.isArray(argv)||argv.length!==2||!['--build','--revise'].includes(argv[0])||
     typeof argv[1]!=='string'||!absolutePath(argv[1])){
    cli.stderr('Usage: node bin/squire-project-review.mjs --build <spec.json>\n');
    return 2;
  }
  let receipt=null;
  try{
    const specBytes=plainBytes(await cli.read(argv[1],MAX_SPEC_BYTES),MAX_SPEC_BYTES);
    try{
      const value=parseReceiptJson(specBytes);
      if(argv[0]==='--revise')return await revisionCli(value,cli);
      const receiptPath=cliSpec(value);
      receipt=plainBytes(await cli.read(receiptPath,MAX_RECEIPT_BYTES),MAX_RECEIPT_BYTES);
      const mutable={...value,receipt_bytes:receipt};delete mutable.receipt_path;
      const result=await cli.build(mutable);
      const changedPathCount=validateCliResult(result);
      cli.stdout([
        'SOURCE_CANDIDATE_CREATED',
        `Base commit: ${result.base_commit}`,
        `Base tree: ${result.base_tree}`,
        `Candidate commit: ${result.candidate_commit}`,
        `Candidate tree: ${result.candidate_tree}`,
        `Changed path count: ${changedPathCount}`,
        ''
      ].join('\n'));
      return 0;
    }finally{specBytes.fill(0);}
  }catch{
    cli.stderr('PROJECT_REVIEW_CANDIDATE_REJECTED\n');
    return 2;
  }finally{receipt?.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await runProjectReviewCandidateCli(process.argv.slice(2));
}
