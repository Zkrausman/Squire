// Private, bounded review and append-only decision records for one original PR210 candidate.
// This module never executes candidate bytes or selects a decision implicitly.
import {recordFailure} from './internal/decision-request-feedback.mjs';
import * as nativeFs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,parse,resolve} from 'node:path';
import {types} from 'node:util';
import {readProjectCandidateReviewSource,readProjectCandidateReviewSnapshotSource} from './project-portable-candidate-snapshot.mjs';
import {MAX_REVIEW_DECISION_BYTES} from './project-review-decision-limits.mjs';

const PACKAGE_SCHEMA='SQUIRE_PROJECT_CANDIDATE_REVIEW_PACKAGE_V1';
const DECISION_SCHEMA='SQUIRE_PROJECT_CANDIDATE_DECISION_V1';
const SHA1=/^[a-f0-9]{40}$/;const SHA256=/^[a-f0-9]{64}$/;
const TOKEN=/^[A-Za-z0-9_-]{1,64}$/;
const MAX_SIDE=4*1024*1024,MAX_COPIES=8*1024*1024,MAX_DIFF=8*1024*1024;
const MAX_MANIFEST=256*1024,MAX_PACKAGE=17*1024*1024;
const MAX_OUTPUT_ENTRIES=50*7+2*50+3;
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
class ReviewPackageError extends Error{
  constructor(code){super(code);this.name='ProjectCandidateReviewError';this.code=code;delete this.stack;}
}
const invalid=()=>{throw new ReviewPackageError('INVALID_PROJECT_CANDIDATE_REVIEW_SPEC');};
const rejected=()=>{throw new ReviewPackageError('PROJECT_CANDIDATE_REVIEW_REJECTED');};
const aborted=()=>{throw new ReviewPackageError('PROJECT_CANDIDATE_REVIEW_ABORTED');};
const digest=value=>createHash('sha256').update(value).digest('hex');
// Recursive key sorting keeps JSON canonical independent of caller insertion order.
function sorted(value){
  if(Array.isArray(value))return value.map(sorted);
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]));
  return value;
}
const encode=value=>Buffer.from(JSON.stringify(sorted(value)),'utf8');
function plain(value){return value!==null&&typeof value==='object'&&!types.isProxy(value)&&
  !Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}
function matchesKeys(value,keys){
  return plain(value)&&Reflect.ownKeys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
}
function closed(value,keys,optional=[]){
  if(!plain(value)||Reflect.ownKeys(value).some(key=>typeof key!=='string'||![...keys,...optional].includes(key))||
     keys.some(key=>!Object.hasOwn(value,key)))invalid();
  for(const key of Reflect.ownKeys(value))if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))invalid();
}
function absolute(path){return typeof path==='string'&&path.length>1&&path.length<=4096&&path.startsWith('/')&&
  resolve(path)===path&&path!==parse(path).root&&!/[\\\u0000-\u001f\u007f]/u.test(path);}
function captureSignal(signal){
  if(signal===undefined)return undefined;
  if(!signal||types.isProxy(signal)||typeof signal!=='object')invalid();
  try{if(!(signal instanceof AbortSignal))invalid();}catch{invalid();}
  return signal;
}
function check(signal){if(signal?.aborted)aborted();}
const nativePort=Object.freeze(Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(name=>
  [name,(...args)=>nativeFs[name](...args)])));
function capturePort(ports){
  closed(ports,[],['fs']);
  if(!Object.hasOwn(ports,'fs'))return nativePort;
  const fs=ports.fs;closed(fs,['lstat','realpath','mkdir','open','chmod','opendir']);
  const result={};for(const key of Object.keys(nativePort)){
    if(typeof fs[key]!=='function'||types.isProxy(fs[key]))invalid();
    result[key]=(...args)=>Reflect.apply(fs[key],fs,args);
  }return Object.freeze(result);
}
function isMissing(error){return error?.code==='ENOENT';}
function file(stat){return stat?.isFile?.()===true&&stat.isSymbolicLink?.()===false;}
function dir(stat){return stat?.isDirectory?.()===true&&stat.isSymbolicLink?.()===false;}
function stable(a,b){return ['dev','ino','size','mtimeMs','ctimeMs'].every(key=>a?.[key]===b?.[key]);}
async function stat(fs,path){try{return await fs.lstat(path);}catch{rejected();}}
async function ancestors(fs,path){
  let current=parse(path).root;const parts=dirname(path).slice(current.length).split('/').filter(Boolean);
  for(const target of [current,...parts.map(part=>{current=join(current,part);return current;})]){
    const s=await stat(fs,target);
    if(!dir(s)||!Number.isSafeInteger(s.uid)||!Number.isSafeInteger(s.mode)||
       !(((s.uid===process.getuid()||s.uid===0)&&(s.mode&0o022)===0)||
         (s.uid===0&&(s.mode&0o1000)===0o1000)))rejected();
  }
}
async function missing(fs,path){try{await fs.lstat(path);return false;}catch(error){if(isMissing(error))return true;rejected();}}
async function reserve(fs,path,signal){
  await ancestors(fs,path);if(!await missing(fs,path))rejected();check(signal);
  try{await fs.mkdir(path,{recursive:false,mode:0o700});}catch{rejected();}
  const s=await stat(fs,path);if(!dir(s)||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700)rejected();
  if(await fs.realpath(path)!==path)rejected();return s;
}
async function ensureDir(fs,root,relative,signal){
  let path=root;for(const part of relative.split('/')){
    path=join(path,part);if(await missing(fs,path)){check(signal);try{await fs.mkdir(path,{recursive:false,mode:0o700});}catch{rejected();}}
    const s=await stat(fs,path);if(!dir(s)||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700)rejected();
  }
}
async function writeFile(fs,root,relative,bytes,signal){
  const path=join(root,...relative.split('/')),parent=dirname(relative);
  if(parent!=='.')await ensureDir(fs,root,parent,signal);
  if(!await missing(fs,path))rejected();let handle,created;
  try{
    check(signal);handle=await fs.open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    created=await handle.stat();if(!file(created)||created.uid!==process.getuid()||created.nlink!==1)rejected();
    await handle.writeFile(bytes);
  }catch(error){if(error instanceof ReviewPackageError)throw error;rejected();}
  finally{if(handle)try{await handle.close();}catch{rejected();}}
  check(signal);try{await fs.chmod(path,0o400);}catch{rejected();}
  const after=await stat(fs,path);
  if(!file(after)||after.uid!==process.getuid()||after.nlink!==1||after.dev!==created.dev||
     after.ino!==created.ino||after.size!==bytes.length||(after.mode&0o7777)!==0o400)rejected();
}
async function readFile(fs,path,max,signal){
  await ancestors(fs,path);const before=await stat(fs,path);
  if(!file(before)||before.uid!==process.getuid()||before.nlink!==1||
     (before.mode&0o7777)!==0o400||!Number.isSafeInteger(before.size)||before.size>max)rejected();
  let handle,result;
  try{
    check(signal);handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const opened=await handle.stat();if(!stable(before,opened)||!file(opened))rejected();
    const bytes=Buffer.alloc(before.size+1);let offset=0;
    while(offset<bytes.length){check(signal);const count=Math.min(65536,bytes.length-offset);
      const read=await handle.read(bytes,offset,count,offset);
      if(!Number.isSafeInteger(read.bytesRead)||read.bytesRead<0||read.bytesRead>count)rejected();
      if(read.bytesRead===0)break;offset+=read.bytesRead;if(offset>max)rejected();}
    const after=await handle.stat(),leaf=await stat(fs,path);
    if(offset!==before.size||!stable(opened,after)||!stable(opened,leaf)||!file(leaf)||
       leaf.uid!==process.getuid()||leaf.nlink!==1||(leaf.mode&0o7777)!==0o400)rejected();
    result=bytes.subarray(0,offset);
  }catch(error){if(error instanceof ReviewPackageError)throw error;rejected();}
  finally{if(handle)try{await handle.close();}catch{rejected();}}
  return result;
}
function asText(bytes){
  try{
    const text=decoder.decode(bytes);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)?null:text;
  }catch{return null;}
}
function diffLines(prefix,text,remaining){
  let output='',length=0,start=0;
  while(start<text.length){
    const newline=text.indexOf('\n',start),end=newline<0?text.length:newline+1;
    const line=`${prefix} ${JSON.stringify(text.slice(start,end))}\n`;
    length+=Buffer.byteLength(line,'utf8');if(length>remaining)rejected();
    output+=line;start=end;
  }
  return output;
}
function makeDiff(files){
  const chunks=[Buffer.from('SQUIRE_FULL_CHANGED_CONTENT_V1\n','utf8')];let length=chunks[0].length;
  const add=value=>{const bytes=Buffer.from(value,'utf8');length+=bytes.length;if(length>MAX_DIFF)rejected();chunks.push(bytes);};
  for(const item of files){
    const oldText=item.old?asText(item.old.data):'';
    const newText=asText(item.new.data);
    add(`path ${JSON.stringify(item.path)}\nold ${item.old?.git_sha1??'ABSENT'}\nnew ${item.new.git_sha1}\n`);
    if(oldText===null||newText===null){add('BINARY_REVIEW_REQUIRED; inspect exact .old/.new copies\n');continue;}
    // Whole-file minus/plus lines show every changed side. JSON quoting keeps
    // control characters and final-newline state unambiguous and reversible.
    add(diffLines('-',oldText,MAX_DIFF-length));
    add(diffLines('+',newText,MAX_DIFF-length));
  }
  return Buffer.concat(chunks,length);
}
function side(item){return item&&{mode:item.mode,git_sha1:item.git_sha1,bytes:item.bytes,sha256:item.sha256};}
function makeManifest(source,diff){
  const identity=source.identity??source.result;
  const paths=source.files.map(item=>({path:item.path,old:side(item.old),new:side(item.new),
    binary_review_required:item.old?asText(item.old.data)===null||asText(item.new.data)===null:asText(item.new.data)===null}));
  return {schema:PACKAGE_SCHEMA,input_result_sha256:source.input_result_sha256,
    candidate_ref:identity.candidate_ref,base_commit:identity.base_commit,
    base_tree:identity.base_tree,candidate_commit:identity.candidate_commit,
    candidate_tree:identity.candidate_tree,changed_paths:source.files.map(item=>item.path),
    paths,diff:{bytes:diff.length,sha256:digest(diff)},
    boundaries:['SOURCE_REVIEW_PENDING','TASK_CORRECTNESS_NOT_EVALUATED','ORIGIN_SUPPLIED_NOT_AUTHENTICATED']};
}
function preparePackage(source){
  const sides=[];
  for(const item of source.files){
    if(item.old)sides.push({path:`changes/${item.path}.old`,data:item.old.data});
    sides.push({path:`changes/${item.path}.new`,data:item.new.data});
  }
  const leaves=new Set(sides.map(side=>side.path));
  if(leaves.size!==sides.length)rejected();
  for(const leaf of leaves){
    for(let slash=leaf.indexOf('/');slash!==-1;slash=leaf.indexOf('/',slash+1)){
      if(leaves.has(leaf.slice(0,slash)))rejected();
    }
  }
  const diff=makeDiff(source.files),manifest=makeManifest(source,diff),manifestBytes=encode(manifest);
  const copied=source.files.reduce((sum,item)=>sum+(item.old?.bytes??0)+item.new.bytes,0);
  if(copied>MAX_COPIES||manifestBytes.length>MAX_MANIFEST||copied+diff.length+manifestBytes.length>MAX_PACKAGE)rejected();
  return {diff,manifest,manifestBytes,sides};
}
async function writePackage(fs,outputDir,prepared,signal){
  await reserve(fs,outputDir,signal);await ensureDir(fs,outputDir,'changes',signal);
  for(const side of prepared.sides){check(signal);
    await writeFile(fs,outputDir,side.path,side.data,signal);
  }
  await writeFile(fs,outputDir,'diff.txt',prepared.diff,signal);
  await writeFile(fs,outputDir,'review-manifest.json',prepared.manifestBytes,signal);
}
async function listPackage(fs,root,signal){
  const found=[];const walk=async relative=>{
    const path=relative?join(root,...relative.split('/')):root;let handle;
    try{handle=await fs.opendir(path,{bufferSize:1});
      while(true){check(signal);const entry=await handle.read();if(entry===null)break;
        if(!entry.name||entry.name.includes('/')||entry.name==='.'||entry.name==='..'||found.length>=MAX_OUTPUT_ENTRIES)rejected();
        const child=relative?`${relative}/${entry.name}`:entry.name,s=await stat(fs,join(root,...child.split('/')));
        if(dir(s)){if(s.uid!==process.getuid()||(s.mode&0o7777)!==0o700)rejected();found.push(`${child}/`);await walk(child);}
        else if(file(s)){if(s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o7777)!==0o400)rejected();found.push(child);}
        else rejected();
      }}catch(error){if(error instanceof ReviewPackageError)throw error;rejected();}
    finally{if(handle)try{await handle.close();}catch{rejected();}}
  };await walk('');return found.sort();
}
async function verifyInternal(fs,root,signal,expectedManifestSha256){
  if(!absolute(root))invalid();await ancestors(fs,root);
  const rootStat=await stat(fs,root);if(!dir(rootStat)||rootStat.uid!==process.getuid()||(rootStat.mode&0o7777)!==0o700||
     await fs.realpath(root)!==root)rejected();
  const manifestBytes=await readFile(fs,join(root,'review-manifest.json'),MAX_MANIFEST,signal);
  const checkedDigest=expectedManifestSha256===undefined?undefined:digest(manifestBytes);
  if(checkedDigest!==expectedManifestSha256)rejected();
  let manifest;try{manifest=JSON.parse(decoder.decode(manifestBytes));}catch{rejected();}
  if(!matchesKeys(manifest,['schema','input_result_sha256','candidate_ref','base_commit','base_tree','candidate_commit',
       'candidate_tree','changed_paths','paths','diff','boundaries'])||
     manifest.schema!==PACKAGE_SCHEMA||!SHA256.test(manifest.input_result_sha256)||
     !SHA1.test(manifest.base_commit)||!SHA1.test(manifest.base_tree)||
     !SHA1.test(manifest.candidate_commit)||!SHA1.test(manifest.candidate_tree)||
     !/^refs\/heads\/candidate-[A-Za-z0-9_-]{1,64}$/.test(manifest.candidate_ref)||
     !Array.isArray(manifest.changed_paths)||!Array.isArray(manifest.paths)||
     manifest.paths.length<1||manifest.paths.length>50||manifest.paths.length!==manifest.changed_paths.length||
     !Array.isArray(manifest.boundaries)||manifest.boundaries.length!==3||
     manifest.boundaries[0]!=='SOURCE_REVIEW_PENDING'||
     manifest.boundaries[1]!=='TASK_CORRECTNESS_NOT_EVALUATED'||
     manifest.boundaries[2]!=='ORIGIN_SUPPLIED_NOT_AUTHENTICATED'||
     !Buffer.from(encode(manifest)).equals(manifestBytes))rejected();
  const expected=['review-manifest.json','diff.txt'];let copyTotal=0;const copies=[];
  const folded=new Map();
  for(let i=0;i<manifest.paths.length;i++){
    const entry=manifest.paths[i];
    if(!matchesKeys(entry,['binary_review_required','new','old','path'])||
       typeof entry.path!=='string'||entry.path!==manifest.changed_paths[i]||
       (i>0&&manifest.changed_paths[i-1]>=entry.path)||
       entry.path.length>256||!/^[A-Za-z0-9._/-]+$/.test(entry.path)||
       entry.path.split('/').length>7||entry.path.split('/').some(part=>!part||part==='.'||part==='..'||
         part.length>64||part.toLowerCase()==='.git')||
       !plain(entry.new)||!['100644'].includes(entry.new.mode)||
       (entry.old!==null&&(!plain(entry.old)||!['100644','100755'].includes(entry.old.mode)))||
       typeof entry.binary_review_required!=='boolean')rejected();
    const lowered=entry.path.toLowerCase();
    if(folded.has(lowered))rejected();
    for(const prefix of lowered.split('/').slice(0,-1).map((_,index)=>lowered.split('/').slice(0,index+1).join('/'))){
      if(folded.has(prefix))rejected();
    }
    for(const prior of folded.keys())if(prior.startsWith(`${lowered}/`))rejected();
    folded.set(lowered,true);
    const data={path:entry.path,old:null,new:null};
    for(const [name,side] of [['old',entry.old],['new',entry.new]])if(side){
      if(!matchesKeys(side,['bytes','git_sha1','mode','sha256']))rejected();
      if(!SHA1.test(side.git_sha1)||!SHA256.test(side.sha256)||!Number.isSafeInteger(side.bytes)||
         side.bytes<0||side.bytes>MAX_SIDE)rejected();
      const relative=`changes/${entry.path}.${name}`;expected.push(relative);
      const bytes=await readFile(fs,join(root,...relative.split('/')),MAX_SIDE,signal);
      if(bytes.length!==side.bytes||digest(bytes)!==side.sha256||
         createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex')!==side.git_sha1)rejected();
      data[name]={...side,data:bytes};
      copyTotal+=bytes.length;
    }
    if(entry.binary_review_required!==
       (data.old?asText(data.old.data)===null||asText(data.new.data)===null:asText(data.new.data)===null))rejected();
    copies.push(data);
  }
  if(copyTotal>MAX_COPIES)rejected();
  const diff=await readFile(fs,join(root,'diff.txt'),MAX_DIFF,signal);
  if(!matchesKeys(manifest.diff,['bytes','sha256'])||
     manifest.diff.bytes!==diff.length||digest(diff)!==manifest.diff.sha256||
     !makeDiff(copies).equals(diff))rejected();
  const directories=new Set(['changes/']);for(const relative of expected.filter(path=>path.startsWith('changes/'))){
    const parts=relative.split('/');for(let i=1;i<parts.length-1;i++)directories.add(parts.slice(0,i+1).join('/')+'/');
  }
  const observed=await listPackage(fs,root,signal);
  if(observed.join('|')!==[...expected,...directories].sort().join('|'))rejected();
  if(copyTotal+diff.length+manifestBytes.length>MAX_PACKAGE)rejected();
  return Object.freeze({manifest,manifest_sha256:checkedDigest??digest(manifestBytes),changed_path_count:manifest.paths.length,
    package_bytes:copyTotal+diff.length+manifestBytes.length});
}
export async function verifyProjectCandidateReviewPackage(reviewPackageDir,ports={},expectedManifestSha256){
  try{
    if(expectedManifestSha256!==undefined&&(typeof expectedManifestSha256!=='string'||
       expectedManifestSha256.length!==64||!SHA256.test(expectedManifestSha256)))invalid();
    const verified=await verifyInternal(capturePort(ports),reviewPackageDir,undefined,expectedManifestSha256);
    return Object.freeze({status:'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED',
      manifest_sha256:verified.manifest_sha256,
      base_commit:verified.manifest.base_commit,base_tree:verified.manifest.base_tree,
      candidate_commit:verified.manifest.candidate_commit,candidate_tree:verified.manifest.candidate_tree,
      changed_path_count:verified.changed_path_count,package_bytes:verified.package_bytes});
  }
  catch(error){if(error instanceof ReviewPackageError)throw error;rejected();}
}
export async function buildProjectCandidateReviewPackage(spec,ports={}){
  let signal;
  try{
    const fs=capturePort(ports);closed(spec,['schema','result','candidate_git_dir','candidate_git_identity',
      'base_git_dir','base_git_identity','output_dir'],['signal']);
    signal=captureSignal(spec.signal);check(signal);
    const source=await readProjectCandidateReviewSource(spec,{fs});
    const prepared=preparePackage(source),{manifest,manifestBytes}=prepared;
    await writePackage(fs,spec.output_dir,prepared,signal);
    const reread=await readProjectCandidateReviewSource(spec,{fs});
    if(digest(encode(makeManifest(reread,makeDiff(reread.files))))!==digest(manifestBytes))rejected();
    const verified=await verifyInternal(fs,spec.output_dir,signal);check(signal);
    return Object.freeze({status:'PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED',
      manifest_sha256:verified.manifest_sha256,input_result_sha256:source.input_result_sha256,
      base_commit:manifest.base_commit,base_tree:manifest.base_tree,
      candidate_commit:manifest.candidate_commit,candidate_tree:manifest.candidate_tree,
      changed_path_count:verified.changed_path_count,package_bytes:verified.package_bytes});
  }catch(error){
    if(error instanceof ReviewPackageError)throw error;
    if(signal?.aborted)aborted();
    if(error?.code==='PROJECT_PORTABLE_SNAPSHOT_ABORTED')aborted();
    if(error?.code==='INVALID_PROJECT_PORTABLE_SNAPSHOT_SPEC')invalid();
    rejected();
  }
}
const SNAPSHOT_PROVENANCE_BOUNDARIES=Object.freeze([
  'RETAINED_SNAPSHOT_SOURCE_ONLY','LIVE_GIT_CUSTODY_NOT_ESTABLISHED','ORIGINAL_RESULT_BODY_NOT_VALIDATED',
  'ORIGINAL_ACKNOWLEDGEMENT_NOT_RECOVERED','ORIGIN_NOT_AUTHENTICATED',
  'NO_DECISION_EXECUTION_MERGE_DISCLOSURE_OR_RETRY_AUTHORITY'
]);
async function handoffClosure(fs,root,signal){
  let handle;const names=[];
  try{
    handle=await fs.opendir(root,{bufferSize:1});
    while(true){check(signal);const entry=await handle.read();if(entry===null)break;
      if(typeof entry.name!=='string'||!['package','provenance.json'].includes(entry.name)||names.includes(entry.name)||names.length>=2)rejected();
      names.push(entry.name);
    }
    if(names.sort().join('|')!=='package|provenance.json')rejected();
  }catch(error){if(error instanceof ReviewPackageError)throw error;rejected();}
  finally{if(handle)try{await handle.close();}catch{rejected();}}
}
function parseSnapshotProvenance(bytes){
  try{
    const receipt=JSON.parse(decoder.decode(bytes));
    closed(receipt,['schema','source_snapshot_manifest_sha256','review_package_manifest_sha256','input_result_sha256',
      'base_commit','base_tree','candidate_commit','candidate_tree','changed_path_count','package_bytes','boundaries']);
    if(receipt.schema!=='SQUIRE_SNAPSHOT_REVIEW_PROVENANCE_V1'||
       ['source_snapshot_manifest_sha256','review_package_manifest_sha256','input_result_sha256'].some(key=>
         typeof receipt[key]!=='string'||receipt[key].length!==64||!SHA256.test(receipt[key]))||
       ['base_commit','base_tree','candidate_commit','candidate_tree'].some(key=>
         typeof receipt[key]!=='string'||receipt[key].length!==40||!SHA1.test(receipt[key]))||
       !Number.isSafeInteger(receipt.changed_path_count)||receipt.changed_path_count<1||receipt.changed_path_count>50||
       !Number.isSafeInteger(receipt.package_bytes)||receipt.package_bytes<1||receipt.package_bytes>MAX_PACKAGE||
       !Array.isArray(receipt.boundaries)||receipt.boundaries.length!==SNAPSHOT_PROVENANCE_BOUNDARIES.length||
       receipt.boundaries.some((value,index)=>value!==SNAPSHOT_PROVENANCE_BOUNDARIES[index])||!encode(receipt).equals(bytes))rejected();
    return Object.freeze({...receipt,boundaries:SNAPSHOT_PROVENANCE_BOUNDARIES});
  }catch{rejected();}
}
async function verifySnapshotHandoffInternal(fs,root,expected,signal){
  await ancestors(fs,root);const before=await stat(fs,root);
  if(!dir(before)||before.uid!==process.getuid()||(before.mode&0o7777)!==0o700||await fs.realpath(root)!==root)rejected();
  await handoffClosure(fs,root,signal);const receiptPath=join(root,'provenance.json'),leafBefore=await stat(fs,receiptPath);
  const bytes=await readFile(fs,receiptPath,16*1024,signal);if(digest(bytes)!==expected)rejected();
  const receipt=parseSnapshotProvenance(bytes),packageDir=join(root,'package'),packageBefore=await stat(fs,packageDir);
  const verified=await verifyInternal(fs,packageDir,signal);
  if(verified.manifest_sha256!==receipt.review_package_manifest_sha256||
     verified.manifest.input_result_sha256!==receipt.input_result_sha256||
     ['base_commit','base_tree','candidate_commit','candidate_tree'].some(key=>verified.manifest[key]!==receipt[key])||
     verified.changed_path_count!==receipt.changed_path_count||verified.package_bytes!==receipt.package_bytes||
     !(await readFile(fs,receiptPath,16*1024,signal)).equals(bytes))rejected();
  await handoffClosure(fs,root,signal);const after=await stat(fs,root),leafAfter=await stat(fs,receiptPath),packageAfter=await stat(fs,packageDir);check(signal);
  if(!dir(after)||!stable(before,after)||after.uid!==process.getuid()||(after.mode&0o7777)!==0o700||
     await fs.realpath(root)!==root||!stable(leafBefore,leafAfter)||!file(leafAfter)||leafAfter.uid!==process.getuid()||
     leafAfter.nlink!==1||(leafAfter.mode&0o7777)!==0o400||!dir(packageAfter)||!stable(packageBefore,packageAfter)||
     packageAfter.uid!==process.getuid()||(packageAfter.mode&0o7777)!==0o700||await fs.realpath(packageDir)!==packageDir)rejected();
  return {receipt,verified,rootStat:after,provenance_sha256:expected};
}
function snapshotHandoffResult(status,inspection){
  const r=inspection.receipt;
  return Object.freeze({status,source_snapshot_manifest_sha256:r.source_snapshot_manifest_sha256,
    manifest_sha256:inspection.verified.manifest_sha256,provenance_sha256:inspection.provenance_sha256,
    input_result_sha256:r.input_result_sha256,base_commit:r.base_commit,base_tree:r.base_tree,
    candidate_commit:r.candidate_commit,candidate_tree:r.candidate_tree,
    changed_path_count:inspection.verified.changed_path_count,package_bytes:inspection.verified.package_bytes});
}
/** Verify one caller-selected copied handoff. No snapshot/store/build/decision or source authenticity claim. */
export async function verifyProjectCandidateReviewSnapshotHandoff(handoffDir,expectedProvenanceSha256,ports={}){
  try{
    if(!absolute(handoffDir)||typeof expectedProvenanceSha256!=='string'||expectedProvenanceSha256.length!==64||
       !SHA256.test(expectedProvenanceSha256))invalid();
    const inspected=await verifySnapshotHandoffInternal(capturePort(ports),handoffDir,expectedProvenanceSha256,undefined);
    return snapshotHandoffResult('PROJECT_CANDIDATE_REVIEW_SNAPSHOT_HANDOFF_VERIFIED',inspected);
  }catch(error){if(error instanceof ReviewPackageError)throw error;rejected();}
}
function clearSource(source){for(const file of source?.files??[])for(const side of [file.old,file.new])side?.data.fill(0);}
/** Build an unchanged V1 review package and byte-bound receipt from one retained original-format snapshot. */
export async function buildProjectCandidateReviewPackageFromSnapshot(spec,ports={}){
  let signal,source,reread,prepared;
  try{
    const fs=capturePort(ports);closed(spec,['schema','snapshot_dir','expected_manifest_sha256','output_dir'],['signal']);
    const request=Object.freeze({schema:spec.schema,snapshot_dir:spec.snapshot_dir,
      expected_manifest_sha256:spec.expected_manifest_sha256,output_dir:spec.output_dir,signal:captureSignal(spec.signal)});
    signal=request.signal;check(signal);
    if(request.schema!=='SQUIRE_PROJECT_CANDIDATE_REVIEW_FROM_SNAPSHOT_SPEC_V1'||!absolute(request.snapshot_dir)||
       !absolute(request.output_dir)||request.snapshot_dir===request.output_dir||
       request.snapshot_dir.startsWith(request.output_dir+'/')||request.output_dir.startsWith(request.snapshot_dir+'/')||
       typeof request.expected_manifest_sha256!=='string'||request.expected_manifest_sha256.length!==64||!SHA256.test(request.expected_manifest_sha256))invalid();
    source=await readProjectCandidateReviewSnapshotSource(request,{fs});prepared=preparePackage(source);
    const expectedPackageSha256=digest(prepared.manifestBytes);
    const container=await reserve(fs,request.output_dir,signal),packageDir=join(request.output_dir,'package');
    await writePackage(fs,packageDir,prepared,signal);
    const initialPackage=await verifyInternal(fs,packageDir,signal);
    if(initialPackage.manifest_sha256!==expectedPackageSha256)rejected();
    const receipt={schema:'SQUIRE_SNAPSHOT_REVIEW_PROVENANCE_V1',
      source_snapshot_manifest_sha256:source.source_snapshot_manifest_sha256,
      review_package_manifest_sha256:initialPackage.manifest_sha256,input_result_sha256:source.input_result_sha256,
      base_commit:prepared.manifest.base_commit,base_tree:prepared.manifest.base_tree,
      candidate_commit:prepared.manifest.candidate_commit,candidate_tree:prepared.manifest.candidate_tree,
      changed_path_count:initialPackage.changed_path_count,package_bytes:initialPackage.package_bytes,
      boundaries:SNAPSHOT_PROVENANCE_BOUNDARIES};
    const receiptBytes=encode(receipt);if(receiptBytes.length>16*1024)rejected();
    await writeFile(fs,request.output_dir,'provenance.json',receiptBytes,signal);
    reread=await readProjectCandidateReviewSnapshotSource(request,{fs});
    if(!stable(source.root_identity,reread.root_identity)||source.root_identity.uid!==reread.root_identity.uid||
       source.root_identity.mode!==reread.root_identity.mode||
       source.source_snapshot_manifest_sha256!==reread.source_snapshot_manifest_sha256||
       digest(encode(makeManifest(reread,makeDiff(reread.files))))!==expectedPackageSha256)rejected();
    const inspected=await verifySnapshotHandoffInternal(fs,request.output_dir,digest(receiptBytes),signal);
    if(inspected.rootStat.dev!==container.dev||inspected.rootStat.ino!==container.ino||
       inspected.verified.manifest_sha256!==expectedPackageSha256)rejected();
    return snapshotHandoffResult('PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED_FROM_SNAPSHOT',inspected);
  }catch(error){
    if(error instanceof ReviewPackageError)throw error;
    if(signal?.aborted||error?.code==='PROJECT_PORTABLE_SNAPSHOT_ABORTED')aborted();
    if(error?.code==='INVALID_PROJECT_PORTABLE_SNAPSHOT_SPEC')invalid();rejected();
  }finally{clearSource(source);clearSource(reread);prepared?.diff.fill(0);prepared?.manifestBytes.fill(0);}
}

function captureDecision(value){
  closed(value,['schema','decision_id','reviewer_label','review_package_sha256','base_commit','base_tree',
    'candidate_commit','candidate_tree','choice','attestations'],['note']);
  if(value.schema!==DECISION_SCHEMA||!TOKEN.test(value.decision_id)||!TOKEN.test(value.reviewer_label)||
     !SHA256.test(value.review_package_sha256)||
     ['base_commit','base_tree','candidate_commit','candidate_tree'].some(key=>!SHA1.test(value[key]))||
     !['ACCEPT','REVISE','REJECT'].includes(value.choice)||!Array.isArray(value.attestations)||
     value.attestations.length>50||
     (value.note!==undefined&&(typeof value.note!=='string'||Buffer.byteLength(value.note,'utf8')>4096)))invalid();
  const attestations=[];
  for(const item of value.attestations){
    closed(item,['path','old_sha256','new_sha256','binary_inspected']);
    if(typeof item.path!=='string'||(item.old_sha256!==null&&!SHA256.test(item.old_sha256))||
       !SHA256.test(item.new_sha256)||typeof item.binary_inspected!=='boolean')invalid();
    attestations.push({...item});
  }
  for(let i=1;i<attestations.length;i++)if(attestations[i-1].path>=attestations[i].path)invalid();
  return {schema:DECISION_SCHEMA,decision_id:value.decision_id,reviewer_label:value.reviewer_label,
    review_package_sha256:value.review_package_sha256,base_commit:value.base_commit,base_tree:value.base_tree,
    candidate_commit:value.candidate_commit,candidate_tree:value.candidate_tree,choice:value.choice,
    attestations,note:value.note??null,
    boundaries:['REVIEWER_LABEL_NOT_AUTHENTICATED','SOURCE_DECISION_ONLY','NO_EXECUTION_OR_MERGE_AUTHORITY']};
}
function decisionBindingIssue(captured,verified){
  const manifest=verified.manifest;
  if(captured.review_package_sha256!==verified.manifest_sha256||
     ['base_commit','base_tree','candidate_commit','candidate_tree'].some(key=>captured[key]!==manifest[key]))return 'PACKAGE_BINDING_MISMATCH';
  const byPath=new Map(manifest.paths.map(item=>[item.path,item]));
  for(const item of captured.attestations){
    const path=byPath.get(item.path);
    if(!path||item.old_sha256!==(path.old?.sha256??null)||item.new_sha256!==path.new.sha256)return 'PACKAGE_BINDING_MISMATCH';
    if(captured.choice==='ACCEPT'&&path.binary_review_required&&!item.binary_inspected)return 'BINARY_ACKNOWLEDGEMENT_REQUIRED';
  }
  if(captured.choice==='ACCEPT'&&captured.attestations.length!==manifest.paths.length)return 'ATTESTATION_REQUIRED';
  return null;
}

export async function recordProjectCandidateDecision(reviewPackageDir,decision,freshDecisionDir,ports={}){
  let issue;
  try{
    const fs=capturePort(ports);
    issue='MALFORMED_REQUEST';
    const captured=captureDecision(decision);
    issue=null;
    if(!absolute(reviewPackageDir)||!absolute(freshDecisionDir)||
       reviewPackageDir===freshDecisionDir||freshDecisionDir.startsWith(reviewPackageDir+'/')||
       reviewPackageDir.startsWith(freshDecisionDir+'/'))invalid();
    const verified=await verifyInternal(fs,reviewPackageDir,undefined),manifest=verified.manifest;
    issue=decisionBindingIssue(captured,verified);
    if(issue)rejected();
    const bytes=encode(captured);if(bytes.length>MAX_REVIEW_DECISION_BYTES){issue='MALFORMED_REQUEST';invalid();}
    await reserve(fs,freshDecisionDir,undefined);
    await writeFile(fs,freshDecisionDir,'decision.json',bytes,undefined);
    const readback=await readFile(fs,join(freshDecisionDir,'decision.json'),bytes.length,undefined);
    if(!bytes.equals(readback))rejected();
    const reverified=await verifyInternal(fs,reviewPackageDir,undefined);
    if(reverified.manifest_sha256!==verified.manifest_sha256)rejected();
    return Object.freeze({status:'PROJECT_CANDIDATE_DECISION_RECORDED',choice:captured.choice,
      review_package_sha256:verified.manifest_sha256,decision_sha256:digest(bytes),
      base_commit:captured.base_commit,base_tree:captured.base_tree,
      candidate_commit:captured.candidate_commit,candidate_tree:captured.candidate_tree,
      changed_path_count:manifest.paths.length,attested_path_count:captured.attestations.length});
  }catch(error){
    const failure=error instanceof ReviewPackageError?error:new ReviewPackageError('PROJECT_CANDIDATE_REVIEW_REJECTED');
    throw recordFailure(failure,issue);
  }
}

/** Verify one explicitly selected stored original decision; no writes or choice selection. */
export async function verifyProjectCandidateDecision(reviewPackageDir,decisionDir,expectedSha256,ports={}){
  try{
    const fs=capturePort(ports);
    if(!absolute(reviewPackageDir)||!absolute(decisionDir)||typeof expectedSha256!=='string'||!SHA256.test(expectedSha256)||
       reviewPackageDir===decisionDir||reviewPackageDir.startsWith(decisionDir+'/')||decisionDir.startsWith(reviewPackageDir+'/'))invalid();
    const verified=await verifyInternal(fs,reviewPackageDir,undefined);
    await ancestors(fs,decisionDir);const before=await stat(fs,decisionDir);
    if(!dir(before)||before.uid!==process.getuid()||(before.mode&0o7777)!==0o700||await fs.realpath(decisionDir)!==decisionDir||
       (await listPackage(fs,decisionDir,undefined)).join('|')!=='decision.json')rejected();
    const decisionPath=join(decisionDir,'decision.json'),leafBefore=await stat(fs,decisionPath);
    const bytes=await readFile(fs,decisionPath,MAX_REVIEW_DECISION_BYTES,undefined);
    if(digest(bytes)!==expectedSha256)rejected();let captured;
    try{
      const raw=JSON.parse(decoder.decode(bytes));
      closed(raw,['schema','decision_id','reviewer_label','review_package_sha256','base_commit','base_tree',
        'candidate_commit','candidate_tree','choice','attestations','note','boundaries']);
      const boundaries=['REVIEWER_LABEL_NOT_AUTHENTICATED','SOURCE_DECISION_ONLY','NO_EXECUTION_OR_MERGE_AUTHORITY'];
      if(!Array.isArray(raw.boundaries)||raw.boundaries.length!==boundaries.length||raw.boundaries.some((v,i)=>v!==boundaries[i]))rejected();
      // The writer rejects explicit null input but canonically stores an omitted note as null.
      const {boundaries:storedBoundaries,note,...request}=raw;
      captured=captureDecision(note===null?request:{...request,note});
      if(!encode(captured).equals(bytes))rejected();
    }catch{rejected();}
    if(decisionBindingIssue(captured,verified))rejected();
    const again=await verifyInternal(fs,reviewPackageDir,undefined),after=await stat(fs,decisionDir),leafAfter=await stat(fs,decisionPath);
    if(again.manifest_sha256!==verified.manifest_sha256||!file(leafAfter)||!stable(leafBefore,leafAfter)||leafAfter.uid!==process.getuid()||
       leafAfter.nlink!==1||(leafAfter.mode&0o7777)!==0o400||!dir(after)||!stable(before,after)||after.uid!==process.getuid()||
       (after.mode&0o7777)!==0o700||await fs.realpath(decisionDir)!==decisionDir||
       (await listPackage(fs,decisionDir,undefined)).join('|')!=='decision.json')rejected();
    return Object.freeze({status:'PROJECT_CANDIDATE_DECISION_VERIFIED',review_package_sha256:verified.manifest_sha256,
      decision_sha256:expectedSha256,attested_path_count:captured.attestations.length});
  }catch(error){if(error instanceof ReviewPackageError)throw error;rejected();}
}
