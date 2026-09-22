import assert from "node:assert/strict";
import test from "node:test";
import { unlink } from "node:fs/promises";
import { fixture, report, REQUEST } from "./helpers/workflow.js";
import { RunEventConsumer } from "../src/personal/run-watcher.js";
import { synthesizeCurrentRunEvents, validateRunEvent, RUN_EVENT_TYPES } from "../src/personal/run-events.js";

test("Linux/Windows filesystem integration observes atomic state/outbox replacements and delivers one terminal event",async()=>{
 let enter!:()=>void, release!:()=>void;
 const ready=new Promise<void>(r=>enter=r), blocked=new Promise<void>(r=>release=r);
 const f=await fixture({async phase(i){if(i.phase==="implement"){enter();await blocked;} return report(i);}});
 try {
  const run=f.controller.run(REQUEST); await ready;
  const events: string[]=[];
  const consumer=new RunEventConsumer({states:f.states,selector:REQUEST.ticketId,reconcileIntervalMs:10,debounceMs:0,onEvent(e){validateRunEvent(e);events.push(e.eventId);}});
  const watching=consumer.watch(); watching.catch(()=>undefined); await new Promise(r=>setTimeout(r,100)); release(); const state=await run; const seen=await watching;
  assert.equal(seen.state.status,"completed");assert.equal(new Set(events).size,events.length);
  assert.equal((await f.states.readEvents(state.runId)).filter(e=>e.type==="terminal_succeeded").length,1);
  await unlink(f.states.eventPath(state.runId));
  const reconstructed=synthesizeCurrentRunEvents(state); reconstructed.forEach(validateRunEvent);
  assert.equal(reconstructed.filter(e=>e.type==="phase_started").length,2);
  assert.ok(RUN_EVENT_TYPES.every(type=>! /remediation|correction|staged/u.test(type)));
 }finally{release();await f.cleanup();}
});
