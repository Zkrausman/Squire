import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BLACKJACK_BRIEF_SHA256,BLACKJACK_BASE,BLACKJACK_PHASES,validateBlackjackSpec,parseBlackjackInterpretation} from '../src/blackjack-contract.mjs';
import {prepareBlackjackController} from '../src/blackjack-controller.mjs';
import {NODE_RUNTIME,canonicalBytes,hash} from '../src/bounded-codegen-plan.mjs';
import {planStaging,writeStage} from '../src/multifile-staging.mjs';
import {blackjackControllerDryRun,blackjackControllerEntrypointMode} from '../acceptance/blackjack-controller-entrypoint.mjs';
const source=dirname(dirname(fileURLToPath(import.meta.url))),enc=s=>new TextEncoder().encode(s);
const match=code=>e=>e?.code===code;
const validWire=()=>({schema:'SQUIRE_BLACKJACK_INTERPRETATION_WIRE_V1',interpretation_id:randomUUID(),brief_page_sha256:BLACKJACK_BRIEF_SHA256,concept_summary:'A public synthetic autonomous design. '.repeat(3),blackjack_mechanic_integration:'Public synthetic explanation of cards and risk. '.repeat(3),shooter_combat_loop:'Public synthetic explanation of controls and combat. '.repeat(3),visual_and_audio_aesthetic:'Public synthetic scribble presentation. '.repeat(2),rule_set_specification:'Public synthetic description of chosen rules and replay. '.repeat(3),planned_file_manifest:['src/game.mjs','README.md'],verification_strategy:'Public synthetic verification strategy and important transitions. '.repeat(2)});
function spec(root){return {schema:'SQUIRE_BLACKJACK_CONTROLLER_SPEC_V1',run_id:randomUUID(),workspace_root:root,source_commit:BLACKJACK_BASE.commit,source_tree:BLACKJACK_BASE.tree,requested_model:'synthetic-codex',effort:'xhigh',max_cumulative_wallclock_sec:2400,cleanup_reserve_ms:30000,max_model_invocations:10,max_native_jobs:3,max_live_owned_processes:8,per_call_generation_wall_ms:120000,per_call_observation_wall_ms:140000};}
function fakeClock(){let n=100;const timers=[];return {timers,setSilent:v=>{n=v;},now:()=>n,schedule:(delay,fn)=>{const t={at:n+delay,fn,canceled:false};timers.push(t);return()=>{t.canceled=true;};},set(v){n=v;for(const t of [...timers])if(!t.canceled&&t.at<=n){t.canceled=true;t.fn();}}};}
async function owned(fn){const root=await fs.mkdtemp(join(tmpdir(),'squire-blackjack-source-'));try{await fs.chmod(root,0o700);await fn(root);}finally{await fs.rm(root,{recursive:true,force:true});}}
async function candidate(root){
 const dir=join(root,'candidate');await fs.mkdir(dir,{mode:0o700});
 const envelope=enc(JSON.stringify({schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',files:[{path:'src/game.mjs',classification:'SOURCE',encoding:'utf-8',content:'export const syntheticOnly = true;\n'}]}));
 const path=join(dir,'candidate-envelope.json');await fs.writeFile(path,envelope,{flag:'wx',mode:0o600});await fs.chmod(path,0o400);
 const stage=await writeStage(planStaging({stage_operation_id:'source-test',caller_label:'source-test',files:[{path:'src/game.mjs',classification:'SOURCE',content:enc('export const syntheticOnly = true;\n')}]}),join(dir,'stage'),{fs,uid:process.getuid()});
 const record={job_id:randomUUID(),task_class:'PROJECT_CODEGEN_V1',lifecycle_status:'LIMITED_SUCCESS',requested_model:'synthetic-codex',reported_model:'UNKNOWN',process_exit:{pid:123,exit_code:0,exit_signal:null,process_wall_ms:1,observed_termination:true},io_state:{stdout_bytes_observed:envelope.length,stderr_bytes_observed:0,stdout_eof:true,stderr_eof:true,io_drained:true},containment_evidence:{containment_level:'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',settlement_status:'SETTLED_DIRECT_CHILD_EXIT',descendant_guarantee:'NONE'},provider_metadata:{provider_reported_status:'turn.completed',duration_seconds:null,usage_tokens:{input:0,output:0,cache_read:0,thinking:'UNKNOWN',total:'UNKNOWN'},codex_reasoning_output_tokens:'UNKNOWN'},output_custody:{persisted:true,path,byte_count:envelope.length,persistence_error:null},task_outcome_evaluated:false,task_payload_valid:true,error_details:{code:null,classification:null,message:null}};
 return {result:{schema:'SQUIRE2_PROJECT_RESULT_V1',status:'CANDIDATE_STAGED',reason:null,generation:{record},staging:stage,task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted:false,workspace_disposition:'DEDICATED_NOT_REUSED',descendant_guarantee:'NONE',operator_admitted:false,operator_receipt:'synthetic-only',direct_child_invocations:{generation:1},outer_observation_target_ms:140000,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP'},stage_root:join(dir,'stage')};
}
function ports(root,overrides={}){const clock=fakeClock(),calls=[];const p={fs,uid:process.getuid(),clock,mode:'SOURCE_SIMULATION',readPublicSource:(path)=>fs.readFile(join(source,...(['src/project-task.mjs','src/project-configuration.mjs','src/project-runner.mjs','docs/project-candidates.md'].includes(path)?['test/fixtures/blackjack-pr177-baseline',path.split('/').at(-1)+'.txt']:[path]))).then(b=>new Uint8Array(b)),observeNodeIdentity:()=>({...NODE_RUNTIME}),retentionReady:()=> 'READY',readCandidateEnvelope:path=>fs.readFile(path).then(b=>new Uint8Array(b)),model_provider:{interpret:async()=>{calls.push('interpret');return enc(JSON.stringify(validWire()));},dispatchCodexTask:async()=>{calls.push('candidate');return candidate(root);},review:async x=>{calls.push('review');return {status:'SOURCE_REVIEW_COMPLETE',stage_manifest_sha256:x.stage_manifest_sha256};}},...overrides};return {p,calls,clock};}
async function ready(root,override={}){const a=ports(root,override),c=await prepareBlackjackController(spec(root),a.p);return {...a,c};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('closed controller spec enforces immutable baseline, finite explicit ceilings and fixed call clocks',()=>{
 const s=spec('/public/synthetic');assert.ok(Object.isFrozen(validateBlackjackSpec(s)));
 for(const patch of [{per_call_generation_wall_ms:240000},{per_call_observation_wall_ms:240000}])assert.throws(()=>validateBlackjackSpec({...s,...patch}),match('INVALID_CALL_CLOCK'));
 for(const patch of [{max_cumulative_wallclock_sec:2401},{max_model_invocations:11},{cleanup_reserve_ms:0},{workspace_root:'/x/../y'},{source_tree:'0'.repeat(40)},{extra:true},{requested_model:''}])assert.throws(()=>validateBlackjackSpec({...s,...patch}));
 assert.throws(()=>validateBlackjackSpec(new Proxy(s,{})));
});
test('interpretation is closed, bounded, duplicate-aware, brief-bound and preserves autonomous prose',()=>{
 const w=validWire(),b=enc(JSON.stringify(w)),r=parseBlackjackInterpretation(b);assert.equal(r.wire.concept_summary,w.concept_summary);assert.equal(hash(r.bytes),r.sha256);
 for(const s of ['{}','{"schema":"x","schema":"y"}',JSON.stringify({...w,brief_page_sha256:'0'.repeat(64)}),JSON.stringify({...w,concept_summary:'x'}),JSON.stringify({...w,concept_summary:'x'.repeat(2049)}),JSON.stringify({...w,planned_file_manifest:['../x']}),JSON.stringify({...w,planned_file_manifest:['a','A']}),JSON.stringify({...w,verification_strategy:'\ud800'.repeat(100)}),JSON.stringify({...w,extra:true}),JSON.stringify({...w,rule_set_specification:'x\ny'.repeat(50)})])assert.throws(()=>parseBlackjackInterpretation(enc(s)),match('INVALID_INTERPRETATION_WIRE'));
 assert.throws(()=>parseBlackjackInterpretation(new Uint8Array(65537)));
});
test('preparation checks public pins, workspace ownership, runtime observation and READY without dispatch',async()=>owned(async root=>{
 const {c,calls}=await ready(root);assert.deepEqual(calls,[]);const r=c.snapshot();assert.equal(r.runtime_admitted,false);assert.equal(r.direct_child_invocations.model_invocations,0);assert.equal(r.accounting.deadline_timestamp_ms-r.accounting.start_timestamp_ms,2400000);c.finish();
}));
test('preparation rejects mismatched source, runtime, retention and unsafe workspace; no repair',async()=>{
 for(const patch of [{readPublicSource:()=>enc('wrong')},{observeNodeIdentity:()=>({...NODE_RUNTIME,sha256:'0'.repeat(64)})},{retentionReady:()=> 'UNKNOWN'},{fs:{...fs,lstat:async path=>{const s=await fs.lstat(path);if(path.includes('squire-blackjack-source-'))return {...s,isDirectory:()=>true,isSymbolicLink:()=>false,uid:process.getuid()+1};return s;}}}])await owned(async root=>{const a=ports(root,patch);await assert.rejects(prepareBlackjackController(spec(root),a.p),match('PREPARATION_FAILED'));assert.deepEqual(a.calls,[]);});
});
test('host interpretation ACK is physically verified before candidate dispatch and receipt remains private',async()=>owned(async root=>{
 const {c,calls}=await ready(root);await c.interpret();const r=c.snapshot(),ack=r.interpretation_receipt;assert.equal(ack.persistence_acknowledgement,'ACKNOWLEDGED');assert.equal(ack.provenance_authenticity,'NOT_ESTABLISHED');assert.equal((await fs.stat(ack.persisted_path)).mode&0o777,0o400);assert.equal(hash(await fs.readFile(ack.persisted_path)),ack.wire_sha256);assert.equal(JSON.stringify(r).includes('synthetic autonomous design'),false);
 const staged=await c.implement();assert.equal(staged.status,'CANDIDATE_STAGED');assert.deepEqual(calls,['interpret','candidate']);assert.equal(staged.task_correctness,'NOT_EVALUATED');assert.equal(staged.accounting.model_invocations_reserved,2);assert.equal(staged.accounting.model_invocations_completed,2);assert.equal(staged.stage_receipt.operation_acknowledgement,'ACKNOWLEDGED');assert.equal(staged.export_receipt,null);assert.deepEqual(staged.direct_child_invocations,{model_invocations:0,native_jobs:0});c.finish();
}));
test('missing host ACK or model self-report cannot satisfy interpretation gate; failure is permanent',async()=>owned(async root=>{
 const {c,calls}=await ready(root);await assert.rejects(c.implement(),match('INTERPRETATION_ACK_REQUIRED'));assert.equal(c.snapshot().status,'INTERPRETATION_REJECTED');await assert.rejects(c.interpret(),match('POST_TERMINAL_DISPATCH_REFUSED'));assert.deepEqual(calls,[]);
}));
test('invalid interpretation self-report rejects with safe diagnostics and no candidate',async()=>owned(async root=>{
 const {c}=await ready(root,{model_provider:{interpret:async()=>enc('{"interpretation_complete":true,"secret":"PRIVATE"}')}});const r=await c.interpret();assert.equal(r.status,'INTERPRETATION_REJECTED');assert.equal(r.reason,'INVALID_INTERPRETATION_WIRE');assert.equal(r.accounting.model_invocations_reserved,1);assert.equal(r.interpretation_receipt,null);assert.equal(JSON.stringify(r).includes('PRIVATE'),false);await assert.rejects(c.implement(),match('POST_TERMINAL_DISPATCH_REFUSED'));
}));
test('tampered or substituted host wire/receipt prevents implementation without codegen',async()=>{
 for(const suffix of ['', '.receipt.json'])await owned(async root=>{const {c,calls}=await ready(root);await c.interpret();const path=c.snapshot().interpretation_receipt.persisted_path+suffix;await fs.chmod(path,0o600);await fs.writeFile(path,'tampered');await fs.chmod(path,0o400);const r=await c.implement();assert.notEqual(r.status,'CANDIDATE_STAGED');assert.deepEqual(calls,['interpret']);assert.equal(r.accounting.model_invocations_reserved,2);});
});
test('exclusive interpretation persistence refuses collisions and retains original files',async()=>owned(async root=>{
 const {c}=await ready(root);await fs.mkdir(join(root,'interpretations'),{mode:0o700});await fs.writeFile(join(root,'interpretations','sentinel'),'keep');const r=await c.interpret();assert.equal(r.status,'INTERPRETATION_REJECTED');assert.equal(await fs.readFile(join(root,'interpretations','sentinel'),'utf8'),'keep');assert.equal(r.interpretation_receipt,null);
}));
test('default model path is inert; caller Boolean cannot qualify desktop generation',async()=>owned(async root=>{
 const {c,calls}=await ready(root,{mode:'NATIVE',gui_admitted:true,operator_admitted:true});const r=await c.interpret();assert.equal(r.reason,'MODEL_EXECUTION_DISABLED');assert.deepEqual(calls,[]);assert.equal(r.runtime_admitted,false);
}));
test('generation rejection consumes reservations with no refund, repeat or reset',async()=>owned(async root=>{
 const a=ports(root);a.p.model_provider.dispatchCodexTask=async()=>{throw Error('PRIVATE_BODY');};const c=await prepareBlackjackController(spec(root),a.p);await c.interpret();const r=await c.implement();assert.equal(r.status,'GENERATION_REJECTED');assert.equal(r.accounting.model_invocations_reserved,2);assert.equal(r.accounting.rejected_attempts_count,1);assert.equal(JSON.stringify(r).includes('PRIVATE_BODY'),false);await assert.rejects(c.implement(),match('POST_TERMINAL_DISPATCH_REFUSED'));assert.equal(c.snapshot().accounting.model_invocations_reserved,2);
}));
test('one active reservation blocks reentrant and concurrent model/native operations',async()=>owned(async root=>{
 const a=ports(root);let release,entered=false;a.p.model_provider.interpret=async()=>{entered=true;return new Promise(resolve=>{release=resolve;});};const c=await prepareBlackjackController(spec(root),a.p),task=c.interpret();while(!entered)await flush();await assert.rejects(c.interpret(),match('CONCURRENT_EXECUTION_PROHIBITED'));assert.throws(()=>c.rejectNative('gui'),match('CONCURRENT_EXECUTION_PROHIBITED'));assert.equal(c.snapshot().accounting.model_invocations_reserved,1);release(enc(JSON.stringify(validWire())));await task;c.finish();
}));
test('deadline dispatch boundary includes 30-second cleanup reserve, refusal consumes no extra call',async()=>owned(async root=>{
 const {c,clock,calls}=await ready(root);clock.set(100+2400000-169999);await assert.rejects(c.interpret(),match('INSUFFICIENT_RUN_WALLCLOCK'));assert.deepEqual(calls,[]);assert.equal(c.snapshot().accounting.model_invocations_reserved,0);assert.equal(c.snapshot().status,'INCOMPLETE');
}));
test('exact 170000ms remaining permits fixed 140000ms observation with cleanup reserve',async()=>owned(async root=>{
 const {c,clock}=await ready(root);clock.set(100+2400000-170000);await c.interpret();assert.equal(c.snapshot().accounting.model_invocations_reserved,1);assert.equal(c.snapshot().interpretation_receipt.persistence_acknowledgement,'ACKNOWLEDGED');c.finish();
}));
test('pending operation times out passively; no late ACK, success promotion or same-run repair',async()=>owned(async root=>{
 const a=ports(root);let release,entered=false;a.p.model_provider.interpret=async()=>{entered=true;return new Promise(resolve=>{release=resolve;});};const c=await prepareBlackjackController(spec(root),a.p),task=c.interpret();while(!entered)await flush();a.clock.set(140100);const r=await task;assert.equal(r.status,'INCOMPLETE');assert.equal(r.reason,'CALL_OBSERVATION_DEADLINE');assert.equal(r.interpretation_receipt,null);release(enc(JSON.stringify(validWire())));await flush();assert.equal(c.snapshot().status,'INCOMPLETE');assert.equal(c.snapshot().accounting.model_invocations_reserved,1);assert.equal(c.snapshot().interpretation_receipt,null);await assert.rejects(c.implement(),match('POST_TERMINAL_DISPATCH_REFUSED'));
}));
test('already-aborted preparation and reentrant abort during source read dispatch nothing',async()=>{
 for(const already of [true,false])await owned(async root=>{const abort=new AbortController(),a=ports(root,{signal:abort.signal});if(already)abort.abort();else a.p.readPublicSource=async path=>{abort.abort();return new Uint8Array(await fs.readFile(join(source,path)));};await assert.rejects(prepareBlackjackController(spec(root),a.p),match('PREPARATION_FAILED'));assert.deepEqual(a.calls,[]);});
});
test('source-only GUI/logic/grading reject without invoking supplied native functions',async()=>{
 for(const kind of ['logic','gui','grading'])await owned(async root=>{let dispatched=0;const {c}=await ready(root,{native_job:{dispatchNativeJob(){dispatched++;}},gui_admitted:true});await c.interpret();await c.implement();assert.throws(()=>c.rejectNative(kind),match('UNQUALIFIED_NATIVE_EXECUTION_REJECTED'));const r=c.snapshot();assert.equal(r.status,'UNQUALIFIED_NATIVE_REJECTED');assert.equal(r.accounting.native_jobs_reserved,1);assert.equal(r.accounting.native_jobs_completed,0);assert.equal(dispatched,0);await assert.rejects(c.packageCandidate(),match('POST_TERMINAL_DISPATCH_REFUSED'));});
});
test('source review and actual owned export ACK remain separate from observed evidence and correctness',async()=>owned(async root=>{
 const {c,calls}=await ready(root);await c.interpret();const staged=await c.implement();const r=await c.packageCandidate();assert.equal(r.status,'EXPORT_PACKAGED');assert.deepEqual(calls,['interpret','candidate','review']);assert.equal(r.accounting.model_invocations_reserved,3);assert.equal(r.accounting.native_jobs_reserved,1);assert.equal(r.export_receipt.operation_acknowledgement,'ACKNOWLEDGED');assert.equal(r.export_receipt.stage_binding.stage_manifest_sha256,staged.stage_receipt.manifest_sha256);assert.equal(r.task_outcome_evaluated,false);assert.equal(r.runtime_admitted,false);assert.deepEqual(await fs.readdir(join(root,'export')),['export-manifest.json','project']);c.finish();
}));
test('stage tamper or synthetic evidence classifications cannot be promoted to genuine stage ACK',async()=>{
 for(const tamper of ['stage','envelope'])await owned(async root=>{const a=ports(root);a.p.model_provider.dispatchCodexTask=async()=>{const v=await candidate(root);const path=tamper==='stage'?join(v.stage_root,'src/game.mjs'):v.result.generation.record.output_custody.path;await fs.chmod(path,0o600);await fs.writeFile(path,tamper==='stage'?'changed':JSON.stringify({schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',files:[{path:'observed.log',classification:'EVIDENCE_LOG',encoding:'utf-8',content:'not observed'}]}));await fs.chmod(path,0o400);if(tamper==='envelope')v.result.generation.record.output_custody.byte_count=(await fs.stat(path)).size;return v;};const c=await prepareBlackjackController(spec(root),a.p);await c.interpret();const r=await c.implement();assert.notEqual(r.status,'CANDIDATE_STAGED');assert.equal(r.stage_receipt,null);assert.equal(r.workspace_disposition,'QUARANTINED');});
});
test('workspace and run reservations are permanent in memory after failure or completion',async()=>owned(async root=>{
 const a=ports(root),s=spec(root),c=await prepareBlackjackController(s,a.p);c.finish();await assert.rejects(prepareBlackjackController({...s,run_id:randomUUID()},a.p),match('WORKSPACE_ALREADY_CONSUMED'));await owned(async other=>assert.rejects(prepareBlackjackController({...s,workspace_root:other},ports(other).p),match('WORKSPACE_ALREADY_CONSUMED')));
}));
test('native default entrypoint exposes no activation mode or fabricated observed acceptance',()=>{
 for(const args of [[],['--run-admitted','config','admission'],['--gui-admitted']])assert.equal(blackjackControllerEntrypointMode(args),'DRY_RUN_NATIVE_DISABLED');const r=blackjackControllerDryRun();assert.equal(r.direct_child_invocations,0);assert.equal(r.runtime_admitted,false);assert.equal(r.task_correctness,'NOT_EVALUATED');
});
test('clock failure is sanitized and cannot reenter dispatch or fabricate success',async()=>owned(async root=>{
 const a=ports(root);const c=await prepareBlackjackController(spec(root),a.p);a.p.clock.now=()=>{throw Error('PRIVATE_CLOCK');};assert.equal(c.poll().reason,'CLOCK_UNAVAILABLE');assert.equal(JSON.stringify(c.snapshot()).includes('PRIVATE_CLOCK'),false);await assert.rejects(c.interpret(),match('POST_TERMINAL_DISPATCH_REFUSED'));
}));

test('classless interpretation manifest supports fifty portable distinct paths without SOURCE-only quota',()=>{
 const w=validWire();w.planned_file_manifest=Array.from({length:50},(_,i)=>'files/part'+i+'.txt');assert.equal(parseBlackjackInterpretation(enc(JSON.stringify(w))).wire.planned_file_manifest.length,50);w.planned_file_manifest.push('files/extra.txt');assert.throws(()=>parseBlackjackInterpretation(enc(JSON.stringify(w))));
});
test('finish rechecks abort after its last fallible clock callback and cannot seal success',async()=>owned(async root=>{
 const abort=new AbortController(),{c,p,clock}=await ready(root,{signal:abort.signal});await c.interpret();await c.implement();const now=clock.now;let n=0;p.clock.now=()=>{if(++n===2)abort.abort();return now();};const r=c.finish();assert.equal(r.status,'INCOMPLETE');assert.equal(r.reason,'CANCELED');assert.equal(r.stage_receipt.operation_acknowledgement,'ACKNOWLEDGED');assert.equal(r.workspace_disposition,'QUARANTINED');
}));
test('per-call absolute deadline is enforced even if the scheduled timer has not delivered',async()=>owned(async root=>{
 const a=ports(root);a.p.model_provider.interpret=async()=>{a.clock.setSilent(140100);return enc(JSON.stringify(validWire()));};const c=await prepareBlackjackController(spec(root),a.p),r=await c.interpret();assert.equal(r.status,'INCOMPLETE');assert.equal(r.reason,'CALL_OBSERVATION_DEADLINE');assert.equal(r.interpretation_receipt,null);assert.equal(r.accounting.model_invocations_reserved,1);
}));
test('pending open retains handle ownership and closes it after cancellation during read or write',async()=>{
 for(const read of [false,true])await owned(async root=>{const abort=new AbortController(),a=ports(root,{signal:abort.signal});let entered=false,release,closed=0;const gate=new Promise(resolve=>{release=resolve;});a.p.fs={...fs,async open(path,flags,...args){const h=await fs.open(path,flags,...args);if(!entered&&path.endsWith('.json')&&(read?(flags&3)===constants.O_RDONLY:(flags&3)!==constants.O_RDONLY)){entered=true;await gate;return new Proxy(h,{get(t,k){if(k==='close')return async()=>{closed++;return t.close();};const v=t[k];return typeof v==='function'?v.bind(t):v;}});}return h;}};const c=await prepareBlackjackController(spec(root),a.p),task=c.interpret();while(!entered)await flush();abort.abort();const r=await task;assert.equal(r.status,'INCOMPLETE');release();while(!closed)await flush();assert.equal(closed,1);assert.equal(c.snapshot().interpretation_receipt,null);});
});
test('provider-owned stage ACK mutations during await cannot export raw fields or change binding',async()=>owned(async root=>{
 const a=ports(root);let ack;a.p.model_provider.dispatchCodexTask=async()=>{const v=await candidate(root);ack={...v.result.staging};v.result.staging=ack;return v;};a.p.readCandidateEnvelope=async path=>{ack.privateRaw='PRIVATE_RESPONSE';ack.caller_label='mutated';return new Uint8Array(await fs.readFile(path));};const c=await prepareBlackjackController(spec(root),a.p);await c.interpret();const r=await c.implement();assert.equal(r.status,'CANDIDATE_STAGED');assert.equal(r.stage_receipt.caller_label,'source-test');assert.equal(JSON.stringify(r).includes('PRIVATE_RESPONSE'),false);assert.equal(Object.hasOwn(r.stage_receipt,'privateRaw'),false);c.finish();
}));
test('model ceiling is prospective and failure to reserve another call permanently stops without refund',async()=>owned(async root=>{
 const a=ports(root),s={...spec(root),max_model_invocations:1},c=await prepareBlackjackController(s,a.p);await c.interpret();await assert.rejects(c.implement(),match('MODEL_BUDGET_EXHAUSTED'));assert.equal(c.snapshot().accounting.model_invocations_reserved,1);assert.equal(c.snapshot().reason,'MODEL_BUDGET_EXHAUSTED');assert.deepEqual(a.calls,['interpret']);
}));
test('clock regression, synchronous scheduler expiry and callback errors fail closed without source dispatch',async()=>{
 await owned(async root=>{const {c,clock}=await ready(root);clock.setSilent(99);assert.equal(c.poll().reason,'CLOCK_UNAVAILABLE');});
 await owned(async root=>{const a=ports(root);a.p.clock.schedule=(delay,fn)=>{fn();return()=>{};};await assert.rejects(prepareBlackjackController(spec(root),a.p),match('PREPARATION_FAILED'));assert.deepEqual(a.calls,[]);});
 await owned(async root=>{const {c,p}=await ready(root);p.clock.schedule=()=>{throw Error('PRIVATE_SCHEDULE');};const r=await c.interpret();assert.equal(r.status,'FAILED');assert.equal(r.reason,'CLOCK_UNAVAILABLE');assert.equal(r.accounting.model_invocations_reserved,1);assert.equal(JSON.stringify(r).includes('PRIVATE_SCHEDULE'),false);});
});
test('readback symlink and hardlink substitutions do not issue interpretation ACK or follow private files',async()=>{
 for(const kind of ['symlink','hardlink'])await owned(async root=>{const a=ports(root);let changed=false;a.p.fs={...fs,async chmod(path,mode){await fs.chmod(path,mode);if(!changed&&path.endsWith('.json')){changed=true;const moved=path+'.saved';await fs.rename(path,moved);if(kind==='symlink')await fs.symlink(moved,path);else await fs.link(moved,path);}}};const c=await prepareBlackjackController(spec(root),a.p),r=await c.interpret();assert.equal(r.status,'INTERPRETATION_REJECTED');assert.equal(r.interpretation_receipt,null);});
});
test('rejecting error proxy is never inspected and cannot cause secondary raw failure',async()=>owned(async root=>{
 let traps=0;const a=ports(root);a.p.model_provider.interpret=async()=>{throw new Proxy({},{getPrototypeOf(){traps++;throw Error('PRIVATE_PROXY');},get(){traps++;throw Error('PRIVATE_PROXY');}});};const c=await prepareBlackjackController(spec(root),a.p),r=await c.interpret();assert.equal(r.status,'INTERPRETATION_REJECTED');assert.equal(r.reason,'INTERPRETATION_PERSISTENCE_FAILED');assert.equal(traps,0);assert.equal(JSON.stringify(r).includes('PRIVATE_PROXY'),false);
}));
