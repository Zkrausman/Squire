import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../src/personal/canonical-json.js";
import { backfillCohortFiles } from "../src/personal/cohort-backfill.js";
import { parseArguments, cohortCommand } from "../src/personal/cli.js";
import { NodeCommandRunner } from "../src/personal/command.js";
import { privateFixture, sessionBytes, sourceFixture, manifestFixture, keyFixture } from "./helpers/cohort-fixture.js";

test("explicit host cohort command has no discovery/action adapters and emits sanitized JSON identity", async () => {
  const f = await privateFixture();
  try {
    const bytes = sessionBytes(), artifact = await f.write("session.jsonl", bytes);
    const source = { ...sourceFixture(bytes), artifact }, manifest = manifestFixture(source), keys = keyFixture();
    const signed = keys.signed();
    manifest.runs[0]!.disposition = { manifest: await f.write("disposition.json", signed.bytes), envelope: await f.write("signature.json", signed.envelopeBytes) };
    const baseline = await f.write("operator-baseline.json", Buffer.from('{"legacy-provisional-extraction":true}'));
    manifest.baseline = { artifact: baseline, expected: { input: 10, output: 2, cacheRead: 30, usageRecords: 1, recordedCost: "0.1" } };
    await f.write("unlisted-session.jsonl", Buffer.from("PRIVATE unlisted invalid session"));
    const manifestRef = await f.write("cohort.json", Buffer.from(canonicalJson(manifest))), roots = await f.write("roots.json", Buffer.from(canonicalJson(keys.roots)));
    const config = await f.write("config.json", Buffer.from(JSON.stringify({ repository: { slug: "synthetic/repository", path: f.repository, sourceRef: "main", baseBranch: "main" }, dataDirectory: path.join(f.base, "data"),
      linear: { apiKeyEnv: "SYNTHETIC_UNSET_CREDENTIAL", endpoint: "https://invalid.invalid" }, github: { tokenCommand: ["must-never-be-executed"] },
      sandbox: { roleUser: "fixture", piExecutable: "must-never-be-executed", piAgentDirectory: "/fixture-agent" }, testCommands: ["must-never-be-executed"] })));
    const parsed = parseArguments(["cohort", manifestRef.file, "--trust-roots", roots.file, "--config", config.file]); assert.equal(parsed?.command, "cohort");
    if (parsed?.command !== "cohort") throw new Error("parse failure");
    const originalRun = NodeCommandRunner.prototype.run, originalFetch = globalThis.fetch, write = process.stdout.write, errorWrite = process.stderr.write;
    const savedDataRoot = process.env["SQUIRE_DATA_DIR"]; delete process.env["SQUIRE_DATA_DIR"];
    let stdout = "", stderr = "";
    try {
      NodeCommandRunner.prototype.run = async () => { throw new Error("action adapter invoked"); };
      globalThis.fetch = async () => { throw new Error("network invoked"); };
      process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof write;
      process.stderr.write = ((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof errorWrite;
      assert.equal(await cohortCommand(parsed), 0, stderr);
      assert.equal(stderr, "");
      const identity = JSON.parse(stdout) as { artifactDigest: string; manifestDigest: string };
      assert.match(identity.artifactDigest, /^[a-f0-9]{64}$/u); assert.ok(!stdout.includes(f.root)); assert.ok(!stdout.includes(manifest.runs[0]!.runId));
      stdout = ""; assert.equal(await cohortCommand({ ...parsed, json: true }), 0, stderr);
      const report = JSON.parse(stdout); assert.equal(report.runs.length, 1); assert.equal(report.totals.recordedCost.known, "0.1"); assert.equal(report.runs[0].disposition.merge, "merged");
      assert.ok(report.baseline.dimensions.every((d: { explanation: string }) => d.explanation === "match"));
      for (const forbidden of ["PRIVATE", f.root, keys.roots.keys[0]!.publicKey, signed.envelope.signature]) assert.ok(!stdout.includes(forbidden));
      stdout = ""; assert.equal(await cohortCommand({ ...parsed, manifest: path.join(f.root, "PRIVATE-missing") }), 1);
      assert.ok(!stderr.includes("PRIVATE")); assert.equal(stdout, "");
    } finally { NodeCommandRunner.prototype.run = originalRun; globalThis.fetch = originalFetch; process.stdout.write = write; process.stderr.write = errorWrite; if (savedDataRoot === undefined) delete process.env["SQUIRE_DATA_DIR"]; else process.env["SQUIRE_DATA_DIR"] = savedDataRoot; }
    const a = await backfillCohortFiles({ manifest: manifestRef.file, trustRoots: roots.file, repository: f.repository, dataRoot: path.join(f.base, "data") });
    const b = await backfillCohortFiles({ manifest: manifestRef.file, trustRoots: roots.file, repository: f.repository, dataRoot: path.join(f.base, "data") });
    assert.deepEqual(a, b); assert.deepEqual(await readFile(artifact.file), bytes);
  } finally { await f.cleanup(); }
});
test("cohort CLI rejects discovery selectors, ambiguous options and missing external trust roots", () => {
  for (const argv of [["cohort"], ["cohort", "all"], ["cohort", "m", "--trust-roots"], ["cohort", "m", "--trust-roots", "k", "--background"], ["cohort", "m", "--trust-roots", "k", "--trust-roots", "other"], ["cohort", "m", "--trust-roots", "k", "--json", "--json"], ["cohort", "m", "--trust-roots", "k", "extra"]]) assert.equal(parseArguments(argv), undefined);
});
