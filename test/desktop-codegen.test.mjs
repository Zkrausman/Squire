import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {
  prepareDesktopCodegenTask,prepareProjectCodexTask,validateDesktopCodegenConfig,
  validateDesktopCodegenAdmission,requireDesktopCodegenAdmission,
  validateProjectCodexConfig,requireProjectCodexAdmission,
  validateProjectReceiptDestination,PROJECT_SOURCE_FILES,PROJECT_SOURCE_ROOT,
  DESKTOP_CODEGEN_SOURCE_FILES,DESKTOP_CODEGEN_SCHEMA,DESKTOP_CODEGEN_INTENT
} from '../src/project-configuration.mjs';
import {
  runProjectDesktopCodegenWithPorts,runProjectDesktopCodegenNative,
  runProjectEntrypointCli,runProjectOneCaseNative,buildDesktopCodegenInvocation,
  projectEntrypointMode,desktopCodegenEntrypointMode
} from '../acceptance/project-entrypoint.mjs';
import {runProjectPreparationCli} from '../acceptance/prepare-project-task.mjs';
import {runProjectCodexTask,admitProjectCodexTask} from '../src/project-runner.mjs';
import {buildProjectCodegenPrompt,PROJECT_PREFIX_IDENTITY} from '../src/project-task.mjs';
import {DESKTOP_TARGET,DESKTOP_PREFIX_IDENTITY} from '../src/desktop-profile.mjs';
import {
  NODE_RUNTIME,GENERATION_SHUTDOWN,canonicalBytes,hash,validateCodexPreflight
} from '../src/bounded-codegen-plan.mjs';
import {
  prepareCodexArgv,prepareChatgptOnlyCodexArgv,
  CODEX_CHILD_ENV_DELETIONS,codexEnvironment
} from '../src/codex-profile.mjs';
import {parseReceiptJson} from '../src/offline-run-summary.mjs';
import {verifyStage} from '../src/multifile-staging.mjs';

// Only event-emitting fake producers, injected clocks and owned fixture files.
// No child_process, generated module, provider, GJS or grader is invoked.
const enc=s=>new TextEncoder().encode(s);
const clone=v=>structuredClone(v);
const request={
  schema:'SQUIRE2_PROJECT_REQUEST_V1',task_id:'desktop-codegen-synthetic',
  task_prompt:'Public synthetic desktop source request.',
  runtime_target:DESKTOP_TARGET,stage_target:'multifile-candidate'
};
const identity=()=>({
  status:'NOT_QUALIFIED',
  executable:{path:'/prospective/gjs',bytes:1,sha256:'a'.repeat(64)},
  typelibs:[{namespace:'Gtk',version:'4.0',typelib:'/prospective/Gtk.typelib',bytes:2,sha256:'b'.repeat(64)}],
  libraries:[{name:'gtk',path:'/prospective/libgtk.so',bytes:3,sha256:'c'.repeat(64)}]
});
const envelope=JSON.stringify({
  schema:'SQUIRE2_PROJECT_FILE_ENVELOPE_V1',
  files:[{
    path:'main.js',classification:'SOURCE',encoding:'utf-8',
    content:"import Gtk from 'gi://Gtk?version=4.0';\n// PRIVATE_SOURCE_SENTINEL\n"
  },{
    path:'assets/public.bin',classification:'LOCAL_ASSET',encoding:'base64',content:'AP8='
  }]
});
const jsonl=enc([
  {type:'turn.started'},
  {type:'item.completed',item:{type:'agent_message',text:envelope}},
  {type:'turn.completed',usage:{input_tokens:1,output_tokens:2,cached_input_tokens:0,reasoning_output_tokens:0}}
].map(v=>JSON.stringify(v)).join('\n')+'\n');
async function owned(fn){
  const root=await fs.mkdtemp(join(tmpdir(),'squire-desktop-codegen-'));
  await fs.chmod(root,0o700);
  try{return await fn(root);}
  finally{await fs.rm(root,{recursive:true,force:true});}
}
function runtime(){
  let time=100;
  const timers=[],calls=[],controller=new AbortController(),child=new EventEmitter();
  child.pid=123;child.unref=()=>{};child.kill=()=>true;
  for(const key of ['stdin','stdout','stderr']){
    child[key]=new EventEmitter();child[key].destroy=()=>{};
  }
  child.stdin.write=(bytes,callback)=>{callback();return true;};
  child.stdin.end=callback=>{
    callback();
    queueMicrotask(()=>{
      child.stdout.emit('data',jsonl);child.stdout.emit('end');
      child.stderr.emit('end');child.emit('exit',0,null);
    });
  };
  const clock={
    now:()=>time,
    schedule(delay,fn){
      const timer={at:time+delay,fn,active:true};timers.push(timer);
      return()=>{timer.active=false;};
    }
  };
  return {
    clock,controller,calls,timers,
    setTime(value){time=value;},
    spawn(...args){calls.push(args);queueMicrotask(()=>child.emit('spawn'));return child;}
  };
}
function inputs(scope){
  return {
    job_id:randomUUID(),scope,
    codex:{path:'/synthetic/codex',version:'0.160.0',bytes:1,sha256:'d'.repeat(64)},
    requested_model:'synthetic-desktop-model',effort:'medium',
    authorization:{
      operator_receipt:'/PRIVATE_OPERATOR_SENTINEL',
      supported_tuples:[{model:'synthetic-desktop-model',effort:'medium'}]
    },
    permissions:{sandbox:'read-only',approval_mode:'never',output_contract:'CODEX_JSONL_SINGLE_AGENT_V1'},
    desktop_runtime_identity:identity()
  };
}
function preparationPorts(){
  const files=new Map(),verified=[],writes=[],directories=new Set();
  for(const name of DESKTOP_CODEGEN_SOURCE_FILES){
    files.set(join(PROJECT_SOURCE_ROOT,name),enc('Public synthetic source '+name));
  }
  return {
    files,verified,writes,
    ports:{
      fs:{
        async readFile(path){
          assert.equal(path.startsWith('/prospective/'),false);
          if(!files.has(path))throw Error('PRIVATE_MISSING_SENTINEL');
          return new Uint8Array(files.get(path));
        },
        async mkdir(path,options){
          if(directories.has(path))throw Error('PRIVATE_EXISTS_SENTINEL');
          assert.equal(options.mode,0o700);directories.add(path);writes.push(path);
        },
        async writeFile(path,bytes,options){
          assert.equal(options.flag,'wx');assert.equal(options.mode,0o600);
          if(files.has(path))throw Error('PRIVATE_EXISTS_SENTINEL');
          files.set(path,new Uint8Array(bytes));writes.push(path);
        }
      },
      async verifyFile(pin){assert.equal(pin.path.startsWith('/prospective/'),false);verified.push(clone(pin));},
      retention:()=>({prepare:async()=>({capability_status:'READY'})}),
      observeDesktopRuntimeIdentity(){throw Error('PROSPECTIVE_IDENTITY_MUST_NOT_BE_OBSERVED');}
    }
  };
}
async function prepared(scope){
  const p=preparationPorts(),privateInputs=inputs(scope);
  const root='/synthetic/prepared-'+privateInputs.job_id;
  const ack=await prepareDesktopCodegenTask(root,'e'.repeat(40),request,privateInputs,p.ports);
  const configBytes=p.files.get(join(root,'config.json'));
  const config=validateDesktopCodegenConfig(parseReceiptJson(configBytes));
  const manifest=parseReceiptJson(p.files.get(join(root,'operation-manifest.json')));
  return {...p,privateInputs,root,ack,configBytes,config,manifest};
}
function proofFor(c,bytes){
  return {
    operation_config_sha256:hash(bytes),observed_at_ms:1000,
    provider_id:'native_codex',cli_version:c.codex.version,
    executable_sha256:c.codex.sha256,requested_model:c.requested_model,
    effort:c.effort,operator_receipt:c.authorization.operator_receipt,
    subscription:true,allowance_available:true,effective_provider:'openai_subscription',
    no_api_or_paid_fallback:true,sandbox:c.permissions.sandbox,
    approval_mode:c.permissions.approval_mode,output_contract:c.permissions.output_contract,
    installed_flags_verified:true
  };
}
async function fixture(root){
  const f=await prepared(join(root,'fresh-scope')),rt=runtime();
  let proof=proofFor(f.config,f.configBytes),retention='READY';
  const admission={
    provider_id:'native_codex',operator_receipt:f.config.authorization.operator_receipt,
    config_sha256:hash(f.configBytes),job_id:f.config.job_id,scope:f.config.scope,
    desktop_codegen_admitted:true,preflight:{evidence_receipt:'/synthetic/preflight'}
  };
  const verifies=[],reads=[];
  const ports={
    fs,spawn:rt.spawn,clock:rt.clock,now:()=>1000,uid:process.getuid(),
    reads:{lstat:fs.lstat,readChunks:async function*(){throw Error('NO_NATIVE_PIN_READ');}},
    async verifyFile(pin){
      verifies.push(clone(pin));
      assert.equal(pin.path.startsWith('/prospective/'),false);
      if(pin.path===NODE_RUNTIME.path){assert.deepEqual(canonicalBytes(pin),canonicalBytes(NODE_RUNTIME));return;}
      if(pin.path===f.config.codex.path){assert.deepEqual(canonicalBytes(pin),canonicalBytes(f.config.codex));return;}
      const bytes=f.files.get(pin.path);
      if(!bytes||bytes.length!==pin.bytes||hash(bytes)!==pin.sha256)throw Error('PRIVATE_SOURCE_PIN_SENTINEL');
    },
    async readBytes(path,cap){
      reads.push([path,cap]);
      const bytes=path==='/synthetic/preflight'?canonicalBytes(proof):f.files.get(path);
      if(!bytes||bytes.length>cap)throw Error('PRIVATE_READ_SENTINEL');
      return new Uint8Array(bytes);
    },
    retention:()=>({prepare:async()=>({capability_status:retention})}),
    environment:{
      PUBLIC:'synthetic',OPENAI_API_KEY:'PRIVATE_KEY_SENTINEL',
      CODEX_API_KEY:'PRIVATE_KEY_SENTINEL',OPENAI_BASE_URL:'PRIVATE_ENDPOINT_SENTINEL',
      GEMINI_API_KEY:'PRIVATE_KEY_SENTINEL',GOOGLE_API_KEY:'PRIVATE_KEY_SENTINEL',
      GOOGLE_GEMINI_BASE_URL:'PRIVATE_ENDPOINT_SENTINEL'
    }
  };
  return {
    ...f,rt,admission,ports,verifies,reads,
    setProof(value){proof=value;},getProof:()=>clone(proof),
    setRetention(value){retention=value;},
    rebind(config){
      this.config=config;this.configBytes=canonicalBytes(config);
      admission.config_sha256=hash(this.configBytes);
      admission.job_id=config.job_id;admission.scope=config.scope;
      // Preserve the prior valid profile even when the negative config omits
      // required fields. The SUT must perform the rejection, not this fixture.
      proof={...proof,operation_config_sha256:hash(this.configBytes)};
    },
    run(signal){return runProjectDesktopCodegenWithPorts(this.configBytes,admission,signal,ports);}
  };
}
async function cli(f,args=['--run-admitted-desktop-codegen','config','admission']){
  let out='',err='';
  const code=await runProjectEntrypointCli(args,{
    async readBytes(path){
      if(path==='config')return f.configBytes;
      if(path==='admission')return canonicalBytes(f.admission);
      throw Error('PRIVATE_CLI_READ_SENTINEL');
    },
    desktopCodegenPorts:f.ports,
    stdout:{write:value=>{out+=value;}},stderr:{write:value=>{err+=value;}}
  });
  return {code,out,err};
}

test('ChatGPT-only helper prepends one fixed global override and preserves the original profile',()=>{
  const data=inputs('/synthetic/profile');
  for(const approval_mode of ['never','on-request']){
    const spec={
      requested_model:data.requested_model,effort:data.effort,
      observed_cli_version:data.codex.version,prompt_bytes:enc('Public synthetic prompt.'),
      authorization:data.authorization,permissions:{...data.permissions,approval_mode}
    };
    const original=prepareCodexArgv(spec),restricted=prepareChatgptOnlyCodexArgv(spec);
    const expected=[
      '--ask-for-approval',approval_mode,'exec','--json','--ephemeral',
      '--sandbox','read-only','--model',data.requested_model,
      '-c','model_reasoning_effort="medium"','-'
    ];
    assert.deepEqual(original,{
      runtime_admitted:false,status:'PREPARED_NOT_EXECUTABLE',argv:expected
    });
    assert.deepEqual(restricted,{
      runtime_admitted:false,status:'PREPARED_NOT_EXECUTABLE',
      argv:['-c','forced_login_method="chatgpt"',...expected]
    });
    assert.equal(Object.isFrozen(restricted),true);
    assert.equal(Object.isFrozen(restricted.argv),true);
    assert.throws(()=>restricted.argv.push('--extra'));
    assert.throws(()=>{restricted.argv[1]='forced_login_method="api"';});
    assert.equal(restricted.argv.filter(value=>value.startsWith('forced_login_method=')).length,1);
    assert.equal(original.argv.some(value=>value.startsWith('forced_login_method=')),false);
    assert.deepEqual(prepareCodexArgv(spec),original);
    for(const extra of [
      {auth_method:'api'},{forced_login_method:'api'},{provider:'api'},
      {argv:['-c','forced_login_method="api"']},
      {extraargv:['-c','forced_login_method="api"']}
    ])assert.throws(()=>prepareChatgptOnlyCodexArgv({...spec,...extra}),e=>e.field==='codex_profile');
    for(const change of [
      s=>{s.permissions.sandbox='danger-full-access';},
      s=>{s.permissions.approval_mode='always';},
      s=>{s.permissions.output_contract='other';},
      s=>{s.authorization.supported_tuples=[];},
      s=>{s.observed_cli_version='0.159.0';},
      s=>{s.prompt_bytes=new Uint8Array();},
      s=>{s.prompt_bytes=new Uint8Array([0xff]);},
      s=>{s.prompt_bytes=enc('invalid\0prompt');}
    ]){
      const invalid=clone(spec);change(invalid);
      assert.throws(()=>prepareChatgptOnlyCodexArgv(invalid));
      assert.throws(()=>prepareCodexArgv(invalid));
    }
  }
});
test('scoped Codex environment deletes exactly the six declared keys without mutating ambient data',()=>{
  assert.deepEqual(CODEX_CHILD_ENV_DELETIONS,[
    'OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL',
    'GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GEMINI_BASE_URL'
  ]);
  const ambient=Object.freeze({
    PUBLIC:'synthetic',PATH:'/synthetic/bin',TMPDIR:'/synthetic/ambient-tmp',
    ...Object.fromEntries(CODEX_CHILD_ENV_DELETIONS.map(key=>[key,'PRIVATE_ENV_SENTINEL']))
  }),before=clone(ambient);
  const environment=codexEnvironment('/synthetic/scope',ambient);
  assert.deepEqual(environment,{
    PUBLIC:'synthetic',PATH:'/synthetic/bin',TMPDIR:'/synthetic/scope/.tmp'
  });
  assert.deepEqual(ambient,before);
  assert.notEqual(environment,ambient);
});
test('explicit preparation binds desktop data, full selected closure, actual launcher and profile',async()=>{
  const f=await prepared('/synthetic/scope-'+randomUUID());
  assert.equal(f.ack.schema,DESKTOP_CODEGEN_SCHEMA);
  assert.equal(f.ack.operation_intent,DESKTOP_CODEGEN_INTENT);
  assert.equal(f.ack.native_app_status,'NOT_QUALIFIED');
  assert.equal(f.ack.task_correctness,'NOT_EVALUATED');
  assert.equal(f.config.runtime_target,DESKTOP_TARGET);
  assert.deepEqual(canonicalBytes(f.config.prefix_identity),canonicalBytes(DESKTOP_PREFIX_IDENTITY));
  assert.deepEqual(canonicalBytes(f.config.desktop_runtime_identity),canonicalBytes(identity()));
  assert.deepEqual(canonicalBytes(f.manifest.selected_profile),canonicalBytes({
    provider_id:'native_codex',requested_model:f.config.requested_model,
    effort:f.config.effort,permissions:f.config.permissions
  }));
  assert.deepEqual(f.manifest.generation.executable,f.config.codex);
  assert.equal(f.manifest.operation_intent,DESKTOP_CODEGEN_INTENT);
  assert.equal(f.manifest.native_app_status,'NOT_QUALIFIED');
  assert.equal(f.manifest.config_sha256,hash(f.configBytes));
  assert.equal(f.ack.prompt_sha256,hash(buildProjectCodegenPrompt(request)));
  assert.equal(f.ack.prompt_bytes,buildProjectCodegenPrompt(request).length);
  assert.equal(f.verified.length,DESKTOP_CODEGEN_SOURCE_FILES.length+2);
  assert.equal(new Set(DESKTOP_CODEGEN_SOURCE_FILES).size,DESKTOP_CODEGEN_SOURCE_FILES.length);
  for(const name of PROJECT_SOURCE_FILES)assert.ok(DESKTOP_CODEGEN_SOURCE_FILES.includes(name));
  for(const name of ['src/project-result-receipt.mjs','src/project-summary.mjs']){
    assert.ok(DESKTOP_CODEGEN_SOURCE_FILES.includes(name));
  }
  assert.equal(JSON.stringify(f.ack).includes('/prospective/'),false);
  const before=new Map(f.files);
  await assert.rejects(prepareDesktopCodegenTask(f.root,'e'.repeat(40),request,f.privateInputs,f.ports));
  assert.deepEqual(f.files,before);
});
test('selected desktop source inventory covers the actual relative runtime import closure',async()=>{
  const inventory=new Set(DESKTOP_CODEGEN_SOURCE_FILES.map(name=>join(PROJECT_SOURCE_ROOT,name)));
  const queue=[
    join(PROJECT_SOURCE_ROOT,'acceptance/project-entrypoint.mjs'),
    join(PROJECT_SOURCE_ROOT,'acceptance/prepare-project-task.mjs')
  ],seen=new Set();
  while(queue.length){
    const path=queue.pop();if(seen.has(path))continue;seen.add(path);
    assert.ok(inventory.has(path),'Missing active source inventory entry: '+path);
    const text=await fs.readFile(path,'utf8');
    const imports=/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/g;
    for(const match of text.matchAll(imports)){
      const imported=resolve(dirname(path),match[1]);
      assert.ok(inventory.has(imported),'Missing active source inventory entry: '+imported);
      queue.push(imported);
    }
  }
});
test('preparation rejects wrong target, missing identity and unsupported explicit profiles before writes',async()=>{
  for(const change of [
    p=>{delete p.desktop_runtime_identity;},
    p=>{p.desktop_runtime_identity.status='QUALIFIED';},
    p=>{delete p.effort;},
    p=>{delete p.requested_model;},
    p=>{delete p.permissions;},
    p=>{p.permissions.sandbox='danger-full-access';},
    p=>{p.permissions.approval_mode='always';},
    p=>{p.permissions.output_contract='other';},
    p=>{p.authorization.supported_tuples=[];},
    p=>{p.codex.version='0.159.0';},
    p=>{p.codex.path=p.desktop_runtime_identity.executable.path;},
    p=>{p.codex.path=NODE_RUNTIME.path;},
    p=>{p.desktop_runtime_identity.executable={...NODE_RUNTIME};},
    p=>{p.auth_method='api';},
    p=>{p.forced_login_method='api';},
    p=>{p.provider='api';},
    p=>{p.argv=['-c','forced_login_method="api"'];},
    p=>{p.extraargv=['-c','forced_login_method="api"'];}
  ]){
    const p=preparationPorts(),data=inputs('/synthetic/scope-'+randomUUID());change(data);
    await assert.rejects(prepareDesktopCodegenTask('/synthetic/new-'+randomUUID(),'e'.repeat(40),request,data,p.ports));
    assert.deepEqual(p.writes,[]);
  }
  const p=preparationPorts();
  await assert.rejects(prepareDesktopCodegenTask('/synthetic/new','e'.repeat(40),{...request,runtime_target:'node24-esm'},inputs('/synthetic/scope'),p.ports));
  assert.deepEqual(p.writes,[]);
  await assert.rejects(runProjectPreparationCli(['--prepare-desktop-codegen','missing']));
});
test('pure builder forwards exact target, prefix, identity, Codex pin and read-only argv intent',async()=>{
  const f=await prepared('/synthetic/scope-'+randomUUID());
  const invocation=buildDesktopCodegenInvocation(f.config,buildProjectCodegenPrompt(request));
  assert.equal(invocation.mode,'DESKTOP_CODEGEN_ONLY');
  assert.equal(invocation.operation_intent,DESKTOP_CODEGEN_INTENT);
  assert.equal(invocation.specification.runtime_target,DESKTOP_TARGET);
  assert.deepEqual(invocation.specification.prefix_identity,DESKTOP_PREFIX_IDENTITY);
  assert.deepEqual(canonicalBytes(invocation.specification.desktop_runtime_identity),canonicalBytes(identity()));
  assert.equal(invocation.executable,f.config.codex.path);
  assert.notEqual(invocation.executable,NODE_RUNTIME.path);
  assert.notEqual(invocation.executable,identity().executable.path);
  assert.deepEqual(prepareChatgptOnlyCodexArgv({
    ...invocation.codex,requested_model:f.config.requested_model,
    effort:f.config.effort,prompt_bytes:invocation.specification.prompt_bytes
  }).argv,f.manifest.generation.argv);
  assert.throws(()=>buildDesktopCodegenInvocation(f.config,enc('PRIVATE_WRONG_PROMPT_SENTINEL')));
  assert.equal(runProjectDesktopCodegenNative.length,3);
});
test('pure builder rejects malformed and proxy prompt inputs without invoking caller traps',async()=>{
  const f=await prepared('/synthetic/builder-rejection-'+randomUUID());
  let accesses=0;
  const forbidden=()=>{accesses++;throw Error('PRIVATE_PROMPT_ACCESSOR_SENTINEL');};
  const malformed={};
  for(const key of ['length','byteLength',Symbol.iterator]){
    Object.defineProperty(malformed,key,{get:forbidden});
  }
  const proxy=new Proxy(buildProjectCodegenPrompt(request),{
    get:forbidden,ownKeys:forbidden,
    getOwnPropertyDescriptor:forbidden,getPrototypeOf:forbidden
  });
  for(const value of [
    undefined,null,1,'prompt',[],{},malformed,
    new DataView(new ArrayBuffer(8)),proxy
  ]){
    assert.throws(()=>buildDesktopCodegenInvocation(f.config,value));
    assert.equal(accesses,0);
  }
  const wrong=buildProjectCodegenPrompt(request);
  wrong[wrong.length-1]^=1;
  assert.throws(()=>buildDesktopCodegenInvocation(f.config,wrong),/PROMPT_CHANGED/);
  assert.throws(()=>buildDesktopCodegenInvocation(f.config,enc('wrong')),/PROMPT_CHANGED/);
  assert.equal(accesses,0);
  const valid=buildProjectCodegenPrompt(request);
  const invocation=buildDesktopCodegenInvocation(f.config,valid);
  assert.deepEqual(invocation.specification.prompt_bytes,valid);
  assert.equal(hash(invocation.specification.prompt_bytes),f.config.prompt.sha256);
});
test('pure builder snapshots intrinsic prompt bytes without own length, byteLength or iterator access',async()=>{
  const f=await prepared('/synthetic/builder-snapshot-'+randomUUID());
  for(const keys of [
    ['length'],['byteLength'],[Symbol.iterator],
    ['length','byteLength',Symbol.iterator]
  ]){
    let accesses=0;
    const bytes=buildProjectCodegenPrompt(request);
    const expected=new Uint8Array(bytes);
    for(const key of keys){
      Object.defineProperty(bytes,key,{
        configurable:true,
        get(){accesses++;throw Error('PRIVATE_PROMPT_ACCESSOR_SENTINEL');}
      });
    }
    const invocation=buildDesktopCodegenInvocation(f.config,bytes);
    assert.equal(accesses,0);
    assert.deepEqual(invocation.specification.prompt_bytes,expected);
    assert.equal(hash(invocation.specification.prompt_bytes),f.config.prompt.sha256);
    Uint8Array.prototype.fill.call(bytes,0);
    assert.deepEqual(invocation.specification.prompt_bytes,expected);
    assert.equal(accesses,0);
  }
});
test('native-like injected producer persists exact envelope and full physical stage ACK with one invocation',async()=>owned(async root=>{
  const f=await fixture(root),ambient=clone(f.ports.environment);
  Object.freeze(f.ports.environment);
  const r=await f.run();
  assert.equal(r.status,'CANDIDATE_STAGED');
  assert.equal(r.operator_admitted,true);
  assert.equal(r.runtime_admitted,false);
  assert.equal(r.task_correctness,'NOT_EVALUATED');
  assert.equal(r.task_outcome_evaluated,false);
  assert.equal(r.direct_child_invocations.generation,1);
  assert.equal(f.rt.calls.length,1);
  const [exe,argv,options]=f.rt.calls[0];
  assert.equal(exe,f.config.codex.path);
  assert.deepEqual(argv,f.manifest.generation.argv);
  const invocation=buildDesktopCodegenInvocation(f.config,buildProjectCodegenPrompt(request));
  const original=prepareCodexArgv({
    ...invocation.codex,requested_model:invocation.specification.requested_model,
    effort:invocation.specification.effort,prompt_bytes:invocation.specification.prompt_bytes
  });
  assert.deepEqual(argv,['-c','forced_login_method="chatgpt"',...original.argv]);
  assert.deepEqual(argv,prepareChatgptOnlyCodexArgv({
    ...invocation.codex,requested_model:invocation.specification.requested_model,
    effort:invocation.specification.effort,prompt_bytes:invocation.specification.prompt_bytes
  }).argv);
  assert.equal(argv.filter(value=>value.startsWith('forced_login_method=')).length,1);
  assert.equal(options.shell,false);
  for(const key of CODEX_CHILD_ENV_DELETIONS){
    assert.equal(Object.hasOwn(options.env,key),false);
  }
  assert.equal(options.env.PUBLIC,'synthetic');
  assert.equal(options.env.TMPDIR,join(f.config.scope,'.tmp'));
  assert.deepEqual(options.env,codexEnvironment(f.config.scope,ambient));
  assert.deepEqual(f.ports.environment,ambient);
  assert.equal(await fs.readFile(r.generation.record.output_custody.path,'utf8'),envelope);
  assert.equal(r.generation.record.output_custody.byte_count,enc(envelope).length);
  assert.equal(r.staging.completion_status,'COMPLETE');
  assert.equal(r.staging.operation_acknowledgement,'ACKNOWLEDGED');
  const stage=join(f.config.scope,'output','run-'+f.config.job_id,'stage');
  assert.equal((await verifyStage(stage,{fs,uid:process.getuid()})).status,'VERIFIED');
  assert.deepEqual(await fs.readFile(join(stage,'assets/public.bin')),Buffer.from([0,255]));
  assert.equal((await fs.stat(join(stage,'main.js'))).mode&0o777,0o400);
  assert.equal(JSON.stringify(r).includes('PRIVATE_SOURCE_SENTINEL'),false);
  assert.equal(f.verifies.length,DESKTOP_CODEGEN_SOURCE_FILES.length+3);
  await assert.rejects(f.run(),/NATIVE_OPERATION_ALREADY_CONSUMED/);
  assert.equal(f.rt.calls.length,1);
}));
test('codegen admission is closed, exact-byte-bound and distinct from old project and receipt admission',async()=>{
  const f=await prepared('/synthetic/scope-'+randomUUID());
  const a={
    provider_id:'native_codex',operator_receipt:f.config.authorization.operator_receipt,
    config_sha256:hash(f.configBytes),job_id:f.config.job_id,scope:f.config.scope,
    desktop_codegen_admitted:true,preflight:{evidence_receipt:'/synthetic/proof'}
  };
  assert.equal(validateDesktopCodegenAdmission(a,f.configBytes).desktop_codegen_admitted,true);
  assert.equal(validateDesktopCodegenAdmission(a,f.configBytes).desktop_codegen_admitted,true);
  assert.throws(()=>requireProjectCodexAdmission(a,f.config,f.configBytes));
  assert.throws(()=>validateProjectReceiptDestination({},f.configBytes,a));
  assert.throws(()=>validateProjectCodexConfig(f.config));
  assert.throws(()=>requireDesktopCodegenAdmission(a,{...f.config,scope:'/synthetic/different'},f.configBytes));
  for(const change of [
    {desktop_codegen_admitted:false},{project_admitted:true},{provider_id:'other'},
    {operator_receipt:'/other'},{config_sha256:'0'.repeat(64)},
    {job_id:randomUUID()},{scope:'/other'},{preflight:{evidence_receipt:'relative'}}
  ])assert.throws(()=>validateDesktopCodegenAdmission({...a,...change},f.configBytes));
  assert.throws(()=>validateDesktopCodegenAdmission(a,enc(new TextDecoder().decode(f.configBytes)+'\n')));
  assert.equal(requireDesktopCodegenAdmission(a,f.config,f.configBytes).desktop_codegen_admitted,true);
  assert.throws(()=>requireDesktopCodegenAdmission(a,f.config,f.configBytes),/NATIVE_OPERATION_ALREADY_CONSUMED/);
});
test('missing or mismatched admission rejects with zero dispatch and no scope creation',async()=>{
  for(const change of [
    a=>null,a=>({...a,desktop_codegen_admitted:false}),
    a=>({...a,project_admitted:true}),a=>({...a,scope:'/different'}),
    a=>({...a,job_id:randomUUID()}),a=>({...a,config_sha256:'0'.repeat(64)}),
    a=>({...a,operator_receipt:'/PRIVATE_WRONG_SENTINEL'}),
    a=>({...a,preflight:{evidence_receipt:'relative'}})
  ])await owned(async root=>{
    const f=await fixture(root);
    await assert.rejects(runProjectDesktopCodegenWithPorts(f.configBytes,change(f.admission),undefined,f.ports));
    assert.equal(f.rt.calls.length,0);assert.deepEqual(await fs.readdir(root),[]);
  });
});
test('unsupported configs fail before generation even with a newly matching admission digest',async()=>{
  for(const change of [
    c=>{delete c.operation_intent;},
    c=>{c.operation_intent='EXECUTE_DESKTOP';},
    c=>{c.schema='SQUIRE2_PROJECT_OPERATION_V1';},
    c=>{c.runtime_target='node24-esm';},
    c=>{delete c.runtime_target;},
    c=>{c.prefix_identity=PROJECT_PREFIX_IDENTITY;},
    c=>{c.desktop_runtime_identity.status='QUALIFIED';},
    c=>{delete c.permissions;},
    c=>{c.permissions.approval_mode='unsupported';},
    c=>{c.permissions.sandbox='danger-full-access';},
    c=>{c.requested_model='unsupported';},
    c=>{c.codex.version='wrong';},
    c=>{c.codex.path=c.desktop_runtime_identity.executable.path;},
    c=>{c.node.sha256='0'.repeat(64);},
    c=>{c.source_pins={};},
    c=>{c.max_direct_child_spawns=2;},
    c=>{c.generation_wall_ms=120001;},
    c=>{c.outer_observation_ms=140001;},
    c=>{c.diagnostic_retention={};},
    c=>{c.auth_method='api';},
    c=>{c.forced_login_method='api';},
    c=>{c.provider='api';},
    c=>{c.argv=['-c','forced_login_method="api"'];},
    c=>{c.extraargv=['-c','forced_login_method="api"'];}
  ])await owned(async root=>{
    const f=await fixture(root),c=clone(f.config);change(c);f.rebind(c);
    await assert.rejects(f.run());
    assert.equal(f.rt.calls.length,0);assert.deepEqual(await fs.readdir(root),[]);
  });
});
test('desktop runner rejects unsupported profiles, prompts and caller auth overrides before dispatch',async()=>owned(async root=>{
  const f=await prepared(root);
  const invocation=buildDesktopCodegenInvocation(f.config,buildProjectCodegenPrompt(request));
  for(const change of [
    (s,c)=>{c.permissions.sandbox='danger-full-access';},
    (s,c)=>{c.permissions.approval_mode='always';},
    (s,c)=>{c.permissions.output_contract='other';},
    (s,c)=>{c.authorization.supported_tuples=[];},
    (s,c)=>{c.observed_cli_version='0.159.0';},
    s=>{s.prompt_bytes=new Uint8Array();},
    s=>{s.prompt_bytes=enc('wrong prefix');},
    (s,c)=>{c.auth_method='api';},
    (s,c)=>{c.forced_login_method='api';},
    (s,c)=>{c.provider='api';},
    (s,c)=>{c.argv=['-c','forced_login_method="api"'];},
    (s,c)=>{c.extraargv=['-c','forced_login_method="api"'];}
  ]){
    const spec=clone(invocation.specification),codex=clone(invocation.codex),rt=runtime();
    change(spec,codex);
    await assert.rejects(runProjectCodexTask(spec,{
      clock:rt.clock,shutdown:GENERATION_SHUTDOWN,abortSignal:rt.controller.signal
    },{
      mode:invocation.mode,operation_intent:invocation.operation_intent,
      executable:invocation.executable,codex,fs,uid:process.getuid(),spawn:rt.spawn
    }));
    assert.equal(rt.calls.length,0);
    assert.deepEqual(await fs.readdir(root),[]);
  }
}));
test('unchanged effective preflight validator rejects every mismatched proof field before dispatch',async()=>{
  const mutations={
    operation_config_sha256:'0'.repeat(64),observed_at_ms:301001,provider_id:'other',
    cli_version:'wrong',executable_sha256:'0'.repeat(64),requested_model:'other',
    effort:'other',operator_receipt:'/PRIVATE_WRONG_SENTINEL',subscription:false,
    allowance_available:false,effective_provider:'api',no_api_or_paid_fallback:false,
    sandbox:'danger-full-access',approval_mode:'on-request',output_contract:'other',
    installed_flags_verified:false
  };
  for(const [key,value]of Object.entries(mutations))await owned(async root=>{
    const f=await fixture(root),proof={...f.getProof(),[key]:value};
    assert.throws(()=>validateCodexPreflight(proof,f.config,f.configBytes,1000));
    f.setProof(proof);await assert.rejects(f.run());
    assert.equal(f.rt.calls.length,0);assert.deepEqual(await fs.readdir(root),[]);
  });
  for(const proofChange of [
    p=>{p.observed_at_ms=1001;},
    p=>{p.observed_at_ms=0;},
    p=>{delete p.no_api_or_paid_fallback;},
    p=>{p.extra=true;}
  ])await owned(async root=>{
    const f=await fixture(root),p=f.getProof();proofChange(p);
    if(p.observed_at_ms===0)f.ports.now=()=>300001;
    f.setProof(p);await assert.rejects(f.run());
    assert.equal(f.rt.calls.length,0);
  });
});
test('changed source/prompt, unavailable retention and existing scope reject without a child',async()=>{
  for(const kind of ['source','prompt','retention','scope'])await owned(async root=>{
    const f=await fixture(root);
    if(kind==='source')f.files.set(Object.keys(f.config.source_pins)[0],enc('PRIVATE_CHANGED_SENTINEL'));
    if(kind==='prompt')f.files.set(f.config.prompt.path,enc('PRIVATE_CHANGED_SENTINEL'));
    if(kind==='retention')f.setRetention('UNAVAILABLE');
    if(kind==='scope'){
      await fs.mkdir(f.config.scope,{mode:0o700});
      await fs.writeFile(join(f.config.scope,'sentinel'),'owned existing bytes',{flag:'wx',mode:0o600});
    }
    await assert.rejects(f.run());assert.equal(f.rt.calls.length,0);
    if(kind==='scope')assert.equal(await fs.readFile(join(f.config.scope,'sentinel'),'utf8'),'owned existing bytes');
    else assert.deepEqual(await fs.readdir(root),[]);
  });
});
test('old Node, desktop simulation, old native admission and default entrypoint semantics remain separate',async()=>owned(async root=>{
  const f=await fixture(root),c=f.config;
  const spec=buildDesktopCodegenInvocation(c,buildProjectCodegenPrompt(request)).specification;
  const {prefix_identity,...legacySpec}=spec;
  assert.equal(admitProjectCodexTask(legacySpec).runtime_target,DESKTOP_TARGET);
  assert.throws(()=>admitProjectCodexTask(spec));
  await assert.rejects(runProjectCodexTask(legacySpec,{},{
    mode:'NATIVE',executable:c.codex.path,spawn(){throw Error('MUST_NOT_DISPATCH');}
  }),e=>e.field==='desktop_source_only');
  await assert.rejects(runProjectOneCaseNative(f.configBytes,f.admission));
  const oldConfig={...clone(c),schema:'SQUIRE2_PROJECT_OPERATION_V1'};
  delete oldConfig.operation_intent;
  const oldPins=new Set(PROJECT_SOURCE_FILES.map(n=>join(PROJECT_SOURCE_ROOT,n)));
  oldConfig.source_pins=Object.fromEntries(Object.entries(oldConfig.source_pins).filter(([p])=>oldPins.has(p)));
  validateProjectCodexConfig(oldConfig);
  assert.throws(()=>requireProjectCodexAdmission({
    provider_id:'native_codex',operator_receipt:c.authorization.operator_receipt,
    config_sha256:hash(canonicalBytes(oldConfig)),job_id:c.job_id,scope:c.scope,
    project_admitted:true,preflight:{evidence_receipt:'/synthetic/proof'}
  },oldConfig,canonicalBytes(oldConfig)),e=>e.field==='desktop_native_disabled');
  const rt=runtime();
  const simulated=await runProjectCodexTask({...legacySpec,task_scope:root,job_id:randomUUID()},
    {clock:rt.clock,shutdown:GENERATION_SHUTDOWN,abortSignal:rt.controller.signal},
    {mode:'SOURCE_SIMULATION',fs,uid:process.getuid(),spawn:rt.spawn,executable:c.codex.path,
      codex:{observed_cli_version:c.codex.version,authorization:c.authorization,permissions:c.permissions}});
  assert.equal(simulated.status,'CANDIDATE_STAGED');assert.equal(rt.calls.length,1);
  assert.deepEqual(rt.calls[0][1],prepareCodexArgv({
    observed_cli_version:c.codex.version,authorization:c.authorization,permissions:c.permissions,
    requested_model:legacySpec.requested_model,effort:legacySpec.effort,
    prompt_bytes:legacySpec.prompt_bytes
  }).argv);
  assert.equal(rt.calls[0][1].some(value=>value.startsWith('forced_login_method=')),false);
  assert.equal(projectEntrypointMode([]),'DRY_RUN_NATIVE_DISABLED');
  assert.equal(projectEntrypointMode(['--run-admitted','c','a']),'EXPLICIT_ADMISSION_REQUIRED');
  assert.equal(projectEntrypointMode(['--run-admitted-desktop-codegen','c','a']),'DRY_RUN_NATIVE_DISABLED');
  assert.equal(desktopCodegenEntrypointMode(['--run-admitted-desktop-codegen','c','a']),'EXPLICIT_DESKTOP_CODEGEN_ADMISSION_REQUIRED');
  assert.equal(f.rt.calls.length,0);
}));
test('legacy Node preparation still omits desktop and operation fields',async()=>{
  const p=preparationPorts(),data=inputs('/synthetic/node-'+randomUUID());
  delete data.desktop_runtime_identity;
  const root='/synthetic/node-prepared-'+randomUUID();
  await prepareProjectCodexTask(root,'e'.repeat(40),{...request,runtime_target:'node24-esm'},data,p.ports);
  const c=validateProjectCodexConfig(parseReceiptJson(p.files.get(join(root,'config.json'))));
  for(const key of ['runtime_target','prefix_identity','desktop_runtime_identity','operation_intent']){
    assert.equal(Object.hasOwn(c,key),false);
  }
  assert.equal(c.schema,'SQUIRE2_PROJECT_OPERATION_V1');
  const manifest=parseReceiptJson(p.files.get(join(root,'operation-manifest.json')));
  assert.deepEqual(manifest.generation.argv,prepareCodexArgv({
    requested_model:data.requested_model,effort:data.effort,
    observed_cli_version:data.codex.version,authorization:data.authorization,
    permissions:data.permissions,prompt_bytes:buildProjectCodegenPrompt({...request,runtime_target:'node24-esm'})
  }).argv);
  assert.equal(manifest.generation.argv.some(value=>value.startsWith('forced_login_method=')),false);
});
test('original Node runner keeps its original argv without a desktop auth override',async()=>owned(async root=>{
  const data=inputs(root),rt=runtime();
  const spec={
    job_id:data.job_id,task_scope:root,requested_model:data.requested_model,
    effort:data.effort,max_wall_clock_sec:120,
    prompt_bytes:buildProjectCodegenPrompt({...request,runtime_target:'node24-esm'})
  };
  const codex={
    observed_cli_version:data.codex.version,
    authorization:data.authorization,permissions:data.permissions
  };
  const result=await runProjectCodexTask(spec,{
    clock:rt.clock,shutdown:GENERATION_SHUTDOWN,abortSignal:rt.controller.signal
  },{
    fs,uid:process.getuid(),spawn:rt.spawn,executable:data.codex.path,codex
  });
  assert.equal(result.status,'CANDIDATE_STAGED');
  assert.equal(rt.calls.length,1);
  assert.deepEqual(rt.calls[0][1],prepareCodexArgv({
    ...codex,requested_model:spec.requested_model,effort:spec.effort,prompt_bytes:spec.prompt_bytes
  }).argv);
  assert.equal(rt.calls[0][1].some(value=>value.startsWith('forced_login_method=')),false);
}));
test('CLI emits only a bounded path-free codegen acknowledgement, exits one and refuses replay',async()=>owned(async root=>{
  const f=await fixture(root),r=await cli(f);
  assert.equal(r.code,1);assert.equal(r.err,'');
  assert.deepEqual(JSON.parse(r.out),{
    schema:'SQUIRE2_DESKTOP_CODEGEN_ACK_V1',status:'CANDIDATE_STAGED',
    task_correctness:'NOT_EVALUATED',native_app_status:'NOT_QUALIFIED'
  });
  for(const secret of [root,f.config.job_id,'PRIVATE','/prospective/','operator_receipt']){
    assert.equal((r.out+r.err).includes(secret),false);
  }
  assert.deepEqual(await cli(f),{
    code:2,out:'',err:'DESKTOP_CODEGEN_ADMISSION_OR_OPERATION_FAILED\n'
  });
  assert.equal(f.rt.calls.length,1);
}));
test('new CLI malformed arity, admission and native errors use fixed output and never dispatch',async()=>{
  for(const args of [
    ['--run-admitted-desktop-codegen'],
    ['--run-admitted-desktop-codegen','config'],
    ['--run-admitted-desktop-codegen','config','admission','extra'],
    ['--run-admitted-desktop-codegen','','admission']
  ])await owned(async root=>{
    const f=await fixture(root),r=await cli(f,args);
    assert.deepEqual(r,{code:2,out:'',err:'DESKTOP_CODEGEN_ADMISSION_OR_OPERATION_FAILED\n'});
    assert.equal(f.rt.calls.length,0);
  });
  await owned(async root=>{
    const f=await fixture(root);f.admission.operator_receipt='/PRIVATE_MISMATCH_SENTINEL';
    assert.deepEqual(await cli(f),{code:2,out:'',err:'DESKTOP_CODEGEN_ADMISSION_OR_OPERATION_FAILED\n'});
    assert.equal(f.rt.calls.length,0);
  });
});
test('existing stage preserves bytes, exact envelope custody and honest quarantine without retry',async()=>owned(async root=>{
  const f=await fixture(root);
  f.ports.fs={...fs,async mkdir(path,...args){
    const result=await fs.mkdir(path,...args);
    if(path.endsWith('run-'+f.config.job_id)){
      await fs.mkdir(join(path,'stage'),{mode:0o700});
      await fs.writeFile(join(path,'stage','sentinel'),'PRIVATE_EXISTING_SENTINEL',{flag:'wx',mode:0o600});
    }
    return result;
  }};
  const r=await f.run();
  assert.equal(r.status,'STAGING_REJECTED');assert.equal(r.staging,null);
  assert.equal(r.workspace_disposition,'QUARANTINED');
  assert.equal(r.generation.record.output_custody.persisted,true);
  const stage=join(f.config.scope,'output','run-'+f.config.job_id,'stage');
  assert.equal(await fs.readFile(join(stage,'sentinel'),'utf8'),'PRIVATE_EXISTING_SENTINEL');
  assert.equal(f.rt.calls.length,1);
  await assert.rejects(f.run());assert.equal(f.rt.calls.length,1);
}));
test('partial envelope write keeps the partial leaf, rejects persistence and emits no raw error',async()=>owned(async root=>{
  const f=await fixture(root);
  f.ports.fs={...fs,async open(path,...args){
    const handle=await fs.open(path,...args);
    if(!path.endsWith('candidate-envelope.json'))return handle;
    return new Proxy(handle,{get(target,key){
      if(key==='writeFile')return async bytes=>{
        await target.writeFile(bytes.subarray(0,8));throw Error('PRIVATE_PARTIAL_WRITE_SENTINEL');
      };
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
  }};
  const result=await cli(f);
  assert.deepEqual(result,{code:2,out:'',err:'DESKTOP_CODEGEN_ADMISSION_OR_OPERATION_FAILED\n'});
  const path=join(f.config.scope,'output','run-'+f.config.job_id,'candidate-envelope.json');
  assert.equal((await fs.stat(path)).size,8);
  assert.equal(f.rt.calls.length,1);
  assert.deepEqual(await fs.readdir(dirname(path)),['candidate-envelope.json']);
}));
test('abort before dispatch is inert and a late staging acknowledgement cannot reopen a canceled result',async()=>{
  await owned(async root=>{
    const f=await fixture(root),controller=new AbortController();controller.abort();
    await assert.rejects(f.run(controller.signal));
    assert.equal(f.rt.calls.length,0);assert.deepEqual(await fs.readdir(root),[]);
  });
  await owned(async root=>{
    const f=await fixture(root),controller=new AbortController();
    let enter,release,closed;
    const entered=new Promise(resolve=>{enter=resolve;});
    const blocked=new Promise(resolve=>{release=resolve;});
    const settled=new Promise(resolve=>{closed=resolve;});
    f.ports.fs={...fs,async open(path,...args){
      if(!path.endsWith('/stage/main.js'))return fs.open(path,...args);
      enter();await blocked;
      const handle=await fs.open(path,...args);
      return new Proxy(handle,{get(target,key){
        if(key==='close')return async()=>{try{await target.close();}finally{closed();}};
        const value=target[key];return typeof value==='function'?value.bind(target):value;
      }});
    }};
    const pending=f.run(controller.signal);await entered;controller.abort();
    const r=await pending;
    assert.equal(r.status,'INCOMPLETE');assert.equal(r.staging,null);
    assert.equal(r.workspace_disposition,'QUARANTINED');
    release();await settled;
    assert.equal(r.status,'INCOMPLETE');assert.equal(r.staging,null);
    assert.equal(f.rt.calls.length,1);
    await assert.rejects(f.run());assert.equal(f.rt.calls.length,1);
  });
});
test('original observation deadline includes pending staging and retains a physical late ACK only as history',async()=>owned(async root=>{
  const f=await fixture(root);
  f.ports.fs={...fs,async lstat(path,...args){
    const stat=await fs.lstat(path,...args);
    if(path.endsWith('/stage/stage-manifest.json'))f.rt.setTime(140100);
    return stat;
  }};
  // Expire during final stage verification or final result checking. Neither
  // path may claim a usable candidate or authorize replay.
  const r=await f.run();
  assert.notEqual(r.status,'CANDIDATE_STAGED');
  assert.equal(r.workspace_disposition,'QUARANTINED');
  assert.equal(r.task_correctness,'NOT_EVALUATED');
  assert.equal(f.rt.calls.length,1);
  await assert.rejects(f.run());
}));
