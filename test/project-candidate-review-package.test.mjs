import {buildProjectPortableCandidateSnapshot,readProjectCandidateReviewSource} from '../src/project-portable-candidate-snapshot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import childProcess,{execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {runCandidateDecisionCli} from '../bin/squire-candidate-decision.mjs';
import {MAX_REVIEW_DECISION_BYTES} from '../src/project-review-decision-limits.mjs';
import {artifactCliChild} from './helpers/artifact-cli-child.mjs';
import {
  buildProjectCandidateReviewPackage,buildProjectCandidateReviewPackageFromSnapshot,verifyProjectCandidateReviewSnapshotHandoff,verifyProjectCandidateReviewPackage,
  recordProjectCandidateDecision,verifyProjectCandidateDecision
} from '../src/project-candidate-review-package.mjs';

const GIT='/usr/bin/git';
const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C',
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',
  GIT_ALLOW_PROTOCOL:'',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',
  GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
function git(gitDir,args,input){return execFileSync(GIT,['-c','core.hooksPath=/dev/null',
  '-c','protocol.allow=never',`--git-dir=${gitDir}`,...args],{cwd:gitDir,env,input,
  encoding:'buffer',maxBuffer:8*1024*1024}).toString('ascii').trim();}
function blob(dir,bytes){return git(dir,['hash-object','-w','--stdin','--no-filters'],bytes);}
function tree(dir,rows){
  const root={dirs:new Map(),files:[]};
  for(const row of rows){const parts=row.path.split('/');let node=root;
    for(const part of parts.slice(0,-1)){if(!node.dirs.has(part))node.dirs.set(part,{dirs:new Map(),files:[]});node=node.dirs.get(part);}
    node.files.push({...row,name:parts.at(-1)});}
  const build=node=>{const list=[];
    for(const [name,child] of node.dirs)list.push({name,key:`${name}/`,mode:'040000',type:'tree',oid:build(child)});
    for(const row of node.files)list.push({name:row.name,key:row.name,mode:row.mode??'100644',type:row.type??'blob',oid:row.oid});
    list.sort((a,b)=>Buffer.compare(Buffer.from(a.key),Buffer.from(b.key)));
    return git(dir,['mktree','-z'],Buffer.concat(list.map(item=>Buffer.from(
      `${item.mode} ${item.type} ${item.oid}\t${item.name}\0`))));};
  return build(root);
}
function commit(dir,treeOid,parent){return git(dir,['commit-tree',treeOid,...(parent?['-p',parent]:[]),'-m','fixture']);}
async function fixture({oldApp,newApp,extras=true,changeCount,deepDistinct=false,
  binaryBytes,candidateMode='100644',candidateParent=true,mutateCandidateRows}={}){
  const root=await fs.mkdtemp(join(tmpdir(),'squire-review-package-'));
  await fs.chmod(root,0o700);
  const base=join(root,'base.git'),candidate=join(root,'candidate.git'),output=join(root,'package');
  execFileSync(GIT,['init','--bare','--shared=0600','--quiet','--template=/dev/null',base],{env});
  execFileSync(GIT,['init','--bare','--shared=0600','--quiet','--template=/dev/null',candidate],{env});
  const old=oldApp??Buffer.from('export const x = 1;\n'),newText=newApp??Buffer.from('export const x = 2;\n');
  const binary=binaryBytes??Buffer.from([0,255,1,42]);
  const deepPath=index=>`g${String(index).padStart(2,'0')}/a/b/c/d/e/file.txt`;
  const baseRows=deepDistinct?Array.from({length:50},(_,index)=>({
    path:deepPath(index),oid:blob(base,Buffer.from(`old ${index}\n`))
  })):[{path:'src/app.mjs',oid:blob(base,old)}];
  baseRows.push({path:'assets/unchanged.bin',oid:blob(base,Buffer.from([1,2,3]))});
  const baseTree=tree(base,baseRows),baseCommit=commit(base,baseTree);
  await fs.writeFile(join(candidate,'objects','info','alternates'),`${join(base,'objects')}\n`,{mode:0o600});
  const candidateRows=deepDistinct?Array.from({length:50},(_,index)=>({
    path:deepPath(index),oid:blob(candidate,Buffer.from(`new ${index}\n`))
  })):[{path:'src/app.mjs',mode:candidateMode,oid:blob(candidate,newText)}];
  candidateRows.push({path:'assets/unchanged.bin',oid:baseRows.at(-1).oid});
  if(changeCount!==undefined){
    for(let index=0;index<changeCount-1;index++)candidateRows.push({
      path:`docs/change-${String(index).padStart(2,'0')}.md`,
      oid:blob(candidate,Buffer.from(`change ${index}\n`))
    });
  }else if(extras&&!deepDistinct)candidateRows.push(
    {path:'docs/new.md',oid:blob(candidate,Buffer.from('# New\n'))},
    {path:'assets/icon.bin',oid:blob(candidate,binary)});
  mutateCandidateRows?.(candidateRows,{base,candidate,baseCommit,blob});
  const candidateTree=tree(candidate,candidateRows);
  const candidateCommit=commit(candidate,candidateTree,candidateParent?baseCommit:null);
  git(candidate,['update-ref','refs/heads/candidate-fixture',candidateCommit]);
  const identity=async path=>{const s=await fs.stat(path);return {dev:s.dev,ino:s.ino};};
  const result={schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',
    operation_id:'fixture',candidate_ref:'refs/heads/candidate-fixture',base_commit:baseCommit,base_tree:baseTree,
    candidate_commit:candidateCommit,candidate_tree:candidateTree,receipt_sha256:'a'.repeat(64),
    stage_manifest_sha256:'b'.repeat(64),changed_paths:deepDistinct?
      Array.from({length:50},(_,index)=>deepPath(index)):
      changeCount!==undefined?
      [...candidateRows.map(row=>row.path).filter(path=>path!=='assets/unchanged.bin')].sort():
      extras?['assets/icon.bin','docs/new.md','src/app.mjs']:['src/app.mjs'],
    task_correctness:'NOT_EVALUATED',human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',
    benchmark_acceptance:'NOT_ESTABLISHED',origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',
    base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'};
  const spec={schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1',result,
    candidate_git_dir:candidate,candidate_git_identity:await identity(candidate),
    base_git_dir:base,base_git_identity:await identity(base),output_dir:output};
  return {root,base,candidate,output,spec,result,binary,candidateRows};
}
async function withFixture(run){const f=await fixture();try{await run(f);}finally{await fs.rm(f.root,{recursive:true,force:true});}}
const failCode=(code,call)=>assert.rejects(call,error=>error?.code===code);
async function rejectedBeforeOutput(f,code='PROJECT_CANDIDATE_REVIEW_REJECTED'){
  await failCode(code,()=>buildProjectCandidateReviewPackage(f.spec));
  await assert.rejects(fs.lstat(f.output),{code:'ENOENT'});
}

test('complete private package, offline verification, and explicit independent decisions',()=>withFixture(async f=>{
  const built=await buildProjectCandidateReviewPackage(f.spec);
  assert.equal(built.changed_path_count,3);
  assert.equal(JSON.stringify(built).includes('src/app.mjs'),false);
  assert.deepEqual(await fs.readFile(join(f.output,'changes','assets','icon.bin.new')),f.binary);
  const diff=await fs.readFile(join(f.output,'diff.txt'),'utf8');
  assert.equal(diff.includes('BINARY_REVIEW_REQUIRED'),true);
  assert.match(diff,/- "export const x = 1;\\n"/u);
  assert.match(diff,/\+ "export const x = 2;\\n"/u);
  assert.match(diff,/\+ "# New\\n"/u);
  const manifest=JSON.parse(await fs.readFile(join(f.output,'review-manifest.json')));
  assert.deepEqual(manifest.changed_paths,['assets/icon.bin','docs/new.md','src/app.mjs']);
  assert.equal(manifest.paths.some(p=>p.path==='assets/unchanged.bin'),false);
  const attestations=manifest.paths.map(p=>({path:p.path,old_sha256:p.old?.sha256??null,
    new_sha256:p.new.sha256,binary_inspected:p.binary_review_required}));
  const decision={schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'one',reviewer_label:'owner',
    review_package_sha256:built.manifest_sha256,base_commit:f.result.base_commit,base_tree:f.result.base_tree,
    candidate_commit:f.result.candidate_commit,candidate_tree:f.result.candidate_tree,
    choice:'ACCEPT',attestations};
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>recordProjectCandidateDecision(f.output,
    {...decision,attestations:attestations.slice(1)},join(f.root,'incomplete')));
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>recordProjectCandidateDecision(f.output,
    {...decision,attestations:attestations.map(a=>({...a,binary_inspected:false}))},join(f.root,'binary-unreviewed')));
  const first=await recordProjectCandidateDecision(f.output,decision,join(f.root,'accept'));
  assert.equal(first.choice,'ACCEPT');
  assert.equal(JSON.stringify(first).includes('src/app.mjs'),false);
  const second=await recordProjectCandidateDecision(f.output,{...decision,decision_id:'two',choice:'REJECT',attestations:[]},join(f.root,'reject'));
  assert.equal(second.choice,'REJECT');
  assert.notEqual(first.decision_sha256,second.decision_sha256);
  await fs.rename(f.base,join(f.root,'base-gone'));
  await fs.rename(f.candidate,join(f.root,'candidate-gone'));
  const verified=await verifyProjectCandidateReviewPackage(f.output);
  assert.equal(verified.manifest_sha256,built.manifest_sha256);
  assert.equal(JSON.stringify(verified).includes('src/app.mjs'),false);
  await fs.chmod(join(f.output,'diff.txt'),0o600);
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateReviewPackage(f.output));
}));

test('wrong source binding and existing destination fail closed',()=>withFixture(async f=>{
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage({
    ...f.spec,candidate_git_identity:{...f.spec.candidate_git_identity,ino:f.spec.candidate_git_identity.ino+1}}));
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage({
    ...f.spec,result:{...f.result,changed_paths:['docs/new.md']}}));
  await buildProjectCandidateReviewPackage(f.spec);
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage(f.spec));
}));

test('offline integrity rejects changed content, changed display and extra paths',()=>withFixture(async f=>{
  await buildProjectCandidateReviewPackage(f.spec);
  const changed=join(f.output,'changes','src','app.mjs.new');
  const original=await fs.readFile(changed);
  await fs.chmod(changed,0o600);await fs.writeFile(changed,Buffer.alloc(original.length,0x61));await fs.chmod(changed,0o400);
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateReviewPackage(f.output));
  await fs.chmod(changed,0o600);await fs.writeFile(changed,original);await fs.chmod(changed,0o400);
  const display=join(f.output,'diff.txt'),text=await fs.readFile(display);
  await fs.chmod(display,0o600);await fs.writeFile(display,Buffer.concat([text,Buffer.from('x')]));await fs.chmod(display,0o400);
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateReviewPackage(f.output));
  await fs.chmod(display,0o600);await fs.writeFile(display,text);await fs.chmod(display,0o400);
  await fs.writeFile(join(f.output,'extra'),Buffer.from('x'),{mode:0o400});
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateReviewPackage(f.output));
}));

test('wrong decision package digest, cancellation and close failure retain partial output',()=>withFixture(async f=>{
  const controller=new AbortController();controller.abort();
  await failCode('PROJECT_CANDIDATE_REVIEW_ABORTED',()=>buildProjectCandidateReviewPackage({...f.spec,signal:controller.signal}));
  await assert.rejects(fs.lstat(f.output),{code:'ENOENT'});
  const methods=['lstat','realpath','mkdir','open','chmod','opendir'];
  const port=Object.fromEntries(methods.map(name=>[name,(...args)=>fs[name](...args)]));
  let failed=false;
  port.open=async(...args)=>{
    const handle=await fs.open(...args);
    if(!failed&&args[0].endsWith('app.mjs.new')&&(args[1]&0o1)){
      failed=true;
      return {stat:(...a)=>handle.stat(...a),writeFile:(...a)=>handle.writeFile(...a),
        close:async()=>{await handle.close();throw new Error('synthetic close uncertainty');}};
    }
    return handle;
  };
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage(f.spec,{fs:port}));
  assert.equal((await fs.lstat(f.output)).isDirectory(),true);
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage(f.spec));
  const f2=await fixture();try{
    const built=await buildProjectCandidateReviewPackage(f2.spec);
    const decision={schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'wrong',reviewer_label:'owner',
      review_package_sha256:'f'.repeat(64),base_commit:f2.result.base_commit,base_tree:f2.result.base_tree,
      candidate_commit:f2.result.candidate_commit,candidate_tree:f2.result.candidate_tree,
      choice:'REJECT',attestations:[]};
    assert.notEqual(built.manifest_sha256,decision.review_package_sha256);
    await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>recordProjectCandidateDecision(f2.output,decision,join(f2.root,'wrong-decision')));
    await assert.rejects(fs.lstat(join(f2.root,'wrong-decision')),{code:'ENOENT'});
  }finally{await fs.rm(f2.root,{recursive:true,force:true});}
}));

test('exact 4 MiB sides and 8 MiB copied bytes succeed; one byte over rejects',async()=>{
  const exact=await fixture({oldApp:Buffer.alloc(4*1024*1024,0),newApp:Buffer.alloc(4*1024*1024,1),extras:false});
  try{const built=await buildProjectCandidateReviewPackage(exact.spec);
    assert.equal(built.changed_path_count,1);
    assert.equal((await verifyProjectCandidateReviewPackage(exact.output)).manifest_sha256,built.manifest_sha256);
  }finally{await fs.rm(exact.root,{recursive:true,force:true});}
  const over=await fixture({oldApp:Buffer.alloc(4*1024*1024+1,0),newApp:Buffer.from('x'),extras:false});
  try{
    await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage(over.spec));
    await assert.rejects(fs.lstat(over.output),{code:'ENOENT'});
  }finally{await fs.rm(over.root,{recursive:true,force:true});}
});

test('50 changed files succeed; the 51st is not accepted',async()=>{
  const exact=await fixture({changeCount:50});
  try{assert.equal((await buildProjectCandidateReviewPackage(exact.spec)).changed_path_count,50);}
  finally{await fs.rm(exact.root,{recursive:true,force:true});}
  const over=await fixture({changeCount:51});
  try{
    await failCode('INVALID_PROJECT_CANDIDATE_REVIEW_SPEC',()=>buildProjectCandidateReviewPackage(over.spec));
    await assert.rejects(fs.lstat(over.output),{code:'ENOENT'});
  }finally{await fs.rm(over.root,{recursive:true,force:true});}
});

test('50 distinct seven-component replacements fit the closed package inventory',async()=>{
  const f=await fixture({deepDistinct:true});
  try{
    let built;
    built=await buildProjectCandidateReviewPackage(f.spec);
    assert.equal(built.changed_path_count,50);
    const verified=await verifyProjectCandidateReviewPackage(f.output);
    assert.equal(verified.manifest_sha256,built.manifest_sha256);
    const entries=await fs.readdir(join(f.output,'changes'));
    assert.equal(entries.length,50);
    for(const index of [0,49]){
      const path=`g${String(index).padStart(2,'0')}/a/b/c/d/e/file.txt`;
      assert.deepEqual(await fs.readFile(join(f.output,'changes',`${path}.old`)),Buffer.from(`old ${index}\n`));
      assert.deepEqual(await fs.readFile(join(f.output,'changes',`${path}.new`)),Buffer.from(`new ${index}\n`));
    }
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('valid UTF-8 control bytes remain binary and require explicit ACCEPT acknowledgement',async()=>{
  const control=await fixture({binaryBytes:Buffer.from([1,2,3])});
  try{
    const built=await buildProjectCandidateReviewPackage(control.spec);
    const manifest=JSON.parse(await fs.readFile(join(control.output,'review-manifest.json')));
    const asset=manifest.paths.find(item=>item.path==='assets/icon.bin');
    assert.equal(asset.binary_review_required,true);
    assert.deepEqual(await fs.readFile(join(control.output,'changes','assets','icon.bin.new')),Buffer.from([1,2,3]));
    assert.match(await fs.readFile(join(control.output,'diff.txt'),'utf8'),/BINARY_REVIEW_REQUIRED/u);
    const attestations=manifest.paths.map(item=>({path:item.path,old_sha256:item.old?.sha256??null,
      new_sha256:item.new.sha256,binary_inspected:false}));
    const decision={schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'control',reviewer_label:'owner',
      review_package_sha256:built.manifest_sha256,base_commit:control.result.base_commit,
      base_tree:control.result.base_tree,candidate_commit:control.result.candidate_commit,
      candidate_tree:control.result.candidate_tree,choice:'ACCEPT',attestations};
    await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>recordProjectCandidateDecision(
      control.output,decision,join(control.root,'unacknowledged')));
    const acknowledged={...decision,attestations:attestations.map(item=>({
      ...item,binary_inspected:item.path==='assets/icon.bin'}))};
    assert.equal((await recordProjectCandidateDecision(control.output,acknowledged,
      join(control.root,'acknowledged'))).choice,'ACCEPT');
  }finally{await fs.rm(control.root,{recursive:true,force:true});}
});

test('source ref drift and readback uncertainty withhold acknowledgement and retain output',()=>withFixture(async f=>{
  const names=['lstat','realpath','mkdir','open','chmod','opendir'];
  const port=Object.fromEntries(names.map(name=>[name,(...args)=>fs[name](...args)]));
  let moved=false;
  port.chmod=async(path,mode)=>{
    await fs.chmod(path,mode);
    if(!moved&&path.endsWith('review-manifest.json')){
      moved=true;
      git(f.candidate,['update-ref','-d',f.result.candidate_ref]);
    }
  };
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage(f.spec,{fs:port}));
  assert.equal((await fs.lstat(join(f.output,'review-manifest.json'))).isFile(),true);
  const next=await fixture();try{
    const readFault=Object.fromEntries(names.map(name=>[name,(...args)=>fs[name](...args)]));
    readFault.open=async(path,flags,...rest)=>{
      if(path.endsWith('review-manifest.json')&&(flags&0o3)===0)throw new Error('unknown readback');
      return fs.open(path,flags,...rest);
    };
    await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage(next.spec,{fs:readFault}));
    assert.equal((await fs.lstat(join(next.output,'review-manifest.json'))).isFile(),true);
  }finally{await fs.rm(next.root,{recursive:true,force:true});}
}));

test('selected base identity, ref, parent and both tree bindings reject independently',async t=>{
  for(const [name,alter] of [
    ['base inode',f=>{f.spec.base_git_identity={...f.spec.base_git_identity,ino:f.spec.base_git_identity.ino+1};}],
    ['selected ref',f=>{git(f.candidate,['update-ref','-d',f.result.candidate_ref]);}],
    ['base tree',f=>{f.result.base_tree='f'.repeat(40);}],
    ['candidate tree',f=>{f.result.candidate_tree='f'.repeat(40);}]
  ])await t.test(name,async()=>{const f=await fixture({extras:false});try{alter(f);await rejectedBeforeOutput(f);}finally{await fs.rm(f.root,{recursive:true,force:true});}});
  await t.test('single base parent',async()=>{const f=await fixture({extras:false,candidateParent:false});
    try{await rejectedBeforeOutput(f);}finally{await fs.rm(f.root,{recursive:true,force:true});}});
});

test('unlisted path, executable, symlink, gitlink, rename, deletion and casefold collision reject',async t=>{
  const cases=[
    ['unlisted addition',f=>{f.result.changed_paths=['src/app.mjs'];},
      {extras:false,mutateCandidateRows:(rows,{candidate,blob})=>rows.push({path:'docs/extra.md',oid:blob(candidate,Buffer.from('x'))})}],
    ['changed executable',()=>{}, {extras:false,candidateMode:'100755'}],
    ['symlink',f=>{f.result.changed_paths=['docs/link','src/app.mjs'];},
      {extras:false,mutateCandidateRows:(rows,{candidate,blob})=>rows.push({path:'docs/link',mode:'120000',oid:blob(candidate,Buffer.from('target'))})}],
    ['gitlink',f=>{f.result.changed_paths=['deps/module','src/app.mjs'];},
      {extras:false,mutateCandidateRows:(rows,{baseCommit})=>rows.push({path:'deps/module',mode:'160000',type:'commit',oid:baseCommit})}],
    ['rename',f=>{f.result.changed_paths=['src/renamed.mjs'];},
      {extras:false,mutateCandidateRows:rows=>{rows.find(row=>row.path==='src/app.mjs').path='src/renamed.mjs';}}],
    ['deletion',()=>{},
      {extras:false,mutateCandidateRows:rows=>rows.splice(rows.findIndex(row=>row.path==='src/app.mjs'),1)}],
    ['casefold collision',f=>{f.result.changed_paths=['SRC/app.mjs','src/app.mjs'];},
      {extras:false,mutateCandidateRows:(rows,{candidate,blob})=>rows.push({path:'SRC/app.mjs',oid:blob(candidate,Buffer.from('collision'))})}]
  ];
  for(const [name,alter,options] of cases)await t.test(name,async()=>{
    const f=await fixture(options);try{alter(f);await rejectedBeforeOutput(f);}
    finally{await fs.rm(f.root,{recursive:true,force:true});}
  });
});

test('exact 8 MiB complete text diff succeeds; one byte over fails before output',async()=>{
  const calibration=await fixture({oldApp:Buffer.from('a'),newApp:Buffer.from('b'),extras:false});
  let overhead;
  try{await buildProjectCandidateReviewPackage(calibration.spec);
    overhead=(await fs.stat(join(calibration.output,'diff.txt'))).size-2;
  }finally{await fs.rm(calibration.root,{recursive:true,force:true});}
  const oldLength=4*1024*1024,newLength=8*1024*1024-overhead-oldLength;
  assert.ok(newLength>0&&newLength<=4*1024*1024);
  const exact=await fixture({oldApp:Buffer.alloc(oldLength,0x61),newApp:Buffer.alloc(newLength,0x62),extras:false});
  try{
    const built=await buildProjectCandidateReviewPackage(exact.spec);
    assert.equal((await fs.stat(join(exact.output,'diff.txt'))).size,8*1024*1024);
    assert.ok(built.package_bytes<17*1024*1024);
    assert.equal((await verifyProjectCandidateReviewPackage(exact.output)).manifest_sha256,built.manifest_sha256);
  }finally{await fs.rm(exact.root,{recursive:true,force:true});}
  const over=await fixture({oldApp:Buffer.alloc(oldLength,0x61),newApp:Buffer.alloc(newLength+1,0x62),extras:false});
  try{await rejectedBeforeOutput(over);}finally{await fs.rm(over.root,{recursive:true,force:true});}
});

test('declared prefix path collision rejects before output',()=>withFixture(async f=>{
  f.result.changed_paths=['src/app.mjs','src/app.mjs/nested'];
  await rejectedBeforeOutput(f);
}));

test('source blob disagreement on final re-read retains partial package',()=>withFixture(async f=>{
  const names=['lstat','realpath','mkdir','open','chmod','opendir'];
  const port=Object.fromEntries(names.map(name=>[name,(...args)=>fs[name](...args)]));
  const oid=f.candidateRows.find(row=>row.path==='src/app.mjs').oid;
  const loose=join(f.candidate,'objects',oid.slice(0,2),oid.slice(2));
  let corrupted=false;
  port.chmod=async(path,mode)=>{
    await fs.chmod(path,mode);
    if(!corrupted&&path.endsWith('review-manifest.json')){
      corrupted=true;
      const falseBytes=Buffer.from('a different source blob\n');
      const frame=Buffer.concat([Buffer.from(`blob ${falseBytes.length}\0`),falseBytes]);
      await fs.chmod(loose,0o600);
      await fs.writeFile(loose,deflateSync(frame));
      await fs.chmod(loose,0o400);
    }
  };
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage(f.spec,{fs:port}));
  assert.equal(corrupted,true);
  assert.equal((await fs.lstat(join(f.output,'review-manifest.json'))).isFile(),true);
}));

test('interrupted ACCEPT decision write leaves earlier REJECT unchanged',()=>withFixture(async f=>{
  const built=await buildProjectCandidateReviewPackage(f.spec);
  const manifest=JSON.parse(await fs.readFile(join(f.output,'review-manifest.json')));
  const baseDecision={schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'first',
    reviewer_label:'owner',review_package_sha256:built.manifest_sha256,
    base_commit:f.result.base_commit,base_tree:f.result.base_tree,
    candidate_commit:f.result.candidate_commit,candidate_tree:f.result.candidate_tree,
    choice:'REJECT',attestations:[]};
  const firstDir=join(f.root,'first-decision');
  await recordProjectCandidateDecision(f.output,baseDecision,firstDir);
  const firstBytes=await fs.readFile(join(firstDir,'decision.json'));
  const attestations=manifest.paths.map(item=>({path:item.path,old_sha256:item.old?.sha256??null,
    new_sha256:item.new.sha256,binary_inspected:item.binary_review_required}));
  const secondDir=join(f.root,'interrupted-accept');
  const names=['lstat','realpath','mkdir','open','chmod','opendir'];
  const port=Object.fromEntries(names.map(name=>[name,(...args)=>fs[name](...args)]));
  port.open=async(...args)=>{
    const handle=await fs.open(...args);
    if(args[0]===join(secondDir,'decision.json'))return {
      stat:(...a)=>handle.stat(...a),writeFile:(...a)=>handle.writeFile(...a),
      close:async()=>{await handle.close();throw new Error('synthetic interrupted close');}
    };
    return handle;
  };
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>recordProjectCandidateDecision(
    f.output,{...baseDecision,decision_id:'second',choice:'ACCEPT',attestations},secondDir,{fs:port}));
  assert.deepEqual(await fs.readFile(join(firstDir,'decision.json')),firstBytes);
  assert.equal((await fs.lstat(secondDir)).isDirectory(),true);
  assert.equal((await fs.lstat(join(secondDir,'decision.json'))).isFile(),true);
}));

const decisionCliUrl=new URL('../bin/squire-candidate-decision.mjs',import.meta.url);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
async function decisionRequest(f,built,choice='ACCEPT'){
 const manifest=JSON.parse(await fs.readFile(join(f.output,'review-manifest.json')));
 return {schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:`synthetic-${choice.toLowerCase()}`,reviewer_label:'synthetic-fixture',
  review_package_sha256:built.manifest_sha256,base_commit:f.result.base_commit,base_tree:f.result.base_tree,
  candidate_commit:f.result.candidate_commit,candidate_tree:f.result.candidate_tree,choice,
  attestations:choice==='ACCEPT'?manifest.paths.map(p=>({path:p.path,old_sha256:p.old?.sha256??null,new_sha256:p.new.sha256,
   binary_inspected:p.binary_review_required})):[],note:'SYNTHETIC_PRIVATE_NOTE'};
}
async function recordCli(f,request,suffix,{text,ports={}}={}){
 const input=join(f.root,`request-${suffix}.json`),dest=join(f.root,`decision-${suffix}`);let out='',err='';
 await fs.writeFile(input,text??JSON.stringify(request),{mode:0o600});
 const code=await runCandidateDecisionCli(['record',f.output,input,dest],{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s},...ports});
 return {code,out,err,input,dest};
}
test('decision CLI records all explicit synthetic choices without changing package or earlier decisions',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),packageBefore=await fs.readFile(join(f.output,'review-manifest.json'));
 const earlier=[];
 for(const choice of ['ACCEPT','REVISE','REJECT']){
  const d=await decisionRequest(f,built,choice),input=join(f.root,`request-${choice}.json`),dest=join(f.root,`decision-${choice}`);
  const inputBytes=Buffer.from(JSON.stringify(d));await fs.writeFile(input,inputBytes,{mode:0o600});
  let result;
  if(choice==='ACCEPT')result=await artifactCliChild(decisionCliUrl,['record',f.output,input,dest]);
  else{let stdout='',stderr='';const code=await runCandidateDecisionCli(['record',f.output,input,dest],{stdout:{write:s=>stdout+=s},stderr:{write:s=>stderr+=s}});result={code,stdout,stderr,signal:null};}
  assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(result.stderr,'');
  const bytes=await fs.readFile(join(dest,'decision.json'));assert.equal(JSON.parse(bytes).choice,choice);
  assert.match(result.stdout,new RegExp(`Decision SHA256: ${sha256(bytes)}`));
  assert.doesNotMatch(result.stdout,/SYNTHETIC_PRIVATE_NOTE|synthetic-fixture|src\/app|assets\/icon/);
  assert.equal(result.stdout.includes(f.root),false);assert.deepEqual(await fs.readFile(input),inputBytes);
  assert.equal((await fs.lstat(dest)).mode&0o777,0o700);assert.equal((await fs.lstat(join(dest,'decision.json'))).mode&0o777,0o400);
  for(const [p,b] of earlier)assert.deepEqual(await fs.readFile(p),b);earlier.push([join(dest,'decision.json'),bytes]);
 }
 assert.deepEqual(await fs.readFile(join(f.output,'review-manifest.json')),packageBefore);
}));
test('decision CLI rejects wrong bindings, incomplete/binary attestations and closed-request violations before output',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),d=await decisionRequest(f,built);
 const malformed=[{...d,review_package_sha256:'0'.repeat(64)},{...d,base_commit:'0'.repeat(40)},
  {...d,candidate_tree:'0'.repeat(40)},{...d,attestations:d.attestations.slice(1)},
  {...d,attestations:d.attestations.map(a=>({...a,binary_inspected:false}))},
  {...d,attestations:d.attestations.map((a,i)=>i===0?{...a,new_sha256:'0'.repeat(64)}:a)},
  {...d,attestations:d.attestations.map((a,i)=>i===2?{...a,old_sha256:'0'.repeat(64)}:a)},
  {...d,private_unknown:'not-dropped'},{...d,boundaries:[]},{...d,note:null},
  {...d,schema:'SQUIRE_PROJECT_REVISION_DECISION_V1'},{...d,choice:'AUTO'},
  {...d,note:'x'.repeat(4097)},{...d,attestations:Array(51).fill(d.attestations[0])}];
 for(let i=0;i<malformed.length;i++){
  const r=await recordCli(f,malformed[i],`invalid-${i}`);assert.equal(r.code,2);assert.equal(r.out,'');
  assert.equal(r.err,'PROJECT_CANDIDATE_DECISION_REJECTED\n');await assert.rejects(fs.lstat(r.dest),{code:'ENOENT'});
 }
 const revisionPackage=join(f.root,'revision-package');await fs.mkdir(revisionPackage,{mode:0o700});
 await fs.writeFile(join(revisionPackage,'revision-review-manifest.json'),'{"schema":"SQUIRE_PROJECT_REVISION_REVIEW_PACKAGE_V1"}',{mode:0o400});
 const input=join(f.root,'request-revision.json');await fs.writeFile(input,JSON.stringify(d),{mode:0o600});
 let err='';const dest=join(f.root,'not-an-original-decision');
 assert.equal(await runCandidateDecisionCli(['record',revisionPackage,input,dest],{stdout:{write(){throw Error('UNEXPECTED_SUCCESS');}},stderr:{write:s=>err+=s}}),2);
 assert.equal(err,'PROJECT_CANDIDATE_DECISION_REJECTED\n');await assert.rejects(fs.lstat(dest),{code:'ENOENT'});
}));
test('decision CLI preserves an existing destination and never treats a stored record as a new request',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),d=await decisionRequest(f,built,'REJECT');
 const first=await recordCli(f,d,'first');assert.equal(first.code,0);const stored=await fs.readFile(join(first.dest,'decision.json'));
 let err='';assert.equal(await runCandidateDecisionCli(['record',f.output,first.input,first.dest],{stdout:{write(){throw Error('UNEXPECTED_SUCCESS');}},stderr:{write:s=>err+=s}}),2);
 assert.equal(err,'PROJECT_CANDIDATE_DECISION_REJECTED\n');assert.deepEqual(await fs.readFile(join(first.dest,'decision.json')),stored);
 const replay=await recordCli(f,{},'stored-as-request',{text:stored});assert.equal(replay.code,2);await assert.rejects(fs.lstat(replay.dest),{code:'ENOENT'});
}));
test('decision CLI retains prior records and partial output after API I/O failure',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),first=await recordCli(f,await decisionRequest(f,built,'REJECT'),'prior');
 assert.equal(first.code,0);const before=await fs.readFile(join(first.dest,'decision.json')),d=await decisionRequest(f,built),target=join(f.root,'decision-close-failure');
 let calls=0;const port=Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(name=>[name,(...a)=>fs[name](...a)]));
 port.open=async(...a)=>{const h=await fs.open(...a);if(a[0]!==join(target,'decision.json'))return h;
  return {stat:(...v)=>h.stat(...v),writeFile:(...v)=>h.writeFile(...v),close:async()=>{await h.close();throw Error('PRIVATE_CLOSE_FAILURE');}};};
 // Only the existing closed six-key filesystem port is supplied to the API.
 const apiPort=Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(k=>[k,port[k]]));
 const r=await recordCli(f,d,'close-failure',{ports:{record:async(...a)=>{calls++;return recordProjectCandidateDecision(...a,{fs:apiPort});}}});
 assert.equal(r.code,2);assert.equal(r.err,'PROJECT_CANDIDATE_DECISION_REJECTED\n');assert.equal(calls,1);
 assert.equal((await fs.lstat(join(target,'decision.json'))).isFile(),true);assert.deepEqual(await fs.readFile(join(first.dest,'decision.json')),before);
}));
test('decision CLI failed synchronous or closed-pipe acknowledgement leaves the synthetic record',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),d=await decisionRequest(f,built,'REVISE');
 let writes=0,diagnostics=0,partial='';
 const r=await recordCli(f,d,'sync-output',{ports:{stdout:{write:s=>{writes++;partial+=s.slice(0,10);throw Error('PRIVATE_OUTPUT');}},stderr:{write(){diagnostics++;}}}});
 assert.equal(r.code,2);assert.equal(writes,1);assert.equal(diagnostics,0);assert.ok(partial.length>0);
 assert.equal((await fs.lstat(join(r.dest,'decision.json'))).isFile(),true);
 const input=join(f.root,'closed-request.json'),dest=join(f.root,'closed-output');await fs.writeFile(input,JSON.stringify(d),{mode:0o600});
 const closed=await artifactCliChild(decisionCliUrl,['record',f.output,input,dest],{closed:'stdout'});
 assert.equal(closed.code,2);assert.equal(closed.signal,null);assert.equal(closed.stdout,'');assert.equal(closed.stderr,'');
 assert.equal((await fs.lstat(join(dest,'decision.json'))).isFile(),true);
}));
test('decision CLI accepts maximum paths, fifty attestations, escaped note and exact input cap',async()=>{
 const f=await fixture({changeCount:50,mutateCandidateRows:rows=>{let i=0;for(const row of rows)if(row.path.startsWith('docs/')){
  row.path='a'.repeat(63)+'/'+'b'.repeat(63)+'/'+'c'.repeat(63)+'/'+'f'+String(i++).padStart(2,'0')+'d'.repeat(57)+'.txt';assert.equal(row.path.length,256);
 }}});
 try{
  const built=await buildProjectCandidateReviewPackage(f.spec),d=await decisionRequest(f,built);d.note='\u0001'.repeat(4096);
  const text=JSON.stringify(d),padded=text+' '.repeat(MAX_REVIEW_DECISION_BYTES-Buffer.byteLength(text));
  const r=await recordCli(f,d,'maximum',{text:padded});assert.equal(r.code,0);assert.equal(r.err,'');
  const stored=await fs.readFile(join(r.dest,'decision.json'));assert.ok(stored.length<=MAX_REVIEW_DECISION_BYTES);
  assert.equal(JSON.parse(stored).attestations.length,50);assert.equal(JSON.parse(stored).note,d.note);
  const over=await recordCli(f,d,'over-input-cap',{text:padded+' '});assert.equal(over.code,2);await assert.rejects(fs.lstat(over.dest),{code:'ENOENT'});
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

const reviewCliUrl=new URL('../bin/squire-candidate-review.mjs',import.meta.url);
const {runCandidateReviewCli}=await import('../bin/squire-candidate-review.mjs');
async function packageCli(f,spec,suffix,{text,ports={}}={}){
 const input=join(f.root,'cli-spec-'+suffix+'.json');await fs.writeFile(input,text??JSON.stringify(spec),{mode:0o600});let out='',err='';
 const code=await runCandidateReviewCli(['--build',input],{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s},...ports});return {code,out,err,input};
}
async function packageSnapshot(dir){const rows=[];async function walk(root,relative=''){for(const name of (await fs.readdir(root)).sort()){const path=join(root,name),rel=relative?relative+'/'+name:name,st=await fs.lstat(path);if(st.isDirectory())await walk(path,rel);else rows.push({path:rel,mode:st.mode,sha256:createHash('sha256').update(await fs.readFile(path)).digest('hex')});}}await walk(dir);return rows;}
test('review package CLI builds original private package and verifies offline without source stores',()=>withFixture(async f=>{
 const prior=await buildProjectCandidateReviewPackage(f.spec),decisionDir=join(f.root,'prior-decision');await recordProjectCandidateDecision(f.output,await decisionRequest(f,prior,'REJECT'),decisionDir);
 const oldPackage=await packageSnapshot(f.output),oldDecision=await packageSnapshot(decisionDir);
 const spec={...f.spec,output_dir:join(f.root,'cli-package')},input=join(f.root,'executable-spec.json');await fs.writeFile(input,JSON.stringify(spec),{mode:0o600});const before=await fs.readFile(input),refBefore=await fs.readFile(join(f.candidate,'refs','heads','candidate-fixture'));
 const built=await artifactCliChild(reviewCliUrl,['--build',input]);assert.equal(built.code,0);assert.equal(built.signal,null);assert.equal(built.stderr,'');assert.match(built.stdout,/^PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED/);assert.doesNotMatch(built.stdout,/src\/app|fixture|squire-review-package|prior-decision/);
 const verified=await verifyProjectCandidateReviewPackage(spec.output_dir);assert.match(built.stdout,new RegExp(verified.manifest_sha256));assert.deepEqual(await fs.readFile(input),before);assert.deepEqual(await fs.readFile(join(f.candidate,'refs','heads','candidate-fixture')),refBefore);assert.deepEqual(await packageSnapshot(f.output),oldPackage);assert.deepEqual(await packageSnapshot(decisionDir),oldDecision);
 const packageBefore=await packageSnapshot(spec.output_dir);await fs.rename(f.base,join(f.root,'base-unavailable'));await fs.rename(f.candidate,join(f.root,'candidate-unavailable'));
 const out=await artifactCliChild(reviewCliUrl,['--verify',spec.output_dir]);assert.equal(out.code,0);assert.equal(out.signal,null);assert.equal(out.stderr,'');assert.match(out.stdout,/^PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED/);assert.match(out.stdout,new RegExp(verified.manifest_sha256));assert.deepEqual(await packageSnapshot(spec.output_dir),packageBefore);assert.deepEqual(await packageSnapshot(decisionDir),oldDecision);
 assert.deepEqual((await fs.readdir(spec.output_dir)).sort(),['changes','diff.txt','review-manifest.json']);
}));
test('review package CLI rejects wrong source/object/profile bindings before fresh destination',()=>withFixture(async f=>{
 const bad=[{...f.spec,candidate_git_identity:{dev:0,ino:0}},{...f.spec,base_git_identity:{dev:0,ino:0}},
  {...f.spec,result:{...f.result,candidate_tree:'0'.repeat(40)}},{...f.spec,result:{...f.result,base_commit:'0'.repeat(40)}},
  {...f.spec,result:{...f.result,schema:'SQUIRE_PROJECT_REVISION_CANDIDATE_V1'}},{...f.spec,result:{...f.result,changed_paths:['src/not-the-candidate.mjs']}},
  {...f.spec,unknown:'PRIVATE'},{...f.spec,candidate_git_dir:'relative'},{...f.spec,signal:null}];
 for(let i=0;i<bad.length;i++){const spec={...bad[i],output_dir:join(f.root,'bad-package-'+i)},r=await packageCli(f,spec,'bad-'+i);assert.equal(r.code,2);assert.equal(r.out,'');assert.equal(r.err,'PROJECT_CANDIDATE_REVIEW_REJECTED\n');await assert.rejects(fs.lstat(spec.output_dir),{code:'ENOENT'});}
 const first=await packageCli(f,f.spec,'first');assert.equal(first.code,0);const original=await packageSnapshot(f.output);const repeated=await packageCli(f,f.spec,'existing-dest');assert.equal(repeated.code,2);assert.equal(repeated.err,'PROJECT_CANDIDATE_REVIEW_REJECTED\n');assert.deepEqual(await packageSnapshot(f.output),original);
 // Verification is read-only and fails closed on a fresh synthetic corruption.
 const copy=join(f.output,'changes','src','app.mjs.new');await fs.chmod(copy,0o600);await fs.writeFile(copy,'corrupt');await fs.chmod(copy,0o400);let err='';assert.equal(await runCandidateReviewCli(['--verify',f.output],{stdout:{write(){throw Error('UNEXPECTED_SUCCESS');}},stderr:{write:s=>err+=s}}),2);assert.equal(err,'PROJECT_CANDIDATE_REVIEW_REJECTED\n');
}));
test('review package CLI accepts fifty paths and exact 64 KiB spec, rejects one byte over',async()=>{
 const f=await fixture({changeCount:50});try{
  assert.equal(f.result.changed_paths.length,50);const raw=JSON.stringify(f.spec),padded=raw+' '.repeat(65536-Buffer.byteLength(raw));const r=await packageCli(f,f.spec,'maximum',{text:padded});assert.equal(r.code,0);assert.equal(r.err,'');assert.equal((await verifyProjectCandidateReviewPackage(f.output)).changed_path_count,50);
  const next={...f.spec,output_dir:join(f.root,'over-limit')},text=JSON.stringify(next);const over=await packageCli(f,next,'overflow',{text:text+' '.repeat(65537-Buffer.byteLength(text))});assert.equal(over.code,2);await assert.rejects(fs.lstat(next.output_dir),{code:'ENOENT'});
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('review package CLI retains partial output after API I/O failure without retry',()=>withFixture(async f=>{
 const target=f.output;const names=['lstat','realpath','mkdir','open','chmod','opendir'];const port=Object.fromEntries(names.map(k=>[k,(...a)=>fs[k](...a)]));
 port.open=async(...a)=>{const h=await fs.open(...a);if(a[0]!==join(target,'review-manifest.json'))return h;return {stat:(...v)=>h.stat(...v),writeFile:(...v)=>h.writeFile(...v),close:async()=>{await h.close();throw Error('PRIVATE_CLOSE');}};};
 let calls=0;const r=await packageCli(f,f.spec,'io-failure',{ports:{build:async s=>{calls++;return buildProjectCandidateReviewPackage(s,{fs:port});}}});assert.equal(r.code,2);assert.equal(calls,1);assert.equal(r.out,'');assert.equal(r.err,'PROJECT_CANDIDATE_REVIEW_REJECTED\n');assert.equal((await fs.lstat(join(target,'review-manifest.json'))).isFile(),true);
}));
test('review package CLI failed sync/closed-pipe acknowledgements leave complete fresh outputs',()=>withFixture(async f=>{
 let calls=0,writes=0,diagnostics=0;const r=await packageCli(f,f.spec,'sync-ack',{ports:{build:async s=>{calls++;return buildProjectCandidateReviewPackage(s);},stdout:{write(){writes++;throw Error('PRIVATE_WRITE');}},stderr:{write(){diagnostics++;}}}});
 assert.equal(r.code,2);assert.equal(calls,1);assert.equal(writes,1);assert.equal(diagnostics,0);assert.equal((await verifyProjectCandidateReviewPackage(f.output)).status,'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED');
 const before=await packageSnapshot(f.output),spec={...f.spec,output_dir:join(f.root,'closed-ack')},input=join(f.root,'closed-spec.json');await fs.writeFile(input,JSON.stringify(spec),{mode:0o600});const bytes=await fs.readFile(input);
 const out=await artifactCliChild(reviewCliUrl,['--build',input],{closed:'stdout'});assert.equal(out.code,2);assert.equal(out.signal,null);assert.equal(out.stdout,'');assert.equal(out.stderr,'');assert.equal((await verifyProjectCandidateReviewPackage(spec.output_dir)).status,'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED');assert.deepEqual(await fs.readFile(input),bytes);assert.deepEqual(await packageSnapshot(f.output),before);
}));

const decisionHash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Canonical wire encoder is fixture-only, to keep semantic mutants canonical rather than fail for whitespace.
function decisionWire(value){const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;return Buffer.from(JSON.stringify(sort(value)));}
async function verifyOriginalCli(packageDir,decisionDir,expected,ports={}){let out='',err='';const code=await runCandidateDecisionCli(['verify-decision',packageDir,decisionDir,expected],{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s},...ports});return {code,out,err};}
test('original decision verifier shares writer bindings, preserves omitted-note semantics and selects no winner',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),before=await packageSnapshot(f.output),rows=[];
 for(const [choice,note] of [['ACCEPT',undefined],['REVISE',''],['REJECT','SYNTHETIC_PRIVATE_NOTE']]){
  const d=await decisionRequest(f,built,choice);if(note===undefined)delete d.note;else d.note=note;const dir=join(f.root,'original-verified-'+choice),written=await recordProjectCandidateDecision(f.output,d,dir),stored=JSON.parse(await fs.readFile(join(dir,'decision.json')));
  assert.equal(stored.note,note??null);assert.deepEqual(stored.boundaries,['REVIEWER_LABEL_NOT_AUTHENTICATED','SOURCE_DECISION_ONLY','NO_EXECUTION_OR_MERGE_AUTHORITY']);
  const verified=await verifyProjectCandidateDecision(f.output,dir,written.decision_sha256);assert.equal(verified.status,'PROJECT_CANDIDATE_DECISION_VERIFIED');assert.equal(verified.review_package_sha256,built.manifest_sha256);assert.equal(verified.decision_sha256,written.decision_sha256);assert.equal(verified.attested_path_count,d.attestations.length);assert.ok(Object.isFrozen(verified));assert.deepEqual(Object.keys(verified).sort(),['attested_path_count','decision_sha256','review_package_sha256','status']);rows.push({dir,written,snapshot:await packageSnapshot(dir)});
 }
 const base=await decisionRequest(f,built,'REJECT');delete base.note;const omittedDir=join(f.root,'omitted-note'),undefinedDir=join(f.root,'undefined-note');await recordProjectCandidateDecision(f.output,base,omittedDir);await recordProjectCandidateDecision(f.output,{...base,note:undefined},undefinedDir);assert.deepEqual(await fs.readFile(join(omittedDir,'decision.json')),await fs.readFile(join(undefinedDir,'decision.json')));
 const invalid=join(f.root,'explicit-null-request');await failCode('INVALID_PROJECT_CANDIDATE_REVIEW_SPEC',()=>recordProjectCandidateDecision(f.output,{...base,note:null},invalid));await assert.rejects(fs.lstat(invalid),{code:'ENOENT'});
 await fs.rename(f.base,join(f.root,'base-unavailable-for-decisions'));await fs.rename(f.candidate,join(f.root,'candidate-unavailable-for-decisions'));
 for(const row of rows){const out=await verifyOriginalCli(f.output,row.dir,row.written.decision_sha256);assert.equal(out.code,0);assert.equal(out.err,'');assert.doesNotMatch(out.out,/ACCEPT|REJECT|REVISE|SYNTHETIC_PRIVATE_NOTE|synthetic-fixture|squire-review-package/);assert.deepEqual(await packageSnapshot(row.dir),row.snapshot);}
 const native=await artifactCliChild(decisionCliUrl,['verify-decision',f.output,rows[2].dir,rows[2].written.decision_sha256]);assert.equal(native.code,0);assert.equal(native.signal,null);assert.equal(native.stderr,'');assert.match(native.stdout,/Attested path count: 0/);assert.deepEqual(await packageSnapshot(f.output),before);
}));
test('original decision verifier rejects canonical binding/attestation/boundary tampering and malformed bytes',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),d=await decisionRequest(f,built),good=join(f.root,'good-verifier-record'),recorded=await recordProjectCandidateDecision(f.output,d,good),raw=JSON.parse(await fs.readFile(join(good,'decision.json'))),before=await packageSnapshot(good),pkg=await packageSnapshot(f.output);
 await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateDecision(f.output,good,'0'.repeat(64)));
 const mutations=[v=>({...v,review_package_sha256:'0'.repeat(64)}),v=>({...v,base_tree:'0'.repeat(40)}),v=>({...v,candidate_commit:'0'.repeat(40)}),v=>({...v,attestations:v.attestations.slice(1)}),v=>({...v,attestations:v.attestations.map(a=>({...a,binary_inspected:false}))}),v=>({...v,attestations:v.attestations.map((a,i)=>i===0?{...a,new_sha256:'0'.repeat(64)}:a)}),v=>({...v,attestations:v.attestations.map((a,i)=>i===2?{...a,old_sha256:'0'.repeat(64)}:a)}),v=>({...v,attestations:Array(51).fill(v.attestations[0])}),v=>({...v,note:'x'.repeat(4097)}),v=>({...v,unknown:'not-stripped'}),v=>({...v,schema:'SQUIRE_PROJECT_REVISION_DECISION_V1'}),v=>({...v,boundaries:[...v.boundaries,'NO_IMPLICIT_WINNER']}),v=>({...v,boundaries:[...v.boundaries].reverse()}),v=>{delete v.note;return v;},v=>{delete v.boundaries;return v;}];
 const bad=mutations.map(fn=>decisionWire(fn(structuredClone(raw))));bad.push(Buffer.from('{'),Buffer.from([255]),Buffer.concat([decisionWire(raw),Buffer.from('\n')]),Buffer.from(decisionWire(raw).toString().replace('"choice":"ACCEPT"','"choice":"ACCEPT","choice":"ACCEPT"')),Buffer.alloc(MAX_REVIEW_DECISION_BYTES+1,0x78));
 for(let i=0;i<bad.length;i++){
  const dir=join(f.root,'tampered-verifier-'+i);await fs.mkdir(dir,{mode:0o700});await fs.writeFile(join(dir,'decision.json'),bad[i],{mode:0o400});const snapshot=await packageSnapshot(dir);
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateDecision(f.output,dir,decisionHash(bad[i])));const out=await verifyOriginalCli(f.output,dir,decisionHash(bad[i]));assert.equal(out.code,2);assert.equal(out.out,'');assert.equal(out.err,'PROJECT_CANDIDATE_DECISION_REJECTED\n');assert.deepEqual(await packageSnapshot(dir),snapshot);
 }
 assert.deepEqual(await packageSnapshot(good),before);assert.deepEqual(await packageSnapshot(f.output),pkg);const f2=await fixture({extras:false});try{await buildProjectCandidateReviewPackage(f2.spec);await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateDecision(f2.output,good,recorded.decision_sha256));}finally{await fs.rm(f2.root,{recursive:true,force:true});}
}));
test('original decision verifier enforces private closure, regular single-link leaves and ownership',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),d=await decisionRequest(f,built,'REJECT');
 for(const kind of ['directory-mode','file-mode','extra-file','extra-directory','symlink','hardlink','directory-leaf']){
  const dir=join(f.root,'custody-'+kind),recorded=await recordProjectCandidateDecision(f.output,d,dir),leaf=join(dir,'decision.json');
  if(kind==='directory-mode')await fs.chmod(dir,0o755);if(kind==='file-mode')await fs.chmod(leaf,0o600);if(kind==='extra-file')await fs.writeFile(join(dir,'extra'),'',{mode:0o400});if(kind==='extra-directory')await fs.mkdir(join(dir,'extra'),{mode:0o700});
  if(kind==='symlink'){const target=join(f.root,'symlink-target');await fs.copyFile(leaf,target);await fs.unlink(leaf);await fs.symlink(target,leaf);}
  if(kind==='hardlink'){const target=join(f.root,'hardlink-target');await fs.copyFile(leaf,target);await fs.unlink(leaf);await fs.link(target,leaf);}
  if(kind==='directory-leaf'){await fs.unlink(leaf);await fs.mkdir(leaf,{mode:0o700});}
  await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateDecision(f.output,dir,recorded.decision_sha256));
 }
 const dir=join(f.root,'wrong-owner-observation'),recorded=await recordProjectCandidateDecision(f.output,d,dir),leaf=join(dir,'decision.json');const port=Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(k=>[k,(...a)=>fs[k](...a)]));port.lstat=async path=>{const s=await fs.lstat(path);return path===leaf?{...s,uid:process.getuid()+1,isFile:()=>true,isSymbolicLink:()=>false}:s;};await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateDecision(f.output,dir,recorded.decision_sha256,{fs:port}));
 for(const args of [['relative',dir,recorded.decision_sha256],[f.output,dir,'not-a-digest'],[f.output,f.output,recorded.decision_sha256]])await failCode('INVALID_PROJECT_CANDIDATE_REVIEW_SPEC',()=>verifyProjectCandidateDecision(...args));
}));
test('original decision verifier is read-only and detects a fresh fixture changing after read-close',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),dir=join(f.root,'readonly-verifier'),recorded=await recordProjectCandidateDecision(f.output,await decisionRequest(f,built,'REVISE'),dir),before=await packageSnapshot(dir),pkg=await packageSnapshot(f.output);const {constants}=await import('node:fs');let writes=0,opens=0;
 const port={lstat:(...a)=>fs.lstat(...a),realpath:(...a)=>fs.realpath(...a),opendir:(...a)=>fs.opendir(...a),mkdir(){writes++;throw Error('UNEXPECTED_WRITE');},chmod(){writes++;throw Error('UNEXPECTED_WRITE');},open:(path,flags,...a)=>{opens++;assert.equal(flags&(constants.O_WRONLY|constants.O_RDWR|constants.O_CREAT|constants.O_TRUNC|constants.O_APPEND),0);return fs.open(path,flags,...a);}};
 assert.equal((await verifyProjectCandidateDecision(f.output,dir,recorded.decision_sha256,{fs:port})).status,'PROJECT_CANDIDATE_DECISION_VERIFIED');assert.equal(writes,0);assert.ok(opens>0);assert.deepEqual(await packageSnapshot(dir),before);assert.deepEqual(await packageSnapshot(f.output),pkg);
 let changed=false;const drifting={...port,open:async(path,...a)=>{const h=await fs.open(path,...a);if(path!==join(dir,'decision.json'))return h;return {stat:(...v)=>h.stat(...v),read:(...v)=>h.read(...v),close:async()=>{await h.close();if(!changed){changed=true;await fs.chmod(path,0o600);await fs.appendFile(path,' ');await fs.chmod(path,0o400);}}};}};
 await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>verifyProjectCandidateDecision(f.output,dir,recorded.decision_sha256,{fs:drifting}));assert.equal(changed,true);assert.equal(writes,0);
}));
test('original decision verifier and CLI accept maximum fifty-path escaped-note records unchanged',async()=>{
 const f=await fixture({changeCount:50,mutateCandidateRows:rows=>{let i=0;for(const row of rows)if(row.path.startsWith('docs/'))row.path='a'.repeat(63)+'/'+'b'.repeat(63)+'/'+'c'.repeat(63)+'/'+'f'+String(i++).padStart(2,'0')+'d'.repeat(57)+'.txt';}});try{
  const built=await buildProjectCandidateReviewPackage(f.spec),d=await decisionRequest(f,built);d.note='\u0001'.repeat(4096);assert.equal(d.attestations.length,50);const dir=join(f.root,'maximum-original-decision'),recorded=await recordProjectCandidateDecision(f.output,d,dir),before=await packageSnapshot(dir);assert.ok((await fs.stat(join(dir,'decision.json'))).size<=MAX_REVIEW_DECISION_BYTES);
  const verified=await verifyProjectCandidateDecision(f.output,dir,recorded.decision_sha256);assert.equal(verified.attested_path_count,50);const out=await verifyOriginalCli(f.output,dir,recorded.decision_sha256);assert.equal(out.code,0);assert.equal(out.err,'');assert.match(out.out,/Attested path count: 50/);assert.deepEqual(await packageSnapshot(dir),before);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('original decision verifier CLI output failures preserve records without reader or writer calls',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),dir=join(f.root,'output-original-decision'),recorded=await recordProjectCandidateDecision(f.output,await decisionRequest(f,built,'REJECT'),dir),before=await packageSnapshot(dir),pkg=await packageSnapshot(f.output);let calls=0,writes=0,diagnostics=0,otherCalls=0;
 const out=await verifyOriginalCli(f.output,dir,recorded.decision_sha256,{verifyDecision:async(...a)=>{calls++;return verifyProjectCandidateDecision(...a);},stdout:{write(){writes++;throw Error('PRIVATE_STDOUT');}},stderr:{write(){diagnostics++;}},readBytes(){otherCalls++;throw Error('UNUSED_READ');},record(){otherCalls++;throw Error('UNUSED_WRITE');},recordRevision(){otherCalls++;throw Error('UNUSED_WRITE');}});assert.equal(out.code,2);assert.equal(calls,1);assert.equal(writes,1);assert.equal(diagnostics,0);assert.equal(otherCalls,0);
 const closed=await artifactCliChild(decisionCliUrl,['verify-decision',f.output,dir,recorded.decision_sha256],{closed:'stdout'});assert.equal(closed.code,2);assert.equal(closed.signal,null);assert.equal(closed.stdout,'');assert.equal(closed.stderr,'');const rejected=await artifactCliChild(decisionCliUrl,['verify-decision',f.output,dir,'0'.repeat(64)],{closed:'stderr'});assert.equal(rejected.code,2);assert.equal(rejected.signal,null);assert.equal(rejected.stdout,'');assert.equal(rejected.stderr,'');assert.deepEqual(await packageSnapshot(dir),before);assert.deepEqual(await packageSnapshot(f.output),pkg);
}));

test('expected manifest original package verification binds the caller digest offline and preserves bytes on failure',()=>withFixture(async f=>{
 const built=await buildProjectCandidateReviewPackage(f.spec),snapshot=await packageSnapshot(f.output),legacy=await artifactCliChild(reviewCliUrl,['--verify',f.output]);assert.equal(legacy.code,0);
 for(const [i,dir] of [f.spec.base_git_dir,f.spec.candidate_git_dir].entries())await fs.rename(dir,join(f.root,'unavailable-expected-'+i));
 const argv=['--verify',f.output,'--expect-sha256',built.manifest_sha256],ok=await artifactCliChild(reviewCliUrl,argv);assert.equal(ok.code,0);assert.equal(ok.signal,null);assert.equal(ok.stdout,legacy.stdout);assert.equal(ok.stderr,'');
 const other=await fixture({newApp:Buffer.from('different synthetic candidate\n')});try{const otherBuilt=await buildProjectCandidateReviewPackage(other.spec);assert.notEqual(otherBuilt.manifest_sha256,built.manifest_sha256);const before=await packageSnapshot(other.output),selected=await artifactCliChild(reviewCliUrl,['--verify',other.output,'--expect-sha256',built.manifest_sha256]);assert.equal(selected.code,2);assert.equal(selected.stdout,'');assert.equal(selected.stderr,'PROJECT_CANDIDATE_REVIEW_REJECTED\n');assert.deepEqual(await packageSnapshot(other.output),before);}finally{await fs.rm(other.root,{recursive:true,force:true});}
 const bad=await artifactCliChild(reviewCliUrl,[...argv.slice(0,3),'0'.repeat(64)]);assert.equal(bad.code,2);assert.equal(bad.stdout,'');assert.equal(bad.stderr,'PROJECT_CANDIDATE_REVIEW_REJECTED\n');
 for(const [args,channel] of [[argv,'stdout'],[[...argv.slice(0,3),'0'.repeat(64)],'stderr']]){const out=await artifactCliChild(reviewCliUrl,args,{closed:channel});assert.equal(out.code,2);assert.equal(out.signal,null);assert.equal(out.stdout,'');assert.equal(out.stderr,'');}
 const late=await artifactCliChild(reviewCliUrl,argv,{before:"const w=process.stdout.write.bind(process.stdout);process.stdout.write=(...a)=>{const v=w(...a);setImmediate(()=>process.stdout.emit('error',Error('PRIVATE_LATE_FAILURE')));return v;};"});assert.equal(late.code,2);assert.equal(late.stdout,legacy.stdout);assert.equal(late.stderr,'');assert.deepEqual(await packageSnapshot(f.output),snapshot);
 const diff=join(f.output,'diff.txt');await fs.chmod(diff,0o600);await fs.appendFile(diff,'synthetic corruption');await fs.chmod(diff,0o400);const corruptSnapshot=await packageSnapshot(f.output),corrupt=await artifactCliChild(reviewCliUrl,argv);assert.equal(corrupt.code,2);assert.equal(corrupt.stdout,'');assert.equal(corrupt.stderr,'PROJECT_CANDIDATE_REVIEW_REJECTED\n');assert.deepEqual(await packageSnapshot(f.output),corruptSnapshot);
}));


async function snapshotReviewFixture(f){
 const snapshotDir=join(f.root,'source-snapshot');
 const snapshot=await buildProjectPortableCandidateSnapshot({...f.spec,schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1',output_dir:snapshotDir});
 return {snapshotDir,snapshot,spec:{schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_FROM_SNAPSHOT_SPEC_V1',snapshot_dir:snapshotDir,
   expected_manifest_sha256:snapshot.manifest_sha256,output_dir:join(f.root,'snapshot-review-handoff')}};
}
test('snapshot source builder creates byte-identical V1 package and bound private receipt without Git stores',()=>withFixture(async f=>{
 const live=await buildProjectCandidateReviewPackage(f.spec),liveBefore=await packageSnapshot(f.output),prepared=await snapshotReviewFixture(f),sourceBefore=await packageSnapshot(prepared.snapshotDir);
 await fs.rename(f.spec.base_git_dir,join(f.root,'base-unavailable'));await fs.rename(f.spec.candidate_git_dir,join(f.root,'candidate-unavailable'));
 const built=await buildProjectCandidateReviewPackageFromSnapshot(prepared.spec),pkg=join(prepared.spec.output_dir,'package');
 assert.equal(built.status,'PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED_FROM_SNAPSHOT');assert.ok(Object.isFrozen(built));assert.equal(built.source_snapshot_manifest_sha256,prepared.snapshot.manifest_sha256);assert.equal(built.manifest_sha256,live.manifest_sha256);
 assert.deepEqual(await packageSnapshot(pkg),liveBefore);assert.deepEqual(await packageSnapshot(prepared.snapshotDir),sourceBefore);
 const receiptBytes=await fs.readFile(join(prepared.spec.output_dir,'provenance.json')),receipt=JSON.parse(receiptBytes);
 assert.equal(createHash('sha256').update(receiptBytes).digest('hex'),built.provenance_sha256);assert.equal(receipt.schema,'SQUIRE_SNAPSHOT_REVIEW_PROVENANCE_V1');assert.equal(receipt.review_package_manifest_sha256,built.manifest_sha256);assert.equal(receipt.source_snapshot_manifest_sha256,prepared.snapshot.manifest_sha256);assert.equal(receipt.input_result_sha256,built.input_result_sha256);assert.deepEqual(Object.keys(receipt).sort(),['schema','source_snapshot_manifest_sha256','review_package_manifest_sha256','input_result_sha256','base_commit','base_tree','candidate_commit','candidate_tree','changed_path_count','package_bytes','boundaries'].sort());assert.deepEqual(receipt.boundaries,['RETAINED_SNAPSHOT_SOURCE_ONLY','LIVE_GIT_CUSTODY_NOT_ESTABLISHED','ORIGINAL_RESULT_BODY_NOT_VALIDATED','ORIGINAL_ACKNOWLEDGEMENT_NOT_RECOVERED','ORIGIN_NOT_AUTHENTICATED','NO_DECISION_EXECUTION_MERGE_DISCLOSURE_OR_RETRY_AUTHORITY']);assert.ok(receiptBytes.equals(decisionWire(receipt)));for(const key of ['base_commit','base_tree','candidate_commit','candidate_tree','changed_path_count','package_bytes'])assert.equal(receipt[key],built[key]);assert.deepEqual(await fs.readdir(prepared.spec.output_dir),['package','provenance.json']);assert.equal((await fs.stat(prepared.spec.output_dir)).mode&0o777,0o700);assert.equal((await fs.stat(join(prepared.spec.output_dir,'provenance.json'))).mode&0o777,0o400);assert.ok(receiptBytes.length<=16*1024);assert.doesNotMatch(receiptBytes.toString(),/snapshot-review-handoff|source-snapshot|reviewer_label|receipt_sha256|stage_manifest_sha256/);
 for(const choice of ['ACCEPT','REVISE','REJECT']){const request=await decisionRequest(f,built,choice),dir=join(f.root,'snapshot-'+choice),d=await recordProjectCandidateDecision(pkg,request,dir);assert.equal((await verifyProjectCandidateDecision(pkg,dir,d.decision_sha256)).status,'PROJECT_CANDIDATE_DECISION_VERIFIED');}
 assert.equal((await verifyProjectCandidateReviewPackage(pkg)).manifest_sha256,live.manifest_sha256);
}));

function snapshotReviewFs(overrides={}){return Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(key=>[key,overrides[key]??((...args)=>fs[key](...args))]));}

// Exercise the same source readers with deterministic Git responses, without
// spawning Git or adding a source/verification override to either builder.
async function withMappedSideFixture(t,{folder,old},run){
 const root=await fs.mkdtemp(join(tmpdir(),'squire-review-mapped-'));
 try{
  const objects=new Map(),listings=new Map();
  const object=(kind,payload)=>{
   const oid=createHash('sha1').update(`${kind} ${payload.length}\0`).update(payload).digest('hex');
   objects.set(oid,{kind,payload});return oid;
  };
  const oneTree=(entries,relative='')=>{
   const rows=[],listing=[];
   for(const [name,value] of Object.entries(entries)){
    const path=relative+name,isFile=typeof value==='string';
    const child=isFile?object('blob',Buffer.from(value)):oneTree(value,path+'/');
    const oid=isFile?child:child.oid,mode=isFile?'100644':'40000';
    rows.push({key:isFile?name:name+'/',bytes:Buffer.concat([Buffer.from(`${mode} ${name}\0`),Buffer.from(oid,'hex')])});
    listing.push(Buffer.from(`${mode.padStart(6,'0')} ${isFile?'blob':'tree'} ${oid}\t${path}\0`));
    if(!isFile)listing.push(child.listing);
   }
   rows.sort((a,b)=>Buffer.compare(Buffer.from(a.key),Buffer.from(b.key)));
   const oid=object('tree',Buffer.concat(rows.map(row=>row.bytes)));
   return {oid,listing:Buffer.concat(listing)};
  };
  const base=oneTree(old?{notes:'previous\n'}:{}),next=oneTree({notes:'current\n',[folder]:{'page.txt':'page\n'}});
  for(const view of [base,next])listings.set(view.oid,view.listing);
  const baseCommit=object('commit',Buffer.from(`tree ${base.oid}\n\nbase\n`));
  const candidateCommit=object('commit',Buffer.from(`tree ${next.oid}\nparent ${baseCommit}\n\ncandidate\n`));
  const ref='refs/heads/candidate-fixture',baseDir=join(root,'base.git'),candidateDir=join(root,'candidate.git');
  for(const dir of [baseDir,candidateDir])await fs.mkdir(join(dir,'objects','info'),{recursive:true,mode:0o700});
  await fs.writeFile(join(candidateDir,'objects','info','alternates'),join(baseDir,'objects')+'\n',{mode:0o600});
  const identity=async dir=>{const {dev,ino}=await fs.lstat(dir);return {dev,ino};};
  const result={schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',operation_id:'fixture',
   candidate_ref:ref,base_commit:baseCommit,base_tree:base.oid,candidate_commit:candidateCommit,candidate_tree:next.oid,
   receipt_sha256:'a'.repeat(64),stage_manifest_sha256:'b'.repeat(64),changed_paths:['notes',folder+'/page.txt'],
   task_correctness:'NOT_EVALUATED',human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',benchmark_acceptance:'NOT_ESTABLISHED',
   origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'};
  const spec={schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1',result,base_git_dir:baseDir,
   base_git_identity:await identity(baseDir),candidate_git_dir:candidateDir,candidate_git_identity:await identity(candidateDir),
   output_dir:join(root,'direct')};
  t.mock.method(childProcess,'spawn',(executable,args,options)=>{
   assert.equal(executable,GIT);assert.ok([baseDir,candidateDir].includes(options.cwd));
   const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
   child.kill=()=>true;
   const input=[];child.stdin.on('data',bytes=>input.push(Buffer.from(bytes)));
   child.stdin.once('finish',()=>{
    const commandIndex=args.findIndex((arg,i)=>i%2===0&&arg!=='-c');
    const [command,option,oid]=args.slice(commandIndex);
    let output=Buffer.alloc(0),exit=0;
    if(command==='rev-parse')output=Buffer.from(({'--is-bare-repository':'true','--show-object-format':'sha1','--verify':candidateCommit})[option]+'\n');
    else if(command==='symbolic-ref')exit=1;
    else if(command==='ls-tree')output=listings.get(args.at(-1));
    else if(command==='cat-file'&&['--batch','--batch-check'].includes(option)){
     output=Buffer.concat(Buffer.concat(input).toString('ascii').trimEnd().split('\n').flatMap(key=>{
      const {kind,payload}=objects.get(key),header=Buffer.from(`${key} ${kind} ${payload.length}\n`);
      return option==='--batch'?[header,payload,Buffer.from('\n')]:[header];
     }));
    }else if(command==='cat-file'&&objects.get(oid)?.kind===option)output=objects.get(oid).payload;
    else if(command!=='for-each-ref')exit=1;
    let pending=2;const end=()=>{if(--pending===0)child.emit('close',exit,null);};
    child.stdout.once('end',end);child.stderr.once('end',end);
    child.stdout.end(output);child.stderr.end();
   });
   return child;
  });
  syncBuiltinESMExports();
  await run({root,spec},await snapshotReviewFixture({root,spec}));
 }finally{t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});}
}

test('mapped side conflicts reject both original package builders before reservation',async t=>{
 for(const row of [{folder:'notes.new',old:false},{folder:'notes.old',old:true}]){
  await withMappedSideFixture(t,row,async(f,snapshot)=>{
   const mkdirs=[],ports={fs:snapshotReviewFs({mkdir:async path=>{mkdirs.push(path);throw Error('UNEXPECTED_RESERVATION');}})};
   const source=await readProjectCandidateReviewSource(f.spec,ports);
   assert.deepEqual(source.files.map(({path,old})=>[path,Boolean(old)]),
    [['notes',row.old],[row.folder+'/page.txt',false]]);
   await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackage(f.spec,ports));
   await failCode('PROJECT_CANDIDATE_REVIEW_REJECTED',()=>buildProjectCandidateReviewPackageFromSnapshot(snapshot.spec,ports));
   assert.deepEqual(mkdirs,[]);
   for(const dir of [f.spec.output_dir,snapshot.spec.output_dir])await assert.rejects(fs.lstat(dir),{code:'ENOENT'});
  });
 }
});
test('an absent old side leaves the nearby original package layout unchanged',async t=>{
 await withMappedSideFixture(t,{folder:'notes.old',old:false},async(f,snapshot)=>{
  const direct=await buildProjectCandidateReviewPackage(f.spec,{fs:snapshotReviewFs()});
  const retained=await buildProjectCandidateReviewPackageFromSnapshot(snapshot.spec,{fs:snapshotReviewFs()});
  const packageDir=join(snapshot.spec.output_dir,'package');
  assert.equal(retained.manifest_sha256,direct.manifest_sha256);
  assert.deepEqual(await packageSnapshot(packageDir),await packageSnapshot(f.spec.output_dir));
  for(const root of [packageDir,f.spec.output_dir]){
   assert.equal(await fs.readFile(join(root,'changes','notes.new'),'utf8'),'current\n');
   assert.equal(await fs.readFile(join(root,'changes','notes.old','page.txt.new'),'utf8'),'page\n');
   assert.equal((await fs.lstat(join(root,'changes','notes.old'))).isDirectory(),true);
  }
 });
});
test('snapshot source invalid closed requests reject without filesystem access',async()=>{
 let calls=0;const fsPort=snapshotReviewFs(Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(k=>[k,async()=>{calls++;throw Error('PRIVATE_UNWANTED');}]))),valid={schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_FROM_SNAPSHOT_SPEC_V1',snapshot_dir:'/synthetic/snapshot',expected_manifest_sha256:'a'.repeat(64),output_dir:'/synthetic/handoff'};
 for(const spec of [{...valid,schema:'SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1'},{...valid,result:{}},{...valid,snapshot_dir:'relative'},{...valid,output_dir:'/synthetic/snapshot/nested'},{...valid,output_dir:'/synthetic/snapshot'},{...valid,expected_manifest_sha256:'A'.repeat(64)},{...valid,expected_manifest_sha256:'a'.repeat(64)+'\n'},{...valid,expected_manifest_sha256:null},{...valid,signal:{}},Object.defineProperty({...valid},'snapshot_dir',{get(){throw Error('PRIVATE_GETTER');}})])await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot(spec,{fs:fsPort}),e=>e.code==='INVALID_PROJECT_CANDIDATE_REVIEW_SPEC');
 assert.equal(calls,0);
});
test('snapshot source wrong selection, corruption and existing destination reject without source changes',()=>withFixture(async f=>{
 const a=await snapshotReviewFixture(f),before=await packageSnapshot(a.snapshotDir),otherDir=join(f.root,'other-snapshot'),other=await buildProjectPortableCandidateSnapshot({...f.spec,schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_SNAPSHOT_REQUEST_V1',result:{...f.result,receipt_sha256:'c'.repeat(64)},output_dir:otherDir});assert.notEqual(other.manifest_sha256,a.snapshot.manifest_sha256);
 for(const spec of [{...a.spec,expected_manifest_sha256:'0'.repeat(64)},{...a.spec,snapshot_dir:otherDir}]){await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot(spec),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');await assert.rejects(fs.lstat(spec.output_dir),{code:'ENOENT'});}
 await fs.mkdir(a.spec.output_dir,{mode:0o700});await fs.writeFile(join(a.spec.output_dir,'existing.txt'),'keep',{mode:0o400});const old=await packageSnapshot(a.spec.output_dir);await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot(a.spec),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');assert.deepEqual(await packageSnapshot(a.spec.output_dir),old);assert.deepEqual(await packageSnapshot(a.snapshotDir),before);
 const damaged=join(a.snapshotDir,'candidate-files','src','app.mjs');await fs.chmod(damaged,0o600);await fs.appendFile(damaged,'corrupt');await fs.chmod(damaged,0o400);const corruptBefore=await packageSnapshot(a.snapshotDir),dest=join(f.root,'corrupt-rejected');await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot({...a.spec,output_dir:dest}),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');await assert.rejects(fs.lstat(dest),{code:'ENOENT'});assert.deepEqual(await packageSnapshot(a.snapshotDir),corruptBefore);
}));
test('snapshot source output faults retain partial or complete handoff and reject incorrect provenance bindings',async()=>{
 for(const fault of ['write','close','receipt-read','receipt-binding','package-drift','source-drift','root-replacement','extra-entry'])await withFixture(async f=>{
  const a=await snapshotReviewFixture(f);let injected=false;
  const fsPort=snapshotReviewFs({open:async(path,flags,...args)=>{if(fault==='receipt-read'&&path===join(a.spec.output_dir,'provenance.json')&&!(flags&3)){injected=true;throw Error('PRIVATE_RECEIPT_READ');}const h=await fs.open(path,flags,...args);if(path===join(a.spec.output_dir,'provenance.json')&&(flags&2||flags&1))return {stat:(...v)=>h.stat(...v),close:async()=>{await h.close();if(fault==='close')throw Error('PRIVATE_CLOSE_FAILURE');},writeFile:async bytes=>{
   injected=true;if(fault==='write')throw Error('PRIVATE_WRITE_FAILURE');
   if(fault==='receipt-binding'){const record=JSON.parse(bytes);record.review_package_manifest_sha256='0'.repeat(64);await h.writeFile(Buffer.from(JSON.stringify(record)));}else await h.writeFile(bytes);
   if(fault==='package-drift'||fault==='source-drift'){const target=fault==='package-drift'?join(a.spec.output_dir,'package','changes','src','app.mjs.new'):join(a.snapshotDir,'candidate-files','src','app.mjs');await fs.chmod(target,0o600);await fs.appendFile(target,'fixture mutation');await fs.chmod(target,0o400);}
   if(fault==='root-replacement'){const old=join(f.root,'retained-source');await fs.rename(a.snapshotDir,old);await fs.cp(old,a.snapshotDir,{recursive:true});}
   if(fault==='extra-entry')await fs.writeFile(join(a.spec.output_dir,'unexpected'),'extra',{mode:0o400});
  }};return h;}});
  await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot(a.spec,{fs:fsPort}),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');assert.equal(injected,true);assert.equal((await fs.stat(a.spec.output_dir)).mode&0o777,0o700);if(fault==='package-drift')await assert.rejects(verifyProjectCandidateReviewPackage(join(a.spec.output_dir,'package')),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');else assert.equal((await verifyProjectCandidateReviewPackage(join(a.spec.output_dir,'package'))).status,'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED');
 });
});
test('snapshot source cancellation closes handles and preserves unknown partial output',()=>withFixture(async f=>{
 const a=await snapshotReviewFixture(f),abort=new AbortController(),handles=new Set();let fired=false;
 const fsPort=snapshotReviewFs({open:async(path,flags,...args)=>{const h=await fs.open(path,flags,...args);handles.add(h);if(path===join(a.spec.output_dir,'package','diff.txt')&&!fired){fired=true;abort.abort();}return {stat:(...v)=>h.stat(...v),read:(...v)=>h.read(...v),writeFile:(...v)=>h.writeFile(...v),close:async()=>{try{await h.close();}finally{handles.delete(h);}}};}});
 await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot({...a.spec,signal:abort.signal},{fs:fsPort}),e=>e.code==='PROJECT_CANDIDATE_REVIEW_ABORTED');assert.equal(fired,true);assert.equal(handles.size,0);assert.ok((await fs.readdir(a.spec.output_dir)).includes('package'));
 const before=new AbortController();before.abort();const dest=join(f.root,'pre-aborted');await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot({...a.spec,output_dir:dest,signal:before.signal}),e=>e.code==='PROJECT_CANDIDATE_REVIEW_ABORTED');await assert.rejects(fs.lstat(dest),{code:'ENOENT'});
}));
test('snapshot source valid portable profiles still obey narrower changed-copy and diff limits',async()=>{
 for(const kind of ['copies-over','diff-over','binary-edge']){const f=await fixture({oldApp:Buffer.alloc(4*1024*1024,kind==='binary-edge'?0:65),newApp:Buffer.alloc(4*1024*1024,kind==='binary-edge'?255:66),extras:kind==='copies-over'});try{
  const a=await snapshotReviewFixture(f);if(kind==='binary-edge'){const built=await buildProjectCandidateReviewPackageFromSnapshot(a.spec);assert.equal(built.changed_path_count,1);assert.equal((await verifyProjectCandidateReviewPackage(join(a.spec.output_dir,'package'))).manifest_sha256,built.manifest_sha256);const m=JSON.parse(await fs.readFile(join(a.spec.output_dir,'package','review-manifest.json')));assert.equal(m.paths[0].binary_review_required,true);}else{await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot(a.spec),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');await assert.rejects(fs.lstat(a.spec.output_dir),{code:'ENOENT'});}
 }finally{await fs.rm(f.root,{recursive:true,force:true});}}
});
test('snapshot source maximum fifty-path V1 output and private receipt remain bounded',async()=>{
 const f=await fixture({deepDistinct:true});try{const live=await buildProjectCandidateReviewPackage(f.spec),a=await snapshotReviewFixture(f),built=await buildProjectCandidateReviewPackageFromSnapshot(a.spec);assert.equal(built.changed_path_count,50);assert.equal(built.manifest_sha256,live.manifest_sha256);assert.deepEqual(await packageSnapshot(join(a.spec.output_dir,'package')),await packageSnapshot(f.output));assert.ok((await fs.stat(join(a.spec.output_dir,'provenance.json'))).size<=16*1024);}finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('snapshot source CLI creates a usable handoff, contains lost acknowledgements and runs no Git in the route',()=>withFixture(async f=>{
 const a=await snapshotReviewFixture(f),before=await packageSnapshot(a.snapshotDir),input=join(f.root,'snapshot-spec.json');await fs.rename(f.base,join(f.root,'no-base'));await fs.rename(f.candidate,join(f.root,'no-candidate'));
 await fs.writeFile(input,JSON.stringify(a.spec),{mode:0o600});const inputBefore=await fs.readFile(input),built=await artifactCliChild(reviewCliUrl,['--build-from-snapshot',input]);assert.equal(built.code,0);assert.equal(built.signal,null);assert.equal(built.stderr,'');assert.match(built.stdout,/^PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED_FROM_SNAPSHOT/);assert.doesNotMatch(built.stdout,/squire-review-package|snapshot-review-handoff|source-snapshot|reviewer_label/);assert.deepEqual(await fs.readFile(input),inputBefore);assert.equal((await verifyProjectCandidateReviewPackage(join(a.spec.output_dir,'package'))).status,'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED');
 const again=await artifactCliChild(reviewCliUrl,['--build-from-snapshot',input]);assert.equal(again.code,2);assert.equal(again.stdout,'');assert.equal(again.stderr,'PROJECT_CANDIDATE_REVIEW_REJECTED\n');
 for(const closed of [false,true]){const spec={...a.spec,output_dir:join(f.root,closed?'lost-ack':'no-git')},path=join(f.root,closed?'lost-spec.json':'no-git-spec.json');await fs.writeFile(path,JSON.stringify(spec),{mode:0o600});const beforeCode="import c from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';c.spawn=()=>{throw Error('UNEXPECTED_GIT_OR_PROVIDER');};syncBuiltinESMExports();";const out=await artifactCliChild(reviewCliUrl,['--build-from-snapshot',path],closed?{closed:'stdout'}:{before:beforeCode});assert.equal(out.code,closed?2:0);assert.equal(out.signal,null);assert.equal(out.stderr,'');if(closed)assert.equal(out.stdout,'');assert.equal((await verifyProjectCandidateReviewPackage(join(spec.output_dir,'package'))).status,'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED');assert.equal(JSON.parse(await fs.readFile(join(spec.output_dir,'provenance.json'))).source_snapshot_manifest_sha256,a.snapshot.manifest_sha256);}
 const lateSpec={...a.spec,output_dir:join(f.root,'late-ack')},latePath=join(f.root,'late-spec.json');await fs.writeFile(latePath,JSON.stringify(lateSpec),{mode:0o600});const late=await artifactCliChild(reviewCliUrl,['--build-from-snapshot',latePath],{before:"const w=process.stdout.write.bind(process.stdout);process.stdout.write=(...v)=>{const r=w(...v);setImmediate(()=>process.stdout.emit('error',Error('PRIVATE_LATE')));return r;};"});assert.equal(late.code,2);assert.equal(late.signal,null);assert.equal(late.stderr,'');assert.match(late.stdout,/^PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED_FROM_SNAPSHOT/);assert.equal((await verifyProjectCandidateReviewPackage(join(lateSpec.output_dir,'package'))).status,'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED');
 assert.deepEqual(await packageSnapshot(a.snapshotDir),before);
}));
test('snapshot source rejects missing oversized wrong-schema or inconsistent inventory before output',async()=>{
 for(const fault of ['missing-object','oversize-manifest','revision-schema','object-bytes','private-mode'])await withFixture(async f=>{
  const a=await snapshotReviewFixture(f),manifestPath=join(a.snapshotDir,'manifest.json'),manifest=JSON.parse(await fs.readFile(manifestPath));let expected=a.spec.expected_manifest_sha256;
  if(fault==='missing-object'||fault==='object-bytes'){const id=manifest.objects[0].git_sha1,target=join(a.snapshotDir,'objects',id.slice(0,2),id.slice(2));if(fault==='missing-object')await fs.unlink(target);else{await fs.chmod(target,0o600);await fs.appendFile(target,'inconsistent bytes');await fs.chmod(target,0o400);}}
  if(fault==='oversize-manifest'||fault==='revision-schema'){const bytes=fault==='oversize-manifest'?Buffer.alloc(8*1024*1024+1,32):decisionWire({...manifest,schema:'SQUIRE_PROJECT_REVISION_REVIEW_PACKAGE_V1'});await fs.chmod(manifestPath,0o600);await fs.writeFile(manifestPath,bytes);await fs.chmod(manifestPath,0o400);expected=createHash('sha256').update(bytes).digest('hex');} // Pin deliberately invalid synthetic bytes; never manufacture expectations for real inputs.
  if(fault==='private-mode')await fs.chmod(join(a.snapshotDir,'candidate-files','src','app.mjs'),0o600);
  const before=await packageSnapshot(a.snapshotDir);await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot({...a.spec,expected_manifest_sha256:expected}),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');await assert.rejects(fs.lstat(a.spec.output_dir),{code:'ENOENT'});assert.deepEqual(await packageSnapshot(a.snapshotDir),before);
 });
});
test('snapshot source rejects substitution of a different valid V1 output before provenance publication',()=>withFixture(async f=>{
 const a=await snapshotReviewFixture(f),other=await fixture({newApp:Buffer.from('a different valid synthetic candidate\n')});try{
  const b=await buildProjectCandidateReviewPackage(other.spec),target=join(a.spec.output_dir,'package');let substituted=false;
  const fsPort=snapshotReviewFs({lstat:async path=>{if(path===target&&!substituted){let complete=false;try{complete=(await fs.lstat(join(target,'review-manifest.json'))).isFile();}catch{}if(complete){substituted=true;await fs.rename(target,join(f.root,'retained-pre-substitution-package'));await fs.cp(other.output,target,{recursive:true});}}return fs.lstat(path);}});
  await assert.rejects(buildProjectCandidateReviewPackageFromSnapshot(a.spec,{fs:fsPort}),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');assert.equal(substituted,true);assert.equal((await verifyProjectCandidateReviewPackage(target)).manifest_sha256,b.manifest_sha256);await assert.rejects(fs.lstat(join(a.spec.output_dir,'provenance.json')),{code:'ENOENT'});
 }finally{await fs.rm(other.root,{recursive:true,force:true});}
}));

async function copiedHandoffFixture(f){const a=await snapshotReviewFixture(f),built=await buildProjectCandidateReviewPackageFromSnapshot(a.spec),copy=join(f.root,'copied-handoff');await fs.cp(a.spec.output_dir,copy,{recursive:true});return {...a,built,copy};}
async function receiptFixtureBytes(root,bytes){const path=join(root,'provenance.json');await fs.chmod(path,0o600);await fs.writeFile(path,bytes);await fs.chmod(path,0o400);return createHash('sha256').update(bytes).digest('hex');}
test('copied handoff verifies retained pair without source stores or any writes',()=>withFixture(async f=>{
 const a=await copiedHandoffFixture(f),before=await packageSnapshot(a.copy);for(const [i,path] of [f.base,f.candidate,a.snapshotDir,a.spec.output_dir].entries())await fs.rename(path,join(f.root,'unavailable-'+i));
 let writes=0,opens=0;const fsPort=snapshotReviewFs({mkdir:()=>{writes++;throw Error('UNEXPECTED_WRITE');},chmod:()=>{writes++;throw Error('UNEXPECTED_WRITE');},open:async(path,flags,...args)=>{assert.ok(path.startsWith(a.copy+'/'));assert.equal(flags&3,0);opens++;return fs.open(path,flags,...args);}});
 const result=await verifyProjectCandidateReviewSnapshotHandoff(a.copy,a.built.provenance_sha256,{fs:fsPort});assert.ok(Object.isFrozen(result));assert.equal(result.status,'PROJECT_CANDIDATE_REVIEW_SNAPSHOT_HANDOFF_VERIFIED');for(const key of Object.keys(a.built).filter(k=>k!=='status'))assert.equal(result[key],a.built[key]);assert.equal(Object.keys(result).length,11);assert.equal(writes,0);assert.ok(opens>0);assert.deepEqual(await packageSnapshot(a.copy),before);
 const cli=await artifactCliChild(reviewCliUrl,['--verify-snapshot-handoff',a.copy,a.built.provenance_sha256]);assert.equal(cli.code,0);assert.equal(cli.signal,null);assert.equal(cli.stderr,'');assert.match(cli.stdout,/^PROJECT_CANDIDATE_REVIEW_SNAPSHOT_HANDOFF_VERIFIED/);assert.doesNotMatch(cli.stdout,/squire-review-package|copied-handoff|unavailable-|source-snapshot/);assert.deepEqual(await packageSnapshot(a.copy),before);
}));
test('copied handoff malformed API arguments access no filesystem',async()=>{
 let calls=0;const fsPort=snapshotReviewFs(Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(k=>[k,()=>{calls++;throw Error('UNEXPECTED_FS');}])));
 for(const [path,hash] of [['relative','a'.repeat(64)],['/','a'.repeat(64)],['/synthetic/../handoff','a'.repeat(64)],['/synthetic/handoff','A'.repeat(64)],['/synthetic/handoff','a'.repeat(64)+'\n'],['/synthetic/handoff',new String('a'.repeat(64))],['/synthetic/handoff',null]])await assert.rejects(verifyProjectCandidateReviewSnapshotHandoff(path,hash,{fs:fsPort}),e=>e.code==='INVALID_PROJECT_CANDIDATE_REVIEW_SPEC');assert.equal(calls,0);
});
test('copied handoff rejects wrong receipt and cross-paired valid package',()=>withFixture(async f=>{
 const a=await copiedHandoffFixture(f),other=await fixture({newApp:Buffer.from('different valid candidate\n')});try{
  const b=await buildProjectCandidateReviewPackage(other.spec),otherPrepared=await snapshotReviewFixture(other),otherHandoff=await buildProjectCandidateReviewPackageFromSnapshot(otherPrepared.spec),before=await packageSnapshot(a.copy);assert.equal((await verifyProjectCandidateReviewSnapshotHandoff(otherPrepared.spec.output_dir,otherHandoff.provenance_sha256)).manifest_sha256,b.manifest_sha256);await assert.rejects(verifyProjectCandidateReviewSnapshotHandoff(otherPrepared.spec.output_dir,a.built.provenance_sha256),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');await assert.rejects(verifyProjectCandidateReviewSnapshotHandoff(a.copy,'0'.repeat(64)),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');assert.deepEqual(await packageSnapshot(a.copy),before);
  await fs.rename(join(a.copy,'package'),join(f.root,'preserved-original-package'));await fs.cp(other.output,join(a.copy,'package'),{recursive:true});assert.equal((await verifyProjectCandidateReviewPackage(join(a.copy,'package'))).manifest_sha256,b.manifest_sha256);const cross=await packageSnapshot(a.copy);await assert.rejects(verifyProjectCandidateReviewSnapshotHandoff(a.copy,a.built.provenance_sha256),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');assert.deepEqual(await packageSnapshot(a.copy),cross);
 }finally{await fs.rm(other.root,{recursive:true,force:true});}
}));
test('copied handoff checks canonical receipt schema and every bound package field even with fixture-pinned bytes',()=>withFixture(async f=>{
 const a=await copiedHandoffFixture(f),raw=JSON.parse(await fs.readFile(join(a.copy,'provenance.json')));const bad=[{...raw,schema:'SQUIRE_OTHER'},{...raw,extra:'PRIVATE_EXTRA'},{...raw,review_package_manifest_sha256:'0'.repeat(64)},{...raw,input_result_sha256:'0'.repeat(64)},...['base_commit','base_tree','candidate_commit','candidate_tree'].map(k=>({...raw,[k]:'0'.repeat(40)})),{...raw,changed_path_count:raw.changed_path_count+1},{...raw,changed_path_count:51},{...raw,package_bytes:raw.package_bytes+1},{...raw,package_bytes:17*1024*1024+1},{...raw,source_snapshot_manifest_sha256:'PRIVATE_HASH'},{...raw,boundaries:[...raw.boundaries,'NEW_AUTHORITY']},{...raw,boundaries:[...raw.boundaries].reverse()}];
 const missing={...raw};delete missing.input_result_sha256;bad.push(missing);
 const bytes=[...bad.map(decisionWire),Buffer.from('{'),Buffer.from([255]),Buffer.concat([decisionWire(raw),Buffer.from('\n')]),Buffer.from(decisionWire(raw).toString().replace('"schema":','"schema":"DUPLICATE","schema":')),Buffer.alloc(16*1024,32),Buffer.alloc(16*1024+1,32)];
 for(let i=0;i<bytes.length;i++){const dest=join(f.root,'bad-handoff-'+i);await fs.cp(a.copy,dest,{recursive:true});const expected=await receiptFixtureBytes(dest,bytes[i]),before=await packageSnapshot(dest);await assert.rejects(verifyProjectCandidateReviewSnapshotHandoff(dest,expected),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');assert.deepEqual(await packageSnapshot(dest),before);}
 // A caller-pinned well-formed source claim is only a declared retained lineage, not source authentication.
 const declared=join(f.root,'declared-lineage');await fs.cp(a.copy,declared,{recursive:true});const expected=await receiptFixtureBytes(declared,decisionWire({...raw,source_snapshot_manifest_sha256:'0'.repeat(64)}));assert.equal((await verifyProjectCandidateReviewSnapshotHandoff(declared,expected)).source_snapshot_manifest_sha256,'0'.repeat(64));
}));
test('copied handoff rejects private closure modes and nonregular or multilink receipts',()=>withFixture(async f=>{
 const a=await copiedHandoffFixture(f);for(const fault of ['root-mode','receipt-mode','extra-entry','symlink','hardlink','directory','package-mode']){const dest=join(f.root,fault);await fs.cp(a.copy,dest,{recursive:true});const receipt=join(dest,'provenance.json');if(fault==='root-mode')await fs.chmod(dest,0o755);if(fault==='receipt-mode')await fs.chmod(receipt,0o600);if(fault==='extra-entry')await fs.writeFile(join(dest,'unexpected'),'extra',{mode:0o400});if(fault==='package-mode')await fs.chmod(join(dest,'package'),0o755);if(['symlink','hardlink','directory'].includes(fault)){const target=join(f.root,fault+'-retained.json');await fs.rename(receipt,target);if(fault==='symlink')await fs.symlink(target,receipt);else if(fault==='hardlink')await fs.link(target,receipt);else await fs.mkdir(receipt,{mode:0o700});}await assert.rejects(verifyProjectCandidateReviewSnapshotHandoff(dest,a.built.provenance_sha256),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');}
 const receipt=join(a.copy,'provenance.json'),port=snapshotReviewFs({lstat:async p=>{const s=await fs.lstat(p);return p===receipt?new Proxy(s,{get(t,k){if(k==='uid')return process.getuid()+1;const v=Reflect.get(t,k);return typeof v==='function'?v.bind(t):v;}}):s;}});await assert.rejects(verifyProjectCandidateReviewSnapshotHandoff(a.copy,a.built.provenance_sha256,{fs:port}),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');
}));
test('copied handoff fails closed on read-close mutation replacement or errors without leaking handles',async()=>{
 for(const fault of ['receipt-change','receipt-replacement','root-replacement','close-error'])await withFixture(async f=>{
  const a=await copiedHandoffFixture(f),receipt=join(a.copy,'provenance.json'),handles=new Set();let fired=false;
  const fsPort=snapshotReviewFs({open:async(path,flags,...args)=>{const h=await fs.open(path,flags,...args);handles.add(h);return {stat:(...v)=>h.stat(...v),read:(...v)=>h.read(...v),close:async()=>{try{await h.close();}finally{handles.delete(h);}if(path===receipt&&!fired){fired=true;if(fault==='receipt-change'){await fs.chmod(receipt,0o600);await fs.appendFile(receipt,' ');await fs.chmod(receipt,0o400);}if(fault==='receipt-replacement'){const old=join(f.root,'retained-receipt');await fs.rename(receipt,old);await fs.copyFile(old,receipt);}if(fault==='root-replacement'){const old=join(f.root,'retained-handoff');await fs.rename(a.copy,old);await fs.cp(old,a.copy,{recursive:true});}if(fault==='close-error')throw Error('PRIVATE_CLOSE_ERROR');}}};}});
  await assert.rejects(verifyProjectCandidateReviewSnapshotHandoff(a.copy,a.built.provenance_sha256,{fs:fsPort}),e=>e.code==='PROJECT_CANDIDATE_REVIEW_REJECTED');assert.equal(fired,true);assert.equal(handles.size,0);
 });
});
test('copied handoff maximum paths and executable output failures retain unchanged packets',async()=>{
 const f=await fixture({deepDistinct:true});try{const a=await copiedHandoffFixture(f),before=await packageSnapshot(a.copy);assert.equal((await verifyProjectCandidateReviewSnapshotHandoff(a.copy,a.built.provenance_sha256)).changed_path_count,50);const args=['--verify-snapshot-handoff',a.copy,a.built.provenance_sha256];
 for(const [argv,channel] of [[args,'stdout'],[[args[0],args[1],'0'.repeat(64)],'stderr']]){const r=await artifactCliChild(reviewCliUrl,argv,{closed:channel});assert.equal(r.code,2);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');}
 const late=await artifactCliChild(reviewCliUrl,args,{before:"const w=process.stdout.write.bind(process.stdout);process.stdout.write=(...v)=>{const r=w(...v);setImmediate(()=>process.stdout.emit('error',Error('PRIVATE_LATE')));return r;};"});assert.equal(late.code,2);assert.equal(late.signal,null);assert.equal(late.stderr,'');assert.match(late.stdout,/^PROJECT_CANDIDATE_REVIEW_SNAPSHOT_HANDOFF_VERIFIED/);assert.deepEqual(await packageSnapshot(a.copy),before);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
