import test from 'node:test';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
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
for(const [standard,suffix] of [[false,''],[true,'-standard']]){
 for(const [mode,kind,value] of [
  [`--build${suffix}`,'build',spec(!standard)],
  [`--revise${suffix}`,'outer revision',{...revision(!standard),original:spec(standard)}],
  [`--revise${suffix}`,'embedded original',{...revision(standard),original:spec(!standard)}]
 ]){
  test(`${mode} rejects a wrong-profile ${kind} schema before secondary reads`,async()=>{
   const h=harness(value);
   assert.equal(await run([mode,'/private/spec'],h.ports),2);
   assert.deepEqual(h.reads,[['/private/spec',65536]]);
   assert.deepEqual(h.routes,[]);assert.deepEqual(h.out,[]);
   assert.deepEqual(h.err,['PROJECT_REVIEW_CANDIDATE_REJECTED\n']);
  });
 }
}
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

test('acknowledgement project help and usage sink failures occur before input or build',async()=>{
 for(const [args,channel] of [[['--help'],'stdout'],[[],'stderr']])for(const sink of [{},{write:7},
  {write(){throw Error('PRIVATE_USAGE');}},Object.defineProperty({},'write',{get(){throw Error('PRIVATE_GETTER');}})]){
  const h=harness(spec(true));h.ports[channel]=sink;assert.equal(await run(args,h.ports),2);
  assert.deepEqual(h.reads,[]);assert.deepEqual(h.routes,[]);
 }
});
test('acknowledgement project output failure preserves simulated creation across all four modes',async()=>{
 for(const [mode,standard,revise] of [['--build',false,false],['--revise',false,true],['--build-standard',true,false],['--revise-standard',true,true]]){
  const h=harness(revise?revision(standard):spec(standard));let writes=0,diagnostics=0,partial='';
  h.ports.stdout={write(text){writes++;partial+=text.slice(0,10);throw Error('PRIVATE_CREATED_OUTPUT');}};
  h.ports.stderr={write(){diagnostics++;throw Error('PRIVATE_FALLBACK');}};
  assert.equal(await run([mode,'/private/spec'],h.ports),2);
  // The injected adapter's completed route is retained; the CLI does not run it again.
  assert.equal(h.routes.length,1);assert.equal(writes,1);assert.equal(diagnostics,0);assert.ok(partial.length>0);
  assert.ok(h.buffers.every(b=>b.every(v=>v===0)));
 }
});
test('acknowledgement project operation rejection attempts a failing diagnostic once',async()=>{
 const h=harness(spec(true),{fail:true});let calls=0;
 h.ports.stderr={write(){calls++;throw Error('PRIVATE_DIAGNOSTIC');}};
 assert.equal(await run(['--build-standard','/private/spec'],h.ports),2);assert.equal(calls,1);
 assert.equal(h.routes.length,1);assert.deepEqual(h.out,[]);assert.ok(h.buffers.every(b=>b.every(v=>v===0)));
});
test('acknowledgement project false-return sink preserves receiver and successful status',async()=>{
 const h=harness(spec(true));const out={text:'',write(text){assert.equal(this,out);this.text+=text;return false;}};
 h.ports.stdout=out;assert.equal(await run(['--build-standard','/private/spec'],h.ports),0);
 assert.match(out.text,/^SOURCE_CANDIDATE_CREATED\n/);assert.deepEqual(h.err,[]);
});

test('result destination rejects occupied leaves and malformed arguments before input reads',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'squire-result-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const occupied=join(root,'occupied'),link=join(root,'link');
 await fs.writeFile(occupied,'keep');
 await fs.symlink(join(root,'missing'),link);
 for(const tail of [['--result-file',occupied],['--result-file',link],['--result-file',root],
  ['--result-file','relative'],['--result-file'],['--other',occupied],['--result-file',occupied,'extra']]){
  const h=harness(spec(false));
  assert.equal(await run(['--build','/private/spec',...tail],h.ports),2);
  assert.deepEqual(h.reads,[]);assert.deepEqual(h.routes,[]);assert.deepEqual(h.out,[]);
 }
 assert.equal(await fs.readFile(occupied,'utf8'),'keep');
});

test('result destinations inside the base worktree, stage or prior store reject before creation',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'squire-result-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dest=join(root,'new');
 for(const [value,mode] of [
  [{...spec(true),base_git_dir:join(root,'.git')},'--build-standard'],
  [{...spec(false),stage_dir:root},'--build'],
  [{...revision(true),prior_candidate:{git_dir:root}},'--revise-standard']
 ]){
  const h=harness(value);
  assert.equal(await run([mode,'/private/spec','--result-file',dest],h.ports),2);
  assert.deepEqual(h.routes,[]);await assert.rejects(fs.stat(dest),{code:'ENOENT'});
 }
});

test('result reservation excludes a concurrent producer and reports a post-creation save failure once',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'squire-result-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dest=join(root,'result.json'),args=['--build','/private/spec','--result-file',dest];
 const h=harness(spec(false)),other=harness(spec(false)),build=h.ports.build;
 h.ports.build=async input=>{
  const created=await build(input);
  assert.equal(await run(args,other.ports),2);
  await fs.rename(dest,join(root,'reserved'));
  await fs.writeFile(dest,'preserve');
  return created;
 };
 assert.equal(await run(args,h.ports),2);
 assert.deepEqual(other.reads,[]);assert.deepEqual(other.routes,[]);
 assert.deepEqual(h.routes,['build']);assert.deepEqual(h.out,[]);
 assert.deepEqual(h.err,['PROJECT_REVIEW_CANDIDATE_CREATED_RESULT_SAVE_UNCONFIRMED\n']);
 assert.equal(await fs.readFile(dest,'utf8'),'preserve');
});

test('retention includes validated non-enumerable original and revision witness fields',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'squire-result-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const revise of [false,true]){
  const value=revise?{...revision(false),prior_candidate:{git_dir:'/private/prior'}}:spec(false);
  const h=harness(value),route=revise?'revise':'build',build=h.ports[route];
  const path=join(root,route);
  let expected;
  h.ports[route]=async spec=>{
   const returned=await build(spec);
   expected=structuredClone(returned);
   if(revise)Object.defineProperty(returned.revised_blobs[0],'previous_sha256',{enumerable:false});
   else Object.defineProperty(returned,'receipt_sha256',{enumerable:false});
   return returned;
  };
  assert.equal(await run(['--'+route,'/private/spec','--result-file',path],h.ports),0);
  assert.deepEqual(JSON.parse(await fs.readFile(path,'utf8')),expected);
 }
});
