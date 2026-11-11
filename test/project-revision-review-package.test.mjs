import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import childProcess,{execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildProjectCandidateReviewPackage,recordProjectCandidateDecision} from '../src/project-candidate-review-package.mjs';
import {buildProjectRevisionReviewPackage,verifyProjectRevisionReviewPackage,recordProjectRevisionDecision,verifyProjectRevisionDecision} from '../src/project-revision-review-package.mjs';
const GIT='/usr/bin/git';const env={PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
function git(dir,args,input){return execFileSync(GIT,['-c','core.hooksPath=/dev/null','-c','protocol.allow=never',`--git-dir=${dir}`,...args],{cwd:dir,env,input,encoding:'buffer',maxBuffer:16*1024*1024}).toString('ascii').trim();}
function blob(dir,data){return git(dir,['hash-object','-w','--stdin','--no-filters'],data);}
function tree(dir,rows){const root={dirs:new Map(),files:[]};for(const row of rows){const parts=row.path.split('/');let node=root;for(const p of parts.slice(0,-1)){if(!node.dirs.has(p))node.dirs.set(p,{dirs:new Map(),files:[]});node=node.dirs.get(p);}node.files.push({...row,name:parts.at(-1)});}const build=node=>{const list=[];for(const [name,child] of node.dirs)list.push({name,key:name+'/',mode:'040000',type:'tree',oid:build(child)});for(const row of node.files)list.push({name:row.name,key:row.name,mode:row.mode??'100644',type:'blob',oid:row.oid});list.sort((a,b)=>Buffer.compare(Buffer.from(a.key),Buffer.from(b.key)));return git(dir,['mktree','-z'],Buffer.concat(list.map(x=>Buffer.from(`${x.mode} ${x.type} ${x.oid}\t${x.name}\0`))));};return build(root);}
function commit(dir,t,parent){return git(dir,['commit-tree',t,...(parent?['-p',parent]:[]),'-m','fixture']);}
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(extraPaths=0,executableRestore=false,badExecutableRestore=false,largeBaseApp=false,largeDisplay=false,displayBaseLines=900000,displayTail=""){const root=await fs.mkdtemp(join(tmpdir(),'squire-p1b-'));await fs.chmod(root,0o700);const base=join(root,'base.git'),original=join(root,'original.git'),revised=join(root,'revised.git');for(const dir of [base,original,revised])execFileSync(GIT,['init','--bare','--shared=0600','--quiet','--template=/dev/null',dir],{env});
  const b={app:largeDisplay?Buffer.concat([Buffer.alloc(displayBaseLines,10),Buffer.from(displayTail)]):largeBaseApp?Buffer.alloc(4*1024*1024,0):Buffer.from('base\n'),restore:Buffer.from('base restore\n'),unchanged:Buffer.from('base unchanged\n')};
  const o={app:Buffer.from('original\n'),restore:Buffer.from('original restore\n'),unchanged:Buffer.from('original unchanged\n'),bin:Buffer.from([0,255,1])};
  const r={app:largeDisplay?Buffer.alloc(400000,10):Buffer.from('revised\n'),restore:b.restore,unchanged:o.unchanged,bin:Buffer.from([0,255,2]),added:Buffer.from('added\n')};
  const baseRows=[{path:'src/app.mjs',oid:blob(base,b.app)},{path:'src/restore.mjs',mode:executableRestore?'100755':'100644',oid:blob(base,b.restore)},{path:'src/unchanged.mjs',oid:blob(base,b.unchanged)}];
  const baseTree=tree(base,baseRows),baseCommit=commit(base,baseTree);
  for(const dir of [original,revised])await fs.writeFile(join(dir,'objects','info','alternates'),join(base,'objects')+'\n',{mode:0o600});
  const origRows=[{path:'src/app.mjs',oid:blob(original,o.app)},{path:'src/restore.mjs',oid:blob(original,o.restore)},{path:'src/unchanged.mjs',oid:blob(original,o.unchanged)},{path:'assets/icon.bin',oid:blob(original,o.bin)},{path:'docs/added.md',oid:blob(original,r.added)}];
  for(let i=0;i<extraPaths;i++)origRows.push({path:`docs/extra-${String(i).padStart(2,'0')}.md`,oid:blob(original,Buffer.from(`extra ${i}\n`))});
  const originalTree=tree(original,origRows),originalCommit=commit(original,originalTree,baseCommit);git(original,['update-ref','refs/heads/candidate-original',originalCommit]);
  const revRows=[{path:'src/app.mjs',oid:blob(revised,r.app)},{path:'src/restore.mjs',mode:executableRestore?'100755':'100644',oid:badExecutableRestore?blob(revised,Buffer.from('wrong executable\n')):baseRows[1].oid},{path:'src/unchanged.mjs',oid:blob(revised,o.unchanged)},{path:'assets/icon.bin',oid:blob(revised,r.bin)},{path:'docs/added.md',oid:blob(revised,r.added)}];
  for(let i=0;i<extraPaths;i++)revRows.push({path:`docs/extra-${String(i).padStart(2,'0')}.md`,oid:blob(revised,Buffer.from(`extra ${i}\n`))});
  const revisedTree=tree(revised,revRows),revisedCommit=commit(revised,revisedTree,baseCommit);git(revised,['update-ref','refs/heads/candidate-revised',revisedCommit]);
  const common={base_commit:baseCommit,base_tree:baseTree,receipt_sha256:'a'.repeat(64),stage_manifest_sha256:'b'.repeat(64),task_correctness:'NOT_EVALUATED',human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',benchmark_acceptance:'NOT_ESTABLISHED',origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'};
  const originalResult={schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',operation_id:'original',candidate_ref:'refs/heads/candidate-original',candidate_commit:originalCommit,candidate_tree:originalTree,changed_paths:['assets/icon.bin','docs/added.md',...Array.from({length:extraPaths},(_,i)=>`docs/extra-${String(i).padStart(2,'0')}.md`),'src/app.mjs','src/restore.mjs','src/unchanged.mjs'],...common};
  const witness=(path,oldData,newData,oldOid,newOid)=>({path,previous_blob:oldOid,previous_bytes:oldData.length,previous_sha256:sha(oldData),blob:newOid,bytes:newData.length,sha256:sha(newData)});
  const revisedResult={...originalResult,schema:'SQUIRE_PROJECT_REVISION_CANDIDATE_V1',status:'SOURCE_REVISION_CANDIDATE_CREATED',operation_id:'revised',candidate_ref:'refs/heads/candidate-revised',candidate_commit:revisedCommit,candidate_tree:revisedTree,changed_paths:['assets/icon.bin','docs/added.md',...Array.from({length:extraPaths},(_,i)=>`docs/extra-${String(i).padStart(2,'0')}.md`),'src/app.mjs','src/unchanged.mjs'],correction_origin:'OPERATOR_SUPPLIED',revision_of:{commit:originalCommit,tree:originalTree},revised_blobs:[witness('assets/icon.bin',o.bin,r.bin,origRows[3].oid,revRows[3].oid),witness('src/app.mjs',o.app,r.app,origRows[0].oid,revRows[0].oid),witness('src/restore.mjs',o.restore,badExecutableRestore?Buffer.from('wrong executable\n'):r.restore,origRows[1].oid,revRows[1].oid)]};
  const id=async dir=>{const s=await fs.stat(dir);return {dev:s.dev,ino:s.ino};};
  const pkg=join(root,'original-package');const p1=await buildProjectCandidateReviewPackage({schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1',result:originalResult,candidate_git_dir:original,candidate_git_identity:await id(original),base_git_dir:base,base_git_identity:await id(base),output_dir:pkg});
  const priorDir=join(root,'prior');const prior=await recordProjectCandidateDecision(pkg,{schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'prior',reviewer_label:'owner',review_package_sha256:p1.manifest_sha256,base_commit:baseCommit,base_tree:baseTree,candidate_commit:originalCommit,candidate_tree:originalTree,choice:'REVISE',attestations:[]},priorDir);
  const spec={schema:'SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1',original_result:originalResult,revised_result:revisedResult,base_git_dir:base,base_git_identity:await id(base),original_git_dir:original,original_git_identity:await id(original),revised_git_dir:revised,revised_git_identity:await id(revised),output_dir:join(root,'revision-package'),original_package:{dir:pkg,manifest_sha256:p1.manifest_sha256},prior_decisions:[{dir:priorDir,file_sha256:prior.decision_sha256}],selected_decision_id:'prior'};
  return {root,spec,originalResult,revisedResult,p1,prior,r};}
const fail=(code,fn)=>assert.rejects(fn,e=>e?.code===code);
test('two direct private views, restored base, prior REVISE, and fresh decision',async()=>{const f=await fixture();try{
  const built=await buildProjectRevisionReviewPackage(f.spec);assert.equal(built.base_to_revised_count,4);assert.equal(built.original_to_revised_count,3);
  const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));
  assert.equal(m.original_to_revised.find(x=>x.path==='src/restore.mjs').classification,'RESTORED_BASE');
  assert.equal(m.original_to_revised.some(x=>x.path==='src/unchanged.mjs'),false);
  assert.equal(m.base_to_revised.some(x=>x.path==='src/unchanged.mjs'),true);
  assert.equal((await verifyProjectRevisionReviewPackage(f.spec.output_dir)).manifest_sha256,built.manifest_sha256);
  const d={schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'fresh',reviewer_label:'owner',revision_package_sha256:built.manifest_sha256,original_package_sha256:f.p1.manifest_sha256,prior_revise_decision_sha256:f.prior.decision_sha256,base_commit:m.base_commit,base_tree:m.base_tree,original_commit:m.original_commit,original_tree:m.original_tree,revised_commit:m.revised_commit,revised_tree:m.revised_tree,choice:'ACCEPT',attestations:[...m.base_to_revised.map(x=>({view:'base_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required})),...m.original_to_revised.map(x=>({view:'original_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required}))]};
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>recordProjectRevisionDecision(f.spec.output_dir,{...d,attestations:d.attestations.slice(1)},join(f.root,'missing')));
  const recorded=await recordProjectRevisionDecision(f.spec.output_dir,d,join(f.root,'decision'));assert.equal(recorded.choice,'ACCEPT');
  assert.equal((await verifyProjectRevisionDecision(f.spec.output_dir,join(f.root,'decision'),recorded.decision_sha256)).choice,'ACCEPT');
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('source and prior decision links fail closed before output',async()=>{for(const mutate of [
  f=>{f.spec.revised_git_identity.ino++;},
  f=>{f.spec.revised_result={...f.revisedResult,receipt_sha256:'f'.repeat(64)};},
  f=>{f.spec.revised_result={...f.revisedResult,revision_of:{...f.revisedResult.revision_of,commit:'f'.repeat(40)}};},
  f=>{f.spec.revised_result={...f.revisedResult,revised_blobs:f.revisedResult.revised_blobs.map((x,i)=>i===0?{...x,previous_sha256:'f'.repeat(64)}:x)};},
  f=>{f.spec.original_package.manifest_sha256='f'.repeat(64);},
  f=>{f.spec.selected_decision_id='missing';},
  f=>{f.spec.prior_decisions[0].file_sha256='f'.repeat(64);}
]){const f=await fixture();try{mutate(f);await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec));await assert.rejects(fs.lstat(f.spec.output_dir),{code:'ENOENT'});}finally{await fs.rm(f.root,{recursive:true,force:true});}}});
test('binary acknowledgement, both-view coverage, and offline mutation checks',async()=>{const f=await fixture();try{
  const built=await buildProjectRevisionReviewPackage(f.spec);const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));
  const base={schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'decision',reviewer_label:'owner',revision_package_sha256:built.manifest_sha256,original_package_sha256:f.p1.manifest_sha256,prior_revise_decision_sha256:f.prior.decision_sha256,base_commit:m.base_commit,base_tree:m.base_tree,original_commit:m.original_commit,original_tree:m.original_tree,revised_commit:m.revised_commit,revised_tree:m.revised_tree,choice:'ACCEPT',attestations:[...m.base_to_revised.map(x=>({view:'base_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required})),...m.original_to_revised.map(x=>({view:'original_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required}))]};
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>recordProjectRevisionDecision(f.spec.output_dir,{...base,attestations:base.attestations.map(x=>({...x,binary_inspected:false}))},join(f.root,'bad-binary')));
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>recordProjectRevisionDecision(f.spec.output_dir,{...base,attestations:base.attestations.filter(x=>x.view==='base_to_revised')},join(f.root,'one-view')));
  const revised=await recordProjectRevisionDecision(f.spec.output_dir,{...base,choice:'REVISE',attestations:[]},join(f.root,'revise'));
  const rejected=await recordProjectRevisionDecision(f.spec.output_dir,{...base,decision_id:'reject',choice:'REJECT',attestations:[]},join(f.root,'reject'));
  assert.notEqual(revised.decision_sha256,rejected.decision_sha256);
  const path=join(f.spec.output_dir,'changes','assets','icon.bin.revised');await fs.chmod(path,0o600);await fs.writeFile(path,Buffer.from([1,2,3]));await fs.chmod(path,0o400);
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>verifyProjectRevisionReviewPackage(f.spec.output_dir));
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('cancelled build and existing output never acknowledge',async()=>{const f=await fixture();try{const c=new AbortController();c.abort();await fail('PROJECT_REVISION_REVIEW_ABORTED',()=>buildProjectRevisionReviewPackage({...f.spec,signal:c.signal}));await assert.rejects(fs.lstat(f.spec.output_dir),{code:'ENOENT'});await buildProjectRevisionReviewPackage(f.spec);await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec));}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('write-close uncertainty retains partial private output without success',async()=>{const f=await fixture();try{
  const names=['lstat','realpath','mkdir','open','chmod','opendir'];const port=Object.fromEntries(names.map(k=>[k,(...args)=>fs[k](...args)]));let failed=false;
  port.open=async(...args)=>{const handle=await fs.open(...args);if(!failed&&args[0].endsWith('icon.bin.revised')&&(args[1]&1)){failed=true;return {stat:(...v)=>handle.stat(...v),writeFile:(...v)=>handle.writeFile(...v),close:async()=>{await handle.close();throw new Error('synthetic close uncertainty');}};}return handle;};
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec,{fs:port}));
  assert.equal((await fs.lstat(f.spec.output_dir)).isDirectory(),true);
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec));
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('pinned ref, alternate, and disclosed conflict reject',async()=>{for(const mutate of [
  async f=>{git(f.spec.revised_git_dir,['update-ref','refs/heads/candidate-revised',f.revisedResult.base_commit]);},
  async f=>{await fs.chmod(join(f.spec.revised_git_dir,'objects','info','alternates'),0o600);await fs.writeFile(join(f.spec.revised_git_dir,'objects','info','alternates'),'/not/the/base\n');},
  async f=>{const dir=join(f.root,'conflict');const m=JSON.parse(await fs.readFile(join(f.spec.original_package.dir,'review-manifest.json')));const d=await recordProjectCandidateDecision(f.spec.original_package.dir,{schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'conflict',reviewer_label:'owner',review_package_sha256:f.p1.manifest_sha256,base_commit:m.base_commit,base_tree:m.base_tree,candidate_commit:m.candidate_commit,candidate_tree:m.candidate_tree,choice:'REJECT',attestations:[]},dir);f.spec.prior_decisions.push({dir,file_sha256:d.decision_sha256});}
]){const f=await fixture();try{await mutate(f);await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec));await assert.rejects(fs.lstat(f.spec.output_dir),{code:'ENOENT'});}finally{await fs.rm(f.root,{recursive:true,force:true});}}});
test('source ref drift during package write retains partial output',async()=>{const f=await fixture();try{
  const names=['lstat','realpath','mkdir','open','chmod','opendir'];const port=Object.fromEntries(names.map(k=>[k,(...args)=>fs[k](...args)]));let drifted=false;
  port.open=async(...args)=>{if(!drifted&&args[0].endsWith('revision-review-manifest.json')&&(args[1]&1)){drifted=true;git(f.spec.revised_git_dir,['update-ref','refs/heads/candidate-revised',f.revisedResult.base_commit]);}return fs.open(...args);};
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec,{fs:port}));
  assert.equal((await fs.lstat(f.spec.output_dir)).isDirectory(),true);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('50 changed union paths fit the private inventory bound',async()=>{const f=await fixture(45);try{const b=await buildProjectRevisionReviewPackage(f.spec);assert.equal(b.base_to_revised_count,49);assert.equal(b.original_to_revised_count,3);assert.equal((await verifyProjectRevisionReviewPackage(f.spec.output_dir)).manifest_sha256,b.manifest_sha256);}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('nested accessor inputs reject before invoking caller code',async()=>{const f=await fixture();try{
  let calls=0;const pkg={manifest_sha256:f.p1.manifest_sha256};Object.defineProperty(pkg,'dir',{enumerable:true,get(){calls++;return f.spec.original_package.dir;}});
  await fail('INVALID_PROJECT_REVISION_REVIEW_SPEC',()=>buildProjectRevisionReviewPackage({...f.spec,original_package:pkg}));
  assert.equal(calls,0);await assert.rejects(fs.lstat(f.spec.output_dir),{code:'ENOENT'});
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('exact base executable restoration is reviewable; changed executable rejects',async()=>{const good=await fixture(0,true);try{
  const b=await buildProjectRevisionReviewPackage(good.spec);const m=JSON.parse(await fs.readFile(join(good.spec.output_dir,'revision-review-manifest.json')));
  const row=m.original_to_revised.find(x=>x.path==='src/restore.mjs');assert.equal(row.classification,'RESTORED_BASE');assert.equal(row.new.mode,'100755');
  assert.equal((await verifyProjectRevisionReviewPackage(good.spec.output_dir)).manifest_sha256,b.manifest_sha256);
}finally{await fs.rm(good.root,{recursive:true,force:true});}
  const bad=await fixture(0,true,true);try{await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(bad.spec));
    await assert.rejects(fs.lstat(bad.spec.output_dir),{code:'ENOENT'});
  }finally{await fs.rm(bad.root,{recursive:true,force:true});}});
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
async function replacePrivate(path,bytes){await fs.chmod(path,0o600);await fs.writeFile(path,bytes);await fs.chmod(path,0o400);}
test('malformed prior decision rejects even when its declared digest matches',async()=>{for(const edit of [
  d=>{d.review_package_sha256='f'.repeat(64);},
  d=>{d.attestations=[{path:'src/app.mjs',old_sha256:null,new_sha256:'f'.repeat(64),binary_inspected:false}];},
  d=>{d.choice='ACCEPT';}
]){const f=await fixture();try{const path=join(f.spec.prior_decisions[0].dir,'decision.json');const d=JSON.parse(await fs.readFile(path));edit(d);const bytes=Buffer.from(JSON.stringify(canonical(d)));await replacePrivate(path,bytes);f.spec.prior_decisions[0].file_sha256=sha(bytes);await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec));await assert.rejects(fs.lstat(f.spec.output_dir),{code:'ENOENT'});}finally{await fs.rm(f.root,{recursive:true,force:true});}}});
test('offline verifier rejects malformed over-profile metadata and display bytes',async()=>{for(const edit of [
  m=>{m.paths.push(...Array.from({length:51},(_,i)=>({...m.paths[0],path:`overflow-${i}.txt`})));},
  m=>{m.paths[0].revised.bytes=4*1024*1024+1;},
  m=>{m.displays.base_to_revised.bytes=8*1024*1024+1;},
  m=>{m.limits.max_copies=12*1024*1024+1;}
]){const f=await fixture();try{await buildProjectRevisionReviewPackage(f.spec);const path=join(f.spec.output_dir,'revision-review-manifest.json');const m=JSON.parse(await fs.readFile(path));edit(m);await replacePrivate(path,Buffer.from(JSON.stringify(canonical(m))));await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>verifyProjectRevisionReviewPackage(f.spec.output_dir));}finally{await fs.rm(f.root,{recursive:true,force:true});}}});
test('oversized manifest and complete display reject offline',async()=>{for(const leaf of ['revision-review-manifest.json','base-to-revised.diff.txt','original-to-revised.diff.txt']){const f=await fixture();try{await buildProjectRevisionReviewPackage(f.spec);const max=leaf.includes('manifest')?512*1024:8*1024*1024;await replacePrivate(join(f.spec.output_dir,leaf),Buffer.alloc(max+1,0x61));await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>verifyProjectRevisionReviewPackage(f.spec.output_dir));}finally{await fs.rm(f.root,{recursive:true,force:true});}}});
test('readback uncertainty retains partial output and public status projects no private content',async()=>{const f=await fixture();try{
  const names=['lstat','realpath','mkdir','open','chmod','opendir'];const port=Object.fromEntries(names.map(k=>[k,(...args)=>fs[k](...args)]));let fault=false;
  port.open=async(...args)=>{if(!fault&&args[0].endsWith('revision-review-manifest.json')&&(args[1]&3)===0&&await fs.stat(f.spec.output_dir).then(()=>true,()=>false)){fault=true;throw new Error('unknown readback');}return fs.open(...args);};
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec,{fs:port}));assert.equal((await fs.lstat(f.spec.output_dir)).isDirectory(),true);
  const f2=await fixture();try{const result=await buildProjectRevisionReviewPackage(f2.spec);const publicText=JSON.stringify(result);for(const privateValue of [f2.root,'src/app.mjs','revised\\n','assets/icon.bin'])assert.equal(publicText.includes(privateValue),false);}finally{await fs.rm(f2.root,{recursive:true,force:true});}
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('unknown Git subprocess settlement withholds package success',async()=>{const f=await fixture();try{
  const real=childProcess.spawn;childProcess.spawn=()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;queueMicrotask(()=>{child.stdout.end();child.stderr.end();child.emit('close',null,'SIGKILL');});return child;};syncBuiltinESMExports();
  try{await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec));}
  finally{childProcess.spawn=real;syncBuiltinESMExports();}
  await assert.rejects(fs.lstat(f.spec.output_dir),{code:'ENOENT'});
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
async function bulkFixture(){const root=await fs.mkdtemp(join(tmpdir(),'squire-p1b-bulk-'));await fs.chmod(root,0o700);
  const base=join(root,'base.git'),original=join(root,'original.git'),revised=join(root,'revised.git');for(const dir of [base,original,revised])execFileSync(GIT,['init','--bare','--shared=0600','--quiet','--template=/dev/null',dir],{env});
  for(const dir of [original,revised])await fs.writeFile(join(dir,'objects','info','alternates'),join(base,'objects')+'\n',{mode:0o600});
  const paths=Array.from({length:8},(_,i)=>`src/bulk-${i}.bin`),data=paths.map((_,i)=>[Buffer.alloc(524288,i+1),Buffer.alloc(524288,i+10),Buffer.alloc(524288,i+20)]);
  const rows=[base,original,revised].map((dir,j)=>paths.map((path,i)=>({path,oid:blob(dir,data[i][j])})));
  const trees=rows.map((r,i)=>tree([base,original,revised][i],r));const commits=[commit(base,trees[0],null)];commits.push(commit(original,trees[1],commits[0]),commit(revised,trees[2],commits[0]));
  git(original,['update-ref','refs/heads/candidate-original',commits[1]]);git(revised,['update-ref','refs/heads/candidate-revised',commits[2]]);
  const common={base_commit:commits[0],base_tree:trees[0],receipt_sha256:'a'.repeat(64),stage_manifest_sha256:'b'.repeat(64),task_correctness:'NOT_EVALUATED',human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',benchmark_acceptance:'NOT_ESTABLISHED',origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'};
  const originalResult={...common,schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',operation_id:'original',candidate_ref:'refs/heads/candidate-original',candidate_commit:commits[1],candidate_tree:trees[1],changed_paths:paths};
  const revisedResult={...common,schema:'SQUIRE_PROJECT_REVISION_CANDIDATE_V1',status:'SOURCE_REVISION_CANDIDATE_CREATED',operation_id:'revised',candidate_ref:'refs/heads/candidate-revised',candidate_commit:commits[2],candidate_tree:trees[2],changed_paths:paths,correction_origin:'OPERATOR_SUPPLIED',revision_of:{commit:commits[1],tree:trees[1]},revised_blobs:paths.map((path,i)=>({path,previous_blob:rows[1][i].oid,previous_bytes:524288,previous_sha256:sha(data[i][1]),blob:rows[2][i].oid,bytes:524288,sha256:sha(data[i][2])}))};
  const id=async dir=>{const s=await fs.stat(dir);return {dev:s.dev,ino:s.ino};};const pkg=join(root,'p1');
  const p1=await buildProjectCandidateReviewPackage({schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1',result:originalResult,candidate_git_dir:original,candidate_git_identity:await id(original),base_git_dir:base,base_git_identity:await id(base),output_dir:pkg});
  const priorDir=join(root,'prior');const prior=await recordProjectCandidateDecision(pkg,{schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'prior',reviewer_label:'owner',review_package_sha256:p1.manifest_sha256,base_commit:commits[0],base_tree:trees[0],candidate_commit:commits[1],candidate_tree:trees[1],choice:'REVISE',attestations:[]},priorDir);
  const spec={schema:'SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1',original_result:originalResult,revised_result:revisedResult,base_git_dir:base,base_git_identity:await id(base),original_git_dir:original,original_git_identity:await id(original),revised_git_dir:revised,revised_git_identity:await id(revised),output_dir:join(root,'revision-package'),original_package:{dir:pkg,manifest_sha256:p1.manifest_sha256},prior_decisions:[{dir:priorDir,file_sha256:prior.decision_sha256}],selected_decision_id:'prior'};
  return {root,spec};}
test('exact 12 MiB three-side copy profile succeeds',async()=>{const f=await bulkFixture();try{const built=await buildProjectRevisionReviewPackage(f.spec);const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));assert.equal(m.paths.reduce((sum,row)=>sum+row.base.bytes+row.original.bytes+row.revised.bytes,0),12*1024*1024);assert.equal((await verifyProjectRevisionReviewPackage(f.spec.output_dir)).manifest_sha256,built.manifest_sha256);}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('exact 4 MiB retained base side succeeds; over-limit metadata rejects',async()=>{const f=await fixture(0,false,false,true);try{const built=await buildProjectRevisionReviewPackage(f.spec);const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));assert.equal(m.paths.find(x=>x.path==='src/app.mjs').base.bytes,4*1024*1024);assert.equal((await verifyProjectRevisionReviewPackage(f.spec.output_dir)).manifest_sha256,built.manifest_sha256);}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('valid linked revision exceeding one complete 8 MiB display rejects before output',async()=>{const f=await fixture(0,false,false,false,true);try{await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec));await assert.rejects(fs.lstat(f.spec.output_dir),{code:'ENOENT'});}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('exact 8 MiB complete display succeeds',async()=>{const f=await fixture(0,false,false,false,true,798297,'xxxxx');try{const b=await buildProjectRevisionReviewPackage(f.spec);assert.equal((await fs.stat(join(f.spec.output_dir,'base-to-revised.diff.txt'))).size,8*1024*1024);assert.equal((await verifyProjectRevisionReviewPackage(f.spec.output_dir)).manifest_sha256,b.manifest_sha256);}finally{await fs.rm(f.root,{recursive:true,force:true});}});
