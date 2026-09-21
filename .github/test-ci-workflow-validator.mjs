import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = process.cwd();
const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
const validator = await readFile(join(root, ".github/validate-ci-workflow.mjs"), "utf8");
const runtimeValidator = await readFile(join(root, ".github/validate-ticket-runtime.mjs"), "utf8");
const runtimeManifest = await readFile(join(root, ".github/runtime/package.json"), "utf8");
const runtimeLock = await readFile(join(root, ".github/runtime/package-lock.json"), "utf8");
const checkManifest = await readFile(join(root, ".github/required-checks.json"), "utf8");
const nestedRuntimeRoot = "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works";
const provisionCommands = [
  'sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /ticket /ticket/runtime /ticket/workspace',
  "install -m 600 .github/runtime/package.json /ticket/runtime/package.json",
  "install -m 600 .github/runtime/package-lock.json /ticket/runtime/package-lock.json",
  "npm ci --prefix /ticket/runtime --engine-strict --ignore-scripts --no-audit --no-fund",
];

function stepRange(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex(line => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `step not found: ${name}`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("      - name: ")) end += 1;
  return { start, end, lines };
}

function swapSteps(source, firstName, secondName) {
  const first = stepRange(source, firstName);
  const second = stepRange(source, secondName);
  assert.equal(first.end, second.start, "regression fixture assumes adjacent steps");
  const before = first.lines.slice(0, first.start);
  const firstBlock = first.lines.slice(first.start, first.end);
  const secondBlock = first.lines.slice(second.start, second.end);
  const after = first.lines.slice(second.end);
  return [...before, ...secondBlock, ...firstBlock, ...after].join("\n");
}

function replaceStepRun(source, stepName, replacementLines) {
  const range = stepRange(source, stepName);
  const runIndex = range.lines.findIndex((line, index) => index >= range.start && index < range.end && line === "        run: node .github/validate-ticket-runtime.mjs");
  const blockIndex = runIndex === -1 ? range.lines.findIndex((line, index) => index >= range.start && index < range.end && line === "        run: |") : runIndex;
  assert.notEqual(blockIndex, -1, `run block not found: ${stepName}`);
  return [
    ...range.lines.slice(0, blockIndex),
    "        run: |",
    ...replacementLines.map(line => `          ${line}`),
    "",
    ...range.lines.slice(range.end),
  ].join("\n");
}

function insertFalseCondition(source, stepName) {
  const marker = `      - name: ${stepName}\n`;
  assert.equal(source.includes(marker), true, `step not found: ${stepName}`);
  return source.replace(marker, `${marker}        if: false\n`);
}

function runNode(args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}

async function runValidator(directory) {
  return runNode([".github/validate-ci-workflow.mjs"], directory);
}

async function writeFixtureFile(runtimeRoot, relativePath, content) {
  const target = join(runtimeRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function createRuntimeFixture(runtimeRoot) {
  for (const packageName of ["pi-agent-core", "pi-ai", "pi-client", "pi-protocol", "pi-telemetry", "pi-tui"]) {
    await writeFixtureFile(runtimeRoot, `${nestedRuntimeRoot}/${packageName}/package.json`, JSON.stringify({ version: "0.84.4" }));
  }
  await writeFixtureFile(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent/package.json", JSON.stringify({ version: "0.84.4" }));
  await writeFixtureFile(runtimeRoot, "node_modules/@zosmaai/pi-llm-wiki/package.json", JSON.stringify({ version: "0.11.8" }));
  for (const requiredFile of [
    `${nestedRuntimeRoot}/pi-tui/dist/utils.js`,
    "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    "node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/index.ts",
    "node_modules/@zosmaai/pi-llm-wiki/dist/extensions/llm-wiki/lib/utils.js",
    "node_modules/@zosmaai/pi-llm-wiki/dist/extensions/llm-wiki/lib/recall.js",
  ]) await writeFixtureFile(runtimeRoot, requiredFile, "fixture");
}

const temporary = await mkdtemp(join(tmpdir(), "aidev242-ci-validator-"));
const runtimeFixture = await mkdtemp(join(tmpdir(), "aidev242-runtime-fixture-"));
let symlinkTarget;
try {
  await mkdir(join(temporary, ".github/workflows"), { recursive: true });
  await mkdir(join(temporary, ".github/runtime"), { recursive: true });
  await writeFile(join(temporary, ".github/validate-ci-workflow.mjs"), validator);
  await writeFile(join(temporary, ".github/validate-ticket-runtime.mjs"), runtimeValidator);
  await writeFile(join(temporary, ".github/runtime/package.json"), runtimeManifest);
  await writeFile(join(temporary, ".github/runtime/package-lock.json"), runtimeLock);

  for (const file of ["src/node-runtime-policy.mjs", "package.json", "package-lock.json", ".github/required-checks.json"]) {
    await writeFixtureFile(temporary, file, await readFile(join(root, file), "utf8"));
  }
  await writeFixtureFile(temporary, ".github/workflows/ci.yml", workflow);
  const positive = await runValidator(temporary);
  assert.equal(positive.status, 0, `unmodified fixture rejected: ${positive.stderr}`);

  const expectValidatorRejects = async (mutatedWorkflow, reason) => {
    assert.notEqual(mutatedWorkflow, workflow, `probe did not mutate workflow: ${reason}`);
    await writeFile(join(temporary, ".github/workflows/ci.yml"), mutatedWorkflow);
    const result = await runValidator(temporary);
    assert.notEqual(result.status, 0, `validator accepted ${reason}`);
  };

  for (const marker of [
    "    runs-on: ubuntu-latest\n    timeout-minutes: 15",
    "    runs-on: ${{ matrix.os }}\n    timeout-minutes: 15",
    "      - name: Run tests\n        timeout-minutes: 5",
    "      - name: Run filesystem event integration\n        timeout-minutes: 5",
    "    runs-on: windows-latest\n    timeout-minutes: 15",
    "      - name: Run Windows launch capture regression\n        timeout-minutes: 5",
  ]) {
    assert.equal(workflow.includes(marker), true, `timeout marker missing: ${marker}`);
    await expectValidatorRejects(workflow.replace(marker, marker.replace(/\n +timeout-minutes: \d+/, "")), `missing timeout: ${marker}`);
    await expectValidatorRejects(workflow.replace(marker, marker.replace(/timeout-minutes: \d+/, "timeout-minutes: 360")), `excessive timeout: ${marker}`);
  }

  for (const name of ["stream", "store", "controller"]) {
    const regression = ` dist/test/personal-telemetry-${name}.test.js`;
    assert.equal(workflow.includes(regression), true, `Windows telemetry ${name} regression missing`);
    await expectValidatorRejects(workflow.replace(regression, ""), `missing Windows telemetry ${name} coverage`);
  }

  const controllerRegression = " dist/test/personal-controller.test.js";
  assert.equal(workflow.includes(controllerRegression), true, "Windows controller regression missing");
  await expectValidatorRejects(workflow.replace(controllerRegression, ""), "missing Windows controller cleanup coverage");
  await expectValidatorRejects(swapSteps(workflow, "Provision ticket runtime", "Validate ticket runtime"), "runtime validation before provisioning");
  await expectValidatorRejects(workflow.replace("          - windows-latest", "          - macos-latest"), "filesystem integration without a Windows runner");
  await expectValidatorRejects(workflow.replace("node --test dist/test/personal-run-events.test.js", "node --test dist/test/personal-run-events.test.js || true"), "status-masked filesystem integration");
  await expectValidatorRejects(insertFalseCondition(workflow, "Run tests"), "an if: false test step");
  await expectValidatorRejects(insertFalseCondition(workflow, "Run Windows launch capture regression"), "disabled Windows launch regression");
  await expectValidatorRejects(workflow.replace(" dist/test/personal-owner-observation.test.js", ""), "missing native owner status regression");
  await expectValidatorRejects(workflow.replace("dist/test/personal-windows-launch.test.js ", ""), "missing native Windows security tests");
  await expectValidatorRejects(workflow.replace("dist/test/personal-windows-state-replace.test.js ", ""), "missing native Windows state replacement tests");
  await expectValidatorRejects(workflow.replace("dist/test/personal-launch-material.test.js ", ""), "missing actual captured-material CLI regression");
  await expectValidatorRejects(workflow.replace("      fail-fast: false\n", ""), "cancelling other Windows version evidence after one failure");
  for (const version of ["20", "22", "25", "26"]) {
    await expectValidatorRejects(workflow.replace('          - "24"', `          - "${version}"`), `unsupported Windows Node ${version}`);
    await expectValidatorRejects(workflow.replace('          - "24"', `          - "24"\n          - "${version}"`), `additional Windows Node ${version}`);
    await expectValidatorRejects(workflow.replaceAll('node-version: "24"', `node-version: "${version}"`), `unsupported setup Node ${version}`);
  }
  // Mutate each setup independently: rejection cannot rely on another job's
  // now-invalid runtime selection, and each job remains an unconditional gate.
  for (const jobId of ["clean-install-build-test", "filesystem-event-integration", "windows-launch-capture", "codeql"]) {
    const start = workflow.indexOf(`\n  ${jobId}:`);
    // A job header has exactly two spaces; nested keys are not boundaries.
    const remainder = workflow.slice(start + 1);
    const nextHeader = /\n  [a-z][a-z-]+:/u.exec(remainder);
    const end = nextHeader ? start + 1 + nextHeader.index : workflow.length;
    const jobSource = workflow.slice(start, end);
    const mutateJob = replacement => workflow.slice(0, start) + replacement + workflow.slice(end);
    const nodeSelection = jobId === "windows-launch-capture" ? "${{ matrix.node }}" : '"24"';
    for (const version of ["20", "22", "25"]) {
      await expectValidatorRejects(mutateJob(jobSource.replace(`node-version: ${nodeSelection}`, `node-version: "${version}"`)), `${jobId} alone uses Node ${version}`);
    }
    await expectValidatorRejects(mutateJob(jobSource.replace(`          node-version: ${nodeSelection}\n`, "")), `${jobId} missing Node selection`);
    await expectValidatorRejects(mutateJob(jobSource.replace(`  ${jobId}:\n`, `  ${jobId}:\n    if: false\n`)), `${jobId} conditional gate`);
    await expectValidatorRejects(mutateJob(jobSource.replace(`  ${jobId}:\n`, `  ${jobId}:\n    continue-on-error: true\n`)), `${jobId} masks status`);
  }
  await expectValidatorRejects(workflow.replaceAll('          node-version: "24"\n', ''), "missing Node setup");
  await expectValidatorRejects(workflow.replace('          - "24"\n', ''), "missing Windows Node matrix");
  await expectValidatorRejects(workflow.replace('          node-version: ${{ matrix.node }}', '          node-version: "22"'), "bypassed Windows matrix");
  await expectValidatorRejects(workflow.replace('          - ubuntu-latest', '          - macos-latest'), "missing Linux filesystem gate");
  await expectValidatorRejects(workflow.slice(0, workflow.indexOf("\n  codeql:")), "removed CodeQL gate");
  await expectValidatorRejects(workflow.replace("  codeql:\n", "  codeql:\n    if: false\n"), "conditional CodeQL gate");
  await expectValidatorRejects(insertFalseCondition(workflow, "Analyze CodeQL"), "conditional CodeQL analysis");
  await expectValidatorRejects(workflow.replace("    name: CodeQL\n", "    name: CodeQL\n    continue-on-error: true\n"), "masked CodeQL failure");
  await expectValidatorRejects(workflow.replace("    name: CodeQL\n    runs-on: ubuntu-latest\n    timeout-minutes: 15", "    name: CodeQL\n    runs-on: ubuntu-latest\n    timeout-minutes: 360"), "inflated CodeQL timeout");
  await expectValidatorRejects(workflow.replace("    name: CodeQL\n    runs-on: ubuntu-latest\n    timeout-minutes: 15", "    name: CodeQL\n    runs-on: ubuntu-latest"), "missing CodeQL timeout");
  await expectValidatorRejects(workflow.replace("    name: windows-launch-capture (${{ matrix.node }})", "    name: old-windows-gate"), "workflow/check manifest disagreement");
  await expectValidatorRejects(workflow.replace(" dist/test/personal-report-correction.test.js", ""), "missing report correction regression");
  await expectValidatorRejects(workflow.replace(" dist/test/personal-launch-retry.test.js", ""), "missing retry regression");
  await expectValidatorRejects(workflow.replace(" dist/test/personal-plan-supervisor.test.js", ""), "missing supervised Plan regression");
  await expectValidatorRejects(replaceStepRun(workflow, "Provision ticket runtime", ["echo runtime provisioning", "# npm ci --prefix /ticket/runtime --engine-strict --ignore-scripts --no-audit --no-fund"]), "comment-substituted provisioning");
  await expectValidatorRejects(replaceStepRun(workflow, "Provision ticket runtime", [...provisionCommands.slice(0, 3), "set +e", provisionCommands[3], "echo runtime install completed"]), "status-masked provisioning");
  await expectValidatorRejects(replaceStepRun(workflow, "Validate ticket runtime", ["echo lstatSync", "echo pi-tui/package.json", "echo 0.84.4"]), "substituted runtime validation");
  await expectValidatorRejects(replaceStepRun(workflow, "Validate ticket runtime", ["exit 0", "node .github/validate-ticket-runtime.mjs"]), "early-exit runtime validation");

  await writeFile(join(temporary, ".github/workflows/ci.yml"), workflow);
  for (const mutate of [
    manifest => { manifest.version = 0; },
    manifest => { manifest.policyId = "legacy-node20-node22"; },
    manifest => { manifest.nodeRange = ">=20"; },
    ...JSON.parse(checkManifest).requiredChecks.map(context => manifest => { manifest.requiredChecks = manifest.requiredChecks.filter(check => check !== context); }),
    manifest => { manifest.requiredChecks.push("windows-launch-capture (22)"); },
  ]) {
    const manifest = JSON.parse(checkManifest);
    mutate(manifest);
    await writeFixtureFile(temporary, ".github/required-checks.json", JSON.stringify(manifest));
    assert.notEqual((await runValidator(temporary)).status, 0, "validator accepted stale/incomplete required checks");
  }
  await writeFixtureFile(temporary, ".github/required-checks.json", checkManifest);
  for (const file of ["package.json", "package-lock.json", ".github/runtime/package.json", ".github/runtime/package-lock.json"]) {
    const original = await readFile(join(root, file), "utf8");
    const metadata = JSON.parse(original);
    (metadata.packages?.[""] ?? metadata).engines.node = ">=22";
    await writeFixtureFile(temporary, file, JSON.stringify(metadata));
    assert.notEqual((await runValidator(temporary)).status, 0, `validator accepted stale engines in ${file}`);
    await writeFixtureFile(temporary, file, original);
  }
  const incompleteLock = JSON.parse(runtimeLock);
  delete incompleteLock.packages[`${nestedRuntimeRoot}/pi-tui`].integrity;
  await writeFile(join(temporary, ".github/runtime/package-lock.json"), `${JSON.stringify(incompleteLock, null, 2)}\n`);
  const incompleteIntegrity = await runValidator(temporary);
  assert.notEqual(incompleteIntegrity.status, 0, "validator accepted a runtime lock without pi-tui integrity");

  await createRuntimeFixture(runtimeFixture);
  const validRuntime = await runNode([join(root, ".github/validate-ticket-runtime.mjs"), runtimeFixture]);
  assert.equal(validRuntime.status, 0, `valid runtime fixture rejected: ${validRuntime.stderr}`);
  const piTuiDirectory = join(runtimeFixture, nestedRuntimeRoot, "pi-tui");
  symlinkTarget = await mkdtemp(join(tmpdir(), "aidev242-runtime-symlink-target-"));
  await writeFixtureFile(symlinkTarget, "package.json", JSON.stringify({ version: "0.84.4" }));
  await writeFixtureFile(symlinkTarget, "dist/utils.js", "substituted");
  await rm(piTuiDirectory, { recursive: true, force: true });
  await symlink(symlinkTarget, piTuiDirectory, "dir");
  const symlinkedParent = await runNode([join(root, ".github/validate-ticket-runtime.mjs"), runtimeFixture]);
  assert.notEqual(symlinkedParent.status, 0, "runtime validation accepted a symlinked pi-tui parent directory");
} finally {
  await rm(temporary, { recursive: true, force: true });
  await rm(runtimeFixture, { recursive: true, force: true });
  if (symlinkTarget) await rm(symlinkTarget, { recursive: true, force: true });
}

console.log("CI validator/runtime negative probes: substitutions, shell bypasses, incomplete integrity, and symlinked parents rejected");
