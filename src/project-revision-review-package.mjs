// Private, bounded two-view review and fresh decision for one first PR211 revision.
// This module never executes candidate bytes or selects a decision implicitly.
import * as nativeFs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,parse,resolve} from 'node:path';
import {types} from 'node:util';
import {readProjectRevisionReviewSource} from './project-portable-candidate-snapshot.mjs';
import {verifyProjectCandidateReviewPackage} from './project-candidate-review-package.mjs';

const PACKAGE_SCHEMA='SQUIRE_PROJECT_REVISION_REVIEW_PACKAGE_V1';
const DECISION_SCHEMA='SQUIRE_PROJECT_REVISION_DECISION_V1';
const SHA1=/^[a-f0-9]{40}$/;const SHA256=/^[a-f0-9]{64}$/;
const TOKEN=/^[A-Za-z0-9_-]{1,64}$/;
const MAX_SIDE=4*1024*1024,MAX_COPIES=12*1024*1024,MAX_DIFF=8*1024*1024;
const MAX_MANIFEST=512*1024,MAX_PACKAGE=29*1024*1024;
const MAX_OUTPUT_ENTRIES=50*7+3*50+3;
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
class ReviewPackageError extends Error{
  constructor(code){super(code);this.name='ProjectRevisionReviewError';this.code=code;delete this.stack;}
}
const invalid=()=>{throw new ReviewPackageError('INVALID_PROJECT_REVISION_REVIEW_SPEC');};
const rejected=()=>{throw new ReviewPackageError('PROJECT_REVISION_REVIEW_REJECTED');};
const aborted=()=>{throw new ReviewPackageError('PROJECT_REVISION_REVIEW_ABORTED');};
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
function closed(value,keys,optional=[]){
  if(!plain(value)||Reflect.ownKeys(value).some(key=>typeof key!=='string'||![...keys,...optional].includes(key))||
     keys.some(key=>!Object.hasOwn(value,key)))invalid();
  for(const key of Reflect.ownKeys(value))if(!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))invalid();
}
function denseArray(value,max,min=0){
  if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||
    value.length<min||value.length>max||Reflect.ownKeys(value).length!==value.length+1)invalid();
  const output=[];for(let i=0;i<value.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
    if(!descriptor||!Object.hasOwn(descriptor,'value'))invalid();output.push(descriptor.value);
  }return output;
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
function asText(bytes){try{const text=decoder.decode(bytes);return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)?null:text;}catch{return null;}}
function diffLines(prefix,text,remaining){let output='',length=0,start=0;while(start<text.length){const newline=text.indexOf('\n',start),end=newline<0?text.length:newline+1;const line=`${prefix} ${JSON.stringify(text.slice(start,end))}\n`;length+=Buffer.byteLength(line);if(length>remaining)rejected();output+=line;start=end;}return output;}
function makeDiff(rows,oldKey){const chunks=[Buffer.from(`SQUIRE_FULL_${oldKey.toUpperCase()}_TO_REVISED_V1\n`)];let length=chunks[0].length;
  const add=value=>{const bytes=Buffer.from(value);length+=bytes.length;if(length>MAX_DIFF)rejected();chunks.push(bytes);};
  for(const item of rows){const old=item.old,next=item.new,oldText=old?asText(old.data):'',newText=asText(next.data);
    add(`path ${JSON.stringify(item.path)}\nold ${old?.git_sha1??'ABSENT'}\nnew ${next.git_sha1}\n`);
    if(oldText===null||newText===null){add('BINARY_REVIEW_REQUIRED; inspect exact side copies\n');continue;}
    add(diffLines('-',oldText,MAX_DIFF-length));add(diffLines('+',newText,MAX_DIFF-length));
  }return Buffer.concat(chunks,length);
}
const side=item=>item&&{mode:item.mode,git_sha1:item.git_sha1,bytes:item.bytes,sha256:item.sha256};
function validPath(path){return typeof path==='string'&&path.length<=256&&/^[A-Za-z0-9._/-]+$/.test(path)&&path.split('/').length<=7&&
  path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&part.length<=64&&part.toLowerCase()!=='.git'&&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));}
function rowsFor(files,paths,oldKey){const set=new Set(paths);return files.filter(row=>set.has(row.path)).map(row=>({path:row.path,old:row[oldKey],new:row.revised,
  binary_review_required:(row[oldKey]&&asText(row[oldKey].data)===null)||asText(row.revised.data)===null}));}
function manifestFor(source,links,displays){const views={};for(const [key,oldKey,paths] of [
  ['base_to_revised','base',source.base_to_revised],['original_to_revised','original',source.original_to_revised]]){
  const rows=rowsFor(source.files,paths,oldKey);views[key]=rows.map(row=>({path:row.path,old:side(row.old),new:side(row.new),
    binary_review_required:!!row.binary_review_required,classification:key==='original_to_revised'&&
      !source.base_to_revised.includes(row.path)?'RESTORED_BASE':'CHANGED'}));}
  return {schema:PACKAGE_SCHEMA,original_result_sha256:source.original_result_sha256,
    revised_result_sha256:source.revised_result_sha256,original_package_sha256:links.original_package_sha256,
    prior_revise_decision_sha256:links.prior_revise_decision_sha256,declared_decisions_sha256:links.declared_decisions_sha256,
    base_commit:source.original_result.base_commit,base_tree:source.original_result.base_tree,
    original_commit:source.original_result.candidate_commit,original_tree:source.original_result.candidate_tree,
    revised_commit:source.revised_result.candidate_commit,revised_tree:source.revised_result.candidate_tree,
    paths:source.files.map(row=>({path:row.path,base:side(row.base),original:side(row.original),revised:side(row.revised)})),
    base_to_revised:views.base_to_revised,original_to_revised:views.original_to_revised,
    displays:{base_to_revised:{bytes:displays.base.length,sha256:digest(displays.base)},
      original_to_revised:{bytes:displays.original.length,sha256:digest(displays.original)}},
    limits:{max_side:MAX_SIDE,max_copies:MAX_COPIES,max_display:MAX_DIFF,max_manifest:MAX_MANIFEST,max_package:MAX_PACKAGE,max_paths:50},
    boundaries:['COPY_INTEGRITY_ONLY','SUPPLIED_INVENTORY_ONLY','REVIEWER_LABEL_NOT_AUTHENTICATED','SOURCE_REVIEW_PENDING','TASK_CORRECTNESS_NOT_EVALUATED']};}
function matchesKeys(value,keys){return plain(value)&&Object.keys(value).sort().join('|')===keys.sort().join('|');}
function validateSide(value){return value===null||(matchesKeys(value,['mode','git_sha1','bytes','sha256'])&&
  ['100644','100755'].includes(value.mode)&&SHA1.test(value.git_sha1)&&SHA256.test(value.sha256)&&
  Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=MAX_SIDE);}
async function listPackage(fs,root,signal){const found=[];const walk=async relative=>{const path=relative?join(root,...relative.split('/')):root;let handle;
  try{handle=await fs.opendir(path,{bufferSize:1});while(true){check(signal);const entry=await handle.read();if(entry===null)break;
    if(!entry.name||entry.name.includes('/')||entry.name==='.'||entry.name==='..'||found.length>=MAX_OUTPUT_ENTRIES)rejected();
    const child=relative?`${relative}/${entry.name}`:entry.name,s=await stat(fs,join(root,...child.split('/')));
    if(dir(s)){if(s.uid!==process.getuid()||(s.mode&0o7777)!==0o700)rejected();found.push(`${child}/`);await walk(child);}
    else if(file(s)){if(s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o7777)!==0o400)rejected();found.push(child);}else rejected();}}
    catch(error){if(error instanceof ReviewPackageError)throw error;rejected();}finally{if(handle)try{await handle.close();}catch{rejected();}}};await walk('');return found.sort();}
async function verifyInternal(fs,root,signal){if(!absolute(root))invalid();await ancestors(fs,root);const rootStat=await stat(fs,root);
  if(!dir(rootStat)||rootStat.uid!==process.getuid()||(rootStat.mode&0o7777)!==0o700||await fs.realpath(root)!==root)rejected();
  const manifestBytes=await readFile(fs,join(root,'revision-review-manifest.json'),MAX_MANIFEST,signal);let m;
  try{m=JSON.parse(decoder.decode(manifestBytes));}catch{rejected();}
  if(!matchesKeys(m,['schema','original_result_sha256','revised_result_sha256','original_package_sha256','prior_revise_decision_sha256','declared_decisions_sha256',
      'base_commit','base_tree','original_commit','original_tree','revised_commit','revised_tree','paths','base_to_revised','original_to_revised','displays','limits','boundaries'])||
    m.schema!==PACKAGE_SCHEMA||!Buffer.from(encode(m)).equals(manifestBytes)||
    ['original_result_sha256','revised_result_sha256','original_package_sha256','prior_revise_decision_sha256','declared_decisions_sha256'].some(k=>!SHA256.test(m[k]))||
    ['base_commit','base_tree','original_commit','original_tree','revised_commit','revised_tree'].some(k=>!SHA1.test(m[k]))||
    !Array.isArray(m.paths)||m.paths.length<1||m.paths.length>50||
    !Array.isArray(m.boundaries)||m.boundaries.join('|')!=='COPY_INTEGRITY_ONLY|SUPPLIED_INVENTORY_ONLY|REVIEWER_LABEL_NOT_AUTHENTICATED|SOURCE_REVIEW_PENDING|TASK_CORRECTNESS_NOT_EVALUATED'||
    !matchesKeys(m.limits,['max_side','max_copies','max_display','max_manifest','max_package','max_paths'])||
    Object.entries({max_side:MAX_SIDE,max_copies:MAX_COPIES,max_display:MAX_DIFF,max_manifest:MAX_MANIFEST,max_package:MAX_PACKAGE,max_paths:50}).some(([k,v])=>m.limits[k]!==v))rejected();
  const files=[],expected=['revision-review-manifest.json','base-to-revised.diff.txt','original-to-revised.diff.txt'];let copies=0,prior='',folded=new Set();
  for(const row of m.paths){if(!matchesKeys(row,['path','base','original','revised'])||!validPath(row.path)||row.path<=prior||!validateSide(row.base)||!validateSide(row.original)||!validateSide(row.revised)||!row.revised||(row.revised.mode!=='100644'&&!(row.revised.mode==='100755'&&
      !m.base_to_revised.some(v=>v.path===row.path)&&m.original_to_revised.some(v=>v.path===row.path))))rejected();prior=row.path;
    const lower=row.path.toLowerCase();if(folded.has(lower)||[...folded].some(v=>v.startsWith(lower+'/')||lower.startsWith(v+'/')))rejected();folded.add(lower);
    const result={path:row.path};for(const key of ['base','original','revised']){const side=row[key];if(!side){result[key]=null;continue;}
      const relative=`changes/${row.path}.${key}`;expected.push(relative);const data=await readFile(fs,join(root,...relative.split('/')),MAX_SIDE,signal);
      if(data.length!==side.bytes||digest(data)!==side.sha256||createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex')!==side.git_sha1)rejected();
      copies+=data.length;result[key]={...side,data};}files.push(result);}
  if(copies>MAX_COPIES)rejected();const displays={};let displayBytes=0;
  for(const [view,oldKey,name] of [['base_to_revised','base','base-to-revised.diff.txt'],['original_to_revised','original','original-to-revised.diff.txt']]){
    const rows=m[view];if(!Array.isArray(rows)||rows.length<1||rows.length>50)rejected();
    const expectedRows=rowsFor(files,rows.map(r=>r?.path),oldKey);let last='';
    for(let i=0;i<rows.length;i++){const row=rows[i],e=expectedRows[i];if(!e||!matchesKeys(row,['path','old','new','binary_review_required','classification'])||row.path<=last||row.path!==e.path||
      !encode(row.old).equals(encode(side(e.old)))||!encode(row.new).equals(encode(side(e.new)))||row.binary_review_required!==e.binary_review_required||
      row.classification!==(view==='original_to_revised'&&!m.base_to_revised.some(v=>v.path===row.path)?'RESTORED_BASE':'CHANGED')||
      (row.old&&row.old.mode===row.new.mode&&row.old.git_sha1===row.new.git_sha1))rejected();last=row.path;}
    const bytes=await readFile(fs,join(root,name),MAX_DIFF,signal);if(!matchesKeys(m.displays?.[view],['bytes','sha256'])||m.displays[view].bytes!==bytes.length||m.displays[view].sha256!==digest(bytes)||!makeDiff(expectedRows,oldKey).equals(bytes))rejected();displays[view]=bytes;displayBytes+=bytes.length;}
  if(!matchesKeys(m.displays,['base_to_revised','original_to_revised'])||
    !m.paths.every(row=>m.base_to_revised.some(v=>v.path===row.path)||m.original_to_revised.some(v=>v.path===row.path)))rejected();
  const dirs=new Set(['changes/']);for(const path of expected.filter(v=>v.startsWith('changes/'))){const parts=path.split('/');for(let i=1;i<parts.length-1;i++)dirs.add(parts.slice(0,i+1).join('/')+'/');}
  if((await listPackage(fs,root,signal)).join('|')!==[...expected,...dirs].sort().join('|')||copies+displayBytes+manifestBytes.length>MAX_PACKAGE)rejected();
  return {manifest:m,manifest_sha256:digest(manifestBytes),package_bytes:copies+displayBytes+manifestBytes.length};}
async function priorLinks(fs,spec,source,signal){
  const pkg=spec.original_package;closed(pkg,['dir','manifest_sha256']);if(!absolute(pkg.dir)||!SHA256.test(pkg.manifest_sha256))invalid();
  const verified=await verifyProjectCandidateReviewPackage(pkg.dir,{fs});if(verified.manifest_sha256!==pkg.manifest_sha256)rejected();
  const pkgBytes=await readFile(fs,join(pkg.dir,'review-manifest.json'),256*1024,signal);let pm;
  try{pm=JSON.parse(decoder.decode(pkgBytes));}catch{rejected();}
  if(digest(pkgBytes)!==pkg.manifest_sha256||pm.input_result_sha256!==source.original_result_sha256||
    pm.base_commit!==source.original_result.base_commit||pm.base_tree!==source.original_result.base_tree||
    pm.candidate_commit!==source.original_result.candidate_commit||pm.candidate_tree!==source.original_result.candidate_tree)rejected();
  const records=spec.prior_decisions;if(!Array.isArray(records)||records.length<1||records.length>8||!TOKEN.test(spec.selected_decision_id))invalid();
  const set=[],ids=new Set();let selected=null;
  for(const item of records){closed(item,['dir','file_sha256']);if(!absolute(item.dir)||!SHA256.test(item.file_sha256))invalid();
    await ancestors(fs,item.dir);const s=await stat(fs,item.dir);if(!dir(s)||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700||await fs.realpath(item.dir)!==item.dir)rejected();
    if((await listPackage(fs,item.dir,signal)).join('|')!=='decision.json')rejected();
    const bytes=await readFile(fs,join(item.dir,'decision.json'),16384,signal);let d;
    try{d=JSON.parse(decoder.decode(bytes));}catch{rejected();}
    if(digest(bytes)!==item.file_sha256||!Buffer.from(encode(d)).equals(bytes)||
      !matchesKeys(d,['schema','decision_id','reviewer_label','review_package_sha256','base_commit','base_tree','candidate_commit','candidate_tree','choice','attestations','note','boundaries'])||
      d.schema!=='SQUIRE_PROJECT_CANDIDATE_DECISION_V1'||!TOKEN.test(d.decision_id)||!TOKEN.test(d.reviewer_label)||ids.has(d.decision_id)||
      d.review_package_sha256!==pkg.manifest_sha256||d.base_commit!==pm.base_commit||d.base_tree!==pm.base_tree||
      d.candidate_commit!==pm.candidate_commit||d.candidate_tree!==pm.candidate_tree||!['ACCEPT','REVISE','REJECT'].includes(d.choice)||
      !Array.isArray(d.attestations)||d.attestations.length>50||typeof d.note!=='string'&&d.note!==null||
      (d.note!==null&&Buffer.byteLength(d.note)>4096)||
      !Array.isArray(d.boundaries)||d.boundaries.join('|')!=='REVIEWER_LABEL_NOT_AUTHENTICATED|SOURCE_DECISION_ONLY|NO_EXECUTION_OR_MERGE_AUTHORITY')rejected();
    ids.add(d.decision_id);let last='';for(const a of d.attestations){if(!matchesKeys(a,['path','old_sha256','new_sha256','binary_inspected'])||!validPath(a.path)||a.path<=last||
      (a.old_sha256!==null&&!SHA256.test(a.old_sha256))||!SHA256.test(a.new_sha256)||typeof a.binary_inspected!=='boolean')rejected();
      const row=pm.paths.find(v=>v.path===a.path);if(!row||a.old_sha256!==(row.old?.sha256??null)||a.new_sha256!==row.new.sha256||
        (d.choice==='ACCEPT'&&row.binary_review_required&&!a.binary_inspected))rejected();last=a.path;}
    if(d.choice==='ACCEPT'&&d.attestations.length!==pm.paths.length)rejected();
    if(d.choice!=='REVISE')rejected();
    if(d.decision_id===spec.selected_decision_id)selected={...item,decision:d};
    set.push({decision_id:d.decision_id,file_sha256:item.file_sha256});
  }
  if(!selected)rejected();set.sort((a,b)=>a.decision_id<b.decision_id?-1:a.decision_id>b.decision_id?1:0);
  return {original_package_sha256:pkg.manifest_sha256,prior_revise_decision_sha256:selected.file_sha256,
    declared_decisions_sha256:digest(encode(set))};
}
function captureBuildSpec(spec){closed(spec,['schema','original_result','revised_result','base_git_dir','base_git_identity',
  'original_git_dir','original_git_identity','revised_git_dir','revised_git_identity','output_dir','original_package',
  'prior_decisions','selected_decision_id'],['signal']);if(spec.schema!=='SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1')invalid();
  closed(spec.original_package,['dir','manifest_sha256']);
  const records=denseArray(spec.prior_decisions,8,1);for(const record of records)closed(record,['dir','file_sha256']);
  const protectedBase=spec.base_git_dir&&spec.base_git_dir.endsWith('/.git')?dirname(spec.base_git_dir):spec.base_git_dir;
  const paths=[spec.output_dir,spec.original_package?.dir,...records.map(v=>v.dir),protectedBase,spec.original_git_dir,spec.revised_git_dir];
  if(paths.some(path=>!absolute(path)))invalid();
  for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++)if(paths[i]===paths[j]||paths[i].startsWith(paths[j]+'/')||paths[j].startsWith(paths[i]+'/'))invalid();
  return captureSignal(spec.signal);
}
export async function verifyProjectRevisionReviewPackage(dir,ports={}){try{const v=await verifyInternal(capturePort(ports),dir,undefined);return Object.freeze({status:'PROJECT_REVISION_REVIEW_PACKAGE_VERIFIED',
  manifest_sha256:v.manifest_sha256,base_commit:v.manifest.base_commit,original_commit:v.manifest.original_commit,
  revised_commit:v.manifest.revised_commit,base_to_revised_count:v.manifest.base_to_revised.length,
  original_to_revised_count:v.manifest.original_to_revised.length,package_bytes:v.package_bytes});}catch(e){if(e instanceof ReviewPackageError)throw e;rejected();}}
export async function buildProjectRevisionReviewPackage(spec,ports={}){let signal;
  try{const fs=capturePort(ports);signal=captureBuildSpec(spec);check(signal);
    const sourceSpec={schema:spec.schema,original_result:spec.original_result,revised_result:spec.revised_result,
      base_git_dir:spec.base_git_dir,base_git_identity:spec.base_git_identity,
      original_git_dir:spec.original_git_dir,original_git_identity:spec.original_git_identity,
      revised_git_dir:spec.revised_git_dir,revised_git_identity:spec.revised_git_identity,
      output_dir:spec.output_dir,signal};
    const source=await readProjectRevisionReviewSource(sourceSpec,{fs});
    const links=await priorLinks(fs,spec,source,signal);
    const displays={base:makeDiff(rowsFor(source.files,source.base_to_revised,'base'),'base'),
      original:makeDiff(rowsFor(source.files,source.original_to_revised,'original'),'original')};
    const manifest=manifestFor(source,links,displays),bytes=encode(manifest);
    if(bytes.length>MAX_MANIFEST||source.files.reduce((sum,row)=>sum+['base','original','revised'].reduce((n,k)=>n+(row[k]?.bytes??0),0),0)+
      displays.base.length+displays.original.length+bytes.length>MAX_PACKAGE)rejected();
    await reserve(fs,spec.output_dir,signal);await ensureDir(fs,spec.output_dir,'changes',signal);
    for(const row of source.files)for(const key of ['base','original','revised'])if(row[key])await writeFile(fs,spec.output_dir,`changes/${row.path}.${key}`,row[key].data,signal);
    await writeFile(fs,spec.output_dir,'base-to-revised.diff.txt',displays.base,signal);
    await writeFile(fs,spec.output_dir,'original-to-revised.diff.txt',displays.original,signal);
    await writeFile(fs,spec.output_dir,'revision-review-manifest.json',bytes,signal);
    const again=await readProjectRevisionReviewSource(sourceSpec,{fs});
    const againLinks=await priorLinks(fs,spec,again,signal);
    const againDisplays={base:makeDiff(rowsFor(again.files,again.base_to_revised,'base'),'base'),
      original:makeDiff(rowsFor(again.files,again.original_to_revised,'original'),'original')};
    if(!encode(manifestFor(again,againLinks,againDisplays)).equals(bytes))rejected();
    const v=await verifyInternal(fs,spec.output_dir,signal);check(signal);
    return Object.freeze({status:'PROJECT_REVISION_REVIEW_PACKAGE_CREATED',manifest_sha256:v.manifest_sha256,
      base_commit:manifest.base_commit,original_commit:manifest.original_commit,revised_commit:manifest.revised_commit,
      base_to_revised_count:manifest.base_to_revised.length,original_to_revised_count:manifest.original_to_revised.length,
      package_bytes:v.package_bytes});
  }catch(e){if(e instanceof ReviewPackageError)throw e;if(signal?.aborted||e?.code==='PROJECT_PORTABLE_SNAPSHOT_ABORTED')aborted();
    if(e?.code==='INVALID_PROJECT_PORTABLE_SNAPSHOT_SPEC')invalid();rejected();}}
function captureDecision(value){closed(value,['schema','decision_id','reviewer_label','revision_package_sha256',
  'original_package_sha256','prior_revise_decision_sha256','base_commit','base_tree','original_commit','original_tree',
  'revised_commit','revised_tree','choice','attestations'],['note']);
  if(value.schema!==DECISION_SCHEMA||!TOKEN.test(value.decision_id)||!TOKEN.test(value.reviewer_label)||
    ['revision_package_sha256','original_package_sha256','prior_revise_decision_sha256'].some(k=>!SHA256.test(value[k]))||
    ['base_commit','base_tree','original_commit','original_tree','revised_commit','revised_tree'].some(k=>!SHA1.test(value[k]))||
    !['ACCEPT','REVISE','REJECT'].includes(value.choice)||
    (value.note!==undefined&&value.note!==null&&(typeof value.note!=='string'||Buffer.byteLength(value.note)>4096)))invalid();
  const attestations=[];let last='';for(const item of denseArray(value.attestations,100)){closed(item,['view','path','old_sha256','new_sha256','binary_inspected']);
    if(!['base_to_revised','original_to_revised'].includes(item.view)||!validPath(item.path)||
      (item.old_sha256!==null&&!SHA256.test(item.old_sha256))||!SHA256.test(item.new_sha256)||
      typeof item.binary_inspected!=='boolean'||`${item.view}/${item.path}`<=last)invalid();
    last=`${item.view}/${item.path}`;attestations.push({...item});}
  return {schema:DECISION_SCHEMA,decision_id:value.decision_id,reviewer_label:value.reviewer_label,
    revision_package_sha256:value.revision_package_sha256,original_package_sha256:value.original_package_sha256,
    prior_revise_decision_sha256:value.prior_revise_decision_sha256,
    base_commit:value.base_commit,base_tree:value.base_tree,original_commit:value.original_commit,original_tree:value.original_tree,
    revised_commit:value.revised_commit,revised_tree:value.revised_tree,choice:value.choice,attestations,note:value.note??null,
    boundaries:['REVIEWER_LABEL_NOT_AUTHENTICATED','SOURCE_DECISION_ONLY','NO_EXECUTION_OR_MERGE_AUTHORITY','NO_IMPLICIT_WINNER']};}
function validateDecision(d,v){const m=v.manifest;if(d.revision_package_sha256!==v.manifest_sha256||
  d.original_package_sha256!==m.original_package_sha256||d.prior_revise_decision_sha256!==m.prior_revise_decision_sha256||
  ['base_commit','base_tree','original_commit','original_tree','revised_commit','revised_tree'].some(k=>d[k]!==m[k]))rejected();
  for(const a of d.attestations){const row=m[a.view].find(v=>v.path===a.path);if(!row||a.old_sha256!==(row.old?.sha256??null)||
    a.new_sha256!==row.new.sha256||(d.choice==='ACCEPT'&&row.binary_review_required&&!a.binary_inspected))rejected();}
  if(d.choice==='ACCEPT'&&d.attestations.length!==m.base_to_revised.length+m.original_to_revised.length)rejected();}
async function verifyDecisionInternal(fs,packageDir,decisionDir,expectedSha256){if(!absolute(packageDir)||!absolute(decisionDir)||
  !SHA256.test(expectedSha256)||packageDir===decisionDir||packageDir.startsWith(decisionDir+'/')||decisionDir.startsWith(packageDir+'/'))invalid();
  const v=await verifyInternal(fs,packageDir,undefined);await ancestors(fs,decisionDir);const s=await stat(fs,decisionDir);
  if(!dir(s)||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700||await fs.realpath(decisionDir)!==decisionDir||
    (await listPackage(fs,decisionDir,undefined)).join('|')!=='decision.json')rejected();
  const bytes=await readFile(fs,join(decisionDir,'decision.json'),16384,undefined);let raw;
  try{raw=JSON.parse(decoder.decode(bytes));}catch{rejected();}
  if(digest(bytes)!==expectedSha256||!Buffer.from(encode(raw)).equals(bytes)||
    !matchesKeys(raw,['schema','decision_id','reviewer_label','revision_package_sha256','original_package_sha256',
      'prior_revise_decision_sha256','base_commit','base_tree','original_commit','original_tree','revised_commit','revised_tree',
      'choice','attestations','note','boundaries'])||!Array.isArray(raw.boundaries)||
    raw.boundaries.join('|')!=='REVIEWER_LABEL_NOT_AUTHENTICATED|SOURCE_DECISION_ONLY|NO_EXECUTION_OR_MERGE_AUTHORITY|NO_IMPLICIT_WINNER')rejected();
  let d;try{const {boundaries,...input}=raw;d=captureDecision(input);}catch(e){rejected();}
  if(!Buffer.from(encode(d)).equals(bytes))rejected();validateDecision(d,v);return {decision:d,decision_sha256:expectedSha256,verified:v};}
export async function verifyProjectRevisionDecision(revisionPackageDir,decisionDir,expectedSha256,ports={}){try{
  const v=await verifyDecisionInternal(capturePort(ports),revisionPackageDir,decisionDir,expectedSha256);
  return Object.freeze({status:'PROJECT_REVISION_DECISION_VERIFIED',choice:v.decision.choice,decision_sha256:v.decision_sha256,
    revision_package_sha256:v.verified.manifest_sha256,attested_path_count:v.decision.attestations.length});
  }catch(e){if(e instanceof ReviewPackageError)throw e;rejected();}}
export async function recordProjectRevisionDecision(revisionPackageDir,decision,freshDecisionDir,ports={}){try{
  const fs=capturePort(ports),d=captureDecision(decision);if(!absolute(freshDecisionDir)||!absolute(revisionPackageDir)||
    freshDecisionDir===revisionPackageDir||freshDecisionDir.startsWith(revisionPackageDir+'/')||revisionPackageDir.startsWith(freshDecisionDir+'/'))invalid();
  const v=await verifyInternal(fs,revisionPackageDir,undefined);validateDecision(d,v);const bytes=encode(d);
  await reserve(fs,freshDecisionDir,undefined);await writeFile(fs,freshDecisionDir,'decision.json',bytes,undefined);
  const checked=await verifyDecisionInternal(fs,revisionPackageDir,freshDecisionDir,digest(bytes));
  return Object.freeze({status:'PROJECT_REVISION_DECISION_RECORDED',choice:d.choice,decision_sha256:checked.decision_sha256,
    revision_package_sha256:v.manifest_sha256,attested_path_count:d.attestations.length});
  }catch(e){if(e instanceof ReviewPackageError)throw e;rejected();}}
