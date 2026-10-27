import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {projectProjectRunSummary,formatProjectSummaryTerminal,projectNativeProjectRunSummary,formatNativeProjectSummaryTerminal} from '../src/project-summary.mjs';
import {createNativeProjectResultReceipt,writeNativeProjectResultReceipt,createProjectResultReceipt,writeProjectResultReceipt} from '../src/project-result-receipt.mjs';
import {runOfflineReportCli,readReceiptBytes} from '../bin/squire-report.mjs';
import {REPORT_MAX_BYTES,parseReceiptJson} from '../src/offline-run-summary.mjs';

const jobId='ba586107-7240-4d89-88d3-d71005bce32f';
const digest='a'.repeat(64);
const envelopeSchema='SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1';
const invalidText='Squire native offline project result: INVALID_RECEIPT\nDiagnostic: SCHEMA_MISMATCH\n';
const encode=value=>new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value));
// Every producer-shaped record in this suite is synthetic and injected; no native entrypoint is invoked.
function record(lifecycle='LIMITED_SUCCESS'){
  const success=lifecycle==='LIMITED_SUCCESS',timed=['LIMITED_TIMEOUT','LIMITED_USER_ABORT'].includes(lifecycle);
  return {
    job_id:jobId,task_class:'PROJECT_CODEGEN_V1',lifecycle_status:lifecycle,
    requested_model:'gpt-6-luna',reported_model:'PRIVATE_MODEL_SENTINEL',
    process_exit:{pid:success?41:null,exit_code:success?0:timed?null:1,exit_signal:null,process_wall_ms:0,observed_termination:!timed},
    io_state:{stdout_bytes_observed:success?100:0,stderr_bytes_observed:0,stdout_eof:true,stderr_eof:true,io_drained:true},
    containment_evidence:{containment_level:'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',settlement_status:success||!timed?'SETTLED_DIRECT_CHILD_EXIT':'ABANDONED_UNSETTLED',descendant_guarantee:'NONE'},
    provider_metadata:{provider_reported_status:success?'turn.completed':timed?'turn.failed':'ERROR',duration_seconds:null,usage_tokens:{input:0,output:8,cache_read:0,thinking:'UNKNOWN',total:'UNKNOWN'}},
    output_custody:{persisted:success,path:'/PRIVATE_SENTINEL/envelope.json',byte_count:success?100:null,persistence_error:null},
    task_outcome_evaluated:false,task_payload_valid:success?true:false,
    error_details:{code:null,classification:null,message:null}
  };
}
function generation(lifecycle='LIMITED_SUCCESS'){
  return {
    record:record(lifecycle),
    runtime_evidence:{deadline_ms:120000,timeout_latched:false,abort_latched:false,signal_attempts:[],event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',workspace_reuse:'NOT_AUTHORIZED',workspace_disposition:lifecycle==='LIMITED_SUCCESS'?'DEDICATED_NOT_REUSED':'QUARANTINED',max_steps:'UNSUPPORTED'},
    diagnostic_retention:{retention_status:'NOT_REQUESTED',rejection_stage:null,rejection_reason:null,exact_response_bytes:null,retained_bytes_count:null,retained_truncated:false,retention_error:null}
  };
}
function ack(){
  return {schema_version:'squire4.stage_receipt.v1',stage_operation_id:`stage-${jobId}`,caller_label:'project_candidate_stager',completion_status:'COMPLETE',manifest_sha256:digest,file_count:1,total_bytes:0,operation_acknowledgement:'ACKNOWLEDGED',provenance_authenticity:'NOT_ESTABLISHED',crash_durability:'NOT_ESTABLISHED'};
}
function result(operatorAdmitted=false,status='CANDIDATE_STAGED',reason=null,gen=generation(),count=1,staging=ack()){
  return {schema:'SQUIRE2_PROJECT_RESULT_V1',status,reason,generation:gen,staging,task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted:false,operator_admitted:operatorAdmitted,workspace_disposition:status==='CANDIDATE_STAGED'?'DEDICATED_NOT_REUSED':'QUARANTINED',descendant_guarantee:'NONE',operator_receipt:'/PRIVATE_SENTINEL/operator-receipt',direct_child_invocations:{generation:count},outer_observation_target_ms:140000,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP'};
}
function envelope(value){return {schema:envelopeSchema,result:value};}
function clone(value){return structuredClone(value);}
async function cliBytes(bytes){
  let out='',err='',stats=0,reads=0;
  const code=await runOfflineReportCli(['/PRIVATE_SENTINEL/native.json'],{
    stat:async()=>{stats++;return {isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length};},
    readFile:async()=>{reads++;return bytes;},
    stdout:{write:value=>{out+=value;}},stderr:{write:value=>{err+=value;}}
  });
  return {code,out,err,stats,reads};
}
async function owned(run){
  const directory=await fs.mkdtemp(join(tmpdir(),'squire-native-result-'));
  await fs.chmod(directory,0o700);
  try{await run(directory);}finally{await fs.rm(directory,{recursive:true,force:true});}
}
function ports(io=fs){return {fs:{lstat:io.lstat.bind(io),open:io.open.bind(io)},uid:process.getuid()};}
function statData(stat,changes={}){
  return {dev:changes.dev??stat.dev,ino:changes.ino??stat.ino,uid:changes.uid??stat.uid,nlink:changes.nlink??stat.nlink,mode:changes.mode??stat.mode,size:changes.size??stat.size,mtimeMs:changes.mtimeMs??stat.mtimeMs,ctimeMs:changes.ctimeMs??stat.ctimeMs,isFile:()=>stat.isFile(),isDirectory:()=>stat.isDirectory(),isSymbolicLink:()=>stat.isSymbolicLink()};
}
function wrappedHandle(handle,{writeFile,read,close,stat}={}){
  let stats=0;
  return {
    async stat(){const value=await handle.stat();return stat?stat(value,stats++):value;},
    async writeFile(bytes){return writeFile?writeFile(handle,bytes):handle.writeFile(bytes);},
    async read(...args){return read?read(handle,...args):handle.read(...args);},
    async close(){return close?close(handle):handle.close();}
  };
}
function controlledFs({open,lstat}={}){
  return {
    async lstat(path,...args){const value=await fs.lstat(path,...args);return lstat?lstat(path,value):value;},
    async open(path,...args){const handle=await fs.open(path,...args);return open?open(path,handle):handle;}
  };
}

test('explicit native envelope preserves both actual admission booleans without authority',()=>{
  for(const claim of [false,true]){
    const live=result(claim);
    const summary=projectNativeProjectRunSummary(envelope(live));
    assert.equal(summary.schema_version,'squire3.native_project_summary.v1');
    assert.equal(summary.operator_admission_claimed,claim);
    assert.equal(summary.admission_authority,'NOT_ESTABLISHED');
    assert.equal(summary.runtime_admitted_marker,false);
    assert.equal(summary.task_correctness,'NOT_EVALUATED');
    assert.equal(summary.task_outcome_evaluated,false);
    assert.equal(summary.readiness,'CANDIDATE_STAGED');
    const terminal=formatNativeProjectSummaryTerminal(summary);
    assert.match(terminal,new RegExp(`operator admission claimed: ${claim}`));
    assert.match(terminal,/authority: NOT_ESTABLISHED/);
    assert.doesNotMatch(terminal,/PRIVATE_SENTINEL|PRIVATE_MODEL|ba586107/);
    const legacy=projectProjectRunSummary(live);
    if(claim){
      assert.equal(legacy.readiness,'INVALID_RECEIPT');
      assert.throws(()=>createProjectResultReceipt(live),e=>e.code==='INVALID_RECEIPT');
    }else{
      assert.equal(legacy.readiness,'CANDIDATE_STAGED');
      assert.equal(legacy.operator_admitted_marker,false);
      assert.equal(createProjectResultReceipt(live).operator_admitted,false);
    }
  }
  assert.equal(projectNativeProjectRunSummary(result(true)).readiness,'INVALID_RECEIPT');
  assert.equal(projectNativeProjectRunSummary({schema:envelopeSchema,result:result(true),extra:true}).readiness,'INVALID_RECEIPT');
});

test('legacy projection preserves the supplied original key order and serialized bytes',()=>{
  const summary=projectProjectRunSummary(result(false,'INCOMPLETE','CANCELED',null,0,null));
  assert.deepEqual(Object.keys(summary),[
    'schema_version','readiness','reason','task_correctness','task_outcome_evaluated',
    'runtime_admitted_marker','operator_admitted_marker','has_operator_receipt',
    'workspace_disposition','descendant_guarantee','direct_child_invocations',
    'outer_observation_target_ms','event_loop_condition','generation','staging','diagnostic'
  ]);
  assert.equal(Buffer.from(JSON.stringify(summary)).toString('utf8'),
    '{"schema_version":"squire2.project_summary.v1","readiness":"INCOMPLETE","reason":"CANCELED","task_correctness":"NOT_EVALUATED","task_outcome_evaluated":false,"runtime_admitted_marker":false,"operator_admitted_marker":false,"has_operator_receipt":true,"workspace_disposition":"QUARANTINED","descendant_guarantee":"NONE","direct_child_invocations":{"generation":0},"outer_observation_target_ms":140000,"event_loop_condition":"RESPONSIVE_PARENT_EVENT_LOOP","generation":null,"staging":null,"diagnostic":null}');
  assert.equal(formatProjectSummaryTerminal(summary),[
    'Squire offline project result: INCOMPLETE',
    'Task correctness: NOT_EVALUATED',
    'Task outcome evaluated: false',
    'Reason: CANCELED',
    'Generation: UNKNOWN',
    'Requested model: UNKNOWN; reported model: UNKNOWN',
    'Process exit code: UNKNOWN; wall ms: UNKNOWN; observed termination: UNKNOWN',
    'Provider status: UNKNOWN; provider duration seconds: UNKNOWN; inference duration seconds: UNKNOWN',
    'Tokens: input=UNKNOWN, output=UNKNOWN, cache_read=UNKNOWN, thinking=UNKNOWN, total=UNKNOWN, codex_reasoning_output=UNKNOWN',
    'Envelope custody: persisted=UNKNOWN; bytes=UNKNOWN; SHA-256=UNKNOWN',
    'Staging ACK history: NONE; operation=NONE; files=UNKNOWN; decoded bytes=UNKNOWN; manifest SHA-256=UNKNOWN',
    'Operator receipt present: true; runtime admitted marker: false; operator admitted marker: false',
    'Direct child invocations: generation=0; observation target ms=140000; event loop=RESPONSIVE_PARENT_EVENT_LOOP',
    'Workspace: QUARANTINED; descendant guarantee: NONE',
    'Diagnostic: NONE',
    'Recorded claims only; no task outcome, artifact, authorization, or execution re-verification.'
  ].join('\n')+'\n');
});

test('native saved capture is closed, independent, frozen, and never invokes late observations',()=>{
  for(const claim of [false,true]){
    let invoked=0;
    const live=result(claim);
    live.generation.late_observations=()=>{invoked++;};
    const saved=createNativeProjectResultReceipt(live);
    assert.equal(saved.schema,envelopeSchema);
    assert.deepEqual(Object.keys(saved),['schema','result']);
    assert.equal(saved.result.operator_admitted,claim);
    assert.equal(Object.hasOwn(saved.result.generation,'late_observations'),false);
    assert.equal(Object.isFrozen(saved),true);
    assert.equal(Object.isFrozen(saved.result.generation.record),true);
    live.operator_receipt='MUTATED';
    live.generation.record.requested_model='MUTATED';
    assert.notEqual(saved.result.operator_receipt,'MUTATED');
    assert.equal(invoked,0);
  }
});

test('native capture rejects hostile inputs, nonboolean claims and legacy true before IO',async()=>{
  let callbacks=0,ioCalls=0;
  const io={async lstat(){ioCalls++;},async open(){ioCalls++;}};
  const hostile=[];
  const getter=result();Object.defineProperty(getter,'status',{get(){callbacks++;throw Error('PRIVATE');}});hostile.push(getter);
  const proxy=new Proxy(result(),{ownKeys(){callbacks++;throw Error('PRIVATE');},get(){callbacks++;throw Error('PRIVATE');}});hostile.push(proxy);
  const symbol=result();symbol[Symbol('private')]=1;hostile.push(symbol);
  const extra=result();extra.private='PRIVATE_SENTINEL';hostile.push(extra);
  const cycle=result();cycle.generation.record.error_details.message=cycle;hostile.push(cycle);
  const fn=result();fn.generation.record.hidden=()=>{callbacks++;};hostile.push(fn);
  const lateGetter=result();Object.defineProperty(lateGetter.generation,'late_observations',{get(){callbacks++;return ()=>{};}});hostile.push(lateGetter);
  for(const bad of hostile){
    assert.throws(()=>createNativeProjectResultReceipt(bad),e=>e.code==='INVALID_INPUT'&&e.message==='INVALID_INPUT');
    await assert.rejects(writeNativeProjectResultReceipt(bad,{directory:'/tmp',filename:'x.json'},{fs:io,uid:process.getuid()}),
      e=>e.code==='INVALID_INPUT'&&e.message==='INVALID_INPUT');
  }
  const undefinedClaim=result();
  undefinedClaim.operator_admitted=undefined;
  assert.equal(projectNativeProjectRunSummary(envelope(undefinedClaim)).readiness,'INVALID_RECEIPT');
  assert.throws(()=>createNativeProjectResultReceipt(undefinedClaim),
    e=>e.code==='INVALID_INPUT'&&e.message==='INVALID_INPUT');
  await assert.rejects(
    writeNativeProjectResultReceipt(undefinedClaim,{directory:'/tmp',filename:'undefined.json'},{fs:io,uid:process.getuid()}),
    e=>e.code==='INVALID_INPUT'&&e.message==='INVALID_INPUT'
  );
  for(const claim of [null,0,'true']){
    const bad=result();bad.operator_admitted=claim;
    assert.equal(projectNativeProjectRunSummary(envelope(bad)).readiness,'INVALID_RECEIPT');
    assert.throws(()=>createNativeProjectResultReceipt(bad),
      e=>e.code==='INVALID_RECEIPT'&&e.message==='INVALID_RECEIPT');
    await assert.rejects(
      writeNativeProjectResultReceipt(bad,{directory:'/tmp',filename:'nonboolean.json'},{fs:io,uid:process.getuid()}),
      e=>e.code==='INVALID_RECEIPT'&&e.message==='INVALID_RECEIPT'
    );
  }
  const legacyTrue=result(true);
  assert.throws(()=>createProjectResultReceipt(legacyTrue),e=>e.code==='INVALID_RECEIPT');
  assert.equal(ioCalls,0);
  assert.equal(callbacks,0);
});

test('status and reason matrix accepts every legacy-valid pair with either native claim',()=>{
  const rows=[
    result(false,'CANDIDATE_STAGED',null,generation(),1,ack()),
    result(false,'GENERATION_REJECTED','GENERATION_REJECTED',generation('LIMITED_PROCESS_FAILED'),1,null),
    result(false,'STAGING_REJECTED','STAGING:DESTINATION_ALREADY_EXISTS',generation(),1,null),
    result(false,'INCOMPLETE','GENERATION_REJECTED',generation('LIMITED_TIMEOUT'),0,null),
    result(false,'INCOMPLETE','CANCELED',null,0,null),
    result(false,'INCOMPLETE','OBSERVATION_DEADLINE',generation('LIMITED_USER_ABORT'),0,null),
    result(false,'FAILED','OPERATION_FAILED_OR_UNCERTAIN',null,0,null),
    result(false,'FAILED','CLEANUP_FAILED_OR_UNCERTAIN',generation(),1,ack()),
    result(false,'FAILED','CLOCK_UNAVAILABLE',generation(),1,ack())
  ];
  for(const claim of [false,true]){
    for(const template of rows){
      const live=clone(template);
      live.operator_admitted=claim;
      const saved=createNativeProjectResultReceipt(live);
      const summary=projectNativeProjectRunSummary(saved);
      assert.equal(summary.readiness,live.status);
      assert.equal(summary.operator_admission_claimed,claim);
    }
  }
  const bad=result(true);bad.status='GENERATION_REJECTED';bad.reason='GENERATION_REJECTED';
  bad.generation.record.lifecycle_status='LIMITED_SPAWN_FAILED';
  bad.generation.record.process_exit={pid:null,exit_code:null,exit_signal:null,process_wall_ms:0,observed_termination:false};
  bad.generation.record.containment_evidence.settlement_status='UNKNOWN';
  bad.generation.record.output_custody={persisted:false,path:null,byte_count:null,persistence_error:null};
  bad.generation.record.task_payload_valid=false;
  bad.generation.runtime_evidence.workspace_disposition='QUARANTINED';
  bad.direct_child_invocations.generation=0;
  assert.equal(projectNativeProjectRunSummary(envelope(bad)).readiness,'INVALID_RECEIPT');
  const contradicted=result(true);contradicted.direct_child_invocations.generation=0;
  assert.equal(projectNativeProjectRunSummary(envelope(contradicted)).readiness,'INVALID_RECEIPT');
});

test('formatter accepts a changed boolean claim and rejects nonboolean claims and forged fields',()=>{
  const valid=projectNativeProjectRunSummary(envelope(result(true)));
  const bad=[];
  for(const mutate of [
    s=>{s.schema_version='squire2.project_summary.v1';},
    s=>{s.operator_admission_claimed='false';},
    s=>{s.admission_authority='ESTABLISHED';},
    s=>{s.runtime_admitted_marker=true;},
    s=>{s.private_path='/PRIVATE_SENTINEL';},
    s=>{s.staging=null;},
    s=>{s.generation.runtime_evidence.max_steps='PRIVATE';},
    s=>{s.readiness='INVALID_RECEIPT';},
    s=>{s.direct_child_invocations.generation=0;}
  ]){const value=clone(valid);mutate(value);bad.push(value);}
  for(const value of bad)assert.equal(formatNativeProjectSummaryTerminal(value),invalidText);
  const alternateClaim=clone(valid);
  alternateClaim.operator_admission_claimed=false;
  assert.match(formatNativeProjectSummaryTerminal(alternateClaim),/operator admission claimed: false/);
  assert.equal(formatNativeProjectSummaryTerminal({
    schema_version:'squire3.native_project_summary.v1',readiness:'INVALID_RECEIPT',
    diagnostic:{stage:'RECEIPT_VALIDATION',reason:'SCHEMA_MISMATCH'}
  }),invalidText);
  assert.equal(formatNativeProjectSummaryTerminal({schema_version:'squire3.native_project_summary.v1',readiness:'CANDIDATE_STAGED'}),
    invalidText);
  assert.equal(formatNativeProjectSummaryTerminal(projectNativeProjectRunSummary(envelope(result(true,{status:'INCOMPLETE'})))),
    invalidText);
});

test('CLI uses only the explicit native envelope schema, reports both claims, and never returns success',async()=>{
  for(const claim of [false,true]){
    const saved=createNativeProjectResultReceipt(result(claim));
    const report=await cliBytes(encode(saved));
    assert.equal(report.code,1);
    assert.equal(report.err,'');
    assert.equal(report.stats,1);
    assert.equal(report.reads,1);
    assert.match(report.out,new RegExp(`operator admission claimed: ${claim}`));
    assert.match(report.out,/NOT_ESTABLISHED/);
    assert.doesNotMatch(report.out,/PRIVATE_SENTINEL|PRIVATE_MODEL|ba586107/);
  }
  const wrong=await cliBytes(encode(result(true)));
  assert.equal(wrong.code,2);
  assert.equal(wrong.err,'SCHEMA_MISMATCH\n');
  const malformed=await cliBytes(encode({schema:envelopeSchema,result:result(true),hidden:'PRIVATE_SENTINEL'}));
  assert.equal(malformed.code,2);
  assert.equal(malformed.err,'SCHEMA_MISMATCH\n');
  assert.doesNotMatch(malformed.out+malformed.err,/PRIVATE_SENTINEL/);
});

test('native adverse and cleanup-after-ACK claims roundtrip through private writer, reader, API and CLI',async()=>{
  const cases=[
    result(false,'GENERATION_REJECTED','GENERATION_REJECTED',generation('LIMITED_PROCESS_FAILED'),1,null),
    result(false,'FAILED','CLEANUP_FAILED_OR_UNCERTAIN',generation(),1,ack())
  ];
  await owned(async directory=>{
    for(const claim of [false,true]){
      for(let index=0;index<cases.length;index++){
        const live=clone(cases[index]);
        live.operator_admitted=claim;
        const filename=`roundtrip-${claim}-${index}.json`;
        const acknowledgement=await writeNativeProjectResultReceipt(live,{directory,filename},ports());
        const path=join(directory,filename);
        const bytes=await readReceiptBytes(path);
        assert.equal(bytes.length,acknowledgement.byte_count);
        assert.equal(createHash('sha256').update(bytes).digest('hex'),acknowledgement.sha256);
        const saved=parseReceiptJson(bytes);
        const summary=projectNativeProjectRunSummary(saved);
        assert.equal(summary.readiness,live.status);
        assert.equal(summary.operator_admission_claimed,claim);
        assert.equal(summary.admission_authority,'NOT_ESTABLISHED');
        assert.equal(summary.generation.provider_metadata.usage_tokens.thinking,null);
        assert.equal(summary.generation.provider_metadata.usage_tokens.total,null);
        assert.equal(summary.staging!==null,index===1);
        const terminal=formatNativeProjectSummaryTerminal(summary);
        assert.match(terminal,/thinking=UNKNOWN, total=UNKNOWN/);
        assert.doesNotMatch(terminal,/PRIVATE_SENTINEL|PRIVATE_MODEL|ba586107/);
        const report=await cliBytes(bytes);
        assert.equal(report.code,1);
        assert.equal(report.err,'');
        assert.match(report.out,new RegExp(`operator admission claimed: ${claim}`));
        assert.doesNotMatch(report.out,/PRIVATE_SENTINEL|PRIVATE_MODEL|ba586107/);
      }
    }
  });
});

test('new writer records the complete envelope, preserves the source, and uses bounded exclusive private IO',async()=>{
  await owned(async directory=>{
    for(const claim of [false,true]){
      const live=result(claim),before=JSON.stringify(live);
      const ackReceipt=await writeNativeProjectResultReceipt(live,{directory,filename:`${claim}.json`},ports());
      assert.deepEqual(Object.keys(ackReceipt),['schema','status','byte_count','sha256','crash_durability','source_authenticity']);
      assert.equal(ackReceipt.schema,'squire3.native_project_result_write_receipt.v1');
      assert.equal(ackReceipt.status,'RECORDED');
      assert.equal(ackReceipt.crash_durability,'NOT_ESTABLISHED');
      assert.equal(ackReceipt.source_authenticity,'NOT_ESTABLISHED');
      assert.equal(JSON.stringify(live),before);
      const bytes=await fs.readFile(join(directory,`${claim}.json`));
      assert.equal(bytes.length,ackReceipt.byte_count);
      assert.ok(bytes.length<=REPORT_MAX_BYTES);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),ackReceipt.sha256);
      const saved=parseReceiptJson(bytes);
      assert.equal(saved.schema,envelopeSchema);
      assert.equal(saved.result.operator_admitted,claim);
      assert.equal(projectNativeProjectRunSummary(saved).operator_admission_claimed,claim);
      assert.equal((await fs.stat(join(directory,`${claim}.json`))).mode&0o7777,0o600);
    }
    const path=join(directory,'existing.json');
    await fs.writeFile(path,'PREEXISTING_SENTINEL',{mode:0o600});
    await assert.rejects(writeNativeProjectResultReceipt(result(),{directory,filename:'existing.json'},ports()),e=>e.code==='WRITE_FAILED');
    assert.equal(await fs.readFile(path,'utf8'),'PREEXISTING_SENTINEL');
    await fs.symlink(path,join(directory,'link.json'));
    await assert.rejects(writeNativeProjectResultReceipt(result(),{directory,filename:'link.json'},ports()),e=>e.code==='WRITE_FAILED');
  });
});

test('native writer reports fixed errors, closes handles, and leaves bounded private remnants on faults',async()=>{
  await owned(async directory=>{
    let writes=0,closes=0,unlinks=0;
    const io=controlledFs({open:async(path,handle)=>wrappedHandle(handle,{
      writeFile:async(target,bytes)=>{writes++;await target.writeFile(bytes.subarray(0,8));throw Error('PRIVATE_SENTINEL');},
      close:async target=>{closes++;return target.close();}
    })});
    const withUnlink={...io,async unlink(path){unlinks++;return fs.unlink(path);}};
    await assert.rejects(writeNativeProjectResultReceipt(result(true),{directory,filename:'fault.json'},ports(withUnlink)),
      e=>e.code==='WRITE_FAILED'&&e.message==='WRITE_FAILED'&&e.cause===undefined);
    assert.equal(writes,1);
    assert.equal(closes,1);
    assert.equal(unlinks,0);
    assert.equal((await fs.stat(join(directory,'fault.json'))).mode&0o7777,0o600);
  });
  await owned(async directory=>{
    let reads=0,closes=0;
    const io=controlledFs({open:async(path,handle)=>wrappedHandle(handle,{
      read:async(target,buffer,offset,length,position)=>{
        const value=await target.read(buffer,offset,length,position);
        if(value.bytesRead>0){reads++;buffer[offset]^=1;}
        return value;
      },
      close:async target=>{closes++;return target.close();}
    })});
    await assert.rejects(writeNativeProjectResultReceipt(result(false),{directory,filename:'corrupt.json'},ports(io)),
      e=>e.code==='WRITE_FAILED'&&e.message==='WRITE_FAILED'&&e.cause===undefined);
    assert.ok(reads>0);
    assert.equal(closes,1);
  });
  await owned(async directory=>{
    let reads=0,closes=0;
    const io=controlledFs({open:async(path,handle)=>wrappedHandle(handle,{
      read:async(target,...args)=>{const value=await target.read(...args);if(value.bytesRead>0)reads++;return value;},
      close:async target=>{closes++;await target.close();throw Error('PRIVATE_SENTINEL');}
    })});
    await assert.rejects(writeNativeProjectResultReceipt(result(true),{directory,filename:'close-fault.json'},ports(io)),
      e=>e.code==='WRITE_FAILED'&&e.message==='WRITE_FAILED'&&e.cause===undefined);
    assert.ok(reads>0);
    assert.equal(closes,1);
  });
  await owned(async directory=>{
    const badFs={
      async lstat(path){return fs.lstat(path);},
      async open(path,...args){return fs.open(path,...args);}
    };
    let calls=0;
    const invalid=result();invalid.direct_child_invocations.generation=0;
    const counting={async lstat(...args){calls++;return badFs.lstat(...args);},async open(...args){calls++;return badFs.open(...args);}};
    await assert.rejects(writeNativeProjectResultReceipt(invalid,{directory,filename:'invalid.json'},ports(counting)),
      e=>e.code==='INVALID_RECEIPT');
    assert.equal(calls,0);
  });
});

test('intake preserves bounded duplicate-key diagnostics and rejects invalid parsed native envelopes',async()=>{
  for(const text of [
    '{"schema":"SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1","schema":"SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1"}',
    '{"schema":"SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1","result":{},"resu\\u006ct":{}}'
  ]){
    const report=await cliBytes(encode(text));
    assert.equal(report.code,2);
    assert.equal(report.err,'DUPLICATE_KEY_CONFLICT\n');
    assert.match(report.out,/INVALID_RECEIPT/);
  }
  const malformed=await cliBytes(new Uint8Array([0xff]));
  assert.equal(malformed.code,2);
  assert.doesNotMatch(malformed.out+malformed.err,/PRIVATE_SENTINEL/);
  const parsedInvalid=await cliBytes(encode({schema:envelopeSchema,result:result(true),hidden:'PRIVATE_SENTINEL'}));
  assert.equal(parsedInvalid.code,2);
  assert.equal(parsedInvalid.err,'SCHEMA_MISMATCH\n');
  assert.doesNotMatch(parsedInvalid.out+parsedInvalid.err,/PRIVATE_SENTINEL/);
  assert.equal(REPORT_MAX_BYTES,262144);
});

test('whole-file CLI intake accepts exactly 262144 bytes including LF and rejects 262145',async()=>{
  const base=JSON.stringify(createNativeProjectResultReceipt(result(false)));
  const padding=REPORT_MAX_BYTES-new TextEncoder().encode(base+'\n').length;
  assert.ok(padding>=0);
  const exact=encode(base+' '.repeat(padding)+'\n');
  assert.equal(exact.length,REPORT_MAX_BYTES);
  const accepted=await cliBytes(exact);
  assert.equal(accepted.code,1);
  const over=encode(base+' '.repeat(padding+1)+'\n');
  assert.equal(over.length,REPORT_MAX_BYTES+1);
  const rejected=await cliBytes(over);
  assert.equal(rejected.code,2);
  assert.equal(rejected.err,'FILE_TOO_LARGE\n');
});

test('native valid adversarial encoding roundtrips; exact-cap branch NOT_EXERCISED',async()=>{
  // Exact-cap branch NOT_EXERCISED: the existing 4096-character scalar and 64-item array limits constrain the fixed semantic receipt shape.
  const privateText='\0'.repeat(4096);
  const live=result(false);
  live.operator_receipt=privateText;
  const created=createNativeProjectResultReceipt(live);
  const createdBytes=encode(JSON.stringify(created)+'\n');
  const skeleton=result(false);
  skeleton.operator_receipt='';
  const skeletonLength=encode(JSON.stringify({schema:envelopeSchema,result:skeleton})+'\n').length;
  assert.equal(createdBytes.length,skeletonLength+privateText.length*6);
  assert.ok(createdBytes.length<REPORT_MAX_BYTES);
  assert.equal(createdBytes.includes(0),false);

  await owned(async directory=>{
    const filename='adversarial-encoding.json';
    const acknowledgement=await writeNativeProjectResultReceipt(live,{directory,filename},ports());
    assert.equal(acknowledgement.status,'RECORDED');
    assert.equal(acknowledgement.byte_count,createdBytes.length);
    assert.equal(acknowledgement.sha256,createHash('sha256').update(createdBytes).digest('hex'));
    const path=join(directory,filename);
    const readback=await readReceiptBytes(path);
    assert.deepEqual(readback,createdBytes);
    const saved=parseReceiptJson(readback);
    const summary=projectNativeProjectRunSummary(saved);
    assert.equal(summary.readiness,'CANDIDATE_STAGED');
    assert.equal(summary.has_operator_receipt,true);
    assert.equal(summary.operator_admission_claimed,false);
    assert.equal(summary.admission_authority,'NOT_ESTABLISHED');
    const terminal=formatNativeProjectSummaryTerminal(summary);
    assert.doesNotMatch(terminal,/PRIVATE_SENTINEL|PRIVATE_MODEL|ba586107/);
    assert.equal(terminal.includes('\0'),false);
    const report=await cliBytes(readback);
    assert.equal(report.code,1);
    assert.equal(report.err,'');
    assert.equal(report.stats,1);
    assert.equal(report.reads,1);
    assert.match(report.out,/operator admission claimed: false/);
    assert.doesNotMatch(report.out,/PRIVATE_SENTINEL|PRIVATE_MODEL|ba586107/);
    assert.equal(report.out.includes('\0'),false);
  });

  const overLength=result(false);
  overLength.operator_receipt='x'.repeat(4097);
  assert.throws(()=>createNativeProjectResultReceipt(overLength),
    error=>error.code==='INVALID_INPUT'&&error.message==='INVALID_INPUT');
  let calls=0;
  const io={async lstat(){calls++;},async open(){calls++;}};
  await assert.rejects(
    writeNativeProjectResultReceipt(overLength,{directory:'/tmp',filename:'overlength.json'},{fs:io,uid:process.getuid()}),
    error=>error.code==='INVALID_INPUT'&&error.message==='INVALID_INPUT'
  );
  assert.equal(calls,0);
});

test('retention, unknown values, zero counters and native authority do not normalize into claims',()=>{
  const live=result(true,'GENERATION_REJECTED','GENERATION_REJECTED',generation('LIMITED_PARSER_ERROR'),1,null);
  live.generation.record.task_payload_valid=false;
  live.generation.record.error_details={code:'PAYLOAD:PROJECT_PAYLOAD_TOO_SMALL',classification:'PRIVATE',message:'PRIVATE'};
  live.generation.diagnostic_retention={retention_status:'UNKNOWN',rejection_stage:'PAYLOAD',rejection_reason:'PROJECT_PAYLOAD_TOO_SMALL',exact_response_bytes:0,retained_bytes_count:0,retained_truncated:false,retention_error:null};
  const summary=projectNativeProjectRunSummary(envelope(live));
  assert.equal(summary.readiness,'GENERATION_REJECTED');
  assert.equal(summary.operator_admission_claimed,true);
  assert.equal(summary.admission_authority,'NOT_ESTABLISHED');
  assert.equal(summary.generation.diagnostic_retention.exact_response_bytes,0);
  assert.deepEqual(summary.diagnostic,{stage:'PAYLOAD',reason:'PROJECT_PAYLOAD_TOO_SMALL'});
  const invalid=clone(envelope(live));invalid.result.generation.diagnostic_retention.rejection_stage=null;
  assert.equal(projectNativeProjectRunSummary(invalid).readiness,'INVALID_RECEIPT');
});

test('synthetic wrapper-shaped fixture remains a recorded claim with privacy and noninvocation checks',async()=>{
  let invoked=0;
  const live=result(true);
  live.operator_receipt='SYNTHETIC_PRIVATE_RECEIPT';
  live.generation.late_observations=()=>{invoked++;};
  const saved=createNativeProjectResultReceipt(live);
  const summary=projectNativeProjectRunSummary(saved);
  const terminal=formatNativeProjectSummaryTerminal(summary);
  assert.equal(saved.result.operator_admitted,true);
  assert.equal(summary.operator_admission_claimed,true);
  assert.equal(summary.admission_authority,'NOT_ESTABLISHED');
  assert.equal(Object.hasOwn(saved.result.generation,'late_observations'),false);
  assert.equal(invoked,0);
  assert.doesNotMatch(terminal,/SYNTHETIC_PRIVATE_RECEIPT|PRIVATE_SENTINEL|PRIVATE_MODEL|ba586107/);
  assert.match(terminal,/Recorded claims only/);
});

test('count-zero spawn-failed claims are rejected before native receipt IO', async () => {
  await owned(async directory => {
    for (const claim of [false, true]) {
      const live = result(
        claim,
        'GENERATION_REJECTED',
        'GENERATION_REJECTED',
        generation('LIMITED_SPAWN_FAILED'),
        1,
        null
      );
      const recordData = live.generation.record;
      recordData.process_exit = {
        pid: null,
        exit_code: null,
        exit_signal: null,
        process_wall_ms: null,
        observed_termination: false
      };
      recordData.io_state = {
        stdout_bytes_observed: 0,
        stderr_bytes_observed: 0,
        stdout_eof: false,
        stderr_eof: false,
        io_drained: false
      };
      recordData.containment_evidence.settlement_status = 'UNKNOWN';
      recordData.provider_metadata.provider_reported_status = null;
      recordData.provider_metadata.duration_seconds = null;
      for (const key of ['input', 'output', 'cache_read', 'thinking', 'total']) {
        recordData.provider_metadata.usage_tokens[key] = 'UNKNOWN';
      }
      recordData.output_custody = {
        persisted: false,
        path: null,
        byte_count: null,
        persistence_error: null
      };
      recordData.task_payload_valid = null;

      const runtime = live.generation.runtime_evidence;
      runtime.timeout_latched = false;
      runtime.abort_latched = false;
      runtime.signal_attempts = [];
      runtime.workspace_disposition = 'QUARANTINED';

      const saved = createNativeProjectResultReceipt(live);
      const projected = projectNativeProjectRunSummary(saved);
      assert.equal(projected.readiness, 'GENERATION_REJECTED');
      assert.equal(saved.result.operator_admitted, claim);
      assert.equal(projected.operator_admission_claimed, claim);
      assert.equal(saved.result.direct_child_invocations.generation, 1);

      const acknowledgement = await writeNativeProjectResultReceipt(
        live,
        { directory, filename: `spawn-failed-${claim}.json` },
        ports()
      );
      assert.equal(acknowledgement.status, 'RECORDED');

      const zeroInvocation = clone(saved.result);
      zeroInvocation.direct_child_invocations.generation = 0;

      assert.equal(
        projectNativeProjectRunSummary({ schema: saved.schema, result: zeroInvocation }).readiness,
        'INVALID_RECEIPT'
      );
      assert.throws(
        () => createNativeProjectResultReceipt(zeroInvocation),
        error => error.code === 'INVALID_RECEIPT' && error.message === 'INVALID_RECEIPT'
      );

      let ioCalls = 0;
      const countingFs = {
        async lstat(...args) {
          ioCalls++;
          return fs.lstat(...args);
        },
        async open(...args) {
          ioCalls++;
          return fs.open(...args);
        }
      };
      await assert.rejects(
        writeNativeProjectResultReceipt(
          zeroInvocation,
          { directory, filename: `zero-invocation-${claim}.json` },
          ports(countingFs)
        ),
        error => error.code === 'INVALID_RECEIPT' && error.message === 'INVALID_RECEIPT'
      );
      assert.equal(ioCalls, 0);

      assert.equal(live.direct_child_invocations.generation, 1);
      assert.equal(live.operator_admitted, claim);
      assert.equal(saved.result.direct_child_invocations.generation, 1);
      assert.equal(saved.result.operator_admitted, claim);
    }
  });
});
