import { InvalidPhaseHandoff, ReportExecutionFailure } from "./report-capture.js";
import { validateCorrectionPolicy, eligibleCorrection, feedbackDigest, type CorrectionCycle, type CorrectionPolicy } from "./correction.js";
import { decimalUnits } from "./telemetry-stream.js";
import { setTimeout as retryDelay } from "node:timers/promises";
import { classifyLaunchFailure, generationIdentity, launchInputDigest, validateLaunchRetryPolicy, LAUNCH_BACKOFF_MS, LAUNCH_CLASSIFIER, type LaunchRetryPolicy, type LaunchRecord } from "./launch-retry.js";
import { parsePhaseResult } from "./phase-payload.js";
import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { decodeReport, verifyReportEvidence } from "./report-evidence.js";
import { classifyExecutionFailure } from "./execution-failure.js";
import { createHash, randomUUID } from "node:crypto";
import { canonical, launchEvidence, persistLaunchMaterial, readLaunchMaterial, validateLaunchMaterial, type LaunchMaterial, type LaunchEvidence } from "./launch-material.js";
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
import { validateVerifyCommands, validatePhaseResultShape, validateProjectWikiDisposition, validateProjectWikiPaths } from "./phase-result.js";
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
} from "./types.js";

interface RunContext {
  state: PersonalRunState;
  persist: (changes: Partial<PersonalRunState>, prepared?: (state: PersonalRunState) => void) => Promise<void>;
  bindSource: (sourceSha: string) => Promise<void>;
  claimReserved: (changes: Partial<PersonalRunState>) => Promise<void>;
  failReserved: (changes: Partial<PersonalRunState>, prepared?: (state: PersonalRunState) => void) => Promise<void>;
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
  /** Monotonic clock seam for deterministic offline deadline checks. */
  readonly monotonicNow?: () => number;
  readonly newId?: () => string;
  /** Controller-level policy used unless a request supplies one. */
  readonly modelPolicy?: PersonalModelPolicy;
  readonly launchRetryPolicy?: LaunchRetryPolicy;
  readonly correctionPolicy?: CorrectionPolicy;
  readonly phaseTimeoutMs?: number;
  readonly testCommands?: readonly string[];
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
  readonly #monotonicNow: () => number;
  readonly #newId: () => string;
  readonly #modelPolicy: PersonalModelPolicy;
  readonly #retryPolicy: LaunchRetryPolicy;
  readonly #correctionPolicy: CorrectionPolicy;
  readonly #phaseTimeoutMs: number;
  readonly #testCommands: readonly string[];
  readonly #controllerPid: number | undefined;
  readonly #onPersistenceError: (error: unknown) => void;
  readonly #contexts = new Map<string, RunContext>();
  readonly #reservedClaims = new Set<string>();

  constructor(options: PersonalMvpControllerOptions) {
    for (const key of ["escalationPolicy", "reportCorrectionPolicy", "promptPolicy", "remediationPolicy"]) if (Object.hasOwn(options,key)) throw new Error(`${key} is retired; remove it and configure only implement/verify`);
    this.#material = options.launchMaterial === undefined ? undefined : validateLaunchMaterial(options.launchMaterial);
    this.#retryPolicy = validateLaunchRetryPolicy(this.#material ? this.#material.config.launchRetryPolicy : options.launchRetryPolicy);
    this.#correctionPolicy = validateCorrectionPolicy(this.#material ? this.#material.config.correctionPolicy : options.correctionPolicy);
    this.#phaseTimeoutMs = this.#material?.config.phaseTimeoutMs ?? options.phaseTimeoutMs ?? 3600000;
    if (!Number.isSafeInteger(this.#phaseTimeoutMs) || this.#phaseTimeoutMs <= 0 || this.#phaseTimeoutMs > 14400000) throw new Error("invalid controller phase timeout");
    this.#testCommands = this.#material?.config.testCommands ?? options.testCommands ?? [];
    if (!this.#testCommands.length || new Set(this.#testCommands).size !== this.#testCommands.length) throw new Error("configured test commands must be nonempty and distinct");
    this.#tickets = options.tickets;
    this.#workspaces = options.workspaces;
    this.#phases = options.phases;
    this.#publication = options.publication;
    this.#states = options.states;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#controllerPid = options.controllerPid;
    this.#onPersistenceError = options.onPersistenceError ?? (() => undefined);
    this.#modelPolicy = validateModelPolicy(this.#material?.config.modelPolicy ?? options.modelPolicy ?? APPROVED_PERSONAL_MODEL_POLICY);
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
    if (this.#material && canonical(resolved.profiles) !== canonical(this.#material.config.modelPolicy)) throw new Error("request model policy differs from capture");
    const identity = createRunIdentity(request, options.runId ?? this.#newId(), options.runId);
    const startedAt = this.#timestamp();
    const baseline = initialState(identity.runId, identity.sandbox, identity.branch, request, resolved.profiles, startedAt, {
      executionMode,
      ...(options.stdoutPath !== undefined ? { stdoutPath: options.stdoutPath } : {}),
      ...(options.stderrPath !== undefined ? { stderrPath: options.stderrPath } : {}),
      controllerPid: options.controllerPid ?? (executionMode === "foreground" ? this.#controllerPid ?? null : null),
      ...(options.launchConfigPath !== undefined ? { launchConfigPath: options.launchConfigPath } : {}),
      ...(options.launchConfigDigest !== undefined ? { launchConfigDigest: options.launchConfigDigest } : {}),
      ...(this.#material ? { launchEvidence: launchEvidence(this.#material), launchConfigDigest: createHash("sha256").update(Buffer.from(this.#material.rawConfig, "base64")).digest("hex") } : {}),
    });

    const state: PersonalRunState = { ...baseline, launchRetryPolicy: this.#retryPolicy, launchGenerations: [], correction: { policy: this.#correctionPolicy, prior: [], transition: "none" } };
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
   * it never creates a second run or reselects model policy.
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
      if (loaded?.schemaVersion !== 2) throw new Error("historical runs are read-only");
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
    const totalDeadline = this.#monotonicNow() + (2 + 2 * this.#correctionPolicy.maxCorrections) * this.#phaseTimeoutMs + 120_000;
    try {
      const ticket = await this.#tickets.get(request.ticketId, signal);
      if (ticket.id !== request.ticketId) throw new Error("Linear returned a different ticket");
      const contractBytes = JSON.stringify(ticket);
      if (Buffer.byteLength(contractBytes) > 128 * 1024) throw new Error("ticket contract exceeds bound");
      await context.persist({
        contract: { ticket: structuredClone(ticket), digest: createHash("sha256").update(contractBytes).digest("hex") },
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

      for (;;) {
        await this.#executePhase(context, ticket, request, "implement", signal, totalDeadline);
        if (context.state.correction?.prior.length) {
          await this.#assertCorrectionCost(context.state);
          if (!this.#workspaces.isolateVerifyOutputs) throw new Error("workspace lacks fresh Verify output isolation");
          await this.#workspaces.isolateVerifyOutputs(context.state.sandbox, requireHead(context.state), signal);
        }
        const verify = await this.#executePhase(context, ticket, request, "verify", signal, totalDeadline);
        if (verify.phase !== "verify") throw new Error("Verify phase identity mismatch");
        if (verify.status === "passed") { if (context.state.correction?.prior.length) await this.#assertCorrectionCost(context.state); break; }
        if (this.#monotonicNow() >= totalDeadline) throw new Error("total correction run deadline exhausted");
        if (!context.state.correction || context.state.correction.prior.length >= context.state.correction.policy.maxCorrections || !eligibleCorrection(verify)) throw new Error(`verify failed: ${verify.summary}`);
        await this.#assertCorrectionCost(context.state);
        const implement = context.state.results.implement as ImplementPhaseResult;
        const candidate = requireHead(context.state);
        const reports = context.state.reports;
        const commands = context.state.verifyCommands;
        if (!reports?.implement || !reports.verify || !commands?.length || !this.#phases.archiveCorrectionSessions || !this.#workspaces.prepareCorrection) throw new Error("correction evidence or trusted transition unavailable");
        await this.#workspaces.assertClean(context.state.sandbox, signal);
        if (await this.#workspaces.currentHead(context.state.sandbox, signal) !== candidate) throw new Error("correction candidate changed");
        const sessions = await this.#phases.archiveCorrectionSessions({ runId: context.state.runId, sandbox: context.state.sandbox, implement, verify }, signal);
        for (const archived of [sessions.implement, sessions.verify]) {
          const hash = createHash("sha256"); let size = 0;
          for (const ref of archived.chunks) { const chunk = await verifyReportEvidence(this.#phases.reportEvidence!, ref); hash.update(chunk); size += chunk.length; }
          if (size !== archived.byteLength || hash.digest("hex") !== archived.sha256) throw new Error("correction session custody mismatch");
        }
        const cycle: CorrectionCycle = { candidate, implement, verify, reports: { implement: reports.implement, verify: reports.verify }, commands, sessions, feedbackDigest: feedbackDigest(verify) };
        await context.persist({ correction: { ...context.state.correction, prior: [...context.state.correction.prior, cycle], transition: "archived" } });
        await this.#workspaces.prepareCorrection({ sandbox: context.state.sandbox, baseSha: requireBase(context.state), candidate }, signal);
        await this.#workspaces.assertClean(context.state.sandbox, signal);
        if (await this.#workspaces.currentHead(context.state.sandbox, signal) !== candidate) throw new Error("correction reset changed candidate");
        await this.#workspaces.assertDescendant?.(context.state.sandbox, requireBase(context.state), candidate, signal);
        await context.persist({ step: "implement", correction: { ...context.state.correction!, transition: "prepared" }, results: {}, reports: {}, sessions: {}, verifyCommands: [], verifyDisposition: "not_run" });
      }

      if (this.#monotonicNow() >= totalDeadline) throw new Error("total correction run deadline exhausted");
      const completeResults = requirePassingResults(context.state);
      const head = requireHead(context.state);
      await context.persist({ step: "publishing", lifecycle: "publishing", publicationState: "publishing" });
      const bundle = await this.#workspaces.exportBundle({ runId: context.state.runId, sandbox: context.state.sandbox, branch: context.state.branch, baseSha: requireBase(context.state), head }, signal);
      if (bundle.baseSha !== context.state.baseSha || bundle.head !== head || bundle.branch !== context.state.branch) throw new Error("candidate bundle identity mismatch");
      const published = await this.#publication.publish({
        contractDigest: context.state.contract!.digest,
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
      await context.persist({ step: "complete", status: "completed", lifecycle: "completed", endedAt: this.#timestamp(), prUrl: published.url, publicationState: "published", terminalReason: "verified_candidate_published", lastError: null });
      await this.#publishTelemetry(context.state);
      await this.#releaseReservation(context);
      this.#contexts.delete(context.state.runId);
      return context.state;
    } catch (error) {
      await this.#recordTerminal(context, error, signal?.aborted === true || classifyExecutionFailure(error) === "cancelled");
      this.#contexts.delete(context.state.runId);
      throw error;
    }
  }

  async #assertCorrectionCost(state: PersonalRunState): Promise<void> {
    if (!state.correction || !this.#phases.cumulativeRecordedCost) throw new Error("correction cost evidence unavailable");
    const cost = await this.#phases.cumulativeRecordedCost(state);
    if (decimalUnits(cost) > decimalUnits(state.correction.policy.maxRecordedCostUsd)) throw new Error("correction recorded cost ceiling exhausted");
  }

  async #executePhase(context: RunContext, ticket: Ticket, request: RunRequest, phase: PersonalPhase, signal?: AbortSignal, totalDeadline = Infinity): Promise<PhaseResult> {
    const attempt = context.state.attempts[phase] + 1;
    if (context.state.schemaVersion !== 2 || context.state.status !== "running" || attempt > (context.state.correction?.policy.maxCorrections ?? 0) + 1 || (attempt > 1 && (context.state.correction?.transition !== "prepared" || context.state.correction.prior.length !== attempt - 1))) throw new Error("phase cannot replay");
    if (phase === "implement" && context.state.results.implement || phase === "verify" && (context.state.results.verify || context.state.results.implement?.status !== "passed")) throw new Error("phase cannot replay");
    const expectedHead = requireHead(context.state);
    await this.#workspaces.assertClean(context.state.sandbox, signal);
    if (await this.#workspaces.currentHead(context.state.sandbox, signal) !== expectedHead) throw new Error("phase baseline changed");
    await context.persist({ step: phase, lifecycle: "running", attempts: { ...context.state.attempts, [phase]: attempt } });
    const remainingRun = Math.floor(totalDeadline - this.#monotonicNow());
    if (remainingRun <= 0) throw new Error("total correction run deadline exhausted");
    const allowedMs = Math.min(this.#phaseTimeoutMs, remainingRun);
    const deadline = this.#monotonicNow() + allowedMs;
    const timeout = AbortSignal.timeout(allowedMs);
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let input: PhaseInput = {
      telemetryAttribution: { trigger: "initial" }, deadline,
      runId: context.state.runId, ticket: structuredClone(ticket), contractDigest: context.state.contract!.digest,
      ...(phase === "verify" ? { implementationEvidence: (context.state.results.implement as ImplementPhaseResult).details } : {}),
      ...(phase === "implement" && attempt > 1 ? { correctionFeedback: { candidate: expectedHead, findings: context.state.correction!.prior.at(-1)!.verify.details.findings, digest: context.state.correction!.prior.at(-1)!.feedbackDigest } } : {}),
      testCommands: this.#testCommands, repository: request.repository, baseBranch: request.baseBranch,
      sandbox: context.state.sandbox, branch: context.state.branch, phase, attempt,
      expectedHead, originalTicketBaseSha: requireBase(context.state), profile: resolvedProfile(context.state, phase),
    };
    const inputDigest = launchInputDigest(input);
    const deadlineAt = new Date(this.#now().getTime() + allowedMs).toISOString();
    let result: PhaseResult;
    try {
      for (let generation = 0; ; generation++) {
        signal.throwIfAborted();
        await this.#workspaces.assertRuntimeParity?.(input.sandbox, signal);
        const identity = generationIdentity(phase, attempt, generation as 0 | 1, randomUUID());
        input = { ...input, launchGeneration: identity };
        const record = async (kind: LaunchRecord["kind"], rule: LaunchRecord["rule"] = null, errorCode: LaunchRecord["errorCode"] = null) => {
          await context.persist({ launchGenerations: [...context.state.launchGenerations!, { ...identity, phase, attempt, expectedHead, inputDigest, deadlineAt, kind, timestamp: this.#timestamp(), delayMs: generation ? LAUNCH_BACKOFF_MS : 0, classifier: LAUNCH_CLASSIFIER, rule, errorCode }] });
        };
        await record("reserved"); await record("dispatched");
        try { result = await this.#phases.run(structuredClone(input), signal); await record("returned"); break; }
        catch (error) {
          const rule = classifyLaunchFailure(error);
          let clean = false;
          if (rule && !signal.aborted) { try { await this.#workspaces.assertClean(input.sandbox, signal); clean = await this.#workspaces.currentHead(input.sandbox, signal) === expectedHead; } catch {} }
          await record("failed", clean ? rule! : null, classifyExecutionFailure(error, signal));
          if (!rule || !clean || generation >= this.#retryPolicy.maxRetries || signal.aborted || deadline - this.#monotonicNow() <= LAUNCH_BACKOFF_MS) throw error;
          await record("retrying", rule);
          await retryDelay(LAUNCH_BACKOFF_MS, undefined, { signal });
          await this.#workspaces.assertClean(input.sandbox, signal);
          if (await this.#workspaces.currentHead(input.sandbox, signal) !== expectedHead) throw new Error("retry baseline changed");
        }
      }
      signal.throwIfAborted();
      if (this.#monotonicNow() >= deadline) throw new Error("phase deadline exhausted");
      const capture = this.#phases.reportCapture?.(result);
      if (this.#phases.reportCapture && !capture) throw new Error("missing raw report evidence");
      if (capture) {
        await context.persist({ reports: { ...context.state.reports, [phase]: capture.evidence } });
        if (!this.#phases.reportEvidence || capture.sessionId !== input.launchGeneration!.sessionId || capture.sessionFile !== input.launchGeneration!.sessionFile) throw new Error("report capture provenance mismatch");
        const bytes = await verifyReportEvidence(this.#phases.reportEvidence, capture.evidence);
        const parsed = parsePhaseResult(decodeReport(bytes), input, capture.sessionId, capture.sessionFile, input.profile);
        if (!isDeepStrictEqual(parsed, result)) throw new Error("report capture/result mismatch");
      }
      const head = await this.#workspaces.currentHead(input.sandbox, signal);
      // Preserve an observed candidate even when its report is failed. It is never promoted.
      if (phase === "implement") await context.persist({ head, candidate: head });
      await this.#workspaces.assertClean(input.sandbox, signal);
      validatePhaseResult(result, input, head);
      if (result.sessionId !== input.launchGeneration!.sessionId || Object.values(context.state.sessions).includes(result.sessionId) || context.state.correction?.prior.some(c => c.implement.sessionId === result.sessionId || c.verify.sessionId === result.sessionId)) throw new Error("phase session identity reused or mismatched");
      if (phase === "verify") {
        if (head !== expectedHead || head !== context.state.candidate) throw new Error("Verify changed candidate identity");
        validateVerifyCommands(result, this.#testCommands);
        const commands = this.#phases.commandEvidence?.(result);
        if (commands) {
          if (commands.length !== this.#testCommands.length || commands.some((entry, index) => entry.command !== this.#testCommands[index] || entry.exitCode !== (result as Extract<PhaseResult, { phase: "verify" }>).details.commands[index]?.exitCode)) throw new Error("host Verify command evidence disagrees with report");
          for (const entry of commands) await verifyReportEvidence(this.#phases.reportEvidence!, entry.output);
          await context.persist({ verifyCommands: structuredClone(commands) });
        } else if (result.status === "failed") throw new Error("failed Verify lacks host command evidence");
      } else if (result.status === "passed") {
        if (head === expectedHead) throw new Error("Implement produced no distinct candidate commit");
        if (!this.#workspaces.assertDescendant) throw new Error("workspace lacks ancestry check");
        await this.#workspaces.assertDescendant(input.sandbox, expectedHead, head, signal);
        await this.#workspaces.assertDescendant(input.sandbox, requireBase(context.state), head, signal);
        await this.#reconcileProjectWikiDisposition(context, result as ImplementPhaseResult, head, signal);
      }
      await context.persist({ results: { ...context.state.results, [phase]: result }, sessions: { ...context.state.sessions, [phase]: result.sessionId }, ...(phase === "verify" ? { verifyDisposition: result.status } : {}) });
      await this.#phases.telemetrySettled?.(result).catch(() => undefined);
      if (result.status !== "passed" && phase !== "verify") throw new Error(`${phase} failed: ${result.summary}`);
      return result;
    } catch (error) {
      if ((error instanceof InvalidPhaseHandoff || error instanceof ReportExecutionFailure) && !context.state.reports?.[phase]) await context.persist({ reports: { ...context.state.reports, [phase]: error.capture.evidence } });
      if (phase === "implement" && context.state.candidate === null) {
        const head = await this.#workspaces.currentHead(input.sandbox).catch(() => null);
        if (head && /^[a-f0-9]{40}$/u.test(head)) await context.persist({ head, candidate: head });
      }
      if (phase === "verify" && context.state.verifyDisposition === "not_run") await context.persist({ verifyDisposition: "failed" });
      throw error;
    } finally { await this.#phases.reportEvidence?.release?.(); }
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
    context.persist = async (changes, prepared) => {
      const next = nextState(changes);
      prepared?.(structuredClone(next));
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
    context.failReserved = async (changes, prepared) => {
      const endedAt = this.#timestampAtOrAfter(context.state.updatedAt, ...(typeof changes.endedAt === "string" ? [changes.endedAt] : []));
      const next = nextState({ ...changes, endedAt }, this.#timestampAtOrAfter(endedAt));
      prepared?.(structuredClone(next));
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
    // Terminal state is immutable, including when cleanup fails. Diagnostics
    // belong in private controller logs, never a terminal-state repair write.
    this.#reportPersistenceError(new Error(failure));
  }

  async #recordTerminal(context: RunContext, error: unknown, interrupted: boolean): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    const status = interrupted ? "interrupted" : "failed";
    const changes: Partial<PersonalRunState> = {
      terminalReason: message || "run_failed",
      ...(context.state.publicationState === "publishing" ? { publicationState: "failed" } : {}),
      status,
      lifecycle: status,
      endedAt: this.#timestamp(),
      lastError: message || (interrupted ? "operator interrupted the run" : "run failed"),
      ...(context.state.launchState === "reserved" ? { launchState: "failed" } : {}),
      ...(context.state.preparationState === "pending" ? { preparationState: "failed" } : {}),
    };
    let terminalPersisted = context.state.status !== "running";
    let expectedTerminal: PersonalRunState | undefined;
    const captureTerminal = (state: PersonalRunState): void => { expectedTerminal = state; };
    const unclaimedBackground = context.state.executionMode === "background" && isReservedLaunch(context.state);
    try {
      if (context.state.status === "running") {
        // The JSON store combines this terminal write with the exact-owner
        // release under the ticket boundary. A pre-handoff failure must not
        // race a detached child claiming the same reservation.
        await (unclaimedBackground ? context.failReserved(changes, captureTerminal) : context.persist(changes, captureTerminal));
        terminalPersisted = true;
      }
    } catch (persistenceError) {
      // A port may commit the replacement and reject while publishing a
      // notification. Reconcile only the exact expected terminal revision;
      // never treat a newer owner/revision as our successful write.
      const observed = await this.#readState(context.state.runId).catch(() => undefined);
      // Compare the complete prepared wire state, including candidate, launch
      // claims, lifecycle, results and timestamps. A matching subset is not
      // evidence that our write committed. The snapshot predates the port call.
      if (observed && expectedTerminal && canonical(observed) === canonical(expectedTerminal)) {
        context.state = observed;
        terminalPersisted = true;
      }
      this.#reportPersistenceError(persistenceError);
    }
    if (terminalPersisted) {
      await this.#publishTelemetry(context.state);
      await this.#releaseReservation(context);
    }
  }

  async #publishTelemetry(state: PersonalRunState): Promise<void> {
    if (!this.#phases.telemetryTerminal) return;
    try {
      const summary = await this.#phases.telemetryTerminal(state);
      if (summary && !summary.complete) this.#reportPersistenceError(new Error(`Run accounting incomplete; inspect squire telemetry ${state.runId}`));
    } catch {
      this.#reportPersistenceError(new Error(`Run accounting unavailable/incomplete; inspect squire telemetry ${state.runId}`));
    }
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
  startedAt: string,
  metadata: Required<Pick<PersonalRunMetadata, "executionMode" | "controllerPid">> & Pick<PersonalRunMetadata, "stdoutPath" | "stderrPath" | "launchConfigPath" | "launchConfigDigest" | "launchEvidence">,
): PersonalRunState {
  const background = metadata.executionMode === "background";
  return {
    schemaVersion: 2,
    contract: null, candidate: null, verifyDisposition: "not_run", publicationState: "not_started", ciDisposition: "pending", mergeDisposition: "not_merged", terminalReason: null,
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
    sandbox,
    repository: request.repository,
    baseBranch: request.baseBranch,
    baseSha: null,
    branch,
    profiles,
    head: null,
    sessions: {},
    attempts: { implement: 0, verify: 0 },
    results: {},
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
  for (const key of ["escalationPolicy", "reportCorrectionPolicy", "promptPolicy", "remediationPolicy"]) if (Object.hasOwn(request,key)) throw new Error(`${key} is retired; start a new Contract/Implement/Verify run`);
  if (!/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(request.ticketId)) throw new Error("invalid Linear ticket identifier");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository)) throw new Error("repository must be owner/name");
  if (!request.repositoryPath || !/^[A-Za-z0-9._/-]+$/u.test(request.baseBranch)) throw new Error("invalid repository configuration");
  validateSourceRef(request.sourceRef, "repository source ref");
}

function validatePhaseResult(result: PhaseResult, input: PhaseInput, observedHead: string): void {
  validatePhaseResultShape(result, input.phase);
  if (result.runId !== input.runId || result.phase !== input.phase || result.attempt !== input.attempt) throw new Error("phase result identity mismatch");
  if (result.sessionFile !== (input.launchGeneration?.sessionFile ?? `/ticket/sessions/${input.phase}/${input.attempt}.jsonl`)) throw new Error("phase result session file mismatch");
  if (result.inputHead !== input.expectedHead) throw new Error("phase result input HEAD mismatch");
  if (result.outputHead !== observedHead) throw new Error("phase result output HEAD mismatch");
  if (!result.profile || result.profile.provider !== input.profile.provider || result.profile.model !== input.profile.model || result.profile.thinking !== input.profile.thinking) throw new Error("phase result profile identity mismatch");
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

function resolvedProfile(state: PersonalRunState, phase: PersonalPhase): PhaseProfile {
  const profile = state.profiles?.[phase];
  if (!profile) throw new Error(`run has no resolved ${phase} Pi profile`);
  return profile;
}

function requirePassingResults(state: PersonalRunState): Readonly<Record<PersonalPhase, PhaseResult>> {
  const { implement, verify } = state.results;
  if (!implement || !verify || implement.status !== "passed" || verify.status !== "passed" || verify.inputHead !== state.candidate || verify.outputHead !== state.candidate || state.head !== state.candidate) throw new Error("publication requires exact verified candidate");
  return { implement, verify };
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
