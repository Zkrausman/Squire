import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { assertSupportedNode, NODE_RUNTIME_PREFLIGHT, NODE_RUNTIME_RANGE } from "../src/node-runtime-policy.mjs";
import { main } from "../src/personal/cli.js";

const unsupported = ["20.17.0", "22.9.0", "25.0.0", "26.0.0", "100.0.0", "", "24", "v24.0.0", "24.01.0", "24.0.0-pre", "24.0.0\n", "24.0.0\u001b[31m", "x".repeat(1000)];

test("developer runtime selection agrees with the Node 24 package contract", async () => {
  assert.equal((await readFile(".nvmrc", "utf8")).trim(), "24");
  for (const file of ["package.json", ".github/runtime/package.json"]) {
    const manifest = JSON.parse(await readFile(file, "utf8")) as { engines: { node: string } };
    assert.equal(manifest.engines.node, NODE_RUNTIME_RANGE);
  }
});

test("runtime policy accepts only Node 24 releases and bounds sanitized refusal diagnostics", () => {
  assert.equal(NODE_RUNTIME_RANGE, ">=24 <25");
  for (const version of ["24.0.0", "24.21.0", "24.999.999"]) {
    assert.doesNotThrow(() => assertSupportedNode(version));
    vm.runInNewContext(NODE_RUNTIME_PREFLIGHT, { process: { versions: { node: version } } });
  }
  for (const version of unsupported) {
    assert.throws(() => assertSupportedNode(version), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Squire requires >=24 <25\. Install\/use Node.js 24/u);
      assert.doesNotMatch(error.message, /[\x00-\x1f\x7f]/u);
      assert.ok(error.message.length < 350);
      return true;
    });
    assert.throws(() => vm.runInNewContext(NODE_RUNTIME_PREFLIGHT, { process: { versions: { node: version } } }), /Squire requires >=24 <25/u);
  }
});

test("public and reserved CLI refuse before even inspecting arguments/configuration", async t => {
  let diagnostic = "";
  t.mock.method(process.stderr, "write", (text: string) => { diagnostic += text; return true; });
  for (const version of unsupported) {
    // Any argument read is a failure: this covers both public and reserved dispatch,
    // including malformed arguments, before config/state/credential adapters exist.
    const unreadableArguments = new Proxy([] as string[], { get() { throw new Error("arguments inspected before preflight"); } });
    assert.equal(await main(unreadableArguments, version), 1);
    for (const argv of [["run", "AIDEV-1", "--config", "must-not-read"], ["run", "AIDEV-1", "--config", "must-not-read", "--reserved-run-id", "aidev-1-0123456789", "--reserved-config-sha256", "a".repeat(64)]]) {
      assert.equal(await main(argv, version), 1);
    }
  }
  assert.match(diagnostic, /Squire requires >=24 <25/u);
  diagnostic = "";
  assert.equal(await main([], "24.0.0"), 2);
  assert.match(diagnostic, /Usage: squire/u);
});

test("source and compiled entrypoints fail before install/native build/runtime validation", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts["preinstall"], "node scripts/check-node-runtime.mjs");
  assert.equal(manifest.scripts["install"], "node scripts/build-windows-launch.mjs");
  assert.match(manifest.scripts["build"]!, /^node scripts\/build-windows-launch.mjs &&/u);
  for (const entry of ["scripts/check-node-runtime.mjs", "scripts/build-windows-launch.mjs", ".github/validate-ticket-runtime.mjs", "dist/src/personal/cli.js"]) {
    for (const version of ["20.17.0", "22.9.0", "25.0.0"]) {
      const script = `Object.defineProperty(process.versions, "node", {value: ${JSON.stringify(version)}}); process.argv[1] = ${JSON.stringify(entry)}; await import(${JSON.stringify(`./${entry}`)});`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
      assert.equal(result.status, 1, `${entry}: ${result.stderr}`);
      assert.match(result.stderr, /Squire requires >=24 <25/u);
      assert.doesNotMatch(result.stderr, /gyp info|ENOENT|Usage: squire/u);
    }
  }
});
