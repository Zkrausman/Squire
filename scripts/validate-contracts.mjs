import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  validatePhaseInput,
  validatePhaseResult,
  validatePhaseTrigger,
  validatePullRequestDeliveryState,
  validateRevisedHandoff,
  validateTestEvidence,
  validateTransitionRequest,
  validateWorkflowConfig
} from "../src/semantic-validation.mjs";

const root = path.resolve(import.meta.dirname, "..");
const schemasDir = path.join(root, "contracts/v1");
const fixturesDir = path.join(root, "fixtures/contracts");

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }));
  return nested.flat().filter(file => file.endsWith(".json"));
}

function contractName(file, base) {
  return path.relative(base, file).split(path.sep)[0];
}

async function main() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schemaFiles = await filesBelow(schemasDir);
  const schemas = await Promise.all(schemaFiles.map(json));
  for (const schema of schemas) ajv.addSchema(schema);

  const validRoot = path.join(fixturesDir, "valid");
  const validFiles = await filesBelow(validRoot);
  for (const file of validFiles) {
    const name = contractName(file, validRoot);
    const validate = ajv.getSchema(`urn:squire:contracts:v1:${name}`);
    if (!validate) throw new Error(`No schema for ${file}`);
    if (!validate(await json(file))) throw new Error(`Valid fixture rejected: ${file}\n${ajv.errorsText(validate.errors)}`);
  }

  const structuralRoot = path.join(fixturesDir, "invalid/structural");
  const structuralFiles = await filesBelow(structuralRoot);
  for (const file of structuralFiles) {
    const name = contractName(file, structuralRoot);
    const validate = ajv.getSchema(`urn:squire:contracts:v1:${name}`);
    if (validate(await json(file))) throw new Error(`Invalid structural fixture accepted: ${file}`);
  }

  const semanticRoot = path.join(fixturesDir, "invalid/semantic");
  const semanticFiles = await filesBelow(semanticRoot);
  for (const file of semanticFiles) {
    const name = contractName(file, semanticRoot);
    const validate = ajv.getSchema(`urn:squire:contracts:v1:${name}`);
    if (!validate(await json(file))) throw new Error(`Semantic fixture must be structurally valid: ${file}\n${ajv.errorsText(validate.errors)}`);
  }

  const config = await json(path.join(validRoot, "workflow-config/basic.json"));
  const inputFile = path.join(validRoot, "phase-input/implement.json");
  const inputBytes = await readFile(inputFile);
  const input = JSON.parse(inputBytes);
  const trigger = await json(path.join(validRoot, "phase-trigger/implement.json"));
  const inputArtifact = {
    path: "artifacts/handoffs/implement-1.json",
    sha256: createHash("sha256").update(inputBytes).digest("hex"),
    schemaId: "urn:squire:contracts:v1:phase-input"
  };
  const result = await json(path.join(validRoot, "phase-result/implement-pass.json"));
  const testEvidence = await json(path.join(validRoot, "test-evidence/pass.json"));
  const transition = await json(path.join(validRoot, "transition-request/review-to-test.json"));
  const delivery = await json(path.join(validRoot, "pull-request-delivery-state/ready.json"));

  const semanticChecks = [
    ["workflow config", validateWorkflowConfig(config)],
    ["phase input", validatePhaseInput(input, { runId: "run_example01", phase: "implement", targetSessionId: "session-implement-01", attempt: 1, inputHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", handoffId: "handoff_implement_1" })],
    ["phase trigger", validatePhaseTrigger(trigger, input, inputArtifact)],
    ["phase result", validatePhaseResult(result, { runId: "run_example01", phase: "implement", sessionId: "session-implement-01", inputHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outputHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", handoffId: "handoff_implement_1", inputArtifact })],
    ["test evidence", validateTestEvidence(testEvidence, config, { runId: "run_example01", sessionId: "session-test-01", headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })],
    ["transition", validateTransitionRequest(transition, { runId: "run_example01", orchestratorSessionId: "session-orchestrator-01", currentState: "reviewing", currentHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", phaseResult: transition.phaseResult })],
    ["delivery", validatePullRequestDeliveryState(delivery, config, { runId: "run_example01", headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", repository: "example/service", baseBranch: "main", featureBranch: "squire/aidev-215/run_example01", pullRequestNumber: 42, pullRequestUrl: "https://github.com/example/service/pull/42" })]
  ];
  for (const [label, errors] of semanticChecks) if (errors.length) throw new Error(`Valid ${label} rejected: ${errors.join("; ")}`);

  const invalidChecks = [
    ["phase-input/remediation-without-feedback.json", data => validatePhaseInput(data)],
    ["phase-trigger/digest-mismatch.json", data => validatePhaseTrigger(data, input, inputArtifact)],
    ["phase-result/wrong-identities.json", data => validatePhaseResult(data, { runId: "run_example01", phase: "implement", sessionId: "session-implement-01", inputHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outputHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", handoffId: "handoff_implement_1", inputArtifact })],
    ["phase-result/stale-sha.json", data => validatePhaseResult(data, { runId: "run_example01", phase: "review", sessionId: "session-review-01", inputHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", outputHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", handoffId: "handoff_review_1", inputArtifact: data.inputArtifact })],
    ["phase-result/contradictory-pass.json", data => validatePhaseResult(data, { runId: "run_example01", phase: "review", sessionId: "session-review-01", inputHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", outputHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", handoffId: "handoff_review_1", inputArtifact: data.inputArtifact })],
    ["phase-input/revision-identity-substitution.json", data => validateRevisedHandoff(input, data, { previousArtifact: inputArtifact, revisedArtifact: { path: "artifacts/handoffs/implement-2.json", sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", schemaId: "urn:squire:contracts:v1:phase-input" } })],
    ["test-evidence/missing-required-command.json", data => validateTestEvidence(data, config, { runId: "run_example01", sessionId: "session-test-01", headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })],
    ["transition-request/illegal-transition.json", data => validateTransitionRequest(data, { runId: "run_example01", orchestratorSessionId: "session-orchestrator-01", currentState: "planning", currentHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", phaseResult: data.phaseResult })],
    ["transition-request/result-substitution.json", data => validateTransitionRequest(data, { runId: "run_example01", orchestratorSessionId: "session-orchestrator-01", currentState: "reviewing", currentHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", phaseResult: transition.phaseResult })],
    ["pull-request-delivery-state/stale-approval.json", data => validatePullRequestDeliveryState(data, config, { runId: "run_example01", headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", repository: "example/service", baseBranch: "main", featureBranch: "squire/aidev-215/run_example01", pullRequestNumber: 42, pullRequestUrl: "https://github.com/example/service/pull/42" })],
    ["pull-request-delivery-state/wrong-target.json", data => validatePullRequestDeliveryState(data, config, { runId: "run_example01", headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", repository: "example/service", baseBranch: "main", featureBranch: "squire/aidev-215/run_example01", pullRequestNumber: 42, pullRequestUrl: "https://github.com/example/service/pull/42" })]
  ];
  for (const [relative, check] of invalidChecks) {
    const data = await json(path.join(semanticRoot, relative));
    if (check(data).length === 0) throw new Error(`Invalid semantic fixture accepted: ${relative}`);
  }

  console.log(`Validated ${schemas.length} schemas, ${validFiles.length} valid fixtures, ${structuralFiles.length} structural rejections, and ${invalidChecks.length} semantic rejections.`);
}

main().catch(error => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
