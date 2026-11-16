// Private review witnesses, not a complete source export or an execution route.
import {join,dirname} from 'node:path';
import {types} from 'node:util';
import {collectRetainedRevisionReviewSource,validateRetainedRevisionWitnesses} from './project-portable-candidate-snapshot.mjs';
import {ReviewPackageError,invalid,rejected,aborted,digest,encode,closed,denseArray,absolute,captureSignal,check,capturePort,file,dir,stable,stat,ancestors,reserve,writeFile,readFile,priorLinks,captureBuildSpec,verifyInternal,manifestFor,makeDiff,rowsFor,side,SHA1,SHA256,TOKEN,decoder} from './internal/revision-review-core.mjs';

const LIMITS=Object.freeze({max_total_bytes:67108864,max_manifest_bytes:8388608,max_object_bytes:33554432,max_objects:8192,max_commit_bytes:65536,max_blob_bytes:4194304,max_base_files:2048,max_candidate_files:2098,max_tree_records:131072,max_base_metadata_bytes:4194304,max_candidate_metadata_bytes:4219904,max_tree_bytes:12634112,max_paths:50,max_side_bytes:4194304,max_copy_bytes:12582912,max_original_package_bytes:17825792,max_result_bytes:262144,max_decision_bytes:98304,max_prior_decisions:8,max_entries:9216});
const BOUNDARIES=Object.freeze(['COPY_INTEGRITY_ONLY','SUPPLIED_CANDIDATE_RESULTS_AS_RECORDS_ONLY','GENERATION_RECEIPT_AND_STAGE_BODIES_NOT_VALIDATED','LIVE_SOURCE_STATE_NOT_ESTABLISHED_OFFLINE','PRODUCER_AND_REVIEWER_NOT_AUTHENTICATED','ORIGINAL_ACKNOWLEDGEMENT_NOT_RECOVERED','NO_EXECUTION_MERGE_DISCLOSURE_OR_RETRY_AUTHORITY']);
const SCHEMA='SQUIRE_RETAINED_REVISION_REVIEW_SOURCE_V1';
const KEYS=['schema','original_result_sha256','revised_result_sha256','endpoints','receipt_sha256','stage_manifest_sha256','original_package_sha256','selected_decision_id','prior_revise_decision_sha256','declared_decisions_sha256','prior_decisions','objects','base_to_original','base_to_revised','original_to_revised','files','limits','object_bytes','retained_bytes','boundaries'];
const hash=v=>typeof v==='string'&&v.length===64&&SHA256.test(v);
const token=v=>typeof v==='string'&&v.length>=1&&v.length<=64&&!/[^A-Za-z0-9_-]/.test(v);
const oid=v=>typeof v==='string'&&v.length===40&&SHA1.test(v);
const eq=(a,b)=>encode(a).equals(encode(b));
const overlap=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
class RetainedError extends Error{constructor(code){super(code);this.name='RetainedRevisionSourceError';this.code=code;delete this.stack;}}
const ABORTED=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
function signalAborted(signal){try{return signal!==undefined&&Reflect.apply(ABORTED,signal,[]);}catch{return false;}}
function strictSignal(value){if(value===undefined)return undefined;if(!value||typeof value!=='object'||types.isProxy(value))invalid();
  let current=value;while(current!==AbortSignal.prototype){if(current===null||types.isProxy(current)||Object.getOwnPropertyDescriptor(current,'aborted'))invalid();current=Object.getPrototypeOf(current);}
  try{Reflect.apply(ABORTED,value,[]);}catch{invalid();}return value;}
function sourceError(e,signal){if(signalAborted(signal))throw new RetainedError('PROJECT_RETAINED_REVISION_SOURCE_ABORTED');if(e instanceof RetainedError)throw e;
  throw new RetainedError(e instanceof ReviewPackageError&&e.code==='INVALID_PROJECT_REVISION_REVIEW_SPEC'?'INVALID_PROJECT_RETAINED_REVISION_SOURCE_SPEC':'PROJECT_RETAINED_REVISION_SOURCE_REJECTED');}
function canonical(bytes){let value;try{value=JSON.parse(decoder.decode(bytes));if(!eqBytes(value,bytes))rejected();}catch{rejected();}return value;}
const eqBytes=(value,bytes)=>encode(value).equals(bytes);
async function rootStat(fs,root){if(!absolute(root))invalid();await ancestors(fs,root);const s=await stat(fs,root);
  if(!dir(s)||s.uid!==process.getuid()||(s.mode&0o7777)!==0o700||await fs.realpath(root)!==root)rejected();return s;}
async function inventory(fs,root,signal,max=LIMITS.max_entries){const found=[];const visit=async rel=>{let handle;try{handle=await fs.opendir(join(root,rel),{bufferSize:1});
  while(true){check(signal);const entry=await handle.read();if(entry===null)break;
    if(typeof entry.name!=='string'||!entry.name||entry.name.includes('/')||entry.name==='.'||entry.name==='..'||found.length>=max)rejected();
    const path=rel?rel+'/'+entry.name:entry.name;if(path.split('/').length>10)rejected();const s=await stat(fs,join(root,path));
    if(s.uid!==process.getuid())rejected();if(dir(s)){if((s.mode&0o7777)!==0o700)rejected();found.push({path:path+'/',stat:s});await visit(path);}
    else{if(!file(s)||s.nlink!==1||(s.mode&0o7777)!==0o400||!Number.isSafeInteger(s.size)||s.size<0)rejected();found.push({path,stat:s});}}
  }finally{if(handle)await handle.close();}};await visit('');return found.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);}
async function copyInputs(fs,spec,signal){const files=new Map();const roots=[{root:spec.original_package.dir,prefix:'original-package',max:LIMITS.max_original_package_bytes},...spec.prior_decisions.map(item=>({root:item.dir,prefix:null,max:LIMITS.max_decision_bytes}))];
  for(const item of roots){await rootStat(fs,item.root);const list=await inventory(fs,item.root,signal,453);let total=0;const read=[];
    for(const e of list)if(!e.path.endsWith('/')){total+=e.stat.size;if(total>item.max)rejected();read.push([e.path,await readFile(fs,join(item.root,e.path),item.max,signal)]);}
    let prefix=item.prefix;if(prefix===null){if(read.length!==1||read[0][0]!=='decision.json')rejected();const d=canonical(read[0][1]);if(!token(d.decision_id))rejected();prefix='prior-decisions/'+d.decision_id;}
    for(const [path,bytes] of read){const full=prefix+'/'+path;if(files.has(full))rejected();files.set(full,bytes);}}
  return files;}
function fileRows(source){return source.files.map(row=>({path:row.path,base:side(row.base),original:side(row.original),revised:side(row.revised)}));}
function endpoints(source){return {base:{commit:source.original_result.base_commit,tree:source.original_result.base_tree},original:{commit:source.original_result.candidate_commit,tree:source.original_result.candidate_tree},revised:{commit:source.revised_result.candidate_commit,tree:source.revised_result.candidate_tree}};}
function publicResult(status,m,manifest){return Object.freeze({status,manifest_sha256:manifest,base_commit:m.endpoints.base.commit,base_tree:m.endpoints.base.tree,original_commit:m.endpoints.original.commit,original_tree:m.endpoints.original.tree,revised_commit:m.endpoints.revised.commit,revised_tree:m.endpoints.revised.tree,base_to_revised_count:m.base_to_revised.length,original_to_revised_count:m.original_to_revised.length,union_count:m.files.length,object_count:m.objects.length,retained_bytes:m.retained_bytes});}
function totalManifest(m,files){const other=[...files.values()].reduce((n,b)=>n+b.length,0);let bytes;
  for(let i=0;i<16;i++){bytes=encode(m);const total=other+bytes.length;if(total>LIMITS.max_total_bytes||bytes.length>LIMITS.max_manifest_bytes)rejected();if(total===m.retained_bytes)return bytes;m.retained_bytes=total;}rejected();}
function requireOriginalCoverage(pm,source){if(!eq(pm.paths.map(r=>r.path),source.base_to_original))rejected();const maps=source.listings.slice(0,2).map(l=>new Map(l.files.map(r=>[r.path,r])));
  for(const row of pm.paths)for(const [i,key] of ['old','new'].entries()){const expected=maps[i].get(row.path);const value=row[key];if(expected?!value||value.mode!==expected.mode||value.git_sha1!==expected.oid:value!==null)rejected();}}
function validateObjects(records,files){const objects=new Map();let total=0,treeBytes=0,last='';for(const row of denseArray(records,LIMITS.max_objects,3)){
  closed(row,['git_sha1','kind','bytes','sha256']);if(!oid(row.git_sha1)||row.git_sha1<=last||!hash(row.sha256)||!['commit','tree','blob'].includes(row.kind)||!Number.isSafeInteger(row.bytes)||row.bytes<0)rejected();last=row.git_sha1;
  const cap=row.kind==='blob'?LIMITS.max_blob_bytes:row.kind==='commit'?LIMITS.max_commit_bytes:LIMITS.max_tree_bytes;
  if(row.bytes>cap||(total+=row.bytes)>LIMITS.max_object_bytes)rejected();if(row.kind==='tree'&&(treeBytes+=row.bytes)>LIMITS.max_tree_bytes)rejected();
  if(files===undefined){objects.set(row.git_sha1,row);continue;}
  const bytes=files.get('objects/'+row.git_sha1.slice(0,2)+'/'+row.git_sha1.slice(2));
  if(!bytes||bytes.length!==row.bytes||digest(bytes)!==row.sha256||gitHash(row.kind,bytes)!==row.git_sha1)rejected();objects.set(row.git_sha1,{kind:row.kind,payload:bytes});}
  return {objects,total};}
import {createHash} from 'node:crypto';
const gitHash=(kind,bytes)=>createHash('sha1').update(Buffer.from(`${kind} ${bytes.length}\0`)).update(bytes).digest('hex');
async function verifySourceInternal(fs,root,expected,signal){if(!absolute(root)||!hash(expected))invalid();check(signal);const before=await rootStat(fs,root);
  const manifestBytes=await readFile(fs,join(root,'retained-revision-manifest.json'),LIMITS.max_manifest_bytes,signal);if(digest(manifestBytes)!==expected)rejected();const m=canonical(manifestBytes);closed(m,KEYS);
  if(m.schema!==SCHEMA||!eq(m.limits,LIMITS)||!eq(m.boundaries,BOUNDARIES)||!Number.isSafeInteger(m.retained_bytes)||m.retained_bytes<1||m.retained_bytes>LIMITS.max_total_bytes)rejected();
  const list=await inventory(fs,root,signal);if(list.filter(e=>!e.path.endsWith('/')).reduce((n,e)=>n+e.stat.size,0)!==m.retained_bytes)rejected();
  const declared=validateObjects(m.objects).objects;
  if(list.filter(e=>!e.path.endsWith('/')&&e.path.startsWith('original-package/')).reduce((n,e)=>n+e.stat.size,0)>LIMITS.max_original_package_bytes)rejected();
  const files=new Map([['retained-revision-manifest.json',manifestBytes]]);
  for(const e of list)if(!e.path.endsWith('/')&&e.path!=='retained-revision-manifest.json'){
    let cap;if(e.path==='results/original.json'||e.path==='results/revised.json')cap=LIMITS.max_result_bytes;
    else if(/^objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(e.path)){const row=declared.get(e.path.slice(8).replace('/',''));if(!row||row.bytes!==e.stat.size)rejected();cap=row.bytes;}
    else if(e.path.startsWith('original-package/'))cap=LIMITS.max_original_package_bytes;
    else if(/^prior-decisions\/[A-Za-z0-9_-]{1,64}\/decision.json$/.test(e.path))cap=LIMITS.max_decision_bytes;
    else rejected();files.set(e.path,await readFile(fs,join(root,e.path),cap,signal));}
  const original=canonical(files.get('results/original.json')??Buffer.alloc(0)),revision=canonical(files.get('results/revised.json')??Buffer.alloc(0));
  const {objects,total}=validateObjects(m.objects,files),source=validateRetainedRevisionWitnesses(original,revision,objects);
  if(!eq(m.endpoints,endpoints(source))||m.original_result_sha256!==source.original_result_sha256||m.revised_result_sha256!==source.revised_result_sha256||m.receipt_sha256!==original.receipt_sha256||m.stage_manifest_sha256!==original.stage_manifest_sha256||m.object_bytes!==total||!eq(m.files,fileRows(source))||!eq(m.base_to_original,source.base_to_original)||!eq(m.base_to_revised,source.base_to_revised)||!eq(m.original_to_revised,source.original_to_revised))rejected();
  const records=denseArray(m.prior_decisions,8,1);let last='';for(const row of records){closed(row,['decision_id','file_sha256']);if(!token(row.decision_id)||row.decision_id<=last||!hash(row.file_sha256))rejected();last=row.decision_id;const record=canonical(files.get('prior-decisions/'+row.decision_id+'/decision.json')??Buffer.alloc(0));if(record.decision_id!==row.decision_id)rejected();}
  const spec={original_package:{dir:join(root,'original-package'),manifest_sha256:m.original_package_sha256},prior_decisions:records.map(row=>({dir:join(root,'prior-decisions',row.decision_id),file_sha256:row.file_sha256})),selected_decision_id:m.selected_decision_id};
  const links=await priorLinks(fs,spec,source,signal);if(m.prior_revise_decision_sha256!==links.prior_revise_decision_sha256||m.declared_decisions_sha256!==links.declared_decisions_sha256)rejected();
  const pm=canonical(files.get('original-package/review-manifest.json')??Buffer.alloc(0));requireOriginalCoverage(pm,source);
  if([...files].filter(([k])=>k.startsWith('original-package/')).reduce((n,[,b])=>n+b.length,0)>LIMITS.max_original_package_bytes)rejected();
  const expectedFiles=new Set(['retained-revision-manifest.json','results/original.json','results/revised.json',...m.objects.map(r=>'objects/'+r.git_sha1.slice(0,2)+'/'+r.git_sha1.slice(2)),...records.map(r=>'prior-decisions/'+r.decision_id+'/decision.json'),...[...files.keys()].filter(k=>k.startsWith('original-package/'))]);
  if(expectedFiles.size!==files.size||[...files.keys()].some(k=>!expectedFiles.has(k)))rejected();const expectedEntries=new Set(expectedFiles);
  for(const path of expectedFiles){let parent=dirname(path);while(parent!=='.'){expectedEntries.add(parent+'/');parent=dirname(parent);}}
  if(!eq([...expectedEntries].sort(),list.map(e=>e.path)))rejected();
  // Re-read all retained bytes after semantic consumers, then recheck metadata/closure.
  for(const [path,bytes] of files)if(!(await readFile(fs,join(root,path),bytes.length,signal)).equals(bytes))rejected();
  const afterList=await inventory(fs,root,signal);if(!eq(afterList.map(e=>e.path),list.map(e=>e.path))||afterList.some((e,i)=>!stable(e.stat,list[i].stat)))rejected();
  if(!stable(before,await rootStat(fs,root)))rejected();check(signal);return {m,source,links,files,rootStat:before,manifest_sha256:expected};}

export async function buildProjectRetainedRevisionReviewSource(spec,ports={}){let signal;try{
  closed(spec,['schema','original_result','revised_result','base_git_dir','base_git_identity','original_git_dir','original_git_identity','revised_git_dir','revised_git_identity','output_dir','original_package','prior_decisions','selected_decision_id'],['signal']);
  if(spec.schema!=='SQUIRE_PROJECT_RETAINED_REVISION_SOURCE_SPEC_V1')invalid();const live={...spec,schema:'SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1'};signal=strictSignal(captureBuildSpec(live));const fs=capturePort(ports);check(signal);
  const collect=async()=>{const raw=await collectRetainedRevisionReviewSource({schema:live.schema,original_result:live.original_result,revised_result:live.revised_result,base_git_dir:live.base_git_dir,base_git_identity:live.base_git_identity,original_git_dir:live.original_git_dir,original_git_identity:live.original_git_identity,revised_git_dir:live.revised_git_dir,revised_git_identity:live.revised_git_identity,output_dir:live.output_dir,signal},{fs});
    const source=validateRetainedRevisionWitnesses(raw.original_result,raw.revised_result,raw.rawObjects),links=await priorLinks(fs,live,source,signal),copies=await copyInputs(fs,live,signal);
    requireOriginalCoverage(canonical(copies.get('original-package/review-manifest.json')),source);
    const files=new Map(copies);files.set('results/original.json',encode(source.original_result));files.set('results/revised.json',encode(source.revised_result));
    if(files.get('results/original.json').length>LIMITS.max_result_bytes||files.get('results/revised.json').length>LIMITS.max_result_bytes)rejected();
    const objects=[...raw.rawObjects].sort(([a],[b])=>a<b?-1:1).map(([git_sha1,o])=>{files.set('objects/'+git_sha1.slice(0,2)+'/'+git_sha1.slice(2),o.payload);return {git_sha1,kind:o.kind,bytes:o.payload.length,sha256:digest(o.payload)};});
    const {total}=validateObjects(objects,files);const records=[...copies].filter(([k])=>k.startsWith('prior-decisions/')).map(([,b])=>{const d=canonical(b);return {decision_id:d.decision_id,file_sha256:digest(b)};}).sort((a,b)=>a.decision_id<b.decision_id?-1:1);
    const m={schema:SCHEMA,original_result_sha256:source.original_result_sha256,revised_result_sha256:source.revised_result_sha256,endpoints:endpoints(source),receipt_sha256:source.original_result.receipt_sha256,stage_manifest_sha256:source.original_result.stage_manifest_sha256,original_package_sha256:links.original_package_sha256,selected_decision_id:live.selected_decision_id,prior_revise_decision_sha256:links.prior_revise_decision_sha256,declared_decisions_sha256:links.declared_decisions_sha256,prior_decisions:records,objects,base_to_original:source.base_to_original,base_to_revised:source.base_to_revised,original_to_revised:source.original_to_revised,files:fileRows(source),limits:LIMITS,object_bytes:total,retained_bytes:0,boundaries:BOUNDARIES};
    files.set('retained-revision-manifest.json',totalManifest(m,files));return {m,files};};
  const prepared=await collect(),expected=digest(prepared.files.get('retained-revision-manifest.json'));const container=await reserve(fs,spec.output_dir,signal);
  for(const [path,bytes] of prepared.files)await writeFile(fs,spec.output_dir,path,bytes,signal);
  const again=await collect();if(!eq([...again.files.keys()].sort(),[...prepared.files.keys()].sort())||[...prepared.files].some(([path,bytes])=>!again.files.get(path).equals(bytes)))rejected();
  const verified=await verifySourceInternal(fs,spec.output_dir,expected,signal);if(verified.rootStat.dev!==container.dev||verified.rootStat.ino!==container.ino)rejected();
  return publicResult('PROJECT_RETAINED_REVISION_SOURCE_CREATED',verified.m,expected);
}catch(e){sourceError(e,signal);}}
export async function verifyProjectRetainedRevisionReviewSource(sourceDir,expectedManifestSha256,ports={}){try{
  if(!absolute(sourceDir)||!hash(expectedManifestSha256))invalid();const v=await verifySourceInternal(capturePort(ports),sourceDir,expectedManifestSha256);return publicResult('PROJECT_RETAINED_REVISION_SOURCE_VERIFIED',v.m,v.manifest_sha256);
}catch(e){sourceError(e);}}

export async function buildProjectRevisionReviewPackageFromRetainedSource(spec,ports={}){let signal;try{
  closed(spec,['schema','retained_source_dir','expected_manifest_sha256','output_dir'],['signal']);if(spec.schema!=='SQUIRE_PROJECT_REVISION_REVIEW_RETAINED_SPEC_V1'||!absolute(spec.retained_source_dir)||!absolute(spec.output_dir)||!hash(spec.expected_manifest_sha256)||overlap(spec.retained_source_dir,spec.output_dir))invalid();
  signal=strictSignal(spec.signal);const fs=capturePort(ports);check(signal);const v=await verifySourceInternal(fs,spec.retained_source_dir,spec.expected_manifest_sha256,signal),source=v.source;
  const displays={base:makeDiff(rowsFor(source.files,source.base_to_revised,'base'),'base'),original:makeDiff(rowsFor(source.files,source.original_to_revised,'original'),'original')};
  const manifest=manifestFor(source,v.links,displays),manifestBytes=encode(manifest),expected=digest(manifestBytes),copyBytes=source.files.reduce((n,r)=>n+['base','original','revised'].reduce((sum,k)=>sum+(r[k]?.bytes??0),0),0),packageBytes=copyBytes+displays.base.length+displays.original.length+manifestBytes.length;
  if(manifestBytes.length>512*1024||packageBytes>29*1024*1024)rejected();
  const receipt={schema:'SQUIRE_RETAINED_REVISION_REVIEW_PROVENANCE_V1',source_manifest_sha256:v.manifest_sha256,revision_package_manifest_sha256:expected,original_result_sha256:source.original_result_sha256,revised_result_sha256:source.revised_result_sha256,original_package_sha256:v.links.original_package_sha256,prior_revise_decision_sha256:v.links.prior_revise_decision_sha256,declared_decisions_sha256:v.links.declared_decisions_sha256,base_commit:manifest.base_commit,base_tree:manifest.base_tree,original_commit:manifest.original_commit,original_tree:manifest.original_tree,revised_commit:manifest.revised_commit,revised_tree:manifest.revised_tree,base_to_revised_count:source.base_to_revised.length,original_to_revised_count:source.original_to_revised.length,union_count:source.files.length,package_bytes:packageBytes,boundaries:BOUNDARIES};
  const receiptBytes=encode(receipt);if(receiptBytes.length>16384)rejected();const container=await reserve(fs,spec.output_dir,signal);const pkg=join(spec.output_dir,'package'),packageIdentity=await reserve(fs,pkg,signal);
  for(const row of source.files)for(const key of ['base','original','revised'])if(row[key])await writeFile(fs,pkg,`changes/${row.path}.${key}`,row[key].data,signal);
  await writeFile(fs,pkg,'base-to-revised.diff.txt',displays.base,signal);await writeFile(fs,pkg,'original-to-revised.diff.txt',displays.original,signal);await writeFile(fs,pkg,'revision-review-manifest.json',manifestBytes,signal);
  if((await verifyInternal(fs,pkg,signal)).manifest_sha256!==expected)rejected();await writeFile(fs,spec.output_dir,'provenance.json',receiptBytes,signal);
  const again=await verifySourceInternal(fs,spec.retained_source_dir,spec.expected_manifest_sha256,signal);if(!stable(v.rootStat,again.rootStat))rejected();
  const list=await inventory(fs,spec.output_dir,signal,505);if(!list.some(e=>e.path==='package/')||list.some(e=>e.path!=='provenance.json'&&!e.path.startsWith('package/')))rejected();
  const out=await verifyInternal(fs,pkg,signal);if(out.manifest_sha256!==expected||out.package_bytes!==packageBytes||!(await readFile(fs,join(spec.output_dir,'provenance.json'),16384,signal)).equals(receiptBytes))rejected();
  const packageAfter=await rootStat(fs,pkg),end=await rootStat(fs,spec.output_dir);if(packageAfter.dev!==packageIdentity.dev||packageAfter.ino!==packageIdentity.ino||end.dev!==container.dev||end.ino!==container.ino)rejected();check(signal);
  return Object.freeze({status:'PROJECT_REVISION_REVIEW_PACKAGE_CREATED_FROM_RETAINED_SOURCE',source_manifest_sha256:v.manifest_sha256,manifest_sha256:expected,provenance_sha256:digest(receiptBytes),base_commit:manifest.base_commit,base_tree:manifest.base_tree,original_commit:manifest.original_commit,original_tree:manifest.original_tree,revised_commit:manifest.revised_commit,revised_tree:manifest.revised_tree,base_to_revised_count:receipt.base_to_revised_count,original_to_revised_count:receipt.original_to_revised_count,union_count:receipt.union_count,package_bytes:packageBytes});
}catch(e){if(e instanceof ReviewPackageError)throw e;if(signalAborted(signal))aborted();rejected();}}
