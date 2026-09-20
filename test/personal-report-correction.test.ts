import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, chmod, unlink, symlink, rename, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { parsePhaseResult } from "../src/personal/phase-payload.js";
import { PhaseExecutionError } from "../src/personal/execution-failure.js";
import { InvalidPhaseHandoff, CorrectionExecutionFailure, correctionSchema, validateCorrectionState, validateReportCorrectionPolicy, type ReportCapture, type ReportCorrectionInput } from "../src/personal/report-correction.js";
import { FileReportEvidence, verifyReportEvidence, reportHash, MAX_REPORT_BYTES, type ReportEvidence, type ReportEvidencePort } from "../src/personal/report-evidence.js";
import { deriveRunEvents } from "../src/personal/run-events.js";
import type { PhaseInput, PhaseResult, PersonalRunState } from "../src/personal/types.js";
import { CommandExecutionError, type CommandRequest } from "../src/personal/command.js";

const BASE = "a".repeat(40), HEAD = "b".repeat(40);
const REQUEST = { ticketId: "AIDEV-295", repository: "example/repo", repositoryPath: "/source/repo", sourceRef: "main", baseBranch: "main" };
function payload(input: PhaseInput): any {
  return { outputHead: input.phase === "plan" ? BASE : HEAD, status: "passed", summary: "synthetic report", details:
    input.phase === "implement" ? { changes: ["documentation change"], projectWiki: { status: "not_required", reason: "no durable knowledge in synthetic fixture" } }
    : input.phase === "plan" ? { steps: ["implement"] } : input.phase === "review" ? { findings: [] }
    : input.phase === "test" ? { commands: [{ command: "npm test", exitCode: 0, summary: "independent fake Test" }] } : { lessons: ["synthetic"], followUps: [] } };
}
class MemoryEvidence implements ReportEvidencePort {
  bytes = new Map<string, Buffer>();
  serial = 0;
  async write(content: string): Promise<ReportEvidence> {
    const bytes = Buffer.from(content);
    const ref = { path: `/evidence/${++this.serial}`, byteLength: bytes.length, sha256: reportHash(bytes), identity: `1:${this.serial}` };
    this.bytes.set(ref.path, bytes);
    return ref;
  }
  async read(ref: ReportEvidence): Promise<Buffer> {
    const bytes = this.bytes.get(ref.path);
    if (!bytes) throw new Error("missing evidence");
    return Buffer.from(bytes);
  }
}
interface Options {
  maximum?: number;
  original?: (value: any, input: PhaseInput) => string;
  correction?: (request: ReportCorrectionInput, h: Harness) => Promise<string>;
  beforeOriginal?: (h: Harness) => void;
  tamper?: (capture: ReportCapture, h: Harness, corrected: boolean) => ReportCapture;
  phaseFailure?: Error;
  wiki?: string[];
  timeout?: number;
  reviewRemediation?: boolean;
  staged?: boolean;
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function harness(options: Options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-correction-"));
  const states = new JsonRunStateStore(path.join(root, "state"));
  const evidence = new MemoryEvidence();
  const calls: string[] = [], corrections: ReportCorrectionInput[] = [], snapshots: PersonalRunState[] = [];
  let head = BASE, clean = true, published = 0, elapsed = 0;
  const save = states.save.bind(states);
  states.save = async state => { await save(state); snapshots.push(structuredClone(state)); };
  const h = {
    root, states, evidence, calls, corrections, snapshots,
    get head() { return head; }, set head(v: string) { head = v; },
    get clean() { return clean; }, set clean(v: boolean) { clean = v; },
    get published() { return published; },
    expireDeadline() { elapsed += 60001; },
    controller: undefined as unknown as PersonalMvpController,
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
  h.controller = new PersonalMvpController({
    states, monotonicNow: () => performance.now() + elapsed, newId: () => "0123456789", phaseTimeoutMs: options.timeout ?? 60000,
    ...(options.staged ? { escalationPolicy: { implement: { stages: [{ provider: "fake", model: "offline", thinking: "low" as const, maxAttempts: 2 }] } } } : {}),
    reportCorrectionPolicy: validateReportCorrectionPolicy({ maxAttempts: options.maximum ?? 1, allowedErrorClasses: ["implement-unexpected-details-fields"] }),
    tickets: { async get(id) { return { id, title: "Synthetic incident regression", description: "No incident artifacts supplied" }; } },
    workspaces: {
      async prepare() { return { sandbox: "synthetic", baseSha: BASE, head: BASE }; },
      async currentHead() { return head; }, async assertClean() { if (!clean) throw new Error("dirty worktree"); },
      async committedProjectWikiPaths(input) { assert.equal(input.baseSha, BASE); return options.wiki ?? []; },
      async exportBundle(input) { assert.equal(input.head, head); return { ...input, path: "/fake/bundle", byteLength: 1, sha256: "c".repeat(64) }; },
    },
    phases: {
      reportEvidence: evidence,
      async run(input) {
        calls.push(input.phase);
        const value = payload(input);
        if (input.phase !== "implement") {
          if (input.phase === "review" && options.reviewRemediation && input.attempt === 1) { value.status = "remediation_required"; value.details.findings = ["synthetic remediation"]; }
          return parsePhaseResult(JSON.stringify(value), input, `${input.phase}-${input.attempt}`, `/ticket/sessions/${input.phase}/${input.attempt}.jsonl`, input.profile);
        }
        head = HEAD;
        options.beforeOriginal?.(h);
        if (options.phaseFailure) throw options.phaseFailure;
        value.details.verification = ["npm test claimed passed (not acceptance)"];
        const raw = options.original ? options.original(value, input) : JSON.stringify(value);
        let capture: ReportCapture = { raw, timestamp: new Date().toISOString(), sessionId: input.reportSession!.sessionId, sessionFile: input.reportSession!.sessionFile, evidence: await evidence.write(raw) };
        capture = options.tamper?.(capture, h, false) ?? capture;
        let diagnostic = "";
        try { parsePhaseResult(raw, input, capture.sessionId, capture.sessionFile, input.profile); } catch (e) { diagnostic = String(e); }
        throw new InvalidPhaseHandoff(capture, diagnostic);
      },
      async correctReport(request) {
        corrections.push(request);
        assert.equal(snapshots.at(-1)?.reportCorrections?.at(-1)?.kind, "launched");
        const raw = options.correction ? await options.correction(request, h) : JSON.stringify(payload(request.input));
        let capture: ReportCapture = { raw, timestamp: new Date().toISOString(), sessionId: request.producerId, sessionFile: `/run/squire-report-${request.producerId}/no-session`, evidence: await evidence.write(raw) };
        capture = options.tamper?.(capture, h, true) ?? capture;
        return capture;
      },
    },
    publication: { async publish(input) { published++; assert.equal(input.phases.review.outputHead, HEAD); assert.equal(input.phases.test.outputHead, HEAD); return { url: "https://example.com/pr", reused: false }; } },
  });
  return h;
}
async function failure(options: Options, pattern: RegExp, expectedCalls = 0) {
  const h = await harness(options);
  try {
    await assert.rejects(h.controller.run(REQUEST), pattern);
    assert.equal(h.published, 0);
    assert.equal(h.corrections.length, expectedCalls);
    const state = await h.states.read("aidev-295-0123456789");
    assert.ok(state?.status === "failed" || state?.status === "interrupted");
    assert.equal(await h.states.reservationOwner(REQUEST.ticketId), undefined);
    assert.equal(deriveRunEvents(h.snapshots.at(-2), h.snapshots.at(-1)!).filter(e => e.type === "terminal_failed").length, 1);
    return state!;
  } finally { await h.cleanup(); }
}

test("policy defaults and finite closed bounds", () => {
  assert.equal(validateReportCorrectionPolicy().maxAttempts, 1);
  for (const maxAttempts of [0, 1, 2]) assert.equal(validateReportCorrectionPolicy({ maxAttempts, allowedErrorClasses: [] }).maxAttempts, maxAttempts);
  for (const maxAttempts of [-1, 3, 1.1, NaN, Infinity, "1", null]) assert.throws(() => validateReportCorrectionPolicy({ maxAttempts, allowedErrorClasses: [] }));
  for (const policy of [{ maxAttempts: 1 }, { maxAttempts: 1, allowedErrorClasses: ["malformed-json"] }, { maxAttempts: 1, allowedErrorClasses: [], extra: true }]) assert.throws(() => validateReportCorrectionPolicy(policy));
});

test("synthetic extra verification correction preserves bytes and reaches independent Review/Test", async () => {
  const h = await harness();
  try {
    const state = await h.controller.run(REQUEST);
    assert.equal(state.status, "completed");
    assert.deepEqual(h.calls, ["plan", "implement", "review", "test", "retro"]);
    assert.equal(h.corrections.length, 1);
    assert.match(h.corrections[0]!.diagnostic, /implement details fields are invalid: unexpected=\["verification"\] missing=\[\]/);
    assert.equal(h.corrections[0]!.deadline, h.corrections[0]!.input.deadline);
    const raw = await h.evidence.read(h.corrections[0]!.original.evidence);
    assert.match(raw.toString(), /claimed passed/);
    assert.ok(!("verification" in state.results.implement!.details));
    assert.deepEqual(state.remediations, { review: 0, test: 0 });
    const ledger = state.reportCorrections!;
    assert.equal(ledger.at(-1)?.kind, "accepted");
    assert.equal(ledger.at(-1)?.remaining, 0);
    assert.equal(new Set(ledger.filter(r => r.evidence).map(r => r.evidence!.path)).size, 4);
    const events = await h.states.readEvents(state.runId);
    assert.ok(events.some(e => e.type === "report_correction_launched" && e.correction?.used === 1));
    assert.ok(events.some(e => e.type === "report_correction_accepted"));
    assert.ok(events.some(e => e.type === "phase_completed" && e.phase === "test"));
    await assert.rejects(h.states.save({ ...state, version: state.version + 1, reportCorrections: [] }), /immutable/);
  } finally { await h.cleanup(); }
});

test("disable=0 preserves original evidence without launching", async () => {
  const state = await failure({ maximum: 0 }, /budget exhausted \(0\/0\)/);
  assert.equal(state.reportCorrections!.filter(r => r.kind === "observed").length, 2);
});
for (const first of ["malformed", "extra"] as const) test(`second correction succeeds within bound after ${first}`, async () => {
  const h = await harness({ maximum: 2, correction: async request => request.correctionAttempt === 1 ? first === "malformed" ? "{" : request.original.raw : JSON.stringify(payload(request.input)) });
  try {
    const state = await h.controller.run(REQUEST);
    assert.equal(state.status, "completed");
    assert.deepEqual(state.reportCorrections!.filter(r => r.kind === "launched").map(r => [r.used, r.remaining]), [[1, 1], [2, 0]]);
    assert.equal(h.corrections[0]!.deadline, h.corrections[1]!.deadline);
  } finally { await h.cleanup(); }
});
for (const raw of ["{", "extra"]) test(`bounded exhaustion for repeated ${raw}`, async () => {
  await failure({ maximum: 2, correction: async request => raw === "extra" ? request.original.raw : raw }, /budget exhausted \(2\/2\)/, 2);
});
test("new Implement remediation attempt has separate allowance", async () => {
  const h = await harness({ reviewRemediation: true });
  try {
    const state = await h.controller.run(REQUEST);
    assert.equal(h.corrections.length, 2);
    assert.deepEqual(state.reportCorrections!.filter(r => r.kind === "launched").map(r => [r.attempt, r.used]), [[1, 1], [2, 1]]);
    assert.equal(state.remediations.review, 1);
  } finally { await h.cleanup(); }
});

for (const [name, mutate] of Object.entries({
  malformed: () => "{",
  missingWiki: (v: any) => { delete v.details.projectWiki; return JSON.stringify(v); },
  contradictoryWiki: (v: any) => { v.details.projectWiki.paths = [".llm-wiki/x"]; return JSON.stringify(v); },
  status: (v: any) => { v.status = "remediation_required"; return JSON.stringify(v); },
  failed: (v: any) => { v.status = "failed"; return JSON.stringify(v); },
  run: (v: any) => { v.runId = "forged"; return JSON.stringify(v); },
  phase: (v: any) => { v.phase = "test"; return JSON.stringify(v); },
  attempt: (v: any) => { v.attempt = 2; return JSON.stringify(v); },
  inputHead: (v: any) => { v.inputHead = HEAD; return JSON.stringify(v); },
  outputHead: (v: any) => { v.outputHead = BASE; return JSON.stringify(v); },
  invalidSHA: (v: any) => { v.outputHead = "not-a-sha"; return JSON.stringify(v); },
  session: (v: any) => { v.sessionId = "forged"; return JSON.stringify(v); },
  profile: (v: any) => { v.profile = { provider: "forged", model: "x", thinking: "low" }; return JSON.stringify(v); },
})) test(`original ${name} cannot enter correction`, async () => { await failure({ original: mutate }, /report correction stopped/); });

test("cumulative wiki contradiction cannot enter correction", async () => { await failure({ wiki: [".llm-wiki/prior.md"] }, /contradicts committed diff/); });
test("dirty original cannot enter correction", async () => { await failure({ beforeOriginal: h => { h.clean = false; } }, /dirty worktree/); });
test("actual invalid Git identity is unknown in evidence and ledger, never the input HEAD", async () => {
  const h = await harness({ beforeOriginal: h => { h.head = "invalid"; } });
  try {
    await assert.rejects(h.controller.run(REQUEST), /implement details.*invalid Git SHA/);
    const state = (await h.states.read("aidev-295-0123456789"))!;
    assert.equal(state.status, "failed");
    assert.match(state.lastError!, /controller.currentHead/);
    assert.equal(h.corrections.length, 0);
    assert.equal(h.published, 0);
    const ledger = state.reportCorrections!;
    assert.deepEqual(ledger.map(r => [r.kind, r.head, r.used]), [["observed", null, 0], ["observed", null, 0], ["stopped", null, 0]]);
    const observation = JSON.parse((await h.evidence.read(ledger[1]!.evidence!)).toString());
    assert.equal(observation.candidateHead, null);
    assert.equal(observation.inputHead, BASE);
    assert.equal(observation.unchangedAndClean, false);
    assert.match(observation.workspaceDiagnostic, /controller.currentHead/);
    validateCorrectionState(state);
    for (const kind of ["launched", "accepted"] as const) {
      assert.throws(() => validateCorrectionState({ ...state, reportCorrections: [...ledger.slice(0, 2), { ...ledger[2]!, kind, used: 1, remaining: 0 }] }), /known candidate identity/);
    }
  } finally { await h.cleanup(); }
});
for (const classification of ["authentication", "infrastructure", "cancelled", "protocol"] as const) test(`${classification} execution failure never invokes correction`, async () => {
  await failure({ phaseFailure: new PhaseExecutionError(classification, `${classification} failure`) }, /failure/);
});
for (const change of ["head", "dirty", "status", "wiki", "identity"] as const) test(`correction ${change} mutation is terminal`, async () => {
  await failure({ maximum: 2, correction: async (request, h) => {
    const value = payload(request.input);
    if (change === "head") h.head = BASE;
    if (change === "dirty") h.clean = false;
    if (change === "status") value.status = "failed";
    if (change === "wiki") value.details.projectWiki.reason = "invented";
    if (change === "identity") value.runId = "forged";
    return JSON.stringify(value);
  } }, /report correction stopped/, 1);
});
test("shared deadline expiry after charged correction stops without renewed allowance", async () => {
  const state = await failure({ staged: true, maximum: 2, correction: async (request, h) => {
    // Advance the injected controller clock, not the immutable deadline.
    h.expireDeadline();
    return JSON.stringify(payload(request.input));
  } }, /aborted|timeout|deadline/i, 1);
  assert.equal(state.stagedTransitions?.at(-1)?.classification, "timeout");
});
test("cancellation records charged call and preserves returned evidence", async () => {
  const abort = new AbortController();
  const h = await harness({ correction: async request => { abort.abort(new Error("operator cancellation")); return JSON.stringify(payload(request.input)); } });
  try {
    await assert.rejects(h.controller.run(REQUEST, abort.signal), /operator cancellation/);
    const state = await h.states.read("aidev-295-0123456789");
    assert.equal(state?.status, "interrupted");
    assert.equal(state?.reportCorrections?.at(-1)?.used, 1);
    assert.equal(h.published, 0);
  } finally { await h.cleanup(); }
});

for (const corrected of [false, true]) for (const mismatch of ["missing", "content", "length", "digest", "producer"]) test(`${corrected ? "corrected" : "original"} evidence ${mismatch} blocks acceptance`, async () => {
  await failure({ tamper: (capture, h, isCorrected) => {
    if (corrected !== isCorrected) return capture;
    if (mismatch === "missing") h.evidence.bytes.delete(capture.evidence.path);
    if (mismatch === "content") h.evidence.bytes.set(capture.evidence.path, Buffer.from(capture.raw.replace("synthetic", "different")));
    if (mismatch === "length") return { ...capture, evidence: { ...capture.evidence, byteLength: capture.evidence.byteLength + 1 } };
    if (mismatch === "digest") return { ...capture, evidence: { ...capture.evidence, sha256: "0".repeat(64) } };
    if (mismatch === "producer") return { ...capture, sessionId: "forged" };
    return capture;
  } }, /evidence|producer/, corrected ? 1 : 0);
});
test("altered controller observation with self-consistent adapter metadata is rejected by content", async () => {
  const h = await harness();
  const write = h.evidence.write.bind(h.evidence);
  h.evidence.write = async content => write(content.includes('"producer":"controller"') ? content.replace('"unchangedAndClean":true', '"unchangedAndClean":false') : content);
  try { await assert.rejects(h.controller.run(REQUEST), /content\/length\/digest mismatch/); assert.equal(h.corrections.length, 0); }
  finally { await h.cleanup(); }
});
test("old evidence altered during correction cannot be hidden by valid corrected output", async () => {
  await failure({ correction: async (request, h) => { h.evidence.bytes.delete(request.original.evidence.path); return JSON.stringify(payload(request.input)); } }, /missing evidence/, 1);
});

test("safe host exact reads reject missing, replaced, unsafe and digest-mismatched evidence", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-report-evidence-"));
  const port = new FileReportEvidence(root);
  try {
    const ref = await port.write("original");
    await verifyReportEvidence(port, ref, "original");
    assert.equal(await readFile(ref.path, "utf8"), "original");
    await assert.rejects(verifyReportEvidence(port, { ...ref, sha256: "f".repeat(64) }, "original"), /digest/);
    await assert.rejects(verifyReportEvidence(port, ref, "different"), /content/);
    await assert.rejects(port.read({ ...ref, byteLength: 2 }), /exact read/);
    await assert.rejects(port.read({ ...ref, path: path.join(root, "..", "elsewhere") }), /unsafe/);
    await assert.rejects(port.write("x".repeat(MAX_REPORT_BYTES + 1)), /bound/);
    await chmod(ref.path, 0o600); await writeFile(ref.path, "altered!"); await chmod(ref.path, 0o400);
    await assert.rejects(port.read(ref), /replaced/);
    const replaced = await port.write("same");
    await rename(replaced.path, replaced.path + ".old"); await writeFile(replaced.path, "same", { mode: 0o400 });
    await assert.rejects(port.read(replaced), /replaced/);
    await unlink(replaced.path); await symlink(ref.path, replaced.path);
    await assert.rejects(port.read(replaced));
    await unlink(replaced.path); await mkdir(replaced.path);
    await assert.rejects(port.read(replaced), /unsafe/);
    const missing = await port.write("missing"); await unlink(missing.path); await assert.rejects(port.read(missing), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restricted runner uses no tools/inherited session and remaining deadline; preserves exact corrected bytes", { skip: process.platform !== "linux" }, async () => {
  const h = await harness();
  try {
    await h.controller.run(REQUEST);
    const request = h.corrections[0]!;
    const commands: CommandRequest[] = [];
    const raw = JSON.stringify(payload(request.input));
    const runner = new SandboxPiPhaseRunner({ stagingRoot: h.root, testCommands: [], commands: { byteOutput: true, async run(spec) { commands.push(spec); return { stdout: raw, stdoutBytes: Buffer.from(raw), stderr: "", exitCode: 0 }; } } });
    const capture = await runner.correctReport(request);
    const launch = commands.at(-1)!;
    for (const flag of ["--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-approve"]) assert.ok(launch.args.includes(flag));
    assert.ok(!launch.args.includes("/ticket/workspace"));
    assert.ok(!launch.args.includes("--session"));
    assert.ok(launch.timeoutMs! > 0 && launch.timeoutMs! < 60000);
    const data = JSON.parse(launch.args.at(-1)!);
    assert.deepEqual(data.schema, correctionSchema(request.input, request.original));
    assert.equal(data.diagnostic, request.diagnostic);
    assert.equal(capture.sessionId, request.producerId);
    await verifyReportEvidence(runner.reportEvidence, capture.evidence, raw);
  } finally { await h.cleanup(); }
});

for (const kind of ["replace", "alter", "truncate", "root"] as const) test(`safe evidence detects ${kind} during exact read`, { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-evidence-race-"));
  const original = new FileReportEvidence(path.join(root, "evidence"));
  try {
    const ref = await original.write("original content");
    const racing = new FileReportEvidence(original.root, { afterRead: async () => {
      if (kind === "root") { await rename(original.root, original.root + ".old"); await mkdir(original.root, { mode: 0o700 }); }
      else if (kind === "replace") { await rename(ref.path, ref.path + ".old"); await writeFile(ref.path, "original content", { mode: 0o400 }); }
      else { await chmod(ref.path, 0o600); await writeFile(ref.path, kind === "alter" ? "modified content" : ""); await chmod(ref.path, 0o400); }
    } });
    await assert.rejects(verifyReportEvidence(racing, ref, "original content"), /changed during exact read/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("evidence symlink ancestor and unsafe permissions are rejected", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-evidence-path-"));
  try {
    await mkdir(path.join(root, "real"), { mode: 0o700 });
    await symlink(path.join(root, "real"), path.join(root, "link"));
    await assert.rejects(new FileReportEvidence(path.join(root, "link", "reports")).write("report"), /unsafe/);
    const port = new FileReportEvidence(path.join(root, "real"));
    const ref = await port.write("report");
    await chmod(ref.path, 0o644); await assert.rejects(port.read(ref), /unsafe/);
    await chmod(ref.path, 0o400); await chmod(port.root, 0o755);
    await assert.rejects(port.read(ref), /unsafe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("ownership loss before correction never launches or removes retained owner", async () => {
  const h = await harness({ beforeOriginal: h => { h.states.reservationOwner = async () => "aidev-295-retained"; } });
  try {
    await assert.rejects(h.controller.run(REQUEST), /ownership mismatch/);
    assert.equal(h.corrections.length, 0);
    assert.equal(h.published, 0);
  } finally { await h.cleanup(); }
});
for (const staged of [false, true]) for (const captured of [false, true]) for (const classification of ["authentication", "infrastructure", "timeout", "cancelled"] as const) test(`${staged ? "staged" : "ordinary"} ${captured ? "captured" : "launch"} correction ${classification} preserves classification without retry`, async () => {
  const h = await harness({ staged, maximum: 2, correction: async (request, h) => {
    const error = new PhaseExecutionError(classification, `correction ${classification} failure`);
    if (!captured) throw error;
    // Even a strictly valid response from a failed execution is evidence only.
    const raw = JSON.stringify(payload(request.input));
    throw new CorrectionExecutionFailure({ raw, timestamp: new Date().toISOString(), sessionId: request.producerId, sessionFile: `/run/squire-report-${request.producerId}/no-session`, evidence: await h.evidence.write(raw) }, error);
  } });
  try {
    await assert.rejects(h.controller.run(REQUEST), error => {
      assert.ok(error instanceof PhaseExecutionError);
      assert.equal(error.classification, classification);
      assert.match(error.message, /implement details.*correction .* failure.*human action/);
      return true;
    });
    const state = (await h.states.read("aidev-295-0123456789"))!;
    assert.equal(state.status, classification === "cancelled" ? "interrupted" : "failed");
    assert.deepEqual(h.calls, ["plan", "implement"]);
    assert.equal(h.published, 0);
    assert.equal(h.corrections.length, 1);
    assert.equal(state.reportCorrections?.at(-1)?.kind, "stopped");
    assert.equal(state.reportCorrections?.at(-1)?.used, 1);
    assert.equal(state.reportCorrections?.at(-1)?.remaining, 1);
    if (captured) {
      const response = state.reportCorrections!.find(r => r.producer === h.corrections[0]!.producerId)!;
      assert.ok(response.evidence);
      await verifyReportEvidence(h.evidence, response.evidence, JSON.stringify(payload(h.corrections[0]!.input)));
    }
    if (staged) {
      assert.equal(state.stagedTransitions?.at(-1)?.reason, "execution_failure");
      assert.equal(state.stagedTransitions?.at(-1)?.classification, classification);
      const events = await h.states.readEvents(state.runId);
      assert.ok(events.some(e => e.staged?.kind === "closed" && e.staged.classification === classification));
    }
    assert.equal(await h.states.reservationOwner(REQUEST.ticketId), undefined);
  } finally { await h.cleanup(); }
});

test("staged attempt accounting is independent from correction charges", async () => {
  const h = await harness({ staged: true, maximum: 2 });
  try {
    const state = await h.controller.run(REQUEST);
    assert.equal(state.attempts.implement, 1);
    assert.equal(state.stagedTransitions?.length, 2);
    assert.equal(state.stagedTransitions?.at(-1)?.consumed, 1);
    assert.equal(state.stagedTransitions?.at(-1)?.remaining, 1);
    assert.equal(state.reportCorrections?.at(-1)?.used, 1);
    assert.equal(state.reportCorrections?.at(-1)?.remaining, 1);
  } finally { await h.cleanup(); }
});
test("ambiguous duplicate JSON facts are never corrected", async () => {
  await failure({ original: v => JSON.stringify(v).replace('"status":"passed"', '"status":"failed","status":"passed"') }, /duplicate JSON member/);
});
test("restricted runner preserves partial stdout from a failed correction but cannot accept it", { skip: process.platform !== "linux" }, async () => {
  const h = await harness();
  try {
    await h.controller.run(REQUEST);
    const request = h.corrections[0]!;
    const runner = new SandboxPiPhaseRunner({ stagingRoot: h.root, testCommands: [], commands: { byteOutput: true, async run(spec) {
      if (spec.args.includes("--no-tools")) throw new CommandExecutionError("timeout", "timed out", '{"outputHead":', undefined, Buffer.from('{"outputHead":'));
      return { stdout: "", stderr: "" };
    } } });
    let failure: unknown;
    try { await runner.correctReport(request); } catch (error) { failure = error; }
    assert.ok(failure instanceof CorrectionExecutionFailure);
    assert.equal(failure.classification, "timeout");
    await verifyReportEvidence(runner.reportEvidence, failure.capture.evidence, '{"outputHead":');
  } finally { await h.cleanup(); }
});
