import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeTrace,calibrationReport} from '../src/benchmark-report.mjs';
import {Controller} from '../src/controller.mjs';
import {Blocker} from '../src/contracts.mjs';
import {fixture,FixtureRuntime} from './support.mjs';
test('trace metrics count unique jobs, unknown and pending usage separately without double summing tokens',()=>{
 const usage={input_tokens:100,cached_input_tokens:80,output_tokens:20,reasoning_output_tokens:10};
 const events=[{type:'job.started',jobId:'a',role:'implement'},{type:'job.finished',jobId:'a',role:'implement',outcome:'completed',usage},{type:'job.finished',jobId:'a',outcome:'completed',usage},{type:'job.started',jobId:'b',role:'review'},{type:'job.finished',jobId:'b',outcome:'failed',receipt:{timedOut:true}},{type:'job.started',jobId:'c',role:'implement'},{type:'ticket.correction_authorized'}];
 const report=summarizeTrace(events,{startedAt:10,endedAt:30});
 assert.equal(report.sessions,3);assert.deepEqual(report.sessionsByRole,{implement:2,review:1});assert.equal(report.pendingSessions,1);assert.equal(report.unknownUsageSessions,1);assert.equal(report.timeouts,1);assert.equal(report.rework,1);assert.equal(report.elapsedMs,20);assert.equal(report.tokenTotalsComplete,false);assert.equal(report.tokens.noncachedInput,20);assert.equal(report.tokens.output,20);
});
test('conflicting usage is unknown and missing timing stays null',()=>{
 const summary=summarizeTrace([{type:'job.finished',jobId:'a',outcome:'completed',usage:{input_tokens:10,cached_input_tokens:5,output_tokens:1}},{type:'job.finished',jobId:'a',outcome:'completed',usage:{input_tokens:20,cached_input_tokens:5,output_tokens:1}}]);
 assert.equal(summary.tokens.input,0);assert.equal(summary.unknownUsageSessions,1);assert.equal(summary.elapsedMs,null);
});
test('unscored reports keep supplied new-behavior and preservation observations separate',()=>{
 const report=observations=>calibrationReport({task:'synthetic-observations',observations,processReceipt:{exitCode:0,timedOut:false}});
 const correct=report({newBehavior:{passed:true},preservation:{passed:true}}),broken=report({newBehavior:{passed:false},preservation:{passed:false}});
 assert.equal(correct.accepted,true);assert.equal(correct.newBehavior.passed,true);assert.equal(correct.preservation.passed,true);
 assert.equal(broken.accepted,false);assert.equal(broken.newBehavior.passed,false);assert.equal(broken.preservation.passed,false);
 for(const report of [correct,broken]){assert.equal(report.scored,false);assert.equal(report.score,null);assert.equal(report.modelPerformanceMeasured,false);assert.equal(report.metrics.sessions,0);assert.equal(report.processReceipt.exitCode,0);}
});
test('process failure cannot pass even if supplied observations claim success',()=>{
 assert.equal(calibrationReport({task:'x',observations:{newBehavior:{passed:true},preservation:{passed:true}},processReceipt:{exitCode:0,timedOut:true}}).accepted,false);
});
test('stopped process cannot pass with exit zero and passing observations',()=>{
 const report=calibrationReport({task:'synthetic-observations',observations:{newBehavior:{passed:true},preservation:{passed:true}},processReceipt:{exitCode:0,timedOut:false,stopped:true,outputExceeded:false}});
 assert.equal(report.accepted,false);
});
test('output-limited process cannot pass with exit zero and passing observations',()=>{
 const report=calibrationReport({task:'synthetic-observations',observations:{newBehavior:{passed:true},preservation:{passed:true}},processReceipt:{exitCode:0,timedOut:false,stopped:false,outputExceeded:true}});
 assert.equal(report.accepted,false);
});
test('actual controller trace retains timed-out reservations and final unknown usage without changing the thrown blocker',async t=>{
 const f=await fixture(t),runtime=new FixtureRuntime();
 runtime.execute=async()=>{throw new Blocker('runtime_failed','Stopped',{receipt:{startedAt:10,endedAt:30,exitCode:1,stopped:true,timedOut:true}});};
 const controller=new Controller(f.store,f.config.id,{runtime});
 await assert.rejects(controller.callAgent('implement',f.seed,f.root,'control'),error=>error.code==='runtime_failed');
 const events=f.store.events(f.config.id,0,1000),metrics=summarizeTrace(events,{startedAt:10,endedAt:30});
 assert.equal(f.store.get(f.config.id).agentCalls,1);assert.equal(metrics.sessions,1);assert.equal(metrics.timeouts,1);assert.equal(metrics.unknownUsageSessions,1);assert.equal(metrics.pendingSessions,0);
 assert.ok(events.find(event=>event.type==='job.started').jobId);
});
