import type { AttemptResultPort } from "../control/attempt-coordinator.js";
import { AttemptCoordinator } from "../control/attempt-coordinator.js";
import type { Clock, ContractReference, PhaseAttempt, Role, RunSnapshot, SessionRegistration } from "../control/domain.js";
import { createPhaseSemanticPolicy, PhaseResultAcceptanceService } from "../control/phase-result-acceptance.js";
import type { WorkflowStore } from "../control/workflow-store.js";
import type { GitWorkspaceReadiness, GitWorkspaceStatus, ReadyGitWorkspace } from "../git/domain.js";
import { normalizeRoleConfig } from "../pi/pi-configuration.js";
import { PiAttemptRuntime } from "../pi/attempt-runtime.js";
import type { LifecycleLimits } from "../control/lifecycle-policy.js";
import type { PiRunner } from "../pi/pi-runner.js";
import type { V1ArtifactValidator } from "../contracts/v1-artifact-validator.js";
import { PlanInputValidator } from "./plan-input-validator.js";
import { PlanTriggerValidator } from "./plan-trigger-validator.js";
import { PlanResultDiscovery } from "./plan-result-discovery.js";
import type { PlanAttemptContext, PlanReadinessIdentity } from "./domain.js";
import { sameContractReference } from "./domain.js";

export interface PlanWorkspacePort extends GitWorkspaceReadiness {
  /** AIDEV-222's read-only status operation. One of these must be present. */
  offlineStatus?(runId: string): Promise<GitWorkspaceStatus>;
  status?(runId: string): Promise<GitWorkspaceStatus>;
}

export interface PlanSessionDependencies {
  readonly store: WorkflowStore;
  readonly runner: PiRunner;
  readonly workspace: PlanWorkspacePort;
  readonly inputValidator: PlanInputValidator;
  readonly artifactValidator: V1ArtifactValidator;
  readonly clock: Clock;
  readonly ticketRoot?: string;
  readonly lifecycleLimits?: LifecycleLimits;
  readonly maxLaunches?: number;
  readonly leaseMs?: number;
  readonly maxRecoveryPrompts?: number;
}

export class PlanSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanSessionError";
  }
}

function fail(message: string): never {
  throw new PlanSessionError(message);
}

function exactRegistration(registration: SessionRegistration | undefined, runId: string, sessionId: string): SessionRegistration {
  if (!registration || registration.runId !== runId || registration.role !== "plan" || registration.sessionId !== sessionId || registration.sessionFile.length === 0 || !Number.isSafeInteger(registration.processGeneration) || registration.processGeneration < 1) fail("persisted Plan session registration is missing or mismatched");
  return registration;
}

function exactAttempt(run: RunSnapshot, handoffId: string): { readonly attempt: PhaseAttempt; readonly index: number } {
  const index = run.attempts.findIndex(candidate => candidate.handoffId === handoffId);
  const attempt = run.attempts[index];
  if (!attempt || attempt.phase !== "plan") fail("handoff is not a persisted Plan attempt");
  const latest = [...run.attempts].reverse().find(candidate => candidate.phase === "plan");
  if (!latest || latest.handoffId !== handoffId || latest.attempt !== attempt.attempt) fail("handoff is not the latest Plan attempt");
  return { attempt, index };
}

function assertTriggerPath(triggerPath: string, attempt: number): string {
  const expected = `/ticket/artifacts/handoffs/plan/${attempt}/trigger.json`;
  if (triggerPath !== expected) fail("Plan trigger path is not the canonical controller path");
  return expected;
}

function readinessIdentity(ready: ReadyGitWorkspace): PlanReadinessIdentity {
  return {
    runId: ready.runId,
    headSha: ready.headSha,
    featureBranch: ready.featureBranch,
    spec: ready.spec,
    manifest: ready.manifest,
    objectFormat: ready.objectFormat,
    workspace: ready.paths.worktree,
  };
}

export class PlanSessionService {
  constructor(readonly dependencies: PlanSessionDependencies) {}

  /**
   * Execute one controller-selected Plan handoff. The signature deliberately
   * has no model-provided task, head, session, or output-path arguments.
   */
  async execute(runId: string, handoffId: string, triggerPath: string, owner: string, signal?: AbortSignal): Promise<"result_accepted"> {
    const { store, runner, workspace, inputValidator, artifactValidator, clock } = this.dependencies;
    const run = await store.read(runId);
    if (!run) fail("run not found");
    if (run.state !== "planning") fail("Plan session requires planning workflow state");
    const selected = exactAttempt(run, handoffId);
    if (selected.attempt.inputHead !== run.currentHead) fail("Plan attempt input head is stale");
    const registration = exactRegistration(await store.getSession(runId, "plan"), runId, selected.attempt.targetSessionId);
    const canonicalTrigger = assertTriggerPath(triggerPath, selected.attempt.attempt);
    const firstReady = await this.#assertWorkspace(run, workspace, runId, run.currentHead);
    const firstContext: PlanAttemptContext = {
      runId,
      handoffId,
      attempt: selected.attempt.attempt,
      phase: "plan",
      targetSessionId: selected.attempt.targetSessionId,
      inputHead: selected.attempt.inputHead,
      currentHead: run.currentHead,
      phaseInput: selected.attempt.input,
      registration,
      latestAttempt: selected.attempt,
      readiness: readinessIdentity(firstReady),
    };
    await new PlanTriggerValidator(artifactValidator, this.dependencies.ticketRoot ?? "/ticket").validate(canonicalTrigger, {
      runId,
      handoffId,
      attempt: selected.attempt.attempt,
      targetSessionId: selected.attempt.targetSessionId,
      inputHead: selected.attempt.inputHead,
      inputArtifact: selected.attempt.input,
    });
    const preliminary = await inputValidator.validate(selected.attempt.input, firstContext);
    const allowedValidationCommandIds = preliminary.configuration.validation.commands.map(command => command.id);
    const requiredValidationCommandIds = preliminary.configuration.validation.commands.filter(command => command.required).map(command => command.id);
    const fullContext: PlanAttemptContext = {
      ...firstContext,
      baseSha: preliminary.ticket.repository.baseSha,
      ticketIdentifier: preliminary.ticket.ticket.identifier,
      repository: {
        owner: preliminary.ticket.repository.owner,
        name: preliminary.ticket.repository.name,
        baseBranch: preliminary.ticket.repository.baseBranch,
        featureBranch: preliminary.ticket.repository.featureBranch,
      },
      normalizedTicket: preliminary.input.ticket,
      configuration: preliminary.input.configuration,
      validationCommandIds: allowedValidationCommandIds,
      requiredValidationCommandIds,
    };
    const validated = await inputValidator.validate(selected.attempt.input, fullContext);
    if (validated.ticket.ticket.identifier !== preliminary.ticket.ticket.identifier) fail("Plan input changed during validation");
    const secondReady = await this.#assertWorkspace(run, workspace, runId, run.currentHead);
    if (!sameContractReference(secondReady.spec, firstReady.spec) || !sameContractReference(secondReady.manifest, firstReady.manifest) || secondReady.headSha !== firstReady.headSha) fail("workspace readiness identity changed before Plan launch");
    const persistedPlan = validated.configuration.pi.roles["plan"];
    if (!persistedPlan) fail("persisted workflow configuration has no Plan profile");
    this.#assertRunnerProfile(persistedPlan);
    const completedAt = new Date(clock.now()).toISOString();
    const planContext = {
      runId,
      handoffId,
      attempt: selected.attempt.attempt,
      targetSessionId: selected.attempt.targetSessionId,
      inputHead: selected.attempt.inputHead,
      inputArtifact: selected.attempt.input,
      ticketIdentifier: validated.ticket.ticket.identifier,
      completedAt,
      allowedValidationCommandIds,
      requiredValidationCommandIds,
      ...(this.dependencies.ticketRoot ? { ticketRoot: this.dependencies.ticketRoot } : {}),
    } as const;
    const acceptance = new PhaseResultAcceptanceService(
      store,
      { observeHead: async observedRunId => (await workspace.verify(observedRunId ?? runId, run.currentHead)).headSha },
      artifactValidator,
      clock,
      createPhaseSemanticPolicy([], {
        ticketIdentifier: validated.ticket.ticket.identifier,
        allowedCommandIds: allowedValidationCommandIds,
        requiredCommandIds: requiredValidationCommandIds,
      }),
      async fence => {
        const current = await store.read(fence.runId);
        if (!current || current.currentHead !== fence.expectedHead || current.state !== "planning") fail("workflow changed during Plan result acceptance");
        await this.#assertWorkspace(current, workspace, fence.runId, fence.expectedHead);
        await this.#assertWorkspace(current, workspace, fence.runId, fence.expectedHead);
      },
    );
    const results: AttemptResultPort = {
      discover: attempt => this.#discover(attempt),
      accept: async (acceptedRunId, acceptedHandoffId, reference, lease) => { await acceptance.accept(acceptedRunId, acceptedHandoffId, reference, lease); },
    };
    const runtime = new PiAttemptRuntime(runner, clock, this.dependencies.lifecycleLimits, planContext);
    const coordinator = new AttemptCoordinator(store, runtime, results, clock, this.dependencies.maxLaunches, this.dependencies.leaseMs, this.dependencies.maxRecoveryPrompts);
    return coordinator.execute({ runId, handoffId, triggerPath: canonicalTrigger, owner, ...(signal ? { signal } : {}) });
  }

  run(runId: string, handoffId: string, triggerPath: string, owner: string, signal?: AbortSignal): Promise<"result_accepted"> {
    return this.execute(runId, handoffId, triggerPath, owner, signal);
  }

  async #discover(attempt: PhaseAttempt): Promise<ContractReference | undefined> {
    return new PlanResultDiscovery(this.dependencies.ticketRoot ?? "/ticket").discover(attempt.attempt);
  }

  async #assertWorkspace(run: RunSnapshot, workspace: PlanWorkspacePort, runId: string, expectedHead: string): Promise<ReadyGitWorkspace> {
    if (!run.gitWorkspace || run.gitWorkspace.stage !== "ready") fail("AIDEV-222 workspace is not durably ready");
    const ready = await workspace.verify(runId, expectedHead);
    if (ready.runId !== runId || ready.headSha !== expectedHead || ready.featureBranch !== run.gitWorkspace.featureBranch || !sameContractReference(ready.spec, run.gitWorkspace.spec) || !sameContractReference(ready.manifest, run.gitWorkspace.manifest)) fail("AIDEV-222 workspace readiness identity mismatch");
    const status = workspace.offlineStatus ? await workspace.offlineStatus(runId) : workspace.status ? await workspace.status(runId) : undefined;
    if (!status || status.runId !== runId || status.headSha !== expectedHead || status.porcelain !== "") fail("Plan requires a clean offline workspace status");
    return ready;
  }

  #assertRunnerProfile(persisted: { readonly provider: string; readonly model: string; readonly thinking: string; readonly instructionsPath: string; readonly timeoutSeconds: number }): void {
    const configured = normalizeRoleConfig("plan", this.dependencies.runner.config.roles.plan);
    if (configured.provider !== persisted.provider || configured.model !== persisted.model || configured.thinking !== persisted.thinking || configured.instructionsPath !== persisted.instructionsPath || configured.timeoutSeconds !== persisted.timeoutSeconds) fail("runner Plan profile does not match persisted workflow configuration");
  }
}
