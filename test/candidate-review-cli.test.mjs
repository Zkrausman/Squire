import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCandidateReviewCli as run} from '../bin/squire-candidate-review.mjs';
import {artifactCliChild as child} from './helpers/artifact-cli-child.mjs';
const MAX=65536,usage='Usage: node bin/squire-candidate-review.mjs <--build|--verify> <spec.json|package-dir>\n       node bin/squire-candidate-review.mjs <--build-revision|--verify-revision> <spec.json|package-dir>\n       node bin/squire-candidate-review.mjs <--verify|--verify-revision> <package-dir> --expect-sha256 <expected-manifest-sha256>\n       node bin/squire-candidate-review.mjs --build-from-snapshot <spec.json>\n       node bin/squire-candidate-review.mjs --verify-snapshot-handoff <handoff-dir> <expected-provenance-sha256>\n';
const help=usage+'       node bin/squire-candidate-review.mjs --retain-revision-source <spec.json> | --verify-retained-revision-source <source-dir> <expected-manifest-sha256> | --build-revision-from-retained <spec.json>\n';
const cli=new URL('../bin/squire-candidate-review.mjs',import.meta.url);
const encode=v=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v));
const spec=()=>({schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1',result:{base_commit:'1'.repeat(40),base_tree:'2'.repeat(40),candidate_commit:'3'.repeat(40),candidate_tree:'4'.repeat(40),changed_paths:['src/private.mjs']},candidate_git_dir:'/private/candidate.git',candidate_git_identity:{dev:1,ino:2},base_git_dir:'/private/base.git',base_git_identity:{dev:1,ino:3},output_dir:'/private/fresh-package'});
const result=(verify=false)=>({status:verify?'PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED':'PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED',manifest_sha256:'a'.repeat(64),base_commit:'1'.repeat(40),base_tree:'2'.repeat(40),candidate_commit:'3'.repeat(40),candidate_tree:'4'.repeat(40),changed_path_count:1,package_bytes:1234,private_label:'PRIVATE_LABEL'});
function harness(input=spec()){
 const reads=[],builds=[],verifies=[],out=[],err=[];
 const ports={readBytes:async(...a)=>{reads.push(a);return encode(input);},build:async s=>{builds.push(s);return result();},verify:async p=>{verifies.push(p);return result(true);},stdout:{write:s=>out.push(s)},stderr:{write:s=>err.push(s)}};
 return {ports,reads,builds,verifies,out,err};
}
test('candidate review help/default/malformed and sparse arguments cause zero reads or operations',async()=>{
 const sparse=['--build','/private/spec.json'];delete sparse[1];
 for(const argv of [[],['--help'],['--build'],['--revise','/private/spec'],['--verify','relative'],['--verify','/'],['--build','/private/../spec'],['--build','/private/\0spec'],['--verify','/private/package','extra'],sparse]){
  const h=harness();assert.equal(await run(argv,h.ports),argv[0]==='--help'?0:2);assert.deepEqual(h.reads,[]);assert.deepEqual(h.builds,[]);assert.deepEqual(h.verifies,[]);assert.equal((argv[0]==='--help'?h.out:h.err).join(''),argv[0]==='--help'?help:usage);
 }
});
test('candidate review selects exactly one API, bounded request and private validated projection',async()=>{
 for(const mode of ['--build','--verify']){
  const h=harness();assert.equal(await run([mode,'/private/input'],h.ports),0);
  assert.equal(h.builds.length,mode==='--build'?1:0);assert.equal(h.verifies.length,mode==='--verify'?1:0);
  assert.deepEqual(h.reads,mode==='--build'?[['/private/input',MAX]]:[]);
  if(mode==='--build')assert.deepEqual(JSON.parse(JSON.stringify(h.builds[0])),spec());else assert.equal(h.verifies[0],'/private/input');
  assert.equal(h.out.join(''),`${result(mode==='--verify').status}\nManifest SHA256: ${'a'.repeat(64)}\nBase commit: ${'1'.repeat(40)}\nBase tree: ${'2'.repeat(40)}\nCandidate commit: ${'3'.repeat(40)}\nCandidate tree: ${'4'.repeat(40)}\nChanged path count: 1\nPackage bytes: 1234\nCOPY_INTEGRITY_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY\n`);assert.deepEqual(h.err,[]);assert.doesNotMatch(h.out.join(''),/private|PRIVATE_LABEL/);
 }
 const h=harness();h.ports.readBytes=()=>{throw Error('UNUSED');};assert.equal(await run(['--verify','/private/package'],h.ports),0);assert.deepEqual(h.reads,[]);
});
test('candidate review strict parsing, closed JSON profile and read errors reject before build',async()=>{
 for(const input of [encode('{"schema":"x","schema":"y"}'),encode('{"schema":"x","\\u0073chema":"y"}'),new Uint8Array([255]),encode('{'),new Uint8Array(MAX+1),encode({...spec(),signal:null}),encode({...spec(),extra:'PRIVATE'}),encode({...spec(),output_dir:'relative'}),encode({...spec(),schema:'SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1'})]){
  const h=harness();h.ports.readBytes=async()=>input;assert.equal(await run(['--build','/private/spec'],h.ports),2);assert.deepEqual(h.builds,[]);assert.deepEqual(h.verifies,[]);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,['PROJECT_CANDIDATE_REVIEW_REJECTED\n']);
 }
 const h=harness();h.ports.readBytes=async()=>{throw Error('PRIVATE_READ');};assert.equal(await run(['--build','/private/spec'],h.ports),2);assert.deepEqual(h.builds,[]);assert.deepEqual(h.err,['PROJECT_CANDIDATE_REVIEW_REJECTED\n']);
});
test('candidate review native reader rejects nonregular/nonsymlink/oversize inputs',async()=>{
 const root=await fs.mkdtemp('/tmp/squire-candidate-review-reader-');try{
  const regular=join(root,'spec.json'),link=join(root,'link.json'),big=join(root,'big.json');await fs.writeFile(regular,JSON.stringify(spec()));await fs.symlink(regular,link);await fs.writeFile(big,' '.repeat(MAX+1));
  for(const path of [root,link,big,join(root,'missing')]){const h=harness();delete h.ports.readBytes;assert.equal(await run(['--build',path],h.ports),2);assert.equal(h.builds.length,0);assert.deepEqual(h.err,['PROJECT_CANDIDATE_REVIEW_REJECTED\n']);}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('candidate review malformed or cross-route result cannot become an acknowledgement',async()=>{
 const bad=[{...result(),status:'PRIVATE_STATUS'},{...result(),manifest_sha256:'PRIVATE_DIGEST'},{...result(),base_commit:'a'.repeat(40)},{...result(),changed_path_count:0},{...result(),changed_path_count:2},{...result(),package_bytes:17*1024*1024+1},{...result(),candidate_tree:'PRIVATE_TREE'},result(true),Object.defineProperty({},'status',{get(){throw Error('PRIVATE_GETTER');}})];
 for(const value of bad){const h=harness();let calls=0;h.ports.build=async()=>{calls++;return value;};assert.equal(await run(['--build','/private/spec'],h.ports),2);assert.equal(calls,1);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,['PROJECT_CANDIDATE_REVIEW_REJECTED\n']);}
 const h=harness();h.ports.verify=async()=>{throw Error('PRIVATE_VERIFY');};assert.equal(await run(['--verify','/private/package'],h.ports),2);assert.deepEqual(h.err,['PROJECT_CANDIDATE_REVIEW_REJECTED\n']);
});
test('candidate review failed acknowledgement suppresses later output and operation retries',async()=>{
 const h=harness();let calls=0,writes=0,diagnostics=0,partial='';h.ports.build=async()=>{calls++;return result();};h.ports.stdout={write(s){writes++;partial+=s.slice(0,8);throw Error('PRIVATE_OUTPUT');}};h.ports.stderr={write(){diagnostics++;throw Error('PRIVATE_FALLBACK');}};
 assert.equal(await run(['--build','/private/spec'],h.ports),2);assert.equal(calls,1);assert.equal(writes,1);assert.equal(diagnostics,0);assert.ok(partial.length>0);
 for(const sink of [{},{write:3},Object.defineProperty({},'write',{get(){throw Error('PRIVATE_SINK');}})]){const a=harness();a.ports.stdout=sink;assert.equal(await run(['--build','/private/spec'],a.ports),2);assert.deepEqual(a.reads,[]);assert.deepEqual(a.builds,[]);}
 const a=harness();const output={text:'',write(s){assert.equal(this,output);this.text+=s;return false;}};a.ports.stdout=output;assert.equal(await run(['--verify','/private/package'],a.ports),0);assert.match(output.text,/^PROJECT_CANDIDATE_REVIEW_PACKAGE_VERIFIED/);
});
test('candidate review executable contains real closed pipes and early/late errors',async()=>{
 for(const [channel,argv] of [['stdout',['--help']],['stderr',[]]]){
  const closed=await child(cli,argv,{closed:channel});assert.equal(closed.code,2);assert.equal(closed.signal,null);assert.equal(closed.stdout,'');assert.equal(closed.stderr,'');
  for(const timing of ['early','late']){const before=`const stream=process.${channel},write=stream.write.bind(stream);stream.write=(...args)=>{const r=write(...args);${timing==='early'?"stream.emit('error',Error('PRIVATE_ERROR'));":"setImmediate(()=>stream.emit('error',Error('PRIVATE_ERROR')));"}return r;};`;const r=await child(cli,argv,{before});assert.equal(r.code,2);assert.equal(r.signal,null);assert.equal(r.stdout,channel==='stdout'?help:'');assert.equal(r.stderr,channel==='stderr'?usage:'');}
 }
});
test('candidate review import is inert',()=>{
 const source=`const b=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];await import(${JSON.stringify(cli.href)});const a=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];if(JSON.stringify(b)!==JSON.stringify(a))throw Error('IMPORT_CHANGED');`;
 const r=spawnSync(process.execPath,['--input-type=module','--eval',source],{encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(r.error,undefined);assert.equal(r.status,0);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});

function revisionSpec(){return {schema:'SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1',original_result:{base_commit:'1'.repeat(40),candidate_commit:'3'.repeat(40)},revised_result:{base_commit:'1'.repeat(40),candidate_commit:'5'.repeat(40),changed_paths:['src/private.mjs'],revised_blobs:[{path:'src/private.mjs'}]},base_git_dir:'/private/base.git',base_git_identity:{dev:1,ino:1},original_git_dir:'/private/original.git',original_git_identity:{dev:1,ino:2},revised_git_dir:'/private/revised.git',revised_git_identity:{dev:1,ino:3},output_dir:'/private/revision-package',original_package:{dir:'/private/original-package',manifest_sha256:'a'.repeat(64)},prior_decisions:[{dir:'/private/prior-decision',file_sha256:'b'.repeat(64)}],selected_decision_id:'PRIVATE_SELECTED'};}
function revisionResult(verify=false){return {status:verify?'PROJECT_REVISION_REVIEW_PACKAGE_VERIFIED':'PROJECT_REVISION_REVIEW_PACKAGE_CREATED',manifest_sha256:'c'.repeat(64),base_commit:'1'.repeat(40),original_commit:'3'.repeat(40),revised_commit:'5'.repeat(40),base_to_revised_count:1,original_to_revised_count:1,package_bytes:1234};}
function revisionHarness(){const input=revisionSpec(),h=harness(input),builds=[],verifies=[];let originalCalls=0;h.ports.build=async()=>{originalCalls++;throw Error('WRONG_ORIGINAL');};h.ports.verify=h.ports.build;h.ports.buildRevision=async s=>{builds.push(s);return revisionResult();};h.ports.verifyRevision=async path=>{verifies.push(path);return revisionResult(true);};return {...h,input,revisionBuilds:builds,revisionVerifies:verifies,originalCalls:()=>originalCalls};}
test('first revision package routes dispatch once with unchanged explicit prior set and fixed private output',async()=>{
 for(const mode of ['--build-revision','--verify-revision']){
  const h=revisionHarness();assert.equal(await run([mode,'/private/input'],h.ports),0);assert.equal(h.originalCalls(),0);assert.deepEqual(h.reads,mode==='--build-revision'?[['/private/input',262144]]:[]);assert.equal(h.revisionBuilds.length,mode==='--build-revision'?1:0);assert.equal(h.revisionVerifies.length,mode==='--verify-revision'?1:0);
  if(h.revisionBuilds.length)assert.deepEqual(JSON.parse(JSON.stringify(h.revisionBuilds[0])),h.input);else assert.equal(h.revisionVerifies[0],'/private/input');
  assert.equal(h.out.join(''),`${revisionResult(mode==='--verify-revision').status}\nManifest SHA256: ${'c'.repeat(64)}\nBase commit: ${'1'.repeat(40)}\nOriginal commit: ${'3'.repeat(40)}\nRevised commit: ${'5'.repeat(40)}\nBase-to-revised path count: 1\nOriginal-to-revised path count: 1\nPackage bytes: 1234\nCOPY_INTEGRITY_ONLY; NO_DECISION_OR_EXECUTION_AUTHORITY\n`);assert.deepEqual(h.err,[]);assert.doesNotMatch(h.out.join(''),/private|PRIVATE_SELECTED|prior_decision/);
 }
 const h=revisionHarness();h.ports.readBytes=()=>{throw Error('UNUSED_READ');};assert.equal(await run(['--verify-revision','/private/package'],h.ports),0);
});
test('first revision malformed grammar/help never read inputs or invoke either API',async()=>{
 const sparse=['--build-revision','/private/input'];delete sparse[1];for(const argv of [[],['--help'],['--build-revision'],['--verify-revision','relative'],['--build-revision','/'],['--build-revision','/private/../spec'],['--verify-revision','/private/package','extra'],sparse]){
  const h=revisionHarness();assert.equal(await run(argv,h.ports),argv[0]==='--help'?0:2);assert.deepEqual(h.reads,[]);assert.deepEqual(h.revisionBuilds,[]);assert.deepEqual(h.revisionVerifies,[]);assert.equal(h.originalCalls(),0);
 }
});
test('first revision JSON frame is finite and original 64 KiB profile remains separate',async()=>{
 const large=revisionSpec();const path='/'+Array(31).fill('漢'.repeat(127)).join('/')+'漢'.repeat(128);assert.equal(path.length,4096);
 for(const key of ['base_git_dir','original_git_dir','revised_git_dir','output_dir'])large[key]=path;large.original_package.dir=path;large.prior_decisions=Array.from({length:8},(_,i)=>({dir:path.slice(0,-1)+String(i),file_sha256:'a'.repeat(64)}));
 const raw=JSON.stringify(large);assert.ok(Buffer.byteLength(raw)>65536);assert.ok(Buffer.byteLength(raw)<262144);
 const h=revisionHarness();h.ports.readBytes=async()=>encode(raw+' '.repeat(262144-Buffer.byteLength(raw)));assert.equal(await run(['--build-revision','/private/spec'],h.ports),0);assert.equal(h.revisionBuilds.length,1);
 for(const bytes of [new Uint8Array(262145),encode('{"schema":"x","schema":"y"}'),new Uint8Array([255]),encode({...revisionSpec(),signal:null}),encode({...revisionSpec(),extra:'PRIVATE'}),encode({...revisionSpec(),schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_SPEC_V1'}),encode({...revisionSpec(),prior_decisions:[]}),encode({...revisionSpec(),original_package:{dir:'relative'}})]){
  const a=revisionHarness();a.ports.readBytes=async()=>bytes;assert.equal(await run(['--build-revision','/private/spec'],a.ports),2);assert.deepEqual(a.revisionBuilds,[]);assert.deepEqual(a.err,['PROJECT_REVISION_REVIEW_REJECTED\n']);
 }
});
test('first revision invalid result or thrown errors cannot leak or acknowledge another witness',async()=>{
 for(const value of [result(),{...revisionResult(),original_commit:'a'.repeat(40)},{...revisionResult(),base_to_revised_count:0},{...revisionResult(),original_to_revised_count:2},{...revisionResult(),manifest_sha256:'PRIVATE_HASH'},{...revisionResult(),package_bytes:29*1024*1024+1},Object.defineProperty({},'status',{get(){throw Error('PRIVATE_GETTER');}})]){
  const h=revisionHarness();let calls=0;h.ports.buildRevision=async()=>{calls++;return value;};assert.equal(await run(['--build-revision','/private/spec'],h.ports),2);assert.equal(calls,1);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,['PROJECT_REVISION_REVIEW_REJECTED\n']);
 }
 const h=revisionHarness();h.ports.verifyRevision=async()=>{throw Error('PRIVATE_FAILURE');};assert.equal(await run(['--verify-revision','/private/package'],h.ports),2);assert.deepEqual(h.err,['PROJECT_REVISION_REVIEW_REJECTED\n']);
});
test('first revision acknowledgement failure suppresses fallback and repeated operations',async()=>{
 const h=revisionHarness();let calls=0,writes=0,diagnostics=0;h.ports.buildRevision=async()=>{calls++;return revisionResult();};h.ports.stdout={write(){writes++;throw Error('PRIVATE_WRITE');}};h.ports.stderr={write(){diagnostics++;}};assert.equal(await run(['--build-revision','/private/spec'],h.ports),2);assert.equal(calls,1);assert.equal(writes,1);assert.equal(diagnostics,0);assert.equal(h.originalCalls(),0);
});

test('expected package digest verification selects one complete verifier and preserves legacy bytes',async()=>{
 for(const revision of [false,true]){
  const mode=revision?'--verify-revision':'--verify',digest=(revision?'c':'a').repeat(64),make=()=>revision?revisionHarness():harness();
  const old=make();assert.equal(await run([mode,'/private/package'],old.ports),0);
  for(const expected of [digest,'0'.repeat(64)]){const h=make();assert.equal(await run([mode,'/private/package','--expect-sha256',expected],h.ports),expected===digest?0:2);assert.deepEqual(h.reads,[]);assert.deepEqual(h.builds,[]);if(revision){assert.deepEqual(h.revisionBuilds,[]);assert.deepEqual(h.revisionVerifies,['/private/package']);assert.equal(h.originalCalls(),0);}else assert.deepEqual(h.verifies,['/private/package']);assert.deepEqual(h.out,expected===digest?old.out:[]);assert.deepEqual(h.err,expected===digest?[]:[revision?'PROJECT_REVISION_REVIEW_REJECTED\n':'PROJECT_CANDIDATE_REVIEW_REJECTED\n']);}
 }
});
test('expected package digest grammar rejects without any input or operation',async()=>{
 for(const mode of ['--verify','--verify-revision']){
  const digest='a'.repeat(64),valid=[mode,'/private/package','--expect-sha256',digest];const sparse=[...valid];delete sparse[3];
  const bad=[[mode,'/private/package','--expect-sha256'],[...valid,'extra'],[mode,'/private/package',digest,'--expect-sha256'],[mode,'relative','--expect-sha256',digest],[mode,'/private/../package','--expect-sha256',digest],sparse,...['',null,undefined,7,{},new String(digest),'A'.repeat(64),'g'.repeat(64),'a'.repeat(63),'a'.repeat(65)].map(v=>[mode,'/private/package','--expect-sha256',v]),['--build','/private/spec','--expect-sha256',digest],['--build-revision','/private/spec','--expect-sha256',digest],['--help','/private/package','--expect-sha256',digest]];
  for(const argv of bad){let calls=0,out='',err='';const operation=()=>{calls++;throw Error('PRIVATE_UNWANTED_OPERATION');};assert.equal(await run(argv,{readBytes:operation,build:operation,verify:operation,buildRevision:operation,verifyRevision:operation,stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}}),2);assert.equal(calls,0);assert.equal(out,'');assert.equal(err,usage);}
 }
});
test('expected digest route validates all result metadata and captures digest once',async()=>{
 for(const revision of [false,true]){
  const mode=revision?'--verify-revision':'--verify',digest=(revision?'c':'a').repeat(64),key=revision?'verifyRevision':'verify',good=revision?revisionResult(true):result(true);
  const bad=[{...good,status:'PRIVATE_STATUS'},{...good,manifest_sha256:'PRIVATE_DIGEST'},{...good,package_bytes:0},{...good,base_commit:'PRIVATE_COMMIT'},revision?{...good,original_to_revised_count:51}:{...good,changed_path_count:51},Object.defineProperty({...good},'manifest_sha256',{get(){throw Error('PRIVATE_GETTER');}})];
  for(const value of bad){const h=revision?revisionHarness():harness();let calls=0;h.ports[key]=async()=>{calls++;return value;};assert.equal(await run([mode,'/private/package','--expect-sha256',digest],h.ports),2);assert.equal(calls,1);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,[revision?'PROJECT_REVISION_REVIEW_REJECTED\n':'PROJECT_CANDIDATE_REVIEW_REJECTED\n']);assert.deepEqual(h.reads,[]);}
  const h=revision?revisionHarness():harness(),argv=[mode,'/private/package','--expect-sha256',digest];let reads=0;h.ports[key]=async()=>{argv[1]='/private/changed';argv[3]='0'.repeat(64);return Object.defineProperty({...good},'manifest_sha256',{get(){reads++;return reads===1?digest:'0'.repeat(64);}});};assert.equal(await run(argv,h.ports),0);assert.equal(reads,1);assert.ok(h.out.join('').includes('Manifest SHA256: '+digest+'\n'));
 }
});
test('expected digest route output failures never retry verification or disclose raw errors',async()=>{
 for(const revision of [false,true]){
  const mode=revision?'--verify-revision':'--verify',digest=(revision?'c':'a').repeat(64),key=revision?'verifyRevision':'verify',good=revision?revisionResult(true):result(true);
  for(const match of [true,false]){const h=revision?revisionHarness():harness();let calls=0,writes=0;h.ports[key]=async()=>{calls++;return good;};h.ports.stdout={write(){writes++;throw Error('PRIVATE_OUTPUT');}};h.ports.stderr={write(){writes++;throw Error('PRIVATE_ERROR');}};assert.equal(await run([mode,'/private/package','--expect-sha256',match?digest:'0'.repeat(64)],h.ports),2);assert.equal(calls,1);assert.equal(writes,1);assert.deepEqual(h.reads,[]);assert.deepEqual(h.builds,[]);}
 }
});

const snapshotSpec=()=>({schema:'SQUIRE_PROJECT_CANDIDATE_REVIEW_FROM_SNAPSHOT_SPEC_V1',snapshot_dir:'/private/snapshot',expected_manifest_sha256:'d'.repeat(64),output_dir:'/private/handoff'});
const snapshotResult=()=>({...result(),status:'PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED_FROM_SNAPSHOT',source_snapshot_manifest_sha256:'d'.repeat(64),provenance_sha256:'b'.repeat(64),input_result_sha256:'c'.repeat(64)});
function snapshotHarness(){const h=harness(snapshotSpec());let calls=0,others=0;h.ports.buildFromSnapshot=async input=>{calls++;assert.deepEqual(JSON.parse(JSON.stringify(input)),snapshotSpec());return snapshotResult();};for(const key of ['build','verify','buildRevision','verifyRevision'])h.ports[key]=async()=>{others++;throw Error('PRIVATE_WRONG_ROUTE');};return {...h,calls:()=>calls,others:()=>others};}
test('snapshot review CLI delegates once and projects only bound fixed metadata',async()=>{
 const h=snapshotHarness();assert.equal(await run(['--build-from-snapshot','/private/spec'],h.ports),0);assert.equal(h.calls(),1);assert.equal(h.others(),0);assert.deepEqual(h.reads,[['/private/spec',65536]]);assert.deepEqual(h.err,[]);assert.equal(h.out.join(''),`PROJECT_CANDIDATE_REVIEW_PACKAGE_CREATED_FROM_SNAPSHOT\nSource snapshot SHA256: ${'d'.repeat(64)}\nManifest SHA256: ${'a'.repeat(64)}\nProvenance SHA256: ${'b'.repeat(64)}\nInput result SHA256: ${'c'.repeat(64)}\nBase commit: ${'1'.repeat(40)}\nBase tree: ${'2'.repeat(40)}\nCandidate commit: ${'3'.repeat(40)}\nCandidate tree: ${'4'.repeat(40)}\nChanged path count: 1\nPackage bytes: 1234\nPackage relative directory: package\nRETAINED_SNAPSHOT_SOURCE_ONLY; NO_LIVE_CUSTODY_OR_ORIGINAL_RESULT_VALIDATION\n`);assert.doesNotMatch(h.out.join(''),/PRIVATE_LABEL|\/private|snapshot_dir|reviewer/);
});
test('snapshot review CLI rejects malformed grammar and strict bounded spec without other operations',async()=>{
 for(const argv of [[],['--help'],['--build-from-snapshot'],['--build-from-snapshot','relative'],['--build-from-snapshot','/'],['--build-from-snapshot','/private/spec','extra'],['--build-from-snapshot','/private/spec','--expect-sha256','a'.repeat(64)]]){const h=snapshotHarness();assert.equal(await run(argv,h.ports),argv[0]==='--help'?0:2);assert.equal(h.calls(),0);assert.equal(h.others(),0);assert.deepEqual(h.reads,[]);}
 for(const value of [{...snapshotSpec(),signal:null},{...snapshotSpec(),extra:'PRIVATE'}, {...snapshotSpec(),schema:'SQUIRE_PROJECT_REVISION_REVIEW_SPEC_V1'}, {...snapshotSpec(),expected_manifest_sha256:'D'.repeat(64)}, {...snapshotSpec(),expected_manifest_sha256:'d'.repeat(64)+'\n'}, {...snapshotSpec(),snapshot_dir:'relative'}, {...snapshotSpec(),output_dir:'/private/snapshot/inside'}, {...snapshotSpec(),output_dir:'/private/snapshot'}]){const h=snapshotHarness();h.ports.readBytes=async()=>encode(value);assert.equal(await run(['--build-from-snapshot','/private/spec'],h.ports),2);assert.equal(h.calls(),0);assert.equal(h.others(),0);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,['PROJECT_CANDIDATE_REVIEW_REJECTED\n']);}
 for(const raw of [encode('{"schema":"x","schema":"y"}'),new Uint8Array([255]),new Uint8Array(65537)]){const h=snapshotHarness();h.ports.readBytes=async()=>raw;assert.equal(await run(['--build-from-snapshot','/private/spec'],h.ports),2);assert.equal(h.calls(),0);}
 const h=snapshotHarness(),raw=encode(JSON.stringify(snapshotSpec())+' '.repeat(65536-Buffer.byteLength(JSON.stringify(snapshotSpec()))));h.ports.readBytes=async()=>raw;assert.equal(await run(['--build-from-snapshot','/private/spec'],h.ports),0);assert.equal(h.calls(),1);assert.ok(raw.some(v=>v!==0));
});
test('snapshot review CLI cannot acknowledge mismatched source or invalid receipt result metadata',async()=>{
 const bad=[result(),{...snapshotResult(),source_snapshot_manifest_sha256:'a'.repeat(64)},{...snapshotResult(),provenance_sha256:'PRIVATE_DIGEST'},{...snapshotResult(),input_result_sha256:'PRIVATE_RESULT'},{...snapshotResult(),candidate_tree:'PRIVATE_TREE'},{...snapshotResult(),changed_path_count:0},{...snapshotResult(),package_bytes:17*1024*1024+1},Object.defineProperty({},'status',{get(){throw Error('PRIVATE_GETTER');}})];
 for(const value of bad){const h=snapshotHarness();let calls=0;h.ports.buildFromSnapshot=async()=>{calls++;return value;};assert.equal(await run(['--build-from-snapshot','/private/spec'],h.ports),2);assert.equal(calls,1);assert.equal(h.others(),0);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,['PROJECT_CANDIDATE_REVIEW_REJECTED\n']);}
});
test('snapshot review CLI output failure retains non-success and never retries a mutation',async()=>{
 const h=snapshotHarness();let writes=0,diagnostics=0;h.ports.stdout={write(){writes++;throw Error('PRIVATE_OUTPUT');}};h.ports.stderr={write(){diagnostics++;throw Error('PRIVATE_FALLBACK');}};assert.equal(await run(['--build-from-snapshot','/private/spec'],h.ports),2);assert.equal(h.calls(),1);assert.equal(h.others(),0);assert.equal(writes,1);assert.equal(diagnostics,0);
 const fail=snapshotHarness();let calls=0,errors=0;fail.ports.buildFromSnapshot=async()=>{calls++;throw Error('PRIVATE_SOURCE_PATH');};fail.ports.stderr={write(){errors++;throw Error('PRIVATE_STDERR');}};assert.equal(await run(['--build-from-snapshot','/private/spec'],fail.ports),2);assert.equal(calls,1);assert.equal(errors,1);
});

const handoffVerified=()=>({...snapshotResult(),status:'PROJECT_CANDIDATE_REVIEW_SNAPSHOT_HANDOFF_VERIFIED'});
const handoffArgs=['--verify-snapshot-handoff','/private/handoff','b'.repeat(64)];
function handoffHarness(){let calls=0,other=0;const wrong=()=>{other++;throw Error('PRIVATE_UNWANTED');};const h=harness();for(const key of ['readBytes','build','verify','buildRevision','verifyRevision','buildFromSnapshot'])h.ports[key]=wrong;h.ports.verifySnapshotHandoff=async(...args)=>{calls++;assert.deepEqual(args,handoffArgs.slice(1));return handoffVerified();};return {...h,calls:()=>calls,other:()=>other};}
test('copied handoff CLI selects one read-only operation and fixed metadata',async()=>{
 const h=handoffHarness();assert.equal(await run(handoffArgs,h.ports),0);assert.equal(h.calls(),1);assert.equal(h.other(),0);assert.deepEqual(h.err,[]);assert.match(h.out.join(''),/^PROJECT_CANDIDATE_REVIEW_SNAPSHOT_HANDOFF_VERIFIED\n/);assert.match(h.out.join(''),new RegExp('Provenance SHA256: '+'b'.repeat(64)));assert.match(h.out.join(''),/SELECTED_HANDOFF_INTEGRITY_ONLY; NO_AUTHENTICITY_OR_ACKNOWLEDGEMENT_RECOVERY\n$/);assert.doesNotMatch(h.out.join(''),/\/private|PRIVATE_LABEL|choice|attestations/);
});
test('copied handoff malformed arguments invoke no reader or API',async()=>{
 const sparse=[...handoffArgs];delete sparse[2];for(const args of [[],['--help'],['--verify-snapshot-handoff'],handoffArgs.slice(0,2),[...handoffArgs,'extra'],['--verify-snapshot-handoff','relative','b'.repeat(64)],['--verify-snapshot-handoff','/','b'.repeat(64)],['--verify-snapshot-handoff','/private/../handoff','b'.repeat(64)],sparse,...['',null,{},new String('b'.repeat(64)),'B'.repeat(64),'b'.repeat(65),'b'.repeat(64)+'\n'].map(v=>['--verify-snapshot-handoff','/private/handoff',v])]){const h=handoffHarness();assert.equal(await run(args,h.ports),args[0]==='--help'?0:2);assert.equal(h.calls(),0);assert.equal(h.other(),0);}
});
test('copied handoff result mismatches and private failures withhold all success output',async()=>{
 for(const value of [snapshotResult(),{...handoffVerified(),provenance_sha256:'a'.repeat(64)},{...handoffVerified(),manifest_sha256:'PRIVATE_HASH'},{...handoffVerified(),source_snapshot_manifest_sha256:'PRIVATE_SOURCE'},{...handoffVerified(),input_result_sha256:'PRIVATE_RESULT'},{...handoffVerified(),base_tree:'PRIVATE_TREE'},{...handoffVerified(),changed_path_count:51},{...handoffVerified(),package_bytes:0},Object.defineProperty({},'status',{get(){throw Error('PRIVATE_GETTER');}})]){const h=handoffHarness();let calls=0;h.ports.verifySnapshotHandoff=async()=>{calls++;return value;};assert.equal(await run(handoffArgs,h.ports),2);assert.equal(calls,1);assert.equal(h.other(),0);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,['PROJECT_CANDIDATE_REVIEW_REJECTED\n']);}
 const h=handoffHarness();h.ports.verifySnapshotHandoff=()=>{throw Error('PRIVATE_PATH');};assert.equal(await run(handoffArgs,h.ports),2);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,['PROJECT_CANDIDATE_REVIEW_REJECTED\n']);
});
test('copied handoff output failures never retry and preserve backpressure semantics',async()=>{
 const h=handoffHarness();let writes=0,errors=0;h.ports.stdout={write(){writes++;throw Error('PRIVATE_OUTPUT');}};h.ports.stderr={write(){errors++;}};assert.equal(await run(handoffArgs,h.ports),2);assert.equal(h.calls(),1);assert.equal(h.other(),0);assert.equal(writes,1);assert.equal(errors,0);
 const bad=handoffHarness();let calls=0,diagnostics=0;bad.ports.verifySnapshotHandoff=()=>{calls++;throw Error('PRIVATE_SOURCE');};bad.ports.stderr={write(){diagnostics++;throw Error('PRIVATE_SINK');}};assert.equal(await run(handoffArgs,bad.ports),2);assert.equal(calls,1);assert.equal(diagnostics,1);
 const pressure=handoffHarness(),sink={text:'',write(s){assert.equal(this,sink);this.text+=s;return false;}};pressure.ports.stdout=sink;assert.equal(await run(handoffArgs,pressure.ports),0);assert.equal(pressure.calls(),1);assert.ok(sink.text.startsWith('PROJECT_CANDIDATE_REVIEW_SNAPSHOT_HANDOFF_VERIFIED'));
});

test('retained revision CLI grammar is inert and routes only explicitly selected operations',async()=>{
 const h='a'.repeat(64),calls=[],bad=[['--verify-retained-revision-source','/private/root'],['--verify-retained-revision-source','relative',h],['--verify-retained-revision-source','/private/root',h+'\n'],['--verify-retained-revision-source','/private/root',h,'extra'],['--retain-revision-source'],['--build-revision-from-retained','relative']];
 for(const argv of bad){let output='';const op=()=>{calls.push('unwanted');};assert.equal(await run(argv,{readBytes:op,retainRevisionSource:op,verifyRetainedRevisionSource:op,buildRevisionFromRetained:op,stdout:{write:op},stderr:{write:s=>output+=s}}),2);assert.match(output,/^Usage:/);}
 assert.deepEqual(calls,[]);
 const value={status:'PROJECT_RETAINED_REVISION_SOURCE_VERIFIED',manifest_sha256:h,base_commit:'1'.repeat(40),base_tree:'2'.repeat(40),original_commit:'3'.repeat(40),original_tree:'4'.repeat(40),revised_commit:'5'.repeat(40),revised_tree:'6'.repeat(40),base_to_revised_count:2,original_to_revised_count:2,union_count:3,object_count:9,retained_bytes:1000};
 let n=0,out='',err='';const ports={verifyRetainedRevisionSource:async(...args)=>{n++;assert.deepEqual(args,['/private/root',h]);return value;},readBytes:()=>{throw Error('PRIVATE_UNWANTED');},stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}};
 assert.equal(await run(['--verify-retained-revision-source','/private/root',h],ports),0);assert.equal(n,1);assert.match(out,/COPY_INTEGRITY_ONLY/);assert.ok(!out.includes('/private'));assert.equal(err,'');
 for(const badValue of [{...value,manifest_sha256:'b'.repeat(64)},{...value,status:'PRIVATE_STATUS'},{...value,union_count:1},{...value,object_count:8193},{...value,retained_bytes:64*1024*1024+1},{...value,base_tree:'PRIVATE'},Object.defineProperty({},'status',{get(){throw Error('PRIVATE_GETTER');}})]){out='';err='';ports.verifyRetainedRevisionSource=async()=>badValue;assert.equal(await run(['--verify-retained-revision-source','/private/root',h],ports),2);assert.equal(out,'');assert.equal(err,'PROJECT_RETAINED_REVISION_SOURCE_REJECTED\n');}
});
test('retained revision build request parsing, bound returned source and output failures remain private',async()=>{
 const h='a'.repeat(64),request={schema:'SQUIRE_PROJECT_REVISION_REVIEW_RETAINED_SPEC_V1',retained_source_dir:'/private/source',expected_manifest_sha256:h,output_dir:'/private/output'},value={status:'PROJECT_REVISION_REVIEW_PACKAGE_CREATED_FROM_RETAINED_SOURCE',source_manifest_sha256:h,manifest_sha256:'b'.repeat(64),provenance_sha256:'c'.repeat(64),base_commit:'1'.repeat(40),base_tree:'2'.repeat(40),original_commit:'3'.repeat(40),original_tree:'4'.repeat(40),revised_commit:'5'.repeat(40),revised_tree:'6'.repeat(40),base_to_revised_count:1,original_to_revised_count:1,union_count:2,package_bytes:1000};
 let operations=0,out='',err='';const ports={readBytes:async(path,max)=>{assert.equal(max,65536);return encode(request);},buildRevisionFromRetained:async spec=>{operations++;assert.deepEqual(JSON.parse(JSON.stringify(spec)),request);return value;},stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}};
 assert.equal(await run(['--build-revision-from-retained','/private/spec'],ports),0);assert.equal(operations,1);assert.ok(!out.includes('PRIVATE')&&!out.includes('/private'));assert.equal(err,'');
 for(const input of [encode({...request,signal:null}),encode({...request,extra:'PRIVATE'}),encode({...request,expected_manifest_sha256:h+'\n'}),encode({...request,output_dir:request.retained_source_dir}),new Uint8Array(65537),encode('{'),new Uint8Array([255])]){ports.readBytes=async()=>input;const before=operations;out='';err='';assert.equal(await run(['--build-revision-from-retained','/private/spec'],ports),2);assert.equal(operations,before);assert.equal(out,'');assert.equal(err,'PROJECT_RETAINED_REVISION_SOURCE_REJECTED\n');}
 ports.readBytes=async()=>encode(request);ports.buildRevisionFromRetained=async()=>({...value,source_manifest_sha256:'f'.repeat(64)});out='';assert.equal(await run(['--build-revision-from-retained','/private/spec'],ports),2);assert.equal(out,'');
 ports.buildRevisionFromRetained=async()=>{operations++;return value;};let writes=0,diagnostics=0;ports.stdout={write(){writes++;throw Error('PRIVATE_SINK');}};ports.stderr={write(){diagnostics++;throw Error('PRIVATE_ERR');}};const before=operations;assert.equal(await run(['--build-revision-from-retained','/private/spec'],ports),2);assert.equal(operations,before+1);assert.equal(writes,1);assert.equal(diagnostics,0);
});
