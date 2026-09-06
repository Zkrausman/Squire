import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { link, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildTrustedPlanExtensionSource, createPlanSubmissionTool, PLAN_TOOL_PARAMETERS } from "../src/plan/plan-extension.js";
import { PLAN_FILESYSTEM_POLICY_SHA256 } from "../src/plan/domain.js";
import { PlanResultDiscovery } from "../src/plan/plan-result-discovery.js";
import { createPlanFixture, type PlanFixture } from "./support/plan-fixtures.js";

const execFile = promisify(execFileCallback);

async function runGeneratedTool(fixture: PlanFixture, toolName: string, input: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const extension = path.join(fixture.root, `plan-extension-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  const driver = path.join(fixture.root, "invoke-plan-extension.mjs");
  await writeFile(extension, buildTrustedPlanExtensionSource(), { mode: 0o600 });
  await writeFile(driver, `
    const tools = new Map();
    const module = await import(${JSON.stringify(new URL(`file://${extension}`).href)});
    module.default({ registerTool(value) { tools.set(value.name, value); } });
    const tool = tools.get(process.env.PLAN_TOOL_NAME);
    if (!tool) throw new Error("requested Plan tool was not registered: " + process.env.PLAN_TOOL_NAME);
    const input = JSON.parse(Buffer.from(process.env.PLAN_TOOL_INPUT_B64, "base64").toString("utf8"));
    try {
      const result = await tool.execute("test-call", input);
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.message || error) }));
    }
  `, { mode: 0o600 });
  const env = {
    ...process.env,
    ...extraEnv,
    SQUIRE_TICKET_ROOT: fixture.ticketRoot,
    SQUIRE_PLAN_FILESYSTEM_POLICY_SHA256: PLAN_FILESYSTEM_POLICY_SHA256,
    SQUIRE_PLAN_WORKSPACE_ROOT: fixture.workspace,
    SQUIRE_PLAN_WIKI_ROOT: path.join(fixture.workspace, ".llm-wiki"),
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
    PLAN_TOOL_NAME: toolName,
    PLAN_TOOL_INPUT_B64: Buffer.from(JSON.stringify(input), "utf8").toString("base64"),
  };
  const { stdout } = await execFile(process.execPath, [driver], { cwd: fixture.workspace, env });
  const envelope = JSON.parse(stdout) as { ok: boolean; result?: Record<string, unknown>; error?: string };
  if (!envelope.ok) throw new Error(envelope.error ?? "generated Plan tool failed");
  return envelope.result!;
}

async function assertGeneratedToolRejects(fixture: PlanFixture, toolName: string, input: Record<string, unknown>, expected: RegExp): Promise<void> {
  await assert.rejects(runGeneratedTool(fixture, toolName, input), expected);
}

async function runGeneratedExtension(fixture: PlanFixture, submission: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runGeneratedTool(fixture, "squire_submit_plan", submission);
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

test("generated Plan extension is dependency-free, registers trusted read tools plus one terminating publisher, and publishes exact outputs", async () => {
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

test("Plan filesystem tools enforce the project-only descriptor-bound read boundary against forbidden paths and races", async () => {
  const fixture = await createPlanFixture();
  try {
    await mkdir(path.join(fixture.workspace, "src"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(fixture.workspace, ".llm-wiki", "wiki"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(fixture.workspace, "src", "main.ts"), "export const planSentinel = true;\n", { mode: 0o600 });
    await writeFile(path.join(fixture.workspace, "src", "other.ts"), "export const other = planSentinel;\n", { mode: 0o600 });
    await writeFile(path.join(fixture.workspace, ".llm-wiki", "wiki", "plan.md"), "# Project-only Plan context\n", { mode: 0o600 });
    const outside = path.join(fixture.root, "host-private-sentinel.txt");
    await writeFile(outside, "HOST_PRIVATE_SENTINEL\n", { mode: 0o600 });
    await writeFile(path.join(fixture.workspace, "auth.json"), "HOST_AUTH_SENTINEL\n", { mode: 0o600 });
    await writeFile(path.join(fixture.workspace, ".env"), "HOST_ENV_SENTINEL\n", { mode: 0o600 });
    await mkdir(path.join(fixture.workspace, "artifacts"), { mode: 0o700 });
    await mkdir(path.join(fixture.workspace, "runtime"), { mode: 0o700 });
    await mkdir(path.join(fixture.workspace, "sessions"), { mode: 0o700 });
    await mkdir(path.join(fixture.workspace, "unsafe"), { mode: 0o700 });
    const runtimeState = path.join(fixture.root, "runtime-state");
    const sessionState = path.join(fixture.root, "session-state");
    await mkdir(runtimeState, { mode: 0o700 });
    await mkdir(sessionState, { mode: 0o700 });
    const runtimeSentinel = path.join(runtimeState, "auth.json");
    const sessionSentinel = path.join(sessionState, "other-session.jsonl");
    const authSentinel = path.join(fixture.root, "auth.json");
    await writeFile(runtimeSentinel, "RUNTIME_AUTH_SENTINEL\n", { mode: 0o600 });
    await writeFile(sessionSentinel, "SESSION_SENTINEL\n", { mode: 0o600 });
    await writeFile(authSentinel, "AUTH_SENTINEL\n", { mode: 0o600 });
    const sourceBefore = await readFile(path.join(fixture.workspace, "src", "main.ts"));
    const wikiBefore = await readFile(path.join(fixture.workspace, ".llm-wiki", "wiki", "plan.md"));
    const runtimeBefore = await readFile(runtimeSentinel);
    const sessionBefore = await readFile(sessionSentinel);
    const authBefore = await readFile(authSentinel);
    const symlinkPath = path.join(fixture.workspace, "unsafe", "escape-link.txt");
    const hardlinkPath = path.join(fixture.workspace, "unsafe", "hardlink.txt");
    await symlink(outside, symlinkPath);
    await link(outside, hardlinkPath);

    const read = await runGeneratedTool(fixture, "squire_plan_read", { path: "src/main.ts" });
    assert.match(String((read["content"] as Array<Record<string, unknown>>)[0]!['text']), /planSentinel/u);
    assert.equal((read["details"] as Record<string, unknown>)["scope"], "repository");
    const wikiRead = await runGeneratedTool(fixture, "squire_plan_read", { path: ".llm-wiki/wiki/plan.md" });
    assert.equal((wikiRead["details"] as Record<string, unknown>)["scope"], "project-wiki");
    const grep = await runGeneratedTool(fixture, "squire_plan_grep", { path: "src", pattern: "planSentinel" });
    assert.match(String((grep["content"] as Array<Record<string, unknown>>)[0]!['text']), /main\.ts:1/u);
    const find = await runGeneratedTool(fixture, "squire_plan_find", { path: "src", pattern: "**/*.ts" });
    assert.match(String((find["content"] as Array<Record<string, unknown>>)[0]!['text']), /src\/main\.ts/u);
    const list = await runGeneratedTool(fixture, "squire_plan_ls", { path: "src" });
    assert.match(String((list["content"] as Array<Record<string, unknown>>)[0]!['text']), /main\.ts/u);
    const rootList = await runGeneratedTool(fixture, "squire_plan_ls", { path: "." });
    const rootListText = String((rootList["content"] as Array<Record<string, unknown>>)[0]!['text']);
    assert.doesNotMatch(rootListText, /(?:auth\.json|\.env|artifacts|runtime|sessions)/u);

    const forbiddenPaths = [
      "/ticket/artifacts/implement/3/result.json",
      "../host-private-sentinel.txt",
      "/ticket/sessions/plan/session.jsonl",
      "/ticket/runtime/auth.json",
      "/ticket/runtime/package.json",
      "/ticket/artifacts/input/phase-input.json",
      "/proc/self/environ",
      runtimeSentinel,
      sessionSentinel,
      authSentinel,
      path.join(fixture.ticketRoot, "artifacts", "input", "phase-input.json"),
      "artifacts/input/phase-input.json",
      "auth.json",
      ".env",
      "runtime/package.json",
      "sessions/plan/session.jsonl",
      "unsafe/escape-link.txt",
      "unsafe/hardlink.txt",
    ];
    const tools: readonly [string, (target: string) => Record<string, unknown>][] = [
      ["squire_plan_read", target => ({ path: target })],
      ["squire_plan_grep", target => ({ path: target, pattern: "HOST_PRIVATE_SENTINEL" })],
      ["squire_plan_find", target => ({ path: target })],
      ["squire_plan_ls", target => ({ path: target })],
    ];
    for (const [toolName, makeInput] of tools) {
      for (const target of forbiddenPaths) await assert.rejects(runGeneratedTool(fixture, toolName, makeInput(target)), /repository-relative|outside|symbolic|single-link|regular|directory|allowlist|changed|filesystem/u, `${toolName} must reject ${target}`);
    }

    const racePath = path.join(fixture.workspace, "race.txt");
    const raceBytes = Buffer.alloc(4 * 1024 * 1024, "r");
    await writeFile(racePath, raceBytes, { mode: 0o600 });
    let mutation = 0;
    const pendingMutations: Promise<void>[] = [];
    const raceTimer = setInterval(() => {
      const write = writeFile(racePath, Buffer.alloc(raceBytes.length, mutation++ % 2 === 0 ? "a" : "b"), { mode: 0o600 });
      pendingMutations.push(write);
      void write;
    }, 1);
    try {
      for (const [toolName, makeInput] of tools) {
        await assert.rejects(runGeneratedTool(fixture, toolName, makeInput("race.txt"), { NODE_ENV: "test", SQUIRE_PLAN_TEST_ONLY_READ_DELAY_MS: "100" }), /changed|stable|single-link|identity|directory/u, `${toolName} must reject its race target`);
      }
    } finally {
      clearInterval(raceTimer);
      await Promise.allSettled(pendingMutations);
    }
    assert.deepEqual(await readFile(path.join(fixture.workspace, "src", "main.ts")), sourceBefore);
    assert.deepEqual(await readFile(path.join(fixture.workspace, ".llm-wiki", "wiki", "plan.md")), wikiBefore);
    assert.deepEqual(await readFile(runtimeSentinel), runtimeBefore);
    assert.deepEqual(await readFile(sessionSentinel), sessionBefore);
    assert.deepEqual(await readFile(authSentinel), authBefore);
    assert.equal((await readFile(outside, "utf8")), "HOST_PRIVATE_SENTINEL\n");
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
