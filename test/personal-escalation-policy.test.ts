import { loadPersonalMvpConfig } from "../src/personal/config.js";
import { NodeCommandRunner } from "../src/personal/command.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { PersonalMvpController } from "../src/personal/controller.js";
import { escalationDigest, validateEscalationPolicy, type EscalationPolicy } from "../src/personal/model-policy.js";
import { PhaseExecutionError, EXECUTION_FAILURES } from "../src/personal/execution-failure.js";
import { assertStagedUnchanged, validateStagedState } from "../src/personal/staged-attempts.js";
import { JsonRunStateStore, validateState } from "../src/personal/json-run-state.js";
import { deriveRunEvents, synthesizeCurrentRunEvents, validateRunEvent } from "../src/personal/run-events.js";
import { formatRunStatus, formatRunEvent } from "../src/personal/status.js";
import { captureLaunchMaterial, persistLaunchMaterial, readLaunchMaterial } from "../src/personal/launch-material.js";
import { TEST_MATERIAL } from "./helpers/personal-launch.js";
import type { PersonalRunState, PhaseInput, PhaseResult, RunStatePort } from "../src/personal/types.js";

const stage = (model = "user-model", maxAttempts = 1) => ({ provider: "user-provider", model, thinking: "high" as const, maxAttempts });
const policy: EscalationPolicy = { implement: { stages: [stage("first", 2), stage("second")] } };
const request = { ticketId: "AIDEV-277", repository: "example/repo", repositoryPath: "/tmp/example-repo", sourceRef: "HEAD", baseBranch: "main" };
const base = "a".repeat(40);
function result(input: PhaseInput, status: PhaseResult["status"] = "passed", head = input.expectedHead): PhaseResult {
  const common = { runId: input.runId, attempt: input.attempt, sessionId: `${input.phase}-${input.attempt}`, sessionFile: `/ticket/sessions/${input.phase}/${input.attempt}.jsonl`, inputHead: input.expectedHead, outputHead: head, profile: input.profile, status, summary: `${input.phase} ${status}` };
  switch (input.phase) {
    case "plan": return { ...common, phase: "plan", details: { steps: ["deliver"] } };
    case "implement": return { ...common, phase: "implement", details: { changes: ["change"], projectWiki: { status: "not_required", reason: "no durable knowledge change" } } };
    case "review": return { ...common, phase: "review", details: { findings: status === "passed" ? [] : ["fix this"] } };
    case "test": return { ...common, phase: "test", details: { commands: [{ command: "npm test", exitCode: status === "passed" ? 0 : 1, summary: status }] } };
    case "retro": return { ...common, phase: "retro", details: { lessons: ["lesson"], followUps: [] } };
  }
}
function harness(run?: (input: PhaseInput) => PhaseResult | Promise<PhaseResult>, options: { policy?: EscalationPolicy; states?: RunStatePort; material?: typeof TEST_MATERIAL } = {}) {
  let state: PersonalRunState;
  const history: PersonalRunState[] = [];
  const inputs: PhaseInput[] = [];
  let publications = 0;
  let clean = true;
  let head = base;
  const states: RunStatePort = options.states ?? {
    async create(next) { validateState(next); state = structuredClone(next); history.push(state); },
    async save(next) { validateState(next); assertStagedUnchanged(state, next); state = structuredClone(next); history.push(state); },
    async findActive() { return undefined; },
  };
  const controller = new PersonalMvpController({ states, ...(options.policy ? { escalationPolicy: options.policy } : {}), ...(options.material ? { launchMaterial: options.material } : {}), newId: () => "1234567890", tickets: { async get(id) { return { id, title: "test", description: "test" }; } },
    workspaces: {
      async prepare() { return { sandbox: "unused", baseSha: base, head: base }; },
      async assertClean() { if (!clean) throw new Error("dirty"); }, async currentHead() { return head; },
      async committedProjectWikiPaths() { return []; },
      async exportBundle(input) { return { ...input, path: "/bundle", sha256: "f".repeat(64), byteLength: 1 }; },
    },
    phases: { async run(input) { inputs.push(input); return run ? run(input) : result(input); } },
    publication: { async publish() { publications++; return { url: "https://example.com/pr/1", reused: false }; } },
  });
  return { controller, inputs, history, get state() { return state!; }, get publications() { return publications; }, setClean(value: boolean) { clean = value; }, setHead(value: string) { head = value; } };
}

test("closed escalation schema accepts user ordering and every bound, rejects malformed policies", () => {
  for (const value of [null, [], {}, { unknown: {} }, { implement: {} }, { implement: { stages: [], extra: true } }, { implement: { stages: [] } }, { implement: { stages: Array.from({ length: 9 }, () => stage()) } }, { implement: { stages: [stage("a", 16), stage("b", 16), stage()] } }]) assert.throws(() => validateEscalationPolicy(value));
  for (const invalid of [0, -1, 17, 1.5, "2", null, NaN, Infinity]) assert.throws(() => validateEscalationPolicy({ implement: { stages: [{ ...stage(), maxAttempts: invalid }] } }));
  for (const bad of [{ extra: true }, { provider: "" }, { model: "bad\nmodel" }, { thinking: "ultra" }, { model: "x".repeat(257) }]) assert.throws(() => validateEscalationPolicy({ plan: { stages: [{ ...stage(), ...bad }] } }));
  for (const key of ["provider", "model", "thinking", "maxAttempts"]) { const s: any = stage(); delete s[key]; assert.throws(() => validateEscalationPolicy({ plan: { stages: [s] } })); }
  for (const stages of [[stage()], [stage("a", 16), stage("b", 16)], Array.from({ length: 8 }, () => stage("any", 4))]) assert.deepEqual(validateEscalationPolicy({ retro: { stages } }), { retro: { stages } });
  const detached = validateEscalationPolicy(policy);
  assert.notEqual(detached.implement!.stages, policy.implement!.stages);
  assert.equal(escalationDigest(policy), escalationDigest(JSON.parse('{"implement":{"stages":[{"maxAttempts":2,"thinking":"high","model":"first","provider":"user-provider"},{"maxAttempts":1,"model":"second","provider":"user-provider","thinking":"high"}]}}')));
});

test("same-stage retry, exact boundary advance, failed committed HEAD, feedback and fresh gates", async () => {
  const h = harness(input => {
    if (input.phase === "implement") {
      const head = String(input.attempt).repeat(40); h.setHead(head);
      return { ...result(input, input.attempt < 3 ? "failed" : "passed", head), summary: "applicable feedback" };
    }
    return result(input);
  }, { policy });
  const state = await h.controller.run(request);
  assert.equal(state.status, "completed");
  const implementations = h.inputs.filter(i => i.phase === "implement");
  assert.deepEqual(implementations.map(i => i.profile.model), ["first", "first", "second"]);
  assert.deepEqual(implementations.map(i => i.expectedHead), [base, "1".repeat(40), "2".repeat(40)]);
  assert.deepEqual(implementations[1]!.feedback, ["applicable feedback"]);
  assert.equal(implementations[2]!.previous.implement!.status, "failed");
  for (const phase of ["review", "test", "retro"] as const) assert.equal(state.results[phase]!.inputHead, "3".repeat(40));
  const transitions = state.stagedTransitions!;
  assert.deepEqual(transitions.map(t => t.reason), ["initial", "result", "retry", "result", "stage_advanced", "result"]);
  assert.equal(transitions.at(-1)!.remaining, 0);
  assert.equal(h.publications, 1);
  const reconstructed = synthesizeCurrentRunEvents(state);
  assert.equal(reconstructed.find(e => e.type === "phase_completed" && e.phase === "implement" && e.attempt === 1)!.outcome, "failed");
  for (const event of reconstructed) validateRunEvent(event);
  assert.match(formatRunEvent(reconstructed.find(e => e.type === "staged_reserved" && e.attempt === 3)!), /stage=2.*remaining=0.*second.*stage_advanced/);
  const during = h.history.find(s => s.stagedTransitions?.at(-1)?.reason === "stage_advanced")!;
  assert.match(formatRunStatus(during), /Model: second/);
  assert.match(formatRunStatus(during), /stage=2\/2.*consumed=3 remaining=0/);
  const derived = h.history.flatMap((s, i) => deriveRunEvents(h.history[i - 1], s));
  assert.equal(derived.filter(e => e.type === "staged_closed").length, 3);
  for (const e of derived.filter(e => e.type.startsWith("staged_"))) assert.ok(reconstructed.some(r => r.eventId === e.eventId));
});

test("exhaustion is terminal, actionable and leaves only real failed evidence", async () => {
  const h = harness(input => result(input, input.phase === "implement" ? "failed" : "passed"), { policy });
  await assert.rejects(h.controller.run(request), /phase=implement policy=[a-f0-9]{64} stage=1 consumed=3 configured=3 trigger=eligible_failure/);
  assert.equal(h.state.status, "failed"); assert.equal(h.publications, 0);
  assert.equal(h.state.results.implement!.status, "failed");
  assert.equal(h.state.attempts.implement, 3);
});

for (const classification of [...EXECUTION_FAILURES, "untyped"] as const) test(`terminal ${classification} failure never launches a later slot`, async () => {
  const h = harness(input => {
    if (input.phase === "implement") throw classification === "untyped" ? new Error("authentication string is not authority") : new PhaseExecutionError(classification, "trusted failure");
    return result(input);
  }, { policy });
  await assert.rejects(h.controller.run(request));
  assert.equal(h.state.attempts.implement, 1);
  assert.equal(h.state.stagedTransitions!.at(-1)!.classification, classification === "untyped" ? "unknown" : classification);
  assert.equal(h.state.status, classification === "cancelled" ? "interrupted" : "failed");
  assert.equal(h.publications, 0);
});

test("AbortSignal cancellation after reservation consumes only its slot", async () => {
  const abort = new AbortController();
  const h = harness(input => { if (input.phase === "implement") { abort.abort(); throw new Error("stop"); } return result(input); }, { policy });
  await assert.rejects(h.controller.run(request, abort.signal));
  assert.equal(h.state.status, "interrupted");
  assert.equal(h.state.stagedTransitions!.at(-1)!.classification, "cancelled");
});

test("preflight dirty or wrong HEAD consumes no staged slot, postflight dirty cannot retry", async () => {
  for (const mode of ["pre-dirty", "pre-head", "post-dirty"] as const) {
    const h = harness(input => {
      if (input.phase === "implement") { h.setClean(false); return result(input, "failed"); }
      return result(input);
    }, { policy });
    if (mode === "pre-dirty") h.setClean(false);
    if (mode === "pre-head") h.setHead("b".repeat(40));
    await assert.rejects(h.controller.run(request));
    assert.equal(h.state.attempts.implement, mode === "post-dirty" ? 1 : 0);
  }
});

test("malformed and provenance-invalid failed results fail closed", async () => {
  for (const mutate of [(r: any) => { r.extra = true; }, (r: any) => { r.profile.model = "wrong"; }, (r: any) => { delete r.profile; }, (r: any) => { r.sessionFile = "/wrong"; }, (r: any) => { r.inputHead = "c".repeat(40); }, (r: any) => { r.outputHead = "c".repeat(40); }]) {
    const h = harness(input => { const r = structuredClone(result(input, input.phase === "implement" ? "failed" : "passed")); if (input.phase === "implement") mutate(r); return r; }, { policy });
    await assert.rejects(h.controller.run(request));
    assert.equal(h.state.attempts.implement, 1);
    assert.equal(h.state.stagedTransitions!.at(-1)!.classification, "protocol");
  }
});

test("omitted policy and omitted phases keep fixed-profile one-shot failure behavior", async () => {
  for (const p of [undefined, { retro: { stages: [stage()] } }]) {
    const h = harness(input => result(input, input.phase === "implement" ? "failed" : "passed"), p ? { policy: p } : {});
    await assert.rejects(h.controller.run(request), /implement failed/);
    assert.equal(h.state.attempts.implement, 1);
    assert.equal(h.state.stagedTransitions?.length ?? 0, 0);
    assert.equal(h.inputs.find(i => i.phase === "implement")!.profile.model, h.state.profiles!.implement.model);
  }
});

test("Review/Test remediation shares global schedule counters and never retries unchanged gates", async () => {
  const p = { implement: { stages: [stage("one"), stage("two", 3)] }, review: { stages: [stage("review", 4)] }, test: { stages: [stage("test", 3)] } };
  const h = harness(input => result(input, (input.phase === "review" || input.phase === "test") && input.attempt === 1 ? "remediation_required" : input.phase === "implement" && input.attempt === 2 ? "failed" : "passed"), { policy: p });
  const state = await h.controller.run(request);
  assert.deepEqual(h.inputs.map(i => i.phase), ["plan", "implement", "review", "implement", "implement", "review", "test", "implement", "review", "test", "retro"]);
  assert.deepEqual(state.remediations, { review: 1, test: 1 });
  assert.equal(state.attempts.implement, 4);
  assert.deepEqual(h.inputs[3]!.feedback, ["fix this"]);
  assert.equal(state.stagedTransitions!.filter(t => t.classification === "remediation_required").length, 2);
});

test("remediation caps and schedule allowances intersect instead of multiplying", async () => {
  for (const budget of [1, 8]) {
    const h = harness(input => result(input, input.phase === "review" ? "remediation_required" : "passed"), { policy: { implement: { stages: [stage("i", budget)] }, review: { stages: [stage("r", budget)] } } });
    await assert.rejects(h.controller.run(request));
    assert.equal(h.state.attempts.implement, budget === 1 ? 1 : 2);
    assert.equal(h.state.attempts.review, budget === 1 ? 1 : 2);
    assert.equal(h.state.attempts.test, 0);
    assert.equal(h.publications, 0);
  }
});

test("journals are ordered, append-only, profile-bound; open reservations remain consumed", async () => {
  const h = harness(undefined, { policy }); await h.controller.run(request);
  const open = h.history.find(s => s.stagedTransitions?.length === 1)!;
  validateState(open);
  assert.equal(open.attempts.implement, 1);
  const mutations = [
    (s: any) => { s.escalationPolicy.implement.stages[0].model = "mutated"; },
    (s: any) => { s.stagedTransitions[0].profile.model = "wrong"; },
    (s: any) => { s.stagedTransitions.push(s.stagedTransitions[0]); },
    (s: any) => { s.attempts.implement = 0; },
    (s: any) => { s.stagedTransitions[1].classification = "eligible_failure"; },
  ];
  for (const mutate of mutations) { const s = structuredClone(h.state); mutate(s); assert.throws(() => validateStagedState(s)); }
  assert.throws(() => assertStagedUnchanged(h.state, { ...h.state, stagedTransitions: [] }), /append-only/);
  assert.throws(() => assertStagedUnchanged(h.state, { ...h.state, escalationPolicy: { implement: { stages: [stage("replacement")] } } }), /immutable/);
});

test("foreground and detached execution use identical frozen schedules, reject capture mismatch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-escalation-"));
  try {
    const config = { ...TEST_MATERIAL.config, escalationPolicy: structuredClone(policy) };
    const bytes = Buffer.from(JSON.stringify(config));
    const digest = createHash("sha256").update(bytes).digest("hex");
    const material = await captureLaunchMaterial({ config, rawConfig: bytes.toString("base64"), digest });
    (config.escalationPolicy.implement!.stages[0] as any).model = "later-config-edit";
    const run = (input: PhaseInput) => result(input, input.phase === "implement" && input.attempt < 3 ? "failed" : "passed");
    const foreground = harness(run, { material });
    const a = await foreground.controller.run(request);
    const states = new JsonRunStateStore(root);
    const detached = harness(run, { states, material });
    const reserved = await detached.controller.reserve(request, { executionMode: "background", launchConfigDigest: digest });
    await persistLaunchMaterial(material, reserved, root);
    assert.deepEqual((await readLaunchMaterial(reserved, root)).config.escalationPolicy, policy);
    await assert.rejects(persistLaunchMaterial(material, { ...reserved, escalationDigest: "f".repeat(64) }, root), /escalation policy mismatch/);
    const b = await detached.controller.runReserved(request, reserved.runId, digest);
    assert.equal(b.status, "completed");
    assert.deepEqual(a.stagedTransitions, b.stagedTransitions);
    assert.deepEqual(a.attempts, b.attempts);
    assert.deepEqual(foreground.inputs.map(i => i.profile), detached.inputs.map(i => i.profile));
    const events = await states.readEvents(b.runId);
    assert.equal(events.filter(e => e.type === "staged_closed").length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed non-Implement HEAD drift cannot retry, and retry feedback is bounded", async () => {
  const p = { review: { stages: [stage("r", 3)] } };
  const drift = harness(input => {
    if (input.phase === "review") { drift.setHead("b".repeat(40)); return result(input, "failed", "b".repeat(40)); }
    return result(input);
  }, { policy: p });
  await assert.rejects(drift.controller.run(request), /changed Git HEAD/);
  assert.equal(drift.state.attempts.review, 1);
  assert.equal(drift.state.stagedTransitions!.at(-1)!.classification, "protocol");
  const bounded = harness(input => {
    if (input.phase === "review" && input.attempt === 1) return { ...result(input, "failed"), phase: "review", details: { findings: Array.from({ length: 100 }, () => "x".repeat(8000)) } };
    return result(input);
  }, { policy: p });
  await bounded.controller.run(request);
  const retry = bounded.inputs.find(i => i.phase === "review" && i.attempt === 2)!;
  assert.equal(retry.feedback.length, 20);
  assert.ok(retry.feedback.every(f => f.length === 2000));
});

test("all configured phases retry only at their top-level boundary", async () => {
  const p = Object.fromEntries(["plan", "implement", "review", "test", "retro"].map(phase => [phase, { stages: [stage("one"), stage("two")] }])) as EscalationPolicy;
  const h = harness(input => result(input, input.attempt === 1 ? "failed" : "passed"), { policy: p });
  const state = await h.controller.run(request);
  assert.deepEqual(state.attempts, { plan: 2, implement: 2, review: 2, test: 2, retro: 2 });
  assert.equal(state.stagedTransitions!.length, 20);
  assert.deepEqual(state.remediations, { review: 0, test: 0 });
});


test("user-global loading and capture reject malformed or mismatched schedules before reservation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-policy-config-"));
  try {
    const file = path.join(root, "config.json");
    for (const escalationPolicy of [{}, { implement: { stages: [] } }, { implement: { stages: [{ ...stage(), tools: ["bash"] }] } }]) {
      await writeFile(file, JSON.stringify({ ...TEST_MATERIAL.config, escalationPolicy }));
      await assert.rejects(loadPersonalMvpConfig(file, { env: {} }));
    }
    await writeFile(file, JSON.stringify({ ...TEST_MATERIAL.config, escalationPolicy: policy }));
    assert.deepEqual((await loadPersonalMvpConfig(file, { env: {} })).escalationPolicy, policy);
    const raw = Buffer.from(JSON.stringify({ ...TEST_MATERIAL.config, escalationPolicy: policy }));
    await assert.rejects(captureLaunchMaterial({ config: TEST_MATERIAL.config, rawConfig: raw.toString("base64"), digest: createHash("sha256").update(raw).digest("hex") }), /escalation policy mismatch/);
    const h = harness();
    await assert.rejects(h.controller.reserve({ ...request, escalationPolicy: {} }), /must not be empty/);
    assert.equal(h.history.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("command failures use machine signals, never authentication text", async () => {
  const commands = new NodeCommandRunner();
  await assert.rejects(commands.run({ command: "/missing-squire-command-277", args: [] }), (e: any) => e.classification === "infrastructure");
  await assert.rejects(commands.run({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 20 }), (e: any) => e.classification === "timeout");
  await assert.rejects(commands.run({ command: process.execPath, args: ["-e", "console.error('authentication failed'); process.exit(1)"] }), (e: any) => e.classification === "unknown");
});

test("an adapter returning success after cancellation cannot grant acceptance", async () => {
  const abort = new AbortController();
  const h = harness(input => { if (input.phase === "implement") abort.abort(); return result(input); }, { policy });
  await assert.rejects(h.controller.run(request, abort.signal), /interrupted/);
  assert.equal(h.state.status, "interrupted");
  assert.equal(h.state.results.implement, undefined);
  assert.equal(h.state.stagedTransitions!.at(-1)!.classification, "cancelled");
  assert.equal(h.state.attempts.implement, 1);
});
