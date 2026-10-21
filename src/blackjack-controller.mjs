// Source-only orchestration. Imports no provider, child_process, desktop or grading adapter.
import {constants} from 'node:fs';
import {join,dirname,parse} from 'node:path';
import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {closed} from './job-spec.mjs';
import {hash,canonicalBytes,NODE_RUNTIME} from './bounded-codegen-plan.mjs';
import {verifyStage,planStaging} from './multifile-staging.mjs';
import {validateProjectPayloadJson} from './project-task.mjs';
import {validateLimitedJobRecord} from './limited-job-record.mjs';
import {buildExport,verifyExport} from './multifile-export.mjs';
import {BLACKJACK_BASE_SOURCE_PINS,BLACKJACK_BRIEF_SHA256,BLACKJACK_PHASES as P,BlackjackControllerError,validateBlackjackSpec,parseBlackjackInterpretation,byteCopy,freezeData,integer,absolute,rejectBlackjack as no} from './blackjack-contract.mjs';
const scopes=new Set(),runs=new Set();
const abortedGetter=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
const isAborted=s=>s!==undefined&&Reflect.apply(abortedGetter,s,[]);
const reasons=new Set(['PREPARATION_FAILED','CLOCK_UNAVAILABLE','CANCELED','OBSERVATION_DEADLINE','CALL_OBSERVATION_DEADLINE','INVALID_INTERPRETATION_WIRE','INTERPRETATION_PERSISTENCE_FAILED','INTERPRETATION_ACK_REQUIRED','MODEL_EXECUTION_DISABLED','INCOMPATIBLE_GENERATION_PROFILE','UNQUALIFIED_NATIVE_EXECUTION_REJECTED','INVALID_CANDIDATE_RESULT','STAGE_BINDING_MISMATCH','EXPORT_REJECTED','INSUFFICIENT_RUN_WALLCLOCK','MODEL_BUDGET_EXHAUSTED','NATIVE_BUDGET_EXHAUSTED']);
function safeReason(e,fallback){try{if(!types.isProxy(e)&&e instanceof BlackjackControllerError){const c=Object.getOwnPropertyDescriptor(e,'code')?.value;if(reasons.has(c))return c;}}catch{}return fallback;}
function regular(s,uid,mode,max){if(!s||!integer(s.uid)||!integer(s.mode)||!integer(s.dev)||!integer(s.ino)||!integer(s.size)||s.size>max||s.uid!==uid||s.nlink!==1||(s.mode&0o777)!==mode||!s.isFile()||s.isSymbolicLink())no('INTERPRETATION_PERSISTENCE_FAILED');}
function directory(s,uid,target=false){if(!s||!integer(s.uid)||!integer(s.mode)||!s.isDirectory()||s.isSymbolicLink()||target&&(s.uid!==uid||(s.mode&0o777)!==0o700))no('PREPARATION_FAILED');}
const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;

export async function prepareBlackjackController(input,ports){
 const spec=validateBlackjackSpec(input);
 // In-memory permanent reservations are logical no-reuse, not cross-process enforcement.
 if(scopes.has(spec.workspace_root)||runs.has(spec.run_id))no('WORKSPACE_ALREADY_CONSUMED');
 scopes.add(spec.workspace_root);runs.add(spec.run_id);
 if(!ports||!integer(ports.uid)||!ports.fs||!ports.clock||typeof ports.clock.now!=='function'||typeof ports.clock.schedule!=='function')no('PREPARATION_FAILED');
 const {fs,clock,uid}=ports,abort=new AbortController();
 let phase=P[0],last=0,start,deadline,active=null,clockBusy=false,sealed=false,failure=null,checkpoint=null;
 let modelReserved=0,modelCompleted=0,nativeReserved=0,nativeCompleted=0,rejected=0;
 let interpretation=null,wireBytes=null,receiptBytes=null,stage=null,stageRoot=null,exported=null;
 let cancelRun=null;const pending=new Set();let stopped;
 const stopPromise=new Promise(resolve=>{stopped=resolve;});
 function fail(status,reason){if(failure||sealed)return;failure={status,reason,phase};rejected++;abort.abort();stopped();}
 function now(){
  if(clockBusy){fail('FAILED','CLOCK_UNAVAILABLE');no('CLOCK_UNAVAILABLE');}
  clockBusy=true;let n;try{n=clock.now();}catch{fail('FAILED','CLOCK_UNAVAILABLE');no('CLOCK_UNAVAILABLE');}finally{clockBusy=false;}
  if(!integer(n)||n<last){fail('FAILED','CLOCK_UNAVAILABLE');no('CLOCK_UNAVAILABLE');}last=n;return n;
 }
 function check(){
  if(failure)no('POST_TERMINAL_DISPATCH_REFUSED');
  if(sealed)no('POST_TERMINAL_DISPATCH_REFUSED');
  if(isAborted(ports.signal)){fail('INCOMPLETE','CANCELED');no('CANCELED');}
  const n=now();if(failure||sealed)no('POST_TERMINAL_DISPATCH_REFUSED');
  if(isAborted(ports.signal)){fail('INCOMPLETE','CANCELED');no('CANCELED');}
  if(n>=deadline){fail('INCOMPLETE','OBSERVATION_DEADLINE');no('OBSERVATION_DEADLINE');}
  if(active&&n>=active.call_deadline_ms){fail('INCOMPLETE','CALL_OBSERVATION_DEADLINE');no('CALL_OBSERVATION_DEADLINE');}return n;
 }
 function snapshot(){return freezeData({schema:'SQUIRE_BLACKJACK_CONTROLLER_RESULT_V1',run_id:spec.run_id,status:failure?.status??checkpoint??'INCOMPLETE',reason:failure?.reason??(checkpoint?null:'SOURCE_CONTROLLER_READY'),terminal_phase:failure?.phase??phase,accounting:{run_id:spec.run_id,start_timestamp_ms:start,deadline_timestamp_ms:deadline,cleanup_reserve_ms:30000,model_invocations_reserved:modelReserved,model_invocations_completed:modelCompleted,native_jobs_reserved:nativeReserved,native_jobs_completed:nativeCompleted,rejected_attempts_count:rejected,wallclock_elapsed_ms:last-start,current_phase:phase,active_reservation:active?{...active}:null},interpretation_receipt:interpretation,stage_receipt:stage,export_receipt:exported,task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted:false,operator_admitted:false,workspace_disposition:!failure&&checkpoint?'DEDICATED_NOT_REUSED':'QUARANTINED',descendant_guarantee:'NONE',direct_child_invocations:{model_invocations:0,native_jobs:0}});}
 // An await may return after logical cancellation. Keep operation-owned data alive until settlement.
 async function io(fn){check();const v=await fn();check();return v;}
 async function readExact(path,expected,mode){
  let h;try{
   directory(await io(()=>fs.lstat(dirname(path))),uid,true);
   const before=await io(()=>fs.lstat(path));regular(before,uid,mode,expected.length);
   check();h=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);check();const opened=await io(()=>h.stat());regular(opened,uid,mode,expected.length);if(!sameIdentity(before,opened))no('INTERPRETATION_PERSISTENCE_FAILED');
   const b=new Uint8Array(expected.length+1);let offset=0;
   while(offset<b.length){const x=await io(()=>h.read(b,offset,b.length-offset,offset));if(!integer(x.bytesRead)||x.bytesRead>b.length-offset)no('INTERPRETATION_PERSISTENCE_FAILED');if(!x.bytesRead)break;offset+=x.bytesRead;}
   const after=await io(()=>h.stat());regular(after,uid,mode,expected.length);const named=await io(()=>fs.lstat(path));regular(named,uid,mode,expected.length);
   if(offset!==expected.length||!sameIdentity(opened,after)||!sameIdentity(after,named)||hash(b.subarray(0,offset))!==hash(expected))no('INTERPRETATION_PERSISTENCE_FAILED');
  }finally{if(h)await h.close();}
 }
 async function writeExact(path,b){
  let h;try{check();h=await fs.open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);check();let offset=0;
   while(offset<b.length){const r=await io(()=>h.write(b,offset,b.length-offset,offset));if(!integer(r.bytesWritten)||r.bytesWritten<1||r.bytesWritten>b.length-offset)no('INTERPRETATION_PERSISTENCE_FAILED');offset+=r.bytesWritten;}
  }finally{if(h)await h.close();}
  await readExact(path,b,0o600);await io(()=>fs.chmod(path,0o400));await readExact(path,b,0o400);
 }
 function reserve(kind,next){
  check();if(active)no('CONCURRENT_EXECUTION_PROHIBITED');
  const n=check();if(deadline-n<170000){fail('INCOMPLETE','INSUFFICIENT_RUN_WALLCLOCK');no('INSUFFICIENT_RUN_WALLCLOCK');}
  if(kind==='MODEL_CALL'){if(modelReserved>=spec.max_model_invocations){fail('FAILED','MODEL_BUDGET_EXHAUSTED');no('MODEL_BUDGET_EXHAUSTED');}modelReserved++;}
  else{if(nativeReserved>=spec.max_native_jobs){fail('FAILED','NATIVE_BUDGET_EXHAUSTED');no('NATIVE_BUDGET_EXHAUSTED');}nativeReserved++;}
  phase=next;active=Object.freeze({reservation_id:randomUUID(),kind,phase_id:next,reserved_at_ms:n,call_deadline_ms:n+140000});return active;
 }
 async function execute(kind,next,fn,status,fallback){
  const reservation=reserve(kind,next);let cancel=null;
  const work=Promise.resolve().then(async()=>{
   check();try{cancel=clock.schedule(reservation.call_deadline_ms-last,()=>{if(active===reservation&&!failure&&!sealed)fail('INCOMPLETE','CALL_OBSERVATION_DEADLINE');});if(typeof cancel!=='function')throw 0;}catch{fail('FAILED','CLOCK_UNAVAILABLE');no('CLOCK_UNAVAILABLE');}check();
   await fn();check();
   if(kind==='MODEL_CALL')modelCompleted++;else nativeCompleted++;if(status)checkpoint=status;
  }).catch(e=>{if(!failure)fail(safeReason(e,'')==='STAGE_BINDING_MISMATCH'?'STAGING_REJECTED':fallback==='INTERPRETATION_PERSISTENCE_FAILED'?'INTERPRETATION_REJECTED':fallback==='EXPORT_REJECTED'?'FAILED':'GENERATION_REJECTED',safeReason(e,fallback));}).finally(()=>{
   try{cancel?.();if(!failure)check();}catch{if(!failure)fail('FAILED','CLOCK_UNAVAILABLE');}
   if(active===reservation)active=null;pending.delete(work);
  });
  pending.add(work);await Promise.race([work,stopPromise]);return snapshot();
 }
 try{
  start=now();deadline=start+spec.max_cumulative_wallclock_sec*1000;if(!integer(deadline))no('CLOCK_UNAVAILABLE');
  if(ports.signal!==undefined&&(types.isProxy(ports.signal)||!(ports.signal instanceof AbortSignal)))no('PREPARATION_FAILED');
  if(ports.signal)EventTarget.prototype.addEventListener.call(ports.signal,'abort',()=>fail('INCOMPLETE','CANCELED'),{once:true});check();
  cancelRun=clock.schedule(deadline-start,()=>{if(!sealed&&!failure)fail('INCOMPLETE','OBSERVATION_DEADLINE');});if(typeof cancelRun!=='function')no('PREPARATION_FAILED');check();
  const setup=Promise.resolve().then(async()=>{
   // Validate ancestors as observations; never repair existing permissions or create higher parents.
   let path=parse(spec.workspace_root).root;const paths=[path];for(const c of spec.workspace_root.slice(path.length).split('/')){path=join(path,c);paths.push(path);}
   for(const path of paths){const s=await io(()=>fs.lstat(path));directory(s,uid,path===spec.workspace_root);if(path!==spec.workspace_root&&!(((s.uid===0||s.uid===uid)&&(s.mode&0o022)===0)||(s.uid===0&&(s.mode&0o1000)!==0)))no('PREPARATION_FAILED');}
   for(const pin of BLACKJACK_BASE_SOURCE_PINS){const b=byteCopy(await io(()=>ports.readPublicSource(pin.path,pin.bytes)),pin.bytes);if(b.length!==pin.bytes||hash(b)!==pin.sha256)no('PREPARATION_FAILED');}
   const runtime=await io(()=>ports.observeNodeIdentity());closed(runtime,['path','bytes','sha256'],[],'runtime');if(runtime.path!==NODE_RUNTIME.path||runtime.bytes!==NODE_RUNTIME.bytes||runtime.sha256!==NODE_RUNTIME.sha256)no('PREPARATION_FAILED');
   if(await io(()=>ports.retentionReady())!=='READY')no('PREPARATION_FAILED');
  });pending.add(setup);setup.finally(()=>pending.delete(setup)).catch(()=>{});
  const outcome=await Promise.race([setup.then(()=>true),stopPromise.then(()=>false)]);if(!outcome)no('PREPARATION_FAILED');check();
 }catch{try{cancelRun?.();}catch{}no('PREPARATION_FAILED');}
 const simulation=ports.mode==='SOURCE_SIMULATION';
 async function interpretationGate(){
  if(!interpretation||!wireBytes||!receiptBytes)no('INTERPRETATION_ACK_REQUIRED');
  await readExact(interpretation.persisted_path,wireBytes,0o400);await readExact(interpretation.persisted_path+'.receipt.json',receiptBytes,0o400);
  if(interpretation.run_id!==spec.run_id||interpretation.wire_sha256!==hash(wireBytes)||interpretation.wire_bytes!==wireBytes.length)no('INTERPRETATION_ACK_REQUIRED');
 }
 return Object.freeze({
  snapshot,
  poll(){try{check();}catch{}return snapshot();},
  async interpret(){
   check();if(active)no('CONCURRENT_EXECUTION_PROHIBITED');if(phase!==P[0])no('ILLEGAL_PHASE_TRANSITION');
   return execute('MODEL_CALL',P[1],async()=>{
    if(!simulation)no('MODEL_EXECUTION_DISABLED');
    const output=await io(()=>ports.model_provider.interpret(Object.freeze({run_id:spec.run_id,brief_page_sha256:BLACKJACK_BRIEF_SHA256,requested_model:spec.requested_model,effort:spec.effort,deadline_ms:active.call_deadline_ms,signal:abort.signal})));
    const parsed=parseBlackjackInterpretation(output);wireBytes=parsed.bytes;
    const dir=join(spec.workspace_root,'interpretations');await io(()=>fs.mkdir(dir,{recursive:false,mode:0o700}));directory(await io(()=>fs.lstat(dir)),uid,true);
    const path=join(dir,parsed.wire.interpretation_id+'.json');await writeExact(path,wireBytes);const stamp=check();if(stamp<1)no('INTERPRETATION_PERSISTENCE_FAILED');
    const receipt=freezeData({schema_version:'squire.blackjack_interpretation_receipt.v1',run_id:spec.run_id,phase_id:P[1],operation_id:active.reservation_id,caller_label:'blackjack_phase_controller',interpretation_id:parsed.wire.interpretation_id,wire_sha256:parsed.sha256,wire_bytes:wireBytes.length,persisted_path:path,persisted_bytes:wireBytes.length,persistence_acknowledgement:'ACKNOWLEDGED',provenance_authenticity:'NOT_ESTABLISHED',crash_durability:'NOT_ESTABLISHED',host_timestamp_ms:stamp});
    receiptBytes=canonicalBytes(receipt);await writeExact(path+'.receipt.json',receiptBytes);interpretation=receipt;
   },null,'INTERPRETATION_PERSISTENCE_FAILED');
  },
  async implement(){
   check();if(active)no('CONCURRENT_EXECUTION_PROHIBITED');if(!interpretation){fail('INTERPRETATION_REJECTED','INTERPRETATION_ACK_REQUIRED');no('INTERPRETATION_ACK_REQUIRED');}
   if(phase!==P[1])no('ILLEGAL_PHASE_TRANSITION');
   return execute('MODEL_CALL',P[2],async()=>{
    await interpretationGate();if(!simulation)no('INCOMPATIBLE_GENERATION_PROFILE');
    // Only explicit injected source simulations may pass this seam. No production PR177 adapter is wired.
    const value=await io(()=>ports.model_provider.dispatchCodexTask(Object.freeze({run_id:spec.run_id,interpretation_receipt:interpretation,deadline_ms:active.call_deadline_ms,generation_wall_ms:120000,outer_observation_ms:140000,signal:abort.signal})));
    closed(value,['result','stage_root'],[],'candidate');const returnedStageRoot=value.stage_root;if(returnedStageRoot!==join(spec.workspace_root,'candidate','stage'))no('INVALID_CANDIDATE_RESULT');
    const r=value.result;closed(r,['schema','status','reason','generation','staging','task_correctness','task_outcome_evaluated','runtime_admitted','workspace_disposition','descendant_guarantee','operator_admitted','operator_receipt','direct_child_invocations','outer_observation_target_ms','event_loop_condition'],[],'candidate_result');
    if(r.schema!=='SQUIRE2_PROJECT_RESULT_V1'||r.status!=='CANDIDATE_STAGED'||r.task_correctness!=='NOT_EVALUATED'||r.task_outcome_evaluated!==false||r.runtime_admitted!==false||r.descendant_guarantee!=='NONE')no('INVALID_CANDIDATE_RESULT');
    closed(r.generation,['record'],['diagnosticReport','diagnostic_retention'],'generation');const record=validateLimitedJobRecord(r.generation.record);
    if(record.task_class!=='PROJECT_CODEGEN_V1'||record.lifecycle_status!=='LIMITED_SUCCESS')no('INVALID_CANDIDATE_RESULT');
    const custody=Object.freeze({...record.output_custody});
    const ackKeys=['schema_version','completion_status','stage_operation_id','caller_label','manifest_sha256','file_count','total_bytes','operation_acknowledgement','provenance_authenticity','crash_durability'];
    closed(r.staging,ackKeys,[],'stage_ack');const stageAck=Object.freeze(Object.fromEntries(ackKeys.map(k=>[k,r.staging[k]])));
    if(custody.path!==join(spec.workspace_root,'candidate','candidate-envelope.json'))no('INVALID_CANDIDATE_RESULT');
    const manifest=byteCopy(await io(()=>ports.readCandidateEnvelope(custody.path,1048576)),1048576);
    if(manifest.length!==custody.byte_count)no('INVALID_CANDIDATE_RESULT');await readExact(custody.path,manifest,0o400);
    const decoded=validateProjectPayloadJson(manifest);let expected;
    try{expected=planStaging({stage_operation_id:stageAck.stage_operation_id,caller_label:stageAck.caller_label,files:decoded.files.map(f=>({path:f.path,classification:f.classification,content:f.content}))});}finally{for(const f of decoded.files)f.content.fill(0);}
    const v=await io(()=>verifyStage(returnedStageRoot,{fs,uid,signal:abort.signal}));
    if(expected.manifest_sha256!==stageAck.manifest_sha256||v.status!=='VERIFIED'||stageAck.schema_version!=='squire4.stage_receipt.v1'||stageAck.completion_status!=='COMPLETE'||stageAck.operation_acknowledgement!=='ACKNOWLEDGED'||stageAck.provenance_authenticity!=='NOT_ESTABLISHED'||stageAck.crash_durability!=='NOT_ESTABLISHED'||['stage_operation_id','caller_label','manifest_sha256','file_count','total_bytes'].some(k=>v[k]!==stageAck[k]))no('STAGE_BINDING_MISMATCH');
    stage=stageAck;stageRoot=returnedStageRoot;
   },'CANDIDATE_STAGED','INVALID_CANDIDATE_RESULT');
  },
  rejectNative(kind){check();if(active)no('CONCURRENT_EXECUTION_PROHIBITED');if(!stage)no('ILLEGAL_PHASE_TRANSITION');if(!['logic','gui','grading'].includes(kind))no('ILLEGAL_PHASE_TRANSITION');reserve('NATIVE_JOB',kind==='logic'?P[3]:P[4]);fail('UNQUALIFIED_NATIVE_REJECTED','UNQUALIFIED_NATIVE_EXECUTION_REJECTED');no('UNQUALIFIED_NATIVE_EXECUTION_REJECTED');},
  async packageCandidate(){
   check();if(active)no('CONCURRENT_EXECUTION_PROHIBITED');if(!stage||phase!==P[2])no('ILLEGAL_PHASE_TRANSITION');
   // No observed evidence ports exist in this source-only slice; export candidate files only.
   const reviewed=await execute('MODEL_CALL',P[5],async()=>{if(!simulation)no('MODEL_EXECUTION_DISABLED');const r=await io(()=>ports.model_provider.review(Object.freeze({run_id:spec.run_id,stage_manifest_sha256:stage.manifest_sha256,deadline_ms:active.call_deadline_ms,signal:abort.signal})));closed(r,['status','stage_manifest_sha256'],[],'review');if(r.status!=='SOURCE_REVIEW_COMPLETE'||r.stage_manifest_sha256!==stage.manifest_sha256)no('EXPORT_REJECTED');},null,'EXPORT_REJECTED');
   if(failure)return reviewed;
   return execute('NATIVE_JOB',P[5],async()=>{const ack=await io(()=>buildExport({export_operation_id:'export-'+spec.run_id,caller_label:'blackjack_phase_controller',stage_dir:stageRoot,export_dir:join(spec.workspace_root,'export'),stage_manifest_sha256:stage.manifest_sha256,evidence_files:[]},{fs,uid,signal:abort.signal}));const v=await io(()=>verifyExport(join(spec.workspace_root,'export'),{fs,uid,signal:abort.signal}));if(v.status!=='VERIFIED'||v.manifest_sha256!==ack.manifest_sha256)no('EXPORT_REJECTED');exported=ack;},'EXPORT_PACKAGED','EXPORT_REJECTED');
  },
  finish(){
   check();if(active)no('CONCURRENT_EXECUTION_PROHIBITED');sealed=true;
   try{cancelRun?.();}catch{sealed=false;fail('FAILED','CLOCK_UNAVAILABLE');sealed=true;}
   // No call to fallible user callbacks can leave a late cancellation as success.
   if(!failure&&isAborted(ports.signal)){sealed=false;fail('INCOMPLETE','CANCELED');sealed=true;}
   try{if(now()>=deadline&&!failure){sealed=false;fail('INCOMPLETE','OBSERVATION_DEADLINE');sealed=true;}}catch{sealed=false;fail('FAILED','CLOCK_UNAVAILABLE');sealed=true;}
   if(!failure&&isAborted(ports.signal)){sealed=false;fail('INCOMPLETE','CANCELED');sealed=true;}
   return snapshot();
  }
 });
}
