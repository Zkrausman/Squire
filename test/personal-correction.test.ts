import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { synthesizeCurrentRunEvents } from "../src/personal/run-events.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { BASE, REQUEST } from "./helpers/workflow.js";
import type { PhaseInput, PhaseResult, PublicationInput, HostCommandEvidence } from "../src/personal/types.js";
import type { ReportCapture } from "../src/personal/report-capture.js";
import type { ReportEvidence } from "../src/personal/report-evidence.js";

const A = "b".repeat(40), B = "c".repeat(40);
function evidence(bytes: Buffer, n: number): ReportEvidence { return { path: `/private/evidence/${n}.json`, identity: "1:2:3", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; }

async function correctionFixture(options: { failAgain?: boolean; noCustody?: boolean; changedHead?: boolean; testFailure?: boolean; ambiguous?: boolean; noRecommendation?: boolean; concurrent?: boolean; malformedReport?: boolean } = {}) {
  const root = await launchTestRoot("squire-correction-");
  const states = new JsonRunStateStore(root);
  const calls: PhaseInput[] = [], published: PublicationInput[] = [], captures = new WeakMap<PhaseResult, ReportCapture>(), commandRefs = new WeakMap<PhaseResult, readonly HostCommandEvidence[]>();
  const bytes = new Map<string, Buffer>();
  let head = BASE, archived = 0, prepared = 0, serial = 0;
  const store = { async write(value: string | Buffer) { const buffer=Buffer.from(value);const ref=evidence(buffer,++serial);bytes.set(ref.path,buffer);return ref; }, async read(ref: ReportEvidence) { return bytes.get(ref.path)!; } };
  const controller = new PersonalMvpController({ states, newId: () => "0123456789", testCommands: ["npm test"], launchRetryPolicy: { maxRetries: 0 },
    tickets: { async get() { return { id: REQUEST.ticketId, title: "owner contract", description: "correct a bounded defect" }; } },
    workspaces: {
      async prepare(i) { return { sandbox: i.sandbox, baseSha: BASE, head: BASE }; },
      async currentHead() { return head; }, async assertClean() {},
      async assertDescendant(_sandbox, base, descendant) { if (![[BASE,A],[BASE,B],[A,B]].some(([b,d]) => b === base && d === descendant)) throw Error("ancestry mismatch"); },
      async committedProjectWikiPaths() { return []; },
      async isolateVerifyOutputs(_sandbox, candidate) { assert.equal(candidate,B); },
      async prepareCorrection(i) { prepared++; assert.equal(i.candidate,A); if(options.concurrent) await assert.rejects(controller.run(REQUEST)); if(options.changedHead) head=B; },
      async exportBundle(i) { return { path: "/private/bundle", sha256: "d".repeat(64), byteLength: 10, baseSha: i.baseSha, head: i.head, branch: i.branch }; },
    },
    phases: {
      reportEvidence: store,
      reportCapture(result) { return captures.get(result); },
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
          : { findings: status==="failed" ? [options.ambiguous ? "Ask the owner to approve a contract change before implementation" : "Fix this implementation defect within ticket scope"] : [], commands: [{ command:"npm test", exitCode, summary:"executed" }], ...(status === "failed" && !options.noRecommendation ? { correction: { kind: "code_only", reason: "bounded implementation change only" } } : {}) };
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
  return { root, states, controller, calls, published, get archived() { return archived; }, get prepared() { return prepared; }, async cleanup() { await rm(root,{recursive:true,force:true}); } };
}

test("failed Verify(A) archives both sessions, corrects B in same run, and only B publishes", async () => {
  const f=await correctionFixture();try {
    const state=await f.controller.run(REQUEST);
    assert.equal(state.status,"completed");assert.equal(state.candidate,B);assert.equal(state.results.verify?.inputHead,B);
    assert.deepEqual(f.calls.map(i=>`${i.phase}:${i.attempt}`),["implement:1","verify:1","implement:2","verify:2"]);
    assert.equal(f.calls[2]?.expectedHead,A);assert.deepEqual(f.calls[2]?.correctionFeedback?.findings,["Fix this implementation defect within ticket scope"]);
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

test("host-observed failed test output remains bound to A without approving A",async()=>{
 const f=await correctionFixture({testFailure:true});try{
  const state=await f.controller.run(REQUEST);
  assert.equal(state.correction?.prior[0]?.commands[0]?.exitCode,1);
  assert.equal(state.correction?.prior[0]?.verify.details.commands[0]?.exitCode,1);
  assert.equal(state.verifyCommands?.[0]?.exitCode,0);
  assert.equal(f.published[0]?.head,B);
 }finally{await f.cleanup();}
});

for (const mode of ["exhausted","custody","head-drift","ambiguous","unclassified","malformed"] as const) test(`correction ${mode} fails closed without publishing`,async()=>{
  const f=await correctionFixture({failAgain:mode==="exhausted",noCustody:mode==="custody",changedHead:mode==="head-drift",ambiguous:mode==="ambiguous",noRecommendation:mode==="unclassified",malformedReport:mode==="malformed"});try{
    await assert.rejects(f.controller.run(REQUEST));
    const state=(await f.states.findByTicket(REQUEST.ticketId))[0]!;
    assert.equal(state.status,"failed");assert.equal(f.published.length,0);
    if(mode==="exhausted") { assert.equal(state.correction?.prior.length,1);assert.equal(state.results.verify?.status,"failed");assert.equal(state.candidate,B); }
    if(mode==="custody" || mode==="ambiguous" || mode==="unclassified" || mode==="malformed") { assert.equal(state.correction?.prior.length,0);assert.equal(f.prepared,0); }
    if(mode==="head-drift") { assert.equal(state.correction?.transition,"archived");assert.equal(f.calls.length,2); }
  }finally{await f.cleanup();}
});
