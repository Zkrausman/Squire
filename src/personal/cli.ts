#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { PersonalMvpController, type StartBackgroundOptions } from "./controller.js";
import { NodeCommandRunner } from "./command.js";
import { loadBoundPersonalMvpConfig, loadPersonalMvpConfig, resolveConfigPath, type PersonalMvpConfig } from "./config.js";
import { DockerSandboxWorkspace } from "./docker-sandbox.js";
import { CommandGitHubTokenProvider, GitHubPublisher } from "./github-publisher.js";
import { JsonRunStateStore } from "./json-run-state.js";
import { LinearClient } from "./linear-client.js";
import { SandboxPiPhaseRunner } from "./pi-phase-runner.js";
import { findRunState, formatRunStatus, sanitizeTerminalText, StatusLookupError } from "./status.js";
import type { RunRequest, TicketPort } from "./types.js";

const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const RUN_PATTERN = /^[a-z][a-z0-9]+-[a-z0-9][a-z0-9-]{7,127}$/u;

export interface ParsedRunArguments {
  readonly command: "run";
  readonly ticketId: string;
  readonly config: string;
  readonly background: boolean;
}

export interface ParsedStatusArguments {
  readonly command: "status";
  readonly selector: string;
  readonly config: string;
}

export type ParsedArguments = ParsedRunArguments | ParsedStatusArguments;

interface ParsedReservedArguments extends ParsedRunArguments {
  readonly reservedRunId: string;
  readonly reservedConfigDigest: string;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const reserved = parseReservedArguments(argv);
  if (reserved) return runReservedCommand(reserved);

  const parsed = parseArguments(argv);
  if (!parsed) {
    process.stderr.write("Usage: squire run <LINEAR-TICKET-ID> [--background] [--config <file>]\n       squire status <TICKET-ID-or-RUN-ID> [--config <file>]\n");
    return 2;
  }

  if (parsed.command === "status") return statusCommand(parsed);
  return runCommand(parsed);
}

export function parseArguments(argv: readonly string[]): ParsedArguments | undefined {
  const command = argv[0];
  if (command !== "run" && command !== "status") return undefined;
  let positional: string | undefined;
  let explicit: string | undefined;
  let background = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      if (explicit !== undefined || typeof argv[index + 1] !== "string" || argv[index + 1]!.trim().length === 0) return undefined;
      explicit = argv[index + 1]!;
      index += 1;
      continue;
    }
    if (argument === "--background" && command === "run") {
      if (background) return undefined;
      background = true;
      continue;
    }
    if (!argument || argument.startsWith("-")) return undefined;
    if (positional !== undefined) return undefined;
    positional = argument;
  }
  if (!positional) return undefined;
  if (command === "run") {
    if (!TICKET_PATTERN.test(positional)) return undefined;
    return { command, ticketId: positional, config: resolveConfigPath(explicit), background };
  }
  if (!TICKET_PATTERN.test(positional) && !RUN_PATTERN.test(positional)) return undefined;
  return { command, selector: positional, config: resolveConfigPath(explicit) };
}

async function runCommand(parsed: ParsedRunArguments): Promise<number> {
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
    const { config, digest: configDigest } = loaded;
    const controller = createController(config);
    const request = requestFromConfig(config, parsed.ticketId);

    if (parsed.background) {
      try {
        const launchOptions: StartBackgroundOptions = {
          cliPath: fileURLToPath(import.meta.url),
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
    const loaded = await loadBoundPersonalMvpConfig(parsed.config);
    if (loaded.digest !== parsed.reservedConfigDigest) throw new Error("reserved launch configuration changed before child bootstrap");
    const stateDirectory = childStateDirectoryOverride();
    const controller = createController(loaded.config, stateDirectory);
    await controller.runReserved(requestFromConfig(loaded.config, parsed.ticketId), parsed.reservedRunId, parsed.reservedConfigDigest, abortController.signal, parsed.config);
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

async function statusCommand(parsed: ParsedStatusArguments): Promise<number> {
  try {
    // Deliberately construct only config/state readers. Status must work with
    // no Linear credential, Docker installation, Pi runtime, GitHub helper, or
    // repository checkout available.
    const config = await loadPersonalMvpConfig(parsed.config);
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

function createController(config: PersonalMvpConfig, stateDirectory = config.paths.state): PersonalMvpController {
  const commands = new NodeCommandRunner();
  const apiKey = process.env[config.linear.apiKeyEnv];
  const tickets: TicketPort = apiKey
    ? new LinearClient({ apiKey, ...(config.linear.endpoint ? { endpoint: config.linear.endpoint } : {}) })
    : { async get(): Promise<never> { throw new Error(`missing Linear credential environment variable: ${config.linear.apiKeyEnv}`); } };
  return new PersonalMvpController({
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
      commands,
      stagingRoot: config.paths.staging,
      testCommands: config.testCommands,
      roleUser: config.sandbox.roleUser,
      piExecutable: config.sandbox.piExecutable,
      piAgentDirectory: config.sandbox.piAgentDirectory,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
