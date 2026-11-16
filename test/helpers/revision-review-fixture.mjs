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
import {buildProjectCandidateReviewPackage,recordProjectCandidateDecision} from '../../src/project-candidate-review-package.mjs';
import {buildProjectRevisionReviewPackage,verifyProjectRevisionReviewPackage,recordProjectRevisionDecision,verifyProjectRevisionDecision} from '../../src/project-revision-review-package.mjs';
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

export {fixture,git,sha,tree,blob,commit,GIT,env};
