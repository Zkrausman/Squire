import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { publishCohort, assertOutsideRepository, runCohort } from "../src/personal/cohort-store.js";
import { publishPrivateBytes, readPrivateBytes } from "../src/personal/private-artifacts.js";
import { canonicalJson, sha256 } from "../src/personal/canonical-json.js";
import { readHistoricalTelemetry } from "../src/personal/historical-telemetry.js";
import { launchTestRoot, assertProtectedAcl, grant } from "./helpers/windows-launch.js";
import { cohortFixture, sessionFixture } from "./helpers/cohort.js";

test("canonical private publication is additive, byte-idempotent and rejects conflicts", async () => {
  const root = await launchTestRoot("squire-cohort-store-");
  try {
    const artifact = { schemaVersion: 1, z: [], a: "synthetic" };
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => publishCohort(root, artifact)));
    assert.ok(concurrent.every(r => r.path === concurrent[0]!.path));
    const published = concurrent[0]!; const bytes = await readFile(published.path); const stat = await lstat(published.path);
    assert.equal(bytes.toString(), canonicalJson(artifact)); assert.equal(sha256(bytes), published.digest);
    assert.deepEqual(await publishCohort(root, artifact), published); assert.equal((await lstat(published.path)).mtimeMs, stat.mtimeMs);
    if (process.platform === "win32") assertProtectedAcl(published.path);
    else { assert.equal(stat.mode & 0o777, 0o600); assert.equal((await lstat(path.dirname(published.path))).mode & 0o777, 0o700); }
    await assert.rejects(publishPrivateBytes(published.path, "different"));
    const next = await publishCohort(root, { ...artifact, a: "changed" }); assert.notEqual(next.path, published.path); assert.deepEqual(await readFile(published.path), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("source reads preserve bytes and reject bounds, unsafe files, and digest tampering", async () => {
  const root = await launchTestRoot("squire-cohort-source-");
  try {
    const fixture = sessionFixture(); fixture.source.path = path.join(root, "retained.jsonl"); await publishPrivateBytes(fixture.source.path, fixture.bytes.toString());
    assert.equal((await readHistoricalTelemetry(fixture.source)).artifact.totals.messages, 1);
    assert.deepEqual(await readFile(fixture.source.path), fixture.bytes); await assert.rejects(readPrivateBytes(fixture.source.path, 1));
    assert.equal((await readHistoricalTelemetry({ ...fixture.source, digest: "0".repeat(64) })).artifact.diagnostic, "invalid_or_unavailable_source");
    // Invalid UTF-8 must remain exact bytes even on the Windows native path.
    await writeFile(fixture.source.path, Buffer.from([255, 0, 10])); assert.deepEqual(await readPrivateBytes(fixture.source.path), Buffer.from([255, 0, 10]));
    if (process.platform !== "win32") {
      await chmod(fixture.source.path, 0o644); await assert.rejects(readPrivateBytes(fixture.source.path)); await chmod(fixture.source.path, 0o600);
      const link = path.join(root, "link"); await symlink(fixture.source.path, link); await assert.rejects(readPrivateBytes(link));
      const directory = path.join(root, "directory"); await mkdir(directory, { mode: 0o700 }); await assert.rejects(readPrivateBytes(directory));
    } else { grant(fixture.source.path, "S-1-5-32-545", "Read"); await assert.rejects(readPrivateBytes(fixture.source.path)); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("host orchestration with unavailable trust retains usage and publishes reproducible private scorecard", async () => {
  const root = await launchTestRoot("squire-cohort-host-");
  try {
    const repo = path.join(root, "repository"); await mkdir(repo); await mkdir(path.join(repo, ".git"));
    await assert.rejects(assertOutsideRepository(path.join(repo, "roots"), repo));
    const spec = cohortFixture(); const fixture = sessionFixture(); fixture.source.path = path.join(root, "retained"); spec.runs[0]!.sources.push(fixture.source);
    await publishPrivateBytes(fixture.source.path, fixture.bytes.toString()); const specFile = path.join(root, "spec"); await publishPrivateBytes(specFile, canonicalJson(spec));
    const options = { specFile, trustRootsFile: path.join(root, "missing-roots"), repositoryPath: repo, dataDirectory: root, stateDirectory: path.join(root, "states"), stagingDirectory: path.join(root, "staging") };
    const result = await runCohort(options); assert.deepEqual(await runCohort(options), result);
    const artifact = JSON.parse(await readFile(result.path, "utf8")); assert.equal(artifact.trustRootsStatus, "unavailable"); assert.equal(artifact.observations[0].totals.tokens.input.known, 10); assert.equal(artifact.observations[0].disposition.status, "unknown");
    assert.doesNotMatch(await readFile(result.path, "utf8"), /SECRET|PRIVATE_PATH|retained|missing-roots/u);
    await writeFile(specFile, "SECRET malformed input"); await assert.rejects(runCohort(options), e => e instanceof Error && e.message === "Cohort unavailable: invalid configuration or private evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});
