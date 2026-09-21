import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertSupportedNode, SUPPORTED_NODE_RANGE } from "../src/runtime-policy.mjs";
import { main } from "../src/personal/cli.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const rejected = ["20.17.0", "22.9.0", "25.0.0", "26.1.0", "100.0.0", "", "24", "24.1", "024.0.0", "24.01.0", "24.0.0-rc.1", "24.0.0+custom", "24.0.0\n", "garbage"];
const diagnostic = (version: string): string => `Unsupported Node.js version ${JSON.stringify(version)}; Squire requires >=24 <25 (Node.js 24 only). Install Node.js 24, ensure node and npm use it, then run npm ci --engine-strict and npm run build.`;

// Only tests replace the process version. Production has no environment bypass.
function injectedVersion(version: string): string {
  return `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`)}`;
}

test("runtime policy accepts only Node 24 releases with deterministic actionable refusal", () => {
  assert.equal(SUPPORTED_NODE_RANGE, ">=24 <25");
  for (const version of ["24.0.0", "24.14.1", "24.999.999", "v24.0.0"]) {
    assert.doesNotThrow(() => assertSupportedNode(version));
  }
  for (const version of rejected) {
    assert.throws(() => assertSupportedNode(version), { message: diagnostic(version) });
  }
});

test("unsupported main refuses before even reading public or reserved argv", async t => {
  let stderr = "";
  const mock = t.mock.method(process.stderr, "write", (chunk: string) => { stderr += chunk; return true; });
  try {
    const unreadableArgv = new Proxy([] as string[], { get() { throw new Error("argument handling must not begin"); } });
    for (const version of rejected) {
      stderr = "";
      assert.equal(await main(unreadableArgv, version), 1);
      assert.equal(stderr, `Squire stopped: ${diagnostic(version)}\n`);
    }
    stderr = "";
    assert.equal(await main([], "24.0.0"), 2);
    assert.match(stderr, /^Usage: squire/);
  } finally { mock.mock.restore(); }
});

test("real CLI startup refuses every command and reserved child before config, state or model work", () => {
  const commands = [
    [], ["nonsense"], ["run", "AIDEV-312"], ["run", "AIDEV-312", "--background"],
    ["status", "AIDEV-312"], ["watch", "AIDEV-312"], ["telemetry", "aidev-312-01234567"],
    ["run", "AIDEV-312", "--reserved-run-id", "aidev-312-01234567", "--reserved-config-sha256", "a".repeat(64)],
  ];
  for (const version of ["20.17.0", "22.9.0", "25.0.0", "26.0.0"]) {
    for (const argv of commands) {
      const child = spawnSync(process.execPath, ["--import", injectedVersion(version), "dist/src/personal/cli.js", ...argv, "--config", "nonexistent-config.json"], { cwd: root, encoding: "utf8", timeout: 10_000 });
      assert.ifError(child.error);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, "");
      assert.equal(child.stderr, `Squire stopped: ${diagnostic(version)}\n`);
    }
  }
});

test("install and direct native/build preflights share the policy before compiler work", () => {
  for (const script of ["scripts/check-runtime.mjs", "scripts/build-windows-launch.mjs"]) {
    for (const version of ["20.17.0", "22.9.0", "25.0.0", "26.0.0"]) {
      const child = spawnSync(process.execPath, ["--import", injectedVersion(version), script], { cwd: root, encoding: "utf8", timeout: 10_000 });
      assert.ifError(child.error);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, "");
      assert.equal(child.stderr, `${diagnostic(version)}\n`);
    }
  }
  const accepted = spawnSync(process.execPath, ["--import", injectedVersion("24.0.0"), "scripts/check-runtime.mjs"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.ifError(accepted.error);
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stderr, "");
});

test("root package/lock and lifecycle entry points agree on the bounded runtime contract", () => {
  const read = (name: string): string => readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
  const manifest = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(read(".nvmrc").trim(), "24");
  assert.equal(manifest.engines.node, SUPPORTED_NODE_RANGE);
  assert.equal(lock.packages[""].engines.node, SUPPORTED_NODE_RANGE);
  assert.equal(manifest.scripts.preinstall, "node scripts/check-runtime.mjs");
  assert.equal(manifest.scripts.install, "node scripts/build-windows-launch.mjs");
  assert.equal(manifest.scripts.build, "node scripts/build-windows-launch.mjs && tsc -p tsconfig.json");
  assert.match(read("scripts/build-windows-launch.mjs"), /^import "\.\/check-runtime\.mjs";/);
  assert.match(read("scripts/check-runtime.mjs"), /import \{ assertSupportedNode \} from "\.\.\/src\/runtime-policy\.mjs"/);
});
