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
async function fixture(extraPaths=0,executableRestore=false,badExecutableRestore=false,largeBaseApp=false,largeDisplay=false,displayBaseLines=900000,displayTail="",maxViews=false){const root=await fs.mkdtemp(join(tmpdir(),'squire-p1b-'));await fs.chmod(root,0o700);const base=join(root,'base.git'),original=join(root,'original.git'),revised=join(root,'revised.git');for(const dir of [base,original,revised])execFileSync(GIT,['init','--bare','--shared=0600','--quiet','--template=/dev/null',dir],{env});
  const b={app:largeDisplay?Buffer.concat([Buffer.alloc(displayBaseLines,10),Buffer.from(displayTail)]):largeBaseApp?Buffer.alloc(4*1024*1024,0):Buffer.from('base\n'),restore:Buffer.from('base restore\n'),unchanged:Buffer.from('base unchanged\n')};
  const o={app:Buffer.from('original\n'),restore:Buffer.from('original restore\n'),unchanged:Buffer.from('original unchanged\n'),bin:Buffer.from([0,255,1])};
  const r={app:largeDisplay?Buffer.alloc(400000,10):Buffer.from('revised\n'),restore:maxViews?Buffer.from('revised restore\n'):b.restore,unchanged:maxViews?Buffer.from('revised unchanged\n'):o.unchanged,bin:Buffer.from([0,255,2]),added:Buffer.from('added\n')};
  const extraPath=i=>maxViews?`docs/${Array(5).fill('x'.repeat(42)).join('/')}/${'z'.repeat(34)}${String(i).padStart(2,'0')}`:`docs/extra-${String(i).padStart(2,'0')}.md`;
  const baseRows=[{path:'src/app.mjs',oid:blob(base,b.app)},{path:'src/restore.mjs',mode:executableRestore?'100755':'100644',oid:blob(base,b.restore)},{path:'src/unchanged.mjs',oid:blob(base,b.unchanged)}];
  const baseTree=tree(base,baseRows),baseCommit=commit(base,baseTree);
  for(const dir of [original,revised])await fs.writeFile(join(dir,'objects','info','alternates'),join(base,'objects')+'\n',{mode:0o600});
  const origRows=[{path:'src/app.mjs',oid:blob(original,o.app)},{path:'src/restore.mjs',oid:blob(original,o.restore)},{path:'src/unchanged.mjs',oid:blob(original,o.unchanged)},{path:'assets/icon.bin',oid:blob(original,o.bin)},{path:'docs/added.md',oid:blob(original,r.added)}];
  for(let i=0;i<extraPaths;i++)origRows.push({path:extraPath(i),oid:blob(original,Buffer.from(`extra ${i}\n`))});
  const originalTree=tree(original,origRows),originalCommit=commit(original,originalTree,baseCommit);git(original,['update-ref','refs/heads/candidate-original',originalCommit]);
  const revRows=[{path:'src/app.mjs',oid:blob(revised,r.app)},{path:'src/restore.mjs',mode:executableRestore?'100755':'100644',oid:maxViews?blob(revised,r.restore):badExecutableRestore?blob(revised,Buffer.from('wrong executable\n')):baseRows[1].oid},{path:'src/unchanged.mjs',oid:blob(revised,r.unchanged)},{path:'assets/icon.bin',oid:blob(revised,r.bin)},{path:'docs/added.md',oid:blob(revised,maxViews?Buffer.from('revised added\n'):r.added)}];
  for(let i=0;i<extraPaths;i++)revRows.push({path:extraPath(i),oid:blob(revised,Buffer.from(`${maxViews?'revised ':''}extra ${i}\n`))});
  const revisedTree=tree(revised,revRows),revisedCommit=commit(revised,revisedTree,baseCommit);git(revised,['update-ref','refs/heads/candidate-revised',revisedCommit]);
  const common={base_commit:baseCommit,base_tree:baseTree,receipt_sha256:'a'.repeat(64),stage_manifest_sha256:'b'.repeat(64),task_correctness:'NOT_EVALUATED',human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',benchmark_acceptance:'NOT_ESTABLISHED',origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'};
  const originalResult={schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',operation_id:'original',candidate_ref:'refs/heads/candidate-original',candidate_commit:originalCommit,candidate_tree:originalTree,changed_paths:['assets/icon.bin','docs/added.md',...Array.from({length:extraPaths},(_,i)=>extraPath(i)),'src/app.mjs','src/restore.mjs','src/unchanged.mjs'],...common};
  const witness=(path,oldData,newData,oldOid,newOid)=>({path,previous_blob:oldOid,previous_bytes:oldData.length,previous_sha256:sha(oldData),blob:newOid,bytes:newData.length,sha256:sha(newData)});
  const extraWitnesses=maxViews?[
    witness('docs/added.md',r.added,Buffer.from('revised added\n'),origRows[4].oid,revRows[4].oid),
    ...Array.from({length:extraPaths},(_,i)=>{const path=extraPath(i);return witness(path,Buffer.from(`extra ${i}\n`),Buffer.from(`revised extra ${i}\n`),origRows[5+i].oid,revRows[5+i].oid);})
  ]:[];
  const revisedResult={...originalResult,schema:'SQUIRE_PROJECT_REVISION_CANDIDATE_V1',status:'SOURCE_REVISION_CANDIDATE_CREATED',operation_id:'revised',candidate_ref:'refs/heads/candidate-revised',candidate_commit:revisedCommit,candidate_tree:revisedTree,changed_paths:['assets/icon.bin','docs/added.md',...Array.from({length:extraPaths},(_,i)=>extraPath(i)),'src/app.mjs',...(maxViews?['src/restore.mjs']:[]),'src/unchanged.mjs'],correction_origin:'OPERATOR_SUPPLIED',revision_of:{commit:originalCommit,tree:originalTree},revised_blobs:[witness('assets/icon.bin',o.bin,r.bin,origRows[3].oid,revRows[3].oid),...extraWitnesses,witness('src/app.mjs',o.app,r.app,origRows[0].oid,revRows[0].oid),witness('src/restore.mjs',o.restore,badExecutableRestore?Buffer.from('wrong executable\n'):r.restore,origRows[1].oid,revRows[1].oid),...(maxViews?[witness('src/unchanged.mjs',o.unchanged,r.unchanged,origRows[2].oid,revRows[2].oid)]:[])]};
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
test('a valid full P1 REVISE decision with escaped note remains consumable by P1b',async()=>{const f=await fixture(45);try{
  const pm=JSON.parse(await fs.readFile(join(f.spec.original_package.dir,'review-manifest.json')));
  assert.equal(pm.paths.length,50);
  const attestations=pm.paths.map(x=>({path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required}));
  const dir=join(f.root,'full-prior');
  const d=await recordProjectCandidateDecision(f.spec.original_package.dir,{schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'fullprior',reviewer_label:'owner',review_package_sha256:f.p1.manifest_sha256,base_commit:pm.base_commit,base_tree:pm.base_tree,candidate_commit:pm.candidate_commit,candidate_tree:pm.candidate_tree,choice:'REVISE',attestations,note:'\u0000'.repeat(4096)},dir);
  assert.ok((await fs.stat(join(dir,'decision.json'))).size>16384);
  f.spec.prior_decisions=[{dir,file_sha256:d.decision_sha256}];f.spec.selected_decision_id='fullprior';
  const built=await buildProjectRevisionReviewPackage(f.spec);
  assert.equal((await verifyProjectRevisionReviewPackage(f.spec.output_dir)).manifest_sha256,built.manifest_sha256);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('a valid two-view revised ACCEPT with escaped note verifies after write',async()=>{const f=await fixture(45);try{
  const built=await buildProjectRevisionReviewPackage(f.spec);
  const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));
  const attestations=[...m.base_to_revised.map(x=>({view:'base_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required})),...m.original_to_revised.map(x=>({view:'original_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required}))];
  assert.equal(attestations.length,52);
  const dir=join(f.root,'full-revised');
  const d={schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'fullrevised',reviewer_label:'owner',revision_package_sha256:built.manifest_sha256,original_package_sha256:f.p1.manifest_sha256,prior_revise_decision_sha256:f.prior.decision_sha256,base_commit:m.base_commit,base_tree:m.base_tree,original_commit:m.original_commit,original_tree:m.original_tree,revised_commit:m.revised_commit,revised_tree:m.revised_tree,choice:'ACCEPT',attestations,note:'\u0000'.repeat(4096)};
  const recorded=await recordProjectRevisionDecision(f.spec.output_dir,d,dir);
  assert.ok((await fs.stat(join(dir,'decision.json'))).size>16384);
  assert.equal((await verifyProjectRevisionDecision(f.spec.output_dir,dir,recorded.decision_sha256)).choice,'ACCEPT');
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>verifyProjectRevisionDecision(f.spec.output_dir,dir,'0'.repeat(64)));
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('structural and note overflow reject before reserving either decision destination',async()=>{const f=await fixture(45);try{
  const pm=JSON.parse(await fs.readFile(join(f.spec.original_package.dir,'review-manifest.json')));
  const prior={schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'overflow',reviewer_label:'owner',review_package_sha256:f.p1.manifest_sha256,base_commit:pm.base_commit,base_tree:pm.base_tree,candidate_commit:pm.candidate_commit,candidate_tree:pm.candidate_tree,choice:'REVISE',attestations:pm.paths.map(x=>({path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:false}))};
  for(const [name,decision] of [['p1-count',{...prior,attestations:[...prior.attestations,prior.attestations[0]]}],['p1-note',{...prior,note:'x'.repeat(4097)}]]){
    const dir=join(f.root,name);await fail('INVALID_PROJECT_CANDIDATE_REVIEW_SPEC',()=>recordProjectCandidateDecision(f.spec.original_package.dir,decision,dir));await assert.rejects(fs.lstat(dir),{code:'ENOENT'});
  }
  const built=await buildProjectRevisionReviewPackage(f.spec);const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));
  const revised={schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'overflow',reviewer_label:'owner',revision_package_sha256:built.manifest_sha256,original_package_sha256:f.p1.manifest_sha256,prior_revise_decision_sha256:f.prior.decision_sha256,base_commit:m.base_commit,base_tree:m.base_tree,original_commit:m.original_commit,original_tree:m.original_tree,revised_commit:m.revised_commit,revised_tree:m.revised_tree,choice:'REVISE',attestations:[]};
  const rows=[...m.base_to_revised.map(x=>({view:'base_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:false})),...m.original_to_revised.map(x=>({view:'original_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:false}))];
  for(const [name,decision] of [['p1b-count',{...revised,attestations:Array.from({length:101},(_,i)=>rows[i%rows.length])}],['p1b-note',{...revised,note:'x'.repeat(4097)}]]){
    const dir=join(f.root,name);await fail('INVALID_PROJECT_REVISION_REVIEW_SPEC',()=>recordProjectRevisionDecision(f.spec.output_dir,decision,dir));await assert.rejects(fs.lstat(dir),{code:'ENOENT'});
  }
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('oversized externally modified prior decision rejects before revision output',async()=>{const f=await fixture();try{
  const leaf=join(f.spec.prior_decisions[0].dir,'decision.json');await fs.chmod(leaf,0o600);await fs.writeFile(leaf,Buffer.alloc(96*1024+1,0x78));await fs.chmod(leaf,0o400);
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>buildProjectRevisionReviewPackage(f.spec));
  await assert.rejects(fs.lstat(f.spec.output_dir),{code:'ENOENT'});
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('oversized externally modified revised decision rejects offline verification',async()=>{const f=await fixture();try{
  const built=await buildProjectRevisionReviewPackage(f.spec);
  const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));
  const dir=join(f.root,'modified-decision');
  const d={schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'modified',reviewer_label:'owner',revision_package_sha256:built.manifest_sha256,original_package_sha256:f.p1.manifest_sha256,prior_revise_decision_sha256:f.prior.decision_sha256,base_commit:m.base_commit,base_tree:m.base_tree,original_commit:m.original_commit,original_tree:m.original_tree,revised_commit:m.revised_commit,revised_tree:m.revised_tree,choice:'REVISE',attestations:[]};
  const recorded=await recordProjectRevisionDecision(f.spec.output_dir,d,dir);
  const leaf=join(dir,'decision.json');await fs.chmod(leaf,0o600);await fs.writeFile(leaf,Buffer.alloc(96*1024+1,0x78));await fs.chmod(leaf,0o400);
  await fail('PROJECT_REVISION_REVIEW_REJECTED',()=>verifyProjectRevisionDecision(f.spec.output_dir,dir,recorded.decision_sha256));
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('maximum 50 plus 50 direct-view attestations with escaped note stay readable',async()=>{const f=await fixture(45,false,false,false,false,900000,'',true);try{
  const built=await buildProjectRevisionReviewPackage(f.spec);
  assert.equal(built.base_to_revised_count,50);assert.equal(built.original_to_revised_count,50);
  const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));
  assert.equal(m.base_to_revised.filter(x=>x.path.length===256).length,45);
  const attestations=[...m.base_to_revised.map(x=>({view:'base_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required})),...m.original_to_revised.map(x=>({view:'original_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required}))];
  const dir=join(f.root,'max-decision');
  const d={schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'maximum',reviewer_label:'owner',revision_package_sha256:built.manifest_sha256,original_package_sha256:f.p1.manifest_sha256,prior_revise_decision_sha256:f.prior.decision_sha256,base_commit:m.base_commit,base_tree:m.base_tree,original_commit:m.original_commit,original_tree:m.original_tree,revised_commit:m.revised_commit,revised_tree:m.revised_tree,choice:'ACCEPT',attestations,note:'\u0000'.repeat(4096)};
  const recorded=await recordProjectRevisionDecision(f.spec.output_dir,d,dir);
  assert.ok((await fs.stat(join(dir,'decision.json'))).size<96*1024);
  assert.equal((await verifyProjectRevisionDecision(f.spec.output_dir,dir,recorded.decision_sha256)).attested_path_count,100);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
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

// New CLI fixtures use fresh disposable original/revision packages only.
const revisionCli=new URL('../bin/squire-candidate-decision.mjs',import.meta.url);
const {runCandidateDecisionCli:runRevisionCli}=await import('../bin/squire-candidate-decision.mjs');
const {artifactCliChild:revisionCliChild}=await import('./helpers/artifact-cli-child.mjs');
const {MAX_REVIEW_DECISION_BYTES:MAX_CLI_DECISION}=await import('../src/project-review-decision-limits.mjs');
async function cliDecision(f,choice='ACCEPT'){
 const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));
 return {schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'explicit-private-decision',reviewer_label:'private-owner',revision_package_sha256:sha(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json'))),original_package_sha256:f.p1.manifest_sha256,prior_revise_decision_sha256:f.prior.decision_sha256,base_commit:m.base_commit,base_tree:m.base_tree,original_commit:m.original_commit,original_tree:m.original_tree,revised_commit:m.revised_commit,revised_tree:m.revised_tree,choice,attestations:choice==='ACCEPT'?['base_to_revised','original_to_revised'].flatMap(view=>m[view].map(x=>({view,path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required}))):[],note:'PRIVATE_NOTE'};
}
async function cliRecord(f,d,name,ports={},text=JSON.stringify(d),mode='record-revision',pkg=f.spec.output_dir){
 const input=join(f.root,name+'.json'),dest=join(f.root,name);await fs.writeFile(input,text,{mode:0o600});let out='',err='';
 const code=await runRevisionCli([mode,pkg,input,dest],{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s},...ports});return {code,out,err,input,dest};
}
async function unchangedWitnesses(f){return Promise.all([join(f.spec.original_package.dir,'review-manifest.json'),join(f.spec.prior_decisions[0].dir,'decision.json'),join(f.spec.output_dir,'revision-review-manifest.json'),join(f.spec.output_dir,'base-to-revised.diff.txt'),join(f.spec.output_dir,'original-to-revised.diff.txt')].map(async p=>({p,sha:sha(await fs.readFile(p)),mode:(await fs.stat(p)).mode})));}
test('revision decision CLI records explicit three choices with two views and prior binding unchanged',async()=>{const f=await fixture();try{
 await buildProjectRevisionReviewPackage(f.spec);const before=await unchangedWitnesses(f);
 for(const choice of ['ACCEPT','REVISE','REJECT']){
  const d=await cliDecision(f,choice),r=await cliRecord(f,d,'cli-'+choice);assert.equal(r.code,0);assert.equal(r.err,'');
  const stored=JSON.parse(await fs.readFile(join(r.dest,'decision.json')));assert.equal(stored.choice,choice);assert.deepEqual(stored.attestations,d.attestations);assert.equal(stored.prior_revise_decision_sha256,f.prior.decision_sha256);
  assert.equal((await verifyProjectRevisionDecision(f.spec.output_dir,r.dest,sha(await fs.readFile(join(r.dest,'decision.json'))))).choice,choice);
  assert.doesNotMatch(r.out,/PRIVATE_NOTE|private-owner|explicit-private-decision/);
 }
 const d=await cliDecision(f);const input=join(f.root,'executable-request.json'),dest=join(f.root,'executable-decision');await fs.writeFile(input,JSON.stringify(d),{mode:0o600});
 const exe=await revisionCliChild(revisionCli,['record-revision',f.spec.output_dir,input,dest]);assert.equal(exe.code,0);assert.equal(exe.signal,null);assert.equal(exe.stderr,'');assert.match(exe.stdout,/^PROJECT_REVISION_DECISION_RECORDED/);
 assert.deepEqual(await unchangedWitnesses(f),before);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('revision decision CLI rejects cross-route requests, missing views, binary and prior/object bindings before destination',async()=>{const f=await fixture();try{
 await buildProjectRevisionReviewPackage(f.spec);const d=await cliDecision(f);const before=await unchangedWitnesses(f);
 const bad=[{...d,revision_package_sha256:'0'.repeat(64)},{...d,original_package_sha256:'0'.repeat(64)},{...d,prior_revise_decision_sha256:'0'.repeat(64)},
  {...d,original_tree:'0'.repeat(40)},{...d,revised_commit:'0'.repeat(40)},{...d,base_tree:'0'.repeat(40)},
  {...d,attestations:d.attestations.filter(a=>a.view==='base_to_revised')},{...d,attestations:d.attestations.map(a=>({...a,binary_inspected:false}))},
  {...d,attestations:d.attestations.map((a,i)=>i===0?{...a,new_sha256:'0'.repeat(64)}:a)},
  {...d,attestations:d.attestations.map((a,i)=>i===1?{...a,old_sha256:'0'.repeat(64)}:a)},
  {...d,schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1'},{...d,choice:'AUTO'},{...d,unknown:'PRIVATE'},{...d,boundaries:[]},
  {...d,attestations:Array(101).fill(d.attestations[0])},{...d,note:'x'.repeat(4097)}];
 for(let i=0;i<bad.length;i++){const r=await cliRecord(f,bad[i],'bad-cli-'+i);assert.equal(r.code,2);assert.equal(r.out,'');assert.equal(r.err,'PROJECT_REVISION_DECISION_REJECTED\n');await assert.rejects(fs.lstat(r.dest),{code:'ENOENT'});}
 const original=JSON.parse(await fs.readFile(join(f.spec.prior_decisions[0].dir,'decision.json')));delete original.boundaries;delete original.note;
 for(const [mode,pkg,request] of [['record',f.spec.output_dir,d],['record-revision',f.spec.original_package.dir,original],['record-revision',f.spec.output_dir,original],['record-revision',f.spec.original_package.dir,d]]){
  const r=await cliRecord(f,request,'cross-'+mode+'-'+(pkg===f.spec.output_dir?'rev':'orig')+'-'+(request===d?'rev':'orig'),{},JSON.stringify(request),mode,pkg);assert.equal(r.code,2);assert.equal(r.out,'');await assert.rejects(fs.lstat(r.dest),{code:'ENOENT'});
 }
 assert.deepEqual(await unchangedWitnesses(f),before);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('revision decision CLI preserves existing records and retains output on I/O or acknowledgement failure',async()=>{const f=await fixture();try{
 await buildProjectRevisionReviewPackage(f.spec);const before=await unchangedWitnesses(f),d=await cliDecision(f,'REVISE');const first=await cliRecord(f,d,'cli-prior');assert.equal(first.code,0);const saved=await fs.readFile(join(first.dest,'decision.json'));
 let err='';assert.equal(await runRevisionCli(['record-revision',f.spec.output_dir,first.input,first.dest],{stdout:{write(){throw Error('UNEXPECTED_SUCCESS');}},stderr:{write:s=>err+=s}}),2);assert.equal(err,'PROJECT_REVISION_DECISION_REJECTED\n');assert.deepEqual(await fs.readFile(join(first.dest,'decision.json')),saved);
 const reused=await cliRecord(f,{},'stored-request',{},saved);assert.equal(reused.code,2);await assert.rejects(fs.lstat(reused.dest),{code:'ENOENT'});
 let calls=0,writes=0,diagnostics=0;const sync=await cliRecord(f,d,'sync-ack',{recordRevision:async(...a)=>{calls++;return recordProjectRevisionDecision(...a);},stdout:{write(){writes++;throw Error('PRIVATE_OUTPUT');}},stderr:{write(){diagnostics++;}}});
 assert.equal(sync.code,2);assert.equal(calls,1);assert.equal(writes,1);assert.equal(diagnostics,0);assert.equal((await fs.lstat(join(sync.dest,'decision.json'))).isFile(),true);
 const target=join(f.root,'io-failure');const port=Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(k=>[k,(...a)=>fs[k](...a)]));
 port.open=async(...a)=>{const h=await fs.open(...a);if(a[0]!==join(target,'decision.json'))return h;return {stat:(...v)=>h.stat(...v),writeFile:(...v)=>h.writeFile(...v),close:async()=>{await h.close();throw Error('PRIVATE_CLOSE');}};};
 let ioCalls=0;const io=await cliRecord(f,d,'io-failure',{recordRevision:async(...a)=>{ioCalls++;return recordProjectRevisionDecision(...a,{fs:port});}});assert.equal(io.code,2);assert.equal(ioCalls,1);assert.equal(io.err,'PROJECT_REVISION_DECISION_REJECTED\n');assert.equal((await fs.lstat(join(target,'decision.json'))).isFile(),true);
 const input=join(f.root,'closed-request.json'),dest=join(f.root,'closed-ack');await fs.writeFile(input,JSON.stringify(d),{mode:0o600});const pipe=await revisionCliChild(revisionCli,['record-revision',f.spec.output_dir,input,dest],{closed:'stdout'});assert.equal(pipe.code,2);assert.equal(pipe.signal,null);assert.equal(pipe.stdout,'');assert.equal(pipe.stderr,'');assert.equal((await fs.lstat(join(dest,'decision.json'))).isFile(),true);
 assert.deepEqual(await fs.readFile(join(first.dest,'decision.json')),saved);assert.deepEqual(await unchangedWitnesses(f),before);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('revision decision CLI accepts full hundred attestations and exact request cap, rejects one over',async()=>{const f=await fixture(45,false,false,false,false,900000,'',true);try{
 await buildProjectRevisionReviewPackage(f.spec);const d=await cliDecision(f);assert.equal(d.attestations.length,100);d.note='\u0001'.repeat(4096);const raw=JSON.stringify(d);assert.ok(Buffer.byteLength(raw)<MAX_CLI_DECISION);const padded=raw+' '.repeat(MAX_CLI_DECISION-Buffer.byteLength(raw));
 const r=await cliRecord(f,d,'max-cli',{},padded);assert.equal(r.code,0);const stored=JSON.parse(await fs.readFile(join(r.dest,'decision.json')));assert.equal(stored.attestations.length,100);assert.equal(stored.note,d.note);
 const over=await cliRecord(f,d,'over-cli',{},padded+' ');assert.equal(over.code,2);await assert.rejects(fs.lstat(over.dest),{code:'ENOENT'});
}finally{await fs.rm(f.root,{recursive:true,force:true});}});

// Explicit first-revision package CLI: all stores/decisions below are fresh synthetic fixtures.
async function snapshotPrivatePackage(dir){const rows=[];async function walk(root,relative=''){for(const name of (await fs.readdir(root)).sort()){const path=join(root,name),rel=relative?relative+'/'+name:name,s=await fs.lstat(path);if(s.isDirectory())await walk(path,rel);else rows.push({path:rel,mode:s.mode,sha256:sha(await fs.readFile(path))});}}await walk(dir);return rows;}
const packageReviewCli=new URL('../bin/squire-candidate-review.mjs',import.meta.url);
const {runCandidateReviewCli:runRevisionPackageCli}=await import('../bin/squire-candidate-review.mjs');
// Keep the decision CLI helper above unchanged; package helper selects this CLI explicitly.
async function runPackage(f,spec,name,options={}){
 const input=join(f.root,name+'.json');await fs.writeFile(input,options.text??JSON.stringify(spec),{mode:0o600});let out='',err='';const code=await runRevisionPackageCli(['--build-revision',input],{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s},...options.ports});return {code,out,err,input};
}
test('first revision package CLI preserves both endpoint views and verifies without source/prior stores',async()=>{const f=await fixture();try{
 const oldPackage=await snapshotPrivatePackage(f.spec.original_package.dir),oldPrior=await snapshotPrivatePackage(f.spec.prior_decisions[0].dir);const input=join(f.root,'native-build.json');await fs.writeFile(input,JSON.stringify(f.spec),{mode:0o600});const inputBefore=await fs.readFile(input);
 const built=await revisionCliChild(packageReviewCli,['--build-revision',input]);assert.equal(built.code,0);assert.equal(built.signal,null);assert.equal(built.stderr,'');assert.match(built.stdout,/^PROJECT_REVISION_REVIEW_PACKAGE_CREATED/);assert.doesNotMatch(built.stdout,/squire-p1b|src\/restore|selected_decision|prior_revise/);
 const m=JSON.parse(await fs.readFile(join(f.spec.output_dir,'revision-review-manifest.json')));assert.equal(m.original_to_revised.find(x=>x.path==='src/restore.mjs').classification,'RESTORED_BASE');assert.equal(m.base_to_revised.some(x=>x.path==='src/restore.mjs'),false);assert.equal(m.original_to_revised.some(x=>x.path==='src/unchanged.mjs'),false);assert.equal(m.base_to_revised.some(x=>x.path==='src/unchanged.mjs'),true);assert.equal(m.prior_revise_decision_sha256,f.prior.decision_sha256);
 assert.deepEqual(await fs.readFile(input),inputBefore);assert.deepEqual(await snapshotPrivatePackage(f.spec.original_package.dir),oldPackage);assert.deepEqual(await snapshotPrivatePackage(f.spec.prior_decisions[0].dir),oldPrior);const snapshot=await snapshotPrivatePackage(f.spec.output_dir);
 for(const [i,dir] of [f.spec.base_git_dir,f.spec.original_git_dir,f.spec.revised_git_dir,f.spec.original_package.dir,...f.spec.prior_decisions.map(x=>x.dir)].entries())await fs.rename(dir,join(f.root,'unavailable-'+i));
 const verified=await revisionCliChild(packageReviewCli,['--verify-revision',f.spec.output_dir]);assert.equal(verified.code,0);assert.equal(verified.signal,null);assert.equal(verified.stderr,'');assert.match(verified.stdout,/^PROJECT_REVISION_REVIEW_PACKAGE_VERIFIED/);assert.match(verified.stdout,/Base-to-revised path count: 4\nOriginal-to-revised path count: 3/);assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),snapshot);assert.deepEqual(await snapshotPrivatePackage(join(f.root,'unavailable-4')),oldPrior);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('first revision package CLI fails closed on missing/wrong/conflicting prior and source bindings',async()=>{const f=await fixture();try{
 const pm=JSON.parse(await fs.readFile(join(f.spec.original_package.dir,'review-manifest.json'))),conflictDir=join(f.root,'conflict');const conflict=await recordProjectCandidateDecision(f.spec.original_package.dir,{schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'conflict',reviewer_label:'owner',review_package_sha256:f.p1.manifest_sha256,base_commit:pm.base_commit,base_tree:pm.base_tree,candidate_commit:pm.candidate_commit,candidate_tree:pm.candidate_tree,choice:'REJECT',attestations:[]},conflictDir);
 const missing={...f.spec};delete missing.selected_decision_id;
 const bad=[{...f.spec,selected_decision_id:'not-declared'},{...f.spec,prior_decisions:[]},missing,{...f.spec,prior_decisions:[{...f.spec.prior_decisions[0],file_sha256:'0'.repeat(64)}]},
  {...f.spec,original_package:{...f.spec.original_package,manifest_sha256:'0'.repeat(64)}},{...f.spec,prior_decisions:[...f.spec.prior_decisions,{dir:conflictDir,file_sha256:conflict.decision_sha256}]},
  {...f.spec,original_git_identity:{dev:0,ino:0}},{...f.spec,revised_result:{...f.revisedResult,candidate_commit:'0'.repeat(40)}},{...f.spec,schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1'},
  {...f.spec,revised_result:{...f.revisedResult,revision_of:{...f.revisedResult.revision_of,commit:'0'.repeat(40)}}},{...f.spec,prior_decisions:Array(9).fill(f.spec.prior_decisions[0])},{...f.spec,signal:null}];
 const oldPrior=await snapshotPrivatePackage(f.spec.prior_decisions[0].dir);
 for(let i=0;i<bad.length;i++){const spec={...bad[i],output_dir:join(f.root,'invalid-package-'+i)},r=await runPackage(f,spec,'invalid-'+i);assert.equal(r.code,2);assert.equal(r.out,'');assert.equal(r.err,'PROJECT_REVISION_REVIEW_REJECTED\n');await assert.rejects(fs.lstat(spec.output_dir),{code:'ENOENT'});}
 assert.deepEqual(await snapshotPrivatePackage(f.spec.prior_decisions[0].dir),oldPrior);const valid=await runPackage(f,f.spec,'valid');assert.equal(valid.code,0);const snapshot=await snapshotPrivatePackage(f.spec.output_dir);const existing=await runPackage(f,f.spec,'existing');assert.equal(existing.code,2);assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),snapshot);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('first revision package CLI accepts 50 plus 50 views, eight declared priors and exact 256 KiB frame',async()=>{const f=await fixture(45,false,false,false,false,900000,'',true);try{
 const pm=JSON.parse(await fs.readFile(join(f.spec.original_package.dir,'review-manifest.json')));
 for(let i=1;i<8;i++){const dir=join(f.root,'prior-'+i),d=await recordProjectCandidateDecision(f.spec.original_package.dir,{schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'prior-'+i,reviewer_label:'owner',review_package_sha256:f.p1.manifest_sha256,base_commit:pm.base_commit,base_tree:pm.base_tree,candidate_commit:pm.candidate_commit,candidate_tree:pm.candidate_tree,choice:'REVISE',attestations:[]},dir);f.spec.prior_decisions.push({dir,file_sha256:d.decision_sha256});}
 assert.equal(f.spec.prior_decisions.length,8);assert.equal(f.spec.revised_result.revised_blobs.length,50);const raw=JSON.stringify(f.spec);assert.ok(Buffer.byteLength(raw)<262144);const r=await runPackage(f,f.spec,'maximum',{text:raw+' '.repeat(262144-Buffer.byteLength(raw))});assert.equal(r.code,0);assert.equal(r.err,'');const verified=await verifyProjectRevisionReviewPackage(f.spec.output_dir);assert.equal(verified.base_to_revised_count,50);assert.equal(verified.original_to_revised_count,50);
 const input=await fs.readFile(r.input);assert.equal(input.length,262144);assert.equal(JSON.parse(input).selected_decision_id,'prior');const next={...f.spec,output_dir:join(f.root,'over-frame')},text=JSON.stringify(next);const over=await runPackage(f,next,'overflow',{text:text+' '.repeat(262145-Buffer.byteLength(text))});assert.equal(over.code,2);await assert.rejects(fs.lstat(next.output_dir),{code:'ENOENT'});
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('first revision package CLI retains partial I/O output without another build attempt',async()=>{const f=await fixture();try{
 const port=Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(k=>[k,(...a)=>fs[k](...a)]));port.open=async(...a)=>{const h=await fs.open(...a);if(a[0]!==join(f.spec.output_dir,'revision-review-manifest.json'))return h;return {stat:(...v)=>h.stat(...v),writeFile:(...v)=>h.writeFile(...v),close:async()=>{await h.close();throw Error('PRIVATE_CLOSE');}};};
 let calls=0;const r=await runPackage(f,f.spec,'io-failure',{ports:{buildRevision:async spec=>{calls++;return buildProjectRevisionReviewPackage(spec,{fs:port});}}});assert.equal(r.code,2);assert.equal(calls,1);assert.equal(r.out,'');assert.equal(r.err,'PROJECT_REVISION_REVIEW_REJECTED\n');assert.equal((await fs.lstat(join(f.spec.output_dir,'revision-review-manifest.json'))).isFile(),true);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('first revision package CLI retains complete outputs after sync or actual closed-pipe acknowledgement failure',async()=>{const f=await fixture();try{
 let calls=0,writes=0,diagnostics=0;const r=await runPackage(f,f.spec,'sync-ack',{ports:{buildRevision:async spec=>{calls++;return buildProjectRevisionReviewPackage(spec);},stdout:{write(){writes++;throw Error('PRIVATE_WRITE');}},stderr:{write(){diagnostics++;}}}});assert.equal(r.code,2);assert.equal(calls,1);assert.equal(writes,1);assert.equal(diagnostics,0);assert.equal((await verifyProjectRevisionReviewPackage(f.spec.output_dir)).status,'PROJECT_REVISION_REVIEW_PACKAGE_VERIFIED');const old=await snapshotPrivatePackage(f.spec.output_dir);
 const spec={...f.spec,output_dir:join(f.root,'closed-ack')},input=join(f.root,'closed-package.json');await fs.writeFile(input,JSON.stringify(spec),{mode:0o600});const before=await fs.readFile(input);const out=await revisionCliChild(packageReviewCli,['--build-revision',input],{closed:'stdout'});assert.equal(out.code,2);assert.equal(out.signal,null);assert.equal(out.stdout,'');assert.equal(out.stderr,'');assert.equal((await verifyProjectRevisionReviewPackage(spec.output_dir)).status,'PROJECT_REVISION_REVIEW_PACKAGE_VERIFIED');assert.deepEqual(await fs.readFile(input),before);assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),old);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});

async function verifyDecisionCli(packageDir,decisionDir,expected,ports={}){let out='',err='';const code=await runRevisionCli(['verify-revision-decision',packageDir,decisionDir,expected],{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s},...ports});return {code,out,err};}
test('selected revision decision CLI verifies each explicit choice without picking among records',async()=>{const f=await fixture();try{
 await buildProjectRevisionReviewPackage(f.spec);const records=[];
 for(const choice of ['ACCEPT','REVISE','REJECT']){const request={...await cliDecision(f,choice),decision_id:'verify-'+choice},dir=join(f.root,'selected-'+choice),result=await recordProjectRevisionDecision(f.spec.output_dir,request,dir);records.push({dir,result,choice,snapshot:await snapshotPrivatePackage(dir)});}
 const packageBefore=await snapshotPrivatePackage(f.spec.output_dir);let readCalls=0,recordCalls=0;
 for(const row of records){let verifies=0;const r=await verifyDecisionCli(f.spec.output_dir,row.dir,row.result.decision_sha256,{readBytes(){readCalls++;throw Error('UNUSED_READER');},record(){recordCalls++;throw Error('UNUSED_WRITER');},recordRevision(){recordCalls++;throw Error('UNUSED_WRITER');},verifyRevisionDecision:async(...a)=>{verifies++;return verifyProjectRevisionDecision(...a);}});assert.equal(r.code,0);assert.equal(verifies,1);assert.equal(r.err,'');assert.match(r.out,/^PROJECT_REVISION_DECISION_VERIFIED/);assert.doesNotMatch(r.out,/ACCEPT|REJECT|REVISE|private-owner|PRIVATE_NOTE|squire-p1b/);assert.deepEqual(await snapshotPrivatePackage(row.dir),row.snapshot);}
 assert.equal(readCalls,0);assert.equal(recordCalls,0);assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),packageBefore);
 for(const [i,dir] of [f.spec.base_git_dir,f.spec.original_git_dir,f.spec.revised_git_dir,f.spec.original_package.dir,...f.spec.prior_decisions.map(x=>x.dir)].entries())await fs.rename(dir,join(f.root,'unavailable-selection-'+i));
 const selected=records[2],out=await revisionCliChild(revisionCli,['verify-revision-decision',f.spec.output_dir,selected.dir,selected.result.decision_sha256]);assert.equal(out.code,0);assert.equal(out.signal,null);assert.equal(out.stderr,'');assert.match(out.stdout,/Attested path count: 0/);assert.deepEqual(await snapshotPrivatePackage(selected.dir),selected.snapshot);assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),packageBefore);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('selected revision decision CLI rejects wrong digest/package/profile and corrupt records read-only',async()=>{const f=await fixture(),other=await fixture(1);try{
 await buildProjectRevisionReviewPackage(f.spec);await buildProjectRevisionReviewPackage(other.spec);const d=await cliDecision(f,'REVISE'),dir=join(f.root,'good-selection'),recorded=await recordProjectRevisionDecision(f.spec.output_dir,d,dir);const snapshot=await snapshotPrivatePackage(dir),pkg=await snapshotPrivatePackage(f.spec.output_dir);
 for(const [packageDir,decisionDir,expected] of [[f.spec.output_dir,dir,'0'.repeat(64)],[other.spec.output_dir,dir,recorded.decision_sha256],[f.spec.output_dir,f.spec.prior_decisions[0].dir,f.prior.decision_sha256]]){
  const r=await verifyDecisionCli(packageDir,decisionDir,expected);assert.equal(r.code,2);assert.equal(r.out,'');assert.equal(r.err,'PROJECT_REVISION_DECISION_REJECTED\n');assert.deepEqual(await snapshotPrivatePackage(dir),snapshot);assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),pkg);
 }
 for(const kind of ['malformed','binding','oversize']){
  const badDir=join(f.root,'corrupt-'+kind);await recordProjectRevisionDecision(f.spec.output_dir,{...d,decision_id:'corrupt-'+kind},badDir);const file=join(badDir,'decision.json'),old=await fs.readFile(file);let bytes;
  if(kind==='malformed')bytes=Buffer.from('{');else if(kind==='oversize')bytes=Buffer.alloc(96*1024+1,0x78);else{const parsed=JSON.parse(old);parsed.prior_revise_decision_sha256='0'.repeat(64);bytes=Buffer.from(JSON.stringify(parsed));}
  await fs.chmod(file,0o600);await fs.writeFile(file,bytes);await fs.chmod(file,0o400);const badBefore=await snapshotPrivatePackage(badDir);
  const r=await verifyDecisionCli(f.spec.output_dir,badDir,sha(bytes));assert.equal(r.code,2);assert.equal(r.out,'');assert.equal(r.err,'PROJECT_REVISION_DECISION_REJECTED\n');assert.deepEqual(await snapshotPrivatePackage(badDir),badBefore);
 }
 assert.deepEqual(await snapshotPrivatePackage(dir),snapshot);assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),pkg);
}finally{await fs.rm(f.root,{recursive:true,force:true});await fs.rm(other.root,{recursive:true,force:true});}});
test('selected revision decision CLI retains accepted hundred-attestation and escaped-note profile',async()=>{const f=await fixture(45,false,false,false,false,900000,'',true);try{
 await buildProjectRevisionReviewPackage(f.spec);const d=await cliDecision(f);d.note='\u0001'.repeat(4096);assert.equal(d.attestations.length,100);const dir=join(f.root,'maximum-selection'),recorded=await recordProjectRevisionDecision(f.spec.output_dir,d,dir),before=await snapshotPrivatePackage(dir);assert.ok((await fs.stat(join(dir,'decision.json'))).size<=96*1024);
 const r=await verifyDecisionCli(f.spec.output_dir,dir,recorded.decision_sha256);assert.equal(r.code,0);assert.equal(r.err,'');assert.match(r.out,/Attested path count: 100/);assert.doesNotMatch(r.out,/PRIVATE|binary_inspected|ACCEPT/);assert.deepEqual(await snapshotPrivatePackage(dir),before);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('selected revision decision CLI output failure preserves package/record bytes and never calls a writer',async()=>{const f=await fixture();try{
 await buildProjectRevisionReviewPackage(f.spec);const dir=join(f.root,'output-selection'),recorded=await recordProjectRevisionDecision(f.spec.output_dir,await cliDecision(f,'REJECT'),dir);const before=await snapshotPrivatePackage(dir),pkg=await snapshotPrivatePackage(f.spec.output_dir);let calls=0,writes=0,diagnostics=0;
 const r=await verifyDecisionCli(f.spec.output_dir,dir,recorded.decision_sha256,{verifyRevisionDecision:async(...a)=>{calls++;return verifyProjectRevisionDecision(...a);},stdout:{write(){writes++;throw Error('PRIVATE_OUTPUT');}},stderr:{write(){diagnostics++;}},record(){throw Error('UNUSED_WRITER');},recordRevision(){throw Error('UNUSED_WRITER');}});assert.equal(r.code,2);assert.equal(calls,1);assert.equal(writes,1);assert.equal(diagnostics,0);
 const closed=await revisionCliChild(revisionCli,['verify-revision-decision',f.spec.output_dir,dir,recorded.decision_sha256],{closed:'stdout'});assert.equal(closed.code,2);assert.equal(closed.signal,null);assert.equal(closed.stdout,'');assert.equal(closed.stderr,'');
 const rejected=await revisionCliChild(revisionCli,['verify-revision-decision',f.spec.output_dir,dir,'0'.repeat(64)],{closed:'stderr'});assert.equal(rejected.code,2);assert.equal(rejected.signal,null);assert.equal(rejected.stdout,'');assert.equal(rejected.stderr,'');assert.deepEqual(await snapshotPrivatePackage(dir),before);assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),pkg);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});

test('expected manifest revision package verification binds the caller digest offline and preserves bytes on failure',async()=>{const f=await fixture();try{
 const built=await buildProjectRevisionReviewPackage(f.spec),snapshot=await snapshotPrivatePackage(f.spec.output_dir),legacy=await revisionCliChild(packageReviewCli,['--verify-revision',f.spec.output_dir]);assert.equal(legacy.code,0);
 for(const [i,dir] of [f.spec.base_git_dir,f.spec.original_git_dir,f.spec.revised_git_dir,f.spec.original_package.dir,...f.spec.prior_decisions.map(v=>v.dir)].entries())await fs.rename(dir,join(f.root,'unavailable-expected-'+i));
 const argv=['--verify-revision',f.spec.output_dir,'--expect-sha256',built.manifest_sha256],ok=await revisionCliChild(packageReviewCli,argv);assert.equal(ok.code,0);assert.equal(ok.signal,null);assert.equal(ok.stdout,legacy.stdout);assert.equal(ok.stderr,'');
 const other=await fixture(1);try{const otherBuilt=await buildProjectRevisionReviewPackage(other.spec);assert.notEqual(otherBuilt.manifest_sha256,built.manifest_sha256);const before=await snapshotPrivatePackage(other.spec.output_dir),selected=await revisionCliChild(packageReviewCli,['--verify-revision',other.spec.output_dir,'--expect-sha256',built.manifest_sha256]);assert.equal(selected.code,2);assert.equal(selected.stdout,'');assert.equal(selected.stderr,'PROJECT_REVISION_REVIEW_REJECTED\n');assert.deepEqual(await snapshotPrivatePackage(other.spec.output_dir),before);}finally{await fs.rm(other.root,{recursive:true,force:true});}
 const bad=await revisionCliChild(packageReviewCli,[...argv.slice(0,3),'0'.repeat(64)]);assert.equal(bad.code,2);assert.equal(bad.stdout,'');assert.equal(bad.stderr,'PROJECT_REVISION_REVIEW_REJECTED\n');
 for(const [args,channel] of [[argv,'stdout'],[[...argv.slice(0,3),'0'.repeat(64)],'stderr']]){const out=await revisionCliChild(packageReviewCli,args,{closed:channel});assert.equal(out.code,2);assert.equal(out.signal,null);assert.equal(out.stdout,'');assert.equal(out.stderr,'');}
 const late=await revisionCliChild(packageReviewCli,argv,{before:"const w=process.stdout.write.bind(process.stdout);process.stdout.write=(...a)=>{const v=w(...a);setImmediate(()=>process.stdout.emit('error',Error('PRIVATE_LATE_FAILURE')));return v;};"});assert.equal(late.code,2);assert.equal(late.stdout,legacy.stdout);assert.equal(late.stderr,'');assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),snapshot);
 const diff=join(f.spec.output_dir,'original-to-revised.diff.txt');await fs.chmod(diff,0o600);await fs.appendFile(diff,'synthetic corruption');await fs.chmod(diff,0o400);const corruptSnapshot=await snapshotPrivatePackage(f.spec.output_dir),corrupt=await revisionCliChild(packageReviewCli,argv);assert.equal(corrupt.code,2);assert.equal(corrupt.stdout,'');assert.equal(corrupt.stderr,'PROJECT_REVISION_REVIEW_REJECTED\n');assert.deepEqual(await snapshotPrivatePackage(f.spec.output_dir),corruptSnapshot);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
