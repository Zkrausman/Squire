import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
const validator = await readFile(join(root, ".github/validate-ci-workflow.mjs"), "utf8");
const runtimeManifest = await readFile(join(root, ".github/runtime/package.json"), "utf8");
const runtimeLock = await readFile(join(root, ".github/runtime/package-lock.json"), "utf8");

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

function insertFalseCondition(source, stepName) {
  const marker = `      - name: ${stepName}\n`;
  assert.equal(source.includes(marker), true, `step not found: ${stepName}`);
  return source.replace(marker, `${marker}        if: false\n`);
}

async function runValidator(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [".github/validate-ci-workflow.mjs"], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}

const temporary = await mkdtemp(join(tmpdir(), "aidev242-ci-validator-"));
try {
  await mkdir(join(temporary, ".github/workflows"), { recursive: true });
  await mkdir(join(temporary, ".github/runtime"), { recursive: true });
  await writeFile(join(temporary, ".github/validate-ci-workflow.mjs"), validator);
  await writeFile(join(temporary, ".github/runtime/package.json"), runtimeManifest);
  await writeFile(join(temporary, ".github/runtime/package-lock.json"), runtimeLock);

  await writeFile(join(temporary, ".github/workflows/ci.yml"), swapSteps(workflow, "Provision ticket runtime", "Validate ticket runtime"));
  const reordered = await runValidator(temporary);
  assert.notEqual(reordered.status, 0, "validator accepted runtime validation before provisioning");

  await writeFile(join(temporary, ".github/workflows/ci.yml"), insertFalseCondition(workflow, "Run tests"));
  const suppressed = await runValidator(temporary);
  assert.notEqual(suppressed.status, 0, "validator accepted an if: false test step");

  await writeFile(join(temporary, ".github/workflows/ci.yml"), workflow);
  const incompleteLock = JSON.parse(runtimeLock);
  delete incompleteLock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui"].integrity;
  await writeFile(join(temporary, ".github/runtime/package-lock.json"), `${JSON.stringify(incompleteLock, null, 2)}\n`);
  const incompleteIntegrity = await runValidator(temporary);
  assert.notEqual(incompleteIntegrity.status, 0, "validator accepted a runtime lock without pi-tui integrity");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log("CI validator negative probes: reordered provisioning, suppressed tests, and incomplete runtime integrity rejected");
