import { readFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { validatePhaseResultPayloadShape } from "../dist/src/personal/phase-result.js";
const ajv = new Ajv({strict:true});
for(const phase of ["implement","verify"]){
 const schema=JSON.parse(await readFile(new URL(`../contracts/v2/${phase}-result.schema.json`,import.meta.url),"utf8"));
 const validate=ajv.compile(schema);
 const valid={version:1,outputHead:"a".repeat(40),status:"passed",summary:"bounded evidence",details:phase==="implement"?{changes:["change"],projectWiki:{status:"not_required",reason:"no durable knowledge"}}:{findings:[],commands:[{command:"npm test",exitCode:0,summary:"passed"}]}};
 assert.ok(validate(valid));validatePhaseResultPayloadShape(valid,phase);
 for(const invalid of [{...valid,unexpected:true},{...valid,status:"remediation_required"},{...valid,version:2},{...valid,details:{...valid.details,unbounded:"extension"}}]){
  assert.equal(validate(invalid),false);assert.throws(()=>validatePhaseResultPayloadShape(invalid,phase));
 }
}
console.log("Validated two closed versioned phase schemas and negative probes");
const { default: addFormats } = await import("ajv-formats");
addFormats(ajv);
const { createRunEvent, validateRunEvent, RUN_EVENT_TYPES } = await import("../dist/src/personal/run-events.js");
const eventSchema = JSON.parse(await readFile(new URL("../contracts/v2/run-event.schema.json",import.meta.url),"utf8"));
assert.deepEqual(eventSchema.properties.type.enum,RUN_EVENT_TYPES);
const validateEvent=ajv.compile(eventSchema);
const event=createRunEvent({runId:"aidev-1-schema123",ticketId:"AIDEV-1",stateRevision:1,timestamp:"2026-01-01T00:00:00.000Z",type:"phase_started",phase:"verify",attempt:1});
assert.ok(validateEvent(event));validateRunEvent(event);
for(const phase of ["plan","review","test","retro"]){assert.equal(validateEvent({...event,phase}),false);assert.throws(()=>validateRunEvent({...event,phase}));}
console.log("Validated v2 event schema with retired-phase rejection");
