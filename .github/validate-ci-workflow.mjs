import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const RUNTIME_MANIFEST_PATH = ".github/runtime/package.json";
const RUNTIME_LOCK_PATH = ".github/runtime/package-lock.json";
const RUNTIME_VALIDATOR_PATH = ".github/validate-ticket-runtime.mjs";
const EXPECTED_RUNTIME_VALIDATOR_SHA256 = "a6656246b9ccc62a4ecf1600ff4817eb7bb51c5178c71472c1305ae08c10fdbf";
const EXPECTED_PROVISION_RUN = [
  'sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /ticket /ticket/runtime /ticket/workspace',
  "install -m 600 .github/runtime/package.json /ticket/runtime/package.json",
  "install -m 600 .github/runtime/package-lock.json /ticket/runtime/package-lock.json",
  "npm ci --prefix /ticket/runtime --ignore-scripts --no-audit --no-fund",
].join("\n") + "\n";

function indentation(line) {
  const match = /^( *)/.exec(line);
  if (line.includes("\t")) throw new Error("tabs are not permitted in CI YAML");
  return match?.[1].length ?? 0;
}

function nextContent(lines, start) {
  let index = start;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  return index;
}

function splitEntry(content) {
  const match = /^([A-Za-z0-9_.-]+):(.*)$/u.exec(content);
  if (!match) throw new Error(`unsupported YAML entry: ${content}`);
  return { key: match[1], rawValue: match[2].trim() };
}

function scalar(rawValue) {
  if (rawValue === "") return null;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  if (rawValue === "null") return null;
  if (rawValue.startsWith('"') && rawValue.endsWith('"')) return JSON.parse(rawValue);
  if (rawValue.startsWith("'") && rawValue.endsWith("'")) return rawValue.slice(1, -1).replaceAll("''", "'");
  return rawValue;
}

function parseWorkflow(source) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");

  function blockScalar(start, parentIndent, folded) {
    let index = start;
    let contentIndent;
    const values = [];
    while (index < lines.length) {
      const line = lines[index];
      if (line.trim() === "") {
        const next = nextContent(lines, index + 1);
        if (next >= lines.length || indentation(lines[next]) <= parentIndent) break;
        values.push("");
        index += 1;
        continue;
      }
      const lineIndent = indentation(line);
      if (lineIndent <= parentIndent) break;
      contentIndent ??= lineIndent;
      if (lineIndent < contentIndent) throw new Error("inconsistent block scalar indentation");
      values.push(line.slice(contentIndent));
      index += 1;
    }
    const value = folded ? values.join(" ") : values.join("\n");
    return { value: `${value}\n`, index };
  }

  function parseBlock(start, expectedIndent) {
    let index = nextContent(lines, start);
    if (index >= lines.length || indentation(lines[index]) < expectedIndent) return { value: null, index };
    const actualIndent = indentation(lines[index]);
    if (actualIndent !== expectedIndent) throw new Error(`unexpected YAML indentation at line ${index + 1}`);
    if (lines[index].slice(expectedIndent).startsWith("-")) return parseSequence(index, expectedIndent);
    return parseMap(index, expectedIndent);
  }

  function parseMap(start, mapIndent) {
    const value = {};
    let index = start;
    while (true) {
      index = nextContent(lines, index);
      if (index >= lines.length || indentation(lines[index]) < mapIndent) break;
      if (indentation(lines[index]) > mapIndent) throw new Error(`unexpected nested YAML mapping at line ${index + 1}`);
      const content = lines[index].slice(mapIndent);
      if (content.startsWith("-")) break;
      const { key, rawValue } = splitEntry(content);
      if (Object.hasOwn(value, key)) throw new Error(`duplicate YAML key: ${key}`);
      index += 1;
      let parsed;
      if (rawValue === "|" || rawValue === ">") {
        const block = blockScalar(index, mapIndent, rawValue === ">");
        parsed = block.value;
        index = block.index;
      } else if (rawValue === "") {
        const child = nextContent(lines, index);
        if (child < lines.length && indentation(lines[child]) > mapIndent) {
          const nested = parseBlock(child, indentation(lines[child]));
          parsed = nested.value;
          index = nested.index;
        } else {
          parsed = null;
        }
      } else {
        parsed = scalar(rawValue);
      }
      value[key] = parsed;
    }
    return { value, index };
  }

  function parseSequence(start, sequenceIndent) {
    const value = [];
    let index = start;
    while (true) {
      index = nextContent(lines, index);
      if (index >= lines.length || indentation(lines[index]) < sequenceIndent) break;
      if (indentation(lines[index]) !== sequenceIndent) throw new Error(`unexpected YAML sequence indentation at line ${index + 1}`);
      const content = lines[index].slice(sequenceIndent);
      if (!content.startsWith("-")) break;
      const body = content.slice(1).trimStart();
      index += 1;
      if (body === "") {
        const child = nextContent(lines, index);
        if (child >= lines.length || indentation(lines[child]) <= sequenceIndent) throw new Error("empty YAML sequence item");
        const nested = parseBlock(child, indentation(lines[child]));
        value.push(nested.value);
        index = nested.index;
        continue;
      }
      if (/^[A-Za-z0-9_.-]+:/u.test(body)) {
        const first = splitEntry(body);
        const object = {};
        let parsed;
        if (first.rawValue === "|" || first.rawValue === ">") {
          const block = blockScalar(index, sequenceIndent, first.rawValue === ">");
          parsed = block.value;
          index = block.index;
        } else if (first.rawValue === "") {
          const child = nextContent(lines, index);
          if (child < lines.length && indentation(lines[child]) > sequenceIndent) {
            const nested = parseBlock(child, indentation(lines[child]));
            parsed = nested.value;
            index = nested.index;
          } else {
            parsed = null;
          }
        } else {
          parsed = scalar(first.rawValue);
        }
        object[first.key] = parsed;
        const child = nextContent(lines, index);
        if (child < lines.length && indentation(lines[child]) > sequenceIndent) {
          const nested = parseBlock(child, indentation(lines[child]));
          if (nested.value === null || typeof nested.value !== "object" || Array.isArray(nested.value)) throw new Error("YAML sequence mapping child is not a map");
          for (const [key, nestedValue] of Object.entries(nested.value)) {
            if (Object.hasOwn(object, key)) throw new Error(`duplicate YAML sequence key: ${key}`);
            object[key] = nestedValue;
          }
          index = nested.index;
        }
        value.push(object);
      } else {
        value.push(scalar(body));
      }
    }
    return { value, index };
  }

  const parsed = parseBlock(0, 0);
  const remainder = nextContent(lines, parsed.index);
  if (remainder < lines.length) throw new Error(`unparsed YAML at line ${remainder + 1}`);
  return parsed.value;
}

function exactKeys(value, keys, label) {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label} must be a mapping`);
  assert.deepEqual(Object.keys(value), keys, `${label} keys/order changed`);
}

function exactRun(step, expected, label) {
  assert.equal(step.run, expected, `${label} run changed`);
}

const workflow = await readFile(WORKFLOW_PATH, "utf8");
const runtimeManifest = JSON.parse(await readFile(RUNTIME_MANIFEST_PATH, "utf8"));
const runtimeLock = JSON.parse(await readFile(RUNTIME_LOCK_PATH, "utf8"));
const runtimeValidator = await readFile(RUNTIME_VALIDATOR_PATH, "utf8");
const document = parseWorkflow(workflow);
const runtimeValidatorSha256 = createHash("sha256").update(runtimeValidator).digest("hex");
assert.equal(runtimeValidatorSha256, EXPECTED_RUNTIME_VALIDATOR_SHA256, "ticket runtime validator source changed");
assert.match(runtimeValidator, /lstatSync/u);
assert.match(runtimeValidator, /isSymbolicLink/u);
assert.match(runtimeValidator, /path\.posix\.relative/u);
assert.match(runtimeValidator, /pi-tui/u);

exactKeys(document, ["name", "on", "permissions", "jobs"], "workflow");
assert.equal(document.name, "CI");
exactKeys(document.on, ["pull_request", "push"], "workflow.on");
assert.equal(document.on.pull_request, null);
exactKeys(document.on.push, ["branches"], "workflow.on.push");
assert.deepEqual(document.on.push.branches, ["main"]);
exactKeys(document.permissions, ["contents"], "workflow.permissions");
assert.equal(document.permissions.contents, "read");
exactKeys(document.jobs, ["clean-install-build-test"], "workflow.jobs");
const job = document.jobs["clean-install-build-test"];
exactKeys(job, ["name", "runs-on", "steps"], "clean-install-build-test job");
assert.equal(job.name, "clean-install-build-test");
assert.equal(job["runs-on"], "ubuntu-latest");
assert.equal(Array.isArray(job.steps), true);

const expectedStepNames = [
  "Checkout",
  "Set up Node.js",
  "Validate CI workflow contract",
  "Run CI workflow negative probes",
  "Install dependencies",
  "Provision ticket runtime",
  "Validate ticket runtime",
  "Build",
  "Validate contracts",
  "Run tests",
  "Verify clean tree",
];
assert.deepEqual(job.steps.map(step => step.name), expectedStepNames, "CI gate step order changed");

const [checkout, setupNode, workflowValidation, negativeProbes, install, provision, runtimeValidation, build, contracts, tests, cleanTree] = job.steps;
exactKeys(checkout, ["name", "uses", "with"], "Checkout step");
assert.equal(checkout.uses, "actions/checkout@v4");
exactKeys(checkout.with, ["persist-credentials"], "Checkout.with");
assert.equal(checkout.with["persist-credentials"], false);
exactKeys(setupNode, ["name", "uses", "with"], "Set up Node.js step");
assert.equal(setupNode.uses, "actions/setup-node@v4");
exactKeys(setupNode.with, ["node-version", "cache", "cache-dependency-path"], "Set up Node.js.with");
assert.equal(setupNode.with["node-version"], "22");
assert.equal(setupNode.with.cache, "npm");
assert.deepEqual(setupNode.with["cache-dependency-path"].trim().split("\n"), ["package-lock.json", ".github/runtime/package-lock.json"]);
exactKeys(workflowValidation, ["name", "run"], "workflow validation step");
exactRun(workflowValidation, "node .github/validate-ci-workflow.mjs", "workflow validation");
exactKeys(negativeProbes, ["name", "run"], "negative probes step");
exactRun(negativeProbes, "node .github/test-ci-workflow-validator.mjs", "negative probes");
exactKeys(install, ["name", "run"], "root install step");
exactRun(install, "npm ci", "root install");
exactKeys(provision, ["name", "run"], "runtime provisioning step");
exactRun(provision, EXPECTED_PROVISION_RUN, "runtime provisioning");
exactKeys(runtimeValidation, ["name", "run"], "runtime validation step");
exactRun(runtimeValidation, "node .github/validate-ticket-runtime.mjs", "runtime validation");
exactKeys(build, ["name", "run"], "build step");
exactRun(build, "npm run build", "build");
exactKeys(contracts, ["name", "run"], "contract validation step");
exactRun(contracts, "npm run validate:contracts", "contract validation");
exactKeys(tests, ["name", "run"], "test step");
exactRun(tests, "npm test", "tests");
exactKeys(cleanTree, ["name", "run"], "clean-tree step");
assert.equal(cleanTree.run.trim(), "git diff --exit-code\ntest -z \"$(git status --porcelain --untracked-files=all)\"");

for (const [label, value] of [["workflow", document], ["job", job], ...job.steps.map(step => [step.name, step])]) {
  assert.equal(Object.hasOwn(value, "if"), false, `${label} must be unconditional`);
  assert.equal(Object.hasOwn(value, "continue-on-error"), false, `${label} cannot continue on error`);
}
for (const forbidden of [
  /pull_request_target/u,
  /secrets\./u,
  /permissions:\s*write/u,
  /continue-on-error\s*:/u,
  /(^|\n)\s*if\s*:/u,
  /--test-name-pattern/u,
  /\|\|\s*true/u,
  /(^|[\n;])\s*true\s*$/mu,
]) assert.doesNotMatch(workflow, forbidden);

assert.deepEqual(runtimeManifest, {
  private: true,
  type: "module",
  dependencies: {
    "@earendil-works/pi-coding-agent": "0.84.4",
    "@zosmaai/pi-llm-wiki": "0.11.8",
  },
});
assert.equal(runtimeLock.lockfileVersion, 3);
assert.deepEqual(runtimeLock.packages?.[""], {
  dependencies: {
    "@earendil-works/pi-coding-agent": "0.84.4",
    "@zosmaai/pi-llm-wiki": "0.11.8",
  },
});
const runtimePackages = Object.entries(runtimeLock.packages).filter(([packagePath]) => packagePath !== "");
assert.equal(runtimePackages.length > 0, true);
for (const [packagePath, record] of runtimePackages) {
  assert.equal(typeof record.version, "string", `${packagePath} version missing`);
  assert.match(record.resolved, /^https:\/\/registry\.npmjs\.org\/.*\.tgz$/u, `${packagePath} registry origin is not exact`);
  assert.equal(record.resolved.endsWith(`-${record.version}.tgz`), true, `${packagePath} resolved version mismatch`);
  assert.match(record.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u, `${packagePath} SRI missing or not sha512`);
  assert.equal(Buffer.from(record.integrity.slice("sha512-".length), "base64").length, 64, `${packagePath} SRI is not a SHA-512 digest`);
  assert.equal(Object.hasOwn(record, "link"), false, `${packagePath} cannot be a link`);
}
const requiredRuntimePackages = {
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core": "0.84.4",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai": "0.84.4",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-client": "0.84.4",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-protocol": "0.84.4",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-telemetry": "0.84.4",
  "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui": "0.84.4",
};
for (const [packagePath, version] of Object.entries(requiredRuntimePackages)) assert.equal(runtimeLock.packages[packagePath]?.version, version, `${packagePath} version is not pinned`);

console.log(`CI workflow, unconditional gate order, ${runtimePackages.length} integrity-bound runtime packages, and pinned ticket-runtime manifest: valid`);
