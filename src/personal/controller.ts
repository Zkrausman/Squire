import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  NodeBackgroundLauncher,
  type BackgroundLaunchRequest,
  type BackgroundLauncher,
} from "./background-launcher.js";
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
  RunExecutionMode,
  RunRequest,
  RunStatePort,
  Ticket,
  TicketPort,
  WorkspacePort,
  PhasePort,
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
  readonly #tickets: TicketPort;
  readonly #workspaces: WorkspacePort;
  readonly #phases: PhasePort;
  readonly #publication: PublicationPort;
  readonly #states: RunStatePort;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #modelPolicy: PersonalModelPolicy;
  readonly #controllerPid: number | undefined;
  readonly #onPersistenceError: (error: unknown) => void;
  readonly #contexts = new Map<string, RunContext>();
  readonly #reservedClaims = new Set<string>();

  constructor(options: PersonalMvpControllerOptions) {
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
    const identity = createRunIdentity(request, options.runId ?? this.#newId(), options.runId);
    const startedAt = this.#timestamp();
    const state = initialState(identity.runId, identity.sandbox, identity.branch, request, resolved.profiles, resolved.planSelection, startedAt, {
      executionMode,
      ...(options.stdoutPath !== undefined ? { stdoutPath: options.stdoutPath } : {}),
      ...(options.stderrPath !== undefined ? { stderrPath: options.stderrPath } : {}),
      controllerPid: options.controllerPid ?? (executionMode === "foreground" ? this.#controllerPid ?? null : null),
      ...(options.launchConfigPath !== undefined ? { launchConfigPath: options.launchConfigPath } : {}),
      ...(options.launchConfigDigest !== undefined ? { launchConfigDigest: options.launchConfigDigest } : {}),
    });

    if (this.#states.reserve) {
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
        || (loaded.launchConfigPath !== undefined && boundConfigPath !== undefined && loaded.launchConfigPath !== boundConfigPath)
      ) throw new Error("reserved run configuration identity mismatch");
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
      await this.#recordTerminal(context, error, signal?.aborted === true);
      this.#contexts.delete(context.state.runId);
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
    await context.persist({ step: phase, lifecycle: "running", attempts: { ...context.state.attempts, [phase]: attempt } });
    const expectedProfile = Object.freeze({ ...resolvedProfile(context.state, phase) });
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
      profile: expectedProfile,
      // A phase adapter is untrusted with respect to controller state. Give it
      // detached, immutable inputs so a retained reference cannot mutate the
      // resolved policy or prior evidence between persistence boundaries.
      previous: structuredClone(context.state.results),
      feedback: Object.freeze([...phaseFeedback]),
    });
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
    const evidencedResult: PhaseResult = result.profile === undefined
      ? { ...structuredClone(result), profile: { ...expectedProfile } }
      : structuredClone(result);
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
    try {
      await this.#states.release(context.state.ticketId, context.state.runId);
    } catch (error) {
      this.#reportPersistenceError(error);
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
      // Never hide a launch/workflow error merely because a second failure
      // prevented durable publication. The caller/log hook can surface it.
      // In particular, do not release a lock after a CAS race with a live
      // child; that would permit a second same-ticket run.
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
  metadata: Required<Pick<PersonalRunMetadata, "executionMode" | "controllerPid">> & Pick<PersonalRunMetadata, "stdoutPath" | "stderrPath" | "launchConfigPath" | "launchConfigDigest">,
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
  if (!logsDirectory || logsDirectory.includes("\0")) throw new Error("background logs directory is invalid");
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
