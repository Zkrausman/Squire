import { requireStagedSlot, reservation } from "./staged-attempts.js";
import { classifyExecutionFailure, PhaseExecutionError } from "./execution-failure.js";
import { validateEscalationPolicy, escalationDigest, type EscalationPolicy } from "./model-policy.js";
import { validatePlanProgress } from "./plan-artifacts.js";
import { validateExecutablePlan } from "./prompt-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { canonical, composeSystemPrompt, launchEvidence, persistLaunchMaterial, readLaunchMaterial, validateLaunchMaterial, type LaunchMaterial, type LaunchEvidence } from "./launch-material.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  NodeBackgroundLauncher,
  type BackgroundLaunchRequest,
  type BackgroundLauncher,
} from "./background-launcher.js";
import { deterministicFeatureBranch, validateSourceRef } from "./identity.js";
import {
  APPROVED_PERSONAL_MODEL_POLICY,
  resolvePhaseProfiles,
  validateModelPolicy,
  type PersonalModelPolicy,
  type PhaseProfile,
} from "./model-policy.js";
import { validatePhaseResultShape, validateProjectWikiDisposition, validateProjectWikiPaths } from "./phase-result.js";
import type {
  PersonalPhase,
  PersonalRunState,
  PhaseInput,
  PhaseResult,
  ImplementPhaseResult,
  PublicationPort,
  RunExecutionMode,
  RunRequest,
  RunStatePort,
  Ticket,
  TicketPort,
  WorkspacePort,
  PhasePort,
  RemediationAttemptEvidence,
} from "./types.js";

interface RunContext {
  state: PersonalRunState;
  persist: (changes: Partial<PersonalRunState>) => Promise<void>;
  bindSource: (sourceSha: string) => Promise<void>;
  claimReserved: (changes: Partial<PersonalRunState>) => Promise<void>;
  failReserved: (changes: Partial<PersonalRunState>) => Promise<void>;
}

export interface PersonalRunMetadata {
  readonly executionMode?: RunExecutionMode;
  readonly stdoutPath?: string | null;
  readonly stderrPath?: string | null;
  readonly controllerPid?: number | null;
  readonly launchConfigPath?: string;
  readonly launchConfigDigest?: string;
  readonly launchEvidence?: LaunchEvidence;
}

export interface PersonalMvpControllerOptions {
  readonly launchMaterial?: LaunchMaterial;
  readonly tickets: TicketPort;
  readonly workspaces: WorkspacePort;
  readonly phases: PhasePort;
  readonly publication: PublicationPort;
  readonly states: RunStatePort;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Controller-level policy used unless a request supplies one. */
  readonly modelPolicy?: PersonalModelPolicy;
  readonly escalationPolicy?: EscalationPolicy;
  /** Optional process identity for persisted foreground/background evidence. */
  readonly controllerPid?: number;
  /** Receives persistence failures that cannot be represented in run state. */
  readonly onPersistenceError?: (error: unknown) => void;
}

export interface ReserveRunOptions extends PersonalRunMetadata {
  readonly runId?: string;
}

export interface BackgroundLogPaths {
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface StartBackgroundOptions {
  readonly launcher?: BackgroundLauncher;
  /** Absolute path to the installed Squire CLI entry point. */
  readonly cliPath: string;
  /** Absolute path to the selected JSON config. */
  readonly configPath: string;
  /** Node executable; defaults to the current absolute process.execPath. */
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Optional state directory propagated for child bootstrap-error recording. */
  readonly stateDirectory?: string;
  readonly logsDirectory?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly launchConfigDigest: string;
  readonly signal?: AbortSignal;
}

export interface StartedBackgroundRun {
  readonly runId: string;
  readonly pid: number | undefined;
  readonly state: PersonalRunState;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

/**
 * The small trusted controller for the personal single-ticket workflow.
 * Reservation and execution are intentionally separate so a detached parent
 * can durably record a run before it contacts Linear or starts Docker.
 */
export class PersonalMvpController {
  readonly #material: LaunchMaterial | undefined;
  readonly #tickets: TicketPort;
  readonly #workspaces: WorkspacePort;
  readonly #phases: PhasePort;
  readonly #publication: PublicationPort;
  readonly #states: RunStatePort;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #modelPolicy: PersonalModelPolicy;
  readonly #escalationPolicy: EscalationPolicy | undefined;
  readonly #controllerPid: number | undefined;
  readonly #onPersistenceError: (error: unknown) => void;
  readonly #contexts = new Map<string, RunContext>();
  readonly #reservedClaims = new Set<string>();

  constructor(options: PersonalMvpControllerOptions) {
    this.#material = options.launchMaterial === undefined ? undefined : validateLaunchMaterial(options.launchMaterial);
    if (this.#material) validateExecutablePlan(this.#material.config.promptPolicy!.plan);
    const staged = this.#material?.config.escalationPolicy ?? options.escalationPolicy;
    this.#escalationPolicy = staged === undefined ? undefined : validateEscalationPolicy(staged);
    this.#tickets = options.tickets;
    this.#workspaces = options.workspaces;
    this.#phases = options.phases;
    this.#publication = options.publication;
    this.#states = options.states;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#controllerPid = options.controllerPid;
    this.#onPersistenceError = options.onPersistenceError ?? (() => undefined);
    this.#modelPolicy = validateModelPolicy(options.modelPolicy ?? APPROVED_PERSONAL_MODEL_POLICY);
  }

  /**
   * Reserve a run before any remote lookup or workspace operation. The JSON
   * store implements this as an exclusive per-ticket filesystem reservation;
   * older in-memory ports use their existing create/findActive surface.
   */
  async reserve(request: RunRequest, options: ReserveRunOptions = {}): Promise<PersonalRunState> {
    validateRequest(request);
    const executionMode = options.executionMode ?? "foreground";
    const resolved = resolvePhaseProfiles(
      request.repository,
      request.ticketId,
      request.modelPolicy ?? this.#modelPolicy,
    );
    const staged = request.escalationPolicy ?? this.#escalationPolicy;
    const escalationPolicy = staged === undefined ? undefined : validateEscalationPolicy(staged);
    if (this.#material && canonical(escalationPolicy) !== canonical(this.#material.config.escalationPolicy)) throw new Error("request escalation policy differs from launch capture");
    const identity = createRunIdentity(request, options.runId ?? this.#newId(), options.runId);
    const startedAt = this.#timestamp();
    const baseline = initialState(identity.runId, identity.sandbox, identity.branch, request, resolved.profiles, resolved.planSelection, startedAt, {
      executionMode,
      ...(options.stdoutPath !== undefined ? { stdoutPath: options.stdoutPath } : {}),
      ...(options.stderrPath !== undefined ? { stderrPath: options.stderrPath } : {}),
      controllerPid: options.controllerPid ?? (executionMode === "foreground" ? this.#controllerPid ?? null : null),
      ...(options.launchConfigPath !== undefined ? { launchConfigPath: options.launchConfigPath } : {}),
      ...(options.launchConfigDigest !== undefined ? { launchConfigDigest: options.launchConfigDigest } : {}),
      ...(this.#material ? { launchEvidence: launchEvidence(this.#material), launchConfigDigest: createHash("sha256").update(Buffer.from(this.#material.rawConfig, "base64")).digest("hex") } : {}),
    });

    const state: PersonalRunState = { ...baseline, ...(escalationPolicy ? { escalationPolicy, escalationDigest: escalationDigest(escalationPolicy), stagedTransitions: [] } : {}) };
    if (this.#states.reserve) {
      if (!this.#states.release) throw new Error("reservation-capable state store must provide release");
      await this.#states.reserve(state);
    } else {
      // This compatibility branch cannot close a cross-process race, but it
      // preserves the original embeddable RunStatePort contract. Production
      // CLI state always uses JsonRunStateStore.reserve above.
      if (await this.#states.findActive(request.ticketId)) throw new Error(`ticket already has an active run: ${request.ticketId}`);
      await this.#states.create(state);
    }
    const context = this.#context(state);
    this.#contexts.set(state.runId, context);
    return state;
  }

  async run(request: RunRequest, signal?: AbortSignal): Promise<PersonalRunState> {
    const reserved = await this.reserve(request, { executionMode: "foreground" });
    const context = this.#contexts.get(reserved.runId)!;
    return this.#executeReserved(context, request, signal);
  }

  /**
   * Execute one already-reserved identity. The detached child uses this path;
   * it never creates a second run or reselects the Plan model bucket.
   */
  async runReserved(request: RunRequest, runId: string, launchConfigDigest: string, signal?: AbortSignal, launchConfigPath?: string): Promise<PersonalRunState> {
    validateRequest(request);
    const boundConfigPath = launchConfigPath === undefined ? undefined : absolutePath(launchConfigPath, "config path");
    if (this.#reservedClaims.has(runId)) throw new Error(`reserved run is already being claimed: ${runId}`);
    this.#reservedClaims.add(runId);
    try {
      // Always claim persisted state. Cached state can belong to the reserving
      // parent invocation and is not authority to enter detached execution.
      const loaded = await this.#readState(runId);
      if (!loaded) throw new Error(`reserved run state not found: ${runId}`);
      if (
        loaded.ticketId !== request.ticketId
        || loaded.repository !== request.repository
        || loaded.repositoryPath !== request.repositoryPath
        || loaded.sourceRef !== request.sourceRef
        || loaded.baseBranch !== request.baseBranch
        || loaded.launchConfigDigest !== launchConfigDigest
        || (boundConfigPath !== undefined && loaded.launchConfigPath !== boundConfigPath)
      ) throw new Error("reserved run configuration identity mismatch");
      const captured = await readLaunchMaterial(loaded, resolveBackgroundStateDirectory(this.#states, undefined));
      if (!this.#material || canonical(captured) !== canonical(this.#material)) throw new Error("reserved execution requires matching captured launch material");
      if (loaded.executionMode !== "background") throw new Error("reserved child execution requires a background run");
      if (loaded.status !== "running" || loaded.launchState !== "reserved" || loaded.controllerPid !== null || loaded.lifecycle !== "launching" || loaded.step !== "launching" || loaded.preparationState !== "pending") {
        throw new Error(`run is not in the exact reserved launch state: ${runId}`);
      }
      // A signal received while the child was still loading its immutable
      // bootstrap inputs must not turn into a claimed workflow. The CLI's
      // fallback terminalizer can still see the untouched reservation.
      if (signal?.aborted) throw startupAbortReason(signal);

      const context = this.#context(loaded);
      // This serialized CAS is the ownership claim. A conflict is terminal
      // for this invocation; it must never reload another child's started
      // state or invoke an adapter.
      await context.claimReserved({
        launchState: "started",
        controllerPid: process.pid,
        lifecycle: "preparing",
        step: "preparing",
        preparationState: "started",
      });
      this.#contexts.set(runId, context);
      if (signal?.aborted) {
        const reason = startupAbortReason(signal);
        await this.#recordTerminal(context, reason, true);
        this.#contexts.delete(runId);
        throw reason;
      }
      return await this.#executeReserved(context, request, signal);
    } finally {
      this.#reservedClaims.delete(runId);
    }
  }

  /** Persist a synchronous/pre-spawn failure for a reserved run. */
  async failReserved(runId: string, error: unknown, interrupted = false): Promise<PersonalRunState | undefined> {
    const context = await this.#contextForRun(runId).catch(() => undefined);
    if (!context) return undefined;
    // Parent-side launch diagnostics may arrive after a child has already
    // advanced the state. Refresh before deciding whether this call still
    // owns the launch boundary; never release a live child's reservation from
    // a stale cached context.
    const latest = await this.#readState(runId).catch(() => undefined);
    if (latest && latest.version >= context.state.version) context.state = latest;
    if (context.state.status !== "running") return context.state;
    if (context.state.executionMode === "background" && !isReservedLaunch(context.state)) return context.state;
    await this.#recordTerminal(context, error, interrupted);
    return context.state;
  }

  /**
   * Reserve and detach the installed CLI. The returned promise ends after the
   * local spawn confirmation, not after Linear, Docker, Pi, or publication.
   */
  async startBackground(request: RunRequest, options: StartBackgroundOptions): Promise<StartedBackgroundRun> {
    validateRequest(request);
    if (!this.#material) throw new Error("background execution requires captured launch material");
    const launcher = options.launcher ?? new NodeBackgroundLauncher();
    const cliPath = absolutePath(options.cliPath, "CLI path");
    const configPath = absolutePath(options.configPath, "config path");
    const launchCwd = absolutePath(options.cwd ?? process.cwd(), "launch cwd");
    // Do not discard an already-aborted startup before reservation. Once the
    // selected config and state root are known, an interrupted invocation must
    // still publish a visible terminal launch record.
    const reservedId = this.#previewRunId(request);
    // The child must always receive the exact state root used by this
    // controller. Falling back to the config path would make a bootstrap
    // failure unrecordable when an embedder uses a separate state store.
    const stateDirectory = resolveBackgroundStateDirectory(this.#states, options.stateDirectory);
    // An explicitly supplied environment is the caller's immutable launch
    // snapshot. Do not merge ambient variables into it later: a variable such
    // as SQUIRE_DATA_DIR appearing during reservation/source binding must not
    // redirect the detached child to a different runtime-data root.
    const launchEnvironment: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
    const defaultLogs = backgroundLogPaths(options.logsDirectory ?? stateDirectory, reservedId);
    const stdoutPath = options.stdoutPath !== undefined ? absolutePath(options.stdoutPath, "stdout log path") : defaultLogs.stdoutPath;
    const stderrPath = options.stderrPath !== undefined ? absolutePath(options.stderrPath, "stderr log path") : defaultLogs.stderrPath;
    // Re-resolve destinations at the launch boundary. This catches ordinary
    // configuration/injection mistakes and symlink retargeting that happened
    // before this check; it is not a continuous ancestor-integrity guarantee.
    await assertBackgroundDestinationsOutsideRepository(request.repositoryPath, [stateDirectory, stdoutPath, stderrPath]);
    assertBackgroundStateStoreMatches(this.#states, stateDirectory);
    launchEnvironment["SQUIRE_STATE_DIRECTORY"] = stateDirectory;

    if (!/^[a-f0-9]{64}$/u.test(options.launchConfigDigest)) throw new Error("launch config digest is invalid");
    if (createHash("sha256").update(Buffer.from(this.#material.rawConfig, "base64")).digest("hex") !== options.launchConfigDigest) throw new Error("launch config digest does not match captured material");
    let state = await this.reserve(request, {
      runId: reservedId,
      executionMode: "background",
      stdoutPath,
      stderrPath,
      controllerPid: null,
      launchConfigPath: configPath,
      launchConfigDigest: options.launchConfigDigest,
    });
    try {
      if (options.signal?.aborted) throw startupAbortReason(options.signal);
      // A mutable branch or tag must not be resolved for the first time by a
      // detached child. Bind the commit while the reservation is still
      // unclaimed, then make preparation verify that the ref still names it.
      // This is optional for small embedded WorkspacePorts; the production
      // Docker adapter implements it.
      if (this.#workspaces.resolveSource) {
        const sourceSha = await this.#workspaces.resolveSource({ repositoryPath: request.repositoryPath, sourceRef: request.sourceRef }, options.signal);
        const context = this.#contexts.get(state.runId) ?? this.#context(state);
        await context.bindSource(sourceSha);
        state = context.state;
      }
      if (options.signal?.aborted) throw startupAbortReason(options.signal);
      await persistLaunchMaterial(this.#material, state, stateDirectory);
      const launchRequest: BackgroundLaunchRequest = {
        executable: options.executable ?? process.execPath,
        args: [cliPath, "run", request.ticketId, "--config", configPath, "--reserved-run-id", state.runId, "--reserved-config-sha256", options.launchConfigDigest],
        cwd: launchCwd,
        // Capture the launch environment now. In particular, a relative or
        // default data-directory resolution must not change between reservation
        // and the detached child's bootstrap.
        env: launchEnvironment,
        stdoutPath,
        stderrPath,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        // Once spawn is confirmed, the detached child is the only lifecycle
        // writer.
        onError: error => this.#reportPersistenceError(error),
      };

      // Recheck immediately before delegating to an injected launcher as well
      // as inside NodeBackgroundLauncher. This closes the ordinary
      // pre-handoff window for launchers that do not perform their own check.
      if (options.signal?.aborted) throw startupAbortReason(options.signal);
      const launched = await launcher.launch(launchRequest);
      // Do not write state after spawn: the detached child exclusively owns all
      // post-handoff lifecycle updates, avoiding parent/child stale writers.
      return { runId: state.runId, pid: launched.pid, state, stdoutPath, stderrPath };
    } catch (error) {
      // No spawn confirmation means this parent still owns source/bootstrap/
      // launch failure recording and may safely close the reservation. If a
      // child already claimed it, failReserved observes that ownership and
      // deliberately leaves the live child's reservation alone.
      await this.failReserved(state.runId, error, options.signal?.aborted === true).catch(persistenceError => this.#reportPersistenceError(persistenceError));
      throw error;
    }
  }

  async #executeReserved(context: RunContext, request: RunRequest, signal?: AbortSignal): Promise<PersonalRunState> {
    try {
      const ticket = await this.#tickets.get(request.ticketId, signal);
      if (ticket.id !== request.ticketId) throw new Error("Linear returned a different ticket");
      await context.persist({
        ticketTitle: ticket.title,
        step: "preparing",
        lifecycle: "preparing",
        preparationState: "started",
        ...(context.state.launchState === "reserved" ? { launchState: "started" } : {}),
      });

      const workspace = await this.#workspaces.prepare({
        runId: context.state.runId,
        ticketId: ticket.id,
        sandbox: context.state.sandbox,
        branch: context.state.branch,
        repositoryPath: request.repositoryPath,
        sourceRef: request.sourceRef,
        ...(context.state.sourceSha !== undefined ? { expectedBaseSha: context.state.sourceSha } : {}),
      }, signal);
      if (workspace.head !== workspace.baseSha) throw new Error("prepared workspace did not start at the base SHA");
      await context.persist({ baseSha: workspace.baseSha, head: workspace.head, preparationState: "ready", lifecycle: "running" });

      await this.#executePhase(context, ticket, request, "plan", [], signal);
      await this.#executePhase(context, ticket, request, "implement", [], signal);
      await this.#ensureReview(context, ticket, request, signal);
      await this.#ensureTest(context, ticket, request, signal);
      await this.#ensureRetro(context, ticket, request, signal);

      const completeResults = requirePassingResults(context.state);
      const head = requireHead(context.state);
      await context.persist({ step: "publishing", lifecycle: "publishing" });
      const bundle = await this.#workspaces.exportBundle({ runId: context.state.runId, sandbox: context.state.sandbox, branch: context.state.branch, baseSha: requireBase(context.state), head }, signal);
      if (bundle.baseSha !== context.state.baseSha || bundle.head !== head || bundle.branch !== context.state.branch) throw new Error("candidate bundle identity mismatch");
      const published = await this.#publication.publish({
        runId: context.state.runId,
        ticket,
        repository: request.repository,
        baseBranch: request.baseBranch,
        branch: context.state.branch,
        head,
        bundle,
        phases: completeResults,
      }, signal);
      if (!/^https:\/\/[^\s]+$/u.test(published.url)) throw new Error("publisher returned an invalid PR URL");
      await context.persist({ step: "complete", status: "completed", lifecycle: "completed", endedAt: this.#timestamp(), prUrl: published.url, lastError: null });
      await this.#releaseReservation(context);
      this.#contexts.delete(context.state.runId);
      return context.state;
    } catch (error) {
      await this.#recordTerminal(context, error, signal?.aborted === true || classifyExecutionFailure(error) === "cancelled");
      this.#contexts.delete(context.state.runId);
      throw error;
    }
  }

  async #ensureReview(context: RunContext, ticket: Ticket, request: RunRequest, signal?: AbortSignal): Promise<void> {
    let result = await this.#executePhase(context, ticket, request, "review", [], signal);
    if (result.status === "remediation_required") {
      if (context.state.remediations.review >= 1) throw new Error("Review remediation budget exhausted");
      for (const phase of ["implement", "review"] as const) requireStagedSlot(context.state, phase, "remediation_required");
      await context.persist({
        remediations: { ...context.state.remediations, review: context.state.remediations.review + 1 },
        remediationAttempts: appendRemediationAttempt(context.state, "review", result.attempt),
      });
      await this.#executePhase(context, ticket, request, "implement", feedback(result), signal);
      result = await this.#executePhase(context, ticket, request, "review", [], signal);
    }
    if (result.status !== "passed") throw new Error(`Review did not pass: ${result.summary}`);
  }

  async #ensureTest(context: RunContext, ticket: Ticket, request: RunRequest, signal?: AbortSignal): Promise<void> {
    let result = await this.#executePhase(context, ticket, request, "test", [], signal);
    if (result.status === "remediation_required") {
      if (context.state.remediations.test >= 1) throw new Error("Test remediation budget exhausted");
      for (const phase of ["implement", "review", "test"] as const) requireStagedSlot(context.state, phase, "remediation_required");
      await context.persist({
        remediations: { ...context.state.remediations, test: context.state.remediations.test + 1 },
        remediationAttempts: appendRemediationAttempt(context.state, "test", result.attempt),
      });
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

  async #executePhase(context: RunContext, ticket: Ticket, request: RunRequest, phase: PersonalPhase, phaseFeedback: readonly string[], signal?: AbortSignal): Promise<PhaseResult> {
    if (!context.state.escalationPolicy?.[phase]) return this.#executePhaseOnce(context, ticket, request, phase, phaseFeedback, signal);
    let nextFeedback = phaseFeedback.slice(0, 20).map(item => item.slice(0, 2000));
    let trigger = phaseFeedback.length ? "remediation_required" : "initial";
    for (;;) {
      signal?.throwIfAborted();
      const slot = requireStagedSlot(context.state, phase, trigger)!;
      // No attempt is charged for controller-owned preflight failures.
      if (signal?.aborted) throw signal.reason;
      await this.#workspaces.assertClean(context.state.sandbox, signal);
      if (await this.#workspaces.currentHead(context.state.sandbox, signal) !== requireHead(context.state)) throw new Error(`${phase} started at an unexpected Git HEAD`);
      signal?.throwIfAborted();
      const reserved = reservation(context.state, slot);
      await context.persist({ step: phase, planProgress: null, lifecycle: "running", attempts: { ...context.state.attempts, [phase]: slot.attempt }, stagedTransitions: [...context.state.stagedTransitions!, reserved] });
      let result: PhaseResult;
      try {
        result = await this.#executePhaseOnce(context, ticket, request, phase, nextFeedback, signal, slot.profile);
      } catch (error) {
        const classification = classifyExecutionFailure(error, signal);
        await context.persist({ stagedTransitions: [...context.state.stagedTransitions!, { ...slot, kind: "closed", reason: "execution_failure", classification }] });
        throw error;
      }
      const classification = result.status === "failed" ? (result.phase === "plan" && result.details.supervision?.outcome === "needs_clarification" ? "needs_clarification" : "eligible_failure") : result.status;
      await context.persist({ stagedTransitions: [...context.state.stagedTransitions!, { ...slot, kind: "closed", reason: "result", classification, result }] });
      if (classification === "needs_clarification") throw new Error(`Plan needs clarification: ${result.summary}`);
      if (classification !== "eligible_failure") return result;
      nextFeedback = feedback(result).slice(0, 20).map(item => item.slice(0, 2000));
      trigger = classification;
    }
  }

  async #executePhaseOnce(
    context: RunContext,
    ticket: Ticket,
    request: RunRequest,
    phase: PersonalPhase,
    phaseFeedback: readonly string[],
    signal?: AbortSignal,
    stagedProfile?: PhaseProfile,
  ): Promise<PhaseResult> {
    const expectedHead = requireHead(context.state);
    const attempt = context.state.attempts[phase] + (stagedProfile ? 0 : 1);
    if (!stagedProfile) await context.persist({ step: phase, planProgress: null, lifecycle: "running", attempts: { ...context.state.attempts, [phase]: attempt } });
    const expectedProfile = Object.freeze({ ...(stagedProfile ?? resolvedProfile(context.state, phase)) });
    const input: PhaseInput = Object.freeze({
      runId: context.state.runId,
      ticket: Object.freeze({ ...ticket }),
      repository: request.repository,
      baseBranch: request.baseBranch,
      sandbox: context.state.sandbox,
      branch: context.state.branch,
      phase,
      attempt,
      expectedHead,
      originalTicketBaseSha: requireBase(context.state),
      previousCumulative: cumulativePreviousResults(context.state),
      profile: expectedProfile,
      ...(stagedProfile ? { escalationDigest: context.state.escalationDigest! } : {}),
      // A phase adapter is untrusted with respect to controller state. Give it
      // detached, immutable inputs so a retained reference cannot mutate the
      // resolved policy or prior evidence between persistence boundaries.
      previous: structuredClone(context.state.results),
      feedback: Object.freeze([...phaseFeedback]),
    });
    if (!stagedProfile && phase !== "implement") {
      await this.#workspaces.assertClean(context.state.sandbox, signal);
      const startingHead = await this.#workspaces.currentHead(context.state.sandbox, signal);
      if (startingHead !== expectedHead) throw new Error(`${phase} started at an unexpected Git HEAD`);
    }
    let result: PhaseResult | undefined;
    let phaseFailed = false;
    let phaseError: unknown;
    let acceptingProgress = true;
    let progressWrites = Promise.resolve();
    let progressCount = 0;
    try {
      result = await this.#phases.run(input, signal, progress => {
        validatePlanProgress(progress);
        const snapshot = structuredClone(progress);
        if (!acceptingProgress || phase !== "plan" || context.state.planExecution !== "supervised-v1" || snapshot.runId !== input.runId || snapshot.attempt !== attempt || snapshot.subphase !== ["requirements", "implementation-design"][progressCount]) return Promise.reject(new Error("stale or unordered Plan progress"));
        progressCount++;
        progressWrites = progressWrites.then(async () => {
          if (context.state.status !== "running" || context.state.step !== "plan" || context.state.attempts.plan !== attempt) throw new Error("late Plan progress");
          await context.persist({ planProgress: snapshot });
        });
        return progressWrites;
      });
    } catch (error) {
      phaseFailed = true;
      phaseError = error;
    } finally {
      acceptingProgress = false;
      try { await progressWrites; } catch (error) { phaseFailed = true; phaseError = error; }
    }
    let observedHead: string | undefined;
    let workspaceFailed = false;
    let workspaceDiagnostic: unknown;
    try {
      observedHead = await this.#workspaces.currentHead(context.state.sandbox, signal);
      await this.#workspaces.assertClean(context.state.sandbox, signal);
    } catch (error) {
      workspaceFailed = true;
      workspaceDiagnostic = error;
    }
    if (stagedProfile && signal?.aborted) throw new PhaseExecutionError("cancelled", "phase interrupted", { cause: signal.reason });
    if (phaseFailed) {
      if (workspaceFailed) throw withSecondaryWorkspaceDiagnostic(phaseError, workspaceDiagnostic);
      throw phaseError;
    }
    if (workspaceFailed) throw workspaceDiagnostic;
    if (observedHead === undefined) throw new Error(`${phase} did not produce an observed Git HEAD`);
    if (!result) throw new PhaseExecutionError("protocol", `${phase} returned no result`);
    let evidencedResult: PhaseResult;
    try {
      evidencedResult = result.profile === undefined
        ? { ...structuredClone(result), profile: { ...expectedProfile } }
        : structuredClone(result);
      validatePhaseResult(evidencedResult, input, observedHead);
      if (stagedProfile && (!result.profile || (Object.values(context.state.sessions).includes(evidencedResult.sessionId) || context.state.stagedTransitions?.some(t => t.result?.sessionId === evidencedResult.sessionId)))) throw new Error("staged result missing profile or reused session");
      if (phase !== "implement" && observedHead !== expectedHead) throw new Error(`${phase} changed Git HEAD`);
      if (phase === "plan" && context.state.launchEvidence?.planSubphases.length) {
        if (evidencedResult.phase !== "plan" || !evidencedResult.details.supervision || evidencedResult.details.supervision.launchDigest !== context.state.launchEvidence.digest) throw new Error("supervised Plan evidence required");
        for (const child of evidencedResult.details.supervision.children) {
          if (!this.#material || child.promptDigest !== createHash("sha256").update(composeSystemPrompt(this.#material, "plan", child.subphase)).digest("hex")) throw new Error("supervised Plan prompt binding mismatch");
        }
        if (evidencedResult.details.supervision.children.length > progressCount) throw new Error("supervised Plan progress evidence missing");
      }
    } catch (error) {
      throw new PhaseExecutionError("protocol", error instanceof Error ? error.message : String(error), { cause: error });
    }
    if (!stagedProfile && evidencedResult.status === "failed") {
      if (evidencedResult.phase === "plan" && evidencedResult.details.supervision) await context.persist({ results: { ...context.state.results, plan: evidencedResult }, sessions: { ...context.state.sessions, plan: evidencedResult.sessionId } });
      throw new Error(`${phase} failed: ${evidencedResult.summary}`);
    }
    if (phase === "implement" && evidencedResult.status !== "passed" && !(stagedProfile && evidencedResult.status === "failed")) throw new Error("Implement must return passed or failed");
    if (phase !== "implement" && observedHead !== expectedHead) throw new Error(`${phase} changed Git HEAD`);
    if (phase === "implement") await this.#reconcileProjectWikiDisposition(context, evidencedResult as ImplementPhaseResult, observedHead, signal);
    await context.persist({
      head: observedHead,
      sessions: { ...context.state.sessions, [phase]: evidencedResult.sessionId },
      results: { ...context.state.results, [phase]: evidencedResult },
    });
    return evidencedResult;
  }

  async #reconcileProjectWikiDisposition(context: RunContext, result: ImplementPhaseResult, head: string, signal?: AbortSignal): Promise<void> {
    const diff = this.#workspaces.committedProjectWikiPaths ?? this.#workspaces.projectWikiDiff;
    if (!diff) throw new Error("workspace cannot provide a committed project-wiki diff");
    const baseSha = requireBase(context.state);
    const reported = result.details.projectWiki;
    validateProjectWikiDisposition(reported);
    const observed = await diff.call(this.#workspaces, { sandbox: context.state.sandbox, baseSha, head }, signal);
    if (!Array.isArray(observed) || observed.length > 1_000) throw new Error("workspace returned an invalid project-wiki diff");
    const changedPaths = observed.length === 0 ? [] : [...validateProjectWikiPaths(observed, "workspace project-wiki diff")].sort();
    if (reported.status === "updated") {
      const reportedPaths = [...reported.paths].sort();
      if (!sameProjectWikiPathSet(reportedPaths, changedPaths)) throw new Error("project-wiki disposition does not match committed diff");
    } else if (changedPaths.length > 0) {
      throw new Error("project-wiki not_required disposition contradicts committed diff");
    }
  }

  #context(state: PersonalRunState): RunContext {
    const context = {} as RunContext;
    context.state = state;
    const nextState = (changes: Partial<PersonalRunState>, updatedAt = this.#timestamp()): PersonalRunState => ({
      ...context.state,
      ...changes,
      version: context.state.version + 1,
      updatedAt,
    });
    context.persist = async changes => {
      const next = nextState(changes);
      await this.#states.save(next);
      context.state = next;
    };
    context.bindSource = async sourceSha => {
      if (!/^[a-f0-9]{40,64}$/u.test(sourceSha)) throw new Error("resolved source SHA is invalid");
      const next = nextState({ sourceSha }, this.#timestampAtOrAfter(context.state.updatedAt));
      if (this.#states.bindSource) {
        await this.#states.bindSource(next);
      } else {
        if (this.#states.reservationOwner && await this.#states.reservationOwner(context.state.ticketId) !== context.state.runId) {
          throw new Error(`reserved run reservation ownership mismatch: ${context.state.runId}`);
        }
        await this.#states.save(next);
      }
      context.state = next;
    };
    context.claimReserved = async changes => {
      const next = nextState(changes, this.#timestampAtOrAfter(context.state.updatedAt));
      if (this.#states.claimReserved) {
        await this.#states.claimReserved(next);
      } else {
        // Older embedders do not expose the serialized claim primitive. Keep
        // their original contract, but perform the ownership check again
        // immediately before the compatibility save.
        if (this.#states.reservationOwner && await this.#states.reservationOwner(context.state.ticketId) !== context.state.runId) {
          throw new Error(`reserved run reservation ownership mismatch: ${context.state.runId}`);
        }
        await this.#states.save(next);
      }
      context.state = next;
    };
    context.failReserved = async changes => {
      const endedAt = this.#timestampAtOrAfter(context.state.updatedAt, ...(typeof changes.endedAt === "string" ? [changes.endedAt] : []));
      const next = nextState({ ...changes, endedAt }, this.#timestampAtOrAfter(endedAt));
      if (this.#states.failReserved) {
        await this.#states.failReserved(next);
      } else {
        if (this.#states.reservationOwner && await this.#states.reservationOwner(context.state.ticketId) !== context.state.runId) {
          throw new Error(`reserved run reservation ownership mismatch: ${context.state.runId}`);
        }
        await this.#states.save(next);
      }
      context.state = next;
    };
    return context;
  }

  async #contextForRun(runId: string): Promise<RunContext> {
    const cached = this.#contexts.get(runId);
    if (cached) return cached;
    const state = await this.#readState(runId);
    if (!state) throw new Error(`run state not found: ${runId}`);
    const context = this.#context(state);
    this.#contexts.set(runId, context);
    return context;
  }

  async #readState(runId: string): Promise<PersonalRunState | undefined> {
    if (!this.#states.read) return undefined;
    return this.#states.read(runId);
  }

  async #releaseReservation(context: RunContext): Promise<void> {
    if (!this.#states.release) return;
    let failure: string | undefined;
    try {
      // The production JSON port performs owner check and unlink under one
      // ticket-operation boundary. Do not perform a second lookup here: a
      // legitimate replacement could acquire the ticket immediately after
      // that boundary and would be misdiagnosed as our failed cleanup.
      await this.#states.release(context.state.ticketId, context.state.runId);
    } catch (error) {
      failure = `reservation release blocked or unverified: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (failure === undefined) return;
    try {
      // Preserve the original terminal lastError and write a distinct,
      // actionable cleanup outcome. The state CAS prevents this diagnostic
      // from overwriting a newer owner or revision.
      await context.persist({ reservationCleanupFailure: failure.slice(0, 2_000) });
    } catch (diagnosticError) {
      this.#reportPersistenceError(diagnosticError);
      this.#reportPersistenceError(new Error(failure));
    }
  }

  async #recordTerminal(context: RunContext, error: unknown, interrupted: boolean): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    const status = interrupted ? "interrupted" : "failed";
    const changes: Partial<PersonalRunState> = {
      status,
      lifecycle: status,
      endedAt: this.#timestamp(),
      lastError: message || (interrupted ? "operator interrupted the run" : "run failed"),
      ...(context.state.launchState === "reserved" ? { launchState: "failed" } : {}),
      ...(context.state.preparationState === "pending" ? { preparationState: "failed" } : {}),
    };
    let terminalPersisted = context.state.status !== "running";
    const unclaimedBackground = context.state.executionMode === "background" && isReservedLaunch(context.state);
    try {
      if (context.state.status === "running") {
        // The JSON store combines this terminal write with the exact-owner
        // release under the ticket boundary. A pre-handoff failure must not
        // race a detached child claiming the same reservation.
        await (unclaimedBackground ? context.failReserved(changes) : context.persist(changes));
        terminalPersisted = true;
      }
    } catch (persistenceError) {
      // A port may commit the replacement and reject while publishing a
      // notification. Reconcile only the exact expected terminal revision;
      // never treat a newer owner/revision as our successful write.
      const observed = await this.#readState(context.state.runId).catch(() => undefined);
      if (observed && observed.version === context.state.version + 1 && observed.status === status && observed.lastError === changes.lastError && observed.endedAt === changes.endedAt) {
        context.state = observed;
        terminalPersisted = true;
      }
      this.#reportPersistenceError(persistenceError);
    }
    if (terminalPersisted) await this.#releaseReservation(context);
  }

  #reportPersistenceError(error: unknown): void {
    try { this.#onPersistenceError(error); } catch { /* reporting must not mask the original failure */ }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #timestampAtOrAfter(...minimums: readonly string[]): string {
    let latest = this.#timestamp();
    for (const minimum of minimums) {
      if (Date.parse(minimum) > Date.parse(latest)) latest = minimum;
    }
    return latest;
  }

  #previewRunId(request: RunRequest): string {
    return createRunIdentity(request, this.#newId()).runId;
  }
}

function initialState(
  runId: string,
  sandbox: string,
  branch: string,
  request: RunRequest,
  profiles: NonNullable<PersonalRunState["profiles"]>,
  planSelection: NonNullable<PersonalRunState["planSelection"]>,
  startedAt: string,
  metadata: Required<Pick<PersonalRunMetadata, "executionMode" | "controllerPid">> & Pick<PersonalRunMetadata, "stdoutPath" | "stderrPath" | "launchConfigPath" | "launchConfigDigest" | "launchEvidence">,
): PersonalRunState {
  const background = metadata.executionMode === "background";
  return {
    schemaVersion: 1,
    version: 1,
    runId,
    ticketId: request.ticketId,
    // The ticket may not have been fetched yet. The identifier is a truthful
    // placeholder and is replaced with the remote title after lookup.
    ticketTitle: request.ticketId,
    status: "running",
    step: background ? "launching" : "preparing",
    lifecycle: background ? "launching" : "preparing",
    launchState: background ? "reserved" : "started",
    preparationState: "pending",
    executionMode: metadata.executionMode,
    startedAt,
    endedAt: null,
    controllerPid: metadata.controllerPid,
    stdoutPath: metadata.stdoutPath ?? null,
    stderrPath: metadata.stderrPath ?? null,
    repositoryPath: request.repositoryPath,
    sourceRef: request.sourceRef,
    ...(metadata.launchConfigPath !== undefined ? { launchConfigPath: metadata.launchConfigPath } : {}),
    ...(metadata.launchConfigDigest !== undefined ? { launchConfigDigest: metadata.launchConfigDigest } : {}),
    ...(metadata.launchEvidence !== undefined ? { launchEvidence: metadata.launchEvidence } : {}),
    ...(metadata.launchEvidence?.planSubphases.length ? { planExecution: "supervised-v1" as const } : {}),
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
    remediationAttempts: { review: [], test: [] },
    prUrl: null,
    lastError: null,
    updatedAt: startedAt,
  };
}

function createRunIdentity(request: RunRequest, suppliedId: string, explicitRunId?: string): { readonly runId: string; readonly sandbox: string; readonly branch: string } {
  let runId: string;
  if (explicitRunId !== undefined) {
    const prefix = `${request.ticketId.toLowerCase()}-`;
    if (!explicitRunId.startsWith(prefix)) throw new Error("reserved run ID does not belong to the ticket");
    const suffix = explicitRunId.slice(prefix.length);
    if (!/^[a-z0-9][a-z0-9-]{7,127}$/u.test(suffix) || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(explicitRunId)) throw new Error("reserved run ID is invalid");
    runId = explicitRunId;
  } else {
    const suffix = suppliedId.replaceAll("-", "").slice(0, 10).toLowerCase();
    if (!/^[a-z0-9]{8,}$/u.test(suffix)) throw new Error("run ID generator returned an invalid value");
    runId = `${request.ticketId.toLowerCase()}-${suffix}`;
  }
  return { runId, sandbox: `squire-${runId}`, branch: deterministicFeatureBranch(request.repository, request.ticketId) };
}

function validateRequest(request: RunRequest): void {
  if (!/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(request.ticketId)) throw new Error("invalid Linear ticket identifier");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository)) throw new Error("repository must be owner/name");
  if (!request.repositoryPath || !/^[A-Za-z0-9._/-]+$/u.test(request.baseBranch)) throw new Error("invalid repository configuration");
  validateSourceRef(request.sourceRef, "repository source ref");
}

function validatePhaseResult(result: PhaseResult, input: PhaseInput, observedHead: string): void {
  validatePhaseResultShape(result, input.phase);
  if (result.runId !== input.runId || result.phase !== input.phase || result.attempt !== input.attempt) throw new Error("phase result identity mismatch");
  if (result.sessionFile !== `/ticket/sessions/${input.phase}/${input.attempt}.jsonl`) throw new Error("phase result session file mismatch");
  if (result.inputHead !== input.expectedHead) throw new Error("phase result input HEAD mismatch");
  if (result.outputHead !== observedHead) throw new Error("phase result output HEAD mismatch");
  if (!result.profile || result.profile.provider !== input.profile.provider || result.profile.model !== input.profile.model || result.profile.thinking !== input.profile.thinking) throw new Error("phase result profile identity mismatch");
}

function appendRemediationAttempt(state: PersonalRunState, phase: "review" | "test", attempt: number): RemediationAttemptEvidence {
  const current = state.remediationAttempts ?? { review: [], test: [] };
  const prior = current[phase];
  if (!Number.isSafeInteger(attempt) || attempt < 1 || prior.some(entry => entry === attempt) || (prior.length > 0 && attempt <= prior[prior.length - 1]!)) {
    throw new Error(`invalid ${phase} remediation attempt evidence`);
  }
  return { ...current, [phase]: [...prior, attempt] };
}

function withSecondaryWorkspaceDiagnostic(primary: unknown, secondary: unknown): Error {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const secondaryMessage = secondary instanceof Error ? secondary.message : String(secondary);
  const error = new PhaseExecutionError(classifyExecutionFailure(primary), `${primaryMessage}; secondary workspace diagnostic: ${secondaryMessage}`, { cause: primary });
  return error;
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

function sameProjectWikiPathSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Preserve every prior output, rather than only the latest result per phase. */
function cumulativePreviousResults(state: PersonalRunState): readonly PhaseResult[] {
  const results: PhaseResult[] = [];
  const seen = new Set<string>();
  for (const result of [
    ...Object.values(state.results),
    ...(state.stagedTransitions ?? []).map(transition => transition.result),
  ]) {
    if (!result || seen.has(result.sessionId)) continue;
    seen.add(result.sessionId);
    results.push(structuredClone(result));
  }
  return Object.freeze(results);
}

function resolvedProfile(state: PersonalRunState, phase: PersonalPhase): PhaseProfile {
  const profile = state.profiles?.[phase];
  if (!profile) throw new Error(`run has no resolved ${phase} Pi profile`);
  return profile;
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

export function backgroundLogPaths(logsDirectory: string, runId: string): BackgroundLogPaths {
  if (!logsDirectory || logsDirectory.includes("\0") || !path.isAbsolute(logsDirectory)) throw new Error("background logs directory must be absolute");
  if (!/^[a-z0-9][a-z0-9-]{7,127}$/u.test(runId)) throw new Error("invalid run id");
  const root = path.resolve(logsDirectory);
  return {
    stdoutPath: path.join(root, `${runId}.stdout.log`),
    stderrPath: path.join(root, `${runId}.stderr.log`),
  };
}

async function assertBackgroundDestinationsOutsideRepository(repositoryPath: string, destinations: readonly string[]): Promise<void> {
  const repositoryReal = await realPathForSafety(repositoryPath);
  for (const destination of destinations) {
    const destinationReal = await realPathForSafety(destination);
    if (isWithinPath(repositoryReal, destinationReal)) throw new Error(`background destination must be outside the repository: ${destination}`);
  }
}

async function realPathForSafety(value: string): Promise<string> {
  const absolute = path.resolve(value);
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return path.resolve(existing, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isWithinPath(parent: string, child: string): boolean {
  const comparableParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const comparableChild = process.platform === "win32" ? child.toLowerCase() : child;
  const relative = path.relative(comparableParent, comparableChild);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function absolutePath(value: string, label: string): string {
  if (!value || value.includes("\0")) throw new Error(`${label} is invalid`);
  return path.resolve(value);
}

function resolveBackgroundStateDirectory(states: RunStatePort, explicit: string | undefined): string {
  const storeDirectory = (states as RunStatePort & { readonly directory?: unknown }).directory;
  const selected = explicit !== undefined
    ? absolutePath(explicit, "state directory")
    : typeof storeDirectory === "string"
      ? absolutePath(storeDirectory, "state directory")
      : undefined;
  if (selected === undefined) throw new Error("background state directory is required for child bootstrap recovery");
  return selected;
}

function assertBackgroundStateStoreMatches(states: RunStatePort, selected: string): void {
  const storeDirectory = (states as RunStatePort & { readonly directory?: unknown }).directory;
  if (typeof storeDirectory === "string" && path.resolve(storeDirectory) !== selected) {
    throw new Error("background state directory does not match the controller state store");
  }
}

function isReservedLaunch(state: PersonalRunState): boolean {
  return state.status === "running"
    && state.executionMode === "background"
    && state.launchState === "reserved"
    && state.controllerPid === null
    && state.lifecycle === "launching"
    && state.step === "launching"
    && state.preparationState === "pending";
}

function startupAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("operator interrupted background startup");
}

// Keep this import type referenced in generated declarations without exposing a
// second launcher implementation from the controller module.
export type { BackgroundLaunchRequest, BackgroundLauncher } from "./background-launcher.js";
