import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore, validateState } from "../src/personal/json-run-state.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { classifyProviderLaunch } from "../src/personal/provider-launch.js";
import { classifyTransientLaunch, DAYBREAK_DIAGNOSTIC, launchPaths, validateLaunchRetryPolicy, type LaunchRecord, type LaunchRetryPolicy } from "../src/personal/launch-retry.js";
import { CommandExecutionError, type CommandRequest } from "../src/personal/command.js";
import { PhaseExecutionError } from "../src/personal/execution-failure.js";
import { formatRunStatus, formatRunEvent } from "../src/personal/status.js";
import { synthesizeCurrentRunEvents } from "../src/personal/run-events.js";
import { piEvents, piJson, jsonLines, fixtureProfile, fixtureSession } from "./helpers/pi-json.js";
import type { PhaseInput, PersonalRunState, WorkspacePort } from "../src/personal/types.js";

const BASE = "a".repeat(40), HEAD = "b".repeat(40);
const REQUEST = { ticketId: "AIDEV-310", repository: "example/repo", repositoryPath: "/source/repo", sourceRef: "refs/remotes/origin/main", baseBranch: "main" };
function failedEvents(id = fixtureSession, profile = fixtureProfile): any[] {
  const e = piEvents("", id, profile);
  e[0].cwd = "/ticket/workspace";
  const m = e[6].message;
  delete m.responseId;
  m.content = []; m.stopReason = "error"; m.errorMessage = DAYBREAK_DIAGNOSTIC;
  m.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  e[5].message = structuredClone(m);
  return e;
}
const classify = (e: unknown[]) => classifyProviderLaunch(jsonLines(e), { sessionId: fixtureSession, profile: fixtureProfile });
test("strict provider envelope recognizes Daybreak only before any response content", () => {
  const error = classify(failedEvents());
  assert.equal(classifyTransientLaunch(error)?.rule, "codex-daybreak-verification-v1");
  assert.equal(classifyTransientLaunch(new Error(DAYBREAK_DIAGNOSTIC)), undefined);
  assert.equal(classifyTransientLaunch(new PhaseExecutionError("infrastructure", DAYBREAK_DIAGNOSTIC)), undefined);
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE PROMPT|access_token/);
  const started = failedEvents(); started[5].message.stopReason = "pending"; delete started[5].message.errorMessage;
  assert.ok(classify(started));
});
for (const [name, mutate] of Object.entries<Record<string, (e: any[]) => void>[string]>({
  unknown: e => { e[6].message.errorMessage = "service unavailable"; },
  authentication: e => { e[6].message.errorMessage = "invalid API key"; },
  moderation: e => { e[6].message.errorMessage = "blocked by moderation"; },
  timeout: e => { e[6].message.stopReason = "aborted"; },
  content: e => { e[6].message.content = [{ type: "text", text: DAYBREAK_DIAGNOSTIC }]; },
  response: e => { e[6].message.responseId = "response"; },
  usage: e => { e[6].message.usage.input = 1; },
  tool: e => { e.splice(6, 0, { type: "tool_execution_start" }); },
  streaming: e => { e.splice(6, 0, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }); },
  session: e => { e[0].id = randomUUID(); },
  profile: e => { e[6].message.model = "other"; },
  extra: e => { e[6].message.secret = "access_token=PRIVATE"; },
  incomplete: e => { e.pop(); },
  duplicate: e => { e.push(e[6]); },
  result: e => { e[6].message.stopReason = "stop"; },
})) test(`provider launch classifier denies ${name}`, () => { const e = failedEvents(); mutate(e); assert.equal(classify(e), undefined); });
test("classifier denies partial, malformed, duplicate-key, oversized and untyped bytes", () => {
  const valid = jsonLines(failedEvents());
  for (const b of [valid.subarray(0, -1), Buffer.from([255]), Buffer.from(DAYBREAK_DIAGNOSTIC), Buffer.alloc(256 * 1024 + 1), Buffer.from(valid.toString().replace('"version":3', '"version":2,"version":3'))]) assert.equal(classifyProviderLaunch(b, { sessionId: fixtureSession, profile: fixtureProfile }), undefined);
});
test("retry policy is closed, default one and downward-only with bounded deterministic delay", () => {
  assert.deepEqual(validateLaunchRetryPolicy(), { maxRetries: 1, backoffMs: 1000 });
  for (const v of [null, {}, { maxRetries: 2, backoffMs: 0 }, { maxRetries: 1, backoffMs: -1 }, { maxRetries: 1, backoffMs: 30001 }, { maxRetries: 1, backoffMs: 1.5 }, { maxRetries: 1, backoffMs: 0, jitter: true }]) assert.throws(() => validateLaunchRetryPolicy(v));
});

async function harness(t: test.TestContext, options: { policy?: LaunchRetryPolicy; review?: (input: PhaseInput, workspace: { head: string; clean: boolean }) => Buffer | Error; authorize?: (input: PhaseInput) => Promise<boolean>; timeout?: number; crash?: (state: PersonalRunState) => boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshots: PersonalRunState[] = [];
  class States extends JsonRunStateStore { override async save(s: PersonalRunState) { await super.save(s); snapshots.push(structuredClone(s)); if (options.crash?.(s)) throw new Error("simulated lost controller after durable commit"); } }
  const states = new States(path.join(root, "state"));
  const workspace = { head: BASE, clean: true };
  const workspaces: WorkspacePort = {
    async prepare(i) { return { sandbox: i.sandbox, baseSha: BASE, head: BASE }; },
    async currentHead() { return workspace.head; },
    async assertClean() { if (!workspace.clean) throw new Error("dirty workspace"); },
    async committedProjectWikiPaths() { return []; },
    async exportBundle(i) { return { path: "/staging/candidate.bundle", sha256: "c".repeat(64), byteLength: 10, baseSha: i.baseSha, head: i.head, branch: i.branch }; },
  };
  const calls: PhaseInput[] = [];
  let active: PhaseInput;
  const runner = new SandboxPiPhaseRunner({ stagingRoot: path.join(root, "staging"), testCommands: ["npm test"], commands: {
    byteOutput: true,
    async run(command: CommandRequest) {
      if (command.args[0] === "cp") active = JSON.parse(await readFile(command.args[1]!, "utf8")) as PhaseInput;
      if (!command.args.includes("--mode")) return { stdout: "", stderr: "", stdoutBytes: Buffer.alloc(0) };
      calls.push(structuredClone(active));
      const session = active.reportSession!;
      if (active.phase === "review") {
        const response = options.review ? options.review(active, workspace) : active.launchGeneration === 1 ? jsonLines(failedEvents(session.sessionId, active.profile)) : undefined;
        if (response instanceof Error) throw response;
        if (response) return { stdout: response.toString(), stderr: "", stdoutBytes: response };
      }
      if (active.phase === "implement") workspace.head = HEAD;
      const details = active.phase === "plan" ? { steps: ["change"] } : active.phase === "implement" ? { changes: ["change"], projectWiki: { status: "not_required", reason: "fixture" } } : active.phase === "review" ? { findings: [] } : active.phase === "test" ? { commands: [{ command: "npm test", exitCode: 0, summary: "passed" }] } : { lessons: ["retry only launch"], followUps: [] };
      const bytes = piJson(JSON.stringify({ outputHead: workspace.head, status: "passed", summary: "passed", details }), session.sessionId, active.profile);
      return { stdout: bytes.toString(), stderr: "", stdoutBytes: bytes };
    },
  } });
  const controller = new PersonalMvpController({ states, workspaces, phases: runner, tickets: { async get(id) { return { id, title: "retry", description: "retry" }; } }, publication: { async publish() { return { url: "https://example.test/pr/1", reused: false }; } }, launchRetryPolicy: options.policy ?? { maxRetries: 1, backoffMs: 1 }, ...(options.authorize ? { authorizeLaunchCost: options.authorize } : {}), ...(options.timeout ? { phaseTimeoutMs: options.timeout } : {}) });
  return { root, states, controller, runner, calls, workspace, snapshots };
}
test("Daybreak before Review relaunches only Review at the exact accepted candidate with independent gates", async t => {
  const h = await harness(t);
  const result = await h.controller.run(REQUEST);
  assert.equal(result.status, "completed", result.lastError ?? "");
  assert.deepEqual(h.calls.map(i => i.phase), ["plan", "implement", "review", "review", "test", "retro"]);
  const reviews = h.calls.filter(i => i.phase === "review");
  assert.deepEqual(reviews.map(i => [i.expectedHead, i.attempt, i.launchGeneration]), [[HEAD, 1, 1], [HEAD, 1, 2]]);
  const { reportSession: _s1, launchGeneration: _g1, ...first } = reviews[0]!;
  const { reportSession: _s2, launchGeneration: _g2, ...second } = reviews[1]!;
  for (const v of [first, second] as unknown as Record<string, unknown>[]) { delete v["sessionId"]; delete v["sessionFile"]; }
  assert.deepEqual(first, second);
  assert.notEqual(_s1!.sessionId, _s2!.sessionId); assert.notEqual(_s1!.sessionFile, _s2!.sessionFile);
  assert.equal(result.results.implement?.outputHead, HEAD); assert.equal(result.head, HEAD);
  assert.notEqual(result.results.review?.sessionId, result.results.test?.sessionId);
  validateState(result);
  const wrongGeneration = structuredClone(result);
  const firstReview = wrongGeneration.launches!.find(r => r.phase === "review")!;
  const wrong = { ...wrongGeneration, sessions: { ...wrongGeneration.sessions, review: firstReview.sessionId }, results: { ...wrongGeneration.results, review: { ...wrongGeneration.results.review!, sessionId: firstReview.sessionId, sessionFile: firstReview.sessionFile } } };
  assert.throws(() => validateState(wrong), /unauthorized launch generation/);
  const reused = structuredClone(result);
  for (const r of reused.launches!.filter(r => r.phase === "review" && r.generation === 2)) (r as { sessionId: string }).sessionId = firstReview.sessionId;
  assert.throws(() => validateState(reused), /reused launch identity/);
  assert.throws(() => validateState({ ...result, launches: [] }), /unauthorized launch generation/);
  const legacy = h.snapshots.find(s => s.results.implement && !s.results.review)!;
  const { launches: _ledger, launchRetryPolicy: _policy, ...oldState } = legacy;
  validateState(oldState);
  const records = result.launches!.filter(r => r.phase === "review");
  assert.deepEqual(records.map(r => r.kind), ["reserved", "dispatched", "failed", "reserved", "dispatched", "returned"]);
  assert.equal(new Set(records.map(r => r.logicalDigest)).size, 1);
  assert.equal(new Set(records.map(r => r.promptDigest)).size, 1);
  assert.equal(new Set(records.map(r => r.deadline)).size, 1);
  const backoff = h.snapshots.find(s => s.launches?.at(-1)?.phase === "review" && s.launches.at(-1)?.generation === 2 && s.launches.at(-1)?.kind === "reserved")!;
  assert.match(formatRunStatus(backoff), /retrying-backoff/);
  const events = synthesizeCurrentRunEvents(result);
  const retry = events.filter(e => e.type.startsWith("launch_"));
  assert.deepEqual(retry.map(e => e.type), ["launch_failed", "launch_retry_scheduled", "launch_retry_started", "launch_retry_returned"]);
  assert.equal(new Set(retry.map(e => e.eventId)).size, 4);
  assert.doesNotMatch(retry.map(formatRunEvent).join(), /PRIVATE PROMPT|Unable to verify|access_token/);
  assert.equal(synthesizeCurrentRunEvents(result).filter(e => e.type.startsWith("launch_")).map(e => e.eventId).join(), retry.map(e => e.eventId).join());
  const telemetry = await h.runner.telemetry.finalize(result);
  assert.equal(telemetry.inventoryComplete, true);
  assert.equal(telemetry.sessions.length, 6);
  assert.equal(telemetry.sessions.filter(s => s.phase === "implement").length, 1);
  assert.equal(telemetry.sessions.filter(s => s.phase === "plan").length, 1);
  assert.deepEqual(telemetry.sessions.filter(s => s.phase === "review").map(s => s.launchGeneration).sort(), [1, 2]);
  assert.equal(telemetry.sessions.find(s => s.phase === "review" && s.launchGeneration === 1)?.outcome, "execution-failed");
  assert.equal(telemetry.sessions.find(s => s.phase === "review" && s.launchGeneration === 2)?.trigger, "retry");
  assert.equal(telemetry.complete, false, "unavailable failed-launch usage must not become invented zero cost");
  for (const phase of ["plan", "implement"] as const) {
    const original = telemetry.sessions.find(s => s.phase === phase)!;
    const totals = telemetry.phases.find(p => p.phase === phase)!.totals;
    assert.equal(totals.durationMs.known, original.durationMs, "no accepted-phase time replay");
    assert.equal(totals.tokens.input.known, 10, "no accepted-phase input-token replay");
  }
  assert.equal(telemetry.phases.find(p => p.phase === "implement")?.totals.recordedCost.known, "0.1");
  assert.equal(telemetry.phases.find(p => p.phase === "plan")?.totals.recordedCost.known, "0.1", "recovery avoids replaying the 0.2 known Plan/Implement cost");
});
for (const [label, options] of Object.entries({
  disabled: { policy: { maxRetries: 0, backoffMs: 0 } as LaunchRetryPolicy },
  retryFailedResult: { review: (i: PhaseInput) => i.launchGeneration === 1 ? jsonLines(failedEvents(i.reportSession!.sessionId, i.profile)) : piJson(JSON.stringify({ outputHead: i.expectedHead, status: "failed", summary: "bug", details: { findings: ["bug"] } }), i.reportSession!.sessionId, i.profile) },
  exhausted: { review: (i: PhaseInput) => jsonLines(failedEvents(i.reportSession!.sessionId, i.profile)) },
  dirty: { review: (i: PhaseInput, w: { clean: boolean }) => { w.clean = false; return jsonLines(failedEvents(i.reportSession!.sessionId, i.profile)); } },
  changed: { review: (i: PhaseInput, w: { head: string }) => { w.head = "c".repeat(40); return jsonLines(failedEvents(i.reportSession!.sessionId, i.profile)); } },
  untyped: { review: () => new Error(DAYBREAK_DIAGNOSTIC) },
  hardAuth: { review: () => new PhaseExecutionError("authentication", "invalid credential") },
  moderation: { review: (i: PhaseInput) => { const events = failedEvents(i.reportSession!.sessionId, i.profile); events[6].message.errorMessage = "moderation"; return jsonLines(events); } },
  implementation: { review: (i: PhaseInput) => piJson(JSON.stringify({ outputHead: i.expectedHead, status: "failed", summary: "implementation defect", details: { findings: ["bug"] } }), i.reportSession!.sessionId, i.profile) },
  processExit: { review: (i: PhaseInput) => new CommandExecutionError("unknown", "exit unproven", "", undefined, jsonLines(failedEvents(i.reportSession!.sessionId, i.profile))) },
  timeout: { review: (i: PhaseInput) => new CommandExecutionError("timeout", "timeout", "", undefined, jsonLines(failedEvents(i.reportSession!.sessionId, i.profile))) },
  malformed: { review: (i: PhaseInput) => piJson("{invalid", i.reportSession!.sessionId, i.profile) },
  budget: { authorize: async (i: PhaseInput) => i.launchGeneration !== 2 },
  budgetError: { authorize: async (i: PhaseInput) => { if (i.launchGeneration === 2) throw new Error("access_token=PRIVATE_BUDGET_RESPONSE"); return true; } },
  budgetIndeterminate: { authorize: async (i: PhaseInput) => i.launchGeneration === 2 ? undefined as unknown as boolean : true },
  deadline: { policy: { maxRetries: 1, backoffMs: 30000 } as LaunchRetryPolicy, timeout: 10000 },
})) test(`controller fails closed for ${label}`, async t => {
  const h = await harness(t, options);
  await assert.rejects(h.controller.run(REQUEST));
  const state = h.snapshots.at(-1)!;
  assert.equal(state.status, "failed");
  assert.doesNotMatch(formatRunStatus(state), /PRIVATE_BUDGET_RESPONSE/);
  assert.equal(h.calls.filter(i => i.phase === "review").length, ["exhausted", "retryFailedResult"].includes(label) ? 2 : 1);
  assert.equal(h.calls.filter(i => i.phase === "implement").length, 1);
  assert.equal(h.calls.filter(i => i.phase === "test").length, 0);
  validateState(state);
  if (label === "retryFailedResult") assert.equal((await h.runner.telemetry.finalize(state)).phaseOutcomes.review, "failed");
});

test("production JSON CAS permits one retry dispatch and rejects rewriting evidence, identity drift, stolen ownership and duplicate dispatch", async t => {
  const h = await harness(t);
  await h.controller.run(REQUEST);
  const reserved = h.snapshots.find(s => s.launches?.at(-1)?.generation === 2 && s.launches.at(-1)?.kind === "reserved")!;
  const directory = path.join(h.root, "race");
  const store = new JsonRunStateStore(directory);
  await store.reserve(reserved);
  const current = reserved.launches!.at(-1)!;
  const dispatched: LaunchRecord = { ...current, kind: "dispatched", elapsedDelayMs: current.delayMs };
  const next = { ...reserved, version: reserved.version + 1, launches: [...reserved.launches!, dispatched] };
  const race = await Promise.allSettled([store.save(next), new JsonRunStateStore(directory).save(next)]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
  await assert.rejects(store.save({ ...next, version: next.version + 1, launches: [...next.launches, dispatched] }), /launch transition/);
  for (const field of ["logicalDigest", "promptDigest", "expectedHead", "owner", "sessionId"] as const) {
    const drift = { ...dispatched, [field]: field === "expectedHead" ? "d".repeat(40) : field === "owner" || field === "sessionId" ? randomUUID() : "d".repeat(64), kind: "returned" as const };
    await assert.rejects(store.save({ ...next, version: next.version + 1, launches: [...next.launches, drift] }), /launch transition/);
  }
  const changed = structuredClone(next);
  (changed.launches.find(r => r.failure) as { failure: unknown }).failure = { version: 1, rule: "codex-daybreak-verification-v1", digest: "f".repeat(64) };
  await assert.rejects(store.save({ ...changed, version: next.version + 1 }), /append-only/);
  await assert.rejects(new JsonRunStateStore(directory).reserve(reserved), /reservation/);
  // Restart cannot claim a started lifecycle or invent process termination.
  await assert.rejects(h.controller.runReserved(REQUEST, reserved.runId, "d".repeat(64)));
  assert.equal((await store.read(reserved.runId))!.launches!.at(-1)!.kind, "dispatched");
});

test("generation paths are canonical sandbox paths on both host platforms", () => {
  for (const host of [path.posix, path.win32]) {
    const one = launchPaths("review", 1, 1), two = launchPaths("review", 1, 2);
    assert.notEqual(host.basename(one.sessionFile), host.basename(two.sessionFile));
    assert.equal(two.inputPath, "/ticket/artifacts/inputs/review-1-g2.json");
    assert.equal(two.sessionFile, "/ticket/sessions/review/1-g2.jsonl");
  }
});

for (const point of ["failed", "reserved", "dispatched", "returned"] as const) test(`crash after ${point} publication cannot replay accepted work or dispatch a retry twice`, async t => {
  const h = await harness(t, { crash: state => {
    const r = state.launches?.at(-1);
    return r?.phase === "review" && r.kind === point && r.generation === (point === "failed" ? 1 : 2);
  } });
  await assert.rejects(h.controller.run(REQUEST));
  const snapshot = h.snapshots.at(-1)!;
  const record = snapshot.launches!.at(-1)!;
  const expectedReviewCalls = point === "returned" ? 2 : 1;
  assert.equal(h.calls.filter(i => i.phase === "review").length, expectedReviewCalls);
  assert.equal(snapshot.results.implement?.outputHead, HEAD);
  // Read durable state from a distinct process, not the stale controller cache.
  const script = `import {JsonRunStateStore} from ${JSON.stringify(pathToFileURL(path.resolve("dist/src/personal/json-run-state.js")).href)};
    const state = await new JsonRunStateStore(process.argv[1]).read(process.argv[2]);
    if(state.launchState !== 'started' || state.results.implement.outputHead !== '${HEAD}') process.exit(2);
    process.stdout.write(JSON.stringify(state.launches.at(-1)));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, path.join(h.root, "state"), snapshot.runId], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), record);
  await assert.rejects(h.controller.run(REQUEST), /active|ambiguous reservation/);
  assert.equal(h.calls.filter(i => i.phase === "review").length, expectedReviewCalls);
  assert.equal(h.calls.filter(i => i.phase === "plan").length, 1);
  assert.equal(h.calls.filter(i => i.phase === "implement").length, 1);
});

test("pinned Pi Codex adapter and agent JSON envelopes reproduce the real pre-response Daybreak failure offline", async t => {
  const base = "/ticket/runtime/node_modules/@earendil-works/pi-coding-agent";
  if (!await access(path.join(base, "package.json")).then(() => true, () => false)) return t.skip("pinned ticket Pi runtime unavailable; portable envelope fixtures still run");
  const load = (relative: string) => import(pathToFileURL(path.join(base, relative)).href);
  const { runAgentLoop } = await load("node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js");
  const { stream } = await load("node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js");
  const { OPENAI_CODEX_MODELS } = await load("node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.models.js");
  const { toJsonEvent } = await load("dist/modes/json-event.js");
  // Synthetic non-secret JWT payload; no environment credentials or network.
  const credential = "e30." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url") + ".fixture";
  const events: unknown[] = [{ type: "session", version: 3, id: fixtureSession, timestamp: "2026-09-01T00:00:00.000Z", cwd: "/ticket/workspace" }];
  let requests = 0;
  await runAgentLoop([{ role: "user", content: "fixture", timestamp: 1 }], { systemPrompt: "fixture", messages: [], tools: [] }, { model: OPENAI_CODEX_MODELS[fixtureProfile.model], convertToLlm: (messages: unknown) => messages }, (event: unknown) => { events.push(toJsonEvent(event)); }, undefined,
    (model: unknown, context: unknown) => stream(model, context, { apiKey: credential, transport: "sse", maxRetries: 0, fetch: async () => { requests++; return new Response(JSON.stringify({ error: { message: DAYBREAK_DIAGNOSTIC } }), { status: 403 }); } }));
  assert.equal(requests, 1);
  assert.equal(classifyTransientLaunch(classify(events))?.rule, "codex-daybreak-verification-v1");
});

test("immutable generation input collision cannot overwrite or remove another launch's private bytes", async t => {
  const h = await harness(t);
  await h.controller.run(REQUEST);
  const review = h.calls.find(i => i.phase === "review")!;
  const target = path.join(h.root, "staging", review.runId, "phase-inputs", "review-1.json");
  await writeFile(target, "retained-original-evidence", { flag: "wx", mode: 0o600 });
  const before = h.calls.length;
  await assert.rejects(h.runner.run(review));
  assert.equal(await readFile(target, "utf8"), "retained-original-evidence");
  assert.equal(h.calls.length, before);
});
