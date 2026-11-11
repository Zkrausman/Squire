import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {buildProjectCodegenPrompt} from '../src/project-task.mjs';
import {GENERATION_SHUTDOWN} from '../src/bounded-codegen-plan.mjs';
import {runProjectCodexTask,runProjectCodexTaskWithPhysicalEvidence} from '../src/project-runner.mjs';
import {projectPhysicalEvidenceConfigSha256,preparePhysicalJobEvidence,verifyProjectPhysicalJobEvidence,unknownPhysicalJobEvidence} from '../src/project-physical-job-evidence.mjs';

const enc=s=>new TextEncoder().encode(s);
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
let serial=1;const id=()=> '8d9ee341-6fa3-4acc-8b93-'+String(serial++).padStart(12,'0');
const MODEL='mock-project-model',EFFORT='mock-project-effort';
const authorization={operator_receipt:'/synthetic/operator.json',supported_tuples:[{model:MODEL,effort:EFFORT}]};
const request={schema:'SQUIRE2_PROJECT_REQUEST_V1',task_id:'synthetic',task_prompt:'Public synthetic project instructions.',runtime_target:'node24-esm',stage_target:'multifile-candidate'};
const response=JSON.stringify({schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',files:[{path:'src/index.mjs',classification:'SOURCE',encoding:'utf-8',content:'export const synthetic = 1;\n'}]});
const stream=()=>enc([{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:response}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:3,cached_input_tokens:0,reasoning_output_tokens:1}}].map(e=>JSON.stringify(e)).join('\n')+'\n');
function runtime(mode='normal',raw=stream(),stderrData=null){
 let time=0;const timers=[],calls=[],kills=[];const controller=new AbortController(),child=new EventEmitter();child.pid=123;child.unref=()=>{};child.kill=s=>{kills.push(s);return true;};
 for(const k of ['stdout','stderr','stdin']){child[k]=new EventEmitter();child[k].destroy=()=>{};}
 child.stdin.write=(b,callback)=>{callback();return true;};
 child.stdin.end=callback=>{callback();if(mode!=='pending')queueMicrotask(()=>{child.stdout.emit('data',raw);child.stdout.emit('end');if(stderrData)child.stderr.emit('data',stderrData);if(mode!=='missing-eof')child.stderr.emit('end');child.emit('exit',mode==='nonzero'?3:0,null);});};
 const clock={now:()=>time,schedule(delay,fn){const t={at:time+delay,fn,active:true};timers.push(t);return()=>{t.active=false;};}};
 return {clock,controller,calls,kills,timers,spawn(...args){calls.push(args);queueMicrotask(()=>child.emit('spawn'));return child;},async advance(n){time=n;for(const t of [...timers].sort((a,b)=>a.at-b.at))if(t.active&&t.at<=time){t.active=false;t.fn();}await flush();},child};
}
async function fixture(fn){const root=await fs.mkdtemp('/tmp/squire-physical-evidence-fixture-');await fs.chmod(root,0o700);const evidence=join(root,'evidence');await fs.mkdir(evidence,{mode:0o700});try{return await fn(root,evidence);}finally{await fs.rm(root,{recursive:true,force:true});}}
function inputs(root,evidence,rt){const spec={job_id:id(),task_scope:root,requested_model:MODEL,effort:EFFORT,max_wall_clock_sec:120,prompt_bytes:buildProjectCodegenPrompt(request)},options={clock:rt.clock,shutdown:GENERATION_SHUTDOWN,abortSignal:rt.controller.signal},ports={fs,uid:process.getuid(),spawn:rt.spawn,executable:'/synthetic/codex',codex:{observed_cli_version:'0.160.0',authorization,permissions:{sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'}},environment:{PUBLIC:'synthetic'}};return {spec,options,ports,evidenceSpec:{root:evidence,operation_config_sha256:projectPhysicalEvidenceConfigSha256(spec)}};}

test('one synthetic physical attempt publishes bounded raw streams and offline integrity, without changing result',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.result.status,'CANDIDATE_STAGED');assert.equal(out.evidence.status,'ACKNOWLEDGED');assert.equal(rt.calls.length,1);
 assert.equal(JSON.stringify(out.evidence).includes(root),false);assert.equal(JSON.stringify(out.evidence).includes(a.spec.job_id),false);
 const attempt=join(evidence,'attempts',a.spec.job_id);const manifest=JSON.parse(await fs.readFile(join(attempt,'manifest.json'),'utf8'));
 assert.equal(manifest.streams.stdout.flag,'COMPLETE');assert.equal(manifest.streams.stderr.bytes,0);
 assert.equal(manifest.stage.acknowledgement,'ACKNOWLEDGED');assert.equal(manifest.process_exit.observed_termination,true);
 assert.equal((await verifyProjectPhysicalJobEvidence(attempt,out.evidence.manifest_sha256)).status,'PHYSICAL_EVIDENCE_COPY_VERIFIED');
 await fs.writeFile(join(attempt,'stdout.bin'),enc('corrupt'));
 await assert.rejects(verifyProjectPhysicalJobEvidence(attempt,out.evidence.manifest_sha256));
}));

test('wrong supplied config rejects before spawn or reservation',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,{...a.evidenceSpec,operation_config_sha256:'0'.repeat(64)});
 assert.equal(out.result,null);assert.equal(out.evidence.status,'UNKNOWN');assert.equal(rt.calls.length,0);
 assert.deepEqual(await fs.readdir(evidence),[]);
}));

test('public UNKNOWN projection rejects arbitrary private reason text',()=>{
 const projection=unknownPhysicalJobEvidence('/private/task/secret.txt: raw provider error');
 assert.equal(projection.status,'UNKNOWN');assert.equal(projection.reason,'EVIDENCE_IO_UNKNOWN');
 assert.equal(JSON.stringify(projection).includes('/private/'),false);
});

test('preflight realpath failure is fixed-code UNKNOWN before any spawn',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt);a.ports.fs={...fs,async realpath(){throw Error('/private/task/secret.txt: synthetic EACCES');}};
 const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.result,null);assert.equal(out.evidence.status,'UNKNOWN');assert.equal(out.evidence.reason,'EVIDENCE_IO_UNKNOWN');
 assert.equal(rt.calls.length,0);assert.equal(JSON.stringify(out).includes('/private/'),false);
}));

test('reserved duplicate job ID rejects before another spawn',async()=>fixture(async(root,evidence)=>{
 const first=runtime(),a=inputs(root,evidence,first),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);assert.equal(out.evidence.status,'ACKNOWLEDGED');
 const next=runtime(),b=inputs(root,evidence,next);b.spec.job_id=a.spec.job_id;b.evidenceSpec.operation_config_sha256=projectPhysicalEvidenceConfigSha256(b.spec);
 const second=await runProjectCodexTaskWithPhysicalEvidence(b.spec,b.options,b.ports,b.evidenceSpec);assert.equal(second.evidence.status,'UNKNOWN');assert.equal(next.calls.length,0);
}));

test('conservative cutoff returns UNKNOWN without claiming unsettled child or raw ACK',async()=>fixture(async(root,evidence)=>{
 const rt=runtime('pending'),a=inputs(root,evidence,rt),pending=runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 while(!rt.calls.length)await new Promise(resolve=>setImmediate(resolve));await rt.advance(140000);
 const out=await pending;assert.equal(out.evidence.status,'UNKNOWN');assert.ok(out.result===null||out.result.generation?.record.containment_evidence.descendant_guarantee==='NONE');
 assert.ok(rt.kills.length>0);rt.child.emit('exit',0,null);
}));

test('missing stderr EOF cannot be promoted to complete retained stream evidence',async()=>fixture(async(root,evidence)=>{
 const rt=runtime('missing-eof'),a=inputs(root,evidence,rt),pending=runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 while(!rt.calls.length)await new Promise(resolve=>setImmediate(resolve));await rt.advance(140000);
 const out=await pending;assert.equal(out.evidence.status,'UNKNOWN');assert.equal(out.evidence.manifest_sha256,null);
 assert.equal((await fs.readdir(join(evidence,'attempts',a.spec.job_id))).includes('manifest.json'),false);
}));

test('sixteen concurrent exclusive slots admit at most sixteen and burn interrupted reservations',async()=>fixture(async(root,evidence)=>{
 const attempts=Array.from({length:17},()=>{const rt=runtime(),a=inputs(root,evidence,rt);return preparePhysicalJobEvidence(a.evidenceSpec,a.spec,a.ports,new AbortController().signal);});
 const results=await Promise.allSettled(attempts);assert.equal(results.filter(r=>r.status==='fulfilled').length,16);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal((await fs.readdir(join(evidence,'slots'))).length,16);
 assert.equal((await fs.readdir(join(evidence,'attempts'))).length,16);
}));

test('sixteen retained attempts exhaust capacity even if slot metadata is incomplete',async()=>fixture(async(root,evidence)=>{
 const attempts=join(evidence,'attempts'),slots=join(evidence,'slots');await fs.mkdir(attempts,{mode:0o700});await fs.mkdir(slots,{mode:0o700});
 for(let i=0;i<16;i++){const job=`8d9ee341-6fa3-4acc-8b93-${String(i).padStart(12,'0')}`;await fs.mkdir(join(attempts,job),{mode:0o700});}
 const rt=runtime(),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.result,null);assert.equal(out.evidence.status,'UNKNOWN');assert.equal(rt.calls.length,0);
 assert.deepEqual(await fs.readdir(slots),[]);
}));

test('zero-spawn failure records ABSENT streams without inventing exit or stage ACK',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt);a.ports.spawn=()=>{throw Error('synthetic spawn failure');};
 const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.result.direct_child_invocations.generation,1);assert.equal(out.result.staging,null);
 assert.equal(out.evidence.status,'ACKNOWLEDGED');const m=JSON.parse(await fs.readFile(join(evidence,'attempts',a.spec.job_id,'manifest.json'),'utf8'));
 assert.equal(m.streams.stdout.flag,'ABSENT');assert.equal(m.stage,null);
 assert.notEqual(m.settlement_status,'SETTLED_DIRECT_CHILD_EXIT');
}));

test('offline verifier rejects a relocated attempt under another valid job ID, including zero-spawn',async()=>{
 for(const zeroSpawn of [false,true])await fixture(async(root,evidence)=>{
  const rt=runtime(),a=inputs(root,evidence,rt);if(zeroSpawn)a.ports.spawn=()=>{throw Error('synthetic spawn failure');};
  const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
  assert.equal(out.evidence.status,'ACKNOWLEDGED');
  const original=join(evidence,'attempts',a.spec.job_id),moved=join(evidence,'attempts',id());
  await fs.rename(original,moved);
  await assert.rejects(verifyProjectPhysicalJobEvidence(moved,out.evidence.manifest_sha256));
 });
});

test('wrong result job binding cannot publish a manifest or claim an ACK',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 const next=runtime(),b=inputs(root,evidence,next),session=await preparePhysicalJobEvidence(b.evidenceSpec,b.spec,b.ports,new AbortController().signal);
 const wrong={...out.result,generation:{...out.result.generation,record:{...out.result.generation.record,job_id:a.spec.job_id}}};
 const status=await session.publish(wrong,new AbortController().signal);
 assert.equal(status.status,'UNKNOWN');assert.equal(status.reason,'EVIDENCE_BINDING_REJECTED');
 assert.deepEqual(await fs.readdir(session.attempt_dir),[]);
}));

test('non-abortable result writer can finish after cutoff but cannot publish a late manifest or ACK',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt);let entered,release;
 const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
 a.ports.fs={...fs,async open(path,...args){if(path.endsWith('/result.json')){entered();await held;}return fs.open(path,...args);}};
 const pending=runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 await started;await rt.advance(140000);const out=await pending;
 assert.equal(out.result.status,'CANDIDATE_STAGED');assert.equal(out.evidence.status,'UNKNOWN');
 release();for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
 const attempt=join(evidence,'attempts',a.spec.job_id);
 assert.equal((await fs.readdir(attempt)).includes('manifest.json'),false);
}));

test('result receipt write fault retains partial evidence and reports UNKNOWN without a final manifest',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt);a.ports.fs={...fs,async open(path,...args){if(path.endsWith('/result.json'))throw Object.assign(Error('synthetic result writer fault'),{code:'EIO'});return fs.open(path,...args);}};
 const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.result.status,'CANDIDATE_STAGED');assert.equal(out.evidence.status,'UNKNOWN');assert.equal(out.evidence.manifest_sha256,null);
 assert.deepEqual(await fs.readdir(join(evidence,'attempts',a.spec.job_id)),['stderr.bin','stdout.bin']);
}));

test('stream leaf write, close and readback faults retain partial evidence without manifest ACK',async()=>{
 for(const [leaf,point] of [['stdout.bin','write'],['stderr.bin','close'],['stdout.bin','readback']])await fixture(async(root,evidence)=>{
  const rt=runtime(),a=inputs(root,evidence,rt);a.ports.fs={...fs,async open(path,flags,...args){
   if(path.endsWith('/'+leaf)&&point==='readback'&&flags===(constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK))throw Error('synthetic stream readback fault');
   const h=await fs.open(path,flags,...args);
   if(path.endsWith('/'+leaf)&&point==='write'&&flags!==(constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK))return {stat:h.stat.bind(h),async writeFile(bytes){await h.writeFile(bytes);throw Error('synthetic stream write fault');},close:h.close.bind(h)};
   if(path.endsWith('/'+leaf)&&point==='close'&&flags!==(constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK))return {stat:h.stat.bind(h),writeFile:h.writeFile.bind(h),async close(){await h.close();throw Error('synthetic stream close fault');}};
   return h;
  }};
  const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
  assert.equal(out.evidence.status,'UNKNOWN');assert.equal(out.evidence.manifest_sha256,null);
  assert.equal((await fs.readdir(join(evidence,'attempts',a.spec.job_id))).includes('manifest.json'),false);
 });
});

test('private attempt mode drift during publication cannot earn a manifest acknowledgement',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt),attempt=join(evidence,'attempts',a.spec.job_id);let changed=false;
 a.ports.fs={...fs,async open(path,...args){if(!changed&&path.endsWith('/stdout.bin')){changed=true;await fs.chmod(attempt,0o755);}return fs.open(path,...args);}};
 const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.result.status,'CANDIDATE_STAGED');assert.equal(out.evidence.status,'UNKNOWN');assert.equal(out.evidence.manifest_sha256,null);
 assert.equal((await fs.readdir(attempt)).includes('manifest.json'),false);
}));

test('offline verifier rejects a self-hashed manifest that misstates the validated record',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.evidence.status,'ACKNOWLEDGED');const attempt=join(evidence,'attempts',a.spec.job_id),path=join(attempt,'manifest.json');
 const m=JSON.parse(await fs.readFile(path,'utf8'));m.record_status='LIMITED_SPAWN_FAILED';
 const bytes=Buffer.from(JSON.stringify(m)+'\n'),sha=createHash('sha256').update(bytes).digest('hex');await fs.writeFile(path,bytes);
 await assert.rejects(verifyProjectPhysicalJobEvidence(attempt,sha));
}));

test('stdout over cap retains only bounded prefix and never claims complete raw capture',async()=>fixture(async(root,evidence)=>{
 const rt=runtime('normal',new Uint8Array(1048577)),a=inputs(root,evidence,rt);
 const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.result.status,'GENERATION_REJECTED');assert.equal(out.evidence.status,'ACKNOWLEDGED');
 const attempt=join(evidence,'attempts',a.spec.job_id),m=JSON.parse(await fs.readFile(join(attempt,'manifest.json'),'utf8'));
 assert.equal(m.streams.stdout.bytes,1048576);assert.equal(m.streams.stdout.flag,'PREFIX_OVERFLOW');
 assert.equal((await fs.stat(join(attempt,'stdout.bin'))).size,1048576);
}));

test('stderr exact cap remains complete and one byte over retains only a flagged prefix',async()=>{
 for(const [size,expected] of [[65536,'COMPLETE'],[65537,'PREFIX_OVERFLOW']])await fixture(async(root,evidence)=>{
  const rt=runtime('normal',stream(),new Uint8Array(size)),a=inputs(root,evidence,rt);
  const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
  assert.equal(out.evidence.status,'ACKNOWLEDGED');
  const m=JSON.parse(await fs.readFile(join(evidence,'attempts',a.spec.job_id,'manifest.json'),'utf8'));
  assert.equal(m.streams.stderr.bytes,65536);assert.equal(m.streams.stderr.flag,expected);
 });
});

test('stdout exact cap is complete without a false overflow flag',async()=>fixture(async(root,evidence)=>{
 const rt=runtime('normal',new Uint8Array(1048576)),a=inputs(root,evidence,rt);
 const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.evidence.status,'ACKNOWLEDGED');const m=JSON.parse(await fs.readFile(join(evidence,'attempts',a.spec.job_id,'manifest.json'),'utf8'));
 assert.equal(m.streams.stdout.bytes,1048576);assert.equal(m.streams.stdout.flag,'COMPLETE');
}));

test('nonzero direct-child exit and parser failure remain distinct inspectable outcomes',async()=>{
 for(const [mode,raw] of [['nonzero',stream()],['normal',enc('not jsonl\n')]])await fixture(async(root,evidence)=>{
  const rt=runtime(mode,raw),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
  assert.equal(out.result.status,'GENERATION_REJECTED');assert.equal(out.evidence.status,'ACKNOWLEDGED');
  const m=JSON.parse(await fs.readFile(join(evidence,'attempts',a.spec.job_id,'manifest.json'),'utf8'));
  assert.equal(m.stage,null);assert.equal(m.streams.stdout.flag,'COMPLETE');
  if(mode==='nonzero')assert.equal(m.process_exit.exit_code,3);
  else assert.notEqual(m.record_status,'LIMITED_SUCCESS');
 });
});

test('zero usage stays distinct from UNKNOWN usage in private validated records',async()=>{
 const zero=enc([{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:response}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:0,cached_input_tokens:0,reasoning_output_tokens:0}}].map(e=>JSON.stringify(e)).join('\n')+'\n');
 for(const raw of [zero,enc('not jsonl\n')])await fixture(async(root,evidence)=>{
  const rt=runtime('normal',raw),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
  assert.equal(out.evidence.status,'ACKNOWLEDGED');const m=JSON.parse(await fs.readFile(join(evidence,'attempts',a.spec.job_id,'manifest.json'),'utf8'));
  if(raw===zero){assert.equal(m.usage_tokens.input,0);assert.equal(m.usage_tokens.output,0);}
  else {assert.equal(m.usage_tokens.input,'UNKNOWN');assert.equal(m.usage_tokens.output,'UNKNOWN');}
 });
});

test('stage failure and envelope persistence failure retain physical attempt without stage ACK',async()=>{
 for(const fault of ['stage','envelope'])await fixture(async(root,evidence)=>{
  const rt=runtime(),a=inputs(root,evidence,rt);a.ports.fs={...fs,
   async mkdir(path,...args){const value=await fs.mkdir(path,...args);if(fault==='stage'&&path.endsWith('run-'+a.spec.job_id))await fs.mkdir(join(path,'stage'),{mode:0o700});return value;},
   async open(path,...args){if(fault==='envelope'&&path.endsWith('/candidate-envelope.json'))throw Error('synthetic persistence fault');return fs.open(path,...args);}
  };
  const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
  assert.equal(out.evidence.status,'ACKNOWLEDGED');assert.equal(out.result.staging,null);
  assert.equal(out.result.status,fault==='stage'?'STAGING_REJECTED':'GENERATION_REJECTED');
  const m=JSON.parse(await fs.readFile(join(evidence,'attempts',a.spec.job_id,'manifest.json'),'utf8'));assert.equal(m.stage,null);
 });
});

test('preflight rejects an existing attempt over aggregate cap before another spawn',async()=>fixture(async(root,evidence)=>{
 const attempts=join(evidence,'attempts'),slots=join(evidence,'slots');await fs.mkdir(attempts,{mode:0o700});await fs.mkdir(slots,{mode:0o700});
 const old=join(attempts,id());await fs.mkdir(old,{mode:0o700});
 await fs.writeFile(join(old,'stdout.bin'),Buffer.alloc(1572865),{mode:0o600});
 const rt=runtime(),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 assert.equal(out.result,null);assert.equal(out.evidence.status,'UNKNOWN');assert.equal(rt.calls.length,0);
 assert.deepEqual(await fs.readdir(slots),[]);
}));

test('stage identity and hash mismatch withhold publication',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 for(const changed of [{stage_operation_id:'stage-'+id()},{manifest_sha256:'x'.repeat(64)}]){
  const next=runtime(),b=inputs(root,evidence,next),session=await preparePhysicalJobEvidence(b.evidenceSpec,b.spec,b.ports,new AbortController().signal);
  const result={...out.result,staging:{...out.result.staging,...changed},generation:{...out.result.generation,record:{...out.result.generation.record,job_id:b.spec.job_id}}};
  const status=await session.publish(result,new AbortController().signal);
  assert.equal(status.status,'UNKNOWN');assert.equal(status.reason,'EVIDENCE_BINDING_REJECTED');assert.deepEqual(await fs.readdir(session.attempt_dir),[]);
 }
}));

test('manifest close and readback faults retain partial leaves but never return an ACK',async()=>{
 for(const point of ['close','readback'])await fixture(async(root,evidence)=>{
  const rt=runtime(),a=inputs(root,evidence,rt);a.ports.fs={...fs,async open(path,flags,...args){
   if(path.endsWith('/manifest.json')&&point==='readback'&&flags===(constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK))throw Error('synthetic readback failure');
   const h=await fs.open(path,flags,...args);
   if(path.endsWith('/manifest.json')&&point==='close'&&flags!==(constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK))return {stat:h.stat.bind(h),writeFile:h.writeFile.bind(h),async close(){await h.close();throw Error('synthetic close failure');}};
   return h;
  }};
  const out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
  assert.equal(out.evidence.status,'UNKNOWN');assert.equal(out.evidence.manifest_sha256,null);
  assert.equal((await fs.readdir(join(evidence,'attempts',a.spec.job_id))).includes('manifest.json'),true);
 });
});

test('late in-flight manifest write cannot promote caller UNKNOWN to an ACK',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt);let entered,release;const started=new Promise(r=>{entered=r;}),held=new Promise(r=>{release=r;});
 a.ports.fs={...fs,async open(path,...args){if(path.endsWith('/manifest.json')){entered();await held;}return fs.open(path,...args);}};
 const pending=runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
 await started;await rt.advance(140000);const out=await pending;
 assert.equal(out.result.status,'CANDIDATE_STAGED');assert.equal(out.evidence.status,'UNKNOWN');assert.equal(out.evidence.manifest_sha256,null);
 release();for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await fs.readdir(join(evidence,'attempts',a.spec.job_id))).includes('manifest.json'),true);
}));

test('offline verifier rejects linked leaves and private-root mode drift',async()=>{
 for(const variant of ['symlink','hardlink','root-mode'])await fixture(async(root,evidence)=>{
  const rt=runtime(),a=inputs(root,evidence,rt),out=await runProjectCodexTaskWithPhysicalEvidence(a.spec,a.options,a.ports,a.evidenceSpec);
  assert.equal(out.evidence.status,'ACKNOWLEDGED');const attempt=join(evidence,'attempts',a.spec.job_id),leaf=join(attempt,'stdout.bin');
  if(variant==='symlink'){const copy=join(root,'copy');await fs.rename(leaf,copy);await fs.symlink(copy,leaf);}
  if(variant==='hardlink')await fs.link(leaf,join(root,'other-link'));
  if(variant==='root-mode')await fs.chmod(evidence,0o755);
  await assert.rejects(verifyProjectPhysicalJobEvidence(attempt,out.evidence.manifest_sha256));
 });
});

test('ordinary project route retains its existing result envelope without an evidence field',async()=>fixture(async(root,evidence)=>{
 const rt=runtime(),a=inputs(root,evidence,rt),out=await runProjectCodexTask(a.spec,a.options,a.ports);
 assert.equal(out.schema,'SQUIRE2_PROJECT_RESULT_V1');assert.equal(out.status,'CANDIDATE_STAGED');
 assert.equal(Object.hasOwn(out,'evidence'),false);assert.equal(rt.calls.length,1);
 assert.deepEqual(await fs.readdir(evidence),[]);
}));
