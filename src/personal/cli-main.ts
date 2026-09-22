#!/usr/bin/env node
import { historicalStatus } from "./historical-state.js";
import { isSupportedNodeVersion, unsupportedRuntimeMessage } from "./runtime-version.js";
import { TelemetryStore, formatTelemetry } from "./telemetry-store.js";
import path from "node:path";
import { captureLaunchMaterial, readLaunchMaterial, type LaunchMaterial } from "./launch-material.js";
import { fileURLToPath } from "node:url";
import { PersonalMvpController, type StartBackgroundOptions } from "./controller.js";
import { NodeCommandRunner } from "./command.js";
import { loadBoundPersonalMvpConfig, loadPersonalMvpConfig, type PersonalMvpConfig } from "./config.js";
import { DockerSandboxWorkspace } from "./docker-sandbox.js";
import { CommandGitHubTokenProvider, GitHubPublisher } from "./github-publisher.js";
import { JsonRunStateStore } from "./json-run-state.js";
import { LinearClient } from "./linear-client.js";
import { SandboxPiPhaseRunner } from "./pi-phase-runner.js";
import { findRunState, formatRunEvent, formatRunStatus, sanitizeTerminalText, StatusLookupError } from "./status.js";
import { watchRun } from "./run-watcher.js";
import type { RunEvent } from "./run-events.js";
import type { RunRequest, TicketPort } from "./types.js";
import { CLI_USAGE, parseArguments, RUN_PATTERN, type ParsedRunArguments, type ParsedStatusArguments, type ParsedTelemetryArguments, type ParsedWatchArguments } from "./cli-arguments.js";

interface ParsedReservedArguments extends ParsedRunArguments {
  readonly reservedRunId: string;
  readonly reservedConfigDigest: string;
}

/** Runtime implementation loaded only after the dependency-free CLI bootstrap dispatches. */
export async function main(argv = process.argv.slice(2), runtime: { nodeVersion?: string; cliPath?: string } = {}): Promise<number> {
  const nodeVersion = runtime.nodeVersion ?? process.versions.node;
  if (!isSupportedNodeVersion(nodeVersion)) {
    process.stderr.write(`${unsupportedRuntimeMessage(nodeVersion)}\n`);
    return 1;
  }
  const reserved = parseReservedArguments(argv);
  if (reserved) return runReservedCommand(reserved);

  const parsed = parseArguments(argv);
  if (!parsed) {
    process.stderr.write(CLI_USAGE);
    return 2;
  }

  if (parsed.command === "telemetry") return telemetryCommand(parsed);
  if (parsed.command === "status") return statusCommand(parsed);
  if (parsed.command === "watch") return watchCommand(parsed);
  return runCommand(parsed, runtime.cliPath);
}

export async function telemetryCommand(parsed: ParsedTelemetryArguments): Promise<number> {
  try {
    const config = await loadPersonalMvpConfig(parsed.config);
    const artifact = await new TelemetryStore(config.paths.staging).read(parsed.selector);
    process.stdout.write((parsed.json ? JSON.stringify(artifact ?? { schemaVersion: 1, runId: parsed.selector, available: false, complete: false, reason: "no_terminal_artifact" }) : formatTelemetry(artifact, parsed.selector)) + "\n");
    return 0;
  } catch { process.stderr.write("Telemetry unavailable: check configuration and private terminal artifact integrity.\n"); return 1; }
}

async function runCommand(parsed: ParsedRunArguments, cliPath = fileURLToPath(new URL("./cli.js", import.meta.url))): Promise<number> {
  // Install the background-startup handlers before loading configuration. A
  // signal cannot create a durable run before reservation, but once startup
  // reaches that boundary it must be recorded as interrupted until spawn is
  // confirmed.
  const startupAbort = parsed.background ? new AbortController() : undefined;
  const startupInterrupt = (): void => startupAbort?.abort(new Error("operator interrupted background startup"));
  if (startupAbort) {
    process.once("SIGINT", startupInterrupt);
    process.once("SIGTERM", startupInterrupt);
  }

  try {
    const launchEnvironment = parsed.background ? { ...process.env } : undefined;
    const loaded = await (parsed.background
      ? loadBoundPersonalMvpConfig(parsed.config, { env: launchEnvironment! })
      : loadBoundPersonalMvpConfig(parsed.config)).catch(error => {
      writeError(error);
      return undefined;
    });
    if (!loaded) return 1;
    const { digest: configDigest } = loaded;
    const material = await captureLaunchMaterial(loaded).catch(error => { writeError(error); return undefined; });
    if (!material) return 1;
    const config = material.config;
    const controller = createController(config, material);
    const request = requestFromConfig(config, parsed.ticketId);

    if (parsed.background) {
      try {
        const launchOptions: StartBackgroundOptions = {
          cliPath,
          configPath: parsed.config,
          stateDirectory: config.paths.state,
          logsDirectory: path.join(config.dataDirectory, "logs"),
          cwd: process.cwd(),
          launchConfigDigest: configDigest,
          ...(launchEnvironment !== undefined ? { env: launchEnvironment } : {}),
          signal: startupAbort!.signal,
        };
        const started = await controller.startBackground(request, launchOptions);
        // The run ID is the only synchronous result. Status can be polled while
        // the detached child performs credential, ticket, and workspace work.
        process.stdout.write(`${started.runId}\n`);
        return 0;
      } catch (error) {
        writeError(error);
        return 1;
      }
    }

    const abortController = new AbortController();
    const interrupt = (): void => abortController.abort(new Error("operator interrupted the run"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      const result = await controller.run(request, abortController.signal);
      process.stdout.write(`${sanitizeTerminalText(result.prUrl ?? "")}\n`);
      return 0;
    } catch (error) {
      writeError(error);
      return 1;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  } finally {
    if (startupAbort) {
      process.removeListener("SIGINT", startupInterrupt);
      process.removeListener("SIGTERM", startupInterrupt);
    }
  }
}

async function runReservedCommand(parsed: ParsedReservedArguments): Promise<number> {
  const abortController = new AbortController();
  const interrupt = (): void => abortController.abort(new Error("operator interrupted the run"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const stateDirectory = childStateDirectoryOverride();
    if (!stateDirectory) throw new Error("reserved execution requires captured state directory");
    const state = await new JsonRunStateStore(stateDirectory).read(parsed.reservedRunId);
    if (!state || state.ticketId !== parsed.ticketId || state.launchConfigDigest !== parsed.reservedConfigDigest || state.launchConfigPath !== path.resolve(parsed.config)) throw new Error("reserved launch identity mismatch");
    const material = await readLaunchMaterial(state, stateDirectory);
    const controller = createController(material.config, material, stateDirectory);
    await controller.runReserved(requestFromConfig(material.config, parsed.ticketId), parsed.reservedRunId, parsed.reservedConfigDigest, abortController.signal, parsed.config);
    return 0;
  } catch (error) {
    // Always consult the original state directory. This is a no-op after the
    // controller already persisted a terminal result, and covers config/state
    // path changes or failures before the reserved state is claimed. The
    // ticket and digest checks keep an unrelated child from terminalizing a
    // reservation merely because it knows a run ID.
    await recordBootstrapFailure(parsed.reservedRunId, parsed.ticketId, parsed.reservedConfigDigest, parsed.config, error, abortController.signal.aborted);
    // This is captured by the background stderr descriptor. The controller
    // has already attempted to persist the terminal state.
    writeError(error);
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function recordBootstrapFailure(runId: string, ticketId: string, launchConfigDigest: string, configPath: string, error: unknown, interrupted: boolean): Promise<void> {
  const directory = process.env["SQUIRE_STATE_DIRECTORY"];
  if (!directory || !path.isAbsolute(directory) || directory.includes("\0")) return;
  if (!runId.startsWith(`${ticketId.toLowerCase()}-`)) return;
  try {
    const states = new JsonRunStateStore(directory);
    const state = await states.read(runId);
    if (state?.ticketId !== ticketId || state.launchConfigDigest !== launchConfigDigest) return;
    if (state.launchConfigPath !== undefined && path.resolve(configPath) !== state.launchConfigPath) return;
    // Bootstrap failure belongs only to an unclaimed launch. A child that
    // loses the reserved->started CAS must not overwrite the winning owner.
    if (state.status !== "running" || state.launchState !== "reserved" || state.controllerPid !== null || state.lifecycle !== "launching" || state.step !== "launching" || state.preparationState !== "pending") return;
    // The state file alone is not ownership evidence. Missing, malformed, or
    // replaced reservation records remain ambiguous and are not terminalized.
    if (await states.reservationOwner(state.ticketId) !== state.runId) return;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000) || "background controller bootstrap failed";
    const endedAt = new Date(Math.max(Date.now(), Date.parse(state.startedAt ?? state.updatedAt), Date.parse(state.updatedAt))).toISOString();
    const terminal = {
      ...state,
      version: state.version + 1,
      status: interrupted ? "interrupted" as const : "failed" as const,
      lifecycle: interrupted ? "interrupted" as const : "failed" as const,
      launchState: "failed" as const,
      ...(state.preparationState === "pending" ? { preparationState: "failed" as const } : {}),
      endedAt,
      lastError: message,
      terminalReason: message,
      updatedAt: endedAt,
    };
    // The JSON store performs the ownership check, version check, terminal
    // replacement, and reservation release under one ticket operation.
    await states.failReserved(terminal);
  } catch (persistenceError) {
    const message = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
    process.stderr.write(`Squire state persistence warning: ${sanitizeTerminalText(message)}\n`);
  }
}

async function watchCommand(parsed: ParsedWatchArguments): Promise<number> {
  const abortController = new AbortController();
  const interrupt = (): void => abortController.abort(new Error("operator interrupted event watch"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    // Watch is deliberately a host-only path: it constructs configuration,
    // persisted state, and filesystem event consumption, but no Linear,
    // Docker, GitHub, Git, Pi, or model adapter.
    const config = await loadPersonalMvpConfig(parsed.config);
    const historical = await historicalStatus(config.paths.state, parsed.selector);
    if (historical) { process.stdout.write(historical); return 0; }
    const states = new JsonRunStateStore(config.paths.state);
    await watchRun({
      states,
      selector: parsed.selector,
      signal: abortController.signal,
      onEvent: (event: RunEvent): void => { process.stdout.write(formatRunEvent(event)); },
    });
    return 0;
  } catch (error) {
    if (abortController.signal.aborted) return 130;
    writeError(error);
    if (error instanceof StatusLookupError && error.code === "malformed") return 2;
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function statusCommand(parsed: ParsedStatusArguments): Promise<number> {
  try {
    // Deliberately construct only config/state readers. Status must work with
    // no Linear credential, Docker installation, Pi runtime, GitHub helper, or
    // repository checkout available.
    const config = await loadPersonalMvpConfig(parsed.config);
    const historical = await historicalStatus(config.paths.state, parsed.selector);
    if (historical) { process.stdout.write(historical); return 0; }
    const state = await findRunState(new JsonRunStateStore(config.paths.state), parsed.selector);
    process.stdout.write(formatRunStatus(state));
    return 0;
  } catch (error) {
    writeError(error);
    if (error instanceof StatusLookupError && error.code === "malformed") return 2;
    return 1;
  }
}

function parseReservedArguments(argv: readonly string[]): ParsedReservedArguments | undefined {
  if (argv[0] !== "run") return undefined;
  const publicArgs: string[] = [];
  let reservedRunId: string | undefined;
  let reservedConfigDigest: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--reserved-run-id") {
      if (reservedRunId !== undefined || typeof argv[index + 1] !== "string" || !RUN_PATTERN.test(argv[index + 1]!)) return undefined;
      reservedRunId = argv[index + 1]!;
      index += 1;
    } else if (argv[index] === "--reserved-config-sha256") {
      if (reservedConfigDigest !== undefined || typeof argv[index + 1] !== "string" || !/^[a-f0-9]{64}$/u.test(argv[index + 1]!)) return undefined;
      reservedConfigDigest = argv[index + 1]!;
      index += 1;
    } else {
      publicArgs.push(argv[index]!);
    }
  }
  if (!reservedRunId || !reservedConfigDigest) return undefined;
  const parsed = parseArguments(["run", ...publicArgs]);
  if (!parsed || parsed.command !== "run" || parsed.background) return undefined;
  return { ...parsed, reservedRunId, reservedConfigDigest };
}

function createController(config: PersonalMvpConfig, material: LaunchMaterial, stateDirectory = config.paths.state): PersonalMvpController {
  const commands = new NodeCommandRunner();
  const apiKey = process.env[config.linear.apiKeyEnv];
  const tickets: TicketPort = apiKey
    ? new LinearClient({ apiKey, ...(config.linear.endpoint ? { endpoint: config.linear.endpoint } : {}) })
    : { async get(): Promise<never> { throw new Error(`missing Linear credential environment variable: ${config.linear.apiKeyEnv}`); } };
  return new PersonalMvpController({
    launchMaterial: material,
    controllerPid: process.pid,
    modelPolicy: config.modelPolicy,
    tickets,
    workspaces: new DockerSandboxWorkspace({
      commands,
      bridgeRoot: config.paths.bridges,
      stagingRoot: config.paths.staging,
      roleUser: config.sandbox.roleUser,
      piAgentDirectory: config.sandbox.piAgentDirectory,
      ...(config.sandbox.piAuthFile ? { piAuthFile: config.sandbox.piAuthFile } : {}),
      ...(config.sandbox.template ? { template: config.sandbox.template } : {}),
    }),
    phases: new SandboxPiPhaseRunner({
      launchMaterial: material,
      commands,
      stagingRoot: config.paths.staging,
      testCommands: config.testCommands,
      roleUser: config.sandbox.roleUser,
      piExecutable: config.sandbox.piExecutable,
      piAgentDirectory: config.sandbox.piAgentDirectory,
      ...(config.phaseTimeoutMs === undefined ? {} : { timeoutMs: config.phaseTimeoutMs }),
    }),
    publication: new GitHubPublisher({
      commands,
      tokens: new CommandGitHubTokenProvider({
        commands,
        command: config.github.tokenCommand[0]!,
        args: config.github.tokenCommand.slice(1),
      }),
    }),
    states: new JsonRunStateStore(stateDirectory),
    onPersistenceError: error => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Squire state persistence warning: ${sanitizeTerminalText(message)}\n`);
    },
  });
}

function childStateDirectoryOverride(): string | undefined {
  const value = process.env["SQUIRE_STATE_DIRECTORY"];
  if (value === undefined) return undefined;
  if (!value || value.includes("\0") || !path.isAbsolute(value)) throw new Error("SQUIRE_STATE_DIRECTORY must be an absolute path");
  return path.resolve(value);
}

function requestFromConfig(config: PersonalMvpConfig, ticketId: string): RunRequest {
  return {
    ticketId,
    repository: config.repository.slug,
    repositoryPath: config.repository.path,
    sourceRef: config.repository.sourceRef,
    baseBranch: config.repository.baseBranch,
  };
}

function writeError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Squire stopped: ${sanitizeTerminalText(message)}\n`);
}
