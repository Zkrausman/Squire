import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {artifactCliChild as child} from './helpers/artifact-cli-child.mjs';
const packageUrl=new URL('../bin/squire-package.mjs',import.meta.url);
const projects=[new URL('../bin/squire-project-review.mjs',import.meta.url),new URL('../src/project-review-candidate.mjs',import.meta.url)];
const help='Usage: node bin/squire-project-review.mjs <--build|--revise|--build-standard|--revise-standard> <spec.json>\n';
const usage='Usage: node bin/squire-project-review.mjs --build <spec.json>\n';
const packageUsage='Usage: node bin/squire-package.mjs --build <receipt> <source> <output-dir> | --verify <output-dir>\n';
for(const url of [packageUrl,...projects]){
 test(`artifact executable closed stderr: ${url.pathname.split('/').slice(-2).join('/')}`,async()=>{
  const r=await child(url,[],{closed:'stderr'});assert.equal(r.code,2);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
 });
 for(const timing of ['early','late'])test(`artifact executable stderr ${timing}: ${url.pathname.split('/').slice(-2).join('/')}`,async()=>{
  const before=`const stream=process.stderr,write=stream.write.bind(stream);stream.write=(...args)=>{const result=write(...args);
   ${timing==='early'?"stream.emit('error',Error('PRIVATE_STREAM_ERROR'));":"setImmediate(()=>stream.emit('error',Error('PRIVATE_STREAM_ERROR')));"}return result;};`;
  const r=await child(url,[],{before});assert.equal(r.code,2);assert.equal(r.signal,null);assert.equal(r.stdout,'');
  assert.equal(r.stderr,url===packageUrl?packageUsage:usage);
 });
}
for(const url of projects){
 test(`artifact project closed stdout: ${url.pathname.split('/').slice(-2).join('/')}`,async()=>{
  const r=await child(url,['--help'],{closed:'stdout'});assert.equal(r.code,2);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
 });
 for(const timing of ['early','late'])test(`artifact project stdout ${timing}: ${url.pathname.split('/').slice(-2).join('/')}`,async()=>{
  const before=`const stream=process.stdout,write=stream.write.bind(stream);stream.write=(...args)=>{const result=write(...args);
   ${timing==='early'?"stream.emit('error',Error('PRIVATE_STREAM_ERROR'));":"setImmediate(()=>stream.emit('error',Error('PRIVATE_STREAM_ERROR')));"}return result;};`;
  const r=await child(url,['--help'],{before});assert.equal(r.code,2);assert.equal(r.signal,null);assert.equal(r.stdout,help);assert.equal(r.stderr,'');
 });
 test(`artifact project healthy help and usage: ${url.pathname.split('/').slice(-2).join('/')}`,async()=>{
  const h=await child(url,['--help']);assert.equal(h.code,0);assert.equal(h.signal,null);assert.equal(h.stdout,help);assert.equal(h.stderr,'');
  const u=await child(url,[]);assert.equal(u.code,2);assert.equal(u.signal,null);assert.equal(u.stdout,'');assert.equal(u.stderr,usage);
 });
}
test('artifact executable modules stay inert when imported',()=>{
 const source=`const before=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];
 for(const url of ${JSON.stringify([packageUrl,...projects].map(u=>u.href))})await import(url);
 const after=[process.stdout.listenerCount('error'),process.stderr.listenerCount('error'),process.exitCode];
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('IMPORT_CHANGED_PROCESS');`;
 const r=spawnSync(process.execPath,['--input-type=module','--eval',source],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 assert.equal(r.error,undefined);assert.equal(r.status,0);assert.equal(r.signal,null);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});
