import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const runtimeRoot = process.argv[2] ?? "/ticket/runtime";
const nestedPackageRoot = "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works";
const nestedPackages = ["pi-agent-core", "pi-ai", "pi-client", "pi-protocol", "pi-telemetry", "pi-tui"];

function assertAbsoluteNormalizedRoot(root) {
  assert.equal(path.posix.isAbsolute(root), true, `runtime root must be absolute: ${root}`);
  assert.equal(path.posix.normalize(root), root, `runtime root must be normalized: ${root}`);
}

function assertContainedPath(relativePath) {
  assert.equal(path.posix.isAbsolute(relativePath), false, `runtime path must be relative: ${relativePath}`);
  assert.equal(relativePath.length > 0, true, "runtime path must not be empty");
  const candidate = path.posix.join(runtimeRoot, relativePath);
  const observedRelative = path.posix.relative(runtimeRoot, candidate);
  assert.equal(observedRelative, relativePath, `runtime path escaped its expected root: ${relativePath}`);
  const components = candidate.split(path.posix.sep).filter(Boolean);
  let current = path.posix.parse(candidate).root;
  for (const [index, component] of components.entries()) {
    current = path.posix.join(current, component);
    const stat = fs.lstatSync(current);
    assert.equal(stat.isSymbolicLink(), false, `runtime ancestor is symlinked: ${current}`);
    if (index < components.length - 1) assert.equal(stat.isDirectory(), true, `runtime ancestor is not a directory: ${current}`);
    else assert.equal(stat.isFile(), true, `runtime leaf is not a regular file: ${current}`);
  }
  return candidate;
}

function assertPackageVersion(relativePackageJson, expectedVersion) {
  const packageJson = assertContainedPath(relativePackageJson);
  assert.equal(JSON.parse(fs.readFileSync(packageJson, "utf8")).version, expectedVersion, `${relativePackageJson} version mismatch`);
}

assertAbsoluteNormalizedRoot(runtimeRoot);
const runtimeRootStat = fs.lstatSync(runtimeRoot);
assert.equal(runtimeRootStat.isSymbolicLink(), false, `runtime root is symlinked: ${runtimeRoot}`);
assert.equal(runtimeRootStat.isDirectory(), true, `runtime root is not a directory: ${runtimeRoot}`);

for (const packageName of nestedPackages) assertPackageVersion(`${nestedPackageRoot}/${packageName}/package.json`, "0.84.4");
assertPackageVersion("node_modules/@earendil-works/pi-coding-agent/package.json", "0.84.4");
assertPackageVersion("node_modules/@zosmaai/pi-llm-wiki/package.json", "0.11.8");

for (const requiredFile of [
  `${nestedPackageRoot}/pi-tui/dist/utils.js`,
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  "node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/index.ts",
  "node_modules/@zosmaai/pi-llm-wiki/dist/extensions/llm-wiki/lib/utils.js",
  "node_modules/@zosmaai/pi-llm-wiki/dist/extensions/llm-wiki/lib/recall.js",
]) assertContainedPath(requiredFile);

console.log("ticket runtime: exact versions, contained non-symlink ancestors, and required regular files are present");
