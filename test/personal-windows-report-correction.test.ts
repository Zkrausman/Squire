import { readRunTelemetry } from "../src/personal/telemetry.js";
import { piJsonStream } from "./helpers/pi-json.js";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { CommandExecutionError, type CommandPort, type CommandRequest } from "../src/personal/command.js";
import { verifyReportEvidence, WindowsReportEvidence } from "../src/personal/report-evidence.js";
import { validateReportCorrectionPolicy } from "../src/personal/report-correction.js";
import type { PhaseInput, PersonalRunState } from "../src/personal/types.js";
import { launchTestRoot } from "./helpers/windows-launch.js";

// Same production runner/controller test runs on Linux and on the authoritative
// Windows matrix. Only the sandbox/model producer and external services are fake.
const BASE = "a".repeat(40), HEAD = "b".repeat(40);
const request = { ticketId: "AIDEV-306", repository: "example/repo", repositoryPath: "/fixture", sourceRef: "main", baseBranch: "main" };
type Fault = "syntax" | "utf8" | "duplicate" | "identity" | "missingWiki" | "failed" | "facts" | "capability" | "cancel" | "command" | "successDigest";
async function fixture(fault?: Fault, maximum = 1) {
  const root = await launchTestRoot("squire-native-correction-");
  const states = new JsonRunStateStore(path.join(root, "state"));
  const snapshots: PersonalRunState[] = [], phases: string[] = [], corrections: CommandRequest[] = [];
  const abort = new AbortController();
  let document: PhaseInput, head = BASE, published = false, original: Buffer = Buffer.alloc(0), corrected: Buffer = Buffer.alloc(0);
  const save = states.save.bind(states);
  states.save = async state => { await save(state); snapshots.push(structuredClone(state)); };
  function payload(input: PhaseInput): any {
    return { outputHead: input.phase === "plan" ? BASE : HEAD, status: "passed", summary: "fixture result", details:
      input.phase === "implement" ? { changes: ["fixture"], projectWiki: { status: "not_required", reason: "fixture changes no durable knowledge" } } : input.phase === "plan" ? { steps: ["implement"] } : input.phase === "review" ? { findings: [] } : input.phase === "test" ? { commands: [{ command: "independent fixture test", exitCode: 0, summary: "passed" }] } : { lessons: ["fixture"], followUps: [] } };
  }
  const commands: CommandPort = {
    byteOutput: true,
    async run(spec) {
      if (spec.args[0] === "cp") document = JSON.parse(await readFile(spec.args[1]!, "utf8"));
      if (!spec.args.includes("--print")) return { stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "" };
      const value = payload(document);
      let bytes: Buffer;
      if (spec.args.includes("--no-tools")) {
        corrections.push(spec);
        assert.equal(snapshots.at(-1)?.reportCorrections?.at(-1)?.kind, "launched");
        assert.ok(spec.args.includes("--no-session"));
        assert.ok(!spec.args.includes("/ticket/workspace"));
        assert.ok(spec.timeoutMs! <= 60000);
        if (fault === "facts") value.details.projectWiki.reason = "invented";
        bytes = corrected = Buffer.from(JSON.stringify(value) + "\r\n");
        if (fault === "cancel") abort.abort(new Error("fixture cancellation"));
        if (fault === "command") { const stream = Buffer.from(piJsonStream(bytes.toString(), document.profile)); throw new CommandExecutionError("timeout", "fixture command timeout", stream.toString(), undefined, stream); }
      } else {
        phases.push(document.phase);
        if (document.phase === "review") assert.equal(snapshots.at(-1)?.results.implement?.status, "passed");
        if (document.phase === "implement") {
          head = HEAD;
          value.details.verification = ["untrusted claim, not acceptance"];
          if (fault === "identity") value.runId = "forged";
          if (fault === "missingWiki") delete value.details.projectWiki;
          if (fault === "failed") value.status = "failed";
        }
        bytes = Buffer.from(JSON.stringify(value) + "\r\n ");
        if (document.phase === "implement") {
          if (fault === "syntax") bytes = Buffer.from("{ genuinely unparseable prose");
          if (fault === "utf8") bytes = Buffer.concat([bytes, Buffer.from([255])]);
          if (fault === "duplicate") bytes = Buffer.from(bytes.toString().replace('"status":"passed"', '"status":"failed","status":"passed"'));
          original = bytes;
        }
      }
      if (fault === "utf8" && document.phase === "implement") { original = Buffer.alloc(0); return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" }; }
      const stream = Buffer.from(piJsonStream(bytes.toString("utf8"), document.profile));
      return { stdout: stream.toString("utf8"), stdoutBytes: stream, stderr: "" };
    },
  };
  const runner = new SandboxPiPhaseRunner({ commands, stagingRoot: root, telemetryStateDirectory: path.join(root, "state"), testCommands: [] });
  if (process.platform === "win32") assert.ok(runner.reportEvidence instanceof WindowsReportEvidence);
  if (fault === "capability") runner.prepareReportCorrection = async () => { throw new Error("Windows report evidence native capability unavailable; rebuild native support"); };
  if (fault === "successDigest") {
    const capture = runner.reportCapture.bind(runner);
    runner.reportCapture = result => { const report = capture(result)!; return { ...report, evidence: { ...report.evidence, sha256: "0".repeat(64) } }; };
  }
  const controller = new PersonalMvpController({
    states, phases: runner, phaseTimeoutMs: 60000, newId: () => "0123456789",
    reportCorrectionPolicy: validateReportCorrectionPolicy({ maxAttempts: maximum, allowedErrorClasses: ["implement-unexpected-details-fields"] }),
    tickets: { async get(id) { return { id, title: "fixture", description: "synthetic data" }; } },
    workspaces: {
      async prepare() { return { sandbox: "fixture", baseSha: BASE, head: BASE }; },
      async currentHead() { return head; }, async assertClean() {}, async committedProjectWikiPaths() { return []; },
      async exportBundle(input) { return { ...input, path: "/fixture/bundle", byteLength: 1, sha256: "c".repeat(64) }; },
    },
    publication: { async publish(input) { assert.equal(input.phases.review.outputHead, HEAD); assert.equal(input.phases.test.outputHead, HEAD); published = true; return { url: "https://example.com/pr", reused: false }; } },
  });
  return { root, states, snapshots, phases, corrections, runner, controller, abort, get published() { return published; }, get original() { return original; }, get corrected() { return corrected; }, async cleanup() { await runner.reportEvidence.release?.(); await rm(root, { recursive: true, force: true }); } };
}

test("native production capture corrects eligible JSON shape only, then independent Review/Test", async () => {
  const f = await fixture();
  try {
    const state = await f.controller.run(request);
    assert.equal(state.status, "completed");
    assert.deepEqual(f.phases, ["plan", "implement", "review", "test", "retro"]);
    assert.equal(f.corrections.length, 1);
    assert.equal(f.published, true);
    const telemetry = await readRunTelemetry(state, path.join(f.root, "state"));
    assert.ok(telemetry.status === "available");
    assert.equal(telemetry.summary.sessions.length, 6);
    assert.equal(telemetry.summary.totals.tokensComplete, true);
    assert.equal(telemetry.summary.totals.tokens.input, 60);
    const originalSession = telemetry.summary.sessions.find(s => s.phase === "implement" && s.kind === "phase")!;
    const correctionSession = telemetry.summary.sessions.find(s => s.kind === "report-correction")!;
    assert.equal(originalSession.outcome, "invalid_report");
    assert.equal(correctionSession.outcome, "passed");
    assert.equal(correctionSession.correctionAttempt, 1);
    assert.notEqual(originalSession.sessionId, correctionSession.sessionId);
    assert.equal(correctionSession.sessionFile, null);
    const ledger = state.reportCorrections!;
    assert.equal(ledger.at(-1)?.kind, "accepted");
    assert.equal(ledger.at(-1)?.used, 1); assert.equal(ledger.at(-1)?.remaining, 0);
    const reports = ledger.filter(record => record.kind === "observed" && record.producer !== "controller");
    assert.equal(reports.length, 2);
    assert.notEqual(reports[0]!.evidence!.path, reports[1]!.evidence!.path);
    await verifyReportEvidence(f.runner.reportEvidence, reports[0]!.evidence!, f.original);
    await verifyReportEvidence(f.runner.reportEvidence, reports[1]!.evidence!, f.corrected);
  } finally { await f.cleanup(); }
});
for (const fault of ["syntax", "utf8", "duplicate", "identity", "missingWiki", "failed", "facts", "capability", "cancel", "command", "successDigest"] as const) test(`native production ${fault} fails closed with exact correction charges`, async () => {
  const f = await fixture(fault);
  try {
    await assert.rejects(f.controller.run(request, f.abort.signal));
    const state = (await f.states.read("aidev-306-0123456789"))!;
    const called = ["facts", "cancel", "command"].includes(fault) ? 1 : 0;
    assert.equal(f.corrections.length, called);
    assert.equal(f.published, false);
    assert.ok(!f.phases.includes("review"));
    if (fault !== "successDigest") {
      assert.equal(state.reportCorrections?.at(-1)?.used, called);
      assert.equal(state.reportCorrections?.at(-1)?.remaining, 1 - called);
      const original = state.reportCorrections!.find(r => r.kind === "observed")!.evidence!;
      await verifyReportEvidence(f.runner.reportEvidence, original, f.original);
    }
  } finally { await f.cleanup(); }
});
test("native production maximum=0 preserves malformed shape without correction", async () => {
  const f = await fixture(undefined, 0);
  try {
    await assert.rejects(f.controller.run(request), /budget exhausted \(0\/0\)/);
    assert.equal(f.corrections.length, 0);
    const state = (await f.states.read("aidev-306-0123456789"))!;
    assert.equal(state.reportCorrections?.at(-1)?.used, 0);
    await verifyReportEvidence(f.runner.reportEvidence, state.reportCorrections![0]!.evidence!, f.original);
  } finally { await f.cleanup(); }
});

test("controller crash keeps irrevocable charge and original evidence, never accepted result", async () => {
  const { spawn } = await import("node:child_process");
  const { createReportEvidence } = await import("../src/personal/report-evidence.js");
  const root = await launchTestRoot("squire-correction-dispatch-crash-");
  const evidence = createReportEvidence(path.join(root, "report-evidence"));
  try {
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("fixtures/report-correction-crash.mjs"), root], { stdio: ["ignore", "ignore", "pipe"], timeout: 30000 });
      let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject); child.on("exit", code => code === 73 ? resolve(code) : reject(new Error(stderr || `unexpected exit ${code}`)));
    });
    assert.equal(exit, 73);
    const states = new JsonRunStateStore(path.join(root, "state"));
    const state = (await states.read("aidev-306-crash0123"))!;
    assert.equal(state.status, "running"); // abrupt exit cannot synthesize terminal/acceptance
    assert.equal(state.reportCorrections?.at(-1)?.kind, "launched");
    assert.equal(state.reportCorrections?.at(-1)?.used, 1);
    assert.equal(state.reportCorrections?.at(-1)?.remaining, 0);
    assert.equal(state.results.implement, undefined);
    assert.equal(state.attempts.review, 0);
    assert.equal(await states.reservationOwner("AIDEV-306"), state.runId);
    const bytes = await verifyReportEvidence(evidence, state.reportCorrections![0]!.evidence!);
    assert.match(bytes.toString(), /untrusted/);
    await assert.rejects(states.reserve(state), /already|reserved|active|reservation/i);
  } finally { await evidence.release?.(); await rm(root, { recursive: true, force: true }); }
});
