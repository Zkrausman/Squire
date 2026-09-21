import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSupportedNode, nodeRuntimeDiagnostic, SUPPORTED_NODE_RANGE } from "../src/runtime-policy.mjs";
import { main } from "../src/personal/cli.js";

const unsupported = ["20.17.0", "22.9.0", "25.0.0", "26.1.2", "100.0.0", "", "24", "24.1", "24.01.0", "24.0.0-rc.1", "garbage"];

test("shared Node policy accepts only stable Node 24 versions", () => {
  assert.equal(SUPPORTED_NODE_RANGE, ">=24 <25");
  for (const version of ["24.0.0", "24.1.2", "24.99.123", "v24.3.0"]) {
    assert.equal(nodeRuntimeDiagnostic(version), undefined);
    assert.doesNotThrow(() => assertSupportedNode(version));
  }
  for (const version of unsupported) {
    const diagnostic = nodeRuntimeDiagnostic(version)!;
    assert.ok(diagnostic.includes(JSON.stringify(version)));
    assert.ok(diagnostic.includes(">=24 <25"));
    assert.match(diagnostic, /Install Node.js 24.*npm ci.*npm run build/u);
    assert.throws(() => assertSupportedNode(version), /Unsupported Node.js/u);
  }
});

// Test-only process injection, not an environment/CLI override available to operators.
function invoke(version: string, script: string, argv: string[] = []) {
  const preload = `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });`;
  return spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, ...argv], { encoding: "utf8" });
}

test("CLI refuses before argument/config access, including reserved child and read-only commands", async () => {
  const argv = new Proxy([] as string[], { get() { throw new Error("argument access before runtime check"); } });
  assert.equal(await main(argv, "22.9.0"), 1);
  for (const version of ["20.17.0", "22.9.0", "25.0.0", "26.0.0"]) {
    for (const args of [[], ["run", "AIDEV-312"], ["run", "AIDEV-312", "--background"], ["run", "AIDEV-312", "--reserved-run-id", "aidev-312-12345678", "--reserved-config-sha256", "a".repeat(64)], ["status", "AIDEV-312"], ["watch", "AIDEV-312"], ["telemetry", "aidev-312-12345678"]]) {
      const result = invoke(version, "dist/src/personal/cli.js", [...args, "--config", "missing-config-must-not-be-read.json"]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), nodeRuntimeDiagnostic(version));
    }
  }
  const supported = invoke("24.0.0", "dist/src/personal/cli.js");
  assert.equal(supported.status, 2);
  assert.match(supported.stderr, /^Usage: squire/u);
});

test("install/build preflight refuses before native compilation, and accepts Node 24", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts.preinstall, "node scripts/runtime-preflight.mjs");
  assert.equal(pkg.scripts.install, "node scripts/build-windows-launch.mjs");
  assert.ok(pkg.scripts.build.startsWith("node scripts/build-windows-launch.mjs && "));
  for (const version of unsupported) {
    for (const script of ["scripts/runtime-preflight.mjs", "scripts/build-windows-launch.mjs"]) {
      const result = invoke(version, script);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), nodeRuntimeDiagnostic(version));
    }
  }
  assert.equal(invoke("24.0.0", "scripts/runtime-preflight.mjs").status, 0);
});
