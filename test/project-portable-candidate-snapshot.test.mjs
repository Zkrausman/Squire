import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {constants as fsConstants,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {
  buildProjectPortableCandidateSnapshot,
  verifyProjectPortableCandidateSnapshot,
  runProjectPortableCandidateSnapshotCli
} from '../src/project-portable-candidate-snapshot.mjs';

const GIT='/usr/bin/git';
const gitConfig=[
  '-c','core.hooksPath=/dev/null','-c','core.attributesFile=/dev/null',
  '-c','core.fsmonitor=false','-c','core.autocrlf=false','-c','core.pager=cat',
  '-c','protocol.allow=never','-c','commit.gpgSign=false'
];
const gitEnv={
  PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',
  GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',
  GIT_ALLOW_PROTOCOL:'',GIT_AUTHOR_NAME:'Portable Snapshot Fixture',
  GIT_AUTHOR_EMAIL:'snapshot@example.invalid',GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME:'Portable Snapshot Fixture',GIT_COMMITTER_EMAIL:'snapshot@example.invalid',
  GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'
};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function fsPort(overrides={}){
  return {
    lstat:overrides.lstat??((...args)=>fs.lstat(...args)),
    realpath:overrides.realpath??((...args)=>fs.realpath(...args)),
    open:overrides.open??((...args)=>fs.open(...args)),
    mkdir:overrides.mkdir??((...args)=>fs.mkdir(...args)),
    chmod:overrides.chmod??((...args)=>fs.chmod(...args)),
    opendir:overrides.opendir??((...args)=>fs.opendir(...args))
  };
}
function canonicalJson(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  const keys=Object.keys(value).sort();
  return `{${keys.map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function git(gitDir,args,{input,allowCodes=[]}={}){
  try{
    return execFileSync(GIT,[...gitConfig,`--git-dir=${gitDir}`,...args],{
      cwd:gitDir,env:gitEnv,input,encoding:'buffer',maxBuffer:16*1024*1024,
      stdio:['pipe','pipe','pipe']
    });
  }catch(error){if(allowCodes.includes(error.status))return error.stdout??Buffer.alloc(0);throw error;}
}
function initBare(path){
  execFileSync(GIT,[...gitConfig,'init','--bare','--shared=0600','--quiet','--template=/dev/null','--object-format=sha1',path],{
    cwd:dirname(path),env:gitEnv,encoding:'buffer',maxBuffer:65536,stdio:['ignore','pipe','pipe']
  });
}
function blob(gitDir,bytes){return git(gitDir,['hash-object','--no-filters','-w','--stdin'],{input:bytes}).toString('ascii').trim();}
function tree(gitDir,entries){
  const root={dirs:new Map(),files:[]};
  for(const entry of entries){
    const parts=entry.path.split('/');let node=root;
    for(const part of parts.slice(0,-1)){
      if(!node.dirs.has(part))node.dirs.set(part,{dirs:new Map(),files:[]});
      node=node.dirs.get(part);
    }
    node.files.push({...entry,name:parts.at(-1)});
  }
  const build=node=>{
    const rows=[];
    for(const [name,child] of node.dirs)rows.push({name,key:`${name}/`,mode:'040000',type:'tree',oid:build(child)});
    for(const file of node.files)rows.push({name:file.name,key:file.name,mode:file.mode??'100644',type:'blob',oid:file.oid});
    rows.sort((a,b)=>Buffer.compare(Buffer.from(a.key),Buffer.from(b.key)));
    const input=Buffer.concat(rows.map(row=>Buffer.from(`${row.mode} ${row.type} ${row.oid}\t${row.name}\0`)));
    return git(gitDir,['mktree','-z'],{input}).toString('ascii').trim();
  };
  return build(root);
}
function commit(gitDir,treeOid,parent=null,message='Fixture commit'){
  const args=['commit-tree',treeOid];if(parent)args.push('-p',parent);args.push('-m',message);
  return git(gitDir,args).toString('ascii').trim();
}
async function withRoot(run){
  const root=await fs.mkdtemp(join(tmpdir(),'squire-portable-candidate-'));
  await fs.chmod(root,0o700);
  try{return await run(root);}finally{await fs.rm(root,{recursive:true,force:true});}
}
async function makeFixture(root,{
  executableAddition=false,oversize=false,executableBase=false,wrongParent=false,
  symlinkAddition=false,caseFoldCollision=false
}={}){
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const baseDir=join(root,'base.git'),candidateDir=join(root,'candidate.git');
  initBare(baseDir);initBare(candidateDir);
  const original=[
    {path:'src/app.mjs',bytes:Buffer.from('export const version = 1;\n')},
    {path:'docs/guide.md',bytes:Buffer.from('# Review guide\n')},
    {path:'assets/icon.bin',bytes:Buffer.from([0,255,4,0,17])}
  ];
  const firstEntries=original.map(file=>({path:file.path,
    mode:executableBase&&file.path==='assets/icon.bin'?'100755':'100644',oid:blob(baseDir,file.bytes)}));
  const firstTree=tree(baseDir,firstEntries),firstCommit=commit(baseDir,firstTree,null,'Older base commit');
  const baseTree=tree(baseDir,firstEntries);
  const baseCommit=commit(baseDir,baseTree,firstCommit,'Pinned project base');
  const neighborBlob=blob(baseDir,Buffer.from('unrelated ref payload\n'));
  const neighborTree=tree(baseDir,[{path:'private/neighbor.txt',mode:'100644',oid:neighborBlob}]);
  const neighborCommit=commit(baseDir,neighborTree,firstCommit,'Neighbor ref');
  git(baseDir,['update-ref','refs/heads/neighbor',neighborCommit]);
  const alternate=Buffer.from(`${join(baseDir,'objects')}\n`);
  await fs.writeFile(join(candidateDir,'objects','info','alternates'),alternate,{mode:0o600});
  await fs.chmod(join(candidateDir,'objects','info','alternates'),0o600);
  const revised=Buffer.from('export const version = 2;\n');
  const addition=oversize?Buffer.alloc(4*1024*1024+(oversize==='exact'?0:1),0x61):Buffer.from('Portable candidate documentation.\n');
  const candidateEntries=[
    {path:'src/app.mjs',mode:'100644',oid:blob(candidateDir,revised)},
    {path:'docs/guide.md',mode:'100644',oid:firstEntries[1].oid},
    {path:'assets/icon.bin',mode:firstEntries[2].mode,oid:firstEntries[2].oid},
    {path:'docs/new.txt',mode:symlinkAddition?'120000':executableAddition?'100755':'100644',oid:blob(candidateDir,addition)}
  ];
  if(caseFoldCollision)candidateEntries.push({path:'SRC/app.mjs',mode:'100644',oid:blob(candidateDir,Buffer.from('case collision\n'))});
  const candidateTree=tree(candidateDir,candidateEntries);
  const candidateCommit=commit(candidateDir,candidateTree,wrongParent?firstCommit:baseCommit,'Candidate review commit');
  git(candidateDir,['update-ref','refs/heads/candidate-portable-fixture',candidateCommit]);
  const identity=async path=>{const stat=await fs.stat(path);return {dev:stat.dev,ino:stat.ino};};
  const result={
    schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',
    operation_id:'portable-fixture',candidate_ref:'refs/heads/candidate-portable-fixture',
    base_commit:baseCommit,base_tree:baseTree,candidate_commit:candidateCommit,candidate_tree:candidateTree,
    receipt_sha256:'1'.repeat(64),stage_manifest_sha256:'2'.repeat(64),
    changed_paths:caseFoldCollision?['SRC/app.mjs','docs/new.txt','src/app.mjs']:['docs/new.txt','src/app.mjs'],task_correctness:'NOT_EVALUATED',
    human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',benchmark_acceptance:'NOT_ESTABLISHED',
    origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'
  };
  const candidateIdentity=await identity(candidateDir),baseIdentity=await identity(baseDir);
  const request=(outputDir,overrides={})=>({
    schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1',result,
    candidate_git_dir:candidateDir,candidate_git_identity:overrides.candidate_git_identity??candidateIdentity,
    base_git_dir:baseDir,base_git_identity:overrides.base_git_identity??baseIdentity,
    output_dir:outputDir,...overrides
  });
  return {
    baseDir,candidateDir,baseCommit,baseTree,candidateCommit,candidateTree,neighborBlob,neighborCommit,firstCommit,
    expectedCandidateFiles:new Map(candidateEntries.map(entry=>[entry.path,
      entry.path==='src/app.mjs'?revised:entry.path==='docs/new.txt'?addition:
        entry.path==='SRC/app.mjs'?Buffer.from('case collision\n'):original.find(file=>file.path===entry.path).bytes
    ])),
    result,request
  };
}
async function rejectedBuild(spec,code='PROJECT_PORTABLE_SNAPSHOT_REJECTED'){
  await assert.rejects(buildProjectPortableCandidateSnapshot(spec),error=>error.code===code);
}
async function makeBoundaryFixture(root,baseCount=2048,changeCount=50){
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const baseDir=join(root,'base.git'),candidateDir=join(root,'candidate.git');initBare(baseDir);initBare(candidateDir);
  const shared=blob(baseDir,Buffer.from('x'));
  const baseEntries=Array.from({length:baseCount},(_,index)=>({
    path:`base/f${String(index).padStart(4,'0')}.txt`,mode:'100644',oid:shared
  }));
  const baseTree=tree(baseDir,baseEntries),baseCommit=commit(baseDir,baseTree);
  await fs.writeFile(join(candidateDir,'objects','info','alternates'),`${join(baseDir,'objects')}\n`,{mode:0o600});
  await fs.chmod(join(candidateDir,'objects','info','alternates'),0o600);
  const changes=Array.from({length:changeCount},(_,index)=>`new/f${String(index).padStart(4,'0')}.txt`);
  const candidateEntries=[...baseEntries,...changes.map(path=>({path,mode:'100644',oid:shared}))];
  const candidateTree=tree(candidateDir,candidateEntries);
  const candidateCommit=commit(candidateDir,candidateTree,baseCommit);
  git(candidateDir,['update-ref','refs/heads/candidate-boundary-fixture',candidateCommit]);
  const identity=async path=>{const stat=await fs.stat(path);return {dev:stat.dev,ino:stat.ino};};
  const candidateIdentity=await identity(candidateDir),baseIdentity=await identity(baseDir);
  const result={
    schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',
    operation_id:'boundary-fixture',candidate_ref:'refs/heads/candidate-boundary-fixture',
    base_commit:baseCommit,base_tree:baseTree,candidate_commit:candidateCommit,candidate_tree:candidateTree,
    receipt_sha256:'3'.repeat(64),stage_manifest_sha256:'4'.repeat(64),changed_paths:changes,
    task_correctness:'NOT_EVALUATED',human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',
    benchmark_acceptance:'NOT_ESTABLISHED',origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',
    base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'
  };
  return {
    baseDir,candidateDir,baseCommit,candidateCommit,result,
    request:outputDir=>({schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1',result,
      candidate_git_dir:candidateDir,candidate_git_identity:candidateIdentity,
      base_git_dir:baseDir,base_git_identity:baseIdentity,output_dir:outputDir})
  };
}
async function makeLargeFixture(root,{copies,blobBytes=4*1024*1024,unique=false,tailBytes=null}){
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const baseDir=join(root,'base.git'),candidateDir=join(root,'candidate.git');initBare(baseDir);initBare(candidateDir);
  const baseBlob=blob(baseDir,Buffer.from('base'));
  const baseTree=tree(baseDir,[{path:'src/base.txt',mode:'100644',oid:baseBlob}]);
  const baseCommit=commit(baseDir,baseTree);
  await fs.writeFile(join(candidateDir,'objects','info','alternates'),`${join(baseDir,'objects')}\n`,{mode:0o600});
  await fs.chmod(join(candidateDir,'objects','info','alternates'),0o600);
  const changedPaths=Array.from({length:copies},(_,index)=>`assets/data-${String(index).padStart(2,'0')}.bin`);
  const blobIds=[];
  for(let index=0;index<copies;index++){
    const bytes=Buffer.alloc(blobBytes,unique?index+1:0x5a);
    blobIds.push(blob(candidateDir,bytes));bytes.fill(0);
  }
  const candidateEntries=[{path:'src/base.txt',mode:'100644',oid:baseBlob},...changedPaths.map((path,index)=>({
    path,mode:'100644',oid:blobIds[index]
  }))];
  if(tailBytes!==null){
    const tail=Buffer.alloc(tailBytes,0x62);
    candidateEntries.push({path:'assets/tail.bin',mode:'100644',oid:blob(candidateDir,tail)});
    tail.fill(0);
    changedPaths.push('assets/tail.bin');
  }
  const candidateTree=tree(candidateDir,candidateEntries),candidateCommit=commit(candidateDir,candidateTree,baseCommit);
  const operationId=`large-fixture-${copies}`;
  const candidateRef=`refs/heads/candidate-${operationId}`;
  git(candidateDir,['update-ref',candidateRef,candidateCommit]);
  const identity=async path=>{const stat=await fs.stat(path);return {dev:stat.dev,ino:stat.ino};};
  const candidateIdentity=await identity(candidateDir),baseIdentity=await identity(baseDir);
  const result={
    schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',
    operation_id:operationId,candidate_ref:candidateRef,base_commit:baseCommit,base_tree:baseTree,
    candidate_commit:candidateCommit,candidate_tree:candidateTree,receipt_sha256:'5'.repeat(64),
    stage_manifest_sha256:'6'.repeat(64),changed_paths:changedPaths,task_correctness:'NOT_EVALUATED',
    human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',benchmark_acceptance:'NOT_ESTABLISHED',
    origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'
  };
  return {
    result,baseDir,candidateDir,
    request:outputDir=>({schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1',result,
      candidate_git_dir:candidateDir,candidate_git_identity:candidateIdentity,
      base_git_dir:baseDir,base_git_identity:baseIdentity,output_dir:outputDir})
  };
}

function writeLooseObject(gitDir,kind,payload){
  const header=Buffer.from(`${kind} ${payload.length}\0`,'ascii');
  const source=Buffer.concat([header,payload]);
  const oid=createHash('sha1').update(source).digest('hex');
  const directory=join(gitDir,'objects',oid.slice(0,2));
  mkdirSync(directory,{recursive:true,mode:0o700});
  const objectPath=join(directory,oid.slice(2));
  if(!existsSync(objectPath))writeFileSync(objectPath,deflateSync(source),{mode:0o444,flag:'wx'});
  return oid;
}
function rawTree(gitDir,entries){
  const root={dirs:new Map(),files:[]};
  for(const entry of entries){
    const parts=entry.path.split('/');let node=root;
    for(const part of parts.slice(0,-1)){
      if(!node.dirs.has(part))node.dirs.set(part,{dirs:new Map(),files:[]});
      node=node.dirs.get(part);
    }
    node.files.push({name:parts.at(-1),mode:entry.mode??'100644',oid:entry.oid});
  }
  const build=node=>{
    const rows=[];
    for(const [name,child] of node.dirs)rows.push({name,key:`${name}/`,mode:'40000',oid:build(child)});
    for(const file of node.files)rows.push({...file,key:file.name});
    rows.sort((a,b)=>Buffer.compare(Buffer.from(a.key),Buffer.from(b.key)));
    const chunks=[];
    for(const row of rows){chunks.push(Buffer.from(`${row.mode} ${row.name}\0`,'ascii'),Buffer.from(row.oid,'hex'));}
    return writeLooseObject(gitDir,'tree',Buffer.concat(chunks));
  };
  return build(root);
}
function rawCommit(gitDir,treeOid,parent=null,message='Fixture commit'){
  const parentLine=parent?`parent ${parent}\n`:'';
  const bytes=Buffer.from(`tree ${treeOid}\n${parentLine}author Portable Snapshot Fixture <snapshot@example.invalid> 0 +0000\ncommitter Portable Snapshot Fixture <snapshot@example.invalid> 0 +0000\n\n${message}\n`);
  return writeLooseObject(gitDir,'commit',bytes);
}
async function makeObjectBoundaryFixture(root,oneOver=false){
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const baseDir=join(root,'base.git'),candidateDir=join(root,'candidate.git');initBare(baseDir);initBare(candidateDir);
  const deep=[];
  for(let index=0;index<128;index++){
    const depth=index===127?55:63;
    const parts=[`g${String(index).padStart(3,'0')}`];
    for(let level=1;level<depth;level++)parts.push(`d${String(level).padStart(3,'0')}`);
    const bytes=Buffer.from(`deep fixture ${index}\n`);
    deep.push({path:`${parts.join('/')}/f.txt`,mode:'100644',oid:writeLooseObject(baseDir,'blob',bytes)});
  }
  const oldApp=Buffer.from('export const boundary = 1;\n');
  const newApp=Buffer.from('export const boundary = 2;\n');
  const baseEntries=[...deep,{path:'src/app.mjs',mode:'100644',oid:writeLooseObject(baseDir,'blob',oldApp)}];
  const baseTree=rawTree(baseDir,baseEntries),baseCommit=rawCommit(baseDir,baseTree,null,'Base');
  const candidateEntries=[...deep,{path:'src/app.mjs',mode:'100644',oid:writeLooseObject(candidateDir,'blob',newApp)}];
  if(oneOver)candidateEntries.push({path:'src/new.txt',mode:'100644',oid:writeLooseObject(candidateDir,'blob',Buffer.from('one more object\n'))});
  const candidateTree=rawTree(candidateDir,candidateEntries),candidateCommit=rawCommit(candidateDir,candidateTree,baseCommit,'Candidate');
  await fs.writeFile(join(candidateDir,'objects','info','alternates'),`${join(baseDir,'objects')}\n`,{mode:0o600});
  await fs.chmod(join(candidateDir,'objects','info','alternates'),0o600);
  const candidateRef='refs/heads/candidate-object-boundary';
  git(candidateDir,['update-ref',candidateRef,candidateCommit]);
  const identity=async path=>{const stat=await fs.stat(path);return {dev:stat.dev,ino:stat.ino};};
  const candidateIdentity=await identity(candidateDir),baseIdentity=await identity(baseDir);
  const changedPaths=oneOver?['src/app.mjs','src/new.txt']:['src/app.mjs'];
  const result={schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',
    operation_id:'object-boundary',candidate_ref:candidateRef,base_commit:baseCommit,base_tree:baseTree,
    candidate_commit:candidateCommit,candidate_tree:candidateTree,receipt_sha256:'a'.repeat(64),
    stage_manifest_sha256:'b'.repeat(64),changed_paths:changedPaths,task_correctness:'NOT_EVALUATED',
    human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',benchmark_acceptance:'NOT_ESTABLISHED',
    origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'};
  return {baseDir,candidateDir,result,request:outputDir=>({
    schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1',result,candidate_git_dir:candidateDir,
    candidate_git_identity:candidateIdentity,base_git_dir:baseDir,base_git_identity:baseIdentity,output_dir:outputDir
  })};
}
async function makeDeduplicatedDeepFixture(root){
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const baseDir=join(root,'base.git'),candidateDir=join(root,'candidate.git');initBare(baseDir);initBare(candidateDir);
  const repeated=writeLooseObject(baseDir,'blob',Buffer.from('x'));
  const deepEntries=Array.from({length:2048},(_,index)=>({
    path:`${[`g${String(index).padStart(4,'0')}`,...Array(22).fill('d')].join('/')}/f.txt`,
    mode:'100644',oid:repeated
  }));
  const baseTree=rawTree(baseDir,deepEntries),baseCommit=rawCommit(baseDir,baseTree,null,'Deep base');
  const addition=writeLooseObject(candidateDir,'blob',Buffer.from('n'));
  const candidateTree=rawTree(candidateDir,[...deepEntries,{path:'new.txt',mode:'100644',oid:addition}]);
  const candidateCommit=rawCommit(candidateDir,candidateTree,baseCommit,'Deep candidate');
  await fs.writeFile(join(candidateDir,'objects','info','alternates'),`${join(baseDir,'objects')}\n`,{mode:0o600});
  await fs.chmod(join(candidateDir,'objects','info','alternates'),0o600);
  const candidateRef='refs/heads/candidate-deep-output-fixture';
  git(candidateDir,['update-ref',candidateRef,candidateCommit]);
  const identity=async path=>{const stat=await fs.stat(path);return {dev:stat.dev,ino:stat.ino};};
  const candidateIdentity=await identity(candidateDir),baseIdentity=await identity(baseDir);
  const result={schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',
    operation_id:'deep-output-fixture',candidate_ref:candidateRef,base_commit:baseCommit,base_tree:baseTree,
    candidate_commit:candidateCommit,candidate_tree:candidateTree,receipt_sha256:'c'.repeat(64),
    stage_manifest_sha256:'d'.repeat(64),changed_paths:['new.txt'],task_correctness:'NOT_EVALUATED',
    human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',benchmark_acceptance:'NOT_ESTABLISHED',
    origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'};
  return {baseDir,candidateDir,result,request:outputDir=>({
    schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1',result,candidate_git_dir:candidateDir,
    candidate_git_identity:candidateIdentity,base_git_dir:baseDir,base_git_identity:baseIdentity,output_dir:outputDir
  })};
}
async function makeEmptyBaseFixture(root){
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const baseDir=join(root,'base.git'),candidateDir=join(root,'candidate.git');initBare(baseDir);initBare(candidateDir);
  const baseTree=tree(baseDir,[]),baseCommit=commit(baseDir,baseTree);
  await fs.writeFile(join(candidateDir,'objects','info','alternates'),`${join(baseDir,'objects')}\n`,{mode:0o600});
  await fs.chmod(join(candidateDir,'objects','info','alternates'),0o600);
  const content=Buffer.from('# First project file\n');
  const candidateTree=tree(candidateDir,[{path:'docs/new.md',mode:'100644',oid:blob(candidateDir,content)}]);
  const candidateCommit=commit(candidateDir,candidateTree,baseCommit);
  const candidateRef='refs/heads/candidate-empty-base-fixture';
  git(candidateDir,['update-ref',candidateRef,candidateCommit]);
  const identity=async path=>{const stat=await fs.stat(path);return {dev:stat.dev,ino:stat.ino};};
  const candidateIdentity=await identity(candidateDir),baseIdentity=await identity(baseDir);
  const result={
    schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',
    operation_id:'empty-base-fixture',candidate_ref:candidateRef,
    base_commit:baseCommit,base_tree:baseTree,candidate_commit:candidateCommit,candidate_tree:candidateTree,
    receipt_sha256:'7'.repeat(64),stage_manifest_sha256:'8'.repeat(64),changed_paths:['docs/new.md'],
    task_correctness:'NOT_EVALUATED',human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',
    benchmark_acceptance:'NOT_ESTABLISHED',origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',
    base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'
  };
  return {
    result,baseDir,candidateDir,content,
    request:outputDir=>({schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1',result,
      candidate_git_dir:candidateDir,candidate_git_identity:candidateIdentity,
      base_git_dir:baseDir,base_git_identity:baseIdentity,output_dir:outputDir})
  };
}
async function waitForDirectory(path){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
    try{const stat=await fs.lstat(path);if(stat.isDirectory())return;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  throw new Error('FIXTURE_OUTPUT_ROOT_NOT_RESERVED');
}
async function waitForFile(path){
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){
    try{const stat=await fs.lstat(path);if(stat.isFile())return;}
    catch(error){if(error.code!=='ENOENT')throw error;}
    await new Promise(resolve=>setTimeout(resolve,0));
  }
  throw new Error('FIXTURE_OUTPUT_FILE_NOT_WRITTEN');
}

test('builds one exact two-tree snapshot and verifies it after both Git stores disappear',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root),snapshot=join(root,'private-review');
  const result=await buildProjectPortableCandidateSnapshot(await fixture.request(snapshot));
  assert.equal(result.status,'PORTABLE_CANDIDATE_SNAPSHOT_CREATED');
  assert.equal(result.candidate_commit,fixture.candidateCommit);
  assert.equal(result.candidate_tree,fixture.candidateTree);
  assert.equal(result.base_commit,fixture.baseCommit);
  assert.equal(result.base_tree,fixture.baseTree);
  assert.equal(result.changed_path_count,2);
  assert.equal(result.base_preimage_count,1);
  assert.ok(result.object_count<8192);
  const rootStat=await fs.stat(snapshot);
  assert.equal(rootStat.mode&0o777,0o700);
  const manifest=JSON.parse(await fs.readFile(join(snapshot,'manifest.json'),'utf8'));
  assert.deepEqual(manifest.changed_paths,['docs/new.txt','src/app.mjs']);
  assert.deepEqual(manifest.base_preimages.map(file=>file.path),['src/app.mjs']);
  assert.equal(manifest.limits.max_total_bytes,64*1024*1024);
  assert.equal(manifest.candidate_files.find(file=>file.path==='assets/icon.bin').mode,'100644');
  const objectIds=new Set(manifest.objects.map(object=>object.git_sha1));
  assert.ok(!objectIds.has(fixture.neighborBlob));
  assert.ok(!objectIds.has(fixture.neighborCommit));
  assert.ok(!objectIds.has(fixture.firstCommit));
  const privateBytes=await fs.readFile(join(snapshot,'candidate-files','docs/new.txt'));
  assert.deepEqual(privateBytes,fixture.expectedCandidateFiles.get('docs/new.txt'));
  for(const [path,bytes] of fixture.expectedCandidateFiles){
    assert.deepEqual(await fs.readFile(join(snapshot,'candidate-files',path)),bytes);
  }
  assert.deepEqual(await fs.readFile(join(snapshot,'base-preimages','src/app.mjs')),Buffer.from('export const version = 1;\n'));
  await fs.rename(fixture.baseDir,join(root,'base-unavailable'));
  await fs.rename(fixture.candidateDir,join(root,'candidate-unavailable'));
  const verified=await verifyProjectPortableCandidateSnapshot(snapshot);
  assert.equal(verified.status,'VERIFIED_FOR_PRIVATE_REVIEW');
  assert.equal(verified.manifest_sha256,result.manifest_sha256);
  assert.equal(verified.object_count,result.object_count);
}));

test('keeps CLI status private and supports fixed-status offline verification',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root),outputDir=join(root,'cli-review');
  const specPath=join(root,'private-spec.json');
  const spec={...await fixture.request(outputDir)};
  await fs.writeFile(specPath,JSON.stringify(spec),{mode:0o400});
  await fs.chmod(specPath,0o400);
  const stdout=[],stderr=[];
  const code=await runProjectPortableCandidateSnapshotCli(['--build',specPath],{
    stdout:{write:value=>stdout.push(value)},stderr:{write:value=>stderr.push(value)}
  });
  assert.equal(code,0);assert.equal(stderr.join(''),'');
  const publicText=stdout.join('');
  assert.match(publicText,/PORTABLE_CANDIDATE_SNAPSHOT_CREATED/);
  for(const privateValue of [root,outputDir,fixture.candidateDir,'docs/new.txt','src/app.mjs','Portable candidate documentation']){
    assert.equal(publicText.includes(privateValue),false);
  }
  const verifyOut=[],verifyErr=[];
  const verifyCode=await runProjectPortableCandidateSnapshotCli(['--verify',outputDir],{
    stdout:{write:value=>verifyOut.push(value)},stderr:{write:value=>verifyErr.push(value)}
  });
  assert.equal(verifyCode,0);assert.equal(verifyErr.join(''),'');
  assert.match(verifyOut.join(''),/VERIFIED_FOR_PRIVATE_REVIEW/);
}));

test('rejects wrong identity, ref/tree/parent binding, alternate, unsafe modes and oversize',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root);
  const badIdentity=await fixture.request(join(root,'bad-identity'));
  badIdentity.candidate_git_identity={dev:0,ino:0};
  await rejectedBuild(badIdentity);
  const badBaseIdentity=await fixture.request(join(root,'bad-base-identity'));
  badBaseIdentity.base_git_identity={dev:0,ino:0};
  await rejectedBuild(badBaseIdentity);
  const badResult=await fixture.request(join(root,'bad-result'));
  badResult.result={...fixture.result,changed_paths:['docs/new.txt']};
  await rejectedBuild(badResult);
  const badTree=await fixture.request(join(root,'bad-tree'));
  badTree.result={...fixture.result,candidate_tree:'0'.repeat(40)};
  await rejectedBuild(badTree);
  const wrongRef=await makeFixture(join(root,'wrong-ref-fixture'));
  git(wrongRef.candidateDir,['update-ref',wrongRef.result.candidate_ref,wrongRef.baseCommit,wrongRef.candidateCommit]);
  await rejectedBuild(await wrongRef.request(join(root,'wrong-ref')));
  const alternate=join(fixture.candidateDir,'objects','info','alternates');
  await fs.chmod(alternate,0o600);await fs.writeFile(alternate,Buffer.from(`${join(root,'wrong-store')}\n`));
  await rejectedBuild(await fixture.request(join(root,'bad-alternate')));

  const executable=await makeFixture(join(root,'executable-fixture'),{executableAddition:true});
  await rejectedBuild(await executable.request(join(root,'bad-executable')));
  const symlink=await makeFixture(join(root,'symlink-fixture'),{symlinkAddition:true});
  await rejectedBuild(await symlink.request(join(root,'bad-symlink')));
  const casefold=await makeFixture(join(root,'casefold-fixture'),{caseFoldCollision:true});
  await rejectedBuild(await casefold.request(join(root,'bad-casefold')));
  const wrongParent=await makeFixture(join(root,'wrong-parent-fixture'),{wrongParent:true});
  await rejectedBuild(await wrongParent.request(join(root,'bad-parent')));
  const oversize=await makeFixture(join(root,'oversize-fixture'),{oversize:true});
  await rejectedBuild(await oversize.request(join(root,'bad-oversize')));
  const exact=await makeFixture(join(root,'exact-blob-fixture'),{oversize:'exact'});
  const exactResult=await buildProjectPortableCandidateSnapshot(await exact.request(join(root,'exact-blob')));
  assert.equal(exactResult.status,'PORTABLE_CANDIDATE_SNAPSHOT_CREATED');
  const exactManifest=JSON.parse(await fs.readFile(join(root,'exact-blob','manifest.json'),'utf8'));
  assert.equal(exactManifest.candidate_files.find(file=>file.path==='docs/new.txt').bytes,4*1024*1024);
}));

test('offline verification rejects missing, extra, altered, linked and wrongly moded output files',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root),snapshot=join(root,'review');
  await buildProjectPortableCandidateSnapshot(await fixture.request(snapshot));
  const copy=join(root,'copy');
  const restore=async()=>{
    await fs.rm(copy,{recursive:true,force:true});
    await fs.cp(snapshot,copy,{recursive:true,preserveTimestamps:true});
    await fs.chmod(copy,0o700);
  };
  await restore();
  const extra=join(copy,'unexpected.txt');await fs.writeFile(extra,'extra',{mode:0o400});await fs.chmod(extra,0o400);
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  await restore();
  await fs.rm(join(copy,'candidate-files','docs','guide.md'));
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  await restore();
  const inventory=JSON.parse(await fs.readFile(join(copy,'manifest.json'),'utf8'));
  const removedObject=inventory.objects[0];
  await fs.rm(join(copy,'objects',removedObject.git_sha1.slice(0,2),removedObject.git_sha1.slice(2)));
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  await restore();
  const changed=join(copy,'candidate-files','src','app.mjs');await fs.chmod(changed,0o600);await fs.writeFile(changed,'tampered');await fs.chmod(changed,0o400);
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  await restore();
  const linked=join(copy,'candidate-files','src','linked.mjs');await fs.link(changed,linked).catch(()=>{});
  if(await fs.lstat(linked).then(stat=>stat.isFile()).catch(()=>false)){
    await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  }
  await restore();
  const symlink=join(copy,'candidate-files','src','unexpected.mjs');
  await fs.symlink(join(copy,'candidate-files','src','app.mjs'),symlink);
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  await restore();
  const wrongMode=join(copy,'manifest.json');await fs.chmod(wrongMode,0o600);
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  await restore();
  const corruptObject=join(copy,'objects',removedObject.git_sha1.slice(0,2),removedObject.git_sha1.slice(2));
  await fs.chmod(corruptObject,0o600);const corrupted=await fs.readFile(corruptObject);corrupted[0]^=0xff;await fs.writeFile(corruptObject,corrupted);await fs.chmod(corruptObject,0o400);
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
}));

test('offline verification rejects closed-manifest extensions, duplicate keys and oversize bytes',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root),snapshot=join(root,'manifest-source');
  await buildProjectPortableCandidateSnapshot(await fixture.request(snapshot));
  const copy=join(root,'manifest-copy');
  const restore=async()=>{
    await fs.rm(copy,{recursive:true,force:true});
    await fs.cp(snapshot,copy,{recursive:true,preserveTimestamps:true});
    await fs.chmod(copy,0o700);
  };
  const manifestPath=join(copy,'manifest.json');
  await restore();
  const unknown=JSON.parse(await fs.readFile(manifestPath,'utf8'));unknown.unrecognized_field='x';
  await fs.chmod(manifestPath,0o600);await fs.writeFile(manifestPath,canonicalJson(unknown));await fs.chmod(manifestPath,0o400);
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  await restore();
  const canonical=await fs.readFile(manifestPath,'utf8');
  const duplicate=canonical.replace('{"base_commit":','{"base_commit":"0000000000000000000000000000000000000000","base_commit":');
  assert.notEqual(duplicate,canonical);
  await fs.chmod(manifestPath,0o600);await fs.writeFile(manifestPath,duplicate);await fs.chmod(manifestPath,0o400);
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  await restore();
  await fs.chmod(manifestPath,0o600);await fs.writeFile(manifestPath,Buffer.alloc(8*1024*1024+1,0x78));await fs.chmod(manifestPath,0o400);
  await assert.rejects(verifyProjectPortableCandidateSnapshot(copy),error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
}));

test('close failure withholds success and readback faults reject without repairing partial output',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root),closeOutput=join(root,'close-failure');
  const closePort=fsPort({open:async(path,flags,...rest)=>{
    const handle=await fs.open(path,flags,...rest);
    if(path!==join(closeOutput,'manifest.json')||(flags&3)!==fsConstants.O_WRONLY)return handle;
    return {stat:(...args)=>handle.stat(...args),writeFile:(...args)=>handle.writeFile(...args),
      close:async()=>{await handle.close();throw new Error('synthetic close failure');}};
  }});
  await assert.rejects(buildProjectPortableCandidateSnapshot(await fixture.request(closeOutput),{fs:closePort}),
    error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  assert.equal((await fs.lstat(join(closeOutput,'manifest.json'))).mode&0o777,0o600);

  const readbackOutput=join(root,'readback-failure'),target=join(readbackOutput,'candidate-files','src','app.mjs');
  const readPort=fsPort({open:async(path,flags,...rest)=>{
    const handle=await fs.open(path,flags,...rest);
    if(path!==target||(flags&3)!==fsConstants.O_RDONLY)return handle;
    let changed=false;
    return {stat:(...args)=>handle.stat(...args),close:(...args)=>handle.close(...args),
      read:async(buffer,...args)=>{
        const result=await handle.read(buffer,...args);
        if(!changed&&result.bytesRead>0){buffer[args[0]]^=1;changed=true;}
        return result;
      }};
  }});
  await assert.rejects(buildProjectPortableCandidateSnapshot(await fixture.request(readbackOutput),{fs:readPort}),
    error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  assert.equal((await fs.lstat(readbackOutput)).mode&0o777,0o700);
  assert.deepEqual(await fs.readFile(target),Buffer.from('export const version = 2;\n'));
}));

test('cancellation during final root stat prevents builder and verifier success',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root),output=join(root,'final-stat-cancel');
  const controller=new AbortController();let outputStats=0;
  const port=fsPort({lstat:async path=>{
    const stat=await fs.lstat(path);
    if(path===output&&++outputStats===4)controller.abort();
    return stat;
  }});
  const request=await fixture.request(output);request.signal=controller.signal;
  await assert.rejects(buildProjectPortableCandidateSnapshot(request,{fs:port}),
    error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_ABORTED');
  assert.equal(outputStats,4);

  const complete=join(root,'verifier-final-stat');
  await buildProjectPortableCandidateSnapshot(await fixture.request(complete));
  const verifyController=new AbortController();let verifyStats=0;
  const verifyPort=fsPort({lstat:async path=>{
    const stat=await fs.lstat(path);
    if(path===complete&&++verifyStats===2)verifyController.abort();
    return stat;
  }});
  await assert.rejects(verifyProjectPortableCandidateSnapshot(complete,{signal:verifyController.signal,fs:verifyPort}),
    error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_ABORTED');
  assert.equal(verifyStats,2);
}));

test('overlapping build cancellation does not cancel an independent offline verifier',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root),snapshot=join(root,'complete');
  await buildProjectPortableCandidateSnapshot(await fixture.request(snapshot));
  const controller=new AbortController(),inFlight=await fixture.request(join(root,'cancelled'));
  inFlight.signal=controller.signal;
  const build=buildProjectPortableCandidateSnapshot(inFlight);
  setTimeout(()=>controller.abort(),1);
  const verification=verifyProjectPortableCandidateSnapshot(snapshot);
  const [buildResult,verifyResult]=await Promise.allSettled([build,verification]);
  assert.equal(buildResult.status,'rejected');
  assert.equal(buildResult.reason.code,'PROJECT_PORTABLE_SNAPSHOT_ABORTED');
  assert.equal(verifyResult.status,'fulfilled');
  assert.equal(verifyResult.value.status,'VERIFIED_FOR_PRIVATE_REVIEW');
}));

test('pre-aborted requests fail before reserving output',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root),controller=new AbortController();controller.abort();
  const output=join(root,'aborted');
  await rejectedBuild({...await fixture.request(output),signal:controller.signal},'PROJECT_PORTABLE_SNAPSHOT_ABORTED');
  await assert.rejects(fs.lstat(output),error=>error.code==='ENOENT');
}));

test('accepts an empty pinned base tree when the candidate adds its first file',async()=>withRoot(async root=>{
  const fixture=await makeEmptyBaseFixture(root),output=join(root,'empty-base-snapshot');
  const result=await buildProjectPortableCandidateSnapshot(fixture.request(output));
  assert.equal(result.status,'PORTABLE_CANDIDATE_SNAPSHOT_CREATED');
  assert.equal(result.base_preimage_count,0);
  assert.equal(result.candidate_file_count,1);
  assert.deepEqual(await fs.readFile(join(output,'candidate-files','docs','new.md')),fixture.content);
  assert.equal((await verifyProjectPortableCandidateSnapshot(output)).status,'VERIFIED_FOR_PRIVATE_REVIEW');
}));

test('rejects coercible result digests without invoking their conversion callbacks',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root);let conversions=0;
  const coercible={toString(){conversions++;return '9'.repeat(64);}};
  for(const field of ['receipt_sha256','stage_manifest_sha256']){
    const output=join(root,`coercible-${field}`);
    const request=await fixture.request(output);
    request.result={...fixture.result,[field]:coercible};
    await rejectedBuild(request,'INVALID_PROJECT_PORTABLE_SNAPSHOT_SPEC');
    await assert.rejects(fs.lstat(output),error=>error.code==='ENOENT');
  }
  assert.equal(conversions,0);
}));

test('preserves an executable mode only when the base path and blob stay unchanged',async()=>withRoot(async root=>{
  const fixture=await makeFixture(root,{executableBase:true}),output=join(root,'inherited-executable');
  await buildProjectPortableCandidateSnapshot(await fixture.request(output));
  const manifest=JSON.parse(await fs.readFile(join(output,'manifest.json'),'utf8'));
  assert.equal(manifest.candidate_files.find(file=>file.path==='assets/icon.bin').mode,'100755');
  assert.equal(manifest.candidate_files.find(file=>file.path==='docs/new.txt').mode,'100644');
}));

test('accepts the 2,048/2,098/50 file boundary and rejects one base file over',async()=>withRoot(async root=>{
  const exact=await makeBoundaryFixture(join(root,'exact'),2048,50);
  const result=await buildProjectPortableCandidateSnapshot(exact.request(join(root,'exact-output')));
  assert.equal(result.changed_path_count,50);
  assert.equal(result.candidate_file_count,2098);
  const over=await makeBoundaryFixture(join(root,'over'),2049,49);
  await rejectedBuild(over.request(join(root,'over-output')));
}));

test('preflights the 32 MiB object and 64 MiB output caps before reserving output',async()=>withRoot(async root=>{
  const objectOver=await makeLargeFixture(join(root,'object-over'),{copies:9,unique:true});
  const objectOutput=join(root,'object-over-output');
  await rejectedBuild(objectOver.request(objectOutput));
  await assert.rejects(fs.lstat(objectOutput),error=>error.code==='ENOENT');
  const outputOver=await makeLargeFixture(join(root,'output-over'),{copies:20,unique:false});
  const privateOutput=join(root,'output-over-output');
  await rejectedBuild(outputOver.request(privateOutput));
  await assert.rejects(fs.lstat(privateOutput),error=>error.code==='ENOENT');
}));

test('accepts the exact 64 MiB aggregate output boundary',async()=>withRoot(async root=>{
  const probe=await makeLargeFixture(join(root,'output-exact-probe'),{copies:16,blobBytes:1,tailBytes:1});
  const probeOutput=join(root,'output-exact-probe-snapshot');
  await buildProjectPortableCandidateSnapshot(probe.request(probeOutput));
  const template=JSON.parse(await fs.readFile(join(probeOutput,'manifest.json'),'utf8'));
  const largeOid=template.candidate_files.find(file=>file.path==='assets/data-00.bin').git_sha1;
  const tailOid=template.candidate_files.find(file=>file.path==='assets/tail.bin').git_sha1;
  const target=64*1024*1024;
  const totalFor=(largeBytes,tailBytes)=>{
    const manifest=structuredClone(template);
    for(const item of manifest.objects){if(item.git_sha1===largeOid)item.bytes=largeBytes;if(item.git_sha1===tailOid)item.bytes=tailBytes;}
    for(const item of manifest.candidate_files){
      if(item.path.startsWith('assets/data-'))item.bytes=largeBytes;
      if(item.path==='assets/tail.bin')item.bytes=tailBytes;
    }
    manifest.object_bytes+=largeBytes-1+tailBytes-1;
    manifest.candidate_file_bytes+=16*(largeBytes-1)+tailBytes-1;
    let length;
    for(let attempt=0;attempt<4;attempt++){
      length=Buffer.byteLength(canonicalJson(manifest));
      const next=manifest.object_bytes+manifest.candidate_file_bytes+manifest.base_preimage_bytes+length;
      if(manifest.total_bytes===next)break;
      manifest.total_bytes=next;
    }
    return manifest.total_bytes;
  };
  let chosen=null;
  for(let tail=1;tail<=9&&!chosen;tail++){
    let low=1,high=4*1024*1024;
    while(low<=high){
      const mid=Math.floor((low+high)/2),value=totalFor(mid,tail);
      if(value===target){chosen={large:mid,tail};break;}
      if(value<target)low=mid+1;else high=mid-1;
    }
  }
  assert.ok(chosen,'fixture search must hit the exact aggregate cap');
  const exact=await makeLargeFixture(join(root,'output-exact-real'),{copies:16,blobBytes:chosen.large,tailBytes:chosen.tail});
  const result=await buildProjectPortableCandidateSnapshot(exact.request(join(root,'output-exact-real-snapshot')));
  assert.equal(result.total_bytes,target);
  assert.equal((await verifyProjectPortableCandidateSnapshot(join(root,'output-exact-real-snapshot'))).total_bytes,target);
}));

test('accepts exactly 8,192 included objects and rejects 8,193 before creating output',async()=>withRoot(async root=>{
  const exact=await makeObjectBoundaryFixture(join(root,'objects-exact'));
  const result=await buildProjectPortableCandidateSnapshot(exact.request(join(root,'objects-exact-output')));
  assert.equal(result.object_count,8192);
  assert.equal((await verifyProjectPortableCandidateSnapshot(join(root,'objects-exact-output'))).object_count,8192);
  const over=await makeObjectBoundaryFixture(join(root,'objects-over'),true),output=join(root,'objects-over-output');
  await rejectedBuild(over.request(output));
  await assert.rejects(fs.lstat(output),error=>error.code==='ENOENT');
}));

test('builds and offline verifies 47,104 paths of deduplicated inspection directories',async()=>withRoot(async root=>{
  const fixture=await makeDeduplicatedDeepFixture(join(root,'deep-deduplicated'));
  const output=join(root,'deep-deduplicated-snapshot');
  const created=await buildProjectPortableCandidateSnapshot(fixture.request(output));
  assert.equal(created.changed_path_count,1);
  assert.equal(created.candidate_file_count,2049);
  assert.ok(created.object_count<40,`expected shared trees and blobs to deduplicate, got ${created.object_count}`);
  assert.ok(2048*23>40000,'fixture must exceed the former hidden entry cap');
  const deepest=await fs.lstat(join(output,'candidate-files','g0000',...Array(22).fill('d')));
  assert.equal(deepest.isDirectory(),true);
  const verified=await verifyProjectPortableCandidateSnapshot(output);
  assert.equal(verified.status,'VERIFIED_FOR_PRIVATE_REVIEW');
  assert.equal(verified.object_count,created.object_count);
  assert.equal(verified.total_bytes,created.total_bytes);
}));

test('retains partial output after cancellation and rejects source-ref drift during export',async()=>withRoot(async root=>{
  const cancellation=await makeBoundaryFixture(join(root,'cancel-fixture'),2048,50);
  const output=join(root,'partial-after-cancel'),controller=new AbortController();
  const request=cancellation.request(output);request.signal=controller.signal;
  const pending=buildProjectPortableCandidateSnapshot(request);
  await waitForDirectory(join(output,'objects'));controller.abort();
  await assert.rejects(pending,error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_ABORTED');
  assert.equal((await fs.stat(output)).mode&0o777,0o700);
  const retained=await fs.readdir(output);assert.ok(retained.length>0);

  const drift=await makeBoundaryFixture(join(root,'drift-fixture'),2048,50);
  const driftOutput=join(root,'partial-after-ref-drift');
  const driftPending=buildProjectPortableCandidateSnapshot(drift.request(driftOutput));
  await waitForFile(join(driftOutput,'candidate-files','base','f0000.txt'));
  git(drift.candidateDir,['update-ref',drift.result.candidate_ref,drift.baseCommit,drift.candidateCommit]);
  await assert.rejects(driftPending,error=>error.code==='PROJECT_PORTABLE_SNAPSHOT_REJECTED');
  assert.equal((await fs.stat(driftOutput)).mode&0o777,0o700);
  assert.ok((await fs.readdir(driftOutput)).length>0);
}));
