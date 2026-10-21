import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join,basename} from 'node:path';
import {hash} from '../src/bounded-codegen-plan.mjs';
import {planReviewPackage,buildReviewPackage,writeReviewPackage,verifyReviewPackage} from '../src/human-review-package.mjs';
import {runPackageCli} from '../bin/squire-package.mjs';

const source=new TextEncoder().encode('// PUBLIC_SYNTHETIC_CODE_BODY_NEVER_REPORT\n'+('export const publicExample = 1;\n').repeat(5));
const id='ba586107-7240-4d89-88d3-d71005bce32f';
const names=['artifact.mjs','summary.json','README.txt','package-manifest.json'];
function receipt(path,bytes=source,generic=false){
 const sha=hash(bytes),record={job_id:id,task_class:generic?'SINGLE_JS_CODEGEN_V1':'BOUNDED_CODEGEN_SUMMARIZER_V5',lifecycle_status:'LIMITED_SUCCESS',requested_model:'gpt-6-luna',reported_model:'UNKNOWN',process_exit:{pid:1,exit_code:0,exit_signal:null,process_wall_ms:0,observed_termination:true},io_state:{stdout_bytes_observed:bytes.length,stderr_bytes_observed:0,stdout_eof:true,stderr_eof:true,io_drained:true},containment_evidence:{containment_level:'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',settlement_status:'SETTLED_DIRECT_CHILD_EXIT',descendant_guarantee:'NONE'},provider_metadata:{provider_reported_status:'turn.completed',duration_seconds:null,usage_tokens:{input:0,output:1,cache_read:0,thinking:'UNKNOWN',total:null},codex_reasoning_output_tokens:0},output_custody:{persisted:true,path,byte_count:bytes.length,persistence_error:null},task_outcome_evaluated:false,task_payload_valid:true,error_details:{code:null,classification:null,message:'PRIVATE_ERROR_SENTINEL'}};
 const generation={record,diagnostic_retention:{retention_status:'NOT_REQUESTED',rejection_stage:null,rejection_reason:null,exact_response_bytes:null,retained_bytes_count:null,retained_truncated:false,retention_error:null},runtime_evidence:{deadline_ms:120000,timeout_latched:false,abort_latched:false,signal_attempts:[],event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',workspace_reuse:'NOT_AUTHORIZED',workspace_disposition:'DEDICATED_NOT_REUSED',max_steps:'UNSUPPORTED'},physical_source_witness:{source_path:path,source_sha256:sha,source_byte_count:bytes.length,format_status:'FORMAT_VALID',syntax_observation:'UNESTABLISHED_NO_NATIVE_PARSER',witness_locked:true,destination_mode:'0o400',witness_timestamp_ms:0},runtime_admitted:false};
 const syntax={wrapper_status:'ACCEPTED',observation:{syntax_status:'SYNTAX_VALID',syntax_valid:true},execution:{status:'OBSERVED_EXIT',observed_exit_code:0,observed_exit_signal:null,observed_wall_ms:0,observed_termination:true,io_state:{stdout_bytes_observed:0,stderr_bytes_observed:0,stdout_eof:true,stderr_eof:true,io_drained:true},settlement_status:'SETTLED_DIRECT_CHILD_EXIT',signal_attempts:[],deadline_ms:5000,runtime_admitted:false,descendant_guarantee:'NONE',workspace_reuse:'NOT_AUTHORIZED'}};
 const r={status:generic?'CANDIDATE_READY':'PASS',reason:null,generation,syntax,source:{source_path:path,source_sha256:sha,source_byte_count:bytes.length,inspection:'ACTUAL_BYTES_COOPERATIVE_FORMAT_ONLY',safety:'NOT_ESTABLISHED'},runtime_admitted:false,workspace_disposition:'DEDICATED_NOT_REUSED',descendant_guarantee:'NONE'};
 if(generic)Object.assign(r,{schema:'SQUIRE2_SINGLE_JS_RESULT_V1',task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false});
 else Object.assign(r,{fixture_deadline_ms:85000,denominator:17,fixtures:Array.from({length:17},(_,i)=>({fixture_id:`FIX-${String(i+1).padStart(2,'0')}`,status:'PASS',fixture_verdict:'PASS',observed_exit_code:i<10?0:i<13?2:i<16?3:4,observed_exit_signal:null,observed_wall_ms:0,exit_code_matched:true,summary_json_matched:i<10?true:'NOT_APPLICABLE',manifest_json_matched:i<10?true:'NOT_APPLICABLE',zero_files_verified:'NOT_APPLICABLE'}))});
 return r;
}
async function fixture(fn,{generic=false,bytes=source}={}){
 const root=await fs.mkdtemp(new URL('./package-fixture-',import.meta.url));
 try{
  const path=join(root,'output','run-'+id,'workspace','src',generic?'task.mjs':'summarizer.mjs');await fs.mkdir(join(path,'..'),{recursive:true,mode:0o700});await fs.writeFile(path,bytes,{flag:'wx',mode:0o400});
  const r=receipt(path,bytes,generic),rp=join(root,'receipt.json');await fs.writeFile(rp,JSON.stringify(r),{flag:'wx',mode:0o600});
  await fn({root,path,r,spec:{receipt_path:rp,source_path:path,output_dir:join(root,'package')},ports:{fs,uid:process.getuid()}});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('pure package plan preserves exact source and closed safe projections; selector cannot bypass validation',()=>{
 const path='/public/output/run-'+id+'/workspace/src/summarizer.mjs',r=receipt(path),p=planReviewPackage(r,source);
 assert.ok(Object.isFrozen(p));assert.deepEqual(p.files['artifact.mjs'].content,source);assert.deepEqual(Object.keys(p.files),names);assert.equal(p.exit_code,0);
 const summary=JSON.parse(new TextDecoder().decode(p.files['summary.json'].content));assert.equal(summary.generation.tokens.input,0);assert.equal(summary.generation.tokens.total,null);assert.equal(summary.generation.inference_duration_sec,null);
 for(const name of names.slice(1)){const text=new TextDecoder().decode(p.files[name].content);assert.equal(/PRIVATE_ERROR|PUBLIC_SYNTHETIC_CODE_BODY|\/public\/|\x1b/.test(text),false);}
 assert.throws(()=>planReviewPackage({...r,schema:'SQUIRE2_SINGLE_JS_OPERATION_V1'},source,{target_profile:'GENERIC_SINGLE_JS'}));assert.throws(()=>planReviewPackage(r,source,{target_profile:'GENERIC_SINGLE_JS'}));assert.throws(()=>planReviewPackage(r,new Uint8Array(99)));assert.throws(()=>planReviewPackage(r,new Uint8Array(65537)));
});
test('owned-file build produces four independent copies and read-only verification, without original ACK claim',async()=>fixture(async f=>{
 const p=await buildReviewPackage(f.spec,f.ports);assert.equal(p.completion_status,'COMPLETE');assert.equal(p.exit_code,0);assert.deepEqual((await fs.readdir(f.spec.output_dir)).sort(),[...names].sort());
 assert.deepEqual(await fs.readFile(join(f.spec.output_dir,'artifact.mjs')),Buffer.from(source));assert.notEqual((await fs.stat(f.path)).ino,(await fs.stat(join(f.spec.output_dir,'artifact.mjs'))).ino);
 for(const n of names)assert.equal((await fs.stat(join(f.spec.output_dir,n))).mode&0o777,0o400);
 const v=await verifyReviewPackage(f.spec.output_dir,f.ports);assert.equal(v.status,'VERIFIED');assert.equal(v.original_operation_acknowledgement,'UNKNOWN');assert.equal(v.provenance_authenticity,'NOT_ESTABLISHED');
}));
test('generic candidate package retains NOT_EVALUATED and no invented17-fixture PASS',async()=>fixture(async f=>{
 let out='',err='';const ports={...f.ports,stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}};
 assert.equal(await runPackageCli(['--build',f.spec.receipt_path,f.path,f.spec.output_dir],ports),1);assert.equal(err,'');assert.match(out,/CANDIDATE_READY/);assert.equal(out.includes(f.root),false);
 const s=JSON.parse(await fs.readFile(join(f.spec.output_dir,'summary.json'),'utf8'));assert.equal(s.task_correctness,'NOT_EVALUATED');assert.equal(Object.hasOwn(s,'fixtures'),false);assert.equal((await verifyReviewPackage(f.spec.output_dir,f.ports)).exit_code,1);
},{generic:true}));
test('existing empty/nonempty/file/symlink destinations stop before input open with no mutation',async()=>{
 for(const kind of ['empty','nonempty','file','symlink'])await fixture(async f=>{
  const target=f.spec.output_dir;if(kind==='file')await fs.writeFile(target,'SENTINEL');else if(kind==='symlink')await fs.symlink(f.root,target);else{await fs.mkdir(target);if(kind==='nonempty')await fs.writeFile(join(target,'sentinel'),'SENTINEL');}
  const before=await fs.lstat(target);let opened=0,chmod=0;const wrapped={...fs,open:async()=>{opened++;throw Error('DO_NOT_READ');},chmod:async()=>{chmod++;}};
  await assert.rejects(buildReviewPackage(f.spec,{...f.ports,fs:wrapped}),e=>e.code==='DESTINATION_ALREADY_EXISTS');const after=await fs.lstat(target);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.ctimeMs,before.ctimeMs);assert.equal(opened,0);assert.equal(chmod,0);
 });
});
test('missing, oversized, changed or mismatched selected source leaves partial directory without manifest',async()=>{
 for(const kind of ['missing','large','digest','other'])await fixture(async f=>{
  if(kind==='missing')await fs.unlink(f.path);if(kind==='large'){await fs.unlink(f.path);await fs.writeFile(f.path,new Uint8Array(65537),{mode:0o400});}if(kind==='digest'){await fs.unlink(f.path);await fs.writeFile(f.path,new Uint8Array(source.length),{mode:0o400});}if(kind==='other')f.spec.source_path=join(f.root,'neighbor');
  await assert.rejects(buildReviewPackage(f.spec,f.ports),e=>['SOURCE_NOT_FOUND','SOURCE_INTEGRITY_MISMATCH'].includes(e.code));assert.deepEqual(await fs.readdir(f.spec.output_dir),[]);
 });
});
test('selected path symlinks, traversal, unexpected source mode and invalid receipt fail closed',async()=>{
 for(const kind of ['symlink','traversal','mode','receipt'])await fixture(async f=>{
  if(kind==='symlink'){const backup=f.path+'.original';await fs.rename(f.path,backup);await fs.symlink(backup,f.path);}if(kind==='traversal')f.spec.output_dir=f.root+'/../escape';if(kind==='mode')await fs.chmod(f.path,0o500);if(kind==='receipt')await fs.writeFile(f.spec.receipt_path,'{"status":1,"status":2}');
  await assert.rejects(buildReviewPackage(f.spec,f.ports),e=>['SPECIAL_FILE_REJECTED','INVALID_RECEIPT'].includes(e.code));
 });
});
test('write/close/readback/chmod failures preserve honest partial output and stop without rollback',async()=>{
 for(const name of names)for(const kind of ['write','close','read','chmod'])await fixture(async f=>{
  let triggered=0;const wrapped={...fs,async open(path,flags,...rest){const h=await fs.open(path,flags,...rest);return {stat:()=>h.stat(),read:async(...a)=>{if(basename(path)===name&&kind==='read'&&flags!=='wx'){triggered++;throw Error('PRIVATE_READ_ERROR');}return h.read(...a);},writeFile:async b=>{if(basename(path)===name&&kind==='write'){triggered++;throw Error('PRIVATE_WRITE_ERROR');}return h.writeFile(b);},close:async()=>{await h.close();if(basename(path)===name&&kind==='close'&&flags==='wx'){triggered++;throw Error('PRIVATE_CLOSE_ERROR');}}};},async chmod(path,mode){if(basename(path)===name&&kind==='chmod'){triggered++;throw Error('PRIVATE_CHMOD_ERROR');}return fs.chmod(path,mode);}};
  await assert.rejects(buildReviewPackage(f.spec,{...f.ports,fs:wrapped}),e=>e.code==='PACKAGE_IO_ERROR');assert.equal(triggered,1);assert.equal((await verifyReviewPackage(f.spec.output_dir,f.ports)).status,'CORRUPT_OR_INCOMPLETE');assert.deepEqual(await fs.readFile(f.path),Buffer.from(source));
 });
});
test('valid contents may verify after late failure but cannot establish original operation acknowledgement',async()=>fixture(async f=>{
 let sourceOpens=0;const wrapped={...fs,async open(path,...a){if(path===f.path&&++sourceOpens===2)throw Error('PRIVATE_LATE_READ_FAILURE');return fs.open(path,...a);}};
 await assert.rejects(buildReviewPackage(f.spec,{...f.ports,fs:wrapped}),e=>e.code==='PACKAGE_IO_ERROR');const v=await verifyReviewPackage(f.spec.output_dir,f.ports);assert.equal(v.status,'VERIFIED');assert.equal(v.original_operation_acknowledgement,'UNKNOWN');
}));
test('verifier rejects changed bytes, extra entries, missing files and manifest schema corruption',async()=>{
 for(const kind of ['changed','extra','missing','manifest','symlink','directory'])await fixture(async f=>{
  await buildReviewPackage(f.spec,f.ports);if(kind==='extra')await fs.writeFile(join(f.spec.output_dir,'extra'),'unexpected');else if(kind==='missing')await fs.unlink(join(f.spec.output_dir,'README.txt'));else if(kind==='symlink'||kind==='directory'){const target=join(f.spec.output_dir,'artifact.mjs');await fs.unlink(target);if(kind==='symlink')await fs.symlink(f.path,target);else await fs.mkdir(target);}else{const target=join(f.spec.output_dir,kind==='changed'?'artifact.mjs':'package-manifest.json');await fs.unlink(target);await fs.writeFile(target,kind==='changed'?new Uint8Array(source.length):'{"completion_status":"COMPLETE"}',{mode:0o400});}
  assert.equal((await verifyReviewPackage(f.spec.output_dir,f.ports)).status,'CORRUPT_OR_INCOMPLETE');
 });
});
test('failed conformance can be packaged honestly, with private control strings excluded',async()=>fixture(async f=>{
 const r=f.r;r.status='FAIL';r.reason='FIXTURE_REJECTED';r.workspace_disposition='QUARANTINED';r.fixtures[0].status=r.fixtures[0].fixture_verdict='FAIL';r.fixtures[0].exit_code_matched=false;
 r.generation.record.requested_model='PRIVATE_MODEL\x1b[31m';r.generation.record.error_details.message='PRIVATE_PROMPT_OR_SECRET';Object.assign(r,{operator_admitted:true,operator_receipt:'/home/PRIVATE_OPERATOR\0',direct_child_invocations:{generation:1,syntax:1,fixtures:17},outer_observation_target_ms:250000,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP'});
 await fs.writeFile(f.spec.receipt_path,JSON.stringify(r));const result=await buildReviewPackage(f.spec,f.ports);assert.equal(result.exit_code,1);assert.equal(result.readiness_or_outcome,'FAIL');
 for(const n of names.slice(1)){const text=await fs.readFile(join(f.spec.output_dir,n),'utf8');assert.equal(/PRIVATE_|\x1b|\0/.test(text),false);}
 assert.equal((await verifyReviewPackage(f.spec.output_dir,f.ports)).exit_code,1);
}));
test('aborted packaging does not create a destination or claim completion',async()=>fixture(async f=>{
 const controller=new AbortController();controller.abort();await assert.rejects(buildReviewPackage(f.spec,{...f.ports,signal:controller.signal}),e=>e.code==='PACKAGE_ABORTED');await assert.rejects(fs.lstat(f.spec.output_dir));
}));
test('abort during final source or verification close cannot acknowledge COMPLETE or VERIFIED',async()=>fixture(async f=>{
 const controller=new AbortController();let opens=0;
 const wrapped={...fs,async open(path,...a){const h=await fs.open(path,...a),last=path===f.path&&++opens===2;return {stat:()=>h.stat(),read:(...args)=>h.read(...args),writeFile:b=>h.writeFile(b),async close(){await h.close();if(last)controller.abort();}};}};
 await assert.rejects(buildReviewPackage(f.spec,{...f.ports,fs:wrapped,signal:controller.signal}),e=>e.code==='PACKAGE_ABORTED');
 const verificationController=new AbortController();const verificationFS={...fs,async open(path,...a){const h=await fs.open(path,...a);return {stat:()=>h.stat(),read:(...args)=>h.read(...args),close:async()=>{await h.close();if(basename(path)==='README.txt')verificationController.abort();}};}};
 assert.equal((await verifyReviewPackage(f.spec.output_dir,{...f.ports,fs:verificationFS,signal:verificationController.signal})).status,'CORRUPT_OR_INCOMPLETE');
}));
test('plan bytes are exact, including BOM; altered plan buffers fail before destination creation',async()=>fixture(async f=>{
 const p=planReviewPackage(f.r,source);p.files['artifact.mjs'].content[0]^=1;await assert.rejects(writeReviewPackage(p,f.spec.output_dir,f.ports),e=>e.code==='INVALID_RECEIPT');await assert.rejects(fs.lstat(f.spec.output_dir));
 const bytes=new Uint8Array([239,187,191,...source]),r=receipt('/public/output/run-'+id+'/workspace/src/summarizer.mjs',bytes);assert.deepEqual(planReviewPackage(r,bytes).files['artifact.mjs'].content,bytes);
}));
test('CLI errors suppress private paths, native messages and Proxy error callbacks',async()=>fixture(async f=>{
 let out='',err='',traps=0;const ports={...f.ports,stdout:{write:s=>out+=s},stderr:{write:s=>err+=s},fs:{...fs,mkdir:async()=>{throw new Proxy(Error('PRIVATE_SECRET'),{get(){traps++;throw Error('PRIVATE_GETTER');},getPrototypeOf(){traps++;throw Error('PRIVATE_PROTOTYPE');}});}}};
 assert.equal(await runPackageCli(['--build',f.spec.receipt_path,f.path,f.spec.output_dir],ports),2);assert.equal(out,'');assert.equal(err,'PACKAGE_IO_ERROR\n');assert.equal(traps,0);assert.equal((out+err).includes(f.root),false);
}));
