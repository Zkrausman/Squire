import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {buildProjectCodegenPrompt} from '../src/project-task.mjs';
import {GENERATION_SHUTDOWN} from '../src/bounded-codegen-plan.mjs';
import {runProjectCodexTaskWithPhysicalEvidence} from '../src/project-runner.mjs';
import {projectPhysicalEvidenceConfigSha256} from '../src/project-physical-job-evidence.mjs';
import {runPhysicalEvidenceCli} from '../bin/squire-physical-evidence.mjs';

const CLI=new URL('../bin/squire-physical-evidence.mjs',import.meta.url).pathname;
const ID='8d9ee341-6fa3-4acc-8b93-000000000001';
const DIGEST='a'.repeat(64);
const ATTEMPT=`/tmp/squire-synthetic/attempts/${ID}`;
let fixtureSerial=2;
const textPort=()=>{let value='';return {write(chunk){value+=chunk;},get value(){return value;}};};
const run=(args,ports={})=>{const stdout=textPort(),stderr=textPort();return runPhysicalEvidenceCli(args,{stdout,stderr,...ports}).then(code=>({code,stdout:stdout.value,stderr:stderr.value}));};

test('import, default, help and malformed arguments never invoke the verifier',async()=>{
  let calls=0;const verify=()=>{calls++;throw Error('must not read');};
  for(const args of [[],['--help'],['verify'],['verify',ATTEMPT],['verify',ATTEMPT,'not-a-digest'],
    ['verify','relative/attempts/'+ID,DIGEST],['verify',ATTEMPT+'/..',DIGEST],
    ['verify','/tmp/squire-synthetic/other/'+ID,DIGEST],['verify',ATTEMPT,DIGEST,'--unknown'],
    ['verify',ATTEMPT,DIGEST,'--json','extra']]){
    const out=await run(args,{verify});assert.equal(out.code,args[0]==='--help'?0:2);
    assert.equal(out.stdout.includes('/tmp/'),false);assert.equal(out.stderr.includes('/tmp/'),false);
  }
  assert.equal(calls,0);
  const proc=spawnSync(process.execPath,[CLI,'--help'],{encoding:'utf8'});
  assert.equal(proc.status,0);assert.match(proc.stdout,/Usage:/);assert.equal(proc.stderr,'');
});

test('one selected path and caller digest are forwarded exactly; output is fixed and bounded',async()=>{
  const calls=[],verify=async(...args)=>{calls.push(args);return {status:'PHYSICAL_EVIDENCE_COPY_VERIFIED',copy_integrity:'VERIFIED',acknowledgement:'UNKNOWN',private_path:'/secret',private_job_id:ID};};
  const plain=await run(['verify',ATTEMPT,DIGEST],{verify});
  const json=await run(['verify',ATTEMPT,DIGEST,'--json'],{verify});
  assert.deepEqual(calls,[[ATTEMPT,DIGEST],[ATTEMPT,DIGEST]]);
  assert.deepEqual(plain,{code:0,stdout:'COPY_INTEGRITY_VERIFIED ACKNOWLEDGEMENT_UNKNOWN\n',stderr:''});
  assert.deepEqual(JSON.parse(json.stdout),{schema:'SQUIRE_PHYSICAL_EVIDENCE_CLI_V1',status:'COPY_INTEGRITY_VERIFIED',copy_integrity:'VERIFIED',acknowledgement:'UNKNOWN'});
  assert.equal(json.code,0);assert.equal(json.stderr,'');
  assert.equal((plain.stdout+json.stdout).includes('/secret'),false);
});

test('only finite verifier failure codes escape, never private error prose',async()=>{
  for(const code of ['EVIDENCE_INTEGRITY_REJECTED','EVIDENCE_CUSTODY_REJECTED','EVIDENCE_CAPACITY_REJECTED','EVIDENCE_IO_UNKNOWN','INVALID_EVIDENCE_SPEC']){
    const out=await run(['verify',ATTEMPT,DIGEST],{verify:()=>{throw Object.assign(Error('/private/secret raw provider output'),{code});}});
    assert.deepEqual(out,{code:1,stdout:'',stderr:code+'\n'});
  }
  for(const error of [Error('/private/secret'),{code:'PRIVATE_/tmp/secret'},{get code(){throw Error('/private/secret');}},
    {get code(){return this.calls++===0?'EVIDENCE_IO_UNKNOWN':'/private/secret';},calls:0}]){
    const out=await run(['verify',ATTEMPT,DIGEST],{verify:()=>{throw error;}});
    assert.deepEqual(out,{code:1,stdout:'',stderr:'EVIDENCE_IO_UNKNOWN\n'});
  }
  const invalid=await run(['verify',ATTEMPT,DIGEST],{verify:()=>({status:'ACKNOWLEDGED',copy_integrity:'VERIFIED',acknowledgement:'ACKNOWLEDGED'})});
  assert.deepEqual(invalid,{code:1,stdout:'',stderr:'EVIDENCE_IO_UNKNOWN\n'});
});

async function syntheticBundle(fn){
  const root=await fs.mkdtemp('/tmp/squire-physical-cli-fixture-');await fs.chmod(root,0o700);
  const evidence=join(root,'evidence');await fs.mkdir(evidence,{mode:0o700});
  try{
    const jobId='8d9ee341-6fa3-4acc-8b93-'+String(fixtureSerial++).padStart(12,'0');
    const child=new EventEmitter();child.pid=123;child.unref=()=>{};child.kill=()=>true;
    for(const name of ['stdout','stderr','stdin']){child[name]=new EventEmitter();child[name].destroy=()=>{};}
    child.stdin.write=(_bytes,callback)=>{callback();return true;};
    const response=JSON.stringify({schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',files:[{path:'src/index.mjs',classification:'SOURCE',encoding:'utf-8',content:'export const synthetic=1;\n'}]});
    child.stdin.end=callback=>{callback();queueMicrotask(()=>{
      child.stdout.emit('data',Buffer.from([{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:response}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:3,cached_input_tokens:0,reasoning_output_tokens:1}}].map(x=>JSON.stringify(x)).join('\n')+'\n'));
      child.stdout.emit('end');child.stderr.emit('end');child.emit('exit',0,null);
    });};
    const clock={now:()=>0,schedule:()=>()=>{}};
    const request={schema:'SQUIRE2_PROJECT_REQUEST_V1',task_id:'synthetic',task_prompt:'Synthetic only.',runtime_target:'node24-esm',stage_target:'multifile-candidate'};
    const spec={job_id:jobId,task_scope:root,requested_model:'mock-project-model',effort:'mock-project-effort',max_wall_clock_sec:120,prompt_bytes:buildProjectCodegenPrompt(request)};
    const ports={fs,uid:process.getuid(),spawn:()=>{queueMicrotask(()=>child.emit('spawn'));return child;},executable:'/synthetic/codex',codex:{observed_cli_version:'0.160.0',authorization:{operator_receipt:'/synthetic/operator.json',supported_tuples:[{model:spec.requested_model,effort:spec.effort}]},permissions:{sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'}},environment:{PUBLIC:'synthetic'}};
    const out=await runProjectCodexTaskWithPhysicalEvidence(spec,{clock,shutdown:GENERATION_SHUTDOWN,abortSignal:new AbortController().signal},ports,{root:evidence,operation_config_sha256:projectPhysicalEvidenceConfigSha256(spec)});
    assert.equal(out.evidence.status,'ACKNOWLEDGED');
    return await fn(join(evidence,'attempts',jobId),out.evidence.manifest_sha256);
  }finally{await fs.rm(root,{recursive:true,force:true});}
}

test('actual CLI verifies one synthetic bundle and rejects wrong digest and corruption',async()=>syntheticBundle(async(attempt,digest)=>{
  const ok=spawnSync(process.execPath,[CLI,'verify',attempt,digest,'--json'],{encoding:'utf8'});
  assert.equal(ok.status,0);assert.equal(ok.stderr,'');
  assert.equal(JSON.parse(ok.stdout).copy_integrity,'VERIFIED');
  assert.equal(JSON.parse(ok.stdout).acknowledgement,'UNKNOWN');
  const wrong=spawnSync(process.execPath,[CLI,'verify',attempt,'0'.repeat(64)],{encoding:'utf8'});
  assert.equal(wrong.status,1);assert.equal(wrong.stdout,'');assert.equal(wrong.stderr,'EVIDENCE_INTEGRITY_REJECTED\n');
  await fs.writeFile(join(attempt,'stdout.bin'),Buffer.from('corrupt'));
  const corrupt=spawnSync(process.execPath,[CLI,'verify',attempt,digest],{encoding:'utf8'});
  assert.equal(corrupt.status,1);assert.equal(corrupt.stderr,'EVIDENCE_INTEGRITY_REJECTED\n');
  for(const out of [ok,wrong,corrupt])assert.equal((out.stdout+out.stderr).includes(attempt),false);
}));

test('actual CLI preserves the verifier custody and byte-bound failures',async()=>syntheticBundle(async(attempt,digest)=>{
  const root=join(attempt,'..','..');
  await fs.chmod(root,0o755);
  let out=spawnSync(process.execPath,[CLI,'verify',attempt,digest],{encoding:'utf8'});
  assert.equal(out.status,1);assert.equal(out.stderr,'EVIDENCE_CUSTODY_REJECTED\n');
  await fs.chmod(root,0o700);
  const stdout=join(attempt,'stdout.bin'),original=await fs.readFile(stdout);
  await fs.rm(stdout);await fs.symlink('/synthetic/nonexistent-private-leaf',stdout);
  out=spawnSync(process.execPath,[CLI,'verify',attempt,digest],{encoding:'utf8'});
  assert.equal(out.status,1);assert.equal(out.stderr,'EVIDENCE_CUSTODY_REJECTED\n');
  await fs.rm(stdout);await fs.writeFile(stdout,Buffer.alloc(1048577),{mode:0o600});
  out=spawnSync(process.execPath,[CLI,'verify',attempt,digest],{encoding:'utf8'});
  assert.equal(out.status,1);assert.equal(out.stderr,'EVIDENCE_CUSTODY_REJECTED\n');
  await fs.writeFile(stdout,original);
  out=spawnSync(process.execPath,[CLI,'verify',attempt,digest],{encoding:'utf8'});
  assert.equal(out.status,0);assert.equal(out.stdout,'COPY_INTEGRITY_VERIFIED ACKNOWLEDGEMENT_UNKNOWN\n');
}));
