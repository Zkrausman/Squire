import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fixture} from './helpers/revision-review-fixture.mjs';
import {buildProjectRetainedRevisionReviewSource as retain,verifyProjectRetainedRevisionReviewSource as verify,buildProjectRevisionReviewPackageFromRetainedSource as build} from '../src/project-retained-revision-review-source.mjs';
import {buildProjectRevisionReviewPackage,verifyProjectRevisionReviewPackage,recordProjectRevisionDecision,verifyProjectRevisionDecision} from '../src/project-revision-review-package.mjs';
import {recordProjectCandidateDecision} from '../src/project-candidate-review-package.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const encode=v=>Buffer.from(JSON.stringify(sorted(v)));
const req=f=>({...f.spec,schema:'SQUIRE_PROJECT_RETAINED_REVISION_SOURCE_SPEC_V1',output_dir:join(f.root,'retained')});
const buildSpec=(f,result)=>({schema:'SQUIRE_PROJECT_REVISION_REVIEW_RETAINED_SPEC_V1',retained_source_dir:join(f.root,'retained'),expected_manifest_sha256:result.manifest_sha256,output_dir:join(f.root,'handoff')});
const port=()=>Object.fromEntries(['lstat','realpath','mkdir','open','chmod','opendir'].map(k=>[k,(...args)=>fs[k](...args)]));
const reject=fn=>assert.rejects(fn,e=>/^(PROJECT_|INVALID_PROJECT_)/.test(e?.code));
async function leaves(root,prefix=''){const out={};for(const n of await fs.readdir(join(root,prefix))){const p=prefix?prefix+'/'+n:n,s=await fs.lstat(join(root,p));if(s.isDirectory())Object.assign(out,await leaves(root,p));else out[p]={sha:sha(await fs.readFile(join(root,p))),mode:s.mode&0o7777};}return out;}
async function replace(path,bytes){await fs.chmod(path,0o600);await fs.writeFile(path,bytes);await fs.chmod(path,0o400);}
async function repin(root,mutate){const path=join(root,'retained-revision-manifest.json');const m=JSON.parse(await fs.readFile(path));await mutate(m);let other=0;for(const [name] of Object.entries(await leaves(root)))if(name!=='retained-revision-manifest.json')other+=(await fs.stat(join(root,name))).size;
 for(let i=0;i<16;i++){const bytes=encode(m),total=other+bytes.length;if(total===m.retained_bytes){await replace(path,bytes);return sha(bytes);}m.retained_bytes=total;}throw Error('fixture accounting');}

test('retained source survives absent stores and yields exact V1 package with fresh bound decision',async()=>{const f=await fixture();try{
 const live=await buildProjectRevisionReviewPackage(f.spec),r=await retain(req(f)),saved=await leaves(join(f.root,'retained'));
 assert.equal(r.status,'PROJECT_RETAINED_REVISION_SOURCE_CREATED');assert.equal(r.base_to_revised_count,4);assert.equal(r.original_to_revised_count,3);assert.equal(r.union_count,5);
 for(const key of ['base_git_dir','original_git_dir','revised_git_dir'])await fs.rename(f.spec[key],f.spec[key]+'.unavailable');
 const readOnly=port();readOnly.mkdir=readOnly.chmod=()=>{throw Error('PRIVATE_WRITE');};const originalOpen=readOnly.open;readOnly.open=(path,flags,...args)=>{assert.equal(flags&3,0);assert.ok(path.startsWith(join(f.root,'retained')+'/'));return originalOpen(path,flags,...args);};
 assert.equal((await verify(join(f.root,'retained'),r.manifest_sha256,{fs:readOnly})).manifest_sha256,r.manifest_sha256);
 const built=await build(buildSpec(f,r)),pkg=join(f.root,'handoff/package');assert.equal(built.manifest_sha256,live.manifest_sha256);assert.deepEqual(await leaves(pkg),await leaves(f.spec.output_dir));
 const m=JSON.parse(await fs.readFile(join(pkg,'revision-review-manifest.json'))),receipt=JSON.parse(await fs.readFile(join(f.root,'handoff/provenance.json')));
 assert.equal(receipt.source_manifest_sha256,r.manifest_sha256);assert.equal(receipt.revision_package_manifest_sha256,live.manifest_sha256);assert.equal(sha(await fs.readFile(join(f.root,'handoff/provenance.json'))),built.provenance_sha256);
 assert.equal(m.original_to_revised.find(x=>x.path==='src/restore.mjs').classification,'RESTORED_BASE');assert.ok(!m.original_to_revised.some(x=>x.path==='src/unchanged.mjs'));
 const d={schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'fresh',reviewer_label:'synthetic',revision_package_sha256:built.manifest_sha256,original_package_sha256:m.original_package_sha256,prior_revise_decision_sha256:m.prior_revise_decision_sha256,base_commit:m.base_commit,base_tree:m.base_tree,original_commit:m.original_commit,original_tree:m.original_tree,revised_commit:m.revised_commit,revised_tree:m.revised_tree,choice:'ACCEPT',attestations:[...m.base_to_revised.map(x=>({view:'base_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required})),...m.original_to_revised.map(x=>({view:'original_to_revised',path:x.path,old_sha256:x.old?.sha256??null,new_sha256:x.new.sha256,binary_inspected:x.binary_review_required}))]};
 await reject(()=>recordProjectRevisionDecision(pkg,{...d,attestations:d.attestations.map(a=>({...a,binary_inspected:false}))},join(f.root,'bad-binary')));
 const decision=await recordProjectRevisionDecision(pkg,d,join(f.root,'decision'));assert.equal((await verifyProjectRevisionDecision(pkg,join(f.root,'decision'),decision.decision_sha256)).choice,'ACCEPT');
 assert.deepEqual(await leaves(join(f.root,'retained')),saved);assert.equal((await verifyProjectRevisionReviewPackage(pkg)).manifest_sha256,built.manifest_sha256);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('wrong expected digest and grammar reject before access/output',async()=>{let reads=0;const p=port();p.lstat=()=>{reads++;throw Error('PRIVATE');};for(const [root,h] of [['relative','a'.repeat(64)],['/selected','A'.repeat(64)],['/selected','a'.repeat(64)+'\n'],['/selected',null]])await reject(()=>verify(root,h,{fs:p}));assert.equal(reads,0);
 const f=await fixture();try{const r=await retain(req(f));await reject(()=>build({...buildSpec(f,r),expected_manifest_sha256:'f'.repeat(64)}));await assert.rejects(fs.lstat(join(f.root,'handoff')),{code:'ENOENT'});}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('strict manifest and bound fields reject even with a fresh deliberately repinned digest',async()=>{const f=await fixture();try{const r=await retain(req(f)),root=join(f.root,'retained'),path=join(root,'retained-revision-manifest.json'),original=await fs.readFile(path);
 for(const mutate of [m=>m.schema='OTHER',m=>m.extra='PRIVATE',m=>m.original_result_sha256='f'.repeat(64),m=>m.revised_result_sha256='f'.repeat(64),m=>m.endpoints.original.commit='f'.repeat(40),m=>m.receipt_sha256='f'.repeat(64),m=>m.stage_manifest_sha256='f'.repeat(64),m=>m.original_package_sha256='f'.repeat(64),m=>m.prior_revise_decision_sha256='f'.repeat(64),m=>m.declared_decisions_sha256='f'.repeat(64),m=>m.selected_decision_id='absent',m=>m.base_to_original.pop(),m=>m.base_to_revised.pop(),m=>m.original_to_revised.pop(),m=>m.files.pop(),m=>m.limits.max_objects++,m=>m.boundaries.pop(),m=>m.object_bytes++,m=>m.objects[0].sha256='f'.repeat(64),m=>m.objects[0].bytes++,m=>m.prior_decisions.push(m.prior_decisions[0])]){
  await replace(path,original);const h=await repin(root,mutate);await reject(()=>verify(root,h));}
 for(const bytes of [Buffer.concat([original,Buffer.from('\n')]),Buffer.from('{"schema":"x","schema":"y"}'),Buffer.from([255]),Buffer.alloc(8*1024*1024+1,32)]){await replace(path,bytes);await reject(()=>verify(root,sha(bytes)));}
 await replace(path,original);assert.equal((await verify(root,r.manifest_sha256)).manifest_sha256,r.manifest_sha256);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('objects, result bodies, selected decision and exact directory closure reject corruption',async()=>{const f=await fixture();try{const r=await retain(req(f)),root=join(f.root,'retained'),m=JSON.parse(await fs.readFile(join(root,'retained-revision-manifest.json')));
 for(const rel of ['results/original.json','results/revised.json','prior-decisions/prior/decision.json','original-package/review-manifest.json',...m.objects.slice(0,2).map(o=>'objects/'+o.git_sha1.slice(0,2)+'/'+o.git_sha1.slice(2))]){const path=join(root,rel),saved=await fs.readFile(path);await replace(path,Buffer.from('PRIVATE_CORRUPTION'));await reject(()=>verify(root,r.manifest_sha256));await replace(path,saved);}
 await fs.mkdir(join(root,'extra'),{mode:0o700});await reject(()=>verify(root,r.manifest_sha256));await fs.rmdir(join(root,'extra'));
 await fs.writeFile(join(root,'extra'),'',{mode:0o400});await reject(()=>verify(root,r.manifest_sha256));await fs.unlink(join(root,'extra'));
 const path=join(root,'results/original.json');await fs.chmod(path,0o600);await reject(()=>verify(root,r.manifest_sha256));await fs.chmod(path,0o400);
 await fs.rename(path,path+'.saved');await fs.symlink(path+'.saved',path);await reject(()=>verify(root,r.manifest_sha256));await fs.unlink(path);await fs.rename(path+'.saved',path);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('source and prior conflict failures occur before reservation',async()=>{for(const mutate of [f=>{f.spec.revised_git_identity.ino++;},f=>{f.spec.revised_result={...f.revisedResult,receipt_sha256:'f'.repeat(64)};},f=>{f.spec.selected_decision_id='absent';},f=>{f.spec.prior_decisions[0].file_sha256='f'.repeat(64);},async f=>{const m=JSON.parse(await fs.readFile(join(f.spec.original_package.dir,'review-manifest.json')));const d=await recordProjectCandidateDecision(f.spec.original_package.dir,{schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'conflict',reviewer_label:'test',review_package_sha256:f.p1.manifest_sha256,base_commit:m.base_commit,base_tree:m.base_tree,candidate_commit:m.candidate_commit,candidate_tree:m.candidate_tree,choice:'REJECT',attestations:[]},join(f.root,'conflict'));f.spec.prior_decisions.push({dir:join(f.root,'conflict'),file_sha256:d.decision_sha256});}]){
 const f=await fixture();try{await mutate(f);await reject(()=>retain(req(f)));await assert.rejects(fs.lstat(join(f.root,'retained')),{code:'ENOENT'});}finally{await fs.rm(f.root,{recursive:true,force:true});}}});
test('50-path union and maximum escaped-note prior remains consumable',async()=>{const f=await fixture(45);try{const pm=JSON.parse(await fs.readFile(join(f.spec.original_package.dir,'review-manifest.json'))),d=await recordProjectCandidateDecision(f.spec.original_package.dir,{schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'full',reviewer_label:'test',review_package_sha256:f.p1.manifest_sha256,base_commit:pm.base_commit,base_tree:pm.base_tree,candidate_commit:pm.candidate_commit,candidate_tree:pm.candidate_tree,choice:'REVISE',attestations:pm.paths.map(r=>({path:r.path,old_sha256:r.old?.sha256??null,new_sha256:r.new.sha256,binary_inspected:r.binary_review_required})),note:'\0'.repeat(4096)},join(f.root,'full'));
 f.spec.prior_decisions=[{dir:join(f.root,'full'),file_sha256:d.decision_sha256}];f.spec.selected_decision_id='full';const r=await retain(req(f));assert.equal(r.union_count,50);const built=await build(buildSpec(f,r));assert.equal(built.union_count,50);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('cancel, create-exclusive and write-close failures preserve partial outputs without retry',async()=>{const f=await fixture();try{const c=new AbortController();c.abort();await assert.rejects(()=>retain({...req(f),signal:c.signal}),e=>e.code==='PROJECT_RETAINED_REVISION_SOURCE_ABORTED');await assert.rejects(fs.lstat(join(f.root,'retained')),{code:'ENOENT'});
 const p=port(),open=p.open;let writes=0;p.open=async(...args)=>{const h=await open(...args);if(args[1]&1){writes++;return {stat:(...a)=>h.stat(...a),writeFile:(...a)=>h.writeFile(...a),close:async()=>{await h.close();throw Error('PRIVATE_CLOSE');}};}return h;};await reject(()=>retain(req(f),{fs:p}));assert.equal(writes,1);assert.ok((await fs.lstat(join(f.root,'retained'))).isDirectory());await reject(()=>retain(req(f)));
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('retained-byte mutation at read-close is rejected and handles close',async()=>{const f=await fixture();try{const r=await retain(req(f)),p=port(),open=p.open;let changed=false,closed=0;
 p.open=async(...args)=>{const h=await open(...args);if(args[0].endsWith('results/original.json')&&!changed){changed=true;return {stat:(...a)=>h.stat(...a),read:(...a)=>h.read(...a),close:async()=>{await h.close();closed++;await replace(args[0],Buffer.from('PRIVATE_CHANGE'));}};}return h;};await reject(()=>verify(join(f.root,'retained'),r.manifest_sha256,{fs:p}));assert.equal(closed,1);
}finally{await fs.rm(f.root,{recursive:true,force:true});}});

test('a valid partial original package is not accepted as complete original change evidence',async()=>{const f=await fixture();try{
 const root=f.spec.original_package.dir,mp=join(root,'review-manifest.json'),m=JSON.parse(await fs.readFile(mp)),removed=m.paths.shift();m.changed_paths.shift();
 for(const k of ['old','new'])if(removed[k])await fs.unlink(join(root,`changes/${removed.path}.${k}`));await fs.rmdir(join(root,'changes/assets'));
 const dp=join(root,'diff.txt'),diff=await fs.readFile(dp,'utf8'),start=diff.indexOf('path '+JSON.stringify(removed.path)+'\n'),end=diff.indexOf('path ',start+5),next=Buffer.from(diff.slice(0,start)+diff.slice(end));m.diff={bytes:next.length,sha256:sha(next)};await replace(dp,next);const mb=encode(m);await replace(mp,mb);f.spec.original_package.manifest_sha256=sha(mb);
 const {verifyProjectCandidateReviewPackage}=await import('../src/project-candidate-review-package.mjs');assert.equal((await verifyProjectCandidateReviewPackage(root)).changed_path_count,4);
 const d=await recordProjectCandidateDecision(root,{schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'partial',reviewer_label:'test',review_package_sha256:sha(mb),base_commit:m.base_commit,base_tree:m.base_tree,candidate_commit:m.candidate_commit,candidate_tree:m.candidate_tree,choice:'REVISE',attestations:[]},join(f.root,'partial-prior'));
 f.spec.prior_decisions=[{dir:join(f.root,'partial-prior'),file_sha256:d.decision_sha256}];f.spec.selected_decision_id='partial';await reject(()=>retain(req(f)));await assert.rejects(fs.lstat(join(f.root,'retained')),{code:'ENOENT'});
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('full fifty plus fifty views and one-over record/result/decision limits fail closed',async()=>{const f=await fixture(45,false,false,false,false,900000,'',true);try{
 const r=await retain(req(f)),root=join(f.root,'retained'),mp=join(root,'retained-revision-manifest.json'),mb=await fs.readFile(mp);assert.equal(r.base_to_revised_count,50);assert.equal(r.original_to_revised_count,50);assert.equal((await build(buildSpec(f,r))).union_count,50);
 for(const mutate of [m=>m.objects=Array.from({length:8193},()=>m.objects[0]),m=>m.prior_decisions=Array.from({length:9},()=>m.prior_decisions[0]),m=>m.files=Array.from({length:51},()=>m.files[0])]){await replace(mp,mb);const h=await repin(root,mutate);await reject(()=>verify(root,h));}
 await replace(mp,mb);
 for(const [name,max] of [['results/original.json',262144],['prior-decisions/prior/decision.json',98304]]){const path=join(root,name),b=await fs.readFile(path);await replace(path,Buffer.alloc(max+1,32));const h=await repin(root,()=>{});await reject(()=>verify(root,h));await replace(path,b);await replace(mp,mb);}
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('actual CLI retains, verifies and builds only synthetic evidence; failed acknowledgement preserves output',async()=>{const f=await fixture();try{
 const {artifactCliChild}=await import('./helpers/artifact-cli-child.mjs'),cli=new URL('../bin/squire-candidate-review.mjs',import.meta.url),specPath=join(f.root,'retain-spec.json');await fs.writeFile(specPath,encode(req(f)),{mode:0o400});
 const a=await artifactCliChild(cli,['--retain-revision-source',specPath]);assert.equal(a.code,0,a.stderr);const root=join(f.root,'retained'),manifest=sha(await fs.readFile(join(root,'retained-revision-manifest.json')));assert.match(a.stdout,/PROJECT_RETAINED_REVISION_SOURCE_CREATED/);const saved=await leaves(root);
 for(const key of ['base_git_dir','original_git_dir','revised_git_dir'])await fs.rename(f.spec[key],f.spec[key]+'.gone');
 const b=await artifactCliChild(cli,['--verify-retained-revision-source',root,manifest]);assert.equal(b.code,0,b.stderr);assert.match(b.stdout,/PROJECT_RETAINED_REVISION_SOURCE_VERIFIED/);
 const bp=join(f.root,'build-spec.json');await fs.writeFile(bp,encode(buildSpec(f,{manifest_sha256:manifest})),{mode:0o400});const c=await artifactCliChild(cli,['--build-revision-from-retained',bp],{closed:'stdout'});assert.equal(c.code,2);assert.equal(c.stderr,'');assert.equal(c.stdout,'');assert.ok((await verifyProjectRevisionReviewPackage(join(f.root,'handoff/package'))).manifest_sha256);assert.deepEqual(await leaves(root),saved);
 const again=await artifactCliChild(cli,['--build-revision-from-retained',bp]);assert.equal(again.code,2);assert.equal(again.stdout,'');assert.equal(again.stderr,'PROJECT_RETAINED_REVISION_SOURCE_REJECTED\n');
}finally{await fs.rm(f.root,{recursive:true,force:true});}});

test('a different valid retained artifact requires its own caller-retained digest',async()=>{const a=await fixture(),b=await fixture(0,false,false,true);try{
 const ar=await retain(req(a)),br=await retain(req(b));assert.notEqual(ar.manifest_sha256,br.manifest_sha256);assert.equal((await verify(join(b.root,'retained'),br.manifest_sha256)).manifest_sha256,br.manifest_sha256);await reject(()=>verify(join(b.root,'retained'),ar.manifest_sha256));
}finally{await fs.rm(a.root,{recursive:true,force:true});await fs.rm(b.root,{recursive:true,force:true});}});
test('valid substituted package cannot receive the source-pinned provenance',async()=>{const a=await fixture(),b=await fixture(0,false,false,true);try{
 const retained=await retain(req(a)),other=await buildProjectRevisionReviewPackage(b.spec),p=port(),open=p.open;let replaced=false;
 p.open=async(...args)=>{if(!replaced&&args[0]===join(a.root,'handoff/package/revision-review-manifest.json')&&(args[1]&3)===0){replaced=true;const target=join(a.root,'handoff/package');await fs.rm(target,{recursive:true});await fs.cp(b.spec.output_dir,target,{recursive:true});}return open(...args);};
 await reject(()=>build(buildSpec(a,retained),{fs:p}));assert.ok(replaced);assert.equal((await verifyProjectRevisionReviewPackage(join(a.root,'handoff/package'))).manifest_sha256,other.manifest_sha256);await assert.rejects(fs.lstat(join(a.root,'handoff/provenance.json')),{code:'ENOENT'});
}finally{await fs.rm(a.root,{recursive:true,force:true});await fs.rm(b.root,{recursive:true,force:true});}});

test('manifest prior decision ID must equal its path and actual copied record ID',async()=>{const f=await fixture();try{
 const r=await retain(req(f)),root=join(f.root,'retained');await fs.rename(join(root,'prior-decisions/prior'),join(root,'prior-decisions/renamed'));
 const expected=await repin(root,m=>{m.prior_decisions[0].decision_id='renamed';});await reject(()=>verify(root,expected));
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
test('output root replacement during final inventory cannot inherit original container acknowledgement',async()=>{const f=await fixture();try{
 const r=await retain(req(f)),p=port(),openDir=p.opendir,output=join(f.root,'handoff');let replaced=false;
 p.opendir=async(path,...args)=>{if(path===output&&!replaced){replaced=true;await fs.rename(output,output+'.original');await fs.cp(output+'.original',output,{recursive:true});}return openDir(path,...args);};
 await reject(()=>build(buildSpec(f,r),{fs:p}));assert.ok(replaced);assert.ok((await fs.lstat(output+'.original')).isDirectory());assert.ok((await fs.lstat(output)).isDirectory());
}finally{await fs.rm(f.root,{recursive:true,force:true});}});
