import type { PersonalMvpConfig } from "../src/personal/config.js";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { supervisePlan } from "../src/personal/plan-supervisor.js";
import { captureLaunchMaterial } from "../src/personal/launch-material.js";
import type { CommandPort } from "../src/personal/command.js";
import type { PhaseInput } from "../src/personal/types.js";
import { TEST_MATERIAL, TEST_CONFIG_DIGEST } from "./helpers/personal-launch.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { piJson, piEvents, jsonLines } from "./helpers/pi-json.js";
const base = "a".repeat(40), head = "b".repeat(40);

for (const fault of ["normal", "remediation", "staged", "malformed-usage", "duplicate-usage", "publication", "capture-storage"] as const) test(`production controller ${fault} keeps gates independent and terminalizes six-session telemetry`, async () => {
  const root = await launchTestRoot("squire-telemetry-controller-");
  let current = base, document: PhaseInput;
  const copies = new Map<string, any>();
  const configValue: PersonalMvpConfig = { ...TEST_MATERIAL.config, ...(fault === "staged" ? { escalationPolicy: { implement: { stages: [{ provider: "openai-codex", model: "first-stage", thinking: "low" as const, maxAttempts: 1 }, { provider: "openai-codex", model: "second-stage", thinking: "high" as const, maxAttempts: 1 }] } } } : {}), promptPolicy: { version: 1, id: "default", plan: ["requirements", "implementation-design"] } };
  const raw = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(TEST_MATERIAL.rawConfig, "base64").toString()), ...(fault === "staged" ? { escalationPolicy: configValue.escalationPolicy } : {}) }));
  const material = await captureLaunchMaterial({ config: configValue, rawConfig: raw.toString("base64"), digest: createHash("sha256").update(raw).digest("hex") });
  const commands: CommandPort = { byteOutput: true, async run(spec) {
    const args = spec.args;
    if (args[0] === "cp") { const value = JSON.parse(await readFile(args[1]!, "utf8")); copies.set(args[2]!.split(":").slice(1).join(":"), value); if (value.phase) document = value; }
    if (args.at(-1)?.includes("rev-parse HEAD")) return { stdout: current, stderr: "" };
    if (args.includes("node")) {
      const config = copies.get(args.at(-1)!); const child = copies.get(config.args.at(-1).match(/from (.+)\. Treat/)[1]);
      const result = child.subphase === "requirements" ? { version: 1, inputHead: base, problem: "deliver", acceptanceCriteria: ["verified"], nonGoals: [], assumptions: [], dependencies: [], openQuestions: [], readiness: "ready" } : { version: 1, inputHead: base, requirementsDigest: child.requirements.digest, steps: ["implement"], affectedComponents: ["src"], tests: ["npm test"], risks: [], exactHeadEvidence: { head: base, observations: ["inspected"] }, projectWiki: { status: "not_required", reason: "fixture" } };
      const bytes = piJson(JSON.stringify(result), child.sessionId, child.profile); return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
    }
    if (!args.includes("--print")) return { stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "" };
    if (document.phase === "implement") current = head;
    const remediation = fault === "remediation" && document.phase === "review" && document.attempt === 1;
    const report = { outputHead: current, status: remediation ? "remediation_required" : fault === "staged" && document.phase === "implement" && document.attempt === 1 ? "failed" : "passed", summary: "validated", details: document.phase === "implement" ? { changes: ["fixture"], projectWiki: { status: "not_required", reason: "fixture adds no knowledge" } } : document.phase === "review" ? { findings: remediation ? ["fix"] : [] } : document.phase === "test" ? { commands: [{ command: "test", exitCode: 0, summary: "passed" }] } : { lessons: ["fixture"], followUps: [] } };
    const id = (document as PhaseInput & { sessionId: string }).sessionId;
    const events = piEvents(JSON.stringify(report), id, document.profile);
    if (fault === "malformed-usage") events[6].message.usage.input = -1;
    if (fault === "duplicate-usage") events.splice(7, 0, events[6]);
    const bytes = jsonLines(events); return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
  } };
  const runner = new SandboxPiPhaseRunner({ commands, stagingRoot: root, testCommands: [] });
  if (fault === "capture-storage") runner.telemetry.begin = async () => { throw new Error("fixture capture unavailable"); };
  const states = new JsonRunStateStore(path.join(root, "state"));
  const controller = new PersonalMvpController({ launchMaterial: material, newId: () => "telemetryfixture", states,
    tickets: { async get(id) { return { id, title: "PRIVATE TICKET", description: "PRIVATE DESCRIPTION SECRET" }; } },
    phases: {
      reportEvidence: runner.reportEvidence, reportCapture: r => runner.reportCapture(r),
      telemetrySettled: r => runner.telemetrySettled(r), telemetryTerminal: s => runner.telemetryTerminal(s),
      async run(i, signal, progress) { return i.phase === "plan" ? supervisePlan(i, { stagingRoot: root, launchMaterial: material, testCommands: [] }, commands, signal!, progress!) : runner.run(i, signal); },
    },
    workspaces: { async prepare() { return { sandbox: "fixture", baseSha: base, head: base }; }, async currentHead() { return current; }, async assertClean() {}, async committedProjectWikiPaths() { return []; }, async exportBundle(i) { return { ...i, path: "/fixture", byteLength: 1, sha256: "c".repeat(64) }; } },
    publication: { async publish() { if (fault === "publication") throw new Error("publication unavailable"); return { url: "https://example.com/pr", reused: false }; } },
  });
  try {
    const run = controller.run({ ticketId: "AIDEV-299", repository: "example/repo", repositoryPath: "/fixture", sourceRef: "HEAD", baseBranch: "main" });
    if (fault === "publication") await assert.rejects(run, /publication unavailable/); else await run;
    const state = (await states.read("aidev-299-telemetryf"))!;
    assert.equal(state.results.test?.status, "passed"); assert.equal(state.results.review?.status, "passed");
    const artifact = (await runner.telemetry.read(state.runId))!; assert.ok(artifact);
    assert.equal(artifact.phaseOutcomes.plan, "passed");
    assert.equal(artifact.phaseOutcomes.test, "passed");
    assert.equal(artifact.outcome, fault === "publication" ? "failed" : "completed");
    assert.equal(artifact.sessions.length, fault === "remediation" ? 8 : fault === "staged" ? 7 : fault === "capture-storage" ? 2 : 6);
    assert.equal(artifact.complete, !["malformed-usage", "duplicate-usage", "capture-storage"].includes(fault));
    assert.equal(artifact.phases[0]!.subphases[0]!.totals.tokens.input.known, 10);
    assert.equal(artifact.phases[0]!.subphases[1]!.totals.tokens.input.known, 10);
    if (fault === "remediation") { assert.equal(artifact.sessions.filter(s => s.trigger === "remediation").length, 2); assert.equal(artifact.sessions.find(s => s.phase === "review" && s.attempt === 1)!.outcome, "remediation_required"); }
    if (fault === "staged") {
      const rows = artifact.sessions.filter(s => s.phase === "implement").sort((a, b) => a.attempt - b.attempt);
      assert.deepEqual(rows.map(s => [s.profile.model, s.stageIndex, s.stageAttempt, s.trigger, s.outcome]), [["first-stage", 0, 1, "initial", "failed"], ["second-stage", 1, 1, "stage_advanced", "passed"]]);
    }
    assert.doesNotMatch(JSON.stringify(artifact), /PRIVATE|SECRET|fixture adds|DESCRIPTION/);
    // CLI uses only config + terminal artifact, no repository or external command.
    const config = path.join(root, "config.json");
    await writeFile(config, JSON.stringify({ ...JSON.parse(Buffer.from(TEST_MATERIAL.rawConfig, "base64").toString()), dataDirectory: root, paths: { state: path.join(root, "state"), staging: root, bridges: path.join(root, "bridges") } }));
    const result = await promisify(execFile)(process.execPath, ["dist/src/personal/cli.js", "telemetry", state.runId, "--json", "--config", config]);
    assert.deepEqual(JSON.parse(result.stdout), artifact);
  } finally { await runner.reportEvidence.release?.(); await rm(root, { recursive: true, force: true }); }
});
