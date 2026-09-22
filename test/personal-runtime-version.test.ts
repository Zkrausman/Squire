import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { main } from "../src/personal/cli.js";
import { isSupportedNodeVersion } from "../src/personal/runtime-version.js";

test("runtime predicate accepts only stable Node 24 without alternate executables", () => {
  for (const version of ["24.0.0", "24.14.0", "v24.99.1"]) assert.equal(isSupportedNodeVersion(version), true, version);
  for (const version of ["20.17.0", "22.9.0", "22.22.1", "25.0.0", "24", "24.0", "24.0.0-rc.1", "024.0.0", "24.01.0", "24.0.0\n", "garbage", ""]) {
    assert.equal(isSupportedNodeVersion(version), false, version);
  }
});

test("unsupported public and reserved CLI commands stop before argument/config/provider work", async () => {
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stderr.write;
  try {
    for (const nodeVersion of ["20.17.0", "22.22.1", "25.0.0"]) {
      for (const command of ["run", "status", "watch", "telemetry"]) {
        assert.equal(await main([command, "AIDEV-1", "--config", "/missing/config"], { nodeVersion }), 1);
      }
      assert.equal(await main(["run", "AIDEV-1", "--reserved-run-id", "aidev-1-0123456789", "--reserved-config-sha256", "a".repeat(64)], { nodeVersion }), 1);
      // Even inspecting argv would precede the guard and fail this test.
      const argv = new Proxy([] as string[], { get() { throw new Error("argument work before runtime guard"); } });
      assert.equal(await main(argv, { nodeVersion }), 1);
    }
    assert.equal(output.split("\n").filter(Boolean).length, 18);
    assert.ok(output.split("\n").filter(Boolean).every(line => line.startsWith("Squire requires Node.js 24")));
  } finally { process.stderr.write = original; }
});

test("production executable uses actual runtime and ignores attempted environment overrides", () => {
  const result = spawnSync(process.execPath, [path.resolve("dist/src/personal/cli.js")], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, SQUIRE_NODE_VERSION: "24.0.0", SQUIRE_SKIP_RUNTIME_CHECK: "1" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, isSupportedNodeVersion(process.versions.node) ? 2 : 1);
  assert.match(result.stderr, isSupportedNodeVersion(process.versions.node) ? /Usage: squire/ : /Squire requires Node.js 24/);
  assert.equal(result.stdout, "");
});
