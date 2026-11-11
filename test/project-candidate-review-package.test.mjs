import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync} from 'node:zlib';
import {
  buildProjectCandidateReviewPackage,verifyProjectCandidateReviewPackage,
  recordProjectCandidateDecision
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
