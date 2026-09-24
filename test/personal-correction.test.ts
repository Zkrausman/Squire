import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { PersonalMvpController } from "../src/personal/controller.js";
import { eligibleCorrection } from "../src/personal/correction.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { persistLaunchMaterial } from "../src/personal/launch-material.js";
import { findRunState } from "../src/personal/status.js";
import { TEST_CONFIG_DIGEST, TEST_MATERIAL } from "./helpers/personal-launch.js";
import { synthesizeCurrentRunEvents } from "../src/personal/run-events.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { BASE, REQUEST } from "./helpers/workflow.js";
import type { PhaseInput, PhaseResult, PublicationInput, HostCommandEvidence, VerifyPhaseResult } from "../src/personal/types.js";
import type { ReportCapture } from "../src/personal/report-capture.js";
import type { ReportEvidence } from "../src/personal/report-evidence.js";

const A = "b".repeat(40), B = "c".repeat(40);
function evidence(bytes: Buffer, n: number, root: string): ReportEvidence { return { path: path.join(root,"evidence",`${n}.json`), identity: "1:2:3", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }
async function assertArchivedBytes(session: { chunks: readonly ReportEvidence[]; sha256: string; byteLength: number }) {
  const total=createHash("sha256");let size=0;
  for(const ref of session.chunks){
    const bytes=await readFile(ref.path);
    assert.equal(bytes.length,ref.byteLength);assert.equal(createHash("sha256").update(bytes).digest("hex"),ref.sha256);
    total.update(bytes);size+=bytes.length;
  }
  assert.ok(session.chunks.length);assert.equal(size,session.byteLength);assert.equal(total.digest("hex"),session.sha256);
}

async function correctionFixture(options: { failAgain?: boolean; noCustody?: boolean; changedHead?: boolean; testFailure?: boolean; ambiguous?: boolean; noRecommendation?: boolean; concurrent?: boolean; malformedReport?: boolean; overCost?: boolean; unknownCost?: boolean; crashAtBoundary?: boolean; killAtBoundary?: boolean; abortAtBoundary?: boolean; root?: string } = {}) {
  const root = options.root ?? await launchTestRoot("squire-correction-");
  const states = new JsonRunStateStore(root);
  const aborter = new AbortController();
  const calls: PhaseInput[] = [], published: PublicationInput[] = [], captures = new WeakMap<PhaseResult, ReportCapture>(), commandRefs = new WeakMap<PhaseResult, readonly HostCommandEvidence[]>();
  let head = BASE, archived = 0, prepared = 0, serial = 0;
  let archivedSnapshot: Awaited<ReturnType<JsonRunStateStore["read"]>>;
  const store = { async write(value: string | Buffer) { const buffer=Buffer.from(value);const ref=evidence(buffer,++serial,root);await mkdir(path.dirname(ref.path),{recursive:true});await writeFile(ref.path,buffer,{flag:"wx"});return ref; }, async read(ref: ReportEvidence) { return readFile(ref.path); } };
  const controller = new PersonalMvpController({ states, launchMaterial: TEST_MATERIAL, newId: () => "0123456789", testCommands: ["npm test"], launchRetryPolicy: { maxRetries: 0 },
    tickets: { async get() { return { id: REQUEST.ticketId, title: "owner contract", description: "correct a bounded defect" }; } },
    workspaces: {
      async prepare(i) { return { sandbox: i.sandbox, baseSha: BASE, head: BASE }; },
      async currentHead() { return head; }, async assertClean() {},
      async assertDescendant(_sandbox, base, descendant) { if (![[BASE,A],[BASE,B],[A,B]].some(([b,d]) => b === base && d === descendant)) throw Error("ancestry mismatch"); },
      async committedProjectWikiPaths() { return []; },
      async isolateVerifyOutputs(_sandbox, candidate) { assert.equal(candidate,B); },
      async prepareCorrection(i) { prepared++; assert.equal(i.candidate,A); if(options.concurrent) await assert.rejects(controller.run(REQUEST)); if(options.crashAtBoundary || options.killAtBoundary) { archivedSnapshot=await states.read(`${REQUEST.ticketId.toLowerCase()}-0123456789`); if(options.killAtBoundary) { assert.equal(archivedSnapshot?.correction?.transition,"archived"); process.stdout.write("archived boundary persisted\n"); process.exit(57); } throw Error("controller lost at archived boundary"); } if(options.abortAtBoundary) { aborter.abort(Error("boundary timeout")); throw Error("correction boundary deadline elapsed"); } if(options.changedHead) head=B; },
      async exportBundle(i) { return { path: "/private/bundle", sha256: "d".repeat(64), byteLength: 10, baseSha: i.baseSha, head: i.head, branch: i.branch }; },
    },
    phases: {
      reportEvidence: store,
      reportCapture(result) { return captures.get(result); },
      async cumulativeRecordedCost() { if(options.unknownCost) throw Error("cost evidence unavailable"); return options.overCost ? "11" : "0.1"; },
      commandEvidence(result) { return commandRefs.get(result); },
      async archiveCorrectionSessions(i) {
        archived++; assert.equal(i.implement.outputHead,A); assert.equal(i.verify.status,"failed");
        if(options.noCustody) throw Error("private session custody unavailable");
        const session = async () => { const ref=await store.write("bounded session");return { chunks:[ref], sha256:ref.sha256, byteLength:ref.byteLength }; };
        return { implement: await session(), verify: await session() };
      },
      async run(input) {
        calls.push(input); const attempt=input.attempt;
        if(input.phase==="implement") head = attempt===1 ? A : B;
        const status = input.phase==="verify" && (attempt===1 || options.failAgain) ? "failed" : "passed";
        const exitCode = options.testFailure && input.phase === "verify" && attempt === 1 ? 1 : 0;
        const details = input.phase==="implement"
          ? { changes: ["changed code"], projectWiki: { status:"not_required", reason:"no durable wiki change" } }
          : { findings: status==="failed" ? [options.ambiguous ? "Owner approval is necessary for a contract amendment" : "Fix this implementation defect in the module"] : [], commands: [{ command:"npm test", exitCode, summary:"executed" }], ...(status === "failed" && !options.noRecommendation ? { correction: { kind: "code_only", reason: "bounded implementation change only" } } : {}) };
        const raw=JSON.stringify({version:1,outputHead:head,status,summary:options.malformedReport && input.phase === "verify" && attempt === 1 ? "contradictory report" : "bounded result",details});
        const ref=await store.write(raw);
        const result={runId:input.runId,phase:input.phase,attempt,sessionId:input.launchGeneration!.sessionId,sessionFile:input.launchGeneration!.sessionFile,inputHead:input.expectedHead,outputHead:head,status,summary:"bounded result",details,profile:input.profile} as PhaseResult;
        captures.set(result,{ raw, evidence:ref, timestamp:new Date().toISOString(), sessionId:result.sessionId, sessionFile:result.sessionFile });
        if (input.phase === "verify") commandRefs.set(result,[{ command:"npm test", exitCode, output:await store.write("host test output") }]);
        return result;
      },
    },
    publication: { async publish(input) { published.push(input); return { url:"https://github.com/example/repo/pull/10", reused:false }; } },
  });
  return { root, states, controller, aborter, calls, published, get archived() { return archived; }, get prepared() { return prepared; }, get archivedSnapshot() { return archivedSnapshot; }, async cleanup() { await rm(root,{recursive:true,force:true}); } };
}

// Run this module as a dedicated process to test an uncatchable termination at the
// exact archived boundary. The parent owns the scratch root and retains it.
if (process.env["SQUIRE_CORRECTION_KILL_ROOT"]) {
  const f = await correctionFixture({root:process.env["SQUIRE_CORRECTION_KILL_ROOT"],killAtBoundary:true});
  const reserved=await f.controller.reserve(REQUEST,{executionMode:"background",launchConfigDigest:TEST_CONFIG_DIGEST,launchConfigPath:path.join(f.root,"canary-config.json"),controllerPid:null});
  await persistLaunchMaterial(TEST_MATERIAL,reserved,f.root);
  await f.controller.runReserved(REQUEST,reserved.runId,TEST_CONFIG_DIGEST,undefined,path.join(f.root,"canary-config.json"));
  process.exit(58); // Reaching here means the kill injection missed its boundary.
}

test("explicit owner requests stop even under a mislabeled code-only recommendation",()=>{
 const base={runId:"aidev-1-test1234",phase:"verify",attempt:1,sessionId:"22222222-2222-4222-8222-222222222222",sessionFile:"/ticket/sessions/verify/1.jsonl",inputHead:A,outputHead:A,status:"failed",summary:"defect",details:{findings:["Fix module code"],commands:[{command:"npm test",exitCode:0,summary:"passed"}],correction:{kind:"code_only",reason:"bounded code fix"}}} as const satisfies VerifyPhaseResult;
 assert.equal(eligibleCorrection(base),true);
 assert.equal(eligibleCorrection({...base,summary:"Syntax passed but normalize does not meet the final contract",details:{...base.details,correction:{kind:"code_only",reason:"Fix within the ticket and sandbox scope; no new authority"}}}),true);
 for(const finding of ["Ask the owner to approve a contract change before implementation","Owner approval is necessary for a contract amendment","Need host permission to proceed","Owner must decide whether to alter acceptance criteria","The contract needs revision before implementation","Contract must be updated before implementation","Update the contract before implementation","Contract update is required","The contract must be revised","The contract was changed","The contract requires a decision from stakeholders before implementation","The scope needs a decision from stakeholders","Rewrite the contract before proceeding","We must alter the contract","Host permissions are required to proceed","The change is beyond the ticket scope","Scope expansion is necessary"]){
  assert.equal(eligibleCorrection({...base,details:{...base.details,findings:[finding]}}),false,finding);
 }
 assert.equal(eligibleCorrection({...base,details:{...base.details,correction:{kind:"requires_owner",reason:"owner decision"}}}),false);
});

test("failed Verify(A) archives both sessions, corrects B in same run, and only B publishes", async () => {
  const f=await correctionFixture();try {
    const state=await f.controller.run(REQUEST);
    assert.equal(state.status,"completed");assert.equal(state.candidate,B);assert.equal(state.results.verify?.inputHead,B);
    assert.deepEqual(f.calls.map(i=>`${i.phase}:${i.attempt}`),["implement:1","verify:1","implement:2","verify:2"]);
    assert.equal(f.calls[2]?.expectedHead,A);assert.deepEqual(f.calls[2]?.correctionFeedback?.findings,["Fix this implementation defect in the module"]);
    assert.equal(f.calls[3]?.originalTicketBaseSha,BASE);assert.notEqual(f.calls[1]?.launchGeneration?.sessionId,f.calls[3]?.launchGeneration?.sessionId);
    assert.equal(state.correction?.prior.length,1);assert.equal(state.correction?.prior[0]?.candidate,A);
    assert.equal(state.correction?.prior[0]?.verify.status,"failed");assert.equal(f.archived,1);assert.equal(f.prepared,1);
    assert.equal(f.published.length,1);assert.equal(f.published[0]?.head,B);
    const actual=await f.states.readEvents(state.runId), reconstructed=synthesizeCurrentRunEvents(state);
    for (const phase of ["implement","verify"] as const) for (const attempt of [1,2]) {
      assert.ok(actual.some(e=>e.type==="phase_completed"&&e.phase===phase&&e.attempt===attempt));
      assert.ok(reconstructed.some(e=>e.type==="phase_completed"&&e.phase===phase&&e.attempt===attempt));
    }
    assert.ok(actual.some(e=>e.type==="terminal_succeeded"));
  }finally{await f.cleanup();}
});

test("concurrent controller cannot reserve while a correction holds the run",async()=>{
 const f=await correctionFixture({concurrent:true});try{
  const state=await f.controller.run(REQUEST);
  assert.equal(state.status,"completed");assert.equal(f.calls.length,4);assert.equal(f.published.length,1);
 }finally{await f.cleanup();}
});

test("caught boundary failure terminalizes with immutable archived evidence",async()=>{
 const f=await correctionFixture({crashAtBoundary:true});try{
  await assert.rejects(f.controller.run(REQUEST),/controller lost at archived boundary/);
  const state=(await f.states.findByTicket(REQUEST.ticketId))[0]!;
  assert.equal(f.archivedSnapshot?.status,"running");assert.equal(f.archivedSnapshot?.correction?.transition,"archived");
  assert.equal(state.status,"failed");assert.equal(state.correction?.transition,"archived");assert.equal(state.correction.prior[0]?.candidate,A);
  assert.equal(state.correction.prior[0]?.verify.status,"failed");assert.ok(state.correction.prior[0]?.sessions.implement.chunks.length);
  assert.ok(state.correction.prior[0]?.sessions.verify.chunks.length);assert.equal(f.calls.length,2);assert.equal(f.published.length,0);
  await assert.rejects(f.states.save({...f.archivedSnapshot!,version:state.version+1}),/immutable|version|stale/);
  assert.equal(await f.states.reservationOwner(REQUEST.ticketId),undefined);
 }finally{await f.cleanup();}
});

test("abort at archived boundary retains evidence and terminalizes without dispatch",async()=>{
 const f=await correctionFixture({abortAtBoundary:true});try{
  await assert.rejects(f.controller.run(REQUEST,f.aborter.signal),/boundary deadline elapsed/);
  const state=(await f.states.findByTicket(REQUEST.ticketId))[0]!;
  assert.equal(state.status,"interrupted");assert.equal(state.correction?.transition,"archived");
  assert.equal(state.correction.prior[0]?.candidate,A);assert.ok(state.correction.prior[0]?.sessions.verify.chunks.length);
  assert.equal(f.calls.length,2);assert.equal(f.published.length,0);
  assert.equal(await f.states.reservationOwner(REQUEST.ticketId),undefined);
 }finally{await f.cleanup();}
});

test("OS kill at archived boundary retains custody and blocks restarted dispatch",async()=>{
 const root=await launchTestRoot("squire-correction-killed-");try{
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,SQUIRE_CORRECTION_KILL_ROOT:root},encoding:"utf8",timeout:30000});
  assert.equal(child.status,57,child.stderr);assert.match(child.stdout,/archived boundary persisted/);
  const f=await correctionFixture({root});
  const state=(await f.states.findByTicket(REQUEST.ticketId))[0]!;
  assert.equal(state.status,"running");assert.equal(state.correction?.transition,"archived");
  assert.equal(state.correction.prior[0]?.candidate,A);assert.equal(state.correction.prior[0]?.verify.status,"failed");
  await assertArchivedBytes(state.correction.prior[0]!.sessions.implement);
  await assertArchivedBytes(state.correction.prior[0]!.sessions.verify);
  assert.equal(state.attempts.implement,1);assert.equal(state.attempts.verify,1);assert.equal(state.prUrl,null);
  assert.equal(await f.states.reservationOwner(REQUEST.ticketId),state.runId);
  await assert.rejects(f.controller.runReserved(REQUEST,state.runId,TEST_CONFIG_DIGEST,undefined,path.join(f.root,"canary-config.json")),/exact reserved launch state/);
  await assert.rejects(f.controller.run(REQUEST),/active or ambiguous reservation/);
  assert.equal(f.calls.length,0);assert.equal(f.published.length,0);
  assert.equal((await f.states.read(state.runId))?.version,state.version);
  // Status may identify the run as running or report ambiguous dead-owner evidence,
  // but must never invent a terminal success or remove the reservation.
  try { const observed=await findRunState(f.states,REQUEST.ticketId);assert.equal(observed.status,"running"); }
  catch(error) { assert.match(String(error),/ambiguous|owner evidence/); }
  assert.equal(await f.states.reservationOwner(REQUEST.ticketId),state.runId);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("host-observed failed test output remains bound to A without approving A",async()=>{
 const f=await correctionFixture({testFailure:true});try{
  const state=await f.controller.run(REQUEST);
  assert.equal(state.correction?.prior[0]?.commands[0]?.exitCode,1);
  assert.equal(state.correction?.prior[0]?.verify.details.commands[0]?.exitCode,1);
  assert.equal(state.verifyCommands?.[0]?.exitCode,0);
  assert.equal(f.published[0]?.head,B);
 }finally{await f.cleanup();}
});

for (const mode of ["exhausted","custody","head-drift","ambiguous","unclassified","malformed","over-cost","unknown-cost"] as const) test(`correction ${mode} fails closed without publishing`,async()=>{
  const f=await correctionFixture({failAgain:mode==="exhausted",noCustody:mode==="custody",changedHead:mode==="head-drift",ambiguous:mode==="ambiguous",noRecommendation:mode==="unclassified",malformedReport:mode==="malformed",overCost:mode==="over-cost",unknownCost:mode==="unknown-cost"});try{
    await assert.rejects(f.controller.run(REQUEST));
    const state=(await f.states.findByTicket(REQUEST.ticketId))[0]!;
    assert.equal(state.status,"failed");assert.equal(f.published.length,0);
    if(mode==="exhausted") { assert.equal(state.correction?.prior.length,1);assert.equal(state.results.verify?.status,"failed");assert.equal(state.candidate,B); }
    if(mode==="custody" || mode==="ambiguous" || mode==="unclassified" || mode==="malformed" || mode==="over-cost" || mode==="unknown-cost") { assert.equal(state.correction?.prior.length,0);assert.equal(f.prepared,0); }
    if(mode==="head-drift") { assert.equal(state.correction?.transition,"archived");assert.equal(f.calls.length,2); }
  }finally{await f.cleanup();}
});
