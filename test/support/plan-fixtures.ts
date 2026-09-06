import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ContractReference, DispatchRecord, PhaseAttempt, RunSnapshot, SessionRegistration } from "../../src/control/domain.js";
import type { GitWorkspaceRecord, ReadyGitWorkspace } from "../../src/git/domain.js";
import { serializeCanonical } from "../../src/git/contracts.js";
import type { PlanPublicationContext } from "../../src/plan/domain.js";
import { run } from "./fixtures.js";

export const planHead = "a".repeat(40);
export const planRunId = "run_planfixture01";
export const planHandoffId = "handoff_plan_1";
export const planSessionId = "plan-session-1";
export const planTicketIdentifier = "AIDEV-218";
export const planFeatureBranch = "squire/aidev-218/run_planfixture01";

export interface PlanFixture {
  root: string;
  ticketRoot: string;
  workspace: string;
  phaseInput: ContractReference;
  ticket: ContractReference;
  configuration: ContractReference;
  triggerPath: string;
  triggerReference: ContractReference;
  ticketDocument: Record<string, unknown>;
  configurationDocument: Record<string, unknown>;
  phaseInputDocument: Record<string, unknown>;
  triggerDocument: Record<string, unknown>;
  registration: SessionRegistration;
  snapshot: RunSnapshot;
  ready: ReadyGitWorkspace;
  publicationContext: PlanPublicationContext;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeContract(root: string, relativePath: string, schemaId: string, document: Record<string, unknown>): Promise<ContractReference> {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const bytes = serializeCanonical(document);
  await writeFile(target, bytes, { mode: 0o600 });
  return { path: relativePath, sha256: sha256(bytes), schemaId };
}

function dispatch(handoffId: string, sessionId: string): DispatchRecord {
  return {
    operationKey: `${planRunId}:${handoffId}:${sessionId}`,
    handoffId,
    targetSessionId: sessionId,
    marker: `SQUIRE_HANDOFF_${handoffId}`,
    state: "prepared",
    generation: 0,
    cursor: null,
    recoveryPrompts: 0,
    launchCount: 0,
  };
}

export async function createPlanFixture(): Promise<PlanFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-plan-"));
  const ticketRoot = path.join(root, "ticket");
  const workspace = path.join(ticketRoot, "workspace");
  await mkdir(path.join(ticketRoot, "artifacts"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(ticketRoot, "evidence"), { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });

  const ticketDocument: Record<string, unknown> = {
    schemaVersion: 1,
    runId: planRunId,
    source: "linear",
    ticket: {
      id: "11111111-1111-4111-8111-111111111111",
      identifier: planTicketIdentifier,
      teamId: "22222222-2222-4222-8222-222222222222",
      stateId: "30000000-0000-4000-8000-000000000001",
      title: "Build the Plan phase",
      description: "Build a generic Plan phase.",
      acceptanceCriteria: ["Plan produces an actionable immutable output."],
      labels: ["architecture"],
      url: "https://linear.app/example/issue/AIDEV-218",
    },
    repository: {
      owner: "example",
      name: "service",
      baseBranch: "main",
      baseSha: planHead,
      featureBranch: planFeatureBranch,
    },
    normalizedAt: "2026-09-01T12:00:00Z",
  };
  const configurationDocument = JSON.parse(await readFile(path.resolve("fixtures/contracts/valid/workflow-config/basic.json"), "utf8")) as Record<string, unknown>;
  const configTicket = configurationDocument["ticket"] as Record<string, unknown>;
  configTicket["identifier"] = planTicketIdentifier;
  const configRepository = configurationDocument["repository"] as Record<string, unknown>;
  configRepository["owner"] = "example";
  configRepository["name"] = "service";
  configRepository["baseBranch"] = "main";
  const ticket = await writeContract(ticketRoot, "artifacts/input/ticket.json", "urn:squire:contracts:v1:normalized-ticket", ticketDocument);
  const configuration = await writeContract(ticketRoot, "artifacts/input/config.json", "urn:squire:contracts:v1:workflow-config", configurationDocument);
  const phaseInputDocument: Record<string, unknown> = {
    schemaVersion: 1,
    handoffId: planHandoffId,
    runId: planRunId,
    phase: "plan",
    targetSessionId: planSessionId,
    attempt: 1,
    inputHead: planHead,
    ticket,
    configuration,
    artifacts: [],
    feedback: [],
    createdAt: "2026-09-01T12:10:00Z",
  };
  const phaseInput = await writeContract(ticketRoot, "artifacts/input/phase-input.json", "urn:squire:contracts:v1:phase-input", phaseInputDocument);
  const triggerDocument: Record<string, unknown> = {
    schemaVersion: 1,
    handoffId: planHandoffId,
    runId: planRunId,
    phase: "plan",
    attempt: 1,
    targetSessionId: planSessionId,
    inputHead: planHead,
    inputArtifact: phaseInput,
  };
  const triggerReference = await writeContract(ticketRoot, "artifacts/handoffs/plan/1/trigger.json", "urn:squire:contracts:v1:phase-trigger", triggerDocument);
  const sessionDirectory = path.join(root, "sessions", "plan");
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionDirectory, `2026_${planSessionId}.jsonl`);
  await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: planSessionId })}\n`, { mode: 0o600 });
  const registration: SessionRegistration = { runId: planRunId, role: "plan", sessionId: planSessionId, sessionFile, processGeneration: 1, processState: "registered", registeredAt: "2026-09-01T12:11:00Z" };
  const spec: ContractReference = { path: "artifacts/git/spec.json", sha256: "1".repeat(64), schemaId: "urn:squire:contracts:v1:git-workspace-spec" };
  const manifest: ContractReference = { path: "artifacts/git/manifest.json", sha256: "2".repeat(64), schemaId: "urn:squire:contracts:v1:git-workspace-manifest" };
  const paths = { repository: "/ticket/git/repo.git" as const, worktree: "/ticket/workspace" as const, artifactRoot: "artifacts/git/run_planfixture01", controlRoot: "control/git/run_planfixture01" };
  const ready: ReadyGitWorkspace = { runId: planRunId, spec, manifest, featureBranch: planFeatureBranch, headSha: planHead, objectFormat: "sha1", paths };
  const gitWorkspace: GitWorkspaceRecord = { runId: planRunId, stage: "ready", spec, specFingerprint: "3".repeat(64), featureBranch: planFeatureBranch, paths, operationGeneration: 1, manifest, headSha: planHead, lastVerifiedAt: "2026-09-01T12:12:00Z" };
  const attempt: PhaseAttempt = { phase: "plan", attempt: 1, handoffId: planHandoffId, targetSessionId: planSessionId, inputHead: planHead, input: phaseInput, feedback: [], dispatch: dispatch(planHandoffId, planSessionId) };
  const snapshot = run({ runId: planRunId, state: "planning", currentHead: planHead, sessions: { plan: registration }, attempts: [attempt], gitWorkspace });
  const publicationContext: PlanPublicationContext = { runId: planRunId, handoffId: planHandoffId, attempt: 1, targetSessionId: planSessionId, inputHead: planHead, inputArtifact: phaseInput, ticketIdentifier: planTicketIdentifier, completedAt: "2026-09-01T12:13:00.000Z", allowedValidationCommandIds: ["contracts", "tests"], requiredValidationCommandIds: ["contracts", "tests"], ticketRoot };
  return { root, ticketRoot, workspace, phaseInput, ticket, configuration, triggerPath: "/ticket/artifacts/handoffs/plan/1/trigger.json", triggerReference, ticketDocument, configurationDocument, phaseInputDocument, triggerDocument, registration, snapshot, ready, publicationContext };
}
