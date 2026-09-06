import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { V1ArtifactValidator } from "../src/contracts/v1-artifact-validator.js";
import { SafeArtifactReader } from "../src/control/safe-artifact-reader.js";
import { PlanArtifactPublisher } from "../src/plan/plan-artifact-publisher.js";
import { PlanResultDiscovery } from "../src/plan/plan-result-discovery.js";
import type { PlanSubmission } from "../src/plan/domain.js";
import { createPlanFixture } from "./support/plan-fixtures.js";

function validSubmission(): PlanSubmission {
  return {
    disposition: "pass",
    plan: {
      schemaVersion: 1,
      runId: "run_planfixture01",
      ticketIdentifier: "AIDEV-218",
      inputHead: "a".repeat(40),
      summary: "Implement the generic Plan protocol.",
      assumptions: ["The controller owns the workspace identity."],
      steps: [{ id: "step-1", description: "Add the Plan protocol.", affectedPaths: ["src/plan/plan-session.ts"], acceptanceCriteria: ["The Plan validation suite passes."] }],
      risks: [{ risk: "A stale head could invalidate the result.", mitigation: "Recheck readiness before acceptance." }],
      validationCommandIds: ["contracts", "tests"],
    },
    questions: [],
  };
}

async function validator(root: string): Promise<V1ArtifactValidator> {
  return V1ArtifactValidator.create(new SafeArtifactReader(root), path.resolve("contracts/v1"));
}

test("Plan publisher writes canonical private artifacts in plan/evidence/result order and retries identically", async () => {
  const fixture = await createPlanFixture();
  try {
    const publisher = new PlanArtifactPublisher({ ticketRoot: fixture.ticketRoot, validator: await validator(fixture.ticketRoot) });
    const first = await publisher.publish(validSubmission(), fixture.publicationContext);
    assert.equal(first.planReference.path, "artifacts/plan/1/plan.json");
    assert.equal(first.resultReference.path, "artifacts/plan/1/result.json");
    assert.equal(first.evidenceReference.kind, "report");
    assert.equal(first.result["status"], "pass");
    assert.deepEqual(first.result["findings"], []);
    assert.deepEqual(first.result["failures"], []);
    assert.equal(first.result["inputHead"], first.result["outputHead"]);
    assert.equal((await new PlanResultDiscovery(fixture.ticketRoot).discover(1))!.sha256, first.resultReference.sha256);
    for (const relative of ["artifacts/plan/1/plan.json", "artifacts/plan/1/result.json", "evidence/plan/1/verification.md"]) {
      const info = await lstat(path.join(fixture.ticketRoot, ...relative.split("/")));
      assert.equal(info.isFile(), true);
      assert.equal(info.nlink, 1);
      assert.equal(info.mode & 0o777, 0o600);
    }
    const retry = await publisher.publish(validSubmission(), fixture.publicationContext);
    assert.deepEqual(retry.result, first.result);
    const changed: PlanSubmission = { ...validSubmission(), plan: { ...validSubmission().plan, summary: "A different immutable plan." } };
    await assert.rejects(publisher.publish(changed, fixture.publicationContext), /immutable Plan output conflict/iu);
    assert.match(await readFile(path.join(fixture.ticketRoot, "evidence/plan/1/verification.md"), "utf8"), /inputArtifact: artifacts\/input\/phase-input\.json/u);
  } finally {
    await import("node:fs/promises").then(fs => fs.rm(fixture.root, { recursive: true, force: true }));
  }
});

test("Plan publisher fails closed on symlink, hardlink, and non-private output destinations", async () => {
  const fixture = await createPlanFixture();
  try {
    const outputDirectory = path.join(fixture.ticketRoot, "artifacts/plan/1");
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const outside = path.join(fixture.root, "outside.json");
    await writeFile(outside, "outside\n", { mode: 0o600 });
    await symlink(outside, path.join(outputDirectory, "plan.json"));
    const publisher = new PlanArtifactPublisher({ ticketRoot: fixture.ticketRoot });
    await assert.rejects(publisher.publish(validSubmission(), fixture.publicationContext), /safely|private|conflict|output/iu);
    await import("node:fs/promises").then(fs => fs.rm(path.join(outputDirectory, "plan.json")));
    const hardlinkSource = path.join(fixture.root, "hardlink.json");
    await writeFile(hardlinkSource, "hardlink\n", { mode: 0o600 });
    await import("node:fs/promises").then(fs => fs.link(hardlinkSource, path.join(outputDirectory, "plan.json")));
    await assert.rejects(publisher.publish(validSubmission(), fixture.publicationContext), /private|hardlink|conflict/iu);
    await import("node:fs/promises").then(fs => fs.rm(path.join(outputDirectory, "plan.json")));
    await writeFile(path.join(outputDirectory, "plan.json"), "not private\n", { mode: 0o644 });
    await assert.rejects(publisher.publish(validSubmission(), fixture.publicationContext), /private|conflict/iu);
  } finally {
    await import("node:fs/promises").then(fs => fs.rm(fixture.root, { recursive: true, force: true }));
  }
});

test("Plan result discovery accepts only one bounded private regular result path", async () => {
  const fixture = await createPlanFixture();
  try {
    const publisher = new PlanArtifactPublisher({ ticketRoot: fixture.ticketRoot });
    await publisher.publish(validSubmission(), fixture.publicationContext);
    const discovery = new PlanResultDiscovery(fixture.ticketRoot);
    assert.ok(await discovery.discover(1));
    await chmod(path.join(fixture.ticketRoot, "artifacts/plan/1/result.json"), 0o644);
    await assert.rejects(discovery.discover(1), /private/iu);
    await chmod(path.join(fixture.ticketRoot, "artifacts/plan/1/result.json"), 0o600);
    await import("node:fs/promises").then(fs => fs.rm(path.join(fixture.ticketRoot, "artifacts/plan/1/result.json")));
    await symlink(path.join(fixture.root, "outside-result.json"), path.join(fixture.ticketRoot, "artifacts/plan/1/result.json"));
    await writeFile(path.join(fixture.root, "outside-result.json"), "outside\n", { mode: 0o600 });
    await assert.rejects(discovery.discover(1), /open|regular|private|symlink/iu);
    // The trusted fixture is isolated from /ticket/runtime; no discovery path
    // can cause cleanup outside this temporary root.
    assert.equal((await lstat(fixture.ticketRoot)).isDirectory(), true);
  } finally {
    await import("node:fs/promises").then(fs => fs.rm(fixture.root, { recursive: true, force: true }));
  }
});
