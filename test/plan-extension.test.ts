import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildTrustedPlanExtensionSource, createPlanSubmissionTool, PLAN_TOOL_PARAMETERS } from "../src/plan/plan-extension.js";
import { PlanResultDiscovery } from "../src/plan/plan-result-discovery.js";
import { createPlanFixture, type PlanFixture } from "./support/plan-fixtures.js";

const execFile = promisify(execFileCallback);

async function runGeneratedExtension(fixture: PlanFixture, submission: Record<string, unknown>): Promise<Record<string, unknown>> {
  const extension = path.join(fixture.root, `plan-extension-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  const driver = path.join(fixture.root, "invoke-plan-extension.mjs");
  await writeFile(extension, buildTrustedPlanExtensionSource(), { mode: 0o600 });
  await writeFile(driver, `
    let tool;
    const module = await import(${JSON.stringify(new URL(`file://${extension}`).href)});
    module.default({ registerTool(value) { tool = value; } });
    if (!tool) throw new Error("Plan tool was not registered");
    const input = JSON.parse(Buffer.from(process.env.PLAN_SUBMISSION_B64, "base64").toString("utf8"));
    const result = await tool.execute("test-call", input);
    process.stdout.write(JSON.stringify(result));
  `, { mode: 0o600 });
  const env = {
    ...process.env,
    SQUIRE_TICKET_ROOT: fixture.ticketRoot,
    SQUIRE_PLAN_INPUT_PATH: fixture.phaseInput.path,
    SQUIRE_PLAN_INPUT_SHA256: fixture.phaseInput.sha256,
    SQUIRE_PLAN_RUN_ID: "run_planfixture01",
    SQUIRE_PLAN_HANDOFF_ID: "handoff_plan_1",
    SQUIRE_PLAN_ATTEMPT: "1",
    SQUIRE_PLAN_SESSION_ID: "plan-session-1",
    SQUIRE_PLAN_INPUT_HEAD: "a".repeat(40),
    SQUIRE_PLAN_TICKET_IDENTIFIER: "AIDEV-218",
    SQUIRE_PLAN_COMPLETED_AT: "2026-09-01T12:13:00.000Z",
    SQUIRE_PLAN_ALLOWED_VALIDATION_COMMAND_IDS: JSON.stringify(["contracts", "tests"]),
    SQUIRE_PLAN_REQUIRED_VALIDATION_COMMAND_IDS: JSON.stringify(["contracts", "tests"]),
    PLAN_SUBMISSION_B64: Buffer.from(JSON.stringify(submission), "utf8").toString("base64"),
  };
  const { stdout } = await execFile(process.execPath, [driver], { cwd: fixture.workspace, env });
  return JSON.parse(stdout) as Record<string, unknown>;
}

function submission(): Record<string, unknown> {
  return {
    disposition: "pass",
    schemaVersion: 1,
    runId: "run_planfixture01",
    ticketIdentifier: "AIDEV-218",
    inputHead: "a".repeat(40),
    summary: "Implement the generic Plan protocol.",
    assumptions: ["The controller owns the workspace identity."],
    steps: [{ id: "step-1", description: "Add the Plan protocol.", affectedPaths: ["src/plan/plan-session.ts"], acceptanceCriteria: ["The Plan validation suite passes."] }],
    risks: [{ risk: "A stale head could invalidate the result.", mitigation: "Recheck readiness before acceptance." }],
    validationCommandIds: ["contracts", "tests"],
  };
}

test("Plan submission boundary exposes no mutating tools and permits one bounded publication", async () => {
  const fixture = await createPlanFixture();
  try {
    const context = { ...fixture.publicationContext, allowedValidationCommandIds: ["contracts", "tests"], requiredValidationCommandIds: ["contracts", "tests"] };
    let publications = 0;
    const publisher = { publish: async (value: unknown, received: typeof context) => { publications += 1; assert.equal(received.ticketRoot, fixture.ticketRoot); return value; } };
    const invalidTool = createPlanSubmissionTool(context, publisher);
    assert.equal(invalidTool.name, "squire_submit_plan");
    assert.equal(JSON.stringify(PLAN_TOOL_PARAMETERS).match(/bash|edit|write|capture|observe|retro/iu), null);
    await assert.rejects(invalidTool.execute("invalid", { ...submission(), injected: "write source" }), /unknown field/iu);
    assert.equal(publications, 0);
    const tool = createPlanSubmissionTool(context, publisher);
    const accepted = await tool.execute("valid", submission());
    assert.equal((accepted as Record<string, unknown>)["terminate"], true);
    assert.equal(publications, 1);
    await assert.rejects(tool.execute("second", submission()), /only once/iu);
    assert.equal(publications, 1);
  } finally { await import("node:fs/promises").then(fs => fs.rm(fixture.root, { recursive: true, force: true })); }
});

test("generated Plan extension is dependency-free, registers one terminating tool, and publishes exact outputs", async () => {
  const fixture = await createPlanFixture();
  try {
    const source = buildTrustedPlanExtensionSource();
    assert.doesNotMatch(source, /@earendil-works|typebox|@zosmaai/iu);
    assert.equal(PLAN_TOOL_PARAMETERS.additionalProperties, false);
    const result = await runGeneratedExtension(fixture, submission());
    assert.equal(((result["content"] as Array<Record<string, unknown>>)[0]!["text"]), "Plan published; the session is complete.");
    assert.equal((result as { terminate?: boolean }).terminate, true);
    const planStat = await lstat(path.join(fixture.ticketRoot, "artifacts/plan/1/plan.json"));
    const resultStat = await lstat(path.join(fixture.ticketRoot, "artifacts/plan/1/result.json"));
    assert.equal(planStat.nlink, 1);
    assert.equal(resultStat.nlink, 1);
    assert.equal(planStat.mode & 0o777, 0o600);
    assert.equal(resultStat.mode & 0o777, 0o600);
    const discovered = await new PlanResultDiscovery(fixture.ticketRoot).discover(1);
    assert.ok(discovered);
    const second = await runGeneratedExtension(fixture, submission());
    assert.deepEqual((second["details"] as Record<string, unknown>)["result"], (result["details"] as Record<string, unknown>)["result"]);
    const changed = submission();
    changed["summary"] = "A different immutable plan.";
    await assert.rejects(runGeneratedExtension(fixture, changed), /immutable Plan output conflict/iu);
    assert.equal((await new PlanResultDiscovery(fixture.ticketRoot).discover(1))!.sha256, discovered!.sha256);
  } finally {
    await import("node:fs/promises").then(fs => fs.rm(fixture.root, { recursive: true, force: true }));
  }
});

test("generated Plan extension blocks unresolved context without writing a guessed result", async () => {
  const fixture = await createPlanFixture();
  try {
    const blocked = submission();
    blocked["disposition"] = "blocked";
    blocked["summary"] = "Blocked: implementation must not start until the base identity is repaired.";
    blocked["assumptions"] = ["The base reference is unknown."];
    blocked["questions"] = ["Which exact base SHA should the controller bind?"];
    const output = await runGeneratedExtension(fixture, blocked);
    assert.equal(((output["content"] as Array<Record<string, unknown>>)[0]!["text"]), "Plan blocked; implementation must not start.");
    const result = JSON.parse(await readFile(path.join(fixture.ticketRoot, "artifacts/plan/1/result.json"), "utf8")) as Record<string, unknown>;
    assert.equal(result["status"], "failed");
    assert.deepEqual((result["failures"] as Array<Record<string, unknown>>)[0]!["id"], "PLAN_CONTEXT_BLOCKED");
    assert.match(await readFile(path.join(fixture.ticketRoot, "evidence/plan/1/verification.md"), "utf8"), /Which exact base SHA/u);
  } finally {
    await import("node:fs/promises").then(fs => fs.rm(fixture.root, { recursive: true, force: true }));
  }
});
