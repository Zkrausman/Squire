// Local copy-integrity tooling only. Never imports, executes or publishes candidate code.
import {types} from 'node:util';
import {constants} from 'node:fs';
import {join,resolve,dirname,parse as parsePath} from 'node:path';
import {closed} from './job-spec.mjs';
import {hash,canonicalBytes} from './bounded-codegen-plan.mjs';
import {parseReceiptJson,snapshotReceiptData,projectRunSummary,formatSummaryTerminal} from './offline-run-summary.mjs';
import {projectSingleJsRunSummary,formatSingleJsSummaryTerminal} from './single-js-summary.mjs';

const names=Object.freeze(['artifact.mjs','summary.json','README.txt','package-manifest.json']);
const caps=Object.freeze({'artifact.mjs':65536,'summary.json':262144,'README.txt':65536,'package-manifest.json':16384});
const profiles=['GENERIC_SINGLE_JS','HISTORICAL_Q218'];
const errors=new Set(['DESTINATION_ALREADY_EXISTS','SOURCE_NOT_FOUND','SOURCE_INTEGRITY_MISMATCH','INVALID_RECEIPT','SPECIAL_FILE_REJECTED','PACKAGE_IO_ERROR','PACKAGE_ABORTED']);
export class ReviewPackageError extends Error{constructor(code){super(errors.has(code)?code:'PACKAGE_IO_ERROR');this.code=errors.has(code)?code:'PACKAGE_IO_ERROR';}}
const stop=code=>{throw new ReviewPackageError(code);};
export const safePackageErrorCode=error=>{const code=errorCode(error);return errors.has(code)?code:'PACKAGE_IO_ERROR';};
function errorCode(error){try{if(types.isProxy(error))return null;return Object.getOwnPropertyDescriptor(error,'code')?.value;}catch{return null;}}
function ownBytes(v,max){
  if(types.isProxy(v)||!types.isUint8Array(v))stop('INVALID_RECEIPT');
  const length=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get.call(v);
  if(length>max)stop('INVALID_RECEIPT');const out=new Uint8Array(length);for(let i=0;i<length;i++)out[i]=v[i];return out;
}
function selectedPath(v){
  if(typeof v!=='string'||!v||v.includes('\0')||v.includes('\\')||v.split('/').includes('..'))stop('SPECIAL_FILE_REJECTED');
  const path=resolve(v);if(path===parsePath(path).root)stop('SPECIAL_FILE_REJECTED');return path;
}
function options(value={}){value=snapshotReceiptData(value);closed(value,[],['target_profile'],'package_options');const profile=value.target_profile??'AUTO';if(!['AUTO',...profiles].includes(profile))stop('INVALID_RECEIPT');return {target_profile:profile};}
function projected(receipt,opts){
  const r=snapshotReceiptData(receipt),selection=options(opts).target_profile;
  const generic=r?.schema==='SQUIRE2_SINGLE_JS_RESULT_V1'||r?.schema==='SQUIRE2_SINGLE_JS_DRY_RUN_V1';
  const historical=r?.denominator===17||r?.status==='DRY_RUN_NATIVE_DISABLED'&&!r?.schema;
  const profile=selection==='AUTO'?generic?'GENERIC_SINGLE_JS':historical?'HISTORICAL_Q218':null:selection;
  if(!profile)stop('INVALID_RECEIPT');
  const summary=profile==='GENERIC_SINGLE_JS'?projectSingleJsRunSummary(r):projectRunSummary(r);
  if(profile==='GENERIC_SINGLE_JS'?summary.readiness==='INVALID_RECEIPT':summary.overall_outcome==='INVALID_RECEIPT')stop('INVALID_RECEIPT');
  const w=r.source??r.generation?.physical_source_witness;
  if(!w||typeof w.source_path!=='string'||typeof w.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(w.source_sha256)||!Number.isSafeInteger(w.source_byte_count)||w.source_byte_count<100||w.source_byte_count>65536)stop('SOURCE_INTEGRITY_MISMATCH');
  const source_path=selectedPath(w.source_path),id=r.generation?.record?.job_id;
  const filename=profile==='GENERIC_SINGLE_JS'?'task.mjs':'summarizer.mjs';
  if(typeof id!=='string'||!source_path.endsWith('/output/run-'+id+'/workspace/src/'+filename))stop('SPECIAL_FILE_REJECTED');
  return {profile,summary,declared:{sha256:w.source_sha256,bytes:w.source_byte_count},source_path};
}
function summaryInfo(summary,profile){
  // Reuse the exact existing validated formatter boundaries; never infer a profile from markers.
  const s=snapshotReceiptData(summary);
  if(profile==='GENERIC_SINGLE_JS'){
    const text=formatSingleJsSummaryTerminal(s);
    if(s.schema_version!=='squire2.single_js_summary.v1'||!['CANDIDATE_READY','GENERATION_REJECTED','SYNTAX_REJECTED','INCOMPLETE','FAILED','NOT_RUN'].includes(s.readiness)||!text.startsWith('Squire single-JavaScript receipt: '+s.readiness+'\n'))stop('INVALID_RECEIPT');
    return {summary:s,text,outcome:s.readiness,correctness:'NOT_EVALUATED',exit_code:1};
  }
  const text=formatSummaryTerminal(s);
  if(s.schema_version!=='squire1.offline_summary.v1'||!['PASS','FAIL','INCOMPLETE'].includes(s.overall_outcome)||!text.startsWith('Squire offline receipt summary: '+s.overall_outcome+'\n'))stop('INVALID_RECEIPT');
  return {summary:s,text,outcome:s.overall_outcome,correctness:s.overall_outcome==='PASS'?'EVALUATED_BY_17_FIXTURES':'NOT_PASSED',exit_code:s.overall_outcome==='PASS'?0:1};
}
function makePlan(summary,profile,declared,source){
  const bytes=ownBytes(source,65536);if(bytes.length<100||bytes.length!==declared.bytes||hash(bytes)!==declared.sha256)stop('SOURCE_INTEGRITY_MISMATCH');
  const info=summaryInfo(summary,profile),artifact=info.summary.artifact;
  if(artifact?.witness_present&&(artifact.sha256!==declared.sha256||artifact.byte_count!==declared.bytes))stop('SOURCE_INTEGRITY_MISMATCH');
  const readme='SQUIRE LOCAL HUMAN REVIEW PACKAGE\n\nARTIFACT IDENTIFICATION\nFile: artifact.mjs\nSHA256: '+declared.sha256+'\nBytes: '+declared.bytes+'\nOrigin: declared staged source; exact copy integrity checked separately.\n\nGENERATION, SYNTAX AND TASK CONFORMANCE\n'+info.text+'\nHUMAN REVIEW REQUIRED\nCandidate readiness and syntax validity are not functional task PASS.\nSyntax checks do not establish dependency freedom or code safety.\nReview artifact.mjs locally before deciding whether to execute or disclose it.\nSource bytes remain exclusively in artifact.mjs; this package is not certified safe for publication.\nMode 0400 is cooperative read-only observation, not same-UID tamper protection.\nNo descendant containment, crash recovery, workspace reuse or authenticated provenance.\nManifest presence alone proves neither original operation acknowledgement nor crash durability.\nRead-only verification checks current contents and hashes, not original acknowledgement or authenticity.\nNo automatic apply, commit, push, dependency install or execution is supplied.\n';
  if(/[^\x20-\x7e\n]/.test(readme))stop('INVALID_RECEIPT');
  const content={'artifact.mjs':bytes,'summary.json':canonicalBytes(info.summary),'README.txt':new TextEncoder().encode(readme)},files={};
  for(const name of names.slice(0,3)){const b=content[name];if(b.length>caps[name])stop('INVALID_RECEIPT');files[name]=Object.freeze({bytes:b.length,sha256:hash(b),content:b});}
  const manifest={schema_version:'squire3.package_manifest.v1',completion_status:'COMPLETE',task_profile:profile,readiness_or_outcome:info.outcome,task_correctness:info.correctness,files:names.slice(0,3).map(path=>({path,bytes:files[path].bytes,sha256:files[path].sha256}))};
  const m=canonicalBytes(manifest);if(m.length>caps['package-manifest.json'])stop('INVALID_RECEIPT');files['package-manifest.json']=Object.freeze({bytes:m.length,sha256:hash(m),content:m});
  if(Object.values(files).reduce((a,f)=>a+f.bytes,0)>2097152)stop('INVALID_RECEIPT');
  return Object.freeze({schema:'SQUIRE3_PACKAGE_PLAN_V1',task_profile:profile,readiness_or_outcome:info.outcome,task_correctness:info.correctness,exit_code:info.exit_code,files:Object.freeze(files)});
}
export function planReviewPackage(receipt,source_bytes,opts={}){
  try{const p=projected(receipt,opts);return makePlan(p.summary,p.profile,p.declared,source_bytes);}
  catch(e){const code=errorCode(e);if(errors.has(code))stop(code);stop('INVALID_RECEIPT');}
}
function capturePlan(plan){
  try{
    closed(plan,['schema','task_profile','readiness_or_outcome','task_correctness','exit_code','files'],[],'package_plan');closed(plan.files,names,[],'package_files');
    if(plan.schema!=='SQUIRE3_PACKAGE_PLAN_V1'||!profiles.includes(plan.task_profile))stop('INVALID_RECEIPT');
    const captured={};for(const n of names){const f=plan.files[n];closed(f,['bytes','sha256','content'],[],'package_file');const content=ownBytes(f.content,caps[n]);if(f.bytes!==content.length||f.sha256!==hash(content))stop('INVALID_RECEIPT');captured[n]={bytes:f.bytes,sha256:f.sha256,content};}
    const summary=parseReceiptJson(captured['summary.json'].content),p=makePlan(summary,plan.task_profile,captured['artifact.mjs'],captured['artifact.mjs'].content);
    if(p.readiness_or_outcome!==plan.readiness_or_outcome||p.task_correctness!==plan.task_correctness||p.exit_code!==plan.exit_code||names.some(n=>p.files[n].sha256!==captured[n].sha256))stop('INVALID_RECEIPT');return p;
  }catch(e){const code=errorCode(e);if(errors.has(code))stop(code);stop('INVALID_RECEIPT');}
}
function checkAbort(ports){if(ports.signal?.aborted)stop('PACKAGE_ABORTED');}
async function checked(ports,operation){checkAbort(ports);const value=await operation();checkAbort(ports);return value;}
async function components(path,ports,includeLeaf=true){
  const root=parsePath(path).root,parts=path.slice(root.length).split('/');let current=root;
  for(let i=0;i<parts.length-(includeLeaf?0:1);i++){current=join(current,parts[i]);const st=await checked(ports,()=>ports.fs.lstat(current));if(st.isSymbolicLink()||i<parts.length-1&&!st.isDirectory())stop('SPECIAL_FILE_REJECTED');}
}
async function readBounded(path,max,ports,{source=false,mode=null}={}){
  await components(path,ports);let handle;
  try{
    const before=await checked(ports,()=>ports.fs.lstat(path));
    if(!before.isFile()||before.isSymbolicLink())stop('SPECIAL_FILE_REJECTED');
    if(mode!==null&&(before.mode&0o777)!==mode||source&&![0o400,0o600].includes(before.mode&0o777))stop('SPECIAL_FILE_REJECTED');
    if(before.size>max)stop(source?'SOURCE_INTEGRITY_MISMATCH':'PACKAGE_IO_ERROR');
    // NOFOLLOW and NONBLOCK constrain leaf races; cooperative path checks are not a hostile-FS guarantee.
    handle=await ports.fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    checkAbort(ports);const opened=await checked(ports,()=>handle.stat());
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||mode!==null&&(opened.mode&0o777)!==mode||source&&![0o400,0o600].includes(opened.mode&0o777))stop('SPECIAL_FILE_REJECTED');
    const bytes=new Uint8Array(max+1);let count=0;
    while(count<bytes.length){const r=await checked(ports,()=>handle.read(bytes,count,Math.min(4096,bytes.length-count),count));if(!Number.isSafeInteger(r.bytesRead)||r.bytesRead<0||r.bytesRead>Math.min(4096,bytes.length-count))stop('PACKAGE_IO_ERROR');if(r.bytesRead===0)break;count+=r.bytesRead;if(count>max)stop(source?'SOURCE_INTEGRITY_MISMATCH':'PACKAGE_IO_ERROR');}
    const after=await checked(ports,()=>handle.stat());if(count!==after.size||before.size!==after.size||opened.mtimeMs!==after.mtimeMs||opened.ctimeMs!==after.ctimeMs)stop(source?'SOURCE_INTEGRITY_MISMATCH':'PACKAGE_IO_ERROR');
    return bytes.slice(0,count);
  }finally{await handle?.close();checkAbort(ports);}
}
async function reserve(output,ports){
  const parent=dirname(output);await components(parent,ports);const st=await checked(ports,()=>ports.fs.lstat(parent));
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==ports.uid)stop('SPECIAL_FILE_REJECTED');
  try{await checked(ports,()=>ports.fs.mkdir(output,{recursive:false,mode:0o700}));}
  catch(e){if(errorCode(e)==='EEXIST')stop('DESTINATION_ALREADY_EXISTS');throw e;}
  const created=await checked(ports,()=>ports.fs.lstat(output));if(!created.isDirectory()||created.isSymbolicLink()||created.uid!==ports.uid||(created.mode&0o777)!==0o700)stop('SPECIAL_FILE_REJECTED');
}
function ioPorts(ports){if(!ports||!ports.fs||!Number.isSafeInteger(ports.uid)||ports.uid<0)stop('PACKAGE_IO_ERROR');return ports;}
async function assemble(plan,output,ports){
  const p=capturePlan(plan);
  for(const name of names){
    const path=join(output,name),record=p.files[name];let handle;
    try{checkAbort(ports);handle=await ports.fs.open(path,'wx',0o600);checkAbort(ports);await checked(ports,()=>handle.writeFile(record.content));}
    finally{await handle?.close();}
    checkAbort(ports);const back=await readBounded(path,caps[name],ports);
    if(back.length!==record.bytes||hash(back)!==record.sha256)stop('PACKAGE_IO_ERROR');
    await checked(ports,()=>ports.fs.chmod(path,0o400));
    const st=await checked(ports,()=>ports.fs.lstat(path));if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o777)!==0o400)stop('PACKAGE_IO_ERROR');
  }
  const entries=await checked(ports,()=>ports.fs.readdir(output));if(entries.length!==4||entries.some(n=>!names.includes(n)))stop('PACKAGE_IO_ERROR');
  checkAbort(ports);
  return Object.freeze({schema_version:'squire3.package_receipt.v1',output_dir:output,completion_status:'COMPLETE',manifest_sha256:p.files['package-manifest.json'].sha256,files:Object.freeze(names.slice(0,3).map(path=>Object.freeze({path,bytes:p.files[path].bytes,sha256:p.files[path].sha256}))),task_profile:p.task_profile,readiness_or_outcome:p.readiness_or_outcome,task_correctness:p.task_correctness,exit_code:p.exit_code});
}
export async function writeReviewPackage(plan,output_dir,ports){
  try{ports=ioPorts(ports);const output=selectedPath(output_dir),p=capturePlan(plan);await reserve(output,ports);return await assemble(p,output,ports);}
  catch(e){const code=errorCode(e);if(errors.has(code))stop(code);stop('PACKAGE_IO_ERROR');}
}
export async function buildReviewPackage(spec,ports){
  try{
    ports=ioPorts(ports);closed(spec,['receipt_path','source_path','output_dir'],['options'],'package_spec');
    const receipt=selectedPath(spec.receipt_path),source=selectedPath(spec.source_path),output=selectedPath(spec.output_dir),opts=options(spec.options);
    await reserve(output,ports); // EEXIST stops before input reads or any content mutation.
    let raw;try{raw=parseReceiptJson(await readBounded(receipt,262144,ports));}catch(e){if(errorCode(e)==='PACKAGE_ABORTED')stop('PACKAGE_ABORTED');stop('INVALID_RECEIPT');}
    const projection=projected(raw,opts);if(projection.source_path!==source)stop('SOURCE_INTEGRITY_MISMATCH');
    let bytes;try{bytes=await readBounded(source,65536,ports,{source:true});}catch(e){if(errors.has(errorCode(e)))stop(errorCode(e));if(errorCode(e)==='ENOENT')stop('SOURCE_NOT_FOUND');throw e;}
    const plan=planReviewPackage(raw,bytes,opts),result=await assemble(plan,output,ports);
    // Recheck the selected source's current identity before acknowledging the copy.
    const after=await readBounded(source,65536,ports,{source:true});if(after.length!==projection.declared.bytes||hash(after)!==projection.declared.sha256)stop('SOURCE_INTEGRITY_MISMATCH');
    checkAbort(ports);return result;
  }catch(e){const code=errorCode(e);if(errors.has(code))stop(code);stop('PACKAGE_IO_ERROR');}
}
export async function verifyReviewPackage(package_dir,ports){
  try{
    ports=ioPorts(ports);const root=selectedPath(package_dir);await components(root,ports);const st=await checked(ports,()=>ports.fs.lstat(root));
    if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o777)!==0o700)stop('SPECIAL_FILE_REJECTED');
    const entries=await checked(ports,()=>ports.fs.readdir(root));if(entries.length!==4||entries.some(n=>!names.includes(n)))stop('PACKAGE_IO_ERROR');
    const manifestBytes=await readBounded(join(root,names[3]),caps[names[3]],ports,{mode:0o400}),m=parseReceiptJson(manifestBytes);
    closed(m,['schema_version','completion_status','task_profile','readiness_or_outcome','task_correctness','files'],[],'package_manifest');
    if(m.schema_version!=='squire3.package_manifest.v1'||m.completion_status!=='COMPLETE'||!profiles.includes(m.task_profile)||!Array.isArray(m.files)||m.files.length!==3)stop('PACKAGE_IO_ERROR');
    const bytes={};for(let i=0;i<3;i++){
      const record=m.files[i],name=names[i];closed(record,['path','bytes','sha256'],[],'manifest_file');
      if(record.path!==name||!Number.isSafeInteger(record.bytes)||record.bytes<0||record.bytes>caps[name]||typeof record.sha256!=='string'||!/^[a-f0-9]{64}$/.test(record.sha256))stop('PACKAGE_IO_ERROR');
      bytes[name]=await readBounded(join(root,name),caps[name],ports,{mode:0o400});if(bytes[name].length!==record.bytes||hash(bytes[name])!==record.sha256)stop('PACKAGE_IO_ERROR');
    }
    const summary=parseReceiptJson(bytes['summary.json']),p=makePlan(summary,m.task_profile,m.files[0],bytes['artifact.mjs']);
    if(m.readiness_or_outcome!==p.readiness_or_outcome||m.task_correctness!==p.task_correctness||names.slice(0,3).some(n=>hash(bytes[n])!==p.files[n].sha256)||hash(manifestBytes)!==p.files[names[3]].sha256)stop('PACKAGE_IO_ERROR');
    checkAbort(ports);return Object.freeze({schema_version:'squire3.package_verification.v1',status:'VERIFIED',manifest_sha256:hash(manifestBytes),task_profile:p.task_profile,readiness_or_outcome:p.readiness_or_outcome,task_correctness:p.task_correctness,exit_code:p.exit_code,original_operation_acknowledgement:'UNKNOWN',provenance_authenticity:'NOT_ESTABLISHED',crash_durability:'NOT_ESTABLISHED'});
  }catch{return Object.freeze({schema_version:'squire3.package_verification.v1',status:'CORRUPT_OR_INCOMPLETE',exit_code:2,original_operation_acknowledgement:'UNKNOWN'});}
}
