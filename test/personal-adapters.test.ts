import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { piJson } from "./helpers/pi-json.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { APPROVED_PERSONAL_MODEL_POLICY } from "../src/personal/model-policy.js";
import { generationIdentity } from "../src/personal/launch-retry.js";
import type { PhaseInput } from "../src/personal/types.js";
import type { CommandRequest } from "../src/personal/command.js";

for(const failing of [false,true])test(`fresh runner seals Verify source and deterministically executes configured commands (failure=${failing})`,async()=>{
 const root=await launchTestRoot("squire-runner-");const calls:CommandRequest[]=[];let data:any;let runner: SandboxPiPhaseRunner | undefined;
 try{
  runner=new SandboxPiPhaseRunner({stagingRoot:root,testCommands:["npm test"],commands:{byteOutput:true,async run(r){
   calls.push(r);
   if(r.args[0]==="cp")data=JSON.parse(await readFile(r.args[1]!,"utf8"));
   if(r.args.includes("--print")){
    const result={version:1,outputHead:"b".repeat(40),status:"passed",summary:"independent verification",details:data.phase==="implement"?{changes:["change"],projectWiki:{status:"not_required",reason:"no durable knowledge"}}:{findings:[],commands:[{command:"npm test",exitCode:0,summary:"passed"}]}};
    const bytes=piJson(JSON.stringify(result),data.sessionId,data.profile);return {stdout:bytes.toString(),stdoutBytes:bytes,stderr:""};
   }
   const stdout=r.args.at(-1)?.includes("SQUIRE_TEST_EXIT")?`output\nSQUIRE_TEST_EXIT=${failing?1:0}\n`:"";
   return {stdout,stdoutBytes:Buffer.from(stdout),stderr:""};
  }}});
  for(const phase of ["implement","verify"] as const){
   const i:PhaseInput={runId:"aidev-1-adapter123",ticket:{id:"AIDEV-1",title:"contract",description:"do it"},repository:"example/repo",baseBranch:"main",branch:"feature",sandbox:"fixture",phase,attempt:1,expectedHead:phase==="implement"?"a".repeat(40):"b".repeat(40),originalTicketBaseSha:"a".repeat(40),profile:APPROVED_PERSONAL_MODEL_POLICY[phase],contractDigest:"a".repeat(64),testCommands:["npm test"],launchGeneration:generationIdentity(phase,1,0,phase==="implement"?"11111111-1111-4111-8111-111111111111":"22222222-2222-4222-8222-222222222222")};
   if(failing&&phase==="verify")await assert.rejects(runner.run(i),/command disagrees/);else assert.equal((await runner.run(i)).phase,phase);
  }
  const models=calls.filter(r=>r.args.includes("--print"));assert.equal(models.length,2);
  assert.equal(models[0]!.args[models[0]!.args.indexOf("--tools")+1],"read,grep,find,ls,bash,edit,write");
  assert.equal(models[1]!.args[models[1]!.args.indexOf("--tools")+1],"read,grep,find,ls,bash");
  assert.ok(models[1]!.args.includes("--no-new-privs"));
  assert.ok(calls.some(r=>r.args.at(-1)?.includes("chmod -R a-w .git")));
  assert.equal(calls.filter(r=>r.args.at(-1)?.includes("SQUIRE_TEST_EXIT")).length,1);
 }finally{await runner?.reportEvidence.release?.();await rm(root,{recursive:true,force:true});}
});
