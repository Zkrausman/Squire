import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCandidateReviewCli as run} from '../bin/squire-candidate-review.mjs';
import {artifactCliChild as child} from './helpers/artifact-cli-child.mjs';
const MAX=65536,usage='Usage: node bin/squire-candidate-review.mjs <--build|--verify> <spec.json|package-dir>\n';
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
  const h=harness();assert.equal(await run(argv,h.ports),argv[0]==='--help'?0:2);assert.deepEqual(h.reads,[]);assert.deepEqual(h.builds,[]);assert.deepEqual(h.verifies,[]);assert.equal((argv[0]==='--help'?h.out:h.err).join(''),usage);
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
  for(const timing of ['early','late']){const before=`const stream=process.${channel},write=stream.write.bind(stream);stream.write=(...args)=>{const r=write(...args);${timing==='early'?"stream.emit('error',Error('PRIVATE_ERROR'));":"setImmediate(()=>stream.emit('error',Error('PRIVATE_ERROR')));"}return r;};`;const r=await child(cli,argv,{before});assert.equal(r.code,2);assert.equal(r.signal,null);assert.equal(r.stdout,channel==='stdout'?usage:'');assert.equal(r.stderr,channel==='stderr'?usage:'');}
 }
});
test('candidate review import is inert',()=>{
 const source=`const b=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];await import(${JSON.stringify(cli.href)});const a=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];if(JSON.stringify(b)!==JSON.stringify(a))throw Error('IMPORT_CHANGED');`;
 const r=spawnSync(process.execPath,['--input-type=module','--eval',source],{encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(r.error,undefined);assert.equal(r.status,0);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});
