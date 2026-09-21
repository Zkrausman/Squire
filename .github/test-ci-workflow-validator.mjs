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
const nestedRuntimeRoot = "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works";
const provisionCommands = [
  'sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /ticket /ticket/runtime /ticket/workspace',
  "install -m 600 .github/runtime/package.json /ticket/runtime/package.json",
  "install -m 600 .github/runtime/package-lock.json /ticket/runtime/package-lock.json",
  "npm ci --prefix /ticket/runtime --ignore-scripts --no-audit --no-fund",
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

  const metadataFiles = ["package.json", "package-lock.json", ".github/required-check-policy.json"];
  for (const file of metadataFiles) await writeFile(join(temporary, file), await readFile(join(root, file)));
  await writeFile(join(temporary, ".github/workflows/ci.yml"), workflow);
  const valid = await runValidator(temporary);
  assert.equal(valid.status, 0, `valid workflow fixture rejected: ${valid.stderr}`);

  const expectValidatorRejects = async (mutatedWorkflow, reason) => {
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
  await expectValidatorRejects(workflow.replace("      fail-fast: false\n", ""), "changing the Windows gate strategy contract");
  for (const version of ["20.17.0", "22.9.0", "25", "26", "lts/*"]) {
    await expectValidatorRejects(workflow.replace('          - "24"', `          - "${version}"`), `unsupported Windows Node ${version}`);
    await expectValidatorRejects(workflow.replace('          - "24"', `          - "24"\n          - "${version}"`), `extra Windows Node ${version}`);
    for (const index of [0, 1]) {
      let seen = 0;
      const changed = workflow.replaceAll('node-version: "24"', match => seen++ === index ? `node-version: "${version}"` : match);
      await expectValidatorRejects(changed, `unsupported application Node ${version} in job ${index}`);
    }
  }
  await expectValidatorRejects(workflow.replace("          - ubuntu-latest\n", ""), "missing Linux filesystem coverage");
  const windowsCommand = workflow.split("run: node --test --test-timeout=120000 ")[1].trim();
  for (const regression of windowsCommand.split(" ")) {
    await expectValidatorRejects(workflow.replace(regression, ""), `missing Windows regression ${regression}`);
  }
  await expectValidatorRejects(workflow.replace("--test-timeout=120000", "--test-timeout=360000"), "weakened Windows test bound");
  await expectValidatorRejects(workflow.replace(windowsCommand, `${windowsCommand} || true`), "status-masked Windows regression");
  await expectValidatorRejects(workflow.replace(" dist/test/personal-plan-supervisor.test.js", ""), "missing supervised Plan regression");
  await expectValidatorRejects(replaceStepRun(workflow, "Provision ticket runtime", ["echo runtime provisioning", "# npm ci --prefix /ticket/runtime --ignore-scripts --no-audit --no-fund"]), "comment-substituted provisioning");
  await expectValidatorRejects(replaceStepRun(workflow, "Provision ticket runtime", [...provisionCommands.slice(0, 3), "set +e", provisionCommands[3], "echo runtime install completed"]), "status-masked provisioning");
  await expectValidatorRejects(replaceStepRun(workflow, "Validate ticket runtime", ["echo lstatSync", "echo pi-tui/package.json", "echo 0.84.4"]), "substituted runtime validation");
  await expectValidatorRejects(replaceStepRun(workflow, "Validate ticket runtime", ["exit 0", "node .github/validate-ticket-runtime.mjs"]), "early-exit runtime validation");

  await writeFile(join(temporary, ".github/workflows/ci.yml"), workflow);
  for (const file of [...metadataFiles, ".github/runtime/package.json", ".github/runtime/package-lock.json"]) {
    const original = await readFile(join(root, file), "utf8");
    const mutations = [];
    const metadata = JSON.parse(original);
    if (file.endsWith("required-check-policy.json")) {
      mutations.push({ ...metadata, policyVersion: "unversioned-node20.17-node22.9-node24" });
      for (let i = 0; i < metadata.requiredChecks.length; i++) {
        mutations.push({ ...metadata, requiredChecks: metadata.requiredChecks.filter((_, index) => index !== i) });
      }
    } else {
      for (const range of ["^20.17.0 || >=22.9.0", ">=24", ">=22 <25"]) {
        const changed = JSON.parse(original);
        (file.includes("lock") ? changed.packages[""] : changed).engines.node = range;
        mutations.push(changed);
      }
    }
    for (const mutation of mutations) {
      await writeFile(join(temporary, file), JSON.stringify(mutation));
      const result = await runValidator(temporary);
      assert.notEqual(result.status, 0, `validator accepted stale/incomplete policy metadata in ${file}`);
    }
    await writeFile(join(temporary, file), original);
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
