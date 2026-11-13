import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {parse} from 'acorn';
import {
  PROJECT_CODING_OBSERVATION_PROFILE,
  PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA,
  PROJECT_LARGE_OBSERVATION_TASK_CLASS,
  PROJECT_OUTPUT_LARGE_PROFILE as LARGE_PROFILE
} from '../src/project-coding-profile.mjs';
import {
  createNativeProjectResultReceipt,createNativeProjectLargeObservationResultReceipt
} from '../src/project-result-receipt.mjs';
import {
  planStaging,writeStage,verifyStage,
  planLargeProjectStaging,
  writeLargeProjectStage,
  verifyLargeProjectStage
} from '../src/multifile-staging.mjs';
import {
  buildStandardProjectReviewCandidate,buildStandardProjectReviewCandidateNative,
  buildStandardProjectRevisionCandidate,buildStandardProjectRevisionCandidateNative,
  buildProjectReviewCandidate,
  buildProjectReviewCandidateNative,
  buildProjectRevisionCandidate,
  buildProjectRevisionCandidateNative
} from '../src/project-review-candidate.mjs';
import {buildProjectCandidateReviewPackage,verifyProjectCandidateReviewPackage,recordProjectCandidateDecision} from '../src/project-candidate-review-package.mjs';
import {buildProjectRevisionReviewPackage,verifyProjectRevisionReviewPackage,recordProjectRevisionDecision,verifyProjectRevisionDecision} from '../src/project-revision-review-package.mjs';
import {runProjectReviewCandidateCli} from '../bin/squire-project-review.mjs';

const GIT='/usr/bin/git';
const MAX_GIT_BUFFER=4*1024*1024+65536;
const utf8=new TextEncoder();
const fatalUtf8=new TextDecoder('utf-8',{fatal:true});
const hashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
const sha1Git=(type,bytes)=>createHash('sha1')
  .update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const uid=process.getuid();
const gitCallTraces=new WeakMap();
const fixtureFs=Object.freeze({
  open:(...args)=>fs.open(...args),
  mkdir:(...args)=>fs.mkdir(...args),
  lstat:(...args)=>fs.lstat(...args),
  chmod:(...args)=>fs.chmod(...args),
  readdir:(...args)=>fs.readdir(...args),
  realpath:(...args)=>fs.realpath(...args)
});

// All Git calls in these tests are fixed plumbing commands against repositories
// created under an owned temporary directory. No shell, hooks, filters, or network.
const cleanGitEnv=Object.freeze({
  PATH:'/usr/bin:/bin',
  LANG:'C',
  LC_ALL:'C',
  GIT_CONFIG_NOSYSTEM:'1',
  GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_TERMINAL_PROMPT:'0',
  GIT_OPTIONAL_LOCKS:'0',
  GIT_ALLOW_PROTOCOL:'',
  GIT_AUTHOR_NAME:'Squire Test Fixture',
  GIT_AUTHOR_EMAIL:'squire-test@example.invalid',
  GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME:'Squire Test Fixture',
  GIT_COMMITTER_EMAIL:'squire-test@example.invalid',
  GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'
});
const gitConfigArgs=[
  '-c','core.hooksPath=/dev/null',
  '-c','core.attributesFile=/dev/null',
  '-c','core.fsmonitor=false',
  '-c','core.autocrlf=false',
  '-c','core.pager=cat',
  '-c','protocol.allow=never',
  '-c','commit.gpgSign=false'
];

function runGit(gitDir,args,{input,allowStatus=[]}={}){
  try{
    return execFileSync(GIT,[...gitConfigArgs,`--git-dir=${gitDir}`,...args],{
      cwd:gitDir,
      env:cleanGitEnv,
      input,
      encoding:'buffer',
      maxBuffer:MAX_GIT_BUFFER,
      stdio:['pipe','pipe','pipe']
    });
  }catch(error){
    if(allowStatus.includes(error.status))return error.stdout??Buffer.alloc(0);
    throw error;
  }
}

function initGitDir(gitDir,bare=true){
  execFileSync(GIT,[...gitConfigArgs,'init',...(bare?['--bare']:[]),
    '--shared=0600','--quiet','--template=/dev/null','--object-format=sha1',gitDir],{
    cwd:dirname(gitDir),env:cleanGitEnv,encoding:'buffer',maxBuffer:65536,
    stdio:['ignore','pipe','pipe']
  });
}

function writeGitBlob(gitDir,bytes){
  return runGit(gitDir,['hash-object','-w','--stdin','--no-filters'],{
    input:Buffer.from(bytes)
  }).toString('ascii').trim();
}

function treeRows(entries){
  const root={dirs:new Map(),files:[]};
  for(const entry of entries){
    const parts=entry.path.split('/');
    let current=root;
    for(const part of parts.slice(0,-1)){
      if(!current.dirs.has(part))current.dirs.set(part,{dirs:new Map(),files:[]});
      current=current.dirs.get(part);
    }
    current.files.push({...entry,name:parts.at(-1)});
  }
  return root;
}

function writeGitTree(gitDir,entries){
  const root=treeRows(entries);
  const build=node=>{
    const rows=[];
    for(const [name,child] of node.dirs){
      rows.push({name,sortName:`${name}/`,mode:'040000',type:'tree',oid:build(child)});
    }
    for(const entry of node.files){
      rows.push({name:entry.name,sortName:entry.name,mode:entry.mode??'100644',
        type:entry.type??'blob',oid:entry.oid});
    }
    rows.sort((a,b)=>Buffer.compare(Buffer.from(a.sortName),Buffer.from(b.sortName)));
    const input=Buffer.concat(rows.map(row=>Buffer.from(
      `${row.mode} ${row.type} ${row.oid}\t${row.name}\0`
    )));
    return runGit(gitDir,['mktree','-z'],{input}).toString('ascii').trim();
  };
  return build(root);
}

function writeGitCommit(gitDir,tree,parent=null,message='Squire test base'){
  const args=['commit-tree',tree];
  if(parent)args.push('-p',parent);
  args.push('-m',message);
  return runGit(gitDir,args).toString('ascii').trim();
}

function parseTreeOutput(bytes,maxEntries=2048,maxMetadataBytes=4*1024*1024){
  if(bytes.length>maxMetadataBytes)throw new Error('FIXTURE_TREE_OUTPUT_OVER_CAP');
  const frames=[];
  let start=0;
  for(let end=0;end<bytes.length;end++){
    if(bytes[end]!==0)continue;
    const frame=bytes.subarray(start,end);
    const tab=frame.indexOf(0x09);
    if(tab<0)throw new Error('FIXTURE_TREE_FRAME_INVALID');
    const header=frame.subarray(0,tab).toString('ascii').split(' ');
    if(header.length!==3)throw new Error('FIXTURE_TREE_HEADER_INVALID');
    frames.push({
      mode:header[0],type:header[1],oid:header[2],
      path:fatalUtf8.decode(frame.subarray(tab+1))
    });
    if(frames.length>maxEntries)throw new Error('FIXTURE_TREE_ENTRY_OVER_CAP');
    start=end+1;
  }
  if(start!==bytes.length)throw new Error('FIXTURE_TREE_TERMINATOR_MISSING');
  return frames;
}

function makeGitPort({faults={},calls=[]}={}){
  const invoke=async(name,args,normal)=>{
    calls.push({name,args});
    if(faults[name])return faults[name](args,normal);
    return normal();
  };
  const port=Object.freeze({
    async inspectCommit({git_dir,oid,max_bytes}){
      return invoke('inspectCommit',{git_dir,oid,max_bytes},()=>{
        const kind=runGit(git_dir,['cat-file','-t',oid]).toString('ascii').trim();
        if(kind!=='commit')return new Uint8Array();
        const raw=runGit(git_dir,['cat-file','commit',oid]);
        if(raw.length>max_bytes)throw new Error('FIXTURE_COMMIT_OVER_CAP');
        return new Uint8Array(raw);
      });
    },
    async inspectTree({git_dir,oid,max_entries,max_metadata_bytes}){
      return invoke('inspectTree',{git_dir,oid,max_entries,max_metadata_bytes},()=>{
        const bytes=runGit(git_dir,['ls-tree','-rtz','--full-tree',oid]);
        return {
          object_format:'sha1',
          entries:parseTreeOutput(bytes,max_entries,max_metadata_bytes)
        };
      });
    },
    async readBlob({git_dir,oid,max_bytes}){
      return invoke('readBlob',{git_dir,oid,max_bytes},()=>{
        const kind=runGit(git_dir,['cat-file','-t',oid]).toString('ascii').trim();
        if(kind!=='blob')throw new Error('FIXTURE_NOT_BLOB');
        const bytes=runGit(git_dir,['cat-file','blob',oid]);
        if(bytes.length>max_bytes)throw new Error('FIXTURE_BLOB_OVER_CAP');
        return new Uint8Array(bytes);
      });
    },
    async initBare({git_dir}){
      return invoke('initBare',{git_dir},()=>{initGitDir(git_dir,true);});
    },
    async writeBlob({git_dir,bytes}){
      return invoke('writeBlob',{git_dir,bytes},()=>writeGitBlob(git_dir,bytes));
    },
    async writeTree({git_dir,entries}){
      return invoke('writeTree',{git_dir,entries},()=>writeGitTree(git_dir,entries));
    },
    async writeCommit({git_dir,tree,parent}){
      return invoke('writeCommit',{git_dir,tree,parent},()=>writeGitCommit(
        git_dir,tree,parent,'Squire source review candidate'
      ));
    },
    async readRef({git_dir,ref}){
      return invoke('readRef',{git_dir,ref},()=>{
        const output=runGit(git_dir,['rev-parse','--verify','--quiet','--end-of-options',ref],{
          allowStatus:[1]
        }).toString('ascii').trim();
        return output||null;
      });
    },
    async createRef({git_dir,ref,oid,old_oid}){
      return invoke('createRef',{git_dir,ref,oid,old_oid},()=>{
        runGit(git_dir,['update-ref',ref,oid,old_oid]);
      });
    }
  });
  gitCallTraces.set(port,calls);
  return port;
}

async function ownedDirectory(run){
  const root=await fs.mkdtemp(join(tmpdir(),'squire-project-review-'));
  await fs.chmod(root,0o700);
  try{return await run(root);}finally{await fs.rm(root,{recursive:true,force:true});}
}

async function makeBase(root,files,{bare=true,extraTreeEntries=[],signedBase=false}={}){
  const project=join(root,bare?'base.git':'base-worktree');
  if(!bare)await fs.mkdir(project,{mode:0o700});
  initGitDir(project,bare);
  const gitDir=bare?project:join(project,'.git');
  const indexed=[];
  for(const file of files){
    const blob=writeGitBlob(gitDir,file.bytes);
    indexed.push({path:file.path,mode:file.mode??'100644',type:file.type??'blob',oid:blob});
  }
  const supplemental=[];
  for(const entry of extraTreeEntries){
    if(entry.oid==='FIXTURE_COMMIT'){
      const emptyTree=writeGitTree(gitDir,[]);
      supplemental.push({...entry,oid:writeGitCommit(gitDir,emptyTree,null,
        'Squire test gitlink')});
    }else if(entry.oid==='FIXTURE_EMPTY_TREE'){
      supplemental.push({...entry,oid:writeGitTree(gitDir,[])});
    }else supplemental.push({...entry});
  }
  indexed.push(...supplemental);
  const tree=writeGitTree(gitDir,indexed);
  let commit;
  if(signedBase){
    const firstParent=writeGitCommit(gitDir,tree,null,'Squire first synthetic parent');
    const secondParent=writeGitCommit(gitDir,tree,firstParent,
      'Squire second synthetic parent');
    const body=utf8.encode([
      `tree ${tree}`,`parent ${firstParent}`,`parent ${secondParent}`,
      'author Squire Test Fixture <squire-test@example.invalid> 946684800 +0000',
      'committer Squire Test Fixture <squire-test@example.invalid> 946684800 +0000',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' c3F1aXJlLXN5bnRoZXRpYy1maXh0dXJl',
      ' -----END PGP SIGNATURE-----','',
      'synthetic signed-shaped test commit',''
    ].join('\n'));
    commit=runGit(gitDir,['hash-object','-w','-t','commit','--stdin'],{
      input:Buffer.from(body)
    }).toString('ascii').trim();
  }else commit=writeGitCommit(gitDir,tree,null);
  runGit(gitDir,['update-ref','refs/heads/main',commit]);
  const commitBytes=new Uint8Array(runGit(gitDir,['cat-file','commit',commit]));
  const stat=await fs.lstat(gitDir);
  return {
    gitDir,project,identity:{dev:stat.dev,ino:stat.ino},tree,commit,commitBytes,
    blobs:new Map(indexed.filter(x=>x.type==='blob').map(x=>[x.path,x.oid]))
  };
}

function makeLargeCompletedReceipt({jobId,stagePlan,stageAck,operatorAdmitted=false,standard=false,rawReceipt=false}){
  const staging={
    schema_version:stageAck.schema_version,
    output_profile:stageAck.output_profile,
    stage_operation_id:stageAck.stage_operation_id,
    caller_label:stageAck.caller_label,
    completion_status:stageAck.completion_status,
    manifest_sha256:stageAck.manifest_sha256,
    file_count:stageAck.file_count,
    total_bytes:stageAck.total_bytes,
    operation_acknowledgement:stageAck.operation_acknowledgement,
    provenance_authenticity:stageAck.provenance_authenticity,
    crash_durability:stageAck.crash_durability
  };
  assert.equal(staging.stage_operation_id,stagePlan.stage_operation_id);
  assert.equal(staging.manifest_sha256,stagePlan.manifest_sha256);
  const result={
    schema:PROJECT_LARGE_OBSERVATION_RESULT_SCHEMA,
    status:'CANDIDATE_STAGED',reason:null,
    generation:{
      record:{
        job_id:jobId,
        task_class:PROJECT_LARGE_OBSERVATION_TASK_CLASS,
        output_profile:LARGE_PROFILE,
        lifecycle_status:'LIMITED_SUCCESS',
        requested_model:'gpt-6-luna',reported_model:'UNKNOWN',
        process_exit:{pid:41,exit_code:0,exit_signal:null,
          process_wall_ms:0,observed_termination:true},
        io_state:{stdout_bytes_observed:128,stderr_bytes_observed:0,
          stdout_eof:true,stderr_eof:true,io_drained:true},
        containment_evidence:{
          containment_level:'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',
          settlement_status:'SETTLED_DIRECT_CHILD_EXIT',descendant_guarantee:'NONE'
        },
        provider_metadata:{
          codex_reasoning_output_tokens:0,
          provider_reported_status:'turn.completed',duration_seconds:null,
          usage_tokens:{input:0,output:1,cache_read:0,thinking:'UNKNOWN',total:'UNKNOWN'}
        },
        output_custody:{persisted:true,path:'/private/synthetic/envelope.json',
          byte_count:128,persistence_error:null},
        task_outcome_evaluated:false,task_payload_valid:true,
        error_details:{code:null,classification:null,message:null}
      },
      runtime_evidence:{
        deadline_ms:null,timeout_latched:false,abort_latched:false,
        signal_attempts:[],event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',
        workspace_reuse:'NOT_AUTHORIZED',workspace_disposition:'DEDICATED_NOT_REUSED',
        max_steps:'UNSUPPORTED'
      },
      diagnostic_retention:{
        retention_status:'NOT_REQUESTED',rejection_stage:null,rejection_reason:null,
        exact_response_bytes:null,retained_bytes_count:null,
        retained_truncated:false,retention_error:null
      }
    },
    staging,
    task_correctness:'NOT_EVALUATED',task_outcome_evaluated:false,
    runtime_admitted:false,operator_admitted:operatorAdmitted,
    workspace_disposition:'DEDICATED_NOT_REUSED',descendant_guarantee:'NONE',
    operator_receipt:'/private/synthetic/operator-receipt',
    direct_child_invocations:{generation:1},outer_observation_target_ms:null,
    event_loop_condition:'RESPONSIVE_PARENT_EVENT_LOOP',
    execution_profile:PROJECT_CODING_OBSERVATION_PROFILE,
    output_profile:LARGE_PROFILE,
    post_generation_closeout:{status:'COMPLETE',limit_ms:20000}
  };
  // Producer-shaped deterministic standard fixture, not conversion of real output.
  if(standard){
    result.schema='SQUIRE2_PROJECT_RESULT_V1';
    result.generation.record.task_class='PROJECT_CODEGEN_V1';
    result.generation.runtime_evidence.deadline_ms=120000;
    result.outer_observation_target_ms=140000;
    delete result.generation.record.output_profile;
    delete result.staging.output_profile;
    delete result.execution_profile;delete result.output_profile;delete result.post_generation_closeout;
  }
  const envelope=rawReceipt?{schema:'SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1',result}:
    standard?createNativeProjectResultReceipt(result):createNativeProjectLargeObservationResultReceipt(result);
  const receiptBytes=utf8.encode(`${JSON.stringify(envelope)}\n`);
  return {envelope,receiptBytes,receiptSha256:hashBytes(receiptBytes)};
}

const asBytes=value=>value instanceof Uint8Array?new Uint8Array(value):utf8.encode(value);
const sourceFile=(path,content)=>({path,classification:'SOURCE',content:asBytes(content)});
const assetFile=(path,content)=>({path,classification:'LOCAL_ASSET',content:asBytes(content)});
const docFile=(path,content)=>({path,classification:'DOC',content:asBytes(content)});

async function makeReviewFixture(root,{
  stageFiles,baseFiles=[],extraTreeEntries=[],bare=true,signedBase=false,
  operationId='review-test',
  jobId='20000000-0000-4000-8000-000000000001',receiptOverride=null,
  standard=false,operatorAdmitted=false,rawReceipt=false
}){
  const base=await makeBase(root,baseFiles,{bare,extraTreeEntries,signedBase});
  const stageDir=join(root,'stage');
  const snapshotDir=join(root,'snapshot');
  const candidateDir=join(root,'candidate.git');
  const stagePlan=(standard?planStaging:planLargeProjectStaging)({
    stage_operation_id:`stage-${jobId}`,
    caller_label:'project_candidate_stager',
    ...(standard?{}:{output_profile:LARGE_PROFILE}),
    files:stageFiles.map(file=>({
      path:file.path,classification:file.classification,
      content:asBytes(file.content)
    }))
  });
  const stageAck=await (standard?writeStage:writeLargeProjectStage)(stagePlan,stageDir,{fs:fixtureFs,uid});
  assert.equal((await (standard?verifyStage:verifyLargeProjectStage)(stageDir,{fs:fixtureFs,uid})).status,'VERIFIED');
  const savedReceipt=receiptOverride??makeLargeCompletedReceipt({jobId,stagePlan,stageAck,standard,operatorAdmitted,rawReceipt});
  const preimages=new Map(baseFiles.map(file=>[file.path,asBytes(file.bytes)]));
  const allowedChanges=stageFiles.map(file=>{
    const original=preimages.get(file.path);
    if(original===undefined)return {path:file.path,original:null};
    const blob=base.blobs.get(file.path);
    assert.equal(typeof blob,'string');
    return {path:file.path,original:{
      blob,bytes:original.length,sha256:hashBytes(original)
    }};
  }).sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const spec={
    schema:standard?'SQUIRE_STANDARD_PROJECT_REVIEW_IMPORT_V1':'SQUIRE_PROJECT_REVIEW_IMPORT_V1',
    operation_id:operationId,caller_label:'review-test',
    receipt_bytes:new Uint8Array(savedReceipt.receiptBytes),
    receipt_sha256:savedReceipt.receiptSha256,
    stage_dir:stageDir,stage_manifest_sha256:stagePlan.manifest_sha256,
    snapshot_dir:snapshotDir,base_git_dir:base.gitDir,
    base_git_identity:{...base.identity},
    base_commit:base.commit,base_tree:base.tree,
    candidate_dir: candidateDir,allowed_changes:allowedChanges
  };
  return {root,base,stageDir,snapshotDir,candidateDir,stagePlan,stageAck,
    stageFiles,baseFiles,receipt:savedReceipt,spec};
}

function testPorts(git,{fsPort=fixtureFs,signal}={}){
  return {fs:fsPort,uid,git,...(signal?{signal}:{})};
}

function candidateSpec(fixture,suffix,changes=fixture.spec.allowed_changes){
  return {
    ...fixture.spec,
    snapshot_dir:join(fixture.root,`snapshot-${suffix}`),
    candidate_dir:join(fixture.root,`candidate-${suffix}.git`),
    allowed_changes:changes.map(change=>({
      path:change.path,
      original:change.original===null?null:{...change.original}
    }))
  };
}

async function repoFileDigest(root){
  const entries=[];
  const walk=async(directory,relative='')=>{
    for(const name of (await fs.readdir(directory)).sort()){
      const full=join(directory,name),rel=relative?`${relative}/${name}`:name;
      const stat=await fs.lstat(full);
      assert.equal(stat.isSymbolicLink(),false);
      if(stat.isDirectory())await walk(full,rel);
      else{
        assert.equal(stat.isFile(),true);
        const bytes=new Uint8Array(await fs.readFile(full));
        entries.push([rel,stat.mode&0o777,bytes.length,hashBytes(bytes)]);
      }
    }
  };
  await walk(root);
  return entries;
}

function readRef(gitDir,ref){
  return runGit(gitDir,['rev-parse','--verify','--quiet','--end-of-options',ref],{allowStatus:[1]})
    .toString('ascii').trim()||null;
}

async function assertExportManifestCounts(snapshotDir,expectedCounts){
  const manifest=JSON.parse(await fs.readFile(
    join(snapshotDir,'export-manifest.json'),'utf8'
  ));
  const canonicalKeys=['source','local_asset','doc','evidence_log','frame_capture'];
  assert.deepEqual(Object.keys(manifest.file_counts).sort(),canonicalKeys.sort());
  assert.deepEqual(manifest.file_counts,expectedCounts);
}

function readTreeMap(gitDir,tree){
  return new Map(parseTreeOutput(runGit(gitDir,['ls-tree','-r','-z','--full-tree',tree]))
    .map(entry=>[entry.path,entry]));
}

function readGitBlob(gitDir,oid){
  return new Uint8Array(runGit(gitDir,['cat-file','blob',oid]));
}

function gitPortWith(fixture,overrides={}){
  const calls=[];
  const base=makeGitPort({faults:overrides,calls});
  return {calls,port:base};
}

const reviewSource=await fs.readFile(
  new URL('../src/project-review-candidate.mjs',import.meta.url),'utf8'
);
const reviewAst=parse(reviewSource,{ecmaVersion:'latest',sourceType:'module'});
const runGitNodes=reviewAst.body.filter(node=>
  node.type==='FunctionDeclaration'&&node.id?.name==='runGit'
);
assert.equal(runGitNodes.length,1,'expected one private runGit declaration');
const privateRunGitSource=reviewSource.slice(runGitNodes[0].start,runGitNodes[0].end);

function makePrivateRunGitHarness(pipeError=null){
  const calls={spawn:[],kill:[],close:0,stdinFinished:false,stdoutEnded:false,
    stderrEnded:false,uncaughtStreamErrors:[]};
  let child;
  let closeReleased=false;
  let streamsReadyResolve;
  const streamsReady=new Promise(resolveReady=>{streamsReadyResolve=resolveReady;});
  class SyntheticChild extends EventEmitter{
    constructor(){
      super();
      this.stdin=new EventEmitter();
      this.stdout=new EventEmitter();
      this.stderr=new EventEmitter();
      this.stdin.end=()=>{
        calls.stdinFinished=true;
        this.stdin.emit('finish');
        for(const [name,stream] of [['stdout',this.stdout],['stderr',this.stderr]]){
          if(pipeError===name){
            try{stream.emit('error',new Error('PRIVATE_PIPE_ERROR_SENTINEL'));}
            catch(error){calls.uncaughtStreamErrors.push(error);}
          }else{
            stream.emit('data',Buffer.from(`synthetic ${name}`));
          }
          stream.emit('end');
          calls[name==='stdout'?'stdoutEnded':'stderrEnded']=true;
        }
        streamsReadyResolve();
      };
    }
    kill(signal){calls.kill.push(signal);return true;}
  }
  const fakeSpawn=(command,args,options)=>{
    calls.spawn.push({command,args,options});
    child=new SyntheticChild();
    return child;
  };
  const rejected=()=>{
    const error=new Error('PROJECT_REVIEW_CANDIDATE_REJECTED');
    error.code='PROJECT_REVIEW_CANDIDATE_REJECTED';
    delete error.stack;
    throw error;
  };
  const runGit=runInNewContext(`(${privateRunGitSource})`,{
    spawn:fakeSpawn,
    FIXED_GIT_CONFIG:Object.freeze([]),
    gitEnvironment:gitDir=>({GIT_DIR:gitDir}),
    checkAbort:()=>{},
    rejected,
    Buffer
  });
  return {
    calls,
    streamsReady,
    run:()=>runGit('/private/base.git',['status'],null,128,128),
    releaseClose(){
      assert.ok(child,'Git child has not been spawned');
      assert.equal(closeReleased,false,'synthetic child close was already released');
      closeReleased=true;
      calls.close++;
      child.emit('close',0,null);
    }
  };
}



test('imports only declared multi-file bytes into a one-parent candidate while preserving the base',async()=>{
  await ownedDirectory(async root=>{
    const oldText=utf8.encode('export const version = 1;\n');
    const newText=utf8.encode('throw new Error("SQUIRE_GENERATED_CODE_EXECUTED");\n');
    const binary=new Uint8Array([0,255,1,128,0,10,13]);
    const unchanged=utf8.encode('reviewed documentation stays byte-identical\n');
    const unlisted=utf8.encode('base file outside the declared stage\n');
    const fixture=await makeReviewFixture(root,{
      stageFiles:[
        sourceFile('src/main.js',newText),
        assetFile('assets/payload.bin',binary),
        docFile('docs/unchanged.md',unchanged)
      ],
      baseFiles:[
        {path:'src/main.js',bytes:oldText},
        {path:'docs/unchanged.md',bytes:unchanged},
        {path:'src/unlisted.js',bytes:unlisted}
      ],
      operationId:'positive-candidate',signedBase:true
    });
    const baseBefore=await repoFileDigest(fixture.base.gitDir);
    const {calls,port}=gitPortWith(fixture);
    const result=await buildProjectReviewCandidate(fixture.spec,testPorts(port));
    await assertExportManifestCounts(fixture.snapshotDir,{
      source:1,local_asset:1,doc:1,evidence_log:0,frame_capture:0
    });

    assert.equal(result.schema,'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1');
    assert.equal(result.status,'SOURCE_CANDIDATE_CREATED');
    assert.equal(result.operation_id,'positive-candidate');
    assert.equal(result.candidate_ref,'refs/heads/candidate-positive-candidate');
    assert.equal(result.base_commit,fixture.base.commit);
    assert.equal(result.base_tree,fixture.base.tree);
    assert.equal(result.receipt_sha256,fixture.receipt.receiptSha256);
    assert.equal(result.stage_manifest_sha256,fixture.stagePlan.manifest_sha256);
    assert.deepEqual(result.changed_paths,['assets/payload.bin','src/main.js']);
    assert.equal(result.task_correctness,'NOT_EVALUATED');
    assert.equal(result.human_review,'PENDING');
    assert.equal(result.native_acceptance,'NOT_ESTABLISHED');
    assert.equal(result.benchmark_acceptance,'NOT_ESTABLISHED');
    assert.equal(result.origin_authenticity,'SUPPLIED_NOT_AUTHENTICATED');
    assert.equal(result.base_alternate_dependency,'READ_ONLY_BASE_OBJECT_ALTERNATE');
    assert.equal(JSON.stringify(result).includes(root),false);

    const candidateCommit=readRef(fixture.candidateDir,result.candidate_ref);
    assert.match(candidateCommit,/^[a-f0-9]{40}$/);
    const commitLine=runGit(fixture.candidateDir,
      ['rev-list','--parents','-n','1',candidateCommit]).toString('ascii').trim().split(' ');
    assert.deepEqual(commitLine,[candidateCommit,fixture.base.commit]);
    const candidateTree=runGit(fixture.candidateDir,
      ['rev-parse',`${candidateCommit}^{tree}`]).toString('ascii').trim();
    const candidateFiles=readTreeMap(fixture.candidateDir,candidateTree);
    const baseFiles=readTreeMap(fixture.base.gitDir,fixture.base.tree);
    assert.deepEqual(readGitBlob(fixture.candidateDir,candidateFiles.get('src/main.js').oid),newText);
    assert.deepEqual(readGitBlob(fixture.candidateDir,candidateFiles.get('assets/payload.bin').oid),binary);
    assert.equal(candidateFiles.get('docs/unchanged.md').oid,
      baseFiles.get('docs/unchanged.md').oid);
    assert.equal(candidateFiles.get('src/unlisted.js').oid,
      baseFiles.get('src/unlisted.js').oid);
    assert.equal(candidateFiles.has('.git/config'),false);
    assert.equal((await fs.readFile(join(fixture.candidateDir,'objects/info/alternates'),'utf8')),
      `${fixture.base.gitDir}/objects\n`);
    const candidateRefs=runGit(fixture.candidateDir,
      ['for-each-ref','--format=%(refname) %(objectname)']).toString('ascii').trim();
    assert.equal(candidateRefs,`${result.candidate_ref} ${candidateCommit}`);
    assert.deepEqual(await repoFileDigest(fixture.base.gitDir),baseBefore);
    assert.ok(calls.some(call=>call.name==='writeBlob'));
    assert.ok(calls.some(call=>call.name==='createRef'));
    assert.equal(await fs.stat(fixture.stageDir).then(stat=>stat.isDirectory()),true);
    assert.deepEqual(new Uint8Array(await fs.readFile(
      join(fixture.stageDir,'src/main.js')
    )),newText);
  });
});

test('the native path accepts the exact 50-file large-profile ceiling',async()=>{
  await ownedDirectory(async root=>{
    const files=[];
    for(let index=0;index<25;index++){
      files.push(sourceFile(`src/file-${String(index).padStart(2,'0')}.js`,
        `export const item${index} = ${index};\n`));
    }
    for(let index=0;index<20;index++){
      files.push(assetFile(`assets/file-${String(index).padStart(2,'0')}.bin`,
        new Uint8Array([index,255-index,0,1])));
    }
    for(let index=0;index<5;index++){
      files.push(docFile(`docs/file-${String(index).padStart(2,'0')}.md`,
        `Generated documentation ${index}.\n`));
    }
    files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
    const fixture=await makeReviewFixture(root,{
      stageFiles:files,baseFiles:[],operationId:'exact-fifty-files',
      jobId:'20000000-0000-4000-8000-000000000002'
    });
    assert.equal(fixture.stagePlan.files.length,LARGE_PROFILE.max_all_files);
    assert.equal(fixture.spec.allowed_changes.length,LARGE_PROFILE.max_all_files);
    const baseBefore=await repoFileDigest(fixture.base.gitDir);
    const result=await buildProjectReviewCandidateNative(fixture.spec);
    await assertExportManifestCounts(fixture.snapshotDir,{
      source:25,local_asset:20,doc:5,evidence_log:0,frame_capture:0
    });
    assert.equal(result.status,'SOURCE_CANDIDATE_CREATED');
    assert.equal(result.changed_paths.length,50);
    assert.deepEqual(result.changed_paths,files.map(file=>file.path).sort());
    assert.equal(readRef(fixture.candidateDir,result.candidate_ref)!==null,true);
    assert.deepEqual(await repoFileDigest(fixture.base.gitDir),baseBefore);
    assert.equal((await fs.readFile(join(fixture.candidateDir,'objects/info/alternates'),'utf8')),
      `${fixture.base.gitDir}/objects\n`);
  });
});

async function expectRejectedWithoutPromotion(fixture,spec,{git=makeGitPort(),portsFs=fixtureFs,signal,build=buildProjectReviewCandidate}={}){
  const ports=testPorts(git.port??git,{fsPort:portsFs,signal});
  let error=null;
  try{await build(spec,ports);}catch(value){error=value;}
  assert.ok(error,'candidate import unexpectedly succeeded');
  assert.equal(String(error).includes(fixture.root),false,'error leaked a local path');
  assert.equal(String(error).includes('SQUIRE_GENERATED_CODE_EXECUTED'),false,
    'error leaked staged source');
  const selectedGit=git.port??git;
  const createCalls=gitCallTraces.get(selectedGit)?.filter(call=>call.name==='createRef').length??0;
  assert.equal(createCalls,0,'candidate ref was promoted after a rejected import');
  const initialized=await fs.access(join(spec.candidate_dir,'HEAD')).then(()=>true,()=>false);
  if(initialized)assert.equal(readRef(spec.candidate_dir,
    `refs/heads/candidate-${spec.operation_id}`),null);
  return error;
}

test('rejects stale repository, tree, preimage, receipt, and allowlist bindings before promotion',async()=>{
  await ownedDirectory(async root=>{
    const current=utf8.encode('export const current = true;\n');
    const original=utf8.encode('export const current = false;\n');
    const unchanged=utf8.encode('unchanged\n');
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js',current),docFile('docs/unchanged.md',unchanged),
        assetFile('assets/new.bin',new Uint8Array([0,255,1]))],
      baseFiles:[
        {path:'src/main.js',bytes:original},
        {path:'docs/unchanged.md',bytes:unchanged}
      ],operationId:'binding-checks'
    });
    const originalDigest=await repoFileDigest(fixture.base.gitDir);
    const mainIndex=fixture.spec.allowed_changes.findIndex(change=>change.path==='src/main.js');
    const newIndex=fixture.spec.allowed_changes.findIndex(change=>change.path==='assets/new.bin');
    const mutations=[
      ['repository inode',spec=>{spec.base_git_identity.ino++;}],
      ['repository device',spec=>{spec.base_git_identity.dev++;}],
      ['base tree',spec=>{spec.base_tree='0'.repeat(40);}],
      ['base commit',spec=>{spec.base_commit='f'.repeat(40);}],
      ['stage manifest',spec=>{spec.stage_manifest_sha256='e'.repeat(64);}],
      ['receipt digest',spec=>{spec.receipt_sha256='d'.repeat(64);}],
      ['preimage blob',spec=>{spec.allowed_changes[mainIndex].original.blob='c'.repeat(40);}],
      ['preimage byte count',spec=>{spec.allowed_changes[mainIndex].original.bytes++;}],
      ['preimage SHA-256',spec=>{spec.allowed_changes[mainIndex].original.sha256='b'.repeat(64);}],
      ['false ABSENT for an existing path',spec=>{spec.allowed_changes[mainIndex].original=null;}],
      ['false present claim for an absent path',spec=>{
        spec.allowed_changes[newIndex].original={...spec.allowed_changes[mainIndex].original};
      }],
      ['out-of-allowlist path',spec=>{spec.allowed_changes[0].path='docs/not-staged.md';}],
      ['.git path',spec=>{spec.allowed_changes[0].path='.git/config';}],
      ['traversal path',spec=>{spec.allowed_changes[0].path='src/../escape.js';}],
      ['case-fold collision',spec=>{
        spec.allowed_changes.push({path:'src/MAIN.js',original:null});
      }],
      ['prefix collision',spec=>{
        spec.allowed_changes.push({path:'src/main.js/child.js',original:null});
      }]
    ];
    for(let index=0;index<mutations.length;index++){
      const [label,mutate]=mutations[index];
      const spec=candidateSpec(fixture,`bad-${index}`);
      mutate(spec);
      const trace={calls:[]};
      const git=makeGitPort({calls:trace.calls});
      await expectRejectedWithoutPromotion(fixture,spec,{git});
      assert.equal(await fs.access(spec.candidate_dir).then(()=>true,()=>false),false,
        `${label} should fail before creating the candidate repository`);
    }
    assert.deepEqual(await repoFileDigest(fixture.base.gitDir),originalDigest);
  });
});

test('valid leftover stages cannot turn partial or quarantined receipts into candidates',async()=>{
  await ownedDirectory(async root=>{
    const old=utf8.encode('old\n'),changed=utf8.encode('new\n');
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js',changed)],
      baseFiles:[{path:'src/main.js',bytes:old}],
      operationId:'partial-receipt'
    });
    for(const [index,status,reason,closeout] of [
      [0,'INCOMPLETE','CANCELED','CANCELED'],
      [1,'FAILED','CLEANUP_FAILED_OR_UNCERTAIN','FAILED_OR_UNCERTAIN']
    ]){
      const result=structuredClone(fixture.receipt.envelope.result);
      result.status=status;
      result.reason=reason;
      result.workspace_disposition='QUARANTINED';
      result.post_generation_closeout.status=closeout;
      const validated=createNativeProjectLargeObservationResultReceipt(result);
      const receiptBytes=utf8.encode(`${JSON.stringify(validated)}\n`);
      const spec=candidateSpec(fixture,`partial-${index}`);
      spec.receipt_bytes=receiptBytes;
      spec.receipt_sha256=hashBytes(receiptBytes);
      const trace={calls:[]};
      const git=makeGitPort({calls:trace.calls});
      await expectRejectedWithoutPromotion(fixture,spec,{git});
      assert.equal(await fs.access(spec.candidate_dir).then(()=>true,()=>false),false);
    }
    assert.equal((await verifyLargeProjectStage(fixture.stageDir,{fs:fixtureFs,uid})).status,
      'VERIFIED');
  });
});

test('rejects a completed receipt whose staged file has become a symlink',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js','export const main = true;\n')],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('export const main = false;\n')}],
      operationId:'stage-symlink'
    });
    const stagedPath=join(fixture.stageDir,'src/main.js');
    const privateTarget=join(root,'private-target.txt');
    await fs.writeFile(privateTarget,'PRIVATE_STAGE_TARGET_SENTINEL');
    await fs.chmod(join(fixture.stageDir,'src'),0o700);
    await fs.unlink(stagedPath);
    await fs.symlink(privateTarget,stagedPath);
    const trace={calls:[]};
    const git=makeGitPort({calls:trace.calls});
    await expectRejectedWithoutPromotion(fixture,fixture.spec,{git});
    assert.equal(await fs.access(fixture.snapshotDir).then(()=>true,()=>false),false);
  });
});

test('rejects unsafe base-tree paths, collisions, symlink ancestors, and gitlink ancestors',async()=>{
  const scenarios=[
    {
      label:'git metadata path',
      baseFiles:[
        {path:'src/main.js',bytes:utf8.encode('old\n')},
        {path:'.git/config',bytes:utf8.encode('core.bare=true\n')}
      ],
      stageFiles:[sourceFile('src/main.js','new\n')]
    },
    {
      label:'case-fold collision',
      baseFiles:[
        {path:'src/main.js',bytes:utf8.encode('old\n')},
        {path:'src/Upper.js',bytes:utf8.encode('a\n')},
        {path:'src/upper.js',bytes:utf8.encode('b\n')}
      ],
      stageFiles:[sourceFile('src/main.js','new\n')]
    },
    {
      label:'symlink ancestor',
      baseFiles:[{path:'vendor',mode:'120000',bytes:utf8.encode('../outside')}],
      stageFiles:[assetFile('vendor/library.bin',new Uint8Array([0,1,2]))]
    },
    {
      label:'gitlink ancestor',
      baseFiles:[],
      extraTreeEntries:[{path:'vendor',mode:'160000',type:'commit',oid:'FIXTURE_COMMIT'}],
      stageFiles:[assetFile('vendor/library.bin',new Uint8Array([0,1,2]))]
    }
  ];
  for(let index=0;index<scenarios.length;index++){
    const scenario=scenarios[index];
    await ownedDirectory(async root=>{
      const fixture=await makeReviewFixture(root,{
        ...scenario,operationId:`unsafe-base-${index}`,
        jobId:`20000000-0000-4000-8000-${String(index+10).padStart(12,'0')}`
      });
      const trace={calls:[]};
      const git=makeGitPort({calls:trace.calls});
      const error=await expectRejectedWithoutPromotion(fixture,fixture.spec,{git});
      assert.ok(String(error).length>0,scenario.label);
    });
  }
});

test('an unchanged-only stage is not promoted as a source candidate',async()=>{
  await ownedDirectory(async root=>{
    const same=utf8.encode('already in the base\n');
    const fixture=await makeReviewFixture(root,{
      stageFiles:[docFile('docs/readme.md',same)],
      baseFiles:[{path:'docs/readme.md',bytes:same}],
      operationId:'no-content-change'
    });
    const trace={calls:[]};
    const git=makeGitPort({calls:trace.calls});
    await expectRejectedWithoutPromotion(fixture,fixture.spec,{git});
    assert.equal(trace.calls.filter(call=>call.name==='createRef').length,0);
  });
});

test('rejects a candidate directory inside the selected base worktree',async()=>{
  await ownedDirectory(async root=>{
    const old=utf8.encode('old worktree content\n');
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js','new worktree content\n')],
      baseFiles:[{path:'src/main.js',bytes:old}],bare:false,
      operationId:'protect-base-worktree'
    });
    const before=await repoFileDigest(fixture.base.gitDir);
    const spec={
      ...fixture.spec,
      candidate_dir:join(fixture.base.project,'review-output','candidate.git')
    };
    const trace={calls:[]};
    const git=makeGitPort({calls:trace.calls});
    await expectRejectedWithoutPromotion(fixture,spec,{git});
    assert.equal(await fs.access(join(fixture.base.project,'review-output'))
      .then(()=>true,()=>false),false);
    assert.deepEqual(await repoFileDigest(fixture.base.gitDir),before);
  });
});

test('rechecks staged and exported bytes after object creation before creating the candidate ref',async()=>{
  for(const mutation of ['stage','snapshot']){
    await ownedDirectory(async root=>{
      const old=utf8.encode('const prior = true;\n');
      const changed=utf8.encode('const candidate = true;\n');
      const fixture=await makeReviewFixture(root,{
        stageFiles:[sourceFile('src/main.js',changed)],
        baseFiles:[{path:'src/main.js',bytes:old}],
        operationId:`mutate-${mutation}`
      });
      const trace={calls:[]};
      const faults={writeBlob:async(args,write)=>{
        const oid=await write();
        const file=mutation==='stage'?
          join(fixture.stageDir,'src/main.js'):
          join(fixture.snapshotDir,'project','src/main.js');
        await fs.chmod(file,0o600);
        await fs.writeFile(file,utf8.encode('mutated while candidate was being built\n'));
        await fs.chmod(file,0o400);
        return oid;
      }};
      const git=makeGitPort({calls:trace.calls,faults});
      await expectRejectedWithoutPromotion(fixture,fixture.spec,{git});
      assert.equal(trace.calls.filter(call=>call.name==='writeBlob').length,1);
      assert.equal(trace.calls.filter(call=>call.name==='createRef').length,0);
      assert.equal(await fs.access(join(fixture.candidateDir,'HEAD'))
        .then(()=>true,()=>false),true,'partial candidate output was deleted');
    });
  }
});

test('fails closed without retry on wrong Git blob IDs, unknown status, and oversized output',async()=>{
  const cases=[
    {
      label:'wrong candidate blob ID',
      failure:'writeBlob',
      faults:{writeBlob:async(_args,write)=>{
        await write();
        return 'f'.repeat(40);
      }}
    },
    {
      label:'unknown tree status',
      failure:'inspectTree',
      faults:{inspectTree:async()=>({object_format:'sha1',entries:[{
        path:'src/main.js',mode:'100644',type:'unknown',oid:'a'.repeat(40)
      }]})}
    },
    {
      label:'oversized original blob output',
      failure:'readBlob',
      faults:{readBlob:async({max_bytes})=>new Uint8Array(max_bytes+1)}
    }
  ];
  for(let index=0;index<cases.length;index++){
    const scenario=cases[index];
    await ownedDirectory(async root=>{
      const old=utf8.encode('preimage bytes\n');
      const fixture=await makeReviewFixture(root,{
        stageFiles:[sourceFile('src/main.js','replacement bytes\n')],
        baseFiles:[{path:'src/main.js',bytes:old}],
        operationId:`git-failure-${index}`
      });
      const trace={calls:[]};
      const git=makeGitPort({calls:trace.calls,faults:scenario.faults});
      const error=await expectRejectedWithoutPromotion(fixture,fixture.spec,{git});
      assert.equal(String(error).includes(root),false,scenario.label);
      assert.equal(trace.calls.filter(call=>call.name===scenario.failure).length,1,
        `${scenario.label} was retried`);
      assert.equal(trace.calls.filter(call=>call.name==='createRef').length,0);
      if(scenario.failure==='writeBlob'){
        assert.equal(await fs.access(join(fixture.candidateDir,'HEAD'))
          .then(()=>true,()=>false),true,'partial candidate output was deleted');
      }
    });
  }
});

test('export, file-close, and cancellation failures retain no promoted ref and expose no private errors',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js','changed bytes\n')],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('old bytes\n')}],
      operationId:'export-mkdir-failure'
    });
    let mkdirCalls=0;
    const exportFailureFs={...fixtureFs,mkdir:async(path,...args)=>{
      if(path===fixture.snapshotDir){
        mkdirCalls++;
        throw new Error('PRIVATE_EXPORT_MKDIR_SENTINEL');
      }
      return fs.mkdir(path,...args);
    }};
    const trace={calls:[]};
    const exportError=await expectRejectedWithoutPromotion(fixture,fixture.spec,{
      git:makeGitPort({calls:trace.calls}),portsFs:exportFailureFs
    });
    assert.equal(mkdirCalls,1);
    assert.equal(String(exportError).includes('PRIVATE_EXPORT_MKDIR_SENTINEL'),false);
  });

  await ownedDirectory(async root=>{
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js','changed bytes\n')],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('old bytes\n')}],
      operationId:'file-close-failure'
    });
    let closeCalls=0;
    const closeFailureFs={...fixtureFs,open:async(...args)=>{
      const handle=await fs.open(...args);
      return {
        stat:(...inner)=>handle.stat(...inner),
        read:(...inner)=>handle.read(...inner),
        writeFile:(...inner)=>handle.writeFile(...inner),
        close:async(...inner)=>{
          closeCalls++;
          const result=await handle.close(...inner);
          if(closeCalls===1)throw new Error('PRIVATE_CLOSE_SENTINEL');
          return result;
        }
      };
    }};
    const trace={calls:[]};
    const closeError=await expectRejectedWithoutPromotion(fixture,fixture.spec,{
      git:makeGitPort({calls:trace.calls}),portsFs:closeFailureFs
    });
    assert.ok(closeCalls>=1);
    assert.equal(String(closeError).includes('PRIVATE_CLOSE_SENTINEL'),false);
    assert.equal(trace.calls.filter(call=>call.name==='createRef').length,0);
  });

  await ownedDirectory(async root=>{
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js','changed bytes\n')],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('old bytes\n')}],
      operationId:'abort-during-object-write'
    });
    const controller=new AbortController();
    fixture.spec.signal=controller.signal;
    const trace={calls:[]};
    const git=makeGitPort({calls:trace.calls,faults:{writeBlob:async(_args,write)=>{
      const oid=await write();
      controller.abort();
      return oid;
    }}});
    await expectRejectedWithoutPromotion(fixture,fixture.spec,{
      git,signal:controller.signal
    });
    assert.equal(trace.calls.filter(call=>call.name==='writeBlob').length,1);
    assert.equal(trace.calls.filter(call=>call.name==='createRef').length,0);
    assert.equal(await fs.access(join(fixture.candidateDir,'HEAD'))
      .then(()=>true,()=>false),true,'partial candidate output was deleted');
  });
});

test('CLI imports and default invocation are inert, and explicit errors redact paths and bytes',async()=>{
  assert.equal(typeof runProjectReviewCandidateCli,'function');
  await ownedDirectory(async root=>{
    const cliPath=fileURLToPath(new URL('../bin/squire-project-review.mjs',import.meta.url));
    const idle=spawnSync(process.execPath,[cliPath],{
      cwd:root,env:cleanGitEnv,encoding:'utf8',maxBuffer:65536,
      stdio:['ignore','pipe','pipe']
    });
    assert.equal(idle.error,undefined);
    assert.equal(idle.status,2);
    assert.equal(idle.stdout,'');
    assert.match(idle.stderr,/^Usage: node bin\/squire-project-review\.mjs --build <spec\.json>\n$/);
    assert.deepEqual(await fs.readdir(root),[]);

    const specPath=join(root,'PRIVATE_CLI_PATH_SENTINEL.json');
    await fs.writeFile(specPath,JSON.stringify({
      private:'PRIVATE_SPEC_SENTINEL',receipt_path:'/PRIVATE_RECEIPT_SENTINEL'
    }));
    const rejectedCli=spawnSync(process.execPath,[cliPath,'--build',specPath],{
      cwd:root,env:cleanGitEnv,encoding:'utf8',maxBuffer:65536,
      stdio:['ignore','pipe','pipe']
    });
    assert.equal(rejectedCli.error,undefined);
    assert.ok(rejectedCli.status>0);
    const terminal=`${rejectedCli.stdout}${rejectedCli.stderr}`;
    for(const secret of [root,'PRIVATE_CLI_PATH_SENTINEL','PRIVATE_SPEC_SENTINEL',
      'PRIVATE_RECEIPT_SENTINEL'])assert.equal(terminal.includes(secret),false);
    assert.ok(terminal.length>0);
    assert.deepEqual((await fs.readdir(root)).sort(),['PRIVATE_CLI_PATH_SENTINEL.json']);
  });
});

test('requires original Git blobs to match byte count, SHA-256, and Git object ID',async()=>{
  await ownedDirectory(async root=>{
    const old=utf8.encode('exact preimage bytes\n');
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js','replacement bytes\n')],
      baseFiles:[{path:'src/main.js',bytes:old}],
      operationId:'corrupt-base-blob'
    });
    const trace={calls:[]};
    const git=makeGitPort({calls:trace.calls,faults:{readBlob:async(_args,read)=>{
      const corrupt=await read();
      corrupt[0]^=1;
      return corrupt;
    }}});
    await expectRejectedWithoutPromotion(fixture,fixture.spec,{git});
    assert.equal(trace.calls.filter(call=>call.name==='readBlob').length,1);
    assert.equal(trace.calls.filter(call=>call.name==='writeBlob').length,0);
    assert.equal(trace.calls.filter(call=>call.name==='createRef').length,0);
  });
});

test('stage mode and profile changes fail physical verification, and export profile tampering is rejected',async()=>{
  for(const mutation of ['stage-mode','stage-profile']){
    await ownedDirectory(async root=>{
      const fixture=await makeReviewFixture(root,{
        stageFiles:[sourceFile('src/main.js','new profile-bound stage\n')],
        baseFiles:[{path:'src/main.js',bytes:utf8.encode('old\n')}],
        operationId:mutation
      });
      if(mutation==='stage-mode'){
        await fs.chmod(join(fixture.stageDir,'src/main.js'),0o600);
      }else{
        const manifestPath=join(fixture.stageDir,'stage-manifest.json');
        const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
        manifest.output_profile={...manifest.output_profile,max_all_files:49};
        await fs.chmod(manifestPath,0o600);
        await fs.writeFile(manifestPath,JSON.stringify(manifest));
        await fs.chmod(manifestPath,0o400);
      }
      const trace={calls:[]};
      const git=makeGitPort({calls:trace.calls});
      await expectRejectedWithoutPromotion(fixture,fixture.spec,{git});
      assert.equal(trace.calls.some(call=>call.name==='initBare'),false);
      assert.equal(trace.calls.some(call=>call.name==='createRef'),false);
    });
  }

  await ownedDirectory(async root=>{
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js','new export profile\n')],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('old\n')}],
      operationId:'export-profile-tamper'
    });
    const manifestPath=join(fixture.snapshotDir,'export-manifest.json');
    const manifestFs={...fixtureFs,open:async(path,...args)=>{
      const handle=await fs.open(path,...args);
      return {
        stat:(...inner)=>handle.stat(...inner),
        read:(...inner)=>handle.read(...inner),
        close:(...inner)=>handle.close(...inner),
        writeFile:async(value,...inner)=>{
          let bytes=value;
          if(path===manifestPath){
            const changed=JSON.parse(fatalUtf8.decode(value));
            changed.output_profile={...changed.output_profile,max_all_files:49};
            bytes=utf8.encode(JSON.stringify(changed));
          }
          return handle.writeFile(bytes,...inner);
        }
      };
    }};
    const trace={calls:[]};
    await expectRejectedWithoutPromotion(fixture,fixture.spec,{
      git:makeGitPort({calls:trace.calls}),portsFs:manifestFs
    });
    assert.equal(trace.calls.some(call=>call.name==='initBare'),false);
    assert.equal(trace.calls.some(call=>call.name==='createRef'),false);
  });
});

test('caller mutation of captured base identity after the first await cannot change the pinned value',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js','candidate after identity capture\n')],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('base before identity capture\n')}],
      operationId:'identity-capture'
    });
    const captured={...fixture.spec.base_git_identity};
    let changed=false;
    const mutatingFs={...fixtureFs,lstat:async(path,...args)=>{
      const stat=await fs.lstat(path,...args);
      if(!changed){
        changed=true;
        fixture.spec.base_git_identity.dev=captured.dev+1;
        fixture.spec.base_git_identity.ino=captured.ino+1;
      }
      return stat;
    }};
    const result=await buildProjectReviewCandidate(
      fixture.spec,testPorts(makeGitPort(),{fsPort:mutatingFs})
    );
    assert.equal(changed,true);
    assert.notDeepEqual(fixture.spec.base_git_identity,captured);
    assert.equal(result.status,'SOURCE_CANDIDATE_CREATED');
    assert.equal(result.base_commit,fixture.base.commit);
  });
});

test('base identity, preimage, and redirect-metadata failures precede Git and stage access',async()=>{
  for(const kind of ['identity','preimage','commondir','gitdir','alternates']){
    await ownedDirectory(async root=>{
      const fixture=await makeReviewFixture(root,{
        stageFiles:[sourceFile('src/main.js','candidate bytes\n')],
        baseFiles:[{path:'src/main.js',bytes:utf8.encode('base bytes\n')}],
        operationId:`preflight-${kind}`
      });
      const spec=candidateSpec(fixture,kind);
      if(kind==='identity')spec.base_git_identity.ino++;
      else if(kind==='preimage')spec.allowed_changes[0].original.sha256='a'.repeat(64);
      else{
        let metadataPath;
        if(kind==='commondir')metadataPath=join(fixture.base.gitDir,'commondir');
        else if(kind==='gitdir')metadataPath=join(fixture.base.gitDir,'gitdir');
        else{
          const infoPath=join(fixture.base.gitDir,'objects','info');
          await fs.mkdir(infoPath,{recursive:true,mode:0o700});
          const infoStat=await fs.lstat(infoPath);
          assert.equal(infoStat.isDirectory(),true);
          assert.equal(infoStat.isSymbolicLink(),false);
          metadataPath=join(infoPath,'alternates');
        }
        await fs.writeFile(metadataPath,'SQUIRE_INERT_REDIRECT_MARKER\n',{
          encoding:'utf8',flag:'wx',mode:0o600
        });
      }
      const watched=[fixture.stageDir,spec.snapshot_dir];
      let stageSnapshotIo=0;
      const tracedFs={};
      for(const name of Object.keys(fixtureFs)){
        tracedFs[name]=async(path,...args)=>{
          if(typeof path==='string'&&watched.some(rootPath=>
            path===rootPath||path.startsWith(`${rootPath}/`)))stageSnapshotIo++;
          return fixtureFs[name](path,...args);
        };
      }
      const trace={calls:[]};
      const git=makeGitPort({calls:trace.calls});
      await expectRejectedWithoutPromotion(fixture,spec,{git,portsFs:tracedFs});
      assert.equal(stageSnapshotIo,0,`${kind} failure touched the stage or snapshot`);
      if(kind==='preimage')assert.equal(trace.calls.filter(call=>call.name==='readBlob').length,1);
      else assert.equal(trace.calls.length,0,`${kind} failure reached an injected Git method`);
      assert.equal(await fs.access(spec.snapshot_dir).then(()=>true,()=>false),false);
      assert.equal(await fs.access(spec.candidate_dir).then(()=>true,()=>false),false);
    });
  }
});

test('native import rejects empty and tree-only unsafe base subtrees instead of dropping them',async()=>{
  const cases=[
    ['empty base subtree','empty'],
    ['tree-only .git subtree','.git']
  ];
  for(let index=0;index<cases.length;index++){
    const [label,path]=cases[index];
    await ownedDirectory(async root=>{
      const fixture=await makeReviewFixture(root,{
        stageFiles:[sourceFile('src/main.js','changed file with hidden base tree\n')],
        baseFiles:[{path:'src/main.js',bytes:utf8.encode('old base file\n')}],
        extraTreeEntries:[{
          path,mode:'040000',type:'tree',oid:'FIXTURE_EMPTY_TREE'
        }],
        operationId:`empty-tree-${index}`
      });
      assert.match(fixture.base.tree,/^[a-f0-9]{40}$/);
      let error=null;
      try{await buildProjectReviewCandidateNative(fixture.spec);}catch(value){error=value;}
      assert.ok(error,`${label} was silently omitted from the new tree`);
      assert.equal(String(error).includes(root),false);
      assert.equal(await fs.access(fixture.snapshotDir).then(()=>true,()=>false),false,
        'base-tree rejection occurred after snapshot effects');
      assert.equal(await fs.access(fixture.candidateDir).then(()=>true,()=>false),false);
    });
  }
});

test('CLI emits a changed-path count and object IDs without account or session names',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeReviewFixture(root,{
      stageFiles:[assetFile('account/session.txt',new Uint8Array([0,1,2]))],
      baseFiles:[],operationId:'cli-private-relative-name'
    });
    const receiptPath=join(root,'private-receipt.json');
    const specPath=join(root,'private-spec.json');
    const {receipt_bytes,...apiFields}=fixture.spec;
    const cliSpec={...apiFields,receipt_path:receiptPath};
    const specBytes=utf8.encode(JSON.stringify(cliSpec));
    const stdout=[],stderr=[];
    let buildCalls=0;
    const code=await runProjectReviewCandidateCli(['--build',specPath],{
      readReceiptBytes:async(path,maxBytes)=>{
        assert.ok(maxBytes>0);
        if(path===specPath)return new Uint8Array(specBytes);
        if(path===receiptPath)return new Uint8Array(fixture.receipt.receiptBytes);
        throw new Error('PRIVATE_CLI_READ_SENTINEL');
      },
      build:async(spec)=>{
        buildCalls++;
        assert.equal(Array.isArray(spec.allowed_changes),true);
        assert.equal(spec.allowed_changes.length,1);
        const [change]=spec.allowed_changes;
        assert.deepEqual(Reflect.ownKeys(change),['path','original']);
        assert.equal(change.path,'account/session.txt');
        assert.equal(change.original,null);
        assert.deepEqual(spec.receipt_bytes,fixture.receipt.receiptBytes);
        return {
          schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',
          status:'SOURCE_CANDIDATE_CREATED',operation_id:'cli-private-relative-name',
          candidate_ref:'refs/heads/candidate-cli-private-relative-name',
          base_commit:'1'.repeat(40),base_tree:'2'.repeat(40),
          candidate_commit:'3'.repeat(40),candidate_tree:'4'.repeat(40),
          receipt_sha256:fixture.receipt.receiptSha256,
          stage_manifest_sha256:fixture.stagePlan.manifest_sha256,
          changed_paths:['account/session.txt'],
          task_correctness:'NOT_EVALUATED',human_review:'PENDING',
          native_acceptance:'NOT_ESTABLISHED',benchmark_acceptance:'NOT_ESTABLISHED',
          origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',
          base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'
        };
      },
      stdout:{write:value=>stdout.push(value)},
      stderr:{write:value=>stderr.push(value)}
    });
    assert.equal(code,0);
    assert.equal(buildCalls,1);
    const publicText=stdout.join('');
    assert.match(publicText,/SOURCE_CANDIDATE_CREATED/);
    assert.match(publicText,/Changed path count: 1/);
    const lines=publicText.trimEnd().split('\n');
    assert.deepEqual(lines.map((line,index)=>index===0?line:line.slice(0,line.indexOf(':'))),[
      'SOURCE_CANDIDATE_CREATED','Base commit','Base tree','Candidate commit',
      'Candidate tree','Changed path count'
    ]);
    for(const oid of ['1'.repeat(40),'2'.repeat(40),'3'.repeat(40),'4'.repeat(40)]){
      assert.ok(publicText.includes(oid));
    }
    assert.equal(publicText.includes('account'),false);
    assert.equal(publicText.includes('session'),false);
    assert.equal(publicText.includes('account/session.txt'),false);
    assert.equal(publicText.includes('cli-private-relative-name'),false);
    assert.equal(publicText.includes(root),false);
    assert.deepEqual(stderr,[]);
  });
});

test('abort during a controlled pending Git read waits for fixture settlement and never retries or promotes',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeReviewFixture(root,{
      stageFiles:[sourceFile('src/main.js','pending Git read candidate\n')],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('pending Git read base\n')}],
      operationId:'pending-git-abort'
    });
    const controller=new AbortController();
    fixture.spec.signal=controller.signal;
    let readEnteredResolve;
    const readEntered=new Promise(resolveEntered=>{readEnteredResolve=resolveEntered;});
    let resolveRead;
    const pendingRead=new Promise(resolve=>{resolveRead=resolve;});
    let inspectCalls=0,createRefCalls=0;
    const delegate=makeGitPort();
    const git={
      inspectCommit(_args){inspectCalls++;readEnteredResolve();return pendingRead;},
      inspectTree:(...args)=>delegate.inspectTree(...args),
      readBlob:(...args)=>delegate.readBlob(...args),
      initBare:(...args)=>delegate.initBare(...args),
      writeBlob:(...args)=>delegate.writeBlob(...args),
      writeTree:(...args)=>delegate.writeTree(...args),
      writeCommit:(...args)=>delegate.writeCommit(...args),
      readRef:(...args)=>delegate.readRef(...args),
      createRef:(...args)=>{createRefCalls++;return delegate.createRef(...args);}
    };
    const watched=[fixture.stageDir,fixture.snapshotDir];
    let stageSnapshotIo=0;
    const tracedFs={};
    for(const name of Object.keys(fixtureFs)){
      tracedFs[name]=async(path,...args)=>{
        if(typeof path==='string'&&watched.some(rootPath=>
          path===rootPath||path.startsWith(`${rootPath}/`)))stageSnapshotIo++;
        return fixtureFs[name](path,...args);
      };
    }
    let state='pending';
    const resultPromise=buildProjectReviewCandidate(
      fixture.spec,testPorts(git,{fsPort:tracedFs,signal:controller.signal})
    ).then(value=>{state='fulfilled';return {value};},error=>{state='rejected';return {error};});
    const firstProgress=await Promise.race([
      readEntered.then(()=>({kind:'read-entered'})),
      resultPromise.then(outcome=>({kind:'result',outcome}))
    ]);
    assert.equal(firstProgress.kind,'read-entered',
      firstProgress.kind==='result'
        ?`bridge settled before controlled Git read: ${firstProgress.outcome.error?.code??'fulfilled'}`
        :'unexpected controlled-read race result');
    controller.abort();
    await Promise.resolve();
    assert.equal(state,'pending','abort returned before the pending Git operation settled');
    assert.equal(stageSnapshotIo,0,'stage or snapshot I/O started before base preflight settled');
    resolveRead(new Uint8Array(fixture.base.commitBytes));
    const outcome=await resultPromise;
    assert.equal(state,'rejected');
    assert.equal(outcome.error?.code,'PROJECT_REVIEW_CANDIDATE_ABORTED');
    assert.equal(inspectCalls,1,'pending Git operation was retried');
    assert.equal(createRefCalls,0);
    assert.equal(await fs.access(fixture.candidateDir).then(()=>true,()=>false),false);
    assert.equal(await fs.access(fixture.snapshotDir).then(()=>true,()=>false),false);
  });
});

test('private Git runner accepts clean stream completion with a controlled synthetic child',async()=>{
  const harness=makePrivateRunGitHarness();
  let settled=false;
  const resultPromise=harness.run().then(result=>{
    settled=true;
    return {result};
  },error=>{
    settled=true;
    return {error};
  });
  await harness.streamsReady;
  await Promise.resolve();
  assert.equal(settled,false,'runner settled before its child close event');
  assert.equal(harness.calls.stdinFinished,true);
  assert.equal(harness.calls.stdoutEnded,true);
  assert.equal(harness.calls.stderrEnded,true);
  assert.equal(harness.calls.close,0);
  harness.releaseClose();
  const outcome=await resultPromise;
  assert.equal(outcome.error,undefined);
  assert.equal(outcome.result.code,0);
  assert.equal(Buffer.from(outcome.result.stdout).toString(),'synthetic stdout');
  assert.equal(Buffer.from(outcome.result.stderr).toString(),'synthetic stderr');
  assert.equal(harness.calls.spawn.length,1);
  assert.equal(harness.calls.spawn[0].command,'/usr/bin/git');
  assert.deepEqual(Array.from(harness.calls.spawn[0].args),['status']);
  assert.equal(harness.calls.spawn[0].options.shell,false);
  assert.deepEqual(harness.calls.kill,[]);
  assert.equal(harness.calls.uncaughtStreamErrors.length,0);
  assert.equal(harness.calls.close,1);
});

test('private Git runner sanitizes stdout readable errors after child close without retry',async()=>{
  const harness=makePrivateRunGitHarness('stdout');
  let settled=false;
  const resultPromise=harness.run().then(result=>{
    settled=true;
    return {result};
  },error=>{
    settled=true;
    return {error};
  });
  await harness.streamsReady;
  await Promise.resolve();
  assert.equal(settled,false,'pipe error escaped before the owned child closed');
  assert.equal(harness.calls.stdoutEnded,true);
  assert.equal(harness.calls.stderrEnded,true);
  assert.equal(harness.calls.close,0);
  harness.releaseClose();
  const outcome=await resultPromise;
  assert.equal(settled,true);
  assert.equal(outcome.result,undefined);
  assert.equal(outcome.error?.code,'PROJECT_REVIEW_CANDIDATE_REJECTED');
  assert.equal(outcome.error?.message,'PROJECT_REVIEW_CANDIDATE_REJECTED');
  assert.equal(outcome.error?.stack,undefined);
  assert.equal(outcome.error?.cause,undefined);
  assert.doesNotMatch(outcome.error?.message??'',/PRIVATE_PIPE_ERROR_SENTINEL|\/private/u);
  assert.deepEqual(harness.calls.kill,['SIGTERM']);
  assert.equal(harness.calls.uncaughtStreamErrors.length,0);
  assert.equal(harness.calls.spawn.length,1,'runner retried after a stdout error');
  assert.equal(harness.calls.close,1);
});

test('private Git runner sanitizes stderr readable errors after child close without retry',async()=>{
  const harness=makePrivateRunGitHarness('stderr');
  let settled=false;
  const resultPromise=harness.run().then(result=>{
    settled=true;
    return {result};
  },error=>{
    settled=true;
    return {error};
  });
  await harness.streamsReady;
  await Promise.resolve();
  assert.equal(settled,false,'pipe error escaped before the owned child closed');
  assert.equal(harness.calls.stdoutEnded,true);
  assert.equal(harness.calls.stderrEnded,true);
  assert.equal(harness.calls.close,0);
  harness.releaseClose();
  const outcome=await resultPromise;
  assert.equal(settled,true);
  assert.equal(outcome.result,undefined);
  assert.equal(outcome.error?.code,'PROJECT_REVIEW_CANDIDATE_REJECTED');
  assert.equal(outcome.error?.message,'PROJECT_REVIEW_CANDIDATE_REJECTED');
  assert.equal(outcome.error?.stack,undefined);
  assert.equal(outcome.error?.cause,undefined);
  assert.doesNotMatch(outcome.error?.message??'',/PRIVATE_PIPE_ERROR_SENTINEL|\/private/u);
  assert.deepEqual(harness.calls.kill,['SIGTERM']);
  assert.equal(harness.calls.uncaughtStreamErrors.length,0);
  assert.equal(harness.calls.spawn.length,1,'runner retried after a stderr error');
  assert.equal(harness.calls.close,1);
});

// Revision fixtures are new synthetic stages and disposable repositories. They
// never import/evaluate project files or use any prior workload namespace.
async function makeRevisionFixture(root,options={}){
  const fixture=await makeReviewFixture(root,{
    stageFiles:[sourceFile('src/main.js','staged source bytes\n'),
      assetFile('assets/retained.bin',new Uint8Array([0,127,255])),
      docFile('docs/note.md','staged note\n')],
    baseFiles:[{path:'src/main.js',bytes:utf8.encode('base source bytes\n'),mode:'100755'},
      {path:'unchanged.sh',bytes:utf8.encode('inert executable-shaped bytes\n'),mode:'100755'}],
    operationId:'original',...options
  });
  const priorResult=await (options.standard?buildStandardProjectReviewCandidateNative:buildProjectReviewCandidateNative)(fixture.spec);
  const priorStat=await fs.lstat(fixture.candidateDir);
  const first=fixture.stageFiles[0];
  const firstBytes=asBytes(first.content);
  const revision={
    schema:options.standard?'SQUIRE_STANDARD_PROJECT_REVIEW_REVISION_V1':'SQUIRE_PROJECT_REVIEW_REVISION_V1',
    original:{...candidateSpec(fixture,'revision'),operation_id:'revision'},
    prior_candidate:{git_dir:fixture.candidateDir,identity:{dev:priorStat.dev,ino:priorStat.ino},
      operation_id:fixture.spec.operation_id,commit:priorResult.candidate_commit,tree:priorResult.candidate_tree},
    corrections:[{path:first.path,original:{blob:sha1Git('blob',firstBytes),
      bytes:firstBytes.length,sha256:hashBytes(firstBytes)},bytes_data:utf8.encode('owner corrected source bytes\n')}]
  };
  return {...fixture,priorResult,revision};
}
async function revisionInputsDigest(fixture){
  return {
    base:await repoFileDigest(fixture.base.gitDir),
    prior:await repoFileDigest(fixture.candidateDir),
    stage:await repoFileDigest(fixture.stageDir),
    snapshot:await repoFileDigest(fixture.snapshotDir)
  };
}
async function rejectRevision(fixture,revision=fixture.revision,{git,fsPort=fixtureFs,native=false,standard=false}={}){
  const before=await revisionInputsDigest(fixture);
  let error;
  try{
    if(native)await (standard?buildStandardProjectRevisionCandidateNative:buildProjectRevisionCandidateNative)(revision);
    else await (standard?buildStandardProjectRevisionCandidate:buildProjectRevisionCandidate)(revision,testPorts(git??makeGitPort(),{fsPort,
      signal:revision.original.signal}));
  }catch(value){error=value;}
  assert.ok(error,'invalid revision was acknowledged');
  assert.ok(['INVALID_PROJECT_REVIEW_SPEC','PROJECT_REVIEW_CANDIDATE_REJECTED',
    'PROJECT_REVIEW_CANDIDATE_ABORTED'].includes(error.code));
  assert.equal(error.message,error.code);
  assert.equal(error.stack,undefined);
  assert.equal(error.cause,undefined);
  assert.equal(String(error).includes(fixture.root),false);
  const output=revision.original.candidate_dir;
  if(await fs.access(join(output,'objects')).then(()=>true,()=>false)){
    assert.equal(readRef(output,`refs/heads/candidate-${revision.original.operation_id}`),null);
  }
  assert.deepEqual(await revisionInputsDigest(fixture),before);
  return error;
}

test('native owner revision creates exact new source objects without mutating prior stage/base/candidate',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);
    const before=await revisionInputsDigest(fixture);
    const supplied=new Uint8Array(fixture.revision.corrections[0].bytes_data);
    const result=await buildProjectRevisionCandidateNative(fixture.revision);
    assert.equal(result.schema,'SQUIRE_PROJECT_REVISION_CANDIDATE_V1');
    assert.equal(result.status,'SOURCE_REVISION_CANDIDATE_CREATED');
    assert.equal(result.correction_origin,'OPERATOR_SUPPLIED');
    assert.equal(result.origin_authenticity,'SUPPLIED_NOT_AUTHENTICATED');
    assert.equal(result.human_review,'PENDING');
    assert.equal(result.task_correctness,'NOT_EVALUATED');
    assert.equal(result.native_acceptance,'NOT_ESTABLISHED');
    assert.equal(result.benchmark_acceptance,'NOT_ESTABLISHED');
    assert.deepEqual(result.revision_of,{commit:fixture.priorResult.candidate_commit,tree:fixture.priorResult.candidate_tree});
    assert.notEqual(result.candidate_tree,fixture.priorResult.candidate_tree);
    const output=fixture.revision.original.candidate_dir;
    const entries=readTreeMap(output,result.candidate_tree);
    assert.equal(entries.get('src/main.js').oid,sha1Git('blob',supplied));
    assert.equal(entries.get('src/main.js').mode,'100644');
    assert.equal(entries.get('unchanged.sh').mode,'100755');
    assert.deepEqual(new Uint8Array(runGit(output,['cat-file','blob',entries.get('src/main.js').oid])),supplied);
    assert.deepEqual(new Uint8Array(runGit(output,['cat-file','blob',entries.get('assets/retained.bin').oid])),new Uint8Array([0,127,255]));
    const commit=runGit(output,['cat-file','commit',result.candidate_commit]).toString('utf8');
    assert.match(commit,new RegExp(`^tree ${result.candidate_tree}\nparent ${fixture.base.commit}\n`));
    assert.equal((commit.match(/^parent /gm)??[]).length,1);
    assert.deepEqual(result.revised_blobs,[{path:'src/main.js',
      previous_blob:fixture.revision.corrections[0].original.blob,
      previous_bytes:fixture.revision.corrections[0].original.bytes,
      previous_sha256:fixture.revision.corrections[0].original.sha256,
      blob:sha1Git('blob',supplied),bytes:supplied.length,sha256:hashBytes(supplied)}]);
    assert.deepEqual(fixture.revision.corrections[0].bytes_data,supplied,'capture erased caller bytes');
    assert.deepEqual(await revisionInputsDigest(fixture),before);
    assert.equal(await fs.readFile(join(output,'objects/info/alternates'),'utf8'),`${join(fixture.base.gitDir,'objects')}\n`);
    // Removing only this disposable prior's object directory proves the new
    // output owns all staged non-base blobs, even those without corrections.
    await fs.rename(join(fixture.candidateDir,'objects'),join(root,'retained-prior-objects'));
    assert.deepEqual(new Uint8Array(runGit(output,['cat-file','blob',entries.get('assets/retained.bin').oid])),new Uint8Array([0,127,255]));
    assert.deepEqual(new Uint8Array(runGit(output,['cat-file','blob',entries.get('docs/note.md').oid])),utf8.encode('staged note\n'));
  });
});

test('revision can restore original executable bytes while leaving the other staged changes',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);
    fixture.revision.corrections[0].bytes_data=utf8.encode('base source bytes\n');
    const result=await buildProjectRevisionCandidateNative(fixture.revision);
    const entries=readTreeMap(fixture.revision.original.candidate_dir,result.candidate_tree);
    assert.equal(entries.get('src/main.js').mode,'100755');
    assert.equal(entries.get('src/main.js').oid,fixture.base.blobs.get('src/main.js'));
    assert.equal(result.changed_paths.includes('src/main.js'),false);
    assert.equal(result.revised_blobs[0].path,'src/main.js');
  });
});

test('revision rejects wrong old blob witnesses, invalid scope, no-op and empty SOURCE without promotion',async()=>{
  const cases=['blob','length','sha256','outside','traversal','duplicate','unchanged','empty-source','oversized'];
  for(const kind of cases)await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root),item=fixture.revision.corrections[0];
    if(kind==='blob')item.original.blob='a'.repeat(40);
    else if(kind==='length')item.original.bytes++;
    else if(kind==='sha256')item.original.sha256='a'.repeat(64);
    else if(kind==='outside')item.path='unlisted.txt';
    else if(kind==='traversal')item.path='../escape';
    else if(kind==='duplicate')fixture.revision.corrections.push({...item});
    else if(kind==='unchanged')item.bytes_data=utf8.encode('staged source bytes\n');
    else if(kind==='empty-source')item.bytes_data=new Uint8Array();
    else item.bytes_data=new Uint8Array(524289);
    await rejectRevision(fixture);
  });
});

test('revision rejects a resulting tree equal to the original base',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root,{stageFiles:[sourceFile('src/main.js','one staged change\n')],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('original base\n')}]});
    fixture.revision.corrections[0].bytes_data=utf8.encode('original base\n');
    await rejectRevision(fixture);
  });
});

test('revision checks exact class file limits and complete revised aggregate totals',async()=>{
  for(const [kind,accepted] of [['exact-source',true],['source-total',false],['doc-file',false],['doc-total',false]]){
    await ownedDirectory(async root=>{
      const stageFiles=kind.startsWith('doc')
        ?[sourceFile('src/a.js','source'),...Array.from({length:3},(_,i)=>docFile(`docs/${i}.md`,'doc'))]
        :Array.from({length:5},(_,i)=>sourceFile(`src/${i}.js`,'source'));
      const fixture=await makeRevisionFixture(root,{stageFiles,baseFiles:[]});
      fixture.revision.corrections=stageFiles.filter(file=>kind.startsWith('doc')?file.classification==='DOC':true).map((file,index)=>{
        const old=asBytes(file.content);
        const size=kind==='exact-source'?(index<4?524288:1):kind==='source-total'?(index<4?524288:2)
          :kind==='doc-file'?65537:65536;
        return {path:file.path,original:{blob:sha1Git('blob',old),bytes:old.length,sha256:hashBytes(old)},bytes_data:new Uint8Array(size).fill(65)};
      });
      // The exact SOURCE total is 2MiB including the unchanged fifth source.
      if(kind==='exact-source')fixture.revision.corrections[3].bytes_data=new Uint8Array(524287).fill(65);
      if(accepted){
        const result=await buildProjectRevisionCandidateNative(fixture.revision);
        assert.equal(result.status,'SOURCE_REVISION_CANDIDATE_CREATED');
        assert.equal(result.revised_blobs.reduce((sum,item)=>sum+item.bytes,0),2097152);
      }else await rejectRevision(fixture);
    });
  }
});

test('revision rejects prior identity, commit/tree/ref substitution and unexpected alternate chains',async()=>{
  for(const kind of ['identity','commit','tree','operation','commondir','gitdir','alternate','symlink-alternate']){
    await ownedDirectory(async root=>{
      const fixture=await makeRevisionFixture(root),prior=fixture.revision.prior_candidate;
      if(kind==='identity')prior.identity.ino++;
      else if(kind==='commit')prior.commit=fixture.base.commit;
      else if(kind==='tree')prior.tree=fixture.base.tree;
      else if(kind==='operation')prior.operation_id='missing-original-ref';
      else if(kind==='commondir'||kind==='gitdir')await fs.writeFile(join(prior.git_dir,kind),'inert redirect\n',{mode:0o600});
      else{
        const alt=join(prior.git_dir,'objects/info/alternates');
        await fs.unlink(alt);
        if(kind==='symlink-alternate')await fs.symlink(join(fixture.base.gitDir,'config'),alt);
        else await fs.writeFile(alt,`${join(fixture.base.gitDir,'objects')}\n${join(root,'other-objects')}\n`,{mode:0o600});
      }
      // Digest helper rejects symlinks itself, so use this negative directly.
      if(kind==='symlink-alternate'){
        await assert.rejects(buildProjectRevisionCandidateNative(fixture.revision),{code:'PROJECT_REVIEW_CANDIDATE_REJECTED'});
        assert.equal(await fs.access(fixture.revision.original.candidate_dir).then(()=>true,()=>false),false);
      }else await rejectRevision(fixture);
    });
  }
});

test('revision cannot import arbitrary same-parent trees or recursively revise its own output',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);
    const entries=Array.from(readTreeMap(fixture.candidateDir,fixture.priorResult.candidate_tree).values());
    entries.push({path:'unlisted.txt',mode:'100644',oid:writeGitBlob(fixture.candidateDir,utf8.encode('inert extra file'))});
    const tree=writeGitTree(fixture.candidateDir,entries);
    const commit=writeGitCommit(fixture.candidateDir,tree,fixture.base.commit);
    runGit(fixture.candidateDir,['update-ref',`refs/heads/candidate-original`,commit]);
    fixture.revision.prior_candidate.commit=commit;fixture.revision.prior_candidate.tree=tree;
    await rejectRevision(fixture);
  });
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);
    const result=await buildProjectRevisionCandidateNative(fixture.revision);
    const out=fixture.revision.original.candidate_dir,stat=await fs.lstat(out);
    const second={...fixture.revision,
      original:{...fixture.revision.original,operation_id:'revision-two',snapshot_dir:join(root,'snapshot-two'),candidate_dir:join(root,'candidate-two.git')},
      prior_candidate:{git_dir:out,identity:{dev:stat.dev,ino:stat.ino},operation_id:'revision',commit:result.candidate_commit,tree:result.candidate_tree}};
    await rejectRevision(fixture,second);
  });
});

test('revision requires original acknowledged stage receipt and rejects missing or changed stage bindings',async()=>{
  for(const kind of ['receipt-hash','manifest','missing-receipt'])await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);
    if(kind==='receipt-hash')fixture.revision.original.receipt_sha256='a'.repeat(64);
    else if(kind==='manifest')fixture.revision.original.stage_manifest_sha256='a'.repeat(64);
    else fixture.revision.original.receipt_bytes=new Uint8Array();
    await rejectRevision(fixture);
  });
});

test('revision captures correction bytes and identities before async operations without invoking getters',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);
    const expected=new Uint8Array(fixture.revision.corrections[0].bytes_data);
    let mutated=false;
    const fsPort={...fixtureFs,lstat:async(...args)=>{
      if(!mutated){mutated=true;fixture.revision.corrections[0].bytes_data.fill(0);fixture.revision.prior_candidate.identity.ino++;}
      return fs.lstat(...args);
    }};
    const result=await buildProjectRevisionCandidate(fixture.revision,testPorts(makeGitPort(),{fsPort}));
    assert.equal(result.revised_blobs[0].sha256,hashBytes(expected));
  });
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);let getterCalls=0;
    Object.defineProperty(fixture.revision.corrections[0],'bytes_data',{enumerable:true,get(){getterCalls++;throw new Error('PRIVATE_GETTER');}});
    await rejectRevision(fixture);
    assert.equal(getterCalls,0);
  });
});

test('revision rejects overlapping prior/output and protected-stage paths before filesystem effects',async()=>{
  for(const field of ['candidate_dir','snapshot_dir','stage_dir','base_git_dir'])await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root),calls=[];
    fixture.revision.original[field]=join(fixture.candidateDir,'nested');
    await rejectRevision(fixture,fixture.revision,{git:makeGitPort({calls})});
    assert.equal(calls.length,0);
  });
});

test('revision fails closed on prior read/close errors and late ref mutation without a success ref',async()=>{
  for(const kind of ['read','close','late-ref','write'])await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);let priorReads=0;
    const git=makeGitPort({faults:{
      readBlob:async(args,normal)=>{
        if(kind==='read'&&args.git_dir===fixture.candidateDir)throw new Error('PRIVATE_GIT_ERROR');
        return normal();
      },
      readRef:async(args,normal)=>{
        if(args.git_dir===fixture.candidateDir&&kind==='late-ref'&&++priorReads===2)return null;
        return normal();
      },
      createRef:async(args,normal)=>{if(kind==='write')throw new Error('PRIVATE_WRITE_ERROR');return normal();}
    }});
    const fsPort={...fixtureFs,open:async(path,...args)=>{
      const handle=await fs.open(path,...args);
      if(kind!=='close'||path!==join(fixture.candidateDir,'objects/info/alternates'))return handle;
      return {stat:(...a)=>handle.stat(...a),read:(...a)=>handle.read(...a),close:async()=>{await handle.close();throw new Error('PRIVATE_CLOSE_ERROR');}};
    }};
    await rejectRevision(fixture,fixture.revision,{git,fsPort});
  });
});

test('revision abort waits for pending prior Git read settlement without retry or promotion',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root),controller=new AbortController();
    fixture.revision.original.signal=controller.signal;
    let enter,release,priorCalls=0;
    const entered=new Promise(resolve=>{enter=resolve;});
    const pending=new Promise(resolve=>{release=resolve;});
    const git=makeGitPort({faults:{inspectCommit:async(args,normal)=>{
      if(args.git_dir!==fixture.candidateDir)return normal();
      priorCalls++;const bytes=await normal();enter();await pending;return bytes;
    }}});
    let settled=false;
    const operation=buildProjectRevisionCandidate(fixture.revision,testPorts(git,{signal:controller.signal})).then(
      result=>{settled=true;return {result};},error=>{settled=true;return {error};});
    const first=await Promise.race([entered.then(()=>({entered:true})),operation]);
    assert.equal(first.entered,true,first.error?.code);
    controller.abort();await Promise.resolve();assert.equal(settled,false);
    release();const result=await operation;
    assert.equal(result.error?.code,'PROJECT_REVIEW_CANDIDATE_ABORTED');assert.equal(priorCalls,1);
    assert.equal(await fs.access(fixture.revision.original.candidate_dir).then(()=>true,()=>false),false);
  });
});

test('native revision CLI consumes explicit bounded correction files and prints no private paths or source',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);
    const receiptPath=join(root,'private-receipt.json'),contentPath=join(root,'private-correction.bin'),specPath=join(root,'private-spec.json');
    await fs.writeFile(receiptPath,fixture.receipt.receiptBytes,{mode:0o400});
    await fs.writeFile(contentPath,fixture.revision.corrections[0].bytes_data,{mode:0o400});
    const {receipt_bytes,...original}=fixture.revision.original;
    const {bytes_data,...correction}=fixture.revision.corrections[0];
    await fs.writeFile(specPath,JSON.stringify({...fixture.revision,
      original:{...original,receipt_path:receiptPath},corrections:[{...correction,content_path:contentPath}]}),{mode:0o400});
    const stdout=[],stderr=[];
    const code=await runProjectReviewCandidateCli(['--revise',specPath],{
      stdout:{write:chunk=>stdout.push(chunk)},stderr:{write:chunk=>stderr.push(chunk)}});
    assert.equal(code,0);assert.deepEqual(stderr,[]);
    const output=stdout.join('');assert.match(output,/^SOURCE_REVISION_CANDIDATE_CREATED\n/);
    assert.ok(output.includes(fixture.priorResult.candidate_commit));
    for(const secret of [root,'src/main.js','private-correction','owner corrected','original'])assert.equal(output.includes(secret),false);
    assert.match(output,/Changed path count: 3\n$/);
  });
});

test('revision accepts the exact whole-project 4MiB cap and rejects the next byte',async()=>{
  for(const overflow of [false,true])await ownedDirectory(async root=>{
    const stageFiles=[...Array.from({length:4},(_,i)=>sourceFile(`src/${i}.js`,'source')),
      ...Array.from({length:4},(_,i)=>assetFile(`assets/${i}.bin`,new Uint8Array([1])))];
    if(overflow)stageFiles.push(docFile('docs/one.md','x'));
    const fixture=await makeRevisionFixture(root,{stageFiles,baseFiles:[]});
    fixture.revision.corrections=stageFiles.filter(file=>file.classification!=='DOC').map(file=>{
      const old=asBytes(file.content);
      return {path:file.path,original:{blob:sha1Git('blob',old),bytes:old.length,sha256:hashBytes(old)},
        bytes_data:new Uint8Array(524288).fill(66)};
    });
    if(overflow)await rejectRevision(fixture);
    else{
      const result=await buildProjectRevisionCandidateNative(fixture.revision);
      assert.equal(result.revised_blobs.reduce((sum,item)=>sum+item.bytes,0),4194304);
      assert.equal(result.status,'SOURCE_REVISION_CANDIDATE_CREATED');
    }
  });
});

test('native correction CLI reader accepts exactly 512KiB and rejects overflow without raising receipt limits',async()=>{
  for(const overflow of [false,true])await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);
    const receiptPath=join(root,'receipt.json'),contentPath=join(root,'correction.bin'),specPath=join(root,'spec.json');
    await fs.writeFile(receiptPath,fixture.receipt.receiptBytes,{mode:0o400});
    await fs.writeFile(contentPath,new Uint8Array(overflow?524289:524288).fill(65),{mode:0o400});
    const {receipt_bytes,...original}=fixture.revision.original;
    const {bytes_data,...correction}=fixture.revision.corrections[0];
    await fs.writeFile(specPath,JSON.stringify({...fixture.revision,
      original:{...original,receipt_path:receiptPath},corrections:[{...correction,content_path:contentPath}]}),{mode:0o400});
    const stdout=[],stderr=[];
    const code=await runProjectReviewCandidateCli(['--revise',specPath],{
      stdout:{write:chunk=>stdout.push(chunk)},stderr:{write:chunk=>stderr.push(chunk)}});
    if(overflow){
      assert.equal(code,2);assert.deepEqual(stdout,[]);
      assert.deepEqual(stderr,['PROJECT_REVIEW_CANDIDATE_REJECTED\n']);
      assert.equal(await fs.access(fixture.revision.original.candidate_dir).then(()=>true,()=>false),false);
    }else{
      assert.equal(code,0);assert.deepEqual(stderr,[]);
      const resultOid=/Candidate commit: ([a-f0-9]{40})/.exec(stdout.join(''))[1];
      const blob=runGit(fixture.revision.original.candidate_dir,['rev-parse',`${resultOid}:src/main.js`]).toString('ascii').trim();
      assert.equal(runGit(fixture.revision.original.candidate_dir,['cat-file','blob',blob]).length,524288);
    }
  });
});

test('correction CLI reader rejects unsafe files and sanitized read/close failures without importing',async()=>{
  for(const kind of ['mode','symlink','read-close'])await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root);
    const receiptPath=join(root,'receipt.json'),contentPath=join(root,'correction.bin'),specPath=join(root,'spec.json');
    await fs.writeFile(receiptPath,fixture.receipt.receiptBytes,{mode:0o400});
    if(kind==='symlink')await fs.symlink(receiptPath,contentPath);
    else await fs.writeFile(contentPath,utf8.encode('bounded correction'),{mode:kind==='mode'?0o600:0o400});
    const {receipt_bytes,...original}=fixture.revision.original;
    const {bytes_data,...correction}=fixture.revision.corrections[0];
    await fs.writeFile(specPath,JSON.stringify({...fixture.revision,
      original:{...original,receipt_path:receiptPath},corrections:[{...correction,content_path:contentPath}]}),{mode:0o400});
    const stdout=[],stderr=[];let imports=0;
    const code=await runProjectReviewCandidateCli(['--revise',specPath],{
      ...(kind==='read-close'?{readCorrectionBytes:async()=>{throw new Error('PRIVATE_READ_CLOSE_ERROR');}}:{}),
      revise:async()=>{imports++;throw new Error('UNREACHABLE_IMPORT');},
      stdout:{write:chunk=>stdout.push(chunk)},stderr:{write:chunk=>stderr.push(chunk)}});
    assert.equal(code,2);assert.equal(imports,0);assert.deepEqual(stdout,[]);
    assert.deepEqual(stderr,['PROJECT_REVIEW_CANDIDATE_REJECTED\n']);
    assert.equal(await fs.access(fixture.revision.original.snapshot_dir).then(()=>true,()=>false),false);
  });
});

test('revision CLI caps each correction by remaining aggregate allowance before import',async()=>{
  for(const overflow of [false,true])await ownedDirectory(async root=>{
    const stageFiles=[...Array.from({length:4},(_,i)=>sourceFile(`src/${i}.js`,'source')),
      ...Array.from({length:4},(_,i)=>assetFile(`assets/${i}.bin`,new Uint8Array([1])))];
    if(overflow)stageFiles.push(docFile('docs/one.md','x'));
    const fixture=await makeRevisionFixture(root,{stageFiles,baseFiles:[]});
    const receiptPath=join(root,'receipt.json'),specPath=join(root,'spec.json');
    await fs.writeFile(receiptPath,fixture.receipt.receiptBytes,{mode:0o400});
    const corrections=[];
    for(let i=0;i<stageFiles.length;i++){
      const file=stageFiles[i],old=asBytes(file.content),contentPath=join(root,`correction-${i}.bin`);
      await fs.writeFile(contentPath,new Uint8Array(i===8?1:524288).fill(67),{mode:0o400});
      corrections.push({path:file.path,original:{blob:sha1Git('blob',old),bytes:old.length,sha256:hashBytes(old)},content_path:contentPath});
    }
    const {receipt_bytes,...original}=fixture.revision.original;
    await fs.writeFile(specPath,JSON.stringify({...fixture.revision,
      original:{...original,receipt_path:receiptPath},corrections}),{mode:0o400});
    const stdout=[],stderr=[];
    const code=await runProjectReviewCandidateCli(['--revise',specPath],{
      stdout:{write:chunk=>stdout.push(chunk)},stderr:{write:chunk=>stderr.push(chunk)}});
    if(overflow){
      assert.equal(code,2);assert.deepEqual(stdout,[]);assert.deepEqual(stderr,['PROJECT_REVIEW_CANDIDATE_REJECTED\n']);
      assert.equal(await fs.access(fixture.revision.original.snapshot_dir).then(()=>true,()=>false),false);
      let filesystemCalls=0;const apiCalls=[];
      const apiSpec={...fixture.revision,corrections:corrections.map((item,index)=>({
        path:item.path,original:item.original,bytes_data:new Uint8Array(index===8?1:524288).fill(67)
      }))};
      await assert.rejects(buildProjectRevisionCandidate(apiSpec,testPorts(makeGitPort({calls:apiCalls}),{
        fsPort:{...fixtureFs,lstat:async(...args)=>{filesystemCalls++;return fs.lstat(...args);}}
      })),{code:'INVALID_PROJECT_REVIEW_SPEC'});
      assert.equal(filesystemCalls,0);assert.equal(apiCalls.length,0);
      // Trusted injected-reader observation proves the call boundary receives
      // zero remaining bytes rather than another full-size read request.
      const requested=[];let imports=0;
      const observed=await runProjectReviewCandidateCli(['--revise',specPath],{
        readCorrectionBytes:async(path,maxBytes)=>{
          requested.push(maxBytes);
          if(maxBytes===0)throw new Error('SYNTHETIC_AGGREGATE_OVERFLOW');
          return new Uint8Array(maxBytes).fill(67);
        },
        revise:async()=>{imports++;throw new Error('UNREACHABLE_IMPORT');},
        stdout:{write:()=>{}},stderr:{write:()=>{}}
      });
      assert.equal(observed,2);assert.equal(imports,0);
      assert.deepEqual(requested,[524288,524288,524288,524288,524288,524288,524288,524288,0]);
    }else{
      assert.equal(code,0);assert.deepEqual(stderr,[]);
      assert.match(stdout.join(''),/^SOURCE_REVISION_CANDIDATE_CREATED\n/);
    }
  });
});


test('revision rejects reuse of the prior operation ID before filesystem or Git access',async()=>{
  await ownedDirectory(async root=>{
    const fixture=await makeRevisionFixture(root),calls=[];let filesystemCalls=0;
    fixture.revision.original.operation_id=fixture.revision.prior_candidate.operation_id;
    const error=await rejectRevision(fixture,fixture.revision,{
      git:makeGitPort({calls}),fsPort:{...fixtureFs,lstat:async(...args)=>{
        filesystemCalls++;return fs.lstat(...args);
      }}
    });
    assert.equal(error.code,'INVALID_PROJECT_REVIEW_SPEC');
    assert.equal(filesystemCalls,0);assert.equal(calls.length,0);
    assert.equal(await fs.access(fixture.revision.original.snapshot_dir).then(()=>true,()=>false),false);
    assert.equal(await fs.access(fixture.revision.original.candidate_dir).then(()=>true,()=>false),false);
  });
});


// Standard-profile acceptance was frozen before this implementation. All contents
// and stores below are synthetic; no generated program is imported or executed.
const rejectStandard=(fixture,spec=fixture.spec,options={})=>
  expectRejectedWithoutPromotion(fixture,spec,{...options,build:buildStandardProjectReviewCandidate});

test('standard native intake preserves exact source/base and feeds the existing review package',async()=>{
  for(const operatorAdmitted of [false,true])await ownedDirectory(async root=>{
    const bytes=utf8.encode('throw new Error("SQUIRE_GENERATED_CODE_EXECUTED");\n');
    const f=await makeReviewFixture(root,{standard:true,operatorAdmitted,
      stageFiles:[sourceFile('src/main.js',bytes),assetFile('assets/icon.bin',new Uint8Array([0,255,4]))],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('old\n')},{path:'docs/keep.md',bytes:utf8.encode('keep\n')}]});
    const before=await repoFileDigest(f.base.gitDir);
    const result=await buildStandardProjectReviewCandidateNative(f.spec);
    assert.equal(result.schema,'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1');
    assert.equal(result.human_review,'PENDING');assert.equal(result.task_correctness,'NOT_EVALUATED');
    assert.deepEqual(result.changed_paths,['assets/icon.bin','src/main.js']);
    const entries=readTreeMap(f.candidateDir,result.candidate_tree);
    assert.deepEqual(readGitBlob(f.candidateDir,entries.get('src/main.js').oid),bytes);
    const st=await fs.lstat(f.candidateDir),output=join(root,'review-package');
    const packaged=await buildProjectCandidateReviewPackage({schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1',
      result,candidate_git_dir:f.candidateDir,candidate_git_identity:{dev:st.dev,ino:st.ino},
      base_git_dir:f.base.gitDir,base_git_identity:f.base.identity,output_dir:output});
    assert.equal(packaged.changed_path_count,2);
    const verified=await verifyProjectCandidateReviewPackage(output);
    assert.equal(verified.status,'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED');
    assert.equal(verified.manifest_sha256,packaged.manifest_sha256);
    assert.deepEqual(await repoFileDigest(f.base.gitDir),before);
    assert.equal(JSON.stringify(result).includes(root),false);
  });
});

test('standard native intake accepts exact 1MiB and 50-path bounds with unchanged class caps',async()=>{
  for(const maximum of ['bytes','paths'])await ownedDirectory(async root=>{
    const files=maximum==='bytes'?[sourceFile('src/main.js',new Uint8Array(65536).fill(65)),
      assetFile('assets/a.bin',new Uint8Array(524288)),assetFile('assets/b.bin',new Uint8Array(458752))]:
      [...Array.from({length:25},(_,i)=>sourceFile(`src/a${i}.js`,'a')),
        ...Array.from({length:20},(_,i)=>assetFile(`assets/a${i}.bin`,new Uint8Array([1]))),
        ...Array.from({length:5},(_,i)=>docFile(`docs/a${i}.md`,'d'))];
    const f=await makeReviewFixture(root,{standard:true,stageFiles:files});
    assert.equal(f.stageAck.total_bytes,maximum==='bytes'?1048576:50);
    assert.equal((await buildStandardProjectReviewCandidateNative(f.spec)).changed_paths.length,files.length);
  });
});

test('standard native intake rejects a physically valid stage above its 1MiB receipt ceiling',async()=>{
  await ownedDirectory(async root=>{
    const f=await makeReviewFixture(root,{standard:true,rawReceipt:true,stageFiles:[
      sourceFile('src/main.js',new Uint8Array(65536).fill(65)),
      assetFile('assets/a.bin',new Uint8Array(524288)),assetFile('assets/b.bin',new Uint8Array(458753))]});
    assert.equal(f.stageAck.total_bytes,1048577);
    const calls=[],git=makeGitPort({calls});await rejectStandard(f,f.spec,{git});
    assert.equal(calls.length,0);await assert.rejects(fs.lstat(f.snapshotDir),{code:'ENOENT'});
  });
});

test('standard and large entry points reject wrong profiles and relabel-only mutants',async()=>{
  for(const standard of [true,false])await ownedDirectory(async root=>{
    const f=await makeReviewFixture(root,{standard,stageFiles:[sourceFile('src/main.js','safe bytes\n')]});
    const wrong={...f.spec,schema:standard?'SQUIRE_PROJECT_REVIEW_IMPORT_V1':'SQUIRE_STANDARD_PROJECT_REVIEW_IMPORT_V1'};
    if(standard)await expectRejectedWithoutPromotion(f,wrong);else await rejectStandard(f,wrong);
    const envelope=structuredClone(f.receipt.envelope);
    envelope.schema=standard?'SQUIRE3_NATIVE_PROJECT_LARGE_OBSERVATION_RESULT_RECEIPT_V1':'SQUIRE3_NATIVE_PROJECT_RESULT_RECEIPT_V1';
    const bytes=utf8.encode(JSON.stringify(envelope));
    const mutation={...wrong,receipt_bytes:bytes,receipt_sha256:hashBytes(bytes),
      snapshot_dir:join(root,'mutant-snapshot'),candidate_dir:join(root,'mutant.git')};
    if(standard)await expectRejectedWithoutPromotion(f,mutation);else await rejectStandard(f,mutation);
  });
});

test('standard receipt cap is exactly 256KiB and malformed bindings reject before promotion',async()=>{
  await ownedDirectory(async root=>{
    const f=await makeReviewFixture(root,{standard:true,stageFiles:[sourceFile('src/main.js','new\n')]});
    const padded=new Uint8Array(262144).fill(32);padded.set(f.spec.receipt_bytes);
    const exact={...f.spec,receipt_bytes:padded,receipt_sha256:hashBytes(padded)};
    assert.equal((await buildStandardProjectReviewCandidateNative(exact)).status,'SOURCE_CANDIDATE_CREATED');
    const tooLarge=new Uint8Array(262145).fill(32);tooLarge.set(f.spec.receipt_bytes);
    await rejectStandard(f,{...candidateSpec(f,'overflow'),receipt_bytes:tooLarge,receipt_sha256:hashBytes(tooLarge)});
    for(const [index,mutate] of [
      e=>{e.result.staging.operation_acknowledgement='UNKNOWN';},
      e=>{e.result.staging.manifest_sha256='f'.repeat(64);},
      e=>{e.result.staging.file_count++;},
      e=>{e.result.staging.stage_operation_id='stage-wrong';},
      e=>{e.result.status='FAILED';},
      e=>{e.result.staging.output_profile=LARGE_PROFILE;}
    ].entries()){
      const e=structuredClone(f.receipt.envelope);mutate(e);const bytes=utf8.encode(JSON.stringify(e));
      await rejectStandard(f,{...candidateSpec(f,`bad-${index}`),receipt_bytes:bytes,receipt_sha256:hashBytes(bytes)});
    }
    await rejectStandard(f,{...candidateSpec(f,'digest'),receipt_sha256:'f'.repeat(64)});
    await rejectStandard(f,{...candidateSpec(f,'path'),allowed_changes:[{path:'.git/config',original:null}]});
    await rejectStandard(f,{...candidateSpec(f,'base'),base_tree:'f'.repeat(40)});
  });
});

test('standard intake final rechecks catch stage and snapshot mutation while retaining partial output',async()=>{
  for(const mutation of ['stage','snapshot'])await ownedDirectory(async root=>{
    const f=await makeReviewFixture(root,{standard:true,stageFiles:[sourceFile('src/main.js','new\n')]});
    const calls=[],git=makeGitPort({calls,faults:{writeBlob:async(_args,write)=>{
      const oid=await write(),p=mutation==='stage'?join(f.stageDir,'src/main.js'):join(f.snapshotDir,'project/src/main.js');
      await fs.chmod(p,0o600);await fs.writeFile(p,'mutated\n');await fs.chmod(p,0o400);return oid;
    }}});
    await rejectStandard(f,f.spec,{git});assert.equal(calls.filter(c=>c.name==='createRef').length,0);
    assert.equal((await fs.lstat(f.candidateDir)).isDirectory(),true);
  });
});

test('standard intake abort and sanitized I/O failures never promote or retry',async()=>{
  for(const fault of ['abort','mkdir','close','symlink'])await ownedDirectory(async root=>{
    const f=await makeReviewFixture(root,{standard:true,stageFiles:[sourceFile('src/main.js','new\n')]});
    const controller=new AbortController(),calls=[];let fsPort=fixtureFs;
    const git=makeGitPort({calls,faults:fault==='abort'?{writeBlob:async(_a,write)=>{
      const oid=await write();controller.abort();return oid;}}:{}});
    if(fault==='mkdir')fsPort={...fixtureFs,mkdir:async(p,...args)=>{
      if(p===f.snapshotDir)throw new Error(`PRIVATE_SENTINEL ${root}`);return fs.mkdir(p,...args);}};
    if(fault==='close')fsPort={...fixtureFs,open:async(...args)=>{
      const h=await fs.open(...args);return {stat:()=>h.stat(),read:(...a)=>h.read(...a),writeFile:(...a)=>h.writeFile(...a),
        close:async()=>{await h.close();throw new Error(`PRIVATE_SENTINEL ${root}`);}};}};
    if(fault==='symlink'){
      await fs.unlink(join(f.stageDir,'src/main.js'));await fs.symlink('/no/private/access',join(f.stageDir,'src/main.js'));
    }
    f.spec.signal=controller.signal;
    const error=await rejectStandard(f,f.spec,{git,portsFs:fsPort,signal:controller.signal});
    assert.equal(String(error).includes('PRIVATE_SENTINEL'),false);
    assert.equal(calls.filter(c=>c.name==='createRef').length,0);
  });
});


const standardRevisionCorrection=(fixture,path,bytes)=>{
  const previous=asBytes(fixture.stageFiles.find(file=>file.path===path).content);
  return {path,original:{blob:sha1Git('blob',previous),bytes:previous.length,sha256:hashBytes(previous)},
    bytes_data:asBytes(bytes)};
};
const standardRevisionSpec=(fixture,suffix,corrections)=>({...fixture.revision,
  original:{...candidateSpec(fixture,`standard-revision-${suffix}`),operation_id:`standard-revision-${suffix}`},corrections});
const rejectStandardRevision=(f,r=f.revision,options={})=>rejectRevision(f,r,{...options,standard:true});

test('standard revision feeds existing two-view review and explicit synthetic decisions',async()=>{
  await ownedDirectory(async root=>{
    const baseRestore=utf8.encode('base restored bytes\n');
    const f=await makeRevisionFixture(root,{standard:true,
      stageFiles:[sourceFile('src/main.js','original main\n'),sourceFile('src/restore.js','original restore\n'),
        sourceFile('src/unchanged.js','unchanged original\n'),assetFile('assets/icon.bin',new Uint8Array([0,255,1]))],
      baseFiles:[{path:'src/main.js',bytes:utf8.encode('base main\n')},
        {path:'src/restore.js',bytes:baseRestore},{path:'src/unchanged.js',bytes:utf8.encode('base unchanged\n')}]});
    const before=await revisionInputsDigest(f);
    const corrections=[standardRevisionCorrection(f,'src/main.js','owner corrected\n'),
      standardRevisionCorrection(f,'src/restore.js',baseRestore),
      standardRevisionCorrection(f,'assets/icon.bin',new Uint8Array([0,255,2]))];
    const revision=standardRevisionSpec(f,'positive',corrections);
    const revised=await buildStandardProjectRevisionCandidateNative(revision);
    assert.equal(revised.schema,'SQUIRE_PROJECT_REVISION_CANDIDATE_V1');
    assert.equal(revised.correction_origin,'OPERATOR_SUPPLIED');assert.equal(revised.human_review,'PENDING');
    assert.deepEqual(revised.revision_of,{commit:f.priorResult.candidate_commit,tree:f.priorResult.candidate_tree});
    assert.equal(revised.receipt_sha256,f.priorResult.receipt_sha256);
    assert.equal(revised.stage_manifest_sha256,f.priorResult.stage_manifest_sha256);
    assert.deepEqual(await revisionInputsDigest(f),before);
    const identity=async dir=>{const st=await fs.lstat(dir);return {dev:st.dev,ino:st.ino};};
    const originalDir=join(root,'original-review');
    const originalPackage=await buildProjectCandidateReviewPackage({schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1',
      result:f.priorResult,candidate_git_dir:f.candidateDir,candidate_git_identity:await identity(f.candidateDir),
      base_git_dir:f.base.gitDir,base_git_identity:f.base.identity,output_dir:originalDir});
    const priorDir=join(root,'synthetic-prior-decision');
    const prior=await recordProjectCandidateDecision(originalDir,{
      schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'synthetic-prior',reviewer_label:'synthetic-fixture',
      review_package_sha256:originalPackage.manifest_sha256,base_commit:f.base.commit,base_tree:f.base.tree,
      candidate_commit:f.priorResult.candidate_commit,candidate_tree:f.priorResult.candidate_tree,
      choice:'REVISE',attestations:[]},priorDir);
    const output=join(root,'revision-review');
    const built=await buildProjectRevisionReviewPackage({schema:'SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1',
      original_result:f.priorResult,revised_result:revised,
      base_git_dir:f.base.gitDir,base_git_identity:f.base.identity,
      original_git_dir:f.candidateDir,original_git_identity:await identity(f.candidateDir),
      revised_git_dir:revision.original.candidate_dir,revised_git_identity:await identity(revision.original.candidate_dir),
      output_dir:output,original_package:{dir:originalDir,manifest_sha256:originalPackage.manifest_sha256},
      prior_decisions:[{dir:priorDir,file_sha256:prior.decision_sha256}],selected_decision_id:'synthetic-prior'});
    const manifest=JSON.parse(await fs.readFile(join(output,'revision-review-manifest.json')));
    assert.equal(built.base_to_revised_count,3);assert.equal(built.original_to_revised_count,3);
    assert.equal(manifest.original_to_revised.find(x=>x.path==='src/restore.js').classification,'RESTORED_BASE');
    assert.ok(manifest.base_to_revised.some(x=>x.path==='src/unchanged.js'));
    assert.equal((await verifyProjectRevisionReviewPackage(output)).manifest_sha256,built.manifest_sha256);
    const attestations=['base_to_revised','original_to_revised'].flatMap(view=>manifest[view].map(item=>({
      view,path:item.path,old_sha256:item.old?.sha256??null,new_sha256:item.new.sha256,
      binary_inspected:item.binary_review_required})));
    const decision={schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'synthetic-fresh',reviewer_label:'synthetic-fixture',
      revision_package_sha256:built.manifest_sha256,original_package_sha256:originalPackage.manifest_sha256,
      prior_revise_decision_sha256:prior.decision_sha256,base_commit:manifest.base_commit,base_tree:manifest.base_tree,
      original_commit:manifest.original_commit,original_tree:manifest.original_tree,
      revised_commit:manifest.revised_commit,revised_tree:manifest.revised_tree,choice:'ACCEPT',attestations};
    const decisionDir=join(root,'synthetic-new-decision');
    const recorded=await recordProjectRevisionDecision(output,decision,decisionDir);
    assert.equal((await verifyProjectRevisionDecision(output,decisionDir,recorded.decision_sha256)).choice,'ACCEPT');
    await assert.rejects(()=>recordProjectRevisionDecision(output,{...decision,decision_id:'missing-view',
      attestations:attestations.slice(1)},join(root,'missing-view')));
    assert.deepEqual(await revisionInputsDigest(f),before);
  });
});

test('standard revision enforces actual class limits and full project bytes including unchanged paths',async()=>{
  await ownedDirectory(async root=>{
    const f=await makeRevisionFixture(root,{standard:true,stageFiles:[sourceFile('src/main.js','old'),
      assetFile('assets/a.bin',new Uint8Array([1])),assetFile('assets/b.bin',new Uint8Array([2]))]});
    const exact=standardRevisionSpec(f,'exact',[standardRevisionCorrection(f,'src/main.js','n'),
      standardRevisionCorrection(f,'assets/a.bin',new Uint8Array(524288)),
      standardRevisionCorrection(f,'assets/b.bin',new Uint8Array(524287))]);
    assert.equal((await buildStandardProjectRevisionCandidateNative(exact)).status,'SOURCE_REVISION_CANDIDATE_CREATED');
    const fullOverflow=standardRevisionSpec(f,'full-overflow',[
      standardRevisionCorrection(f,'assets/a.bin',new Uint8Array(524288)),
      standardRevisionCorrection(f,'assets/b.bin',new Uint8Array(524288))]);
    const calls=[],git=makeGitPort({calls});await rejectStandardRevision(f,fullOverflow,{git});
    assert.equal(calls.some(c=>c.name==='initBare'),false,'full revised ceiling must precede candidate writes');
    const captureOverflow=standardRevisionSpec(f,'capture-overflow',exact.corrections.map(item=>
      item.path==='src/main.js'?standardRevisionCorrection(f,'src/main.js','nn'):item));
    await rejectStandardRevision(f,captureOverflow);
    await rejectStandardRevision(f,standardRevisionSpec(f,'source-overflow',[
      standardRevisionCorrection(f,'src/main.js',new Uint8Array(65537).fill(65))]));
    await rejectStandardRevision(f,standardRevisionSpec(f,'asset-overflow',[
      standardRevisionCorrection(f,'assets/a.bin',new Uint8Array(524289))]));
    await rejectStandardRevision(f,standardRevisionSpec(f,'source-empty',[
      standardRevisionCorrection(f,'src/main.js',new Uint8Array())]));
    assert.equal((await buildStandardProjectRevisionCandidateNative(standardRevisionSpec(f,'source-exact',[
      standardRevisionCorrection(f,'src/main.js',new Uint8Array(65536).fill(65))]))).status,'SOURCE_REVISION_CANDIDATE_CREATED');
  });
  await ownedDirectory(async root=>{
    const f=await makeRevisionFixture(root,{standard:true,
      stageFiles:Array.from({length:9},(_,i)=>sourceFile(`src/a${i}.js`,'a'))});
    const atCap=Array.from({length:8},(_,i)=>standardRevisionCorrection(f,`src/a${i}.js`,new Uint8Array(65536).fill(65)));
    // Nine one-byte SOURCEs:8*64KiB+one unchanged byte exceeds512KiB.
    await rejectStandardRevision(f,standardRevisionSpec(f,'source-aggregate-over',atCap));
    const exact=atCap.map((x,i)=>i===7?{...x,bytes_data:new Uint8Array(65535).fill(65)}:x);
    assert.equal((await buildStandardProjectRevisionCandidateNative(standardRevisionSpec(f,'source-aggregate-exact',exact))).status,
      'SOURCE_REVISION_CANDIDATE_CREATED');
  });
});

test('standard revision accepts fifty corrections and preserves larger unchanged base preimages',async()=>{
  await ownedDirectory(async root=>{
    const files=[...Array.from({length:25},(_,i)=>sourceFile(`src/a${i}.js`,'a')),
      ...Array.from({length:20},(_,i)=>assetFile(`assets/a${i}.bin`,new Uint8Array([1]))),
      ...Array.from({length:5},(_,i)=>docFile(`docs/a${i}.md`,'d'))];
    const f=await makeRevisionFixture(root,{standard:true,stageFiles:files});
    const corrections=files.map(file=>standardRevisionCorrection(f,file.path,
      file.classification==='LOCAL_ASSET'?new Uint8Array([2]):'z'));
    const calls=[],git=makeGitPort({calls});
    await rejectStandardRevision(f,standardRevisionSpec(f,'fifty-one',[...corrections,corrections[0]]),{git});
    assert.equal(calls.length,0,'correction count overflow must reject before Git I/O');
    const revised=await buildStandardProjectRevisionCandidateNative(standardRevisionSpec(f,'fifty',corrections));
    assert.equal(revised.revised_blobs.length,50);
  });
  await ownedDirectory(async root=>{
    const f=await makeRevisionFixture(root,{standard:true,
      stageFiles:[sourceFile('src/main.js','new')],baseFiles:[{path:'src/main.js',bytes:new Uint8Array(2*1048576)}]});
    assert.equal((await buildStandardProjectRevisionCandidateNative(f.revision)).status,'SOURCE_REVISION_CANDIDATE_CREATED');
  });
});

test('standard revision rejects cross-profile, witness, identity, chain and scope mutants',async()=>{
  await ownedDirectory(async root=>{
    const f=await makeRevisionFixture(root,{standard:true});
    for(const [i,mutate] of [
      r=>{r.schema='SQUIRE_PROJECT_REVIEW_REVISION_V1';},
      r=>{r.original.schema='SQUIRE_PROJECT_REVIEW_IMPORT_V1';},
      r=>{r.prior_candidate.identity.ino++;},
      r=>{r.prior_candidate.tree='f'.repeat(40);},
      r=>{r.prior_candidate.commit='f'.repeat(40);},
      r=>{r.prior_candidate.operation_id='wrong-ref';},
      r=>{r.corrections[0].original.sha256='f'.repeat(64);},
      r=>{r.corrections[0].bytes_data=asBytes(f.stageFiles[0].content);},
      r=>{r.corrections[0].path='src/outside.js';},
      r=>{r.original.receipt_sha256='f'.repeat(64);}
    ].entries()){
      const r=standardRevisionSpec(f,`mutant-${i}`,f.revision.corrections.map(c=>({...c,original:{...c.original}})));
      r.prior_candidate={...r.prior_candidate,identity:{...r.prior_candidate.identity}};mutate(r);
      await rejectStandardRevision(f,r);
    }
    await assert.rejects(()=>buildProjectRevisionCandidateNative(f.revision));
    const revised=await buildStandardProjectRevisionCandidateNative(f.revision);
    const st=await fs.lstat(f.revision.original.candidate_dir);
    const chain=standardRevisionSpec(f,'chain',f.revision.corrections);
    chain.prior_candidate={git_dir:f.revision.original.candidate_dir,identity:{dev:st.dev,ino:st.ino},
      operation_id:revised.operation_id,commit:revised.candidate_commit,tree:revised.candidate_tree};
    await rejectStandardRevision(f,chain);
  });
  await ownedDirectory(async root=>{
    const f=await makeRevisionFixture(root);
    await rejectStandardRevision(f,{...f.revision,schema:'SQUIRE_STANDARD_PROJECT_REVIEW_REVISION_V1'});
  });
});

test('standard revision abort, final prior mutation and Git I/O errors withhold promotion',async()=>{
  for(const failure of ['abort','prior-ref','io'])await ownedDirectory(async root=>{
    const f=await makeRevisionFixture(root,{standard:true});const controller=new AbortController();
    f.revision.original.signal=controller.signal;
    let calls=0;
    const git=makeGitPort({faults:{writeBlob:async(_args,write)=>{
      calls++;const oid=await write();
      if(failure==='abort')controller.abort();
      if(failure==='prior-ref')runGit(f.candidateDir,['update-ref',`refs/heads/candidate-${f.spec.operation_id}`,f.base.commit]);
      if(failure==='io')throw new Error(`PRIVATE_ERROR ${root}`);
      return oid;
    }}});
    if(failure==='prior-ref'){
      // The deliberate fault changes a synthetic prior ref; assert rejection
      // directly rather than asking the preservation helper to bless the mutation.
      await assert.rejects(()=>buildStandardProjectRevisionCandidate(f.revision,testPorts(git,{signal:controller.signal})),
        e=>e.code==='PROJECT_REVIEW_CANDIDATE_REJECTED'&&!String(e).includes(root));
      assert.equal(readRef(f.revision.original.candidate_dir,'refs/heads/candidate-revision'),null);
    }else await rejectStandardRevision(f,f.revision,{git});
    assert.equal(calls,failure==='prior-ref'?3:1);
  });
});

test('standard CLI builds a disposable candidate through the standard native adapter',async()=>{
  await ownedDirectory(async root=>{
    const f=await makeReviewFixture(root,{standard:true});
    const receiptPath=join(root,'receipt.json'),specPath=join(root,'spec.json');
    const {receipt_bytes,...fields}=f.spec;
    await fs.writeFile(receiptPath,receipt_bytes,{mode:0o400});
    await fs.writeFile(specPath,JSON.stringify({...fields,receipt_path:receiptPath}),{mode:0o400});
    const stdout=[],stderr=[];
    assert.equal(await runProjectReviewCandidateCli(['--build-standard',specPath],{
      stdout:{write:s=>stdout.push(s)},stderr:{write:s=>stderr.push(s)}}),0);
    assert.deepEqual(stderr,[]);assert.match(stdout.join(''),/^SOURCE_CANDIDATE_CREATED\n/);
    assert.match(readRef(f.candidateDir,`refs/heads/candidate-${f.spec.operation_id}`),/^[a-f0-9]{40}$/);
    assert.equal(stdout.join('').includes(root),false);
  });
});

test('standard CLI revisions preserve prior inputs and create a fresh candidate',async()=>{
  await ownedDirectory(async root=>{
    const f=await makeRevisionFixture(root,{standard:true}),before=await revisionInputsDigest(f);
    const receiptPath=join(root,'receipt.json'),contentPath=join(root,'correction.bin'),specPath=join(root,'spec.json');
    await fs.writeFile(receiptPath,f.receipt.receiptBytes,{mode:0o400});
    await fs.writeFile(contentPath,f.revision.corrections[0].bytes_data,{mode:0o400});
    const {receipt_bytes,...original}=f.revision.original;
    const {bytes_data,...correction}=f.revision.corrections[0];
    await fs.writeFile(specPath,JSON.stringify({...f.revision,original:{...original,receipt_path:receiptPath},
      corrections:[{...correction,content_path:contentPath}]}),{mode:0o400});
    const stdout=[],stderr=[];
    assert.equal(await runProjectReviewCandidateCli(['--revise-standard',specPath],{
      stdout:{write:s=>stdout.push(s)},stderr:{write:s=>stderr.push(s)}}),0);
    assert.deepEqual(stderr,[]);assert.match(stdout.join(''),/^SOURCE_REVISION_CANDIDATE_CREATED\n/);
    assert.ok(stdout.join('').includes(f.priorResult.candidate_commit));
    assert.equal(stdout.join('').includes(root),false);
    assert.deepEqual(await revisionInputsDigest(f),before);
  });
});
