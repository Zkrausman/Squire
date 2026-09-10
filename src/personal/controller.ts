import { randomUUID } from "node:crypto";
import { deterministicFeatureBranch } from "./identity.js";
import {
  APPROVED_PERSONAL_MODEL_POLICY,
  resolvePhaseProfiles,
  validateModelPolicy,
  type PersonalModelPolicy,
  type PhaseProfile,
} from "./model-policy.js";
import { validatePhaseResultShape } from "./phase-result.js";
import type {
  PersonalPhase,
  PersonalRunState,
  PhaseInput,
  PhaseResult,
  PublicationPort,
  RunRequest,
  RunStatePort,
  Ticket,
  TicketPort,
  WorkspacePort,
  PhasePort,
} from "./types.js";

interface RunContext {
  state: PersonalRunState;
  readonly persist: (changes: Partial<PersonalRunState>) => Promise<void>;
}

export interface PersonalMvpControllerOptions {
  readonly tickets: TicketPort;
  readonly workspaces: WorkspacePort;
  readonly phases: PhasePort;
  readonly publication: PublicationPort;
  readonly states: RunStatePort;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Controller-level policy used unless a request supplies one. */
  readonly modelPolicy?: PersonalModelPolicy;
  /** Backward-compatible flat profile map for older embedders. */
  readonly profiles?: Readonly<Record<PersonalPhase, PhaseProfile>>;
}

export class PersonalMvpController {
  readonly #tickets: TicketPort;
  readonly #workspaces: WorkspacePort;
  readonly #phases: PhasePort;
  readonly #publication: PublicationPort;
  readonly #states: RunStatePort;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #modelPolicy: PersonalModelPolicy;

  constructor(options: PersonalMvpControllerOptions) {
    this.#tickets = options.tickets;
    this.#workspaces = options.workspaces;
    this.#phases = options.phases;
    this.#publication = options.publication;
    this.#states = options.states;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#modelPolicy = validateModelPolicy(options.modelPolicy ?? flatProfilesPolicy(options.profiles) ?? APPROVED_PERSONAL_MODEL_POLICY);
  }

  async run(request: RunRequest, signal?: AbortSignal): Promise<PersonalRunState> {
    validateRequest(request);
    if (await this.#states.findActive(request.ticketId)) throw new Error(`ticket already has an active run: ${request.ticketId}`);
    const ticket = await this.#tickets.get(request.ticketId, signal);
    if (ticket.id !== request.ticketId) throw new Error("Linear returned a different ticket");

    // Resolve the complete policy before workspace preparation. The returned
    // selection is the only Plan decision made for this run and is persisted
    // with the initial state, so retries/remediation never reselect it.
    const resolved = resolvePhaseProfiles(
      request.repository,
      ticket.id,
      request.modelPolicy ?? (request.profiles ? flatProfilesPolicy(request.profiles) : this.#modelPolicy),
    );
    const suffix = this.#newId().replaceAll("-", "").slice(0, 10).toLowerCase();
    const runId = `${request.ticketId.toLowerCase()}-${suffix}`;
    const sandbox = `squire-${request.ticketId.toLowerCase()}-${suffix}`;
    const branch = deterministicFeatureBranch(request.repository, request.ticketId);
    const context: RunContext = {
      state: initialState(runId, sandbox, branch, ticket, request, resolved.profiles, resolved.planSelection, this.#timestamp()),
      persist: async changes => {
        context.state = { ...context.state, ...changes, version: context.state.version + 1, updatedAt: this.#timestamp() };
        await this.#states.save(context.state);
      },
    };
    await this.#states.create(context.state);

    try {
      const workspace = await this.#workspaces.prepare({
        runId,
        ticketId: ticket.id,
        sandbox,
        branch,
        repositoryPath: request.repositoryPath,
        sourceRef: request.sourceRef,
      }, signal);
      if (workspace.head !== workspace.baseSha) throw new Error("prepared workspace did not start at the base SHA");
      await context.persist({ baseSha: workspace.baseSha, head: workspace.head });

      await this.#executePhase(context, ticket, request, "plan", [], signal);
      await this.#executePhase(context, ticket, request, "implement", [], signal);
      await this.#ensureReview(context, ticket, request, signal);
      await this.#ensureTest(context, ticket, request, signal);
      await this.#ensureRetro(context, ticket, request, signal);

      const completeResults = requirePassingResults(context.state);
      const head = requireHead(context.state);
      await context.persist({ step: "publishing" });
      const bundle = await this.#workspaces.exportBundle({ runId, sandbox, branch, baseSha: requireBase(context.state), head }, signal);
      if (bundle.baseSha !== context.state.baseSha || bundle.head !== head || bundle.branch !== branch) throw new Error("candidate bundle identity mismatch");
      const published = await this.#publication.publish({
        runId,
        ticket,
        repository: request.repository,
        baseBranch: request.baseBranch,
        branch,
        head,
        bundle,
        phases: completeResults,
      }, signal);
      if (!/^https:\/\/[^\s]+$/u.test(published.url)) throw new Error("publisher returned an invalid PR URL");
      await context.persist({ step: "complete", status: "completed", prUrl: published.url, lastError: null });
      return context.state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await context.persist({ status: signal?.aborted ? "interrupted" : "failed", lastError: message.slice(0, 2_000) }).catch(() => undefined);
      throw error;
    }
  }

  async #ensureReview(context: RunContext, ticket: Ticket, request: RunRequest, signal?: AbortSignal): Promise<void> {
    let result = await this.#executePhase(context, ticket, request, "review", [], signal);
    if (result.status === "remediation_required") {
      if (context.state.remediations.review >= 1) throw new Error("Review remediation budget exhausted");
      await context.persist({ remediations: { ...context.state.remediations, review: context.state.remediations.review + 1 } });
      await this.#executePhase(context, ticket, request, "implement", feedback(result), signal);
      result = await this.#executePhase(context, ticket, request, "review", [], signal);
    }
    if (result.status !== "passed") throw new Error(`Review did not pass: ${result.summary}`);
  }

  async #ensureTest(context: RunContext, ticket: Ticket, request: RunRequest, signal?: AbortSignal): Promise<void> {
    let result = await this.#executePhase(context, ticket, request, "test", [], signal);
    if (result.status === "remediation_required") {
      if (context.state.remediations.test >= 1) throw new Error("Test remediation budget exhausted");
      await context.persist({ remediations: { ...context.state.remediations, test: context.state.remediations.test + 1 } });
      await this.#executePhase(context, ticket, request, "implement", feedback(result), signal);
      await this.#ensureReview(context, ticket, request, signal);
      result = await this.#executePhase(context, ticket, request, "test", [], signal);
    }
    if (result.status !== "passed") throw new Error(`Test did not pass: ${result.summary}`);
  }

  async #ensureRetro(context: RunContext, ticket: Ticket, request: RunRequest, signal?: AbortSignal): Promise<void> {
    const test = context.state.results.test;
    const head = requireHead(context.state);
    if (!test || test.status !== "passed" || test.inputHead !== head || test.outputHead !== head) throw new Error("Retro requires a fresh passing Test at the current HEAD");
    const result = await this.#executePhase(context, ticket, request, "retro", [], signal);
    if (result.status !== "passed") throw new Error(`Retro did not pass: ${result.summary}`);
  }

  async #executePhase(
    context: RunContext,
    ticket: Ticket,
    request: RunRequest,
    phase: PersonalPhase,
    phaseFeedback: readonly string[],
    signal?: AbortSignal,
  ): Promise<PhaseResult> {
    const expectedHead = requireHead(context.state);
    const attempt = context.state.attempts[phase] + 1;
    await context.persist({ step: phase, attempts: { ...context.state.attempts, [phase]: attempt } });
    const input: PhaseInput = {
      runId: context.state.runId,
      ticket,
      repository: request.repository,
      baseBranch: request.baseBranch,
      sandbox: context.state.sandbox,
      branch: context.state.branch,
      phase,
      attempt,
      expectedHead,
      profile: resolvedProfile(context.state, phase),
      previous: context.state.results,
      feedback: phaseFeedback,
    };
    if (phase !== "implement") {
      await this.#workspaces.assertClean(context.state.sandbox, signal);
      const startingHead = await this.#workspaces.currentHead(context.state.sandbox, signal);
      if (startingHead !== expectedHead) throw new Error(`${phase} started at an unexpected Git HEAD`);
    }
    let result: PhaseResult | undefined;
    let phaseError: unknown;
    try {
      result = await this.#phases.run(input, signal);
    } catch (error) {
      phaseError = error;
    }
    const observedHead = await this.#workspaces.currentHead(context.state.sandbox, signal);
    await this.#workspaces.assertClean(context.state.sandbox, signal);
    if (phaseError !== undefined) throw phaseError;
    if (!result) throw new Error(`${phase} returned no result`);
    // A port may omit the additive evidence field, but an explicitly supplied
    // value must be validated rather than treated as missing. This prevents a
    // malformed profile from being silently replaced by the controller.
    const evidencedResult: PhaseResult = result.profile === undefined ? { ...result, profile: input.profile } : result;
    validatePhaseResult(evidencedResult, input, observedHead);
    if (evidencedResult.status === "failed") throw new Error(`${phase} failed: ${evidencedResult.summary}`);
    if (phase === "implement" && evidencedResult.status !== "passed") throw new Error("Implement must return passed or failed");
    if (phase !== "implement" && observedHead !== expectedHead) throw new Error(`${phase} changed Git HEAD`);
    await context.persist({
      head: observedHead,
      sessions: { ...context.state.sessions, [phase]: evidencedResult.sessionId },
      results: { ...context.state.results, [phase]: evidencedResult },
    });
    return evidencedResult;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function initialState(runId: string, sandbox: string, branch: string, ticket: Ticket, request: RunRequest, profiles: NonNullable<PersonalRunState["profiles"]>, planSelection: NonNullable<PersonalRunState["planSelection"]>, updatedAt: string): PersonalRunState {
  return {
    schemaVersion: 1,
    version: 1,
    runId,
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    status: "running",
    step: "preparing",
    sandbox,
    repository: request.repository,
    baseBranch: request.baseBranch,
    baseSha: null,
    branch,
    profiles,
    planSelection,
    head: null,
    sessions: {},
    attempts: { plan: 0, implement: 0, review: 0, test: 0, retro: 0 },
    results: {},
    remediations: { review: 0, test: 0 },
    prUrl: null,
    lastError: null,
    updatedAt,
  };
}

function validateRequest(request: RunRequest): void {
  if (!/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(request.ticketId)) throw new Error("invalid Linear ticket identifier");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository)) throw new Error("repository must be owner/name");
  if (!request.repositoryPath || !request.sourceRef || !/^[A-Za-z0-9._/-]+$/u.test(request.baseBranch)) throw new Error("invalid repository configuration");
}

function validatePhaseResult(result: PhaseResult, input: PhaseInput, observedHead: string): void {
  validatePhaseResultShape(result, input.phase);
  if (result.runId !== input.runId || result.phase !== input.phase || result.attempt !== input.attempt) throw new Error("phase result identity mismatch");
  if (result.inputHead !== input.expectedHead) throw new Error("phase result input HEAD mismatch");
  if (result.outputHead !== observedHead) throw new Error("phase result output HEAD mismatch");
  if (!result.profile || result.profile.provider !== input.profile.provider || result.profile.model !== input.profile.model || result.profile.thinking !== input.profile.thinking) throw new Error("phase result profile identity mismatch");
}

function feedback(result: PhaseResult): readonly string[] {
  if (result.phase === "review") return result.details.findings.length ? result.details.findings : [result.summary];
  if (result.phase === "test") {
    const failed = result.details.commands.filter(command => command.exitCode !== 0).map(command => `${command.command}: ${command.summary}`);
    return failed.length ? failed : [result.summary];
  }
  return [result.summary];
}

function requireHead(state: PersonalRunState): string {
  if (!state.head) throw new Error("run has no current Git HEAD");
  return state.head;
}

function requireBase(state: PersonalRunState): string {
  if (!state.baseSha) throw new Error("run has no base Git SHA");
  return state.baseSha;
}

function resolvedProfile(state: PersonalRunState, phase: PersonalPhase): PhaseProfile {
  const profile = state.profiles?.[phase];
  if (!profile) throw new Error(`run has no resolved ${phase} Pi profile`);
  return profile;
}

function flatProfilesPolicy(profiles: Readonly<Record<PersonalPhase, PhaseProfile>> | undefined): PersonalModelPolicy | undefined {
  if (!profiles) return undefined;
  return {
    plan: [profiles.plan, profiles.plan],
    implement: profiles.implement,
    review: profiles.review,
    test: profiles.test,
    retro: profiles.retro,
  };
}

function requirePassingResults(state: PersonalRunState): Readonly<Record<PersonalPhase, PhaseResult>> {
  const plan = state.results.plan;
  const implement = state.results.implement;
  const review = state.results.review;
  const test = state.results.test;
  const retro = state.results.retro;
  const head = requireHead(state);
  if (!plan || !implement || !review || !test || !retro) throw new Error("all phase results are required before publication");
  if ([plan, implement, review, test, retro].some(result => result.status !== "passed")) throw new Error("all phases must pass before publication");
  if (review.inputHead !== head || review.outputHead !== head || test.inputHead !== head || test.outputHead !== head || retro.inputHead !== head || retro.outputHead !== head) throw new Error("Review, Test, and Retro are stale for the publication HEAD");
  return { plan, implement, review, test, retro };
}
