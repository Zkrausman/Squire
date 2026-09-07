import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflowPath = ".github/workflows/ci.yml";
const workflow = await readFile(workflowPath, "utf8");
const runtimeManifest = JSON.parse(await readFile(".github/runtime/package.json", "utf8"));
const runtimeLock = JSON.parse(await readFile(".github/runtime/package-lock.json", "utf8"));

assert.match(workflow, /^name: CI\n/u);
assert.match(workflow, /\n  pull_request:\n  push:\n    branches:\n      - main\n/u);
assert.match(workflow, /\npermissions:\n  contents: read\n/u);
assert.match(workflow, /\n  clean-install-build-test:\n    name: clean-install-build-test\n/u);
assert.match(workflow, /uses: actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false\n/u);
assert.match(workflow, /uses: actions\/setup-node@v4\n\s+with:\n\s+node-version: "22"\n\s+cache: npm\n/u);
assert.match(workflow, /run: node \.github\/validate-ci-workflow\.mjs\n/u);
assert.match(workflow, /run: npm ci\n/u);
assert.match(workflow, /npm ci --prefix \/ticket\/runtime --ignore-scripts --no-audit --no-fund/u);
assert.match(workflow, /run: npm run build\n/u);
assert.match(workflow, /run: npm run validate:contracts\n/u);
assert.match(workflow, /run: npm test\n/u);
assert.match(workflow, /git diff --exit-code\n\s+test -z "\$\(git status --porcelain --untracked-files=all\)"/u);
for (const forbidden of [
  /pull_request_target/u,
  /secrets\./u,
  /permissions:\s*write/u,
  /continue-on-error:\s*true/u,
  /--test-name-pattern/u,
  /\|\|\s*true/u,
]) assert.doesNotMatch(workflow, forbidden);

assert.deepEqual(runtimeManifest, {
  private: true,
  type: "module",
  dependencies: {
    "@earendil-works/pi-coding-agent": "0.84.4",
    "@zosmaai/pi-llm-wiki": "0.11.8",
  },
});
assert.deepEqual(runtimeLock.packages?.[""], {
  dependencies: {
    "@earendil-works/pi-coding-agent": "0.84.4",
    "@zosmaai/pi-llm-wiki": "0.11.8",
  },
});
assert.equal(runtimeLock.lockfileVersion, 3);

console.log("CI workflow and pinned ticket-runtime manifest: valid");
