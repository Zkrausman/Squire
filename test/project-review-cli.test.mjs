import test from 'node:test';
import assert from 'node:assert/strict';
import {runProjectReviewCandidateCli as run} from '../bin/squire-project-review.mjs';
const enc=new TextEncoder();
const result={schema:'SQUIRE_PROJECT_REVIEW_CANDIDATE_V1',status:'SOURCE_CANDIDATE_CREATED',
  operation_id:'private-operation',candidate_ref:'refs/heads/candidate-private-operation',
  base_commit:'1'.repeat(40),base_tree:'2'.repeat(40),candidate_commit:'3'.repeat(40),candidate_tree:'4'.repeat(40),
  receipt_sha256:'5'.repeat(64),stage_manifest_sha256:'6'.repeat(64),changed_paths:['private/source.js'],
  task_correctness:'NOT_EVALUATED',human_review:'PENDING',native_acceptance:'NOT_ESTABLISHED',
  benchmark_acceptance:'NOT_ESTABLISHED',origin_authenticity:'SUPPLIED_NOT_AUTHENTICATED',
  base_alternate_dependency:'READ_ONLY_BASE_OBJECT_ALTERNATE'};
const spec=standard=>({schema:standard?'SQUIRE_STANDARD_PROJECT_REVIEW_IMPORT_V1':'SQUIRE_PROJECT_REVIEW_IMPORT_V1',
 operation_id:'private-operation',caller_label:'private-owner',receipt_path:'/private/receipt',receipt_sha256:'5'.repeat(64),
 stage_dir:'/private/stage',stage_manifest_sha256:'6'.repeat(64),snapshot_dir:'/private/snapshot',
 base_git_dir:'/private/base',base_git_identity:{dev:1,ino:2},base_commit:'1'.repeat(40),base_tree:'2'.repeat(40),
 candidate_dir:'/private/candidate',allowed_changes:[{path:'private/source.js',original:null}]});
const revision=(standard,count=1)=>({schema:standard?'SQUIRE_STANDARD_PROJECT_REVIEW_REVISION_V1':'SQUIRE_PROJECT_REVIEW_REVISION_V1',
 original:spec(standard),prior_candidate:{},corrections:Array.from({length:count},(_,i)=>({path:`private/${i}.js`,original:null,content_path:`/private/correction-${i}`}))});
function harness(value,{size=1,fail=false}={}){
 const reads=[],routes=[],out=[],err=[],buffers=[];
 const accept=route=>async input=>{routes.push(route);buffers.push(input.receipt_bytes??input.original.receipt_bytes);
  if(input.corrections)buffers.push(...input.corrections.map(c=>c.bytes_data));
  if(fail)throw Error('PRIVATE_ERROR /private/secret');
  return route.startsWith('revise')?{...result,schema:'SQUIRE_PROJECT_REVISION_CANDIDATE_V1',status:'SOURCE_REVISION_CANDIDATE_CREATED',
   correction_origin:'OPERATOR_SUPPLIED',revision_of:{commit:'7'.repeat(40),tree:'8'.repeat(40)},
   revised_blobs:[{path:'private/source.js',previous_blob:'9'.repeat(40),previous_bytes:1,previous_sha256:'a'.repeat(64),blob:'b'.repeat(40),bytes:1,sha256:'c'.repeat(64)}]}:{...result};};
 const ports={readReceiptBytes:async(path,max)=>{reads.push([path,max]);return path==='/private/spec'?enc.encode(JSON.stringify(value)):new Uint8Array([1]);},
 readCorrectionBytes:async(path,max)=>{reads.push([path,max]);return new Uint8Array(size).fill(65);},
 build:accept('build'),revise:accept('revise'),buildStandard:accept('buildStandard'),reviseStandard:accept('reviseStandard'),
 stdout:{write:s=>out.push(s)},stderr:{write:s=>err.push(s)}};
 return {ports,reads,routes,out,err,buffers};
}
for(const [mode,route,standard,revise] of [['--build','build',false,false],['--revise','revise',false,true],
 ['--build-standard','buildStandard',true,false],['--revise-standard','reviseStandard',true,true]]){
 test(`${mode} selects only its explicit adapter and clears buffers`,async()=>{
  const h=harness(revise?revision(standard):spec(standard));
  assert.equal(await run([mode,'/private/spec'],h.ports),0);assert.deepEqual(h.routes,[route]);
  assert.equal(h.reads[0][1],65536);assert.equal(h.reads[1][1],262144);
  assert.ok(h.buffers.every(b=>b.every(v=>v===0)));
  assert.deepEqual(h.err,[]);assert.doesNotMatch(h.out.join(''),/private|source\.js|PRIVATE_ERROR/);
 });
}
test('default, malformed and help commands never read inputs or call adapters',async()=>{
 for(const args of [[],['--unknown','/private/spec'],['--build-standard','relative'],['--revise-standard'],['--help']]){
  const h=harness(spec(true));assert.equal(await run(args,h.ports),args[0]==='--help'?0:2);
  assert.deepEqual(h.reads,[]);assert.deepEqual(h.routes,[]);
  if(args[0]==='--help')assert.match(h.out.join(''),/--build-standard\|--revise-standard/);
 }
});
test('standard commands reject wrong-profile schemas before receipt or correction reads',async()=>{
 for(const [mode,value] of [['--build-standard',spec(false)],['--revise-standard',revision(false)],
 ['--revise-standard',{...revision(true),original:spec(false)}]]){
  const h=harness(value);assert.equal(await run([mode,'/private/spec'],h.ports),2);
  assert.equal(h.reads.length,1);assert.deepEqual(h.routes,[]);assert.deepEqual(h.out,[]);
 }
});
test('standard exact aggregate budget and overflow are distinct; large budget remains unchanged',async()=>{
 for(const [standard,count,code,expected] of [[true,2,0,[524288,524288]], [true,3,2,[524288,524288,0]],
 [false,3,0,[524288,524288,524288]]]){
  const h=harness(revision(standard,count),{size:524288});
  assert.equal(await run([standard?'--revise-standard':'--revise','/private/spec'],h.ports),code);
  assert.deepEqual(h.reads.slice(2).map(r=>r[1]),expected);
  assert.equal(h.routes.length,code===0?1:0);
 }
});
test('standard adapter failures expose fixed diagnostics and clear receipt/correction copies',async()=>{
 for(const revise of [false,true]){
  const h=harness(revise?revision(true):spec(true),{fail:true});
  assert.equal(await run([revise?'--revise-standard':'--build-standard','/private/spec'],h.ports),2);
  assert.deepEqual(h.err,['PROJECT_REVIEW_CANDIDATE_REJECTED\n']);assert.deepEqual(h.out,[]);
  assert.ok(h.buffers.every(b=>b.every(v=>v===0)));
 }
});
