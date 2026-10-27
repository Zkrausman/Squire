import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProjectEntrypointCli,projectDryRun,projectEntrypointMode,runProjectOneCaseNative} from '../acceptance/project-entrypoint.mjs';
import {prepareProjectCodexTask,validateProjectCodexConfig,validateProjectReceiptDestination,PROJECT_SOURCE_FILES,PROJECT_SOURCE_ROOT,PROJECT_RECEIPT_SOURCE_FILES,PROJECT_RECEIPT_DESTINATION_SCHEMA} from '../src/project-configuration.mjs';
import {hash,verifyExactFile} from '../src/bounded-codegen-plan.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {createNativeProjectResultReceipt} from '../src/project-result-receipt.mjs';
import {projectNativeProjectRunSummary,formatNativeProjectSummaryTerminal} from '../src/project-summary.mjs';
import {readReceiptBytes,runOfflineReportCli} from '../bin/squire-report.mjs';

// Proposed synthetic tests only. No native producer or provider workload is invoked.
const enc=value=>new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value));
const clone=value=>structuredClone(value);
const job='ba586107-7240-4d89-88d3-d71005bce32f',digest='a'.repeat(64);
function generation(lifecycle='LIMITED_SUCCESS'){
  const success=lifecycle==='LIMITED_SUCCESS',timed=lifecycle==='LIMITED_TIMEOUT',spawn=lifecycle==='LIMITED_SPAWN_FAILED';
  return {
    record:{
      job_id:job,task_class:'PROJECT_CODEGEN_V1',lifecycle_status:lifecycle,
      requested_model:'gpt-6-luna',reported_model:'PRIVATE_MODEL_SENTINEL',
      process_exit:{pid:success?41:null,exit_code:success?0:timed||spawn?null:1,exit_signal:null,process_wall_ms:0,observed_termination:!timed&&!spawn},
      io_state:{stdout_bytes_observed:success?100:0,stderr_bytes_observed:0,stdout_eof:true,stderr_eof:true,io_drained:true},
      containment_evidence:{containment_level:'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',settlement_status:timed?'ABANDONED_UNSETTLED':spawn?'UNKNOWN':'SETTLED_DIRECT_CHILD_EXIT',descendant_guarantee:'NONE'},
      provider_metadata:{provider_reported_status:success?'turn.completed':timed?'turn.failed':'ERROR',duration_seconds:null,usage_tokens:{input:0,output:8,cache_read:0,thinking:'UNKNOWN',total:'UNKNOWN'}},
      output_custody:{persisted:success,path:'/PRIVATE_SENTINEL/envelope.json',byte_count:success?100:null,persistence_error:null},
      task_outcome_evaluated:false,task_payload_valid:success,
      error_details:{code:null,classification:null,message:null}
    },
    runtime_evidence:{deadline_ms:120000,timeout_latched:false,abort_latched:false,signal_attempts:[],event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',workspace_reuse:'NOT_AUTHORIZED',workspace_disposition:success?'DEDICATED_NOT_REUSED':'QUARANTINED',max_steps:'UNSUPPORTED'},
    diagnostic_retention:{retention_status:'NOT_REQUESTED',rejection_stage:null,rejection_reason:null,exact_response_bytes:null,retained_bytes_count:null,retained_truncated:false,retention_error:null}
  };
}
function result(admitted=true,status='CANDIDATE_STAGED',reason=null,gen=generation(),count=1,staging=undefined){
  const ack={schema_version:'squire4.stage_receipt.v1',stage_operation_id:`stage-${job}`,caller_label:'project_candidate_stager',completion_status:'COMPLETE',manifest_sha256:digest,file_count:1,total_bytes:0,operation_acknowledgement:'ACKNOWLEDGED',provenance_authenticity:'NOT_ESTABLISHED',crash_durability:'NOT_ESTABLISHED'};
  return {schema:'SQUIRE2_PROJECT_RESULT_V1',status,reason,generation:gen,staging:staging===undefined?ack:staging,task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,runtime_admitted:false,operator_admitted:admitted,workspace_disposition:status==='CANDIDATE_STAGED'?'DEDICATED_NOT_REUSED':'QUARANTINED',descendant_guarantee:'NONE',operator_receipt:'/PRIVATE_SENTINEL/operator',direct_child_invocations:{generation:count},outer_observation_target_ms:140000,event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP'};
}
async function owned(run){
  const directory=await fs.mkdtemp(join(tmpdir(),'squire-entrypoint-receipt-'));
  await fs.chmod(directory,0o700);
  try{await run(directory);}finally{await fs.rm(directory,{recursive:true,force:true});}
}
async function fixture(directory){
  const files=new Map(),sourceBytes=new Map();
  for(const name of [...PROJECT_SOURCE_FILES,...PROJECT_RECEIPT_SOURCE_FILES]){
    const path=join(PROJECT_SOURCE_ROOT,name),bytes=enc('PUBLIC SYNTHETIC PIN '+name);
    files.set(path,bytes);sourceBytes.set(path,bytes);
  }
  const authorization={operator_receipt:'/PRIVATE_SENTINEL/operator',supported_tuples:[{model:'gpt-6.1-sol',effort:'medium'}]};
  const inputs={job_id:job,scope:'/PRIVATE_SENTINEL/scope',codex:{path:'/PRIVATE_SENTINEL/codex',version:'0.160.0',bytes:1,sha256:digest},requested_model:'gpt-6.1-sol',effort:'medium',authorization,permissions:{sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'}};
  const io={readFile:async path=>files.get(path),mkdir:async()=>{},writeFile:async(path,bytes)=>files.set(path,new Uint8Array(bytes))};
  await prepareProjectCodexTask('/PRIVATE_SENTINEL/prepared','b'.repeat(40),{schema:'SQUIRE2_PROJECT_REQUEST_V1',task_id:'synthetic',task_prompt:'Public synthetic instructions.',runtime_target:'node24-esm',stage_target:'multifile-candidate'},inputs,{fs:io,verifyFile:async()=>{},retention:()=>({prepare:async()=>({capability_status:'READY'})})});
  const configBytes=enc(new TextDecoder().decode(files.get('/PRIVATE_SENTINEL/prepared/config.json'))+'\n');
  const config=validateProjectCodexConfig(parseReceiptJson(configBytes));
  const admission={provider_id:'native_codex',operator_receipt:authorization.operator_receipt,config_sha256:hash(configBytes),job_id:job,scope:config.scope,project_admitted:true,preflight:{evidence_receipt:'/PRIVATE_SENTINEL/preflight'}};
  const source_pins=Object.fromEntries(PROJECT_RECEIPT_SOURCE_FILES.map(name=>{
    const path=join(PROJECT_SOURCE_ROOT,name),bytes=sourceBytes.get(path);
    return [path,{bytes:bytes.length,sha256:hash(bytes)}];
  }));
  const descriptor={schema:PROJECT_RECEIPT_DESTINATION_SCHEMA,config_sha256:hash(configBytes),job_id:job,scope:config.scope,destination:{directory,filename:'receipt.json'},source_pins};
  let descriptorBytes=enc(descriptor),admissionBytes=enc(admission),out='',err='',runs=0,opens=0,late=0;
  const verified=[],readCalls=[],calls=[],live=result();
  live.generation.late_observations=()=>{late++;throw Error('PRIVATE_LATE_SENTINEL');};
  const ports={
    readBytes:async(path,cap)=>{readCalls.push([path,cap]);if(path==='config')return configBytes;if(path==='admission')return admissionBytes;if(path==='destination')return descriptorBytes;throw Error('PRIVATE_READ_SENTINEL');},
    runProject:async(...args)=>{runs++;calls.push(args);return live;},
    verifyFile:async(identity,reads)=>{verified.push(identity);return verifyExactFile(identity,reads);},
    reads:{lstat:async path=>({size:sourceBytes.get(path)?.length,isFile:()=>true,isSymbolicLink:()=>false}),readChunks:async function*(path){yield sourceBytes.get(path);}},
    writerPorts:{fs:{lstat:fs.lstat,open:async(...args)=>{opens++;return fs.open(...args);}},uid:process.getuid()},
    stdout:{write:value=>{out+=value;}},stderr:{write:value=>{err+=value;}}
  };
  return {
    configBytes,config,admission,descriptor,sourceBytes,ports,live,verified,readCalls,calls,
    args:()=>['--run-admitted-save-receipt','config','admission','destination',hash(descriptorBytes)],
    descriptorBytes:()=>descriptorBytes,
    setDescriptor(value){descriptorBytes=enc(value);},
    setAdmission(value){admissionBytes=enc(value);},
    observations:()=>({out,err,runs,opens,late}),
    async run(args){return runProjectEntrypointCli(args??this.args(),ports);}
  };
}
function invalidBeforeRun(f){
  assert.deepEqual(f.observations(),{out:'',err:'PROJECT_RECEIPT_REQUEST_INVALID\n',runs:0,opens:0,late:0});
}
async function report(bytes){
  let out='',err='';
  const code=await runOfflineReportCli(['/PRIVATE_SENTINEL/receipt'],{
    stat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,size:bytes.length}),
    readFile:async()=>bytes,stdout:{write:value=>{out+=value;}},stderr:{write:value=>{err+=value;}}
  });
  return {code,out,err};
}
function statData(stat,changes={}){
  return {...Object.fromEntries(['dev','ino','uid','nlink','mode','size','mtimeMs','ctimeMs'].map(key=>[key,stat[key]])),
    isFile:()=>stat.isFile(),isDirectory:()=>stat.isDirectory(),isSymbolicLink:()=>stat.isSymbolicLink(),...changes};
}
function handlePorts(handle,kind){
  return {
    stat:()=>handle.stat(),
    writeFile:bytes=>kind==='write'?Promise.reject(Error('PRIVATE_WRITE_SENTINEL')):handle.writeFile(bytes),
    async read(...args){const value=await handle.read(...args);if(kind==='readback'&&value.bytesRead)args[0][args[1]]^=1;return value;},
    async close(){await handle.close();if(kind==='close')throw Error('PRIVATE_CLOSE_SENTINEL');}
  };
}
test('legacy API, default and unrelated CLI shapes remain inert',async()=>{
  assert.equal(typeof runProjectOneCaseNative,'function');assert.equal(runProjectOneCaseNative.length,3);
  assert.equal(projectEntrypointMode([]),'DRY_RUN_NATIVE_DISABLED');
  assert.equal(projectEntrypointMode(['--run-admitted','one']),'DRY_RUN_NATIVE_DISABLED');
  assert.equal(projectEntrypointMode(['--run-admitted','one','two']),'EXPLICIT_ADMISSION_REQUIRED');
  for(const args of [
    [],['unrelated'],['--run-admitted','one'],
    ...['--run-admitted-unknown','--run-admitted-save-receipt-unknown','--run-admitted-save','--run-admitted-save-other','--unrelated'].flatMap(flag=>[
      [flag,'config','admission'],
      [flag,'config','admission','destination',digest]
    ])
  ]){
    let out='',err='';
    const callbacks=[],unexpected=name=>(...args)=>{callbacks.push([name,args]);throw Error('UNEXPECTED_LEGACY_CALLBACK');};
    const ports={
      readBytes:unexpected('readBytes'),runProject:unexpected('runProject'),verifyFile:unexpected('verifyFile'),
      reads:{lstat:unexpected('reads.lstat'),readChunks:unexpected('reads.readChunks')},
      writerPorts:{fs:{lstat:unexpected('fs.lstat'),open:unexpected('fs.open')},uid:process.getuid()},
      stdout:{write:value=>{out+=value;}},stderr:{write:value=>{err+=value;}}
    };
    assert.equal(projectEntrypointMode(args),'DRY_RUN_NATIVE_DISABLED');
    assert.equal(await runProjectEntrypointCli(args,ports),0);
    assert.equal(out,JSON.stringify(projectDryRun())+'\n');assert.equal(err,'');
    assert.deepEqual(callbacks,[]);
  }
});
test('legacy three-argument seam preserves staged and adverse output and fixed runner failure',async()=>{
  for(const status of ['CANDIDATE_STAGED','FAILED']){
    const bytes=enc('{}'),admission=enc({synthetic:true}),live={status,synthetic:true};let out='',err='',calls=0;
    const ports={readBytes:async path=>path==='config'?bytes:admission,runProject:async(config,a)=>{calls++;assert.strictEqual(config,bytes);assert.equal(a.synthetic,true);return live;},stdout:{write:value=>{out+=value;}},stderr:{write:value=>{err+=value;}}};
    assert.equal(await runProjectEntrypointCli(['--run-admitted','config','admission'],ports),status==='CANDIDATE_STAGED'?0:1);
    assert.equal(out,JSON.stringify(live)+'\n');assert.equal(err,'');assert.equal(calls,1);
    out='';ports.runProject=async()=>{throw Error('PRIVATE_RUNNER_SENTINEL');};
    assert.equal(await runProjectEntrypointCli(['--run-admitted','config','admission'],ports),2);
    assert.equal(out,'');assert.equal(err,'PROJECT_ADMISSION_OR_OPERATION_FAILED\n');
  }
});
test('receipt pins are separate and preparation keeps its legacy closed config',async()=>owned(async directory=>{
  const f=await fixture(directory);
  assert.deepEqual(PROJECT_RECEIPT_SOURCE_FILES,['src/project-result-receipt.mjs','src/project-summary.mjs']);
  assert.ok(Object.isFrozen(PROJECT_RECEIPT_SOURCE_FILES));
  assert.deepEqual(Object.keys(f.config.source_pins).sort(),PROJECT_SOURCE_FILES.map(name=>join(PROJECT_SOURCE_ROOT,name)).sort());
  assert.equal(Object.hasOwn(f.config,'receipt_destination'),false);
  assert.equal(Object.hasOwn(f.config,'receipt_source_pins'),false);
  assert.equal(f.config.requested_model,'gpt-6.1-sol');assert.equal(f.config.effort,'medium');
  for(let index=0;index<2;index++)assert.equal(validateProjectReceiptDestination(f.descriptor,f.configBytes,f.admission).job_id,job);
}));
test('exact bytes, pins, parent and live result reach the fixed writer once',async()=>owned(async directory=>{
  const f=await fixture(directory),originalRun=f.ports.runProject;
  f.ports.runProject=async(...args)=>{
    assert.equal(f.verified.length,2);
    assert.deepEqual(await fs.readdir(directory),[]);
    assert.strictEqual(args[0],f.configBytes);
    assert.deepEqual(args[1],parseReceiptJson(enc(f.admission)));
    return originalRun(...args);
  };
  assert.equal(await f.run(),1);
  const observed=f.observations(),ack=JSON.parse(observed.out);
  assert.equal(observed.err,'');assert.equal(observed.runs,1);assert.equal(observed.opens,1);assert.equal(observed.late,0);
  assert.equal(observed.out,JSON.stringify(ack)+'\n');
  assert.deepEqual(Object.keys(ack).sort(),['schema','status','byte_count','sha256','crash_durability','source_authenticity'].sort());
  assert.equal(ack.schema,'squire3.native_project_result_write_receipt.v1');assert.equal(ack.status,'RECORDED');
  assert.equal(ack.crash_durability,'NOT_ESTABLISHED');assert.equal(ack.source_authenticity,'NOT_ESTABLISHED');
  const bytes=await readReceiptBytes(join(directory,'receipt.json')),saved=parseReceiptJson(bytes);
  assert.equal(ack.sha256,hash(bytes));assert.equal(ack.byte_count,bytes.length);
  assert.equal(saved.result.operator_admitted,true);assert.equal(Object.hasOwn(saved.result.generation,'late_observations'),false);
  assert.deepEqual(saved,parseReceiptJson(enc(createNativeProjectResultReceipt(f.live))));
  assert.deepEqual(f.readCalls,[['config',65536],['admission',65536],['destination',65536]]);
  for(const identity of f.verified)assert.deepEqual(identity,{path:identity.path,...f.descriptor.source_pins[identity.path]});
  for(const secret of [directory,job,'PRIVATE','project_candidate_stager','CANDIDATE_STAGED'])assert.equal((observed.out+observed.err).includes(secret),false);
}));
for(const [label,change]of [
  ['missing',()=>null],['false',a=>({...a,project_admitted:false})],
  ['job',a=>({...a,job_id:'00000000-0000-4000-8000-000000000000'})],
  ['scope',a=>({...a,scope:'/different'})],['config',a=>({...a,config_sha256:'0'.repeat(64)})],
  ['receipt',a=>({...a,operator_receipt:'/different'})],['provider',a=>({...a,provider_id:'different'})]
])test('admission '+label+' fails before any injected producer',async()=>owned(async directory=>{
  const f=await fixture(directory);f.setAdmission(change(f.admission));assert.equal(await f.run(),2);invalidBeforeRun(f);
}));
for(const [label,change]of [
  ['schema',d=>({...d,schema:'wrong'})],['job',d=>({...d,job_id:'wrong'})],
  ['scope',d=>({...d,scope:'/other'})],['config',d=>({...d,config_sha256:'0'.repeat(64)})],
  ['extra',d=>({...d,extra:true})],['null',()=>null],
  ['missing-pins',d=>{delete d.source_pins;return d;}],
  ['empty-pins',d=>({...d,source_pins:{}})],
  ['extra-pin',d=>{d.source_pins['/extra']={bytes:0,sha256:digest};return d;}],
  ['bad-pin',d=>{Object.values(d.source_pins)[0].sha256='bad';return d;}],
  ['negative-pin',d=>{Object.values(d.source_pins)[0].bytes=-1;return d;}],
  ['mismatched-pin',d=>{Object.values(d.source_pins)[0].sha256='0'.repeat(64);return d;}],
  ['wrong-size',d=>{Object.values(d.source_pins)[0].bytes++;return d;}]
])test('descriptor '+label+' rejects before producer',async()=>owned(async directory=>{
  const f=await fixture(directory);f.setDescriptor(change(clone(f.descriptor)));assert.equal(await f.run(),2);invalidBeforeRun(f);
}));
for(const destination of [
  null,{}, {directory:'/',filename:'x'}, {directory:'relative',filename:'x'},
  {directory:'/a/../b',filename:'x'}, {directory:'/a\0b',filename:'x'},
  {directory:'/valid',filename:''}, {directory:'/valid',filename:'.'},
  {directory:'/valid',filename:'..'}, {directory:'/valid',filename:'../x'},
  {directory:'/valid',filename:'x'.repeat(129)}, {directory:'/valid',filename:'x',extra:true}
])test('invalid destination '+JSON.stringify(destination),async()=>owned(async directory=>{
  const f=await fixture(directory);f.setDescriptor({...f.descriptor,destination});assert.equal(await f.run(),2);invalidBeforeRun(f);
}));
test('object validator rejects getters, proxies, symbols and unbound destination without invoking traps',async()=>owned(async directory=>{
  const f=await fixture(directory);let traps=0;
  const getter=clone(f.descriptor);Object.defineProperty(getter.destination,'filename',{get(){traps++;return 'x';}});
  const proxy=clone(f.descriptor);proxy.destination=new Proxy(proxy.destination,{ownKeys(){traps++;return [];},get(){traps++;return 'x';}});
  const symbol=clone(f.descriptor);symbol.destination[Symbol('private')]=true;
  for(const value of [getter,proxy,symbol,f.descriptor.destination,new Proxy(f.descriptor,{get(){traps++;}})]){
    assert.throws(()=>validateProjectReceiptDestination(value,f.configBytes,f.admission));
  }
  assert.equal(traps,0);
}));
test('bounded bytes, duplicate decoded keys and exact descriptor hash fail closed',async()=>{
  for(const kind of ['hash','upper-hash','duplicate','malformed','oversize','config-oversize','admission-oversize','config-duplicate','admission-duplicate']){
    await owned(async directory=>{
      const f=await fixture(directory),read=f.ports.readBytes;
      if(kind==='duplicate')f.setDescriptor('{"schema":"x","\\u0073chema":"y"}');
      if(kind==='malformed')f.setDescriptor('{');
      if(kind==='oversize')f.setDescriptor(' '.repeat(65537));
      f.ports.readBytes=async(path,cap)=>{
        if(kind===path+'-oversize')return enc(' '.repeat(65537));
        if(kind===path+'-duplicate')return enc('{"x":1,"x":2}');
        return read(path,cap);
      };
      const args=f.args();
      if(kind==='hash')args[4]='0'.repeat(64);
      if(kind==='upper-hash')args[4]='A'.repeat(64);
      assert.equal(await f.run(args),2);invalidBeforeRun(f);
    });
  }
});
test('exact new flag arity and malformed argv cannot enter legacy native mode',async()=>{
  for(const args of [
    ['--run-admitted-save-receipt'],['--run-admitted-save-receipt','a','b'],
    ['--run-admitted-save-receipt','a','b','c'],['--run-admitted-save-receipt','a','b','c',digest,'extra'],
    ['--run-admitted-save-receipt','a','b','',digest],
    null,new Proxy([],{}),['--run-admitted-save-receipt','a','b','c',null]
  ])await owned(async directory=>{
    const f=await fixture(directory);assert.equal(await runProjectEntrypointCli(args,f.ports),2);invalidBeforeRun(f);
  });
});
test('changed extra source bytes and verifier failure precede producer',async()=>{
  for(const kind of ['changed','throw'])await owned(async directory=>{
    const f=await fixture(directory);
    if(kind==='changed')f.sourceBytes.set(Object.keys(f.descriptor.source_pins)[0],enc('CHANGED'));
    else f.ports.verifyFile=async()=>{throw Error('PRIVATE_VERIFY_SENTINEL');};
    assert.equal(await f.run(),2);invalidBeforeRun(f);assert.deepEqual(await fs.readdir(directory),[]);
  });
});
test('bad parent metadata and absent parent fail before producer',async()=>{
  for(const changes of [
    {uid:process.getuid()+1},{mode:0o40755},{mode:0o44700},{mode:0o42700},
    {isDirectory:()=>false},{isSymbolicLink:()=>true},{uid:NaN},{ino:-1}
  ])await owned(async directory=>{
    const f=await fixture(directory);
    f.ports.writerPorts.fs.lstat=async path=>statData(await fs.lstat(path),changes);
    assert.equal(await f.run(),2);invalidBeforeRun(f);
  });
  await owned(async directory=>{
    const f=await fixture(directory);f.setDescriptor({...f.descriptor,destination:{directory:join(directory,'absent'),filename:'x'}});
    assert.equal(await f.run(),2);invalidBeforeRun(f);assert.deepEqual(await fs.readdir(directory),[]);
  });
  await owned(async directory=>{
    const target=join(directory,'target'),link=join(directory,'link');await fs.mkdir(target,{mode:0o700});await fs.symlink(target,link);
    const f=await fixture(directory);f.setDescriptor({...f.descriptor,destination:{directory:link,filename:'x'}});
    assert.equal(await f.run(),2);invalidBeforeRun(f);assert.deepEqual(await fs.readdir(target),[]);
  });
});
test('invalid trusted capabilities fail before reads or producer',async()=>{
  for(const change of [
    ports=>{ports.runProject=null;},ports=>{ports.verifyFile=null;},
    ports=>{ports.writerPorts.uid=-1;},ports=>{ports.writerPorts.fs.open=null;},
    ports=>{ports.reads.readChunks=null;},ports=>{ports.writerPorts.extra=true;},
    ports=>{ports.writer=()=>{};}
  ])await owned(async directory=>{
    const f=await fixture(directory);change(f.ports);assert.equal(await f.run(),2);invalidBeforeRun(f);assert.equal(f.readCalls.length,0);
  });
});
test('saved staged, adverse and cleanup ACK histories roundtrip as synthetic claims',async()=>{
  const cases=[
    result(true),result(false),
    result(true,'GENERATION_REJECTED','GENERATION_REJECTED',generation('LIMITED_PROCESS_FAILED'),1,null),
    result(true,'STAGING_REJECTED','STAGING:PACKAGE_IO_ERROR',generation(),1,null),
    result(true,'INCOMPLETE','GENERATION_REJECTED',generation('LIMITED_TIMEOUT'),1,null),
    result(true,'INCOMPLETE','CANCELED'),
    result(false,'FAILED','CLEANUP_FAILED_OR_UNCERTAIN'),
    result(true,'FAILED','OPERATION_FAILED_OR_UNCERTAIN',null,0,null)
  ];
  for(const live of cases)await owned(async directory=>{
    const f=await fixture(directory);
    f.ports.runProject=async(...args)=>{await f.calls.push(args);return live;};
    assert.equal(await f.run(),1);assert.equal(f.calls.length,1);assert.equal(f.observations().err,'');
    const bytes=await readReceiptBytes(join(directory,'receipt.json')),saved=parseReceiptJson(bytes);
    assert.equal(saved.result.operator_admitted,live.operator_admitted);
    const summary=projectNativeProjectRunSummary(saved),text=formatNativeProjectSummaryTerminal(summary),cli=await report(bytes);
    assert.equal(summary.readiness,live.status);assert.equal(summary.operator_admission_claimed,live.operator_admitted);
    assert.equal(summary.admission_authority,'NOT_ESTABLISHED');assert.equal(summary.runtime_admitted_marker,false);
    assert.equal(summary.staging?.completion_status??null,live.staging?.completion_status??null);
    assert.equal(cli.code,1);assert.equal(cli.out,text);assert.equal(cli.err,'');
    assert.equal(text.includes('PRIVATE'),false);assert.equal(text.includes(job),false);
    if(summary.generation){
      assert.equal(summary.generation.provider_metadata.usage_tokens.input,0);
      assert.equal(summary.generation.provider_metadata.usage_tokens.thinking,null);
      assert.equal(summary.generation.record,undefined);
      assert.match(text,/thinking=UNKNOWN/);
      assert.match(text,/input=0/);
      assert.match(text,/reported model: UNKNOWN/);
    }
  });
});
test('existing leaf remains unchanged after one producer with no overwrite or fallback',async()=>owned(async directory=>{
  const f=await fixture(directory),path=join(directory,'receipt.json'),sentinel=enc('PRIVATE_EXISTING_SENTINEL');
  await fs.writeFile(path,sentinel,{mode:0o600,flag:'wx'});
  assert.equal(await f.run(),2);
  assert.deepEqual(await fs.readFile(path),Buffer.from(sentinel));
  assert.deepEqual(f.observations(),{out:'',err:'PROJECT_RECEIPT_WRITE_FAILED\n',runs:1,opens:1,late:0});
  assert.deepEqual(await fs.readdir(directory),['receipt.json']);
}));
test('runner exception is fixed and never opens the sink',async()=>owned(async directory=>{
  const f=await fixture(directory);let calls=0;
  f.ports.runProject=async()=>{calls++;throw Error('PRIVATE_RUNNER_SENTINEL');};
  assert.equal(await f.run(),2);assert.equal(calls,1);assert.equal(f.observations().opens,0);
  assert.equal(f.observations().out,'');assert.equal(f.observations().err,'PROJECT_ADMISSION_OR_OPERATION_FAILED\n');
  assert.deepEqual(await fs.readdir(directory),[]);
}));
for(const kind of ['write','readback','close'])test('sink '+kind+' error is fixed with no retry or deletion',async()=>owned(async directory=>{
  const f=await fixture(directory),open=f.ports.writerPorts.fs.open;
  f.ports.writerPorts.fs.open=async(...args)=>handlePorts(await open(...args),kind);
  assert.equal(await f.run(),2);
  assert.deepEqual(f.observations(),{out:'',err:'PROJECT_RECEIPT_WRITE_FAILED\n',runs:1,opens:1,late:0});
  assert.deepEqual(await fs.readdir(directory),['receipt.json']);
}));
test('final writer rechecks parent after cooperative preflight',async()=>owned(async directory=>{
  const f=await fixture(directory),run=f.ports.runProject;
  f.ports.runProject=async(...args)=>{const live=await run(...args);await fs.chmod(directory,0o750);return live;};
  assert.equal(await f.run(),2);
  assert.deepEqual(f.observations(),{out:'',err:'PROJECT_RECEIPT_WRITE_FAILED\n',runs:1,opens:0,late:0});
  assert.deepEqual(await fs.readdir(directory),[]);
}));
test('incompatible live values reject before sink creation',async()=>{
  for(const live of [null,{private:'PRIVATE_RESULT_SENTINEL'}]){
    await owned(async directory=>{
      const f=await fixture(directory);let calls=0;f.ports.runProject=async()=>{calls++;return live;};
      assert.equal(await f.run(),2);assert.equal(calls,1);assert.equal(f.observations().opens,0);
      assert.equal(f.observations().out,'');assert.equal(f.observations().err,'PROJECT_RECEIPT_WRITE_FAILED\n');
      assert.deepEqual(await fs.readdir(directory),[]);
    });
  }
});
test('spawn failure records with count one for both admission claims and rejects only the count-zero delta',async()=>{
  const positives=[true,false].map(admitted=>result(admitted,'GENERATION_REJECTED','GENERATION_REJECTED',generation('LIMITED_SPAWN_FAILED'),1,null));
  const originals=positives.map(live=>clone(live));
  for(const live of positives)await owned(async directory=>{
    const expected=createNativeProjectResultReceipt(live);
    const f=await fixture(directory),run=f.ports.runProject;
    f.ports.runProject=async(...args)=>{await run(...args);return live;};
    assert.equal(await f.run(),1);
    const observed=f.observations(),ack=JSON.parse(observed.out);
    assert.deepEqual(observed,{out:JSON.stringify(ack)+'\n',err:'',runs:1,opens:1,late:0});
    assert.equal(f.calls.length,1);
    assert.equal(ack.schema,'squire3.native_project_result_write_receipt.v1');
    assert.equal(ack.status,'RECORDED');
    const bytes=await readReceiptBytes(join(directory,'receipt.json')),saved=parseReceiptJson(bytes);
    assert.equal(ack.sha256,hash(bytes));assert.equal(ack.byte_count,bytes.length);
    assert.deepEqual(saved,parseReceiptJson(enc(expected)));
    assert.equal(saved.result.operator_admitted,live.operator_admitted);
    assert.deepEqual(await fs.readdir(directory),['receipt.json']);
  });
  const invalid=clone(positives[0]);
  invalid.direct_child_invocations.generation=0;
  assert.deepEqual(invalid,{...originals[0],direct_child_invocations:{generation:0}});
  assert.throws(()=>createNativeProjectResultReceipt(invalid));
  await owned(async directory=>{
    const f=await fixture(directory),run=f.ports.runProject;
    f.ports.runProject=async(...args)=>{await run(...args);return invalid;};
    assert.equal(await f.run(),2);
    assert.equal(f.calls.length,1);
    assert.deepEqual(f.observations(),{out:'',err:'PROJECT_RECEIPT_WRITE_FAILED\n',runs:1,opens:0,late:0});
    assert.deepEqual(await fs.readdir(directory),[]);
  });
  assert.deepEqual(positives,originals);
});
