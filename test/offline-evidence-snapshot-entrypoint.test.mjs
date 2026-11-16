import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {artifactCliChild as child} from './helpers/artifact-cli-child.mjs';
import {runPhysicalEvidenceCli as physical} from '../bin/squire-physical-evidence.mjs';
import {runProjectPortableCandidateSnapshotCli as portable} from '../src/project-portable-candidate-snapshot.mjs';
const physicalUrl=new URL('../bin/squire-physical-evidence.mjs',import.meta.url);
const portableUrls=[new URL('../bin/squire-portable-candidate.mjs',import.meta.url),new URL('../src/project-portable-candidate-snapshot.mjs',import.meta.url)];
const physicalUsage='Usage: node bin/squire-physical-evidence.mjs verify <absolute-attempt-dir> <expected-manifest-sha256> [--json]\n';
const portableUsage='Usage: node bin/squire-portable-candidate.mjs --build <spec.json> | --verify <snapshot-dir>\n       node bin/squire-portable-candidate.mjs --verify <snapshot-dir> --expect-sha256 <expected-manifest-sha256>\n';
const args=['verify','/tmp/synthetic/attempts/8d9ee341-6fa3-4acc-8b93-000000000001','a'.repeat(64)];
const result=()=>({status:'PHYSICAL_EVIDENCE_COPY_VERIFIED',copy_integrity:'VERIFIED',acknowledgement:'UNKNOWN'});
for(const url of [physicalUrl,...portableUrls]){
 const failure=url===physicalUrl?1:2,usage=url===physicalUrl?physicalUsage:portableUsage;
 test(`remaining offline executable closed stderr ${url.pathname.split('/').slice(-2).join('/')}`,async()=>{
  const r=await child(url,[],{closed:'stderr'});assert.equal(r.code,failure);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
 });
 for(const timing of ['early','late'])test(`remaining offline stderr ${timing} ${url.pathname.split('/').slice(-2).join('/')}`,async()=>{
  const before=`const stream=process.stderr,write=stream.write.bind(stream);stream.write=(...args)=>{const r=write(...args);${timing==='early'?"stream.emit('error',Error('PRIVATE_ERROR'));":"setImmediate(()=>stream.emit('error',Error('PRIVATE_ERROR')));"}return r;};`;
  const r=await child(url,[],{before});assert.equal(r.code,failure);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,usage);
 });
 test(`remaining offline healthy usage ${url.pathname.split('/').slice(-2).join('/')}`,async()=>{
  const r=await child(url,[]);assert.equal(r.code,2);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,usage);
 });
}
test('physical executable closed stdout and healthy help',async()=>{
 const r=await child(physicalUrl,['--help'],{closed:'stdout'});assert.equal(r.code,1);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
 const h=await child(physicalUrl,['--help']);assert.equal(h.code,0);assert.equal(h.stdout,physicalUsage);assert.equal(h.stderr,'');
});
for(const timing of ['early','late'])test(`physical stdout ${timing}`,async()=>{
 const before=`const stream=process.stdout,write=stream.write.bind(stream);stream.write=(...args)=>{const r=write(...args);${timing==='early'?"stream.emit('error',Error('PRIVATE_ERROR'));":"setImmediate(()=>stream.emit('error',Error('PRIVATE_ERROR')));"}return r;};`;
 const r=await child(physicalUrl,['--help'],{before});assert.equal(r.code,1);assert.equal(r.signal,null);assert.equal(r.stdout,physicalUsage);assert.equal(r.stderr,'');
});
test('physical synchronous sink capture is bounded, inert and private',async()=>{
 for(const sink of [{},{write:4},Object.defineProperty({},'write',{get(){throw Error('PRIVATE_GETTER');}})]){
  let calls=0;const code=await physical(args,{stdout:sink,stderr:{write(){throw Error('PRIVATE_FALLBACK');}},verify(){calls++;return result();}});assert.equal(code,1);assert.equal(calls,0);
 }
 let calls=0;assert.equal(await physical(args,{get stdout(){throw Error('PRIVATE_PORT');},verify(){calls++;}}),1);assert.equal(calls,0);
});
test('physical sync acknowledgement failure suppresses output fallback and never repeats verification',async()=>{
 let calls=0,writes=0,diagnostics=0,partial='';
 assert.equal(await physical(args,{verify(){calls++;return result();},stdout:{write(s){writes++;partial+=s.slice(0,5);throw Error('PRIVATE_WRITE');}},stderr:{write(){diagnostics++;}}}),1);
 assert.equal(calls,1);assert.equal(writes,1);assert.equal(diagnostics,0);assert.ok(partial.length>0);
 const stream={text:'',write(s){assert.equal(this,stream);this.text+=s;return false;}};
 assert.equal(await physical(args,{verify:result,stdout:stream,stderr:{write(){throw Error('UNEXPECTED');}}}),0);assert.equal(stream.text,'COPY_INTEGRITY_VERIFIED ACKNOWLEDGEMENT_UNKNOWN\n');
});
test('physical usage and verifier rejection failing diagnostics stay fixed non-success',async()=>{
 let writes=0;assert.equal(await physical([],{stderr:{write(){writes++;throw Error('PRIVATE_USAGE');}}}),2);assert.equal(writes,1);
 writes=0;assert.equal(await physical(args,{verify(){throw Error('PRIVATE_OPERATION');},stderr:{write(){writes++;throw Error('PRIVATE_DIAGNOSTIC');}}}),1);assert.equal(writes,1);
});
test('portable sync usage and operation rejection cannot expose sink errors',async()=>{
 const root=await fs.mkdtemp('/tmp/squire-offline-sink-');
 try{
  for(const argv of [[],['--verify',join(root,'missing')]]){
   let writes=0;assert.equal(await portable(argv,{stdout:{write(){}},stderr:{write(){writes++;throw Error('PRIVATE_SINK');}}}),2);assert.equal(writes,1);
  }
  let diagnostic='';assert.equal(await portable(['--verify',join(root,'missing')],{stdout:{write(){throw Error('UNEXPECTED');}},stderr:{write:s=>diagnostic+=s}}),2);assert.equal(diagnostic,'PROJECT_PORTABLE_SNAPSHOT_INVALID\n');
  for(const sink of [{},{write:4},Object.defineProperty({},'write',{get(){throw Error('PRIVATE_GETTER');}})])assert.equal(await portable([],{stdout:sink}),2);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('all remaining offline imports leave process listeners/output/exit inert',()=>{
 const source=`const before=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];for(const u of ${JSON.stringify([physicalUrl,...portableUrls].map(x=>x.href))})await import(u);const after=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];if(JSON.stringify(before)!==JSON.stringify(after))throw Error('IMPORT_CHANGED');`;
 const r=spawnSync(process.execPath,['--input-type=module','--eval',source],{encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(r.error,undefined);assert.equal(r.status,0);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});

test('portable expected-digest malformed grammar accesses no filesystem or verifier input',()=>{
 const source=`import f from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';let reads=0;for(const key of ['lstat','realpath','open','opendir','mkdir','chmod'])f[key]=async()=>{reads++;throw Error('SYNTHETIC_UNWANTED_ACCESS');};syncBuiltinESMExports();const observed=await import('node:fs/promises');try{await observed.lstat('/synthetic/hook-check');}catch{}if(reads!==1)throw Error('HOOK_NOT_ACTIVE');reads=0;const {runProjectPortableCandidateSnapshotCli:run}=await import(${JSON.stringify(portableUrls[1].href)});const h='a'.repeat(64),p='/synthetic/snapshot',good=['--verify',p,'--expect-sha256',h],sparse=[...good];delete sparse[3];const bad=[[],['--help'],['--verify',p,'--expect-sha256'],[...good,'extra'],['--verify',p,h,'--expect-sha256'],['--build',p,'--expect-sha256',h],['--verify','relative','--expect-sha256',h],['--verify','/synthetic/../snapshot','--expect-sha256',h],sparse,...['',null,undefined,7,{},new String(h),'A'.repeat(64),'g'.repeat(64),'a'.repeat(63),'a'.repeat(65),...[[10],[13],[13,10],[0x2028],[0x2029]].map(v=>h+String.fromCodePoint(...v))].map(v=>['--verify',p,'--expect-sha256',v])];for(const args of bad){let out='',err='';const code=await run(args,{stdout:{write:s=>out+=s},stderr:{write:s=>err+=s}});if(code!==2||out!==''||err!==${JSON.stringify(portableUsage)}||reads!==0)throw Error('GRAMMAR_OR_ACCESS_FAILURE');}`;
 const r=spawnSync(process.execPath,['--input-type=module','--eval',source],{encoding:'utf8',timeout:10000,maxBuffer:65536});assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});
