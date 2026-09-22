import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_PERSONAL_MODEL_POLICY, validateModelPolicy } from "../src/personal/model-policy.js";
import { validateCapturedRawConfig } from "../src/personal/config.js";
import { TEST_MATERIAL } from "./helpers/personal-launch.js";
import { parsePhaseResult } from "../src/personal/phase-payload.js";
import { fixture, REQUEST } from "./helpers/workflow.js";
test("only implement and verify model profiles are accepted; obsolete configuration has migration errors",()=>{
 assert.deepEqual(validateModelPolicy(APPROVED_PERSONAL_MODEL_POLICY),APPROVED_PERSONAL_MODEL_POLICY);
 for(const key of ["plan","review","test","retro"])assert.throws(()=>validateModelPolicy({...APPROVED_PERSONAL_MODEL_POLICY,[key]:APPROVED_PERSONAL_MODEL_POLICY.verify}),/migrate/);
 const raw=JSON.parse(Buffer.from(TEST_MATERIAL.rawConfig,"base64").toString());
 for(const key of ["escalationPolicy","reportCorrectionPolicy","promptPolicy","remediationPolicy"]) assert.throws(()=>validateCapturedRawConfig({...raw,[key]:{}}),/retired.*remove/);
});
test("phase report is closed and versioned; never infer or correct malformed dispositions",async()=>{
 const f=await fixture();try{
 await f.controller.run(REQUEST); const i=f.calls[0]!,g=i.launchGeneration!;
 const valid={version:1,outputHead:"b".repeat(40),status:"passed",summary:"done",details:{changes:["change"],projectWiki:{status:"not_required",reason:"no durable knowledge"}}};
 for(const raw of ["", "{}",JSON.stringify({...valid,status:"remediation_required"}),JSON.stringify({...valid,runId:i.runId}),JSON.stringify({...valid,version:2}),JSON.stringify(valid).replace('"version":1','"version":1,"version":1')]) assert.throws(()=>parsePhaseResult(raw,i,g.sessionId,g.sessionFile,i.profile));
 assert.equal(parsePhaseResult(JSON.stringify(valid),i,g.sessionId,g.sessionFile,i.profile).status,"passed");
 }finally{await f.cleanup();}
});
