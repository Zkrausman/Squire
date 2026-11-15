import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCandidateDecisionCli as run} from '../bin/squire-candidate-decision.mjs';
import {MAX_REVIEW_DECISION_BYTES as MAX} from '../src/project-review-decision-limits.mjs';
import {artifactCliChild} from './helpers/artifact-cli-child.mjs';
const encode=v=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v));
const args=['record','/private/package','/private/request.json','/private/new-decision'];
const request=()=>({schema:'SQUIRE_PROJECT_CANDIDATE_DECISION_V1',decision_id:'private-id',reviewer_label:'private-label',
 review_package_sha256:'a'.repeat(64),base_commit:'1'.repeat(40),base_tree:'2'.repeat(40),candidate_commit:'3'.repeat(40),candidate_tree:'4'.repeat(40),
 choice:'REVISE',attestations:[],note:'PRIVATE_NOTE'});
function harness(value=request()){
 const reads=[],records=[],out=[],err=[];let created=false;
 const ports={readBytes:async(path,max)=>{reads.push({path,max});return encode(value);},
  record:async(pkg,decision,dest)=>{records.push({pkg,decision,dest});created=true;
   return {status:'PROJECT_CANDIDATE_DECISION_RECORDED',choice:decision.choice,review_package_sha256:decision.review_package_sha256,decision_sha256:'b'.repeat(64)};},
  stdout:{write:s=>out.push(s)},stderr:{write:s=>err.push(s)}};
 return {reads,records,out,err,ports,created:()=>created};
}
test('record-only grammar and help are inert',async()=>{
 for(const argv of [[],['record'],['verify',...args.slice(1)],[...args,'extra'],['record','relative',...args.slice(2)],
  ['record','/',...args.slice(2)],['record','/private/../package',...args.slice(2)],['record','/private/\0bad',...args.slice(2)],['--help']]){
  const h=harness();assert.equal(await run(argv,h.ports),argv[0]==='--help'?0:2);assert.equal(h.reads.length,0);assert.equal(h.records.length,0);
  assert.match((argv[0]==='--help'?h.out:h.err).join(''),/^Usage:/);
 }
});
test('explicit request is passed once and only validated status/digests are emitted',async()=>{
 const h=harness();assert.equal(await run(args,h.ports),0);
 assert.deepEqual(h.reads,[{path:args[2],max:MAX}]);assert.equal(h.records.length,1);
 assert.equal(h.records[0].pkg,args[1]);assert.equal(h.records[0].dest,args[3]);
 assert.deepEqual(JSON.parse(JSON.stringify(h.records[0].decision)),request());
 assert.equal(h.out.join(''),`PROJECT_CANDIDATE_DECISION_RECORDED\nPackage SHA256: ${'a'.repeat(64)}\nDecision SHA256: ${'b'.repeat(64)}\nSOURCE_DECISION_ONLY; NO_EXECUTION_OR_MERGE_AUTHORITY\n`);
 assert.deepEqual(h.err,[]);assert.doesNotMatch(h.out.join(''),/private|PRIVATE_NOTE|REVISE/);
});
test('strict parsing, returned oversize and read errors never invoke record',async()=>{
 for(const bytes of [encode('{"choice":"ACCEPT","choice":"REJECT"}'),new Uint8Array([255]),encode('{'),new Uint8Array(MAX+1)]){
  const h=harness();h.ports.readBytes=async()=>bytes;assert.equal(await run(args,h.ports),2);assert.equal(h.records.length,0);
  assert.deepEqual(h.err,['PROJECT_CANDIDATE_DECISION_REJECTED\n']);assert.deepEqual(h.out,[]);
 }
 const h=harness();h.ports.readBytes=async()=>{throw Error('PRIVATE_READ_ERROR');};assert.equal(await run(args,h.ports),2);
 assert.equal(h.records.length,0);assert.doesNotMatch(h.err.join(''),/PRIVATE_READ_ERROR/);
});
test('native request reader rejects symlinks, special files and oversized text',async()=>{
 const root=await fs.mkdtemp('/tmp/squire-decision-reader-');
 try{
  const regular=join(root,'regular.json');await fs.writeFile(regular,JSON.stringify(request()));
  const link=join(root,'link.json');await fs.symlink(regular,link);
  const big=join(root,'big.json');await fs.writeFile(big,' '.repeat(MAX+1));
  for(const path of [link,root,big,join(root,'missing')]){
   const h=harness();delete h.ports.readBytes;assert.equal(await run(['record',args[1],path,args[3]],h.ports),2);
   assert.equal(h.records.length,0);assert.deepEqual(h.err,['PROJECT_CANDIDATE_DECISION_REJECTED\n']);
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('invalid operation results and raw errors cannot become acknowledgements',async()=>{
 for(const result of [{status:'PRIVATE_STATUS'},
  {status:'PROJECT_CANDIDATE_DECISION_RECORDED',choice:'REVISE',review_package_sha256:'a'.repeat(64),decision_sha256:'PRIVATE_DIGEST'},
  {status:'PROJECT_CANDIDATE_DECISION_RECORDED',choice:'ACCEPT',review_package_sha256:'a'.repeat(64),decision_sha256:'b'.repeat(64)},
  Object.defineProperty({},'status',{get(){throw Error('PRIVATE_GETTER');}})]){
  const h=harness();h.ports.record=async()=>result;assert.equal(await run(args,h.ports),2);assert.deepEqual(h.out,[]);
  assert.deepEqual(h.err,['PROJECT_CANDIDATE_DECISION_REJECTED\n']);
 }
 const h=harness();h.ports.record=async()=>{throw Error('PRIVATE_RECORD_ERROR');};assert.equal(await run(args,h.ports),2);
 assert.deepEqual(h.err,['PROJECT_CANDIDATE_DECISION_REJECTED\n']);
});
test('acknowledgement failure is not no-creation and never retries a channel or operation',async()=>{
 const h=harness();let out=0,err=0,partial='';
 h.ports.stdout={write:s=>{out++;partial+=s.slice(0,10);throw Error('PRIVATE_OUTPUT');}};
 h.ports.stderr={write:()=>{err++;throw Error('PRIVATE_FALLBACK');}};
 assert.equal(await run(args,h.ports),2);assert.equal(h.created(),true);assert.equal(h.records.length,1);
 assert.equal(out,1);assert.equal(err,0);assert.ok(partial.length>0);
 const failed=harness();let diagnostics=0;failed.ports.record=async()=>{throw Error('PRIVATE_RECORD');};
 failed.ports.stderr={write(){diagnostics++;throw Error('PRIVATE_DIAGNOSTIC');}};
 assert.equal(await run(args,failed.ports),2);assert.equal(diagnostics,1);
});
test('sink capture failures are inert and false-return output preserves its receiver',async()=>{
 for(const sink of [{},{write:4},Object.defineProperty({},'write',{get(){throw Error('PRIVATE_SINK');}})]){
  const h=harness();h.ports.stdout=sink;assert.equal(await run(args,h.ports),2);assert.equal(h.reads.length,0);assert.equal(h.records.length,0);
 }
 const h=harness();const out={text:'',write(s){assert.equal(this,out);this.text+=s;return false;}};
 h.ports.stdout=out;assert.equal(await run(args,h.ports),0);assert.match(out.text,/^PROJECT_CANDIDATE_DECISION_RECORDED/);
});
const cli=new URL('../bin/squire-candidate-decision.mjs',import.meta.url);
const usage='Usage: node bin/squire-candidate-decision.mjs record <package-dir> <decision-request.json> <fresh-decision-dir>\n       node bin/squire-candidate-decision.mjs record-revision <revision-package-dir> <decision-request.json> <fresh-decision-dir>\n       node bin/squire-candidate-decision.mjs verify-revision-decision <revision-package-dir> <decision-dir> <expected-decision-sha256>\n';
test('executable closed pipes and early/late observed errors withhold success',async()=>{
 for(const [channel,argv] of [['stdout',['--help']],['stderr',[]]]){
  const closed=await artifactCliChild(cli,argv,{closed:channel});assert.equal(closed.code,2);assert.equal(closed.signal,null);
  assert.equal(closed.stdout,'');assert.equal(closed.stderr,'');
  for(const timing of ['early','late']){
   const before=`const stream=process.${channel},write=stream.write.bind(stream);stream.write=(...args)=>{const r=write(...args);${timing==='early'?"stream.emit('error',Error('PRIVATE_ERROR'));":"setImmediate(()=>stream.emit('error',Error('PRIVATE_ERROR')));"}return r;};`;
   const r=await artifactCliChild(cli,argv,{before});assert.equal(r.code,2);assert.equal(r.signal,null);
   assert.equal(r.stdout,channel==='stdout'?usage:'');assert.equal(r.stderr,channel==='stderr'?usage:'');
  }
 }
});
test('module import is inert',()=>{
 const source=`const before=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];await import(${JSON.stringify(cli.href)});const after=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];if(JSON.stringify(before)!==JSON.stringify(after))throw Error('IMPORT_CHANGED');`;
 const r=spawnSync(process.execPath,['--input-type=module','--eval',source],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 assert.equal(r.error,undefined);assert.equal(r.status,0);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});

test('sparse argument positions are malformed and cause zero request reads or records',async()=>{
 for(const index of [1,2,3]){
  const sparse=[...args];delete sparse[index];const h=harness();const code=await run(sparse,h.ports);
  assert.equal(h.reads.length,0);assert.equal(h.records.length,0);assert.equal(code,2);
 }
});

const revisionArgs=['record-revision',...args.slice(1)];
function revisionHarness(){
 const d={schema:'SQUIRE_PROJECT_REVISION_DECISION_V1',decision_id:'PRIVATE_ID',reviewer_label:'PRIVATE_LABEL',revision_package_sha256:'c'.repeat(64),original_package_sha256:'d'.repeat(64),prior_revise_decision_sha256:'e'.repeat(64),base_commit:'1'.repeat(40),base_tree:'2'.repeat(40),original_commit:'3'.repeat(40),original_tree:'4'.repeat(40),revised_commit:'5'.repeat(40),revised_tree:'6'.repeat(40),choice:'REVISE',attestations:[],note:'PRIVATE_NOTE'};
 const h=harness(d);let originalCalls=0;
 h.ports.record=async()=>{originalCalls++;throw Error('WRONG_ROUTE');};
 h.ports.recordRevision=async(pkg,decision,dest)=>{h.records.push({pkg,decision,dest});return {status:'PROJECT_REVISION_DECISION_RECORDED',choice:decision.choice,revision_package_sha256:decision.revision_package_sha256,decision_sha256:'b'.repeat(64)};};
 return {...h,d,originalCalls:()=>originalCalls};
}
test('revision CLI dispatch is explicit, once, and projects only matching revision status/digests',async()=>{
 const h=revisionHarness();assert.equal(await run(revisionArgs,h.ports),0);assert.equal(h.originalCalls(),0);
 assert.deepEqual(h.reads,[{path:args[2],max:MAX}]);assert.equal(h.records.length,1);assert.equal(h.records[0].pkg,args[1]);assert.equal(h.records[0].dest,args[3]);
 assert.deepEqual(JSON.parse(JSON.stringify(h.records[0].decision)),h.d);
 assert.equal(h.out.join(''),`PROJECT_REVISION_DECISION_RECORDED\nRevision package SHA256: ${'c'.repeat(64)}\nDecision SHA256: ${'b'.repeat(64)}\nSOURCE_DECISION_ONLY; NO_EXECUTION_OR_MERGE_AUTHORITY\n`);
 assert.equal(h.err.join(''),'');assert.doesNotMatch(h.out.join(''),/PRIVATE|REVISE|original_commit/);
});
test('revision CLI malformed or sparse grammar and help have zero request/API calls',async()=>{
 const sparse=revisionArgs.map((_,i)=>{const a=[...revisionArgs];delete a[i];return a;});
 for(const argv of [...sparse,[],['record-revision'],[...revisionArgs,'extra'],['record-revision','relative',...args.slice(2)],['--help']]){
  const h=revisionHarness();assert.equal(await run(argv,h.ports),argv[0]==='--help'?0:2);assert.equal(h.reads.length,0);assert.equal(h.records.length,0);assert.equal(h.originalCalls(),0);
 }
});
test('revision CLI parse/read and invalid-result boundaries are private and nonretrying',async()=>{
 for(const bytes of [encode('{"choice":"ACCEPT","choice":"REJECT"}'),new Uint8Array([255]),new Uint8Array(MAX+1)]){
  const h=revisionHarness();h.ports.readBytes=async()=>bytes;assert.equal(await run(revisionArgs,h.ports),2);assert.equal(h.records.length,0);assert.deepEqual(h.err,['PROJECT_REVISION_DECISION_REJECTED\n']);
 }
 for(const result of [{status:'PROJECT_CANDIDATE_DECISION_RECORDED',choice:'REVISE',review_package_sha256:'c'.repeat(64),decision_sha256:'b'.repeat(64)},
  {status:'PROJECT_REVISION_DECISION_RECORDED',choice:'REVISE',revision_package_sha256:'a'.repeat(64),decision_sha256:'b'.repeat(64)},
  {status:'PROJECT_REVISION_DECISION_RECORDED',choice:'ACCEPT',revision_package_sha256:'c'.repeat(64),decision_sha256:'b'.repeat(64)},
  Object.defineProperty({},'status',{get(){throw Error('PRIVATE_GETTER');}})]){
  const h=revisionHarness();let calls=0;h.ports.recordRevision=async()=>{calls++;return result;};assert.equal(await run(revisionArgs,h.ports),2);assert.equal(calls,1);assert.equal(h.originalCalls(),0);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,['PROJECT_REVISION_DECISION_REJECTED\n']);
 }
 const h=revisionHarness();h.ports.recordRevision=async()=>{throw Error('PRIVATE_FAILURE');};assert.equal(await run(revisionArgs,h.ports),2);assert.deepEqual(h.err,['PROJECT_REVISION_DECISION_REJECTED\n']);
});
test('revision CLI acknowledgement failure suppresses fallback and operation retry',async()=>{
 const h=revisionHarness();let writes=0,diagnostics=0;h.ports.stdout={write(){writes++;throw Error('PRIVATE_OUTPUT');}};h.ports.stderr={write(){diagnostics++;}};
 assert.equal(await run(revisionArgs,h.ports),2);assert.equal(h.records.length,1);assert.equal(h.originalCalls(),0);assert.equal(writes,1);assert.equal(diagnostics,0);
});

test('revision parser accepts exactly hundred rows while legacy receipt parser remains at sixty-four',async()=>{
 const {parseReceiptJson}=await import('../src/offline-run-summary.mjs');
 assert.equal(parseReceiptJson(encode(Array(64).fill(null))).length,64);assert.throws(()=>parseReceiptJson(encode(Array(65).fill(null))),e=>e==='SCHEMA_MISMATCH');
 for(const [count,expected] of [[100,0],[101,2]]){const h=revisionHarness();h.d.attestations=Array(count).fill(null);h.ports.readBytes=async()=>encode(h.d);assert.equal(await run(revisionArgs,h.ports),expected);assert.equal(h.records.length,expected===0?1:0);}
 const h=revisionHarness();h.ports.readBytes=async()=>encode('{"choice":"ACCEPT","\\u0063hoice":"REJECT"}');assert.equal(await run(revisionArgs,h.ports),2);assert.equal(h.records.length,0);
});

const verifyDecisionArgs=['verify-revision-decision','/private/revision-package','/private/decision','b'.repeat(64)];
const verifiedDecision=(choice='REVISE',count=0)=>({status:'PROJECT_REVISION_DECISION_VERIFIED',choice,revision_package_sha256:'c'.repeat(64),decision_sha256:'b'.repeat(64),attested_path_count:count,private_label:'PRIVATE_LABEL'});
test('selected revision decision verification calls only the selected verifier once and omits stored choice',async()=>{
 for(const [choice,count] of [['ACCEPT',100],['REVISE',0],['REJECT',0]]){
  const h=harness();let calls=0;h.ports.verifyRevisionDecision=async(...a)=>{calls++;assert.deepEqual(a,verifyDecisionArgs.slice(1));return verifiedDecision(choice,count);};
  assert.equal(await run(verifyDecisionArgs,h.ports),0);assert.equal(calls,1);assert.deepEqual(h.reads,[]);assert.deepEqual(h.records,[]);assert.deepEqual(h.err,[]);
  assert.equal(h.out.join(''),`PROJECT_REVISION_DECISION_VERIFIED\nRevision package SHA256: ${'c'.repeat(64)}\nDecision SHA256: ${'b'.repeat(64)}\nAttested path count: ${count}\nSELECTED_RECORD_INTEGRITY_ONLY; NO_EXECUTION_OR_MERGE_AUTHORITY\n`);assert.doesNotMatch(h.out.join(''),/PRIVATE_LABEL|ACCEPT|REJECT|REVISE|private/);
 }
});
test('selected revision decision verification requires exact explicit paths and digest before reads',async()=>{
 const sparse=Array.from({length:3},(_,i)=>{const a=[...verifyDecisionArgs];delete a[i+1];return a;});
 const invalid=[[],['--help'],verifyDecisionArgs.slice(0,3),[...verifyDecisionArgs,'extra'],['verify-decision',...verifyDecisionArgs.slice(1)],['verify-revision-decision','relative',...verifyDecisionArgs.slice(2)],['verify-revision-decision','/',...verifyDecisionArgs.slice(2)],['verify-revision-decision',verifyDecisionArgs[1],'/private/../decision',verifyDecisionArgs[3]],...['B'.repeat(64),'b'.repeat(63),'z'.repeat(64),''].map(hash=>[...verifyDecisionArgs.slice(0,3),hash]),...sparse];
 for(const argv of invalid){const h=harness();let calls=0;h.ports.verifyRevisionDecision=async()=>{calls++;return verifiedDecision();};assert.equal(await run(argv,h.ports),argv[0]==='--help'?0:2);assert.equal(calls,0);assert.deepEqual(h.reads,[]);assert.deepEqual(h.records,[]);}
});
test('selected revision decision verification rejects malformed API projection without raw errors',async()=>{
 const bad=[{...verifiedDecision(),status:'PROJECT_REVISION_DECISION_RECORDED'},{...verifiedDecision(),revision_package_sha256:'PRIVATE_HASH'},{...verifiedDecision(),decision_sha256:'a'.repeat(64)},{...verifiedDecision(),choice:'AUTO'},{...verifiedDecision(),attested_path_count:-1},{...verifiedDecision(),attested_path_count:101},{...verifiedDecision(),attested_path_count:0.5},Object.defineProperty({},'status',{get(){throw Error('PRIVATE_GETTER');}})];
 for(const value of bad){const h=harness();let calls=0;h.ports.verifyRevisionDecision=async()=>{calls++;return value;};assert.equal(await run(verifyDecisionArgs,h.ports),2);assert.equal(calls,1);assert.deepEqual(h.out,[]);assert.deepEqual(h.err,['PROJECT_REVISION_DECISION_REJECTED\n']);assert.deepEqual(h.records,[]);}
 const h=harness();h.ports.verifyRevisionDecision=async()=>{throw Error('PRIVATE_FAILURE');};assert.equal(await run(verifyDecisionArgs,h.ports),2);assert.deepEqual(h.err,['PROJECT_REVISION_DECISION_REJECTED\n']);
});
test('selected revision decision verification output failures never retry or call a writer',async()=>{
 const h=harness();let calls=0,writes=0,diagnostics=0;h.ports.verifyRevisionDecision=async()=>{calls++;return verifiedDecision();};h.ports.stdout={write(){writes++;throw Error('PRIVATE_OUTPUT');}};h.ports.stderr={write(){diagnostics++;}};
 assert.equal(await run(verifyDecisionArgs,h.ports),2);assert.equal(calls,1);assert.equal(writes,1);assert.equal(diagnostics,0);assert.deepEqual(h.records,[]);assert.deepEqual(h.reads,[]);
 const failed=harness();let errors=0;failed.ports.verifyRevisionDecision=async()=>{throw Error('PRIVATE_VERIFY');};failed.ports.stderr={write(){errors++;throw Error('PRIVATE_SINK');}};assert.equal(await run(verifyDecisionArgs,failed.ports),2);assert.equal(errors,1);
 const unopened=harness();unopened.ports.stdout={};let verifies=0;unopened.ports.verifyRevisionDecision=async()=>{verifies++;return verifiedDecision();};assert.equal(await run(verifyDecisionArgs,unopened.ports),2);assert.equal(verifies,0);
});
