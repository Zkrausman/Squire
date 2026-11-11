// Bounded, private two-tree snapshot for one original PR210 review candidate.
// This module is inert on import and never executes candidate bytes.
import {spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,dirname,join,parse,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {types} from 'node:util';
import {AsyncLocalStorage} from 'node:async_hooks';

const REQUEST_SCHEMA='SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1';
const SNAPSHOT_SCHEMA='SQUIRE_PORTABLE_CANDIDATE_SNAPSHOT_V1';
const RESULT_SCHEMA='SQUIRE_PROJECT_REVIEW_CANDIDATE_V1';
const MAX_REQUEST_BYTES=65536;
const MAX_MANIFEST_BYTES=8*1024*1024;
const MAX_TOTAL_BYTES=64*1024*1024;
const MAX_OBJECT_BYTES=32*1024*1024;
const MAX_BLOB_BYTES=4*1024*1024;
const MAX_OBJECTS=8192;
const MAX_BASE_FILES=2048;
const MAX_CANDIDATE_FILES=2098;
const MAX_CHANGED_PATHS=50;
const MAX_BASE_METADATA_BYTES=4*1024*1024;
const MAX_CANDIDATE_METADATA_BYTES=MAX_BASE_METADATA_BYTES+MAX_CHANGED_PATHS*512;
const MAX_TREE_RECORDS=131072;
const MAX_COMMIT_BYTES=65536;
const MAX_GIT_STDERR=4096;
const MAX_BATCH_OVERHEAD=MAX_OBJECTS*96+65536;
// A candidate tree record creates at most one candidate-files entry. Changed
// preimages have at most seven path components; SHA-1 fanout has 256 buckets.
const MAX_OUTPUT_ENTRIES=MAX_TREE_RECORDS+MAX_CHANGED_PATHS*7+MAX_OBJECTS+256+4;
const SHA1=/^[a-f0-9]{40}$/;
const SHA256=/^[a-f0-9]{64}$/;
const TOKEN=/^[A-Za-z0-9_-]{1,64}$/;
const ZERO_OID='0000000000000000000000000000000000000000';
const utf8=new TextEncoder();
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const encoder=new TextEncoder();
const ABORTED_GETTER=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
const ADD_EVENT_LISTENER=EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER=EventTarget.prototype.removeEventListener;
const signalPrototype=AbortSignal.prototype;
const signalContext=new AsyncLocalStorage();
const activeSignal=()=>signalContext.getStore();
const FS_PORT_KEYS=['lstat','realpath','open','mkdir','chmod','opendir'];
const nativeFsPort=Object.freeze(Object.fromEntries(FS_PORT_KEYS.map(key=>[key,(...args)=>fs[key](...args)])));
const fsContext=new AsyncLocalStorage();
const activeFs=()=>fsContext.getStore()??nativeFsPort;
const LIMITS=Object.freeze({
  max_total_bytes:MAX_TOTAL_BYTES,
  max_object_bytes:MAX_OBJECT_BYTES,
  max_manifest_bytes:MAX_MANIFEST_BYTES,
  max_blob_bytes:MAX_BLOB_BYTES,
  max_objects:MAX_OBJECTS,
  max_base_files:MAX_BASE_FILES,
  max_candidate_files:MAX_CANDIDATE_FILES,
  max_changed_paths:MAX_CHANGED_PATHS,
  max_base_metadata_bytes:MAX_BASE_METADATA_BYTES,
  max_candidate_metadata_bytes:MAX_CANDIDATE_METADATA_BYTES,
  max_tree_records:MAX_TREE_RECORDS
});
const LIMITATIONS=Object.freeze([
  'COPY_INTEGRITY_ONLY',
  'SUPPLIED_NOT_AUTHENTICATED',
  'PENDING_REVIEW',
  'NOT_EVALUATED'
]);
const RESULT_KEYS=[
  'schema','status','operation_id','candidate_ref','base_commit','base_tree',
  'candidate_commit','candidate_tree','receipt_sha256','stage_manifest_sha256',
  'changed_paths','task_correctness','human_review','native_acceptance',
  'benchmark_acceptance','origin_authenticity','base_alternate_dependency'
];
const REQUEST_KEYS=[
  'schema','result','candidate_git_dir','candidate_git_identity',
  'base_git_dir','base_git_identity','output_dir'
];
const OPTIONAL_REQUEST_KEYS=['signal'];
const OBJECT_KEYS=['git_sha1','kind','bytes','sha256'];
const FILE_KEYS=['path','mode','kind','git_sha1','bytes','sha256'];
const MANIFEST_KEYS=[
  'schema','input_result_sha256','candidate_ref','candidate_commit','candidate_tree',
  'base_commit','base_tree','changed_paths','limits','objects','candidate_files',
  'base_preimages','object_bytes','candidate_file_bytes','base_preimage_bytes',
  'total_bytes','limitations'
];

class SnapshotError extends Error{
  constructor(code){super(code);this.name='PortableCandidateSnapshotError';this.code=code;delete this.stack;}
}
const invalid=()=>{throw new SnapshotError('INVALID_PROJECT_PORTABLE_SNAPSHOT_SPEC');};
const rejected=()=>{throw new SnapshotError('PROJECT_PORTABLE_SNAPSHOT_REJECTED');};
const aborted=()=>{throw new SnapshotError('PROJECT_PORTABLE_SNAPSHOT_ABORTED');};
const hasOwn=(value,key)=>Object.hasOwn(value,key);
function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
function gitOid(type,bytes){
  return createHash('sha1').update(Buffer.from(`${type} ${bytes.byteLength}\0`,'ascii')).update(bytes).digest('hex');
}
function isPlainRecord(value){
  return value!==null&&typeof value==='object'&&!Array.isArray(value)&&!types.isProxy(value)&&
    [Object.prototype,null].includes(Object.getPrototypeOf(value));
}
function closed(value,required,optional=[]){
  if(!isPlainRecord(value))invalid();
  const keys=Reflect.ownKeys(value);
  if(keys.some(key=>typeof key!=='string'||![...required,...optional].includes(key))||
     required.some(key=>!hasOwn(value,key)))invalid();
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!hasOwn(descriptor,'value'))invalid();}
}
function captureFsPort(value){
  if(value===undefined)return nativeFsPort;
  closed(value,FS_PORT_KEYS);
  const port=Object.create(null);
  for(const key of FS_PORT_KEYS){
    const method=Object.getOwnPropertyDescriptor(value,key)?.value;
    if(typeof method!=='function'||types.isProxy(method))invalid();
    port[key]=(...args)=>Reflect.apply(method,value,args);
  }
  return Object.freeze(port);
}
function captureFsOptions(value){
  if(value===undefined)value={};
  closed(value,[],['fs']);
  return captureFsPort(Object.hasOwn(value,'fs')?Object.getOwnPropertyDescriptor(value,'fs').value:undefined);
}
function denseArray(value,max){
  if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)invalid();
  const length=Object.getOwnPropertyDescriptor(value,'length')?.value;
  const keys=Reflect.ownKeys(value);
  if(!Number.isSafeInteger(length)||length<0||length>max||keys.length!==length+1)invalid();
  const output=[];
  for(let index=0;index<length;index++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
    if(!descriptor||!hasOwn(descriptor,'value'))invalid();
    output.push(descriptor.value);
  }
  return output;
}
function absolutePath(value){
  return typeof value==='string'&&value.length>1&&value.length<=4096&&value.startsWith('/')&&
    !/[\\\u0000-\u001f\u007f]/u.test(value)&&resolve(value)===value&&value!==parse(value).root;
}
function relativePath(value,maxLength=4096){
  if(typeof value!=='string'||!value||value.length>maxLength||value.startsWith('/')||value.endsWith('/')||
     !/^[A-Za-z0-9._/-]+$/.test(value))return false;
  const parts=value.split('/');
  return parts.length<=64&&parts.every(part=>part&&part!=='.'&&part!=='..'&&part.length<=255&&
    part.toLowerCase()!=='.git'&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function stageRelative(value){
  if(!relativePath(value,256))return false;
  const parts=value.split('/');
  return parts.length<=7&&parts.every(part=>part.length<=64&&
    !['stage-manifest.json','export-manifest.json','package-manifest.json','.git'].includes(part.toLowerCase()))&&
    !['project','evidence','frames'].includes(parts[0].toLowerCase());
}
function pathsOverlap(left,right){return left===right||left.startsWith(`${right}/`)||right.startsWith(`${left}/`);}
function captureArray(value,max){
  try{return denseArray(value,max);}catch{invalid();}
}
function captureIdentity(value){
  closed(value,['dev','ino']);
  const dev=Object.getOwnPropertyDescriptor(value,'dev')?.value;
  const ino=Object.getOwnPropertyDescriptor(value,'ino')?.value;
  if(!Number.isSafeInteger(dev)||dev<0||!Number.isSafeInteger(ino)||ino<0)invalid();
  return Object.freeze({dev,ino});
}
function captureResult(value){
  closed(value,RESULT_KEYS);
  const result=Object.create(null);
  for(const key of RESULT_KEYS){result[key]=Object.getOwnPropertyDescriptor(value,key).value;}
  if(result.schema!==RESULT_SCHEMA||result.status!=='SOURCE_CANDIDATE_CREATED'||
     typeof result.operation_id!=='string'||!TOKEN.test(result.operation_id)||
     result.candidate_ref!==`refs/heads/candidate-${result.operation_id}`||
     typeof result.base_commit!=='string'||!SHA1.test(result.base_commit)||
     typeof result.base_tree!=='string'||!SHA1.test(result.base_tree)||
     typeof result.candidate_commit!=='string'||!SHA1.test(result.candidate_commit)||
     typeof result.candidate_tree!=='string'||!SHA1.test(result.candidate_tree)||
     typeof result.receipt_sha256!=='string'||!SHA256.test(result.receipt_sha256)||
     typeof result.stage_manifest_sha256!=='string'||!SHA256.test(result.stage_manifest_sha256)||
     result.task_correctness!=='NOT_EVALUATED'||result.human_review!=='PENDING'||
     result.native_acceptance!=='NOT_ESTABLISHED'||result.benchmark_acceptance!=='NOT_ESTABLISHED'||
     result.origin_authenticity!=='SUPPLIED_NOT_AUTHENTICATED'||
     result.base_alternate_dependency!=='READ_ONLY_BASE_OBJECT_ALTERNATE')invalid();
  const paths=captureArray(result.changed_paths,MAX_CHANGED_PATHS);
  if(paths.length===0||paths.some(path=>!stageRelative(path)))invalid();
  for(let index=1;index<paths.length;index++)if(paths[index-1]>=paths[index])invalid();
  checkPathCollisions(paths);
  result.changed_paths=Object.freeze(paths);
  return Object.freeze(result);
}
function captureSignal(value){
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||types.isProxy(value))invalid();
  let current=value,found=false;
  while(current!==null){
    if(types.isProxy(current))invalid();
    let descriptor,next;
    try{descriptor=Object.getOwnPropertyDescriptor(current,'aborted');next=Object.getPrototypeOf(current);}catch{invalid();}
    if(current===value&&descriptor)invalid();
    if(current===signalPrototype){
      if(!descriptor||!hasOwn(descriptor,'get')||descriptor.get!==ABORTED_GETTER)invalid();
      found=true;
    }else if(descriptor)invalid();
    current=next;
  }
  if(!found)invalid();
  try{Reflect.apply(ABORTED_GETTER,value,[]);}catch{invalid();}
  return value;
}
function signalAborted(signal){
  if(signal===undefined)return false;
  try{return Reflect.apply(ABORTED_GETTER,signal,[]);}catch{invalid();}
}
function checkAbort(signal){if(signalAborted(signal))aborted();}
function captureRequest(value){
  closed(value,REQUEST_KEYS,OPTIONAL_REQUEST_KEYS);
  const out=Object.create(null);
  for(const key of [...REQUEST_KEYS,...(hasOwn(value,'signal')?['signal']:[])]){
    out[key]=Object.getOwnPropertyDescriptor(value,key).value;
  }
  if(out.schema!==REQUEST_SCHEMA||!absolutePath(out.candidate_git_dir)||basename(out.candidate_git_dir)==='.git'||
     !absolutePath(out.base_git_dir)||!absolutePath(out.output_dir))invalid();
  out.result=captureResult(out.result);
  out.candidate_git_identity=captureIdentity(out.candidate_git_identity);
  out.base_git_identity=captureIdentity(out.base_git_identity);
  out.signal=captureSignal(out.signal);
  const protectedBase=basename(out.base_git_dir)==='.git'?dirname(out.base_git_dir):out.base_git_dir;
  const roots=[out.candidate_git_dir,protectedBase,out.output_dir];
  for(let left=0;left<roots.length;left++)for(let right=left+1;right<roots.length;right++){
    if(pathsOverlap(roots[left],roots[right]))invalid();
  }
  return Object.freeze(out);
}

function checkPathCollisions(paths){
  const folded=new Map(),exact=new Set(paths);
  for(const path of paths){
    const prior=folded.get(path.toLowerCase());
    if(prior!==undefined&&prior!==path)rejected();
    folded.set(path.toLowerCase(),path);
  }
  for(const path of exact){
    const parts=path.toLowerCase().split('/');
    for(let index=1;index<parts.length;index++)if(folded.has(parts.slice(0,index).join('/')))rejected();
  }
}
function checkAllTreePaths(files,trees){
  const entries=[...files.map(file=>file.path),...trees.map(tree=>tree.path)];
  const folded=new Map();
  for(const path of entries){
    const prior=folded.get(path.toLowerCase());
    if(prior!==undefined)rejected();
    folded.set(path.toLowerCase(),path);
  }
  const fileSet=new Set(files.map(file=>file.path));
  for(const path of entries){
    const parts=path.split('/');
    for(let index=1;index<parts.length;index++)if(fileSet.has(parts.slice(0,index).join('/')))rejected();
  }
}

function canonicalValue(value){
  if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='string')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonicalValue).join(',')}]`;
  const keys=Object.keys(value).sort();
  return `{${keys.map(key=>`${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`;
}
function canonicalBytes(value){return Buffer.from(canonicalValue(value),'utf8');}
function canonicalByteLength(value){
  if(value===null||typeof value==='boolean'||typeof value==='number')return Buffer.byteLength(JSON.stringify(value),'utf8');
  if(typeof value==='string')return Buffer.byteLength(JSON.stringify(value),'utf8');
  if(Array.isArray(value))return 2+value.reduce((sum,item,index)=>sum+(index?1:0)+canonicalByteLength(item),0);
  const keys=Object.keys(value).sort();
  return 2+keys.reduce((sum,key,index)=>sum+(index?1:0)+Buffer.byteLength(JSON.stringify(key),'utf8')+1+canonicalByteLength(value[key]),0);
}
function parseStrictJson(bytes,maxBytes){
  if(!Buffer.isBuffer(bytes)&&!(bytes instanceof Uint8Array))rejected();
  if(bytes.byteLength>maxBytes)rejected();
  let text;try{text=decoder.decode(bytes);}catch{rejected();}
  let index=0,nodes=0;
  const whitespace=()=>{while(index<text.length&&/[\x20\t\r\n]/.test(text[index]))index++;};
  function parseString(){
    if(text[index]!=='"')rejected();
    const start=index++;let escaped=false;
    while(index<text.length){
      const code=text.charCodeAt(index++);
      if(escaped){escaped=false;continue;}
      if(code===0x5c){escaped=true;continue;}
      if(code===0x22){try{return JSON.parse(text.slice(start,index));}catch{rejected();}}
      if(code<0x20)rejected();
    }
    rejected();
  }
  function value(depth){
    if(depth>16||++nodes>150000)rejected();
    whitespace();const token=text[index];
    if(token==='"')return parseString();
    if(token==='{'){
      index++;whitespace();const output=Object.create(null),seen=new Set();
      if(text[index]==='}'){index++;return output;}
      while(index<text.length){
        const key=parseString();
        if(seen.has(key)||['__proto__','constructor','prototype'].includes(key))rejected();
        seen.add(key);whitespace();if(text[index++]!==':')rejected();
        output[key]=value(depth+1);whitespace();const separator=text[index++];
        if(separator==='}')return output;if(separator!==',')rejected();whitespace();
        if(seen.size>MAX_OBJECTS*2+4096)rejected();
      }
      rejected();
    }
    if(token==='['){
      index++;whitespace();const output=[];
      if(text[index]===']'){index++;return output;}
      while(index<text.length){
        if(output.length>=MAX_OBJECTS)rejected();
        output.push(value(depth+1));whitespace();const separator=text[index++];
        if(separator===']')return output;if(separator!==',')rejected();whitespace();
      }
      rejected();
    }
    const match=/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index));
    if(!match)rejected();index+=match[0].length;
    const scalar=JSON.parse(match[0]);if(typeof scalar==='number'&&!Number.isFinite(scalar))rejected();
    return scalar;
  }
  const parsed=value(0);whitespace();if(index!==text.length)rejected();return parsed;
}

function statIs(stat,kind){
  if(!stat||typeof stat!=='object'||types.isProxy(stat)||typeof stat.isDirectory!=='function'||
     typeof stat.isFile!=='function'||typeof stat.isSymbolicLink!=='function')return false;
  try{return !stat.isSymbolicLink()&&(kind==='directory'?stat.isDirectory()===true:stat.isFile()===true);}catch{return false;}
}
function stable(a,b){
  return ['dev','ino','size','mtimeMs','ctimeMs'].every(key=>
    typeof a?.[key]==='number'&&Number.isFinite(a[key])&&a[key]===b?.[key]
  );
}
function sameDirectoryIdentity(a,b){
  return a?.dev===b?.dev&&a?.ino===b?.ino&&a?.uid===b?.uid&&
    (a?.mode&0o7777)===(b?.mode&0o7777);
}
function isMissing(error){try{return Object.getOwnPropertyDescriptor(error,'code')?.value==='ENOENT';}catch{return false;}}
async function lstat(path){
  checkAbort(activeSignal());
  try{const stat=await activeFs().lstat(path);checkAbort(activeSignal());return stat;}catch(error){
    if(error instanceof SnapshotError)throw error;rejected();
  }
}
async function ancestorChecks(target){
  checkAbort(activeSignal());
  const parent=dirname(target),root=parse(parent).root,parts=parent.slice(root.length).split('/').filter(Boolean);
  const paths=[root];let current=root;
  for(const part of parts){current=join(current,part);paths.push(current);}
  for(const path of paths){
    const stat=await lstat(path);
    if(!statIs(stat,'directory')||!Number.isSafeInteger(stat.uid)||!Number.isSafeInteger(stat.mode))rejected();
    const ownerSafe=(stat.uid===process.getuid()||stat.uid===0)&&(stat.mode&0o022)===0;
    const stickyRoot=stat.uid===0&&(stat.mode&0o1000)===0o1000;
    if(!ownerSafe&&!stickyRoot)rejected();
  }
}
async function realPathSelf(path){try{if(await activeFs().realpath(path)!==path)rejected();}catch{rejected();}}
async function missing(path){try{await activeFs().lstat(path);return false;}catch(error){if(isMissing(error))return true;rejected();}}
async function readStableFile(path,maxBytes,expectedMode=0o400){
  await ancestorChecks(path);
  let handle=null,buffer=null,result=null;
  try{
    let before;try{before=await activeFs().lstat(path);}catch{rejected();}
    if(!statIs(before,'file')||before.uid!==process.getuid()||before.nlink!==1||
       (before.mode&0o7777)!==expectedMode||!Number.isSafeInteger(before.size)||before.size<0||before.size>maxBytes)rejected();
    checkAbort(activeSignal());
    try{handle=await activeFs().open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{rejected();}
    checkAbort(activeSignal());
    const opened=await handle.stat();
    if(!statIs(opened,'file')||opened.uid!==process.getuid()||opened.nlink!==1||
       (opened.mode&0o7777)!==expectedMode||!stable(before,opened))rejected();
    buffer=Buffer.alloc(before.size+1);let offset=0;
    while(offset<buffer.length){
      const count=Math.min(65536,buffer.length-offset);
      const read=await handle.read(buffer,offset,count,offset);
      if(!Number.isSafeInteger(read.bytesRead)||read.bytesRead<0||read.bytesRead>count)rejected();
      if(read.bytesRead===0)break;
      offset+=read.bytesRead;if(offset>maxBytes)rejected();
    }
    const after=await handle.stat();let leaf;try{leaf=await activeFs().lstat(path);}catch{rejected();}
    if(offset!==before.size||!stable(opened,after)||!stable(opened,leaf)||!statIs(leaf,'file')||
       leaf.uid!==process.getuid()||leaf.nlink!==1||(leaf.mode&0o7777)!==expectedMode)rejected();
    result=buffer.subarray(0,offset);buffer=null;
  }catch(error){if(error instanceof SnapshotError)throw error;rejected();}
  finally{
    buffer?.fill(0);
    if(handle){try{await handle.close();}catch{result?.fill(0);rejected();}}
  }
  const output=Buffer.from(result);result.fill(0);return output;
}

async function sourceDirectory(path,identity,{bare,forbidAlternates=false}={}){
  await ancestorChecks(path);
  let stat;try{stat=await activeFs().lstat(path);}catch{rejected();}
  if(!statIs(stat,'directory')||stat.uid!==process.getuid()||(stat.mode&0o022)!==0||
     stat.dev!==identity.dev||stat.ino!==identity.ino)rejected();
  await realPathSelf(path);
  const objects=join(path,'objects');let objectStat;try{objectStat=await activeFs().lstat(objects);}catch{rejected();}
  if(!statIs(objectStat,'directory')||objectStat.uid!==process.getuid()||(objectStat.mode&0o022)!==0)rejected();
  await realPathSelf(objects);
  for(const name of ['commondir','gitdir'])if(!await missing(join(path,name)))rejected();
  const info=join(objects,'info');
  if(!await missing(info)){
    const infoStat=await lstat(info);
    if(!statIs(infoStat,'directory')||infoStat.uid!==process.getuid()||(infoStat.mode&0o022)!==0)rejected();
    await realPathSelf(info);
    if(!await missing(join(info,'http-alternates')))rejected();
    if(forbidAlternates&&!await missing(join(info,'alternates')))rejected();
  }else if(forbidAlternates){
    if(!await missing(join(info,'alternates')))rejected();
  }
  const gitInfo=join(path,'info');
  if(!await missing(gitInfo)){
    const gitInfoStat=await lstat(gitInfo);
    if(!statIs(gitInfoStat,'directory')||gitInfoStat.uid!==process.getuid()||(gitInfoStat.mode&0o022)!==0)rejected();
  }
  if(bare!==undefined){
    const observed=await gitText(path,['rev-parse','--is-bare-repository'],64);
    if(observed!==`${bare?'true':'false'}\n`)rejected();
    if(!bare&&await gitText(path,['rev-parse','--show-toplevel'],4096)!==`${dirname(path)}\n`)rejected();
  }
  if(await gitText(path,['rev-parse','--show-object-format'],64)!=='sha1\n')rejected();
  const replacements=await gitBytes(path,['for-each-ref','--format=%(refname)','refs/replace'],4096);
  if(replacements.length!==0)rejected();
  if(!await missing(join(path,'info','grafts')))rejected();
  return Object.freeze({path,objects,stat,objectStat});
}

const FIXED_GIT_CONFIG=Object.freeze([
  '-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
  '-c','core.attributesFile=/dev/null','-c','core.autocrlf=false',
  '-c','core.pager=cat','-c','protocol.allow=never','-c','gc.auto=0'
]);
function gitEnv(gitDir){
  const env={
    PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1',
    GIT_NO_LAZY_FETCH:'1',GIT_PAGER:'cat',PAGER:'cat',GIT_DIR:gitDir
  };
  if(basename(gitDir)==='.git')env.GIT_WORK_TREE=dirname(gitDir);
  return env;
}
async function runGit(gitDir,args,input,maxStdout,signal=activeSignal(),allowedCodes=[0]){
  checkAbort(signal);
  const stdout=[],stderr=[];let outBytes=0,errBytes=0,overflow=false,childError=false,inputError=false;
  let stdoutEnded=false,stderrEnded=false,stdinFinished=false,child;
  try{child=spawn('/usr/bin/git',[...FIXED_GIT_CONFIG,...args],{
    cwd:gitDir,env:gitEnv(gitDir),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']
  });}catch{rejected();}
  let closed=false,resolveClose;
  const closePromise=new Promise(resolvePromise=>{resolveClose=resolvePromise;});
  child.once('close',(code,signalName)=>{closed=true;resolveClose({code,signalName});});
  const kill=signalName=>{try{child.kill(signalName);}catch{}};
  const fail=()=>{childError=true;kill('SIGTERM');};
  child.on('error',fail);child.stdout.on('error',fail);child.stderr.on('error',fail);
  child.stdout.on('data',chunk=>{
    outBytes+=chunk.length;
    if(outBytes>maxStdout){overflow=true;kill('SIGKILL');return;}
    stdout.push(Buffer.from(chunk));
  });
  child.stderr.on('data',chunk=>{
    errBytes+=chunk.length;
    if(errBytes>MAX_GIT_STDERR){overflow=true;kill('SIGKILL');return;}
    stderr.push(Buffer.from(chunk));
  });
  child.stdout.once('end',()=>{stdoutEnded=true;});child.stderr.once('end',()=>{stderrEnded=true;});
  child.stdin.once('finish',()=>{stdinFinished=true;});child.stdin.on('error',()=>{inputError=true;});
  const abort=()=>kill('SIGTERM');let listening=false;
  if(signal!==undefined){
    try{Reflect.apply(ADD_EVENT_LISTENER,signal,['abort',abort,{once:true}]);listening=true;}catch{childError=true;kill('SIGKILL');}
    try{if(signalAborted(signal))abort();}catch{childError=true;kill('SIGKILL');}
  }
  let inputCopy=null;
  try{inputCopy=input===null||input===undefined?null:Buffer.from(input);child.stdin.end(inputCopy??undefined);}
  catch{inputError=true;kill('SIGKILL');}
  const exit=await closePromise;
  inputCopy?.fill(0);
  if(listening){try{Reflect.apply(REMOVE_EVENT_LISTENER,signal,['abort',abort]);}catch{childError=true;}}
  checkAbort(signal);
  if(!closed||childError||overflow||inputError||!stdoutEnded||!stderrEnded||!stdinFinished||
     !allowedCodes.includes(exit.code)||exit.signalName!==null)rejected();
  return Object.freeze({code:exit.code,stdout:Buffer.concat(stdout,outBytes),stderr:Buffer.concat(stderr,errBytes)});
}
async function gitBytes(gitDir,args,maxBytes,signal=activeSignal(),allowedCodes=[0]){
  const result=await runGit(gitDir,args,null,maxBytes,signal,allowedCodes);
  if(result.stdout.length>maxBytes)rejected();return result.stdout;
}
async function gitText(gitDir,args,maxBytes,signal=activeSignal()){
  const bytes=await gitBytes(gitDir,args,maxBytes,signal);
  try{return decoder.decode(bytes);}catch{rejected();}
}
async function catObject(gitDir,kind,oid,maxBytes=MAX_BLOB_BYTES){
  if(!SHA1.test(oid)||!['commit','tree','blob'].includes(kind))rejected();
  const output=await gitBytes(gitDir,['cat-file',kind,oid],maxBytes+1);
  if(output.length>maxBytes||gitOid(kind,output)!==oid)rejected();
  return output;
}
async function readRef(gitDir,ref){
  const symbolic=await runGit(gitDir,['symbolic-ref','--quiet','--no-recurse',ref],null,256,activeSignal(),[0,1]);
  if(symbolic.code===0||symbolic.stdout.length!==0||symbolic.stderr.length!==0)rejected();
  const result=await runGit(gitDir,['rev-parse','--verify','--quiet','--end-of-options',ref],null,64,activeSignal(),[0,1]);
  if(result.code===1&&result.stdout.length===0&&result.stderr.length===0)return null;
  let text;try{text=decoder.decode(result.stdout);}catch{rejected();}
  const match=/^([a-f0-9]{40})\n$/.exec(text);if(!match)rejected();return match[1];
}
async function readAlternate(path,expected){
  const alternate=join(path,'objects','info','alternates');
  const bytes=await readStableFile(alternate,4096,0o600);
  try{if(!bytes.equals(Buffer.from(`${expected}\n`,'utf8')))rejected();}finally{bytes.fill(0);}
}

function parseCommit(bytes,oid){
  if(gitOid('commit',bytes)!==oid||bytes.length>MAX_COMMIT_BYTES)rejected();
  let text;try{text=decoder.decode(bytes);}catch{rejected();}
  const split=text.indexOf('\n\n');if(split<0)rejected();
  const headerLines=text.slice(0,split).split('\n');let tree=null,lastKey=null;const parents=[];
  for(const line of headerLines){
    if(line.startsWith(' ')){if(lastKey===null||lastKey==='tree'||lastKey==='parent')rejected();continue;}
    const field=/^([A-Za-z0-9-]+) (.+)$/.exec(line);if(!field)rejected();lastKey=field[1];
    if(lastKey==='tree'){if(tree!==null||!SHA1.test(field[2]))rejected();tree=field[2];}
    else if(lastKey==='parent'){if(!SHA1.test(field[2])||parents.length>=16)rejected();parents.push(field[2]);}
  }
  if(tree===null)rejected();return Object.freeze({tree,parents:Object.freeze(parents)});
}
function parseLsTree(bytes,maxFiles,maxMetadata){
  if(bytes.length>maxMetadata)rejected();
  const files=[],trees=[];let offset=0,recordCount=0,metadataBytes=0;
  while(offset<bytes.length){
    const end=bytes.indexOf(0,offset);if(end<0)rejected();
    const record=bytes.subarray(offset,end),tab=record.indexOf(9);if(tab<0)rejected();
    const header=record.subarray(0,tab).toString('ascii');
    const match=/^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})$/.exec(header);if(!match)rejected();
    let path;try{path=decoder.decode(record.subarray(tab+1));}catch{rejected();}
    if(!relativePath(path))rejected();
    const [,mode,type,oid]=match;
    if(type==='tree'&&['040000','40000'].includes(mode))trees.push(Object.freeze({path,oid}));
    else if(type==='blob'&&['100644','100755'].includes(mode))files.push(Object.freeze({path,mode,oid}));
    else rejected();
    metadataBytes+=utf8.encode(path).length+mode.length+type.length+oid.length+4;
    if(!Number.isSafeInteger(metadataBytes)||metadataBytes>maxMetadata)rejected();
    if(++recordCount>MAX_TREE_RECORDS||files.length>maxFiles)rejected();
    offset=end+1;
  }
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  trees.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  checkAllTreePaths(files,trees);
  return Object.freeze({files:Object.freeze(files),trees:Object.freeze(trees),metadataBytes});
}
function parseGitTreeListing(bytes,maxFiles,maxMetadata){
  return parseLsTree(bytes,maxFiles,maxMetadata);
}

function parseBatch(bytes,oids,expectedKinds,expectedSizes,maxPayloadBytes){
  const parsed=new Map();let offset=0,totalPayload=0;
  for(const oid of oids){
    const end=bytes.indexOf(10,offset);if(end<0)rejected();
    let header;try{header=decoder.decode(bytes.subarray(offset,end));}catch{rejected();}
    offset=end+1;
    const match=/^([a-f0-9]{40}) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(header);
    if(!match||match[1]!==oid||!Number.isSafeInteger(Number(match[3])))rejected();
    const [,observedOid,kind,sizeText]=match,size=Number(sizeText);
    if(kind!==expectedKinds.get(oid)||!Number.isSafeInteger(size)||size<0||
       size!==expectedSizes.get(oid)||size>maxPayloadBytes-totalPayload)rejected();
    if(offset+size>=bytes.length||bytes[offset+size]!==10)rejected();
    const payload=bytes.subarray(offset,offset+size);offset+=size+1;totalPayload+=size;
    if(gitOid(kind,payload)!==observedOid)rejected();
    parsed.set(oid,Object.freeze({oid,kind,bytes:size,sha256:sha256(payload),payload}));
  }
  if(offset!==bytes.length||parsed.size!==oids.length)rejected();
  return parsed;
}
function parseBatchCheck(bytes,oids,expectedKinds){
  const sizes=new Map();let offset=0;
  for(const oid of oids){
    const end=bytes.indexOf(10,offset);if(end<0)rejected();
    let header;try{header=decoder.decode(bytes.subarray(offset,end));}catch{rejected();}
    offset=end+1;
    const match=/^([a-f0-9]{40}) (commit|tree|blob) (0|[1-9][0-9]*)$/.exec(header);
    if(!match||match[1]!==oid||match[2]!==expectedKinds.get(oid)||!Number.isSafeInteger(Number(match[3])))rejected();
    sizes.set(oid,Number(match[3]));
  }
  if(offset!==bytes.length||sizes.size!==oids.length)rejected();
  return sizes;
}
async function checkBatchSizes(gitDir,oids,expectedKinds){
  if(oids.length>MAX_OBJECTS)rejected();
  if(oids.length===0)return new Map();
  const input=Buffer.from(oids.map(oid=>`${oid}\n`).join(''),'ascii');
  try{
    const maxStdout=oids.length*96+1;
    const result=await runGit(gitDir,['cat-file','--batch-check'],input,maxStdout,activeSignal());
    return parseBatchCheck(result.stdout,oids,expectedKinds);
  }finally{input.fill(0);}
}
async function fetchBatch(gitDir,oids,expectedKinds,expectedSizes,maxPayloadBytes=MAX_OBJECT_BYTES){
  if(oids.length>MAX_OBJECTS)rejected();
  if(oids.length===0)return new Map();
  if(!Number.isSafeInteger(maxPayloadBytes)||maxPayloadBytes<0||maxPayloadBytes>MAX_OBJECT_BYTES)rejected();
  const input=Buffer.from(oids.map(oid=>`${oid}\n`).join(''),'ascii');
  const cap=maxPayloadBytes+Math.min(MAX_BATCH_OVERHEAD,oids.length*96+65536);
  let output;
  try{
    checkAbort(activeSignal());
    const result=await runGit(gitDir,['cat-file','--batch'],input,cap,activeSignal());
    output=result.stdout;
    return parseBatch(output,oids,expectedKinds,expectedSizes,maxPayloadBytes);
  }finally{input.fill(0);}
}

function collectRawTree(rootOid,objects,maxFiles,maxMetadata){
  const files=[],trees=[],active=new Set();let metadataBytes=0,records=0;
  const visit=(oid,prefix,isRoot=false)=>{
    if(active.has(oid))rejected();
    const object=objects.get(oid);if(!object||object.kind!=='tree')rejected();
    active.add(oid);
    const payload=object.payload;let offset=0,childCount=0,lastSortKey=null;
    while(offset<payload.length){
      const space=payload.indexOf(0x20,offset);if(space<0)rejected();
      const nul=payload.indexOf(0,space+1);if(nul<0||nul+21>payload.length)rejected();
      const mode=payload.subarray(offset,space).toString('ascii');
      let name;try{name=decoder.decode(payload.subarray(space+1,nul));}catch{rejected();}
      const nameBytes=payload.subarray(space+1,nul);
      if(!name||name.includes('/')||name==='.'||name==='..'||!relativePath(prefix?`${prefix}/${name}`:name))rejected();
      const oidBytes=payload.subarray(nul+1,nul+21),childOid=oidBytes.toString('hex');
      const isTree=mode==='40000',isBlob=['100644','100755'].includes(mode);
      if(!isTree&&!isBlob)rejected();
      const sortKey=Buffer.concat([nameBytes,Buffer.from([isTree?0x2f:0x00])]);
      if(lastSortKey!==null&&Buffer.compare(lastSortKey,sortKey)>=0)rejected();
      lastSortKey=sortKey;
      const path=prefix?`${prefix}/${name}`:name;
      const childObject=objects.get(childOid);
      if(!childObject||childObject.kind!==(isTree?'tree':'blob'))rejected();
      metadataBytes+=utf8.encode(path).length+(isTree?'040000tree':'100644blob').length+childOid.length+4;
      if(!Number.isSafeInteger(metadataBytes)||metadataBytes>maxMetadata)rejected();
      if(++records>MAX_TREE_RECORDS)rejected();childCount++;
      if(isTree){trees.push(Object.freeze({path,oid:childOid}));visit(childOid,path,false);}
      else{
        files.push(Object.freeze({path,mode,oid:childOid}));
        if(files.length>maxFiles)rejected();
      }
      offset=nul+21;
    }
    active.delete(oid);if(childCount===0&&!isRoot)rejected();
  };
  visit(rootOid,'',true);
  files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  trees.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  checkAllTreePaths(files,trees);
  return Object.freeze({files:Object.freeze(files),trees:Object.freeze(trees),metadataBytes,records});
}
function sameListing(left,right){
  return left.files.length===right.files.length&&left.trees.length===right.trees.length&&
    left.files.every((entry,index)=>entry.path===right.files[index].path&&entry.mode===right.files[index].mode&&entry.oid===right.files[index].oid)&&
    left.trees.every((entry,index)=>entry.path===right.trees[index].path&&entry.oid===right.trees[index].oid);
}
function computeChanges(baseFiles,candidateFiles){
  const before=new Map(baseFiles.map(entry=>[entry.path,entry]));
  const after=new Map(candidateFiles.map(entry=>[entry.path,entry]));
  const paths=[...new Set([...before.keys(),...after.keys()])];
  const changed=paths.filter(path=>{
    const old=before.get(path),next=after.get(path);
    // PR210 emits additions and replacements only; deletion is outside this source binding.
    if(old&&!next)rejected();
    return !old||old.mode!==next.mode||old.oid!==next.oid;
  }).sort();
  if(changed.length===0||changed.length>MAX_CHANGED_PATHS)rejected();
  return changed;
}
function compareLists(expected,actual){
  return expected.length===actual.length&&expected.every((value,index)=>value===actual[index]);
}
function objectRecordFrom(parsed,source){
  const output=new Map();
  for(const [oid,object] of parsed)output.set(oid,Object.freeze({
    oid,kind:object.kind,bytes:object.bytes,sha256:object.sha256,payload:object.payload,source
  }));
  return output;
}
function addExpectedKind(kinds,oid,kind){
  const old=kinds.get(oid);if(old!==undefined&&old!==kind)rejected();kinds.set(oid,kind);
}
function changedDescriptors(paths,baseFiles,objects){
  const byPath=new Map(baseFiles.map(file=>[file.path,file]));
  return paths.flatMap(path=>{
    const file=byPath.get(path);if(!file)return [];
    const object=objects.get(file.oid);if(!object||object.kind!=='blob')rejected();
    return [Object.freeze({path,mode:file.mode,kind:'blob',oid:file.oid,bytes:object.bytes,sha256:object.sha256})];
  });
}
function fileDescriptors(files,objects){
  return files.map(file=>{
    const object=objects.get(file.oid);if(!object||object.kind!=='blob')rejected();
    return Object.freeze({path:file.path,mode:file.mode,kind:'blob',oid:file.oid,bytes:object.bytes,sha256:object.sha256});
  });
}

async function gatherSource(request,candidateRepo,baseRepo){
  const result=request.result;
  if(await readRef(candidateRepo.path,result.candidate_ref)!==result.candidate_commit)rejected();
  await readAlternate(candidateRepo.path,baseRepo.objects);
  const candidateCommitBytes=await catObject(candidateRepo.path,'commit',result.candidate_commit,MAX_COMMIT_BYTES);
  const baseCommitBytes=await catObject(baseRepo.path,'commit',result.base_commit,MAX_COMMIT_BYTES);
  const candidateCommit=parseCommit(candidateCommitBytes,result.candidate_commit);
  const baseCommit=parseCommit(baseCommitBytes,result.base_commit);
  candidateCommitBytes.fill(0);baseCommitBytes.fill(0);
  if(candidateCommit.tree!==result.candidate_tree||candidateCommit.parents.length!==1||
     candidateCommit.parents[0]!==result.base_commit||baseCommit.tree!==result.base_tree)rejected();
  const candidateListing=parseGitTreeListing(await gitBytes(candidateRepo.path,
    ['ls-tree','-rtz','--full-tree',result.candidate_tree],MAX_CANDIDATE_METADATA_BYTES),
    MAX_CANDIDATE_FILES,MAX_CANDIDATE_METADATA_BYTES);
  const baseListing=parseGitTreeListing(await gitBytes(baseRepo.path,
    ['ls-tree','-rtz','--full-tree',result.base_tree],MAX_BASE_METADATA_BYTES),
    MAX_BASE_FILES,MAX_BASE_METADATA_BYTES);
  const changes=computeChanges(baseListing.files,candidateListing.files);
  if(!compareLists(changes,result.changed_paths))rejected();
  for(const path of changes)if(!stageRelative(path))rejected();
  const baseByPath=new Map(baseListing.files.map(file=>[file.path,file]));
  const candidateByPath=new Map(candidateListing.files.map(file=>[file.path,file]));
  for(const candidate of candidateListing.files){
    const base=baseByPath.get(candidate.path);
    if(candidate.mode==='100755'&&(!base||base.mode!=='100755'||base.oid!==candidate.oid))rejected();
  }
  const candidateKinds=new Map(),baseKinds=new Map();
  addExpectedKind(candidateKinds,result.candidate_commit,'commit');
  addExpectedKind(baseKinds,result.base_commit,'commit');
  addExpectedKind(candidateKinds,result.candidate_tree,'tree');
  addExpectedKind(baseKinds,result.base_tree,'tree');
  for(const tree of candidateListing.trees)addExpectedKind(candidateKinds,tree.oid,'tree');
  for(const tree of baseListing.trees)addExpectedKind(baseKinds,tree.oid,'tree');
  for(const file of candidateListing.files)addExpectedKind(candidateKinds,file.oid,'blob');
  for(const path of changes){const old=baseByPath.get(path);if(old)addExpectedKind(baseKinds,old.oid,'blob');}
  if(candidateKinds.size>MAX_OBJECTS||baseKinds.size>MAX_OBJECTS)rejected();
  const overlapping=new Set([...candidateKinds.keys()].filter(oid=>baseKinds.has(oid)));
  const baseOnly=new Map([...baseKinds].filter(([oid])=>!candidateKinds.has(oid)));
  const candidateOids=[...candidateKinds.keys()].sort();
  const baseOids=[...baseOnly.keys()].sort();
  if(new Set([...candidateOids,...baseOids]).size>MAX_OBJECTS)rejected();
  const candidateSizes=await checkBatchSizes(candidateRepo.path,candidateOids,candidateKinds);
  const baseSizes=await checkBatchSizes(baseRepo.path,baseOids,baseOnly);
  let expectedObjectBytes=0;
  for(const size of [...candidateSizes.values(),...baseSizes.values()]){
    expectedObjectBytes+=size;if(!Number.isSafeInteger(expectedObjectBytes)||expectedObjectBytes>MAX_OBJECT_BYTES)rejected();
  }
  for(const oid of [...candidateSizes.keys(),...baseSizes.keys()]){
    const kind=candidateKinds.get(oid)??baseOnly.get(oid);
    const size=candidateSizes.get(oid)??baseSizes.get(oid);
    if(kind==='blob'&&size>MAX_BLOB_BYTES)rejected();
  }
  const candidateObjects=objectRecordFrom(await fetchBatch(
    candidateRepo.path,candidateOids,candidateKinds,candidateSizes,
    [...candidateSizes.values()].reduce((sum,size)=>sum+size,0)
  ),candidateRepo.path);
  const candidatePayloadBytes=[...candidateSizes.values()].reduce((sum,size)=>sum+size,0);
  const basePayloadCap=MAX_OBJECT_BYTES-candidatePayloadBytes;
  const baseObjects=objectRecordFrom(await fetchBatch(
    baseRepo.path,baseOids,baseOnly,baseSizes,basePayloadCap
  ),baseRepo.path);
  const objects=new Map([...candidateObjects,...baseObjects]);
  for(const oid of overlapping){
    const candidate=candidateObjects.get(oid),baseKind=baseKinds.get(oid);
    if(!candidate||candidate.kind!==baseKind)rejected();
  }
  if(objects.size>MAX_OBJECTS)rejected();
  let objectBytes=0;
  for(const object of objects.values()){
    if(object.kind==='blob'&&object.bytes>MAX_BLOB_BYTES)rejected();
    objectBytes+=object.bytes;if(!Number.isSafeInteger(objectBytes)||objectBytes>MAX_OBJECT_BYTES)rejected();
  }
  const candidateTree=collectRawTree(result.candidate_tree,objects,MAX_CANDIDATE_FILES,MAX_CANDIDATE_METADATA_BYTES);
  const baseTree=collectRawTree(result.base_tree,objects,MAX_BASE_FILES,MAX_BASE_METADATA_BYTES);
  if(!sameListing(candidateListing,candidateTree)||!sameListing(baseListing,baseTree))rejected();
  const recomputedChanges=computeChanges(baseTree.files,candidateTree.files);
  if(!compareLists(changes,recomputedChanges)||!compareLists(changes,result.changed_paths))rejected();
  for(const candidate of candidateTree.files){
    const base=baseByPath.get(candidate.path);
    if(candidate.mode==='100755'&&(!base||base.mode!=='100755'||base.oid!==candidate.oid))rejected();
  }
  const candidateFiles=fileDescriptors(candidateTree.files,objects);
  const basePreimages=changedDescriptors(changes,baseTree.files,objects);
  const candidateBytes=candidateFiles.reduce((sum,file)=>sum+file.bytes,0);
  const baseBytes=basePreimages.reduce((sum,file)=>sum+file.bytes,0);
  if(!Number.isSafeInteger(candidateBytes)||!Number.isSafeInteger(baseBytes))rejected();
  const inputResultSha256=sha256(canonicalBytes(result));
  const manifest={
    schema:SNAPSHOT_SCHEMA,input_result_sha256:inputResultSha256,
    candidate_ref:result.candidate_ref,candidate_commit:result.candidate_commit,
    candidate_tree:result.candidate_tree,base_commit:result.base_commit,base_tree:result.base_tree,
    changed_paths:[...changes],limits:LIMITS,
    objects:[...objects.values()].map(({oid,kind,bytes,sha256:digest})=>({git_sha1:oid,kind,bytes,sha256:digest}))
      .sort((a,b)=>a.git_sha1<b.git_sha1?-1:a.git_sha1>b.git_sha1?1:0),
    candidate_files:candidateFiles.map(file=>({
      path:file.path,mode:file.mode,kind:'blob',git_sha1:file.oid,bytes:file.bytes,sha256:file.sha256
    })),
    base_preimages:basePreimages.map(file=>({
      path:file.path,mode:file.mode,kind:'blob',git_sha1:file.oid,bytes:file.bytes,sha256:file.sha256
    })),
    object_bytes:objectBytes,candidate_file_bytes:candidateBytes,
    base_preimage_bytes:baseBytes,total_bytes:0,limitations:LIMITATIONS
  };
  let manifestBytes=null;
  for(let attempt=0;attempt<4;attempt++){
    const manifestLength=canonicalByteLength(manifest);
    if(manifestLength>MAX_MANIFEST_BYTES)rejected();
    const total=objectBytes+candidateBytes+baseBytes+manifestLength;
    if(!Number.isSafeInteger(total)||total>MAX_TOTAL_BYTES)rejected();
    if(manifest.total_bytes===total)break;
    manifest.total_bytes=total;
  }
  manifestBytes=canonicalBytes(manifest);
  if(manifestBytes.length>MAX_MANIFEST_BYTES||
     objectBytes+candidateBytes+baseBytes+manifestBytes.length!==manifest.total_bytes)rejected();
  return Object.freeze({
    candidateRepo,baseRepo,objects,candidateFiles:Object.freeze(candidateFiles),
    basePreimages:Object.freeze(basePreimages),manifest:Object.freeze(manifest),
    manifestBytes,objectBytes,candidateBytes,baseBytes
  });
}

async function recheckSources(request,state){
  checkAbort(request.signal);
  const candidateRepo=await sourceDirectory(request.candidate_git_dir,request.candidate_git_identity,{bare:true});
  const baseRepo=await sourceDirectory(request.base_git_dir,request.base_git_identity,{
    bare:basename(request.base_git_dir)!=='.git',forbidAlternates:true
  });
  if(!stable(state.candidateRepo.stat,candidateRepo.stat)||!stable(state.baseRepo.stat,baseRepo.stat)||
     !stable(state.candidateRepo.objectStat,candidateRepo.objectStat)||!stable(state.baseRepo.objectStat,baseRepo.objectStat))rejected();
  if(await readRef(candidateRepo.path,request.result.candidate_ref)!==request.result.candidate_commit)rejected();
  await readAlternate(candidateRepo.path,baseRepo.objects);
  const uniqueBySource=new Map();
  for(const object of state.objects.values()){
    if(!uniqueBySource.has(object.source))uniqueBySource.set(object.source,[]);
    uniqueBySource.get(object.source).push(object.oid);
  }
  for(const [source,oids] of uniqueBySource){
    const kinds=new Map(oids.map(oid=>[oid,state.objects.get(oid).kind]));
    const sizes=new Map(oids.map(oid=>[oid,state.objects.get(oid).bytes]));
    const payloadCap=oids.reduce((sum,oid)=>sum+sizes.get(oid),0);
    const reread=await fetchBatch(source,oids,kinds,sizes,payloadCap);
    for(const oid of oids){
      const before=state.objects.get(oid),after=reread.get(oid);
      if(!after||after.kind!==before.kind||after.bytes!==before.bytes||after.sha256!==before.sha256)rejected();
    }
    for(const item of reread.values())item.payload.fill(0);
  }
  const candidateCommit=await catObject(candidateRepo.path,'commit',request.result.candidate_commit,MAX_COMMIT_BYTES);
  const baseCommit=await catObject(baseRepo.path,'commit',request.result.base_commit,MAX_COMMIT_BYTES);
  try{
    const candidate=parseCommit(candidateCommit,request.result.candidate_commit);
    const base=parseCommit(baseCommit,request.result.base_commit);
    if(candidate.tree!==request.result.candidate_tree||candidate.parents.length!==1||
       candidate.parents[0]!==request.result.base_commit||base.tree!==request.result.base_tree)rejected();
  }finally{candidateCommit.fill(0);baseCommit.fill(0);}
  if(await readRef(candidateRepo.path,request.result.candidate_ref)!==request.result.candidate_commit)rejected();
}

async function reserveRoot(path){
  await ancestorChecks(path);
  if(!await missing(path))rejected();
  checkAbort(activeSignal());
  try{await activeFs().mkdir(path,{recursive:false,mode:0o700});}catch{rejected();}
  const stat=await lstat(path);
  if(!statIs(stat,'directory')||stat.uid!==process.getuid()||(stat.mode&0o7777)!==0o700)rejected();
  await realPathSelf(path);
  return stat;
}
async function ensurePrivateDirectory(root,relative){
  let current=root;
  for(const part of relative.split('/')){
    current=join(current,part);
    if(await missing(current)){
      checkAbort(activeSignal());
      try{await activeFs().mkdir(current,{recursive:false,mode:0o700});}catch{rejected();}
    }
    const stat=await lstat(current);
    if(!statIs(stat,'directory')||stat.uid!==process.getuid()||(stat.mode&0o7777)!==0o700)rejected();
  }
}
async function writePrivateFile(root,relative,bytes){
  const path=join(root,...relative.split('/'));
  const parent=dirname(relative);if(parent!=='.')await ensurePrivateDirectory(root,parent);
  if(!await missing(path))rejected();
  let handle=null,created=null;
  try{
    checkAbort(activeSignal());
    handle=await activeFs().open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    created=await handle.stat();
    if(!statIs(created,'file')||created.uid!==process.getuid()||created.nlink!==1)rejected();
    await handle.writeFile(bytes);
  }catch(error){if(error instanceof SnapshotError)throw error;rejected();}
  finally{if(handle){try{await handle.close();}catch{rejected();}}}
  checkAbort(activeSignal());
  try{await activeFs().chmod(path,0o400);}catch{rejected();}
  const after=await lstat(path);
  if(!statIs(after,'file')||after.uid!==process.getuid()||after.nlink!==1||
     after.dev!==created.dev||after.ino!==created.ino||after.size!==bytes.length||
     (after.mode&0o7777)!==0o400)rejected();
}
async function writeSnapshot(root,state){
  await ensurePrivateDirectory(root,'objects');
  await ensurePrivateDirectory(root,'candidate-files');
  await ensurePrivateDirectory(root,'base-preimages');
  const candidateByOid=new Map(),baseByOid=new Map();
  for(const file of state.candidateFiles){if(!candidateByOid.has(file.oid))candidateByOid.set(file.oid,[]);candidateByOid.get(file.oid).push(file);}
  for(const file of state.basePreimages){if(!baseByOid.has(file.oid))baseByOid.set(file.oid,[]);baseByOid.get(file.oid).push(file);}
  for(const object of [...state.objects.values()].sort((a,b)=>a.oid<b.oid?-1:a.oid>b.oid?1:0)){
    checkAbort(activeSignal());
    if(object.payload.length!==object.bytes||gitOid(object.kind,object.payload)!==object.oid||sha256(object.payload)!==object.sha256)rejected();
    await writePrivateFile(root,`objects/${object.oid.slice(0,2)}/${object.oid.slice(2)}`,object.payload);
    for(const file of candidateByOid.get(object.oid)??[]){
      await writePrivateFile(root,`candidate-files/${file.path}`,object.payload);
    }
    for(const file of baseByOid.get(object.oid)??[]){
      await writePrivateFile(root,`base-preimages/${file.path}`,object.payload);
    }
  }
  await writePrivateFile(root,'manifest.json',state.manifestBytes);
}

function validateInventoryObject(value){
  closed(value,OBJECT_KEYS);
  if(!SHA1.test(value.git_sha1)||!['commit','tree','blob'].includes(value.kind)||
     !Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>MAX_OBJECT_BYTES||!SHA256.test(value.sha256))rejected();
  if(value.kind==='blob'&&value.bytes>MAX_BLOB_BYTES)rejected();
  return Object.freeze({oid:value.git_sha1,kind:value.kind,bytes:value.bytes,sha256:value.sha256});
}
function validateInventoryFile(value){
  closed(value,FILE_KEYS);
  if(!relativePath(value.path)||!['100644','100755'].includes(value.mode)||value.kind!=='blob'||!SHA1.test(value.git_sha1)||
     !Number.isSafeInteger(value.bytes)||value.bytes<0||value.bytes>MAX_BLOB_BYTES||!SHA256.test(value.sha256))rejected();
  return Object.freeze({path:value.path,mode:value.mode,kind:value.kind,oid:value.git_sha1,bytes:value.bytes,sha256:value.sha256});
}
function validateManifest(value){
  try{closed(value,MANIFEST_KEYS);}catch{rejected();}
  if(value.schema!==SNAPSHOT_SCHEMA||!SHA256.test(value.input_result_sha256)||
     typeof value.candidate_ref!=='string'||!/^refs\/heads\/candidate-[A-Za-z0-9_-]{1,64}$/.test(value.candidate_ref)||
     !SHA1.test(value.candidate_commit)||!SHA1.test(value.candidate_tree)||
     !SHA1.test(value.base_commit)||!SHA1.test(value.base_tree))rejected();
  try{closed(value.limits,Object.keys(LIMITS));}catch{rejected();}
  if(canonicalValue(value.limits)!==canonicalValue(LIMITS))rejected();
  const changes=captureArray(value.changed_paths,MAX_CHANGED_PATHS);
  if(changes.length===0||changes.some(path=>!stageRelative(path)))rejected();
  for(let index=1;index<changes.length;index++)if(changes[index-1]>=changes[index])rejected();
  checkPathCollisions(changes);
  const rawObjects=captureArray(value.objects,MAX_OBJECTS);
  const objects=rawObjects.map(validateInventoryObject);
  for(let index=1;index<objects.length;index++)if(objects[index-1].oid>=objects[index].oid)rejected();
  const rawCandidate=captureArray(value.candidate_files,MAX_CANDIDATE_FILES);
  if(rawCandidate.length===0)rejected();
  const candidateFiles=rawCandidate.map(validateInventoryFile);
  const rawPreimages=captureArray(value.base_preimages,MAX_CHANGED_PATHS);
  const basePreimages=rawPreimages.map(validateInventoryFile);
  for(const files of [candidateFiles,basePreimages]){
    for(let index=1;index<files.length;index++)if(files[index-1].path>=files[index].path)rejected();
    checkPathCollisions(files.map(file=>file.path));
  }
  if(!compareLists(changes,[...changes].sort()))rejected();
  const objectBytes=objects.reduce((sum,object)=>sum+object.bytes,0);
  const candidateBytes=candidateFiles.reduce((sum,file)=>sum+file.bytes,0);
  const baseBytes=basePreimages.reduce((sum,file)=>sum+file.bytes,0);
  if(objects.length<2||objects.length>MAX_OBJECTS||objectBytes>MAX_OBJECT_BYTES||
     candidateFiles.length>MAX_CANDIDATE_FILES||basePreimages.length>MAX_CHANGED_PATHS||
     value.object_bytes!==objectBytes||value.candidate_file_bytes!==candidateBytes||
     value.base_preimage_bytes!==baseBytes||!Number.isSafeInteger(value.total_bytes)||
     value.total_bytes>MAX_TOTAL_BYTES||value.total_bytes<objectBytes+candidateBytes+baseBytes||
     !Array.isArray(value.limitations)||canonicalValue(value.limitations)!==canonicalValue(LIMITATIONS))rejected();
  return Object.freeze({
    schema:SNAPSHOT_SCHEMA,input_result_sha256:value.input_result_sha256,
    candidate_ref:value.candidate_ref,candidate_commit:value.candidate_commit,candidate_tree:value.candidate_tree,
    base_commit:value.base_commit,base_tree:value.base_tree,changed_paths:Object.freeze(changes),
    objects:Object.freeze(objects),candidate_files:Object.freeze(candidateFiles),base_preimages:Object.freeze(basePreimages),
    object_bytes:objectBytes,candidate_file_bytes:candidateBytes,base_preimage_bytes:baseBytes,total_bytes:value.total_bytes,
    limitations:LIMITATIONS
  });
}
function expectedInventory(manifest){
  const files=new Set(['manifest.json']),directories=new Set(['objects','candidate-files','base-preimages']);
  const addFile=relative=>{
    files.add(relative);
    let parent=dirname(relative);
    while(parent!=='.'){
      directories.add(parent);parent=dirname(parent);
    }
  };
  for(const object of manifest.objects)addFile(`objects/${object.oid.slice(0,2)}/${object.oid.slice(2)}`);
  for(const file of manifest.candidate_files)addFile(`candidate-files/${file.path}`);
  for(const file of manifest.base_preimages)addFile(`base-preimages/${file.path}`);
  return {files,directories};
}
async function walkOutput(root,signal){
  const files=[],directories=[];let count=0;
  const visit=async(relative)=>{
    checkAbort(signal);
    const path=relative?join(root,...relative.split('/')):root;
    let directory;try{directory=await activeFs().opendir(path,{bufferSize:1});}catch{rejected();}
    let failed=false;
    try{
      while(true){
        checkAbort(signal);
        let entry;try{entry=await directory.read();}catch{rejected();}
        if(entry===null)break;
        if(++count>MAX_OUTPUT_ENTRIES||typeof entry.name!=='string'||!entry.name||entry.name==='.'||entry.name==='..'||entry.name.includes('/'))rejected();
        const childRelative=relative?`${relative}/${entry.name}`:entry.name;
        const childPath=join(root,...childRelative.split('/'));
        const stat=await lstat(childPath);
        if(statIs(stat,'directory')){
          if(stat.uid!==process.getuid()||(stat.mode&0o7777)!==0o700)rejected();
          directories.push(childRelative);await visit(childRelative);
        }else if(statIs(stat,'file')){
          if(stat.uid!==process.getuid()||stat.nlink!==1||(stat.mode&0o7777)!==0o400||
             !Number.isSafeInteger(stat.size)||stat.size<0)rejected();
          files.push(Object.freeze({path:childRelative,size:stat.size}));
        }else rejected();
      }
    }catch(error){failed=true;if(error instanceof SnapshotError)throw error;rejected();}
    finally{try{await directory.close();}catch{if(!failed)rejected();}}
  };
  const rootStat=await lstat(root);
  if(!statIs(rootStat,'directory')||rootStat.uid!==process.getuid()||(rootStat.mode&0o7777)!==0o700)rejected();
  await realPathSelf(root);
  await visit('');
  return Object.freeze({files:Object.freeze(files),directories:Object.freeze(directories),rootStat});
}
async function readInventoryObject(root,record){
  const path=`objects/${record.oid.slice(0,2)}/${record.oid.slice(2)}`;
  const bytes=await readStableFile(join(root,...path.split('/')),MAX_OBJECT_BYTES,0o400);
  if(bytes.length!==record.bytes||sha256(bytes)!==record.sha256||gitOid(record.kind,bytes)!==record.oid){bytes.fill(0);rejected();}
  return bytes;
}
function parseCommitFromInventory(oid,objects){
  const record=objects.get(oid);if(!record||record.kind!=='commit')rejected();
  return parseCommit(record.payload,oid);
}
function verifyTreeClosure(rootOid,objects,maxFiles,maxMetadata){
  return collectRawTree(rootOid,objects,maxFiles,maxMetadata);
}
function verifyManifestObjectClosure(manifest,objects,candidateTree,baseTree,candidateCommit,baseCommit){
  if(candidateCommit.tree!==manifest.candidate_tree||candidateCommit.parents.length!==1||
     candidateCommit.parents[0]!==manifest.base_commit||baseCommit.tree!==manifest.base_tree)rejected();
  const actualChanges=computeChanges(baseTree.files,candidateTree.files);
  if(!compareLists(actualChanges,manifest.changed_paths))rejected();
  const baseByPath=new Map(baseTree.files.map(file=>[file.path,file]));
  for(const candidate of candidateTree.files){
    const old=baseByPath.get(candidate.path);
    if(candidate.mode==='100755'&&(!old||old.mode!=='100755'||old.oid!==candidate.oid))rejected();
  }
  const expected=new Map();
  const add=(oid,kind)=>{const previous=expected.get(oid);if(previous&&previous!==kind)rejected();expected.set(oid,kind);};
  add(manifest.candidate_commit,'commit');add(manifest.base_commit,'commit');
  add(manifest.candidate_tree,'tree');add(manifest.base_tree,'tree');
  for(const tree of candidateTree.trees)add(tree.oid,'tree');
  for(const tree of baseTree.trees)add(tree.oid,'tree');
  for(const file of candidateTree.files)add(file.oid,'blob');
  const baseByPathChanged=new Map(baseTree.files.map(file=>[file.path,file]));
  for(const path of actualChanges){const old=baseByPathChanged.get(path);if(old)add(old.oid,'blob');}
  if(expected.size!==objects.size||[...expected].some(([oid,kind])=>objects.get(oid)?.kind!==kind))rejected();
  const expectedCandidate=fileDescriptors(candidateTree.files,objects);
  const expectedPreimages=changedDescriptors(actualChanges,baseTree.files,objects);
  const compareFiles=(left,right)=>left.length===right.length&&left.every((item,index)=>
    item.path===right[index].path&&item.mode===right[index].mode&&item.kind===right[index].kind&&item.oid===right[index].oid&&
    item.bytes===right[index].bytes&&item.sha256===right[index].sha256);
  if(!compareFiles(manifest.candidate_files,expectedCandidate)||!compareFiles(manifest.base_preimages,expectedPreimages))rejected();
  return Object.freeze({actualChanges});
}
async function verifySnapshotInternal(snapshotDir,signal){
  if(!absolutePath(snapshotDir))invalid();
  await ancestorChecks(snapshotDir);
  const inventory=await walkOutput(snapshotDir,signal);
  const manifestBytes=await readStableFile(join(snapshotDir,'manifest.json'),MAX_MANIFEST_BYTES,0o400);
  let raw,manifest;
  try{
    raw=parseStrictJson(manifestBytes,MAX_MANIFEST_BYTES);
    const canonical=canonicalBytes(raw);
    if(!canonical.equals(manifestBytes))rejected();
    manifest=validateManifest(raw);
  }finally{manifestBytes.fill(0);}
  const expected=expectedInventory(manifest);
  const actualFiles=inventory.files.map(file=>file.path).sort();
  const actualDirs=inventory.directories.slice().sort();
  if(!compareLists([...expected.files].sort(),actualFiles)||!compareLists([...expected.directories].sort(),actualDirs))rejected();
  const stats=new Map(inventory.files.map(file=>[file.path,file.size]));
  let outputBytes=0;
  for(const path of expected.files){
    const size=stats.get(path);if(!Number.isSafeInteger(size)||size<0)rejected();
    outputBytes+=size;if(!Number.isSafeInteger(outputBytes)||outputBytes>MAX_TOTAL_BYTES)rejected();
  }
  if(outputBytes!==manifest.total_bytes||stats.get('manifest.json')!==canonicalBytes(raw).length)rejected();
  const objectMap=new Map();let objectBytes=0;
  for(const record of manifest.objects){
    const payload=await readInventoryObject(snapshotDir,record);
    objectMap.set(record.oid,Object.freeze({oid:record.oid,kind:record.kind,bytes:record.bytes,sha256:record.sha256,payload}));
    objectBytes+=record.bytes;
  }
  if(objectBytes!==manifest.object_bytes)rejected();
  const candidateCommit=parseCommitFromInventory(manifest.candidate_commit,objectMap);
  const baseCommit=parseCommitFromInventory(manifest.base_commit,objectMap);
  const candidateTree=verifyTreeClosure(manifest.candidate_tree,objectMap,MAX_CANDIDATE_FILES,MAX_CANDIDATE_METADATA_BYTES);
  const baseTree=verifyTreeClosure(manifest.base_tree,objectMap,MAX_BASE_FILES,MAX_BASE_METADATA_BYTES);
  const closure=verifyManifestObjectClosure(manifest,objectMap,candidateTree,baseTree,candidateCommit,baseCommit);
  for(const file of manifest.candidate_files){
    const bytes=await readStableFile(join(snapshotDir,'candidate-files',...file.path.split('/')),MAX_BLOB_BYTES,0o400);
    try{if(bytes.length!==file.bytes||sha256(bytes)!==file.sha256||gitOid('blob',bytes)!==file.oid)rejected();}
    finally{bytes.fill(0);}
  }
  for(const file of manifest.base_preimages){
    const bytes=await readStableFile(join(snapshotDir,'base-preimages',...file.path.split('/')),MAX_BLOB_BYTES,0o400);
    try{if(bytes.length!==file.bytes||sha256(bytes)!==file.sha256||gitOid('blob',bytes)!==file.oid)rejected();}
    finally{bytes.fill(0);}
  }
  const rootAfter=await lstat(snapshotDir);
  checkAbort(signal);
  if(!stable(inventory.rootStat,rootAfter)||!statIs(rootAfter,'directory')||rootAfter.uid!==process.getuid()||
     (rootAfter.mode&0o7777)!==0o700)rejected();
  return Object.freeze({
    status:'VERIFIED_FOR_PRIVATE_REVIEW',manifest_sha256:sha256(canonicalBytes(raw)),
    input_result_sha256:manifest.input_result_sha256,candidate_commit:manifest.candidate_commit,
    candidate_tree:manifest.candidate_tree,base_commit:manifest.base_commit,base_tree:manifest.base_tree,
    changed_path_count:closure.actualChanges.length,object_count:manifest.objects.length,
    candidate_file_count:manifest.candidate_files.length,base_preimage_count:manifest.base_preimages.length,
    total_bytes:manifest.total_bytes
  });
}

/** Create one private snapshot from the exact original PR210 result and two selected stores. */
export async function buildProjectPortableCandidateSnapshot(spec,options={}){
  let request=null,state=null;
  try{
    const fsPort=captureFsOptions(options);
    request=captureRequest(spec);
    return await fsContext.run(fsPort,()=>signalContext.run(request.signal,async()=>{
      checkAbort(request.signal);
      const candidateRepo=await sourceDirectory(request.candidate_git_dir,request.candidate_git_identity,{bare:true});
      const baseRepo=await sourceDirectory(request.base_git_dir,request.base_git_identity,{
        bare:basename(request.base_git_dir)!=='.git',forbidAlternates:true
      });
      await readAlternate(candidateRepo.path,baseRepo.objects);
      state=await gatherSource(request,candidateRepo,baseRepo);
      const outputStat=await reserveRoot(request.output_dir);
      await writeSnapshot(request.output_dir,state);
      await recheckSources(request,state);
      // Read back the complete closed directory and verify it without source-store access.
      const verification=await verifySnapshotInternal(request.output_dir,request.signal);
      const rootAfter=await lstat(request.output_dir);
      checkAbort(request.signal);
      if(!sameDirectoryIdentity(outputStat,rootAfter)||!statIs(rootAfter,'directory')||
         (rootAfter.mode&0o7777)!==0o700)rejected();
      return Object.freeze({
        status:'PORTABLE_CANDIDATE_SNAPSHOT_CREATED',manifest_sha256:verification.manifest_sha256,
        input_result_sha256:verification.input_result_sha256,candidate_commit:verification.candidate_commit,
        candidate_tree:verification.candidate_tree,base_commit:verification.base_commit,base_tree:verification.base_tree,
        changed_path_count:verification.changed_path_count,object_count:verification.object_count,
        candidate_file_count:verification.candidate_file_count,base_preimage_count:verification.base_preimage_count,
        total_bytes:verification.total_bytes
      });
    }));
  }catch(error){
    if(error instanceof SnapshotError)throw error;
    if(request?.signal&&signalAborted(request.signal))throw new SnapshotError('PROJECT_PORTABLE_SNAPSHOT_ABORTED');
    throw new SnapshotError('PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  }finally{
    for(const object of state?.objects?.values()??[])object.payload.fill(0);
    state?.manifestBytes?.fill(0);
  }
}

/** Verify a copied snapshot offline. No base repository or alternate is accepted. */
export async function verifyProjectPortableCandidateSnapshot(snapshotDir,options={}){
  let signal;
  try{
    if(!isPlainRecord(options))invalid();
    closed(options,[],['signal','fs']);
    signal=captureSignal(options.signal);
    const fsPort=captureFsPort(Object.hasOwn(options,'fs')?Object.getOwnPropertyDescriptor(options,'fs').value:undefined);
    return await fsContext.run(fsPort,()=>signalContext.run(signal,async()=>{
      checkAbort(signal);return await verifySnapshotInternal(snapshotDir,signal);
    }));
  }catch(error){
    if(error instanceof SnapshotError)throw error;
    if(signal&&signalAborted(signal))throw new SnapshotError('PROJECT_PORTABLE_SNAPSHOT_ABORTED');
    throw new SnapshotError('PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  }
}

// Shared, read-only PR210 source inspection for the bounded changed-file review
// package. It deliberately does not build a portable inventory or read unchanged
// blobs. Snapshot entry points above retain their original behavior.
export async function readProjectCandidateReviewSource(spec,options={}){
  let request;
  try{
    closed(options,[],['fs']);
    const fsPort=captureFsPort(options.fs);
    closed(spec,['schema','result','candidate_git_dir','candidate_git_identity',
      'base_git_dir','base_git_identity','output_dir'],['signal']);
    if(spec.schema!=='SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1')invalid();
    request=captureRequest({...spec,schema:REQUEST_SCHEMA});
    return await fsContext.run(fsPort,()=>signalContext.run(request.signal,async()=>{
      checkAbort(request.signal);
      const candidateRepo=await sourceDirectory(request.candidate_git_dir,request.candidate_git_identity,{bare:true});
      const baseRepo=await sourceDirectory(request.base_git_dir,request.base_git_identity,{
        bare:basename(request.base_git_dir)!=='.git',forbidAlternates:true
      });
      await readAlternate(candidateRepo.path,baseRepo.objects);
      const result=request.result;
      if(await readRef(candidateRepo.path,result.candidate_ref)!==result.candidate_commit)rejected();
      const candidateCommit=parseCommit(await catObject(candidateRepo.path,'commit',result.candidate_commit,MAX_COMMIT_BYTES),result.candidate_commit);
      const baseCommit=parseCommit(await catObject(baseRepo.path,'commit',result.base_commit,MAX_COMMIT_BYTES),result.base_commit);
      if(candidateCommit.tree!==result.candidate_tree||candidateCommit.parents.length!==1||
         candidateCommit.parents[0]!==result.base_commit||baseCommit.tree!==result.base_tree)rejected();
      const candidateListing=parseGitTreeListing(await gitBytes(candidateRepo.path,
        ['ls-tree','-rtz','--full-tree',result.candidate_tree],MAX_CANDIDATE_METADATA_BYTES),
        MAX_CANDIDATE_FILES,MAX_CANDIDATE_METADATA_BYTES);
      const baseListing=parseGitTreeListing(await gitBytes(baseRepo.path,
        ['ls-tree','-rtz','--full-tree',result.base_tree],MAX_BASE_METADATA_BYTES),
        MAX_BASE_FILES,MAX_BASE_METADATA_BYTES);
      const changed=computeChanges(baseListing.files,candidateListing.files);
      if(!compareLists(changed,result.changed_paths))rejected();
      for(const path of changed)if(!stageRelative(path))rejected();
      const baseByPath=new Map(baseListing.files.map(row=>[row.path,row]));
      const candidateByPath=new Map(candidateListing.files.map(row=>[row.path,row]));
      for(const path of changed)if(candidateByPath.get(path)?.mode!=='100644')rejected();
      for(const row of candidateListing.files){
        const old=baseByPath.get(row.path);
        if(row.mode==='100755'&&(!old||old.mode!=='100755'||old.oid!==row.oid))rejected();
      }
      const kinds=new Map();
      for(const row of [...candidateListing.trees,...baseListing.trees])addExpectedKind(kinds,row.oid,'tree');
      addExpectedKind(kinds,result.candidate_tree,'tree');addExpectedKind(kinds,result.base_tree,'tree');
      const treeOids=[...kinds.keys()].sort();
      const raw=new Map();let totalTreeBytes=0;
      // The review profile permits the PR210 tree-record ceiling even when
      // it exceeds the portable snapshot's 8,192-object inventory ceiling.
      for(let start=0;start<treeOids.length;start+=4096){
        const group=treeOids.slice(start,start+4096);
        const groupKinds=new Map(group.map(oid=>[oid,'tree']));
        const sizes=await checkBatchSizes(candidateRepo.path,group,groupKinds);
        const groupBytes=[...sizes.values()].reduce((sum,size)=>sum+size,0);
        totalTreeBytes+=groupBytes;
        if(totalTreeBytes>MAX_BASE_METADATA_BYTES+MAX_CANDIDATE_METADATA_BYTES)rejected();
        for(const [oid,record] of await fetchBatch(candidateRepo.path,group,groupKinds,sizes,groupBytes))raw.set(oid,record);
      }
      const objects=new Map(raw);
      for(const row of [...candidateListing.files,...baseListing.files]){
        if(objects.has(row.oid)&&objects.get(row.oid).kind!=='blob')rejected();
        if(!objects.has(row.oid))objects.set(row.oid,{kind:'blob',payload:Buffer.alloc(0)});
      }
      const candidateTree=collectRawTree(result.candidate_tree,objects,MAX_CANDIDATE_FILES,MAX_CANDIDATE_METADATA_BYTES);
      const baseTree=collectRawTree(result.base_tree,objects,MAX_BASE_FILES,MAX_BASE_METADATA_BYTES);
      if(!sameListing(candidateListing,candidateTree)||!sameListing(baseListing,baseTree)||
         !compareLists(computeChanges(baseTree.files,candidateTree.files),changed))rejected();
      const blobOids=[...new Set([...candidateTree.files,...baseTree.files].map(row=>row.oid))].sort();
      for(let start=0;start<blobOids.length;start+=4096){
        const group=blobOids.slice(start,start+4096);
        await checkBatchSizes(candidateRepo.path,group,new Map(group.map(oid=>[oid,'blob'])));
      }
      const files=[];let copied=0;
      for(const path of changed){
        const old=baseByPath.get(path)??null,next=candidateByPath.get(path);
        const oldBytes=old?await catObject(baseRepo.path,'blob',old.oid,MAX_BLOB_BYTES):null;
        const newBytes=await catObject(candidateRepo.path,'blob',next.oid,MAX_BLOB_BYTES);
        copied+=(oldBytes?.length??0)+newBytes.length;
        if(copied>8*1024*1024)rejected();
        files.push(Object.freeze({path,
          old:old?Object.freeze({mode:old.mode,git_sha1:old.oid,bytes:oldBytes.length,sha256:sha256(oldBytes),data:oldBytes}):null,
          new:Object.freeze({mode:next.mode,git_sha1:next.oid,bytes:newBytes.length,sha256:sha256(newBytes),data:newBytes})}));
      }
      if(await readRef(candidateRepo.path,result.candidate_ref)!==result.candidate_commit)rejected();
      const candidateAfter=await sourceDirectory(request.candidate_git_dir,request.candidate_git_identity,{bare:true});
      const baseAfter=await sourceDirectory(request.base_git_dir,request.base_git_identity,{
        bare:basename(request.base_git_dir)!=='.git',forbidAlternates:true
      });
      if(!stable(candidateRepo.stat,candidateAfter.stat)||!stable(baseRepo.stat,baseAfter.stat)||
         !stable(candidateRepo.objectStat,candidateAfter.objectStat)||!stable(baseRepo.objectStat,baseAfter.objectStat))rejected();
      await readAlternate(candidateRepo.path,baseRepo.objects);
      return Object.freeze({result,input_result_sha256:sha256(canonicalBytes(result)),files:Object.freeze(files)});
    }));
  }catch(error){
    if(error instanceof SnapshotError)throw error;
    if(request?.signal&&signalAborted(request.signal))aborted();
    rejected();
  }
}

function publicLines(result){
  return [
    result.status,`Candidate commit: ${result.candidate_commit}`,`Candidate tree: ${result.candidate_tree}`,
    `Base commit: ${result.base_commit}`,`Base tree: ${result.base_tree}`,
    `Input result SHA-256: ${result.input_result_sha256}`,`Manifest SHA-256: ${result.manifest_sha256}`,
    `Changed path count: ${result.changed_path_count}`,`Object count: ${result.object_count}`,
    `Candidate file count: ${result.candidate_file_count}`,`Base preimage count: ${result.base_preimage_count}`,
    `Total bytes: ${result.total_bytes}`,'\n'
  ].join('\n');
}
async function readCliSpec(path){
  const bytes=await readStableFile(path,MAX_REQUEST_BYTES,0o400);
  try{return parseStrictJson(bytes,MAX_REQUEST_BYTES);}finally{bytes.fill(0);}
}
function cliFailureCode(error,forVerify){
  if(error instanceof SnapshotError&&error.code==='PROJECT_PORTABLE_SNAPSHOT_ABORTED')return 'PROJECT_PORTABLE_SNAPSHOT_ABORTED';
  if(error instanceof SnapshotError&&error.code==='INVALID_PROJECT_PORTABLE_SNAPSHOT_SPEC')return 'INVALID_PROJECT_PORTABLE_SNAPSHOT_SPEC';
  return forVerify?'PROJECT_PORTABLE_SNAPSHOT_INVALID':'PROJECT_PORTABLE_SNAPSHOT_REJECTED';
}
/** Explicit fixed-status local CLI router; import and default invocation are inert. */
export async function runProjectPortableCandidateSnapshotCli(argv,ports={}){
  const output=key=>{
    const stream=ports[key]??process[key];
    if(!stream||typeof stream.write!=='function')invalid();
    return text=>{
      try{stream.write(text);}catch{throw new SnapshotError('PROJECT_PORTABLE_SNAPSHOT_REJECTED');}
    };
  };
  let stdout,stderr;try{stdout=output('stdout');stderr=output('stderr');}catch{return 2;}
  if(!Array.isArray(argv)||argv.length!==2||!['--build','--verify'].includes(argv[0])||!absolutePath(argv[1])){
    stderr('Usage: node bin/squire-portable-candidate.mjs --build <spec.json> | --verify <snapshot-dir>\n');return 2;
  }
  const verify=argv[0]==='--verify';
  try{
    let result;
    if(verify)result=await verifyProjectPortableCandidateSnapshot(argv[1]);
    else{
      const request=await readCliSpec(argv[1]);
      result=await buildProjectPortableCandidateSnapshot(request);
    }
    stdout(publicLines(result));return 0;
  }catch(error){stderr(`${cliFailureCode(error,verify)}\n`);return 2;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await runProjectPortableCandidateSnapshotCli(process.argv.slice(2));
}

// Separate P1b source reader. It binds three pinned stores and two direct endpoint
// comparisons; the original PR210 reader above intentionally remains unchanged.
export async function readProjectRevisionReviewSource(spec,options={}){
  let signal;
  try{
    closed(options,[],['fs']);const fsPort=captureFsPort(options.fs);
    closed(spec,['schema','original_result','revised_result','base_git_dir','base_git_identity',
      'original_git_dir','original_git_identity','revised_git_dir','revised_git_identity','output_dir'],['signal']);
    if(spec.schema!=='SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1')invalid();
    signal=captureSignal(spec.signal);
    const original=captureResult(spec.original_result);
    const revision=spec.revised_result;
    closed(revision,[...RESULT_KEYS,'correction_origin','revision_of','revised_blobs']);
    if(revision.schema!=='SQUIRE_PROJECT_REVISION_CANDIDATE_V1'||revision.status!=='SOURCE_REVISION_CANDIDATE_CREATED'||
      revision.correction_origin!=='OPERATOR_SUPPLIED')invalid();
    const {correction_origin,revision_of,revised_blobs,...common}=revision;
    captureResult({...common,schema:RESULT_SCHEMA,status:'SOURCE_CANDIDATE_CREATED'});
    closed(revision_of,['commit','tree']);
    if(revision_of.commit!==original.candidate_commit||revision_of.tree!==original.candidate_tree||
       revision.base_commit!==original.base_commit||revision.base_tree!==original.base_tree||
       revision.receipt_sha256!==original.receipt_sha256||
       revision.stage_manifest_sha256!==original.stage_manifest_sha256||
       revision.candidate_commit===original.candidate_commit)rejected();
    const witnesses=denseArray(revised_blobs,50);
    if(witnesses.length<1)rejected();
    let prior='',newTotal=0,oldTotal=0;for(const row of witnesses){
      closed(row,['path','previous_blob','previous_bytes','previous_sha256','blob','bytes','sha256']);
      if(!stageRelative(row.path)||row.path<=prior||!SHA1.test(row.previous_blob)||!SHA1.test(row.blob)||
         !SHA256.test(row.previous_sha256)||!SHA256.test(row.sha256)||
         !Number.isSafeInteger(row.previous_bytes)||row.previous_bytes<0||row.previous_bytes>524288||
         !Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>524288||row.previous_blob===row.blob)rejected();newTotal+=row.bytes;oldTotal+=row.previous_bytes;
      if(newTotal>4*1024*1024||oldTotal>4*1024*1024)rejected();prior=row.path;
    }
    for(const key of ['base_git_dir','original_git_dir','revised_git_dir','output_dir'])if(!absolutePath(spec[key]))invalid();
    if(basename(spec.original_git_dir)==='.git'||basename(spec.revised_git_dir)==='.git')invalid();
    const protectedBase=basename(spec.base_git_dir)==='.git'?dirname(spec.base_git_dir):spec.base_git_dir;
    const roots=[protectedBase,spec.original_git_dir,spec.revised_git_dir,spec.output_dir];
    for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)if(pathsOverlap(roots[i],roots[j]))invalid();
    const ids=['base_git_identity','original_git_identity','revised_git_identity'].map(key=>captureIdentity(spec[key]));
    return await fsContext.run(fsPort,()=>signalContext.run(signal,async()=>{
      checkAbort(signal);
      const base=await sourceDirectory(spec.base_git_dir,ids[0],{bare:basename(spec.base_git_dir)!=='.git',forbidAlternates:true});
      const orig=await sourceDirectory(spec.original_git_dir,ids[1],{bare:true});
      const rev=await sourceDirectory(spec.revised_git_dir,ids[2],{bare:true});
      await readAlternate(orig.path,base.objects);await readAlternate(rev.path,base.objects);
      const refs=[[orig,original],[rev,revision]];
      for(const [repo,result] of refs)if(await readRef(repo.path,result.candidate_ref)!==result.candidate_commit)rejected();
      const baseCommit=parseCommit(await catObject(base.path,'commit',original.base_commit,MAX_COMMIT_BYTES),original.base_commit);
      if(baseCommit.tree!==original.base_tree)rejected();
      for(const [repo,result] of refs){
        const commit=parseCommit(await catObject(repo.path,'commit',result.candidate_commit,MAX_COMMIT_BYTES),result.candidate_commit);
        if(commit.tree!==result.candidate_tree||commit.parents.length!==1||commit.parents[0]!==result.base_commit)rejected();
      }
      const specs=[[base,original.base_tree,MAX_BASE_FILES,MAX_BASE_METADATA_BYTES],
        [orig,original.candidate_tree,MAX_CANDIDATE_FILES,MAX_CANDIDATE_METADATA_BYTES],
        [rev,revision.candidate_tree,MAX_CANDIDATE_FILES,MAX_CANDIDATE_METADATA_BYTES]];
      const listings=[];
      for(const [repo,tree,maxFiles,maxMeta] of specs){
        const listing=parseGitTreeListing(await gitBytes(repo.path,['ls-tree','-rtz','--full-tree',tree],maxMeta),maxFiles,maxMeta);
        const kinds=new Map();for(const row of listing.trees)addExpectedKind(kinds,row.oid,'tree');addExpectedKind(kinds,tree,'tree');
        const raw=new Map();let treeBytes=0,treeOids=[...kinds.keys()].sort();
        for(let start=0;start<treeOids.length;start+=4096){
          const group=treeOids.slice(start,start+4096),groupKinds=new Map(group.map(oid=>[oid,'tree']));
          const sizes=await checkBatchSizes(repo.path,group,groupKinds);
          const groupBytes=[...sizes.values()].reduce((sum,n)=>sum+n,0);treeBytes+=groupBytes;
          if(treeBytes>maxMeta)rejected();
          for(const [key,value] of await fetchBatch(repo.path,group,groupKinds,sizes,groupBytes))raw.set(key,value);
        }
        const objects=new Map(raw);
        for(const row of listing.files)if(!objects.has(row.oid))objects.set(row.oid,{kind:'blob',payload:Buffer.alloc(0)});
        const checked=collectRawTree(tree,objects,maxFiles,maxMeta);
        if(!sameListing(listing,checked))rejected();
        const blobs=[...new Set(checked.files.map(row=>row.oid))].sort();
        for(let start=0;start<blobs.length;start+=4096){const group=blobs.slice(start,start+4096);
          await checkBatchSizes(repo.path,group,new Map(group.map(oid=>[oid,'blob'])));}
        listings.push(checked);
      }
      const [baseTree,originalTree,revisedTree]=listings;
      const baseToOriginal=computeChanges(baseTree.files,originalTree.files);
      if(!compareLists(baseToOriginal,original.changed_paths))rejected();
      const baseMap=new Map(baseTree.files.map(row=>[row.path,row]));
      for(const listing of [originalTree,revisedTree])for(const row of listing.files)if(row.mode==='100755'){
        const old=baseMap.get(row.path);if(!old||old.mode!=='100755'||old.oid!==row.oid)rejected();}
      const baseToRevised=computeChanges(baseTree.files,revisedTree.files);
      const originalToRevised=computeChanges(originalTree.files,revisedTree.files);
      if(!compareLists(baseToRevised,revision.changed_paths)||!compareLists(originalToRevised,witnesses.map(row=>row.path)))rejected();
      const union=[...new Set([...baseToRevised,...originalToRevised])].sort();if(union.length>50)rejected();
      for(const path of union)if(!stageRelative(path))rejected();checkPathCollisions(union);
      const maps=listings.map(listing=>new Map(listing.files.map(row=>[row.path,row])));
      for(const path of union){const row=maps[2].get(path),baseRow=maps[0].get(path);
        if(!row||(row.mode!=='100644'&&!(row.mode==='100755'&&baseRow?.mode==='100755'&&baseRow.oid===row.oid)))rejected();}
      const files=[];let copyBytes=0;
      for(const path of union){
        const sides=[];
        for(let i=0;i<3;i++){
          const needed=i===2||(i===0?baseToRevised.includes(path):originalToRevised.includes(path));
          const row=needed?maps[i].get(path):null;if(!row){sides.push(null);continue;}
          const bytes=await catObject(specs[i][0].path,'blob',row.oid,MAX_BLOB_BYTES);
          const side={mode:row.mode,git_sha1:row.oid,bytes:bytes.length,sha256:sha256(bytes),data:bytes};
          if(bytes.length>4*1024*1024)rejected();copyBytes+=bytes.length;sides.push(side);
        }
        const witness=witnesses.find(row=>row.path===path);
        if(witness){const [,,next]=sides,prev=sides[1];if(!prev||
          witness.previous_blob!==prev.git_sha1||witness.previous_bytes!==prev.bytes||witness.previous_sha256!==prev.sha256||
          witness.blob!==next.git_sha1||witness.bytes!==next.bytes||witness.sha256!==next.sha256)rejected();}
        files.push({path,base:sides[0],original:sides[1],revised:sides[2]});
      }
      if(copyBytes>12*1024*1024)rejected();
      for(const [repo,result] of refs)if(await readRef(repo.path,result.candidate_ref)!==result.candidate_commit)rejected();
      for(const [repo,path,id,bare] of [[base,spec.base_git_dir,ids[0],basename(spec.base_git_dir)!=='.git'],
        [orig,spec.original_git_dir,ids[1],true],[rev,spec.revised_git_dir,ids[2],true]]){
        const after=await sourceDirectory(path,id,{bare,forbidAlternates:repo===base});
        if(!stable(repo.stat,after.stat)||!stable(repo.objectStat,after.objectStat))rejected();
        if(repo!==base)await readAlternate(repo.path,base.objects);
      }
      return Object.freeze({original_result:original,revised_result:revision,
        original_result_sha256:sha256(canonicalBytes(original)),revised_result_sha256:sha256(canonicalBytes(revision)),
        base_to_revised:baseToRevised,original_to_revised:originalToRevised,files});
    }));
  }catch(error){if(error instanceof SnapshotError)throw error;if(signal&&signalAborted(signal))aborted();rejected();}
}
