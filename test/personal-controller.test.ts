import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, report, REQUEST, HEAD, BASE } from "./helpers/workflow.js";
import { PERSONAL_PHASES } from "../src/personal/types.js";
import { historicalStatus } from "../src/personal/historical-state.js";

test("clean Contract → Implement → independent Verify has exactly two sessions and exact publication",async () => {
 const f=await fixture(); try {
  const state=await f.controller.run(REQUEST);
  assert.deepEqual(PERSONAL_PHASES,["implement","verify"]);
  assert.deepEqual(f.calls.map(i=>i.phase),["implement","verify"]);
  assert.notEqual(f.calls[0]!.launchGeneration!.sessionId,f.calls[1]!.launchGeneration!.sessionId);
  assert.equal(f.calls[0]!.expectedHead,BASE); assert.equal(f.calls[1]!.expectedHead,HEAD);
  assert.deepEqual(f.calls[1]!.testCommands,["npm test"]);
  assert.equal(state.contract?.ticket.description,"immutable requirement");
  assert.equal(state.candidate,HEAD); assert.equal(state.verifyDisposition,"passed");
  assert.equal(state.publicationState,"published"); assert.equal(state.ciDisposition,"pending"); assert.equal(state.mergeDisposition,"not_merged");
  assert.equal(f.publications[0]!.head,HEAD); assert.equal(state.status,"completed");
  assert.equal(await f.states.reservationOwner(REQUEST.ticketId),undefined);
  const before=await readFile(path.join(f.root,`${state.runId}.json`));
  await assert.rejects(f.states.save({...state,version:state.version+1}),/immutable/);
  assert.deepEqual(await readFile(path.join(f.root,`${state.runId}.json`)),before);
 } finally { await f.cleanup(); }
});

for(const scenario of ["failed-implement","malformed","missing","failed-verify","findings","missing-command","failed-command","duplicate-command","mutation","dirty","unchanged","reused-session","timeout","publish-failure"]){
 test(`${scenario} terminalizes once without another model session or promotion`,async()=>{
  let firstSession="";
  const f=await fixture({publish(){if(scenario==="publish-failure")throw Error("publication failure");},async phase(i,w){
    if(i.phase==="implement")firstSession=i.launchGeneration!.sessionId;
    const r=report(i);
    if(i.phase==="implement"){
      if(scenario==="malformed")throw Error("malformed phase JSON");
      if(scenario==="missing")return undefined as never;
      if(scenario==="timeout")throw Error("phase deadline exhausted");
      if(scenario==="failed-implement")return {...r,status:"failed"};
      if(scenario==="unchanged"){w.head=BASE;return {...r,outputHead:BASE};}
    } else if(r.phase==="verify"){
      if(scenario==="mutation")w.head="c".repeat(40);
      if(scenario==="dirty")w.dirty=true;
      if(scenario==="failed-verify")return {...r,status:"failed"};
      if(scenario==="reused-session")return {...r,sessionId:firstSession};
      if(scenario==="findings")return {...r,details:{...r.details,findings:["security defect"]}};
      if(scenario==="missing-command")return {...r,details:{...r.details,commands:[]}};
      if(scenario==="failed-command")return {...r,details:{...r.details,commands:[{command:"npm test",exitCode:1,summary:"failed"}]}};
      if(scenario==="duplicate-command")return {...r,details:{...r.details,commands:[...r.details.commands,...r.details.commands]}};
    } return r;
  }});
  try {
    await assert.rejects(f.controller.run(REQUEST));
    const state=(await f.states.findByTicket(REQUEST.ticketId))[0]!;
    assert.equal(state.status,"failed"); assert.ok(state.terminalReason); assert.ok(state.candidate);
    assert.ok(f.calls.length<=2); assert.equal(f.publications.length,scenario==="publish-failure"?1:0);
    await assert.rejects(f.controller.runReserved(REQUEST,state.runId,"a".repeat(64)));
    assert.equal((await f.states.readEvents(state.runId)).filter(e=>e.type==="terminal_failed").length,1);
    const bytes=await readFile(path.join(f.root,`${state.runId}.json`));
    await f.controller.failReserved(state.runId,Error("later diagnostic"));
    assert.deepEqual(await readFile(path.join(f.root,`${state.runId}.json`)),bytes);
  } finally {await f.cleanup();}
 });
}

test("historical v1 records are display-only and cannot be saved, claimed or executed",async()=>{
 const f=await fixture();try{
  const state=await f.controller.reserve(REQUEST);
  const legacy={...state,schemaVersion:1,step:"review",attempts:{plan:1,implement:1,review:1,test:0,retro:0}};
  await writeFile(path.join(f.root,`${state.runId}.json`),JSON.stringify(legacy));
  assert.match((await historicalStatus(f.root,state.runId))!,/read-only/);
  await assert.rejects(f.states.read(state.runId),/historical/);
  await assert.rejects(f.states.save({...state,version:2}));
  await assert.rejects(f.controller.runReserved(REQUEST,state.runId,"a".repeat(64)));
  assert.equal(f.calls.length,0);
 }finally{await f.cleanup();}
});
