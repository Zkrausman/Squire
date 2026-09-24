import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePi, reviewPassed, exactHeadPassed} from '../gates.mjs';

const message=(stopReason='stop')=>JSON.stringify({type:'message_end',message:{role:'assistant',stopReason,content:[{type:'text',text:'ready'}],usage:{input:1,output:2,cacheRead:3,cacheWrite:4,cost:{total:0.5}}}});
test('Pi requires successful settlement, not just an accepted prompt or agent_end',()=>{
  assert.throws(()=>parsePi(message()),/settle/);
  assert.throws(()=>parsePi(message('length')+'\n'+JSON.stringify({type:'agent_settled'})),/settle/);
  assert.throws(()=>parsePi('not-json\n'),/JSONL/);
  const out=parsePi(message()+'\n'+JSON.stringify({type:'agent_settled'})+'\n');
  assert.equal(out.text,'ready');assert.equal(out.usage.cost,0.5);
});
test('independent review fails closed on ambiguous or incomplete verdict',()=>{
  for(const value of ['PASS','BLOCK\nPASS',' PASS\n','PASS: yes\n','PASS\n'+ 'a'.repeat(16000)])assert.equal(reviewPassed(value),false);
  assert.equal(reviewPassed('PASS\nNo blockers.'),true);
});
test('exact-head gate rejects moved, closed, missing, pending, failed and skipped checks',()=>{
  const pr={state:'OPEN',headRefOid:'a'.repeat(40),baseRefName:'main'};
  const checks=[{name:'test',bucket:'pass',state:'SUCCESS'},{name:'windows-link-check',bucket:'pass',state:'SUCCESS'}];
  const v={pr,expectedHead:pr.headRefOid,expectedBase:'main',checks,required:['test','windows-link-check']};
  assert.equal(exactHeadPassed(v),true);
  for(const [key,value] of [['expectedHead','b'.repeat(40)],['expectedBase','other'],['checks',[checks[0]]],['checks',[checks[0],{...checks[1],bucket:'pending'}]],['checks',[checks[0],{...checks[1],bucket:'skipping'}]],['checks',[...checks,{name:'security',bucket:'fail'}]],['required',['test','test']]])assert.equal(exactHeadPassed({...v,[key]:value}),false,key);
  assert.equal(exactHeadPassed({...v,pr:{...pr,state:'MERGED'}}),false);
});
