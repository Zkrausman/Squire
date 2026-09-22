import assert from "node:assert/strict";
import test from "node:test";
import { classifyLaunchFailure, TransientLaunchFailure, providerLaunchFailure, DAYBREAK_BLUE, generationIdentity } from "../src/personal/launch-retry.js";
import { piEvents, fixtureProfile, fixtureSession, jsonLines } from "./helpers/pi-json.js";
test("provider retry retains its typed no-effects allowlist, rejects ordinary model errors and tool turns",()=>{
 assert.equal(classifyLaunchFailure(Error(DAYBREAK_BLUE)),undefined);
 assert.equal(classifyLaunchFailure(new TransientLaunchFailure("process-spawn-unavailable")),"process-spawn-unavailable");
 const events=piEvents("",fixtureSession,fixtureProfile);const m=(events[6] as any).message;
 m.content=[];m.stopReason="error";m.errorMessage=DAYBREAK_BLUE;delete m.responseId;
 m.usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 events[5].message={...m,stopReason:"pending"};
 const input={profile:fixtureProfile,launchGeneration:generationIdentity("implement",1,0,fixtureSession)};
 assert.ok(providerLaunchFailure(jsonLines(events),input));
 m.content=[{type:"text",text:"accepted result"}];assert.equal(providerLaunchFailure(jsonLines(events),input),undefined);
 m.content=[];m.usage.input=1;assert.equal(providerLaunchFailure(jsonLines(events),input),undefined);
});

import { fixture, report, REQUEST } from "./helpers/workflow.js";
test("one zero-effect provider replacement never replays an accepted phase",async()=>{
 let rejected=false;
 const f=await fixture({retries:1,async phase(i,w){if(i.phase==="verify"&&!rejected){rejected=true;throw new TransientLaunchFailure("process-spawn-unavailable");}return report(i);}});
 try{const s=await f.controller.run(REQUEST);assert.equal(s.status,"completed");assert.deepEqual(f.calls.map(i=>i.phase),["implement","verify","verify"]);assert.equal(s.attempts.implement,1);assert.equal(s.attempts.verify,1);assert.equal(f.calls[2]!.launchGeneration!.generation,1);assert.equal(f.calls[1]!.deadline,f.calls[2]!.deadline);}finally{await f.cleanup();}
});
test("ordinary failed Verify never enters launch replacement even with retry enabled",async()=>{
 const f=await fixture({retries:1,async phase(i){const r=report(i);return i.phase==="verify"?{...r,status:"failed"}:r;}});
 try{await assert.rejects(f.controller.run(REQUEST));assert.equal(f.calls.length,2);}finally{await f.cleanup();}
});
