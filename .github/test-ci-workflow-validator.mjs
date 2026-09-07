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

  const expectValidatorRejects = async (mutatedWorkflow, reason) => {
    await writeFile(join(temporary, ".github/workflows/ci.yml"), mutatedWorkflow);
    const result = await runValidator(temporary);
    assert.notEqual(result.status, 0, `validator accepted ${reason}`);
  };

  await expectValidatorRejects(swapSteps(workflow, "Provision ticket runtime", "Validate ticket runtime"), "runtime validation before provisioning");
  await expectValidatorRejects(insertFalseCondition(workflow, "Run tests"), "an if: false test step");
  await expectValidatorRejects(replaceStepRun(workflow, "Provision ticket runtime", ["echo runtime provisioning", "# npm ci --prefix /ticket/runtime --ignore-scripts --no-audit --no-fund"]), "comment-substituted provisioning");
  await expectValidatorRejects(replaceStepRun(workflow, "Provision ticket runtime", [...provisionCommands.slice(0, 3), "set +e", provisionCommands[3], "echo runtime install completed"]), "status-masked provisioning");
  await expectValidatorRejects(replaceStepRun(workflow, "Validate ticket runtime", ["echo lstatSync", "echo pi-tui/package.json", "echo 0.84.4"]), "substituted runtime validation");
  await expectValidatorRejects(replaceStepRun(workflow, "Validate ticket runtime", ["exit 0", "node .github/validate-ticket-runtime.mjs"]), "early-exit runtime validation");

  await writeFile(join(temporary, ".github/workflows/ci.yml"), workflow);
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
