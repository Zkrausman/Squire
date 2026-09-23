import assert from "node:assert/strict";
import test from "node:test";
import { fixture, REQUEST } from "./helpers/workflow.js";
import { piJson } from "./helpers/pi-json.js";
import { invocation, TelemetryStore, validateRunTelemetry } from "../src/personal/telemetry-store.js";
test("preterminal cost gate rejects missing capture and sums authenticated Pi-recorded usage",async()=>{
 const f=await fixture();try{
  const state=await f.controller.run(REQUEST),store=new TelemetryStore(f.root);
  const [implement,verify]=f.calls;
  const first=invocation(implement!,implement!.launchGeneration!.sessionId,implement!.launchGeneration!.sessionFile);
  const second=invocation(verify!,verify!.launchGeneration!.sessionId,verify!.launchGeneration!.sessionFile);
  await store.begin(first);await store.end(first,piJson("report",first.sessionId,first.profile),true);
  await assert.rejects(store.cumulativeRecordedCost(state));
  await store.begin(second);await store.end(second,piJson("report",second.sessionId,second.profile),true);
  assert.equal(await store.cumulativeRecordedCost(state),"0.2");
 }finally{await f.cleanup();}
});

test("controller-owned telemetry inventories only two sessions and keeps terminal/CI/publication separate",async()=>{
 const f=await fixture();try{
  const state=await f.controller.run(REQUEST),store=new TelemetryStore(f.root);
  for(const input of f.calls){const g=input.launchGeneration!,id=invocation(input,g.sessionId,g.sessionFile);await store.begin(id);await store.end(id,piJson("report",g.sessionId,input.profile),true);await store.acceptPhase(input.runId,g.sessionId,"passed");}
  const telemetry=await store.finalize(state);validateRunTelemetry(telemetry,state.runId);
  assert.equal(telemetry.authority,"pi-controller-json-v2");
  validateRunTelemetry({ ...telemetry, authority: "pi-0.84.4-controller-json-v2" },state.runId);
  assert.equal(telemetry.sessions.length,2);assert.deepEqual(telemetry.phases.map(p=>p.phase),["implement","verify"]);
  assert.equal(telemetry.candidate,state.candidate);assert.equal(telemetry.publicationState,"published");assert.equal(telemetry.ciDisposition,"pending");assert.equal(telemetry.mergeDisposition,"not_merged");
  assert.ok(telemetry.sessions.every(s=>s.durationMs!==null));
  assert.deepEqual(await store.finalize(state),telemetry);
 }finally{await f.cleanup();}
});
