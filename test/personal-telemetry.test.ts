import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseArguments } from "../src/personal/cli.js";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { captureLaunchMaterial } from "../src/personal/launch-material.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { CommandExecutionError, type CommandPort } from "../src/personal/command.js";
import { buildRunTelemetry, formatRunTelemetry, readRunTelemetry, TelemetryLedger, validateRunTelemetry, type RunTelemetry } from "../src/personal/telemetry.js";
import { PERSONAL_PHASES, type PersonalRunState, type PhaseInput } from "../src/personal/types.js";
import { createReportEvidence, verifyReportEvidence } from "../src/personal/report-evidence.js";
import { formatRunStatus } from "../src/personal/status.js";
import { deriveRunEvents } from "../src/personal/run-events.js";
import { TEST_MATERIAL } from "./helpers/personal-launch.js";
import { createPlanSbx } from "./helpers/plan-sbx.js";
import { assertProtectedAcl, launchTestRoot } from "./helpers/windows-launch.js";
import { piJsonEvents, piJsonStream, piThresholdCompactionEvents } from "./helpers/pi-json.js";
const BASE = "a".repeat(40);
const request = { ticketId: "AIDEV-299", repository: "example/repo", repositoryPath: "/fixture", sourceRef: "main", baseBranch: "main" };
const SECRET = "PROMPT RESPONSE TICKET SOURCE ENV=CREDENTIAL /credential/auth.json token-command";
type Fault = "malformed" | "duplicate" | "overflow" | "unsupported" | "interrupted" | "partial" | "publication" | "capture";
async function harness(options: { fault?: Fault; remediation?: boolean; staged?: boolean; compaction?: boolean } = {}) {
  const root = await launchTestRoot("squire-telemetry-");
  const stateDirectory = path.join(root, "state");
  const states = new JsonRunStateStore(stateDirectory);
  const escalationPolicy = options.staged ? { implement: { stages: [{ provider: "openai-codex", model: "small", thinking: "medium" as const, maxAttempts: 1 }, { provider: "openai-codex", model: "large", thinking: "high" as const, maxAttempts: 2 }] } } : undefined;
  const config = { ...TEST_MATERIAL.config, repository: { slug: "example/repo", path: "/fixture", sourceRef: "main", baseBranch: "main" }, dataDirectory: root, paths: { state: stateDirectory, staging: root, bridges: path.join(root, "bridges") }, promptPolicy: { version: 1 as const, id: "default", plan: ["requirements", "implementation-design"] as ("requirements" | "implementation-design")[] }, ...(escalationPolicy ? { escalationPolicy } : {}) };
  const raw = Buffer.from(JSON.stringify(config));
  const material = await captureLaunchMaterial({ config, digest: createHash("sha256").update(raw).digest("hex"), rawConfig: raw.toString("base64") });
  const sbx = await createPlanSbx(root, path.join(root, "plan-launches.jsonl"), options.compaction ? piThresholdCompactionEvents().map(e => JSON.stringify(e)).join("\n") + "\n" : "");
  const launches: PhaseInput[] = [];
  let input: PhaseInput;
  const abort = new AbortController();
  const commands: CommandPort = { byteOutput: true, async run(command) {
    if (command.args[0] === "cp") input = JSON.parse(await readFile(command.args[1]!, "utf8"));
    if (!command.args.includes("--print")) return { stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "" };
    assert.equal(command.args[command.args.indexOf("--mode") + 1], "json");
    launches.push(input);
    const phase = input.phase;
    const status = options.staged && phase === "implement" && input.attempt === 1 ? "failed" : options.remediation && (phase === "review" || phase === "test") && input.attempt === 1 ? "remediation_required" : "passed";
    const details = phase === "implement" ? { changes: ["fixture"], projectWiki: { status: "not_required", reason: "fixture" } } : phase === "review" ? { findings: status === "passed" ? [] : ["fix fixture"] } : phase === "test" ? { commands: [{ command: "fixture", exitCode: status === "passed" ? 0 : 1, summary: "fixture" }] } : { lessons: ["fixture"], followUps: [] };
    const text = JSON.stringify({ outputHead: BASE, status, summary: SECRET, details });
    const events = piJsonEvents(text, input.profile);
    if (phase === "implement") {
      if (options.fault === "malformed") events[4].message.usage.input = -1;
      if (options.fault === "duplicate") events.splice(5, 0, events[4]);
      if (options.fault === "unsupported") { events[4].message.api = "unsupported"; }
      if (options.fault === "partial" || options.fault === "interrupted") events.pop();
    }
    if (options.compaction) events.push(...piThresholdCompactionEvents());
    const bytes = Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n");
    if (phase === "implement" && options.fault === "interrupted") { abort.abort(); throw new CommandExecutionError("cancelled", "fixture interruption", "", undefined, bytes); }
    if (phase === "implement" && options.fault === "overflow") return { stdout: "", stdoutBytes: bytes.subarray(0, 40), terminalEventBytes: Buffer.from(JSON.stringify(events.at(-1)) + "\n"), stdoutTruncated: true, stderr: "" };
    return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
  } };
  const runner = new SandboxPiPhaseRunner({ commands, stagingRoot: root, telemetryStateDirectory: stateDirectory, testCommands: [], launchMaterial: material, sbxExecutable: sbx });
  // Controller selects supervised Plan, but fixed/staged policy is independently tested.
  const phases = { run: runner.run.bind(runner), finalizeTelemetry: runner.finalizeTelemetry.bind(runner), reportEvidence: runner.reportEvidence, reportCapture: runner.reportCapture.bind(runner) };
  const controller = new PersonalMvpController({ states, phases, launchMaterial: material, newId: () => "0123456789",
    tickets: { async get(id) { return { id, title: SECRET, description: SECRET }; } },
    workspaces: { async prepare() { return { sandbox: "fixture", head: BASE, baseSha: BASE }; }, async currentHead() { return BASE; }, async assertClean() {}, async committedProjectWikiPaths() { return []; }, async exportBundle(i) { return { ...i, path: "/fixture", sha256: "b".repeat(64), byteLength: 1 }; } },
    publication: { async publish() { return { url: "https://example.invalid/pr/1", reused: false }; } },
  });
  if (options.fault === "publication") { await mkdir(stateDirectory, { mode: 0o700 }); await writeFile(path.join(stateDirectory, "telemetry"), "blocked"); }
  if (options.fault === "capture") await writeFile(path.join(root, "telemetry-evidence"), "blocked");
  let state: PersonalRunState;
  try { state = await controller.run(request, abort.signal); }
  catch (error) { state = (await states.read("aidev-299-0123456789"))!; if (!state) throw error; }
  return { root, stateDirectory, states, state, runner, launches, async cleanup() { await runner.reportEvidence.release?.(); await runner.telemetry.release(); await rm(root, { recursive: true, force: true }); } };
}
async function summary(h: Awaited<ReturnType<typeof harness>>): Promise<RunTelemetry> {
  const result = await readRunTelemetry(h.state, h.stateDirectory);
  assert.equal(result.status, "available", JSON.stringify(result));
  assert.ok(result.status === "available"); return result.summary;
}

test("six-session controller capture, separate Plan rows, exact totals, restart reader and private evidence", async () => {
  const h = await harness();
  try {
    assert.equal(h.state.status, "completed", h.state.lastError ?? "");
    const s = await summary(h);
    assert.equal(s.sessions.length, 6);
    assert.deepEqual(s.sessions.map(r => r.subphase ?? r.phase), ["requirements", "implementation-design", "implement", "review", "test", "retro"]);
    assert.deepEqual(s.totals.tokens, { input: 60, output: 12, cacheRead: 180, cacheWrite: 24 });
    assert.equal(s.phases[0]!.totals.tokens.input, 20);
    assert.equal(s.planSubphases[0]!.totals.tokens.input, 10);
    assert.equal(s.phases.reduce((n, p) => n + p.totals.tokens.input, 0), s.totals.tokens.input);
    assert.equal(s.sessions.reduce((n, r) => n + r.durationMs!, 0), s.totals.durationMs);
    assert.equal(s.totals.providerCost, null); assert.equal(s.totals.costComplete, false);
    assert.equal(s.totals.tokensComplete, true);
    assert.equal(s.completeness, "incomplete", "no fabricated provider money");
    assert.ok(s.sessions.every(r => r.streamSha256 && r.streamBytes && r.piSessionId && r.outcome === "passed"));
    assert.ok(!JSON.stringify(s).includes(SECRET));
    assert.ok(!JSON.stringify(s).includes("auth.json"));
    assert.ok(!formatRunTelemetry({ status: "available", summary: s }).includes(SECRET));
    assert.match(formatRunTelemetry({ status: "available", summary: s }), /cost=unknown/);
    assert.match(formatRunStatus(h.state), /Telemetry: incomplete/);
    assert.ok(!JSON.stringify(deriveRunEvents(undefined, h.state)).includes("telemetry"));
    const before = await readFile(path.join(h.stateDirectory, h.state.runId + ".json"));
    const reread = await h.states.read(h.state.runId);
    assert.deepEqual(await readRunTelemetry(reread!, h.stateDirectory), { status: "available", summary: s });
    assert.deepEqual(await readFile(path.join(h.stateDirectory, h.state.runId + ".json")), before);
    assert.ok(h.state.telemetry?.status === "available");
    const artifact = h.state.telemetry.artifact;
    if (process.platform === "win32") assertProtectedAcl(artifact.path);
    else { assert.equal((await lstat(artifact.path)).mode & 0o777, 0o400); assert.equal((await lstat(path.dirname(artifact.path))).mode & 0o777, 0o700); }
    // Mutating/replacing/deleting model-owned files cannot change host-captured usage.
    const sandbox = path.join(h.root, "sandbox", "ticket", "sessions");
    await mkdir(sandbox, { recursive: true });
    const session = path.join(sandbox, "implement.jsonl");
    for (const operation of [async () => writeFile(session, SECRET), async () => { await rename(session, session + ".old"); await writeFile(session, piJsonStream("forged")); }, async () => rm(sandbox, { recursive: true })]) {
      await operation(); assert.deepEqual(await readRunTelemetry(h.state, h.stateDirectory), { status: "available", summary: s });
    }
    // No reader needs the raw event evidence or a model/runtime/repository.
    await rm(path.join(h.root, "telemetry-evidence"), { recursive: true });
    assert.deepEqual(await readRunTelemetry(h.state, h.stateDirectory), { status: "available", summary: s });
  } finally { await h.cleanup(); }
});

test("remediation sessions and staged escalation retain every actual attempt/profile", async () => {
  for (const options of [{ remediation: true }, { staged: true }]) {
    const h = await harness(options);
    try {
      assert.equal(h.state.status, "completed", h.state.lastError ?? "");
      const s = await summary(h);
      assert.equal(s.sessions.length, options.remediation ? 11 : 7);
      assert.equal(s.totals.tokens.input, s.sessions.length * 10);
      assert.equal(new Set(s.sessions.map(r => r.sessionId)).size, s.sessions.length);
      const implement = s.sessions.filter(r => r.phase === "implement");
      if (options.remediation) {
        assert.deepEqual(implement.map(r => r.attempt), [1, 2, 3]);
        assert.deepEqual(implement.map(r => r.remediation), [false, true, true]);
        assert.equal(s.sessions.filter(r => r.outcome === "remediation_required").length, 2);
        assert.ok(s.sessions.filter(r => r.phase === "plan").every(r => !r.remediation));
      } else {
        assert.deepEqual(implement.map(r => [r.attempt, r.profile.model, r.stageIndex, r.outcome]), [[1, "small", 0, "failed"], [2, "large", 1, "passed"]]);
      }
    } finally { await h.cleanup(); }
  }
});
for (const fault of ["malformed", "duplicate", "overflow", "unsupported", "capture", "publication"] as const) test(`telemetry ${fault} cannot relabel successful phase or completed run`, async () => {
  const h = await harness({ fault });
  try {
    assert.equal(h.state.status, "completed", h.state.lastError ?? "");
    assert.equal(h.state.results.implement?.status, "passed");
    const result = await readRunTelemetry(h.state, h.stateDirectory);
    if (fault === "publication") { assert.deepEqual(result, { status: "unavailable", completeness: "incomplete", diagnostic: "publication_failed" }); return; }
    const s = await summary(h);
    assert.equal(s.completeness, "incomplete"); assert.equal(s.totals.tokensComplete, false);
    assert.equal(s.sessions.find(r => r.phase === "implement")!.tokens, null);
    assert.ok(!JSON.stringify(s).includes(SECRET));
  } finally { await h.cleanup(); }
});
for (const fault of ["interrupted", "partial"] as const) test(`terminal ${fault} retains launched child with incomplete accounting`, async () => {
  const h = await harness({ fault });
  try {
    assert.equal(h.state.status, fault === "interrupted" ? "interrupted" : "failed");
    const s = await summary(h);
    assert.equal(s.sessions.length, 3);
    assert.equal(s.sessions[2]!.tokens, null);
    assert.equal(s.sessions[2]!.outcome, fault === "interrupted" ? "interrupted" : "invalid_report");
    assert.ok(s.sessions[2]!.durationMs !== null);
  } finally { await h.cleanup(); }
});

test("artifact identity/digest/schema/reconciliation tampering is rejected; no source state rewritten", async () => {
  const h = await harness();
  try {
    const s = await summary(h);
    assert.ok(h.state.telemetry?.status === "available");
    const disposition = h.state.telemetry;
    for (const ref of [{ ...disposition, terminalVersion: disposition.terminalVersion - 1 }, { ...disposition, artifact: { ...disposition.artifact, sha256: "f".repeat(64) } }, { ...disposition, artifact: { ...disposition.artifact, path: disposition.artifact.path + ".tmp" } }]) assert.equal((await readRunTelemetry({ ...h.state, telemetry: ref }, h.stateDirectory)).status, "unavailable");
    for (const change of [(v: any) => v.runId = "wrong-run-identity", (v: any) => v.totals.tokens.input++, (v: any) => v.sessions[0].prompt = SECRET, (v: any) => v.sessions[0].sessionFile = "/credential/auth.json", (v: any) => v.sessions[0].profile.model = "forged", (v: any) => v.terminalVersion++, (v: any) => v.sessions.push(v.sessions[0])]) {
      const changed = structuredClone(s); change(changed); assert.throws(() => validateRunTelemetry(changed, h.state));
    }
    const file = disposition.artifact.path;
    const raw = await readFile(file);
    if (process.platform !== "win32") {
      await chmod(file, 0o600); await writeFile(file, raw); await chmod(file, 0o400);
      assert.equal((await readRunTelemetry(h.state, h.stateDirectory)).status, "unavailable", "same bytes with changed identity are not historical evidence");
      await rm(file); await symlink(path.join(h.root, "missing"), file);
      assert.equal((await readRunTelemetry(h.state, h.stateDirectory)).status, "unavailable");
    }
    const { telemetry: _t, ...legacy } = h.state;
    assert.deepEqual(await readRunTelemetry(legacy, "/does-not-exist"), { status: "unavailable", completeness: "incomplete", diagnostic: "not_captured" });
    assert.equal((await readRunTelemetry({ ...h.state, status: "running" }, "/does-not-exist")).status, "unavailable");
  } finally { await h.cleanup(); }
});

test("durable launch boundaries, missing end, immutable idempotent publication and bounded orphan files", async () => {
  const root = await launchTestRoot("squire-ledger-");
  const ledger = new TelemetryLedger(path.join(root, "raw"));
  const input: PhaseInput = { runId: "aidev-299-duration1", phase: "implement", attempt: 1, expectedHead: BASE, originalTicketBaseSha: BASE, previousCumulative: [], profile: { provider: "openai-codex", model: "fixture", thinking: "medium" }, ticket: { id: "AIDEV-299", title: SECRET, description: SECRET }, repository: "example/repo", baseBranch: "main", branch: "fixture", sandbox: "fixture", previous: {}, feedback: [] };
  try {
    const row = await ledger.begin(input, randomUUID());
    const launchFiles = await readdir(path.join(root, "raw"));
    assert.equal(launchFiles.length, 1);
    const launch = JSON.parse(await readFile(path.join(root, "raw", launchFiles[0]!), "utf8"));
    assert.equal(launch.row.endedAt, null); assert.equal(launch.row.durationMs, null);
    const state = { schemaVersion: 1, version: 2, runId: input.runId, status: "failed", startedAt: row.startedAt, endedAt: row.startedAt, attempts: { plan: 0, implement: 1, review: 0, test: 0, retro: 0 }, profiles: Object.fromEntries(PERSONAL_PHASES.map(p => [p, input.profile])), results: {} } as PersonalRunState;
    const missing = buildRunTelemetry(state, ledger.rows());
    assert.equal(missing.totals.durationComplete, false);
    assert.equal(missing.sessions[0]!.durationMs, null);
    const raw = Buffer.from(piJsonStream(SECRET, input.profile));
    await ledger.finish(row, raw, "passed", new Date(Date.parse(row.startedAt) + 1234).toISOString());
    const ref = await ledger.publish(state, root);
    assert.deepEqual(await ledger.publish(state, root), ref);
    assert.equal((await readdir(path.join(root, "telemetry"))).length, 1);
    const bound = { ...state, telemetry: ref };
    const read = await readRunTelemetry(bound, root);
    assert.ok(read.status === "available"); assert.equal(read.summary.sessions[0]!.durationMs, 1234);
    assert.ok(!JSON.stringify(read).includes(SECRET));
    // Raw capture retains exact bytes independently of the sanitized summary.
    const closed = (await Promise.all((await readdir(path.join(root, "raw"))).map(async name => { try { return JSON.parse(await readFile(path.join(root, "raw", name), "utf8")); } catch { return null; } }))).find(v => v?.event === "closed");
    const rawPort = createReportEvidence(path.join(root, "raw"));
    try { assert.deepEqual(await verifyReportEvidence(rawPort, closed.chunks[0]), raw); } finally { await rawPort.release?.(); }
    const restarted = await readRunTelemetry(bound, root); assert.deepEqual(restarted, read);
    await writeFile(path.join(root, "telemetry", "orphan.tmp"), SECRET);
    assert.deepEqual(await readRunTelemetry(bound, root), read);
  } finally { await ledger.release(); await rm(root, { recursive: true, force: true }); }
});

test("single-run CLI parsing and read-only JSON/human reporting require no credentials/runtime/repository", async () => {
  assert.equal(parseArguments(["telemetry", "AIDEV-299"]), undefined);
  for (const args of [["telemetry", "../secret"], ["telemetry", "aidev-299-valid123", "--background"], ["telemetry", "aidev-299-valid123", "--json", "--json"], ["telemetry", "aidev-299-valid123", "other-run123"]]) assert.equal(parseArguments(args), undefined);
  assert.equal(parseArguments(["telemetry", "aidev-299-valid123", "--json"])?.command, "telemetry");
  const h = await harness();
  try {
    const config = path.join(h.root, "config.json");
    await writeFile(config, JSON.stringify({ repository: { slug: "example/repo", path: path.join(h.root, "missing-repo"), sourceRef: "HEAD", baseBranch: "main" }, dataDirectory: h.root, paths: { state: h.stateDirectory, bridges: path.join(h.root, "missing-bridges"), staging: path.join(h.root, "missing-staging") }, linear: { apiKeyEnv: "MISSING_SECRET" }, github: { tokenCommand: ["do-not-execute"] }, sandbox: { roleUser: "1000:1000", piExecutable: "does-not-exist", piAgentDirectory: "/missing" }, testCommands: ["do-not-run"] }));
    const args = [path.resolve("dist/src/personal/cli.js"), "telemetry", h.state.runId, "--config", config];
    const execute = promisify(execFile);
    const json = await execute(process.execPath, [...args, "--json"], { env: { ...process.env, PATH: "", MISSING_SECRET: "" } });
    assert.equal(JSON.parse(json.stdout).summary.sessions.length, 6);
    assert.ok(!json.stdout.includes(SECRET)); assert.ok(!json.stdout.includes("credential"));
    const human = await execute(process.execPath, args, { env: { ...process.env, PATH: "" } });
    assert.match(human.stdout, /requirements/); assert.match(human.stdout, /implementation-design/); assert.match(human.stdout, /accounting incomplete/); assert.match(human.stdout, /provider cost=unknown/);
  } finally { await h.cleanup(); }
});

test("threshold compaction leaves both supervised Plan children and ordinary phase outcomes passed", async () => {
  const h = await harness({ compaction: true });
  try {
    assert.equal(h.state.status, "completed", h.state.lastError ?? "");
    const s = await summary(h);
    assert.equal(s.sessions.length, 6);
    assert.ok(s.sessions.every(row => row.outcome === "passed" && row.tokens === null && row.diagnostics.includes("unsupported_compaction")));
    assert.ok(PERSONAL_PHASES.every(phase => h.state.results[phase]?.status === "passed"));
    assert.equal(s.totals.tokensComplete, false);
    assert.equal(s.completeness, "incomplete");
    assert.ok(!JSON.stringify(s).includes("PRIVATE"));
    assert.ok(!formatRunTelemetry({ status: "available", summary: s }).includes("PRIVATE"));
  } finally { await h.cleanup(); }
});
