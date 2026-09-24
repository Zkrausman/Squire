import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { piJson } from "./helpers/pi-json.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { DockerSandboxWorkspace } from "../src/personal/docker-sandbox.js";
import { generationIdentity } from "../src/personal/launch-retry.js";
import { APPROVED_PERSONAL_MODEL_POLICY } from "../src/personal/model-policy.js";
import { verifyReportEvidence } from "../src/personal/report-evidence.js";
import type { PhaseInput, VerifyPhaseResult, ImplementPhaseResult } from "../src/personal/types.js";
import type { CommandRequest } from "../src/personal/command.js";

const A="b".repeat(40),B="c".repeat(40),BASE="a".repeat(40);
test("second-attempt Pi sessions use exclusive files; host custody retains both old sessions",async()=>{
 const root=await launchTestRoot("correction-adapter-"); const calls:CommandRequest[]=[];let data:any;
 const runner=new SandboxPiPhaseRunner({stagingRoot:root,testCommands:["npm test"],commands:{byteOutput:true,async run(request){
  calls.push(request);
  if(request.args[0]==="cp")data=JSON.parse(await readFile(request.args[1]!,"utf8"));
  if(request.args.includes("--print")){
   const payload={version:1,outputHead:B,status:"passed",summary:"fresh verification",details:{findings:[],commands:[{command:"npm test",exitCode:0,summary:"passed"}]}};
   const bytes=piJson(JSON.stringify(payload),data.sessionId,data.profile);return {stdout:bytes.toString(),stdoutBytes:bytes,stderr:""};
  }
  if(request.args.includes("cat")){const bytes=Buffer.from(`session ${request.args.at(-1)}`);return {stdout:bytes.toString(),stdoutBytes:bytes,stderr:""};}
  const stdout=request.args.at(-1)?.includes("SQUIRE_TEST_EXIT")?"\nSQUIRE_TEST_EXIT=0\n":"";
  return {stdout,stdoutBytes:Buffer.from(stdout),stderr:""};
 }}});
 try{
  const runId="aidev-1-adapter123";
  const id="33333333-3333-4333-8333-333333333333";
  const input:PhaseInput={runId,ticket:{id:"AIDEV-1",title:"contract",description:"correct this"},repository:"example/repo",baseBranch:"main",branch:"feature",sandbox:"fixture",phase:"verify",attempt:2,expectedHead:B,originalTicketBaseSha:BASE,profile:APPROVED_PERSONAL_MODEL_POLICY.verify,contractDigest:"a".repeat(64),testCommands:["npm test"],launchGeneration:generationIdentity("verify",2,0,id)};
  assert.equal((await runner.run(input)).attempt,2);
  const prepare=calls.find(r=>r.args.at(-1)?.includes("chown root:root '/ticket/sessions/verify'"));
  assert.ok(prepare);assert.match(prepare!.args.at(-1)!,/chown '1000:1000' '\/ticket\/sessions\/verify\/2\.jsonl'/);
  assert.ok(!prepare!.args.at(-1)!.includes("chown -R '1000:1000' '/ticket/sessions/verify'"));
  const implement={runId,phase:"implement",attempt:1,sessionId:"11111111-1111-4111-8111-111111111111",sessionFile:generationIdentity("implement",1,0,"11111111-1111-4111-8111-111111111111").sessionFile,inputHead:BASE,outputHead:A,status:"passed",summary:"implemented",details:{changes:["change"],projectWiki:{status:"not_required",reason:"no wiki"}},profile:APPROVED_PERSONAL_MODEL_POLICY.implement} as ImplementPhaseResult;
  const verify={...implement,phase:"verify",sessionId:"22222222-2222-4222-8222-222222222222",sessionFile:generationIdentity("verify",1,0,"22222222-2222-4222-8222-222222222222").sessionFile,inputHead:A,outputHead:A,status:"failed",details:{findings:["defect"],commands:[{command:"npm test",exitCode:0,summary:"passed"}]},profile:APPROVED_PERSONAL_MODEL_POLICY.verify} as VerifyPhaseResult;
  const refs=await runner.archiveCorrectionSessions({runId,sandbox:"fixture",implement,verify});
  assert.equal(refs.implement.chunks.length,1);assert.equal(refs.verify.chunks.length,1);
  for(const custody of [refs.implement,refs.verify]) assert.equal((await verifyReportEvidence(runner.reportEvidence,custody.chunks[0]!)).length,custody.byteLength);
  assert.equal(calls.filter(r=>r.args.includes("cat")).length,2);
 }finally{await runner.reportEvidence.release?.();await rm(root,{recursive:true,force:true});}
});

test("failed Verify report with matching host nonzero test is accepted as failed, not passed",async()=>{
 const root=await launchTestRoot("correction-command-");let data:any;
 const runner=new SandboxPiPhaseRunner({stagingRoot:root,testCommands:["npm test"],commands:{byteOutput:true,async run(r){
  if(r.args[0]==="cp")data=JSON.parse(await readFile(r.args[1]!,"utf8"));
  if(r.args.includes("--print")){
   const payload={version:1,outputHead:A,status:"failed",summary:"test defect",details:{findings:["deterministic regression"],commands:[{command:"npm test",exitCode:1,summary:"regression"}]}};
   const bytes=piJson(JSON.stringify(payload),data.sessionId,data.profile);return {stdout:bytes.toString(),stdoutBytes:bytes,stderr:""};
  }
  const stdout=r.args.at(-1)?.includes("SQUIRE_TEST_EXIT")?"failure evidence\nSQUIRE_TEST_EXIT=1\n":"";
  return {stdout,stdoutBytes:Buffer.from(stdout),stderr:""};
 }}});
 try{
  const id="44444444-4444-4444-8444-444444444444";
  const input:PhaseInput={runId:"aidev-1-adapter456",ticket:{id:"AIDEV-1",title:"contract",description:"do it"},repository:"example/repo",baseBranch:"main",branch:"feature",sandbox:"fixture",phase:"verify",attempt:1,expectedHead:A,originalTicketBaseSha:BASE,profile:APPROVED_PERSONAL_MODEL_POLICY.verify,contractDigest:"a".repeat(64),testCommands:["npm test"],launchGeneration:generationIdentity("verify",1,0,id)};
  const result=await runner.run(input);
  assert.equal(result.status,"failed");assert.equal(runner.commandEvidence(result)?.[0]?.exitCode,1);
  const ref=runner.commandEvidence(result)?.[0]?.output;assert.ok(ref);
  assert.match((await verifyReportEvidence(runner.reportEvidence,ref)).toString(),/failure evidence/);
 }finally{await runner.reportEvidence.release?.();await rm(root,{recursive:true,force:true});}
});

test("workspace correction validates exact A, removes ignored outputs before unsealing and rechecks A",async()=>{
 const requests:CommandRequest[]=[];
 const workspace=new DockerSandboxWorkspace({bridgeRoot:"/private/bridge",stagingRoot:"/private/staging",commands:{async run(request){requests.push(request);let stdout="";if(request.args.includes("rev-parse"))stdout=A+"\n";return {stdout,stdoutBytes:Buffer.from(stdout),stderr:""};}}});
 await workspace.prepareCorrection({sandbox:"squire-test-run",baseSha:BASE,candidate:A});
 const cleanup=requests.findIndex(r=>r.args.includes("clean"));
 const reset=requests.findIndex(r=>r.args.includes("node")&&r.args.includes("-e"));
 assert.ok(cleanup>0&&reset>cleanup);assert.deepEqual(requests[cleanup]!.args.slice(-2),["clean","-ffdx"]);
 assert.match(requests[reset]!.args.at(-1)!,/Git database contains symlink/);
 assert.equal(requests.filter(r=>r.args.includes("rev-parse")).length,2);
});
