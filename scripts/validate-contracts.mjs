import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  validateImplementationPlan,
  validatePhaseInput,
  validatePhaseResult,
  validatePhaseTrigger,
  validatePullRequestDeliveryState,
  validateRevisedHandoff,
  validateTestEvidence,
  validateTransitionRequest,
  validateWorkflowConfig,
  normalizeWorkflowConfig
} from "../src/semantic-validation.mjs";

const root = path.resolve(import.meta.dirname, "..");
const schemasDir = path.join(root, "contracts/v1");
const fixturesDir = path.join(root, "fixtures/contracts");
const gitSchemasDir = path.join(root, "contracts/git-workspace/v1");
const gitFixturesDir = path.join(root, "fixtures/git-workspace/v1");

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

function nameForGitFixture(file) {
  const stem = path.basename(file, ".json");
  for (const name of ["workspace-spec", "workspace-manifest", "bundle-manifest"]) {
    if (stem === name || stem.startsWith(`${name}-`)) return name;
  }
  throw new Error(`Git workspace fixture does not identify a schema: ${file}`);
}

function gitSemanticErrors(name, data) {
  const errors = [];
  if (name === "workspace-spec") {
    if (data.featureBranch !== `squire/${data.ticketIdentifier.toLowerCase()}-${data.runId}`) errors.push("featureBranch is not deterministic");
    if (data.paths?.repository !== "/ticket/git/repo.git" || data.paths?.worktree !== "/ticket/workspace" || data.paths?.artifactRoot !== `artifacts/git/${data.runId}` || data.paths?.controlRoot !== `control/git/${data.runId}`) errors.push("workspace paths are not fixed");
  }
  if (name === "workspace-manifest") {
    if (data.featureBranch !== `squire/${data.ticketIdentifier.toLowerCase()}-${data.runId}` || data.baseSha !== data.baseSha?.toLowerCase()) errors.push("manifest identity is not bound");
    if (data.alternates !== null || data.worktreeCount !== 1 || data.worktree !== "/ticket/workspace") errors.push("manifest isolation proof is invalid");
  }
  if (name === "bundle-manifest") {
    if (data.refs?.length !== 1 || data.refs[0]?.name !== `refs/heads/${data.featureBranch}` || data.refs[0]?.oid !== data.headSha) errors.push("bundle ref inventory is invalid");
    if (data.bundlePath !== `artifacts/git/${data.runId}/${data.headSha}.bundle`) errors.push("bundle path is not head-bound");
  }
  return errors;
}

async function main() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const schemaFiles = await filesBelow(schemasDir);
  const schemas = await Promise.all(schemaFiles.map(json));
  for (const schema of schemas) ajv.addSchema(schema);
  const gitSchemaFiles = await filesBelow(gitSchemasDir);
  const gitSchemas = await Promise.all(gitSchemaFiles.map(json));
  for (const schema of gitSchemas) ajv.addSchema(schema);

  const validRoot = path.join(fixturesDir, "valid");
  const validFiles = await filesBelow(validRoot);
  for (const file of validFiles) {
    const name = contractName(file, validRoot);
    const validate = ajv.getSchema(`urn:squire:contracts:v1:${name}`);
    if (!validate) throw new Error(`No schema for ${file}`);
    const raw = await json(file);
    const document = name === "workflow-config" ? normalizeWorkflowConfig(raw) : raw;
    if (!validate(document)) throw new Error(`Valid fixture rejected: ${file}\n${ajv.errorsText(validate.errors)}`);
  }

  const structuralRoot = path.join(fixturesDir, "invalid/structural");
  const structuralFiles = await filesBelow(structuralRoot);
  for (const file of structuralFiles) {
    const name = contractName(file, structuralRoot);
    const validate = ajv.getSchema(`urn:squire:contracts:v1:${name}`);
    const raw = await json(file);
    const document = name === "workflow-config" ? normalizeWorkflowConfig(raw) : raw;
    if (validate(document)) throw new Error(`Invalid structural fixture accepted: ${file}`);
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
  const planInput = await json(path.join(validRoot, "phase-input/plan.json"));
  const planTrigger = await json(path.join(validRoot, "phase-trigger/plan.json"));
  const planResult = await json(path.join(validRoot, "phase-result/plan-pass.json"));
  const implementationPlan = await json(path.join(validRoot, "implementation-plan/basic.json"));
  const result = await json(path.join(validRoot, "phase-result/implement-pass.json"));
  const testEvidence = await json(path.join(validRoot, "test-evidence/pass.json"));
  const transition = await json(path.join(validRoot, "transition-request/review-to-test.json"));
  const delivery = await json(path.join(validRoot, "pull-request-delivery-state/ready.json"));

  const semanticChecks = [
    ["workflow config", validateWorkflowConfig(config)],
    ["phase input", validatePhaseInput(input, { runId: "run_example01", phase: "implement", targetSessionId: "session-implement-01", attempt: 1, inputHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", handoffId: "handoff_implement_1" })],
    ["Plan phase input", validatePhaseInput(planInput, { runId: "run_example01", phase: "plan", targetSessionId: "session-plan-01", attempt: 1, inputHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", handoffId: "handoff_plan_1" })],
    ["Plan trigger", validatePhaseTrigger(planTrigger, planInput, planTrigger.inputArtifact)],
    ["implementation plan", validateImplementationPlan(implementationPlan, { runId: "run_example01", ticketIdentifier: "AIDEV-215", inputHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", allowedValidationCommandIds: ["contracts", "tests"], requiredValidationCommandIds: ["contracts", "tests"] })],
    ["Plan result", validatePhaseResult(planResult, { runId: "run_example01", phase: "plan", sessionId: "session-plan-01", inputHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outputHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", handoffId: "handoff_plan_1", inputArtifact: planResult.inputArtifact })],
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

  const gitName = file => path.basename(file, ".json");
  const gitValidFiles = await filesBelow(path.join(gitFixturesDir, "valid"));
  for (const file of gitValidFiles) {
    const name = gitName(file);
    const data = await json(file);
    const validate = ajv.getSchema(`urn:squire:git-workspace:v1:${name}`);
    if (!validate || !validate(data)) throw new Error(`Valid Git workspace fixture rejected: ${file}\n${ajv.errorsText(validate?.errors)}`);
    const semanticErrors = gitSemanticErrors(name, data);
    if (semanticErrors.length) throw new Error(`Valid Git workspace semantic fixture rejected: ${file}: ${semanticErrors.join(", ")}`);
  }
  const gitStructuralFiles = await filesBelow(path.join(gitFixturesDir, "invalid/structural"));
  for (const file of gitStructuralFiles) {
    const name = nameForGitFixture(file);
    const validate = ajv.getSchema(`urn:squire:git-workspace:v1:${name}`);
    if (!validate || validate(await json(file))) throw new Error(`Invalid Git workspace structural fixture accepted: ${file}`);
  }
  const gitSemanticFiles = await filesBelow(path.join(gitFixturesDir, "invalid/semantic"));
  for (const file of gitSemanticFiles) {
    const name = nameForGitFixture(file);
    const data = await json(file);
    const validate = ajv.getSchema(`urn:squire:git-workspace:v1:${name}`);
    if (!validate || !validate(data)) throw new Error(`Git workspace semantic fixture must remain structurally valid: ${file}`);
    if (gitSemanticErrors(name, data).length === 0) throw new Error(`Git workspace semantic fixture accepted: ${file}`);
  }

  const validFixtureCount = validFiles.length + gitValidFiles.length;
  const publishedBaselineFixtureCount = validFixtureCount - 3;
  console.log(`Validated ${schemas.length + gitSchemas.length} schemas, ${validFixtureCount} valid fixtures (${publishedBaselineFixtureCount} valid fixtures in the published baseline), ${structuralFiles.length + gitStructuralFiles.length} structural rejections, and ${invalidChecks.length + gitSemanticFiles.length} semantic rejections.`);
}

main().catch(error => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
