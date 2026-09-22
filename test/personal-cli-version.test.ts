import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = process.cwd();
const cli = path.join(root, "dist/src/personal/cli.js");
const packageVersion = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
const loadProbe = pathToFileURL(path.join(root, "test/support/version-load-probe.mjs")).href;
const rootUrl = pathToFileURL(`${root}${path.sep}`).href;
const probeImport = `data:text/javascript,import{register}from"node:module";register(${JSON.stringify(loadProbe)},${JSON.stringify(rootUrl)});`;

function run(args: readonly string[], withLoadProbe = false) {
  return spawnSync(process.execPath, [...(withLoadProbe ? ["--import", probeImport] : []), cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SQUIRE_CONFIG: path.join(root, "missing-version-config.json") },
  });
}

test("--version and -V are exact dependency-free subprocess commands", () => {
  for (const alias of ["--version", "-V"]) {
    const result = run([alias], true);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${packageVersion}\n`);
    assert.equal(result.stderr, "");
  }
});

test("version flags reject extra operands and incompatible options through bounded CLI errors", () => {
  for (const args of [["--version", "extra"], ["-V", "--config", "missing.json"], ["--version", "-V"], ["run", "AIDEV-318", "--version"]]) {
    const result = run(args);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Usage: squire /u);
  }
});
