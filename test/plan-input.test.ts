import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { V1ArtifactValidator } from "../src/contracts/v1-artifact-validator.js";
import { SafeArtifactReader } from "../src/control/safe-artifact-reader.js";
import { serializeCanonical } from "../src/git/contracts.js";
import { PlanInputValidationError, PlanInputValidator } from "../src/plan/plan-input-validator.js";
import type { PlanAttemptContext } from "../src/plan/domain.js";
import { createPlanFixture } from "./support/plan-fixtures.js";

async function inputValidator(ticketRoot: string): Promise<PlanInputValidator> {
  return PlanInputValidator.fromValidator(await V1ArtifactValidator.create(new SafeArtifactReader(ticketRoot), path.resolve("contracts/v1")));
}

function context(fixture: Awaited<ReturnType<typeof createPlanFixture>>): PlanAttemptContext {
  return {
    runId: "run_planfixture01",
    handoffId: "handoff_plan_1",
    attempt: 1,
    phase: "plan",
    targetSessionId: "plan-session-1",
    inputHead: "a".repeat(40),
    currentHead: "a".repeat(40),
    phaseInput: fixture.phaseInput,
    normalizedTicket: fixture.ticket,
    configuration: fixture.configuration,
    registration: fixture.registration,
    latestAttempt: fixture.snapshot.attempts[0]!,
    readiness: fixture.ready,
    baseSha: "a".repeat(40),
    repository: { owner: "example", name: "service", baseBranch: "main", featureBranch: "squire/aidev-218/run_planfixture01" },
    ticketIdentifier: "AIDEV-218",
    validationCommandIds: ["contracts", "tests"],
    requiredValidationCommandIds: ["contracts", "tests"],
  };
}

async function writePhaseInput(fixture: Awaited<ReturnType<typeof createPlanFixture>>, document: Record<string, unknown>, name: string): Promise<{ path: string; sha256: string; schemaId: string }> {
  const relative = `artifacts/input/${name}.json`;
  const target = path.join(fixture.ticketRoot, ...relative.split("/"));
  const bytes = serializeCanonical(document);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600 });
  const { createHash } = await import("node:crypto");
  return { path: relative, sha256: createHash("sha256").update(bytes).digest("hex"), schemaId: "urn:squire:contracts:v1:phase-input" };
}

test("Plan input validator exact-reads one phase input and its ticket/configuration chain", async () => {
  const fixture = await createPlanFixture();
  try {
    const validated = await (await inputValidator(fixture.ticketRoot)).validate(fixture.phaseInput, context(fixture));
    assert.equal(validated.input.phase, "plan");
    assert.equal(validated.ticket.ticket.identifier, "AIDEV-218");
    assert.equal(validated.configuration.ticket.identifier, "AIDEV-218");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("Plan input rejects hidden duplicate authorities and ambiguous trusted aliases", async () => {
  const fixture = await createPlanFixture();
  try {
    const duplicate = structuredClone(fixture.phaseInputDocument);
    (duplicate["artifacts"] as unknown[]).push(fixture.ticket);
    const duplicateReference = await writePhaseInput(fixture, duplicate, "duplicate-phase");
    const duplicateContext = { ...context(fixture), phaseInput: duplicateReference, phaseInputReference: duplicateReference };
    await assert.rejects((await inputValidator(fixture.ticketRoot)).validate(duplicateReference, duplicateContext), PlanInputValidationError);
    const ambiguous = { ...context(fixture), planRegistration: { ...fixture.registration, sessionFile: `${fixture.registration.sessionFile}.other` } };
    await assert.rejects((await inputValidator(fixture.ticketRoot)).validate(fixture.phaseInput, ambiguous), /registration aliases are ambiguous/iu);
    await assert.rejects((await inputValidator(fixture.ticketRoot)).validate(fixture.phaseInput, { ...context(fixture), registration: { ...fixture.registration, sessionId: "other-session" } }), /session|registration/iu);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("Plan input fails closed on stale head, repository/branch substitution, and missing phase reference", async () => {
  const fixture = await createPlanFixture();
  try {
    const loader = await inputValidator(fixture.ticketRoot);
    await assert.rejects(loader.validate(fixture.phaseInput, { ...context(fixture), currentHead: "b".repeat(40) }), /stale|head/iu);
    await assert.rejects(loader.validate(fixture.phaseInput, { ...context(fixture), repository: { ...context(fixture).repository!, featureBranch: "squire/other" } }), /repository identity|feature branch/iu);
    const missing = { ...context(fixture), phaseInput: undefined, phaseInputReference: undefined, inputArtifact: undefined } as unknown as PlanAttemptContext;
    await assert.rejects(loader.validate(fixture.phaseInput, missing), /phase-input reference is missing/iu);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
