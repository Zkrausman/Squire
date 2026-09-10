#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { PersonalMvpController, type StartBackgroundOptions } from "./controller.js";
import { NodeCommandRunner } from "./command.js";
import { loadPersonalMvpConfig, resolveConfigPath, type PersonalMvpConfig } from "./config.js";
import { DockerSandboxWorkspace } from "./docker-sandbox.js";
import { CommandGitHubTokenProvider, GitHubPublisher } from "./github-publisher.js";
import { JsonRunStateStore } from "./json-run-state.js";
import { LinearClient } from "./linear-client.js";
import { SandboxPiPhaseRunner } from "./pi-phase-runner.js";
import { findRunState, formatRunStatus, StatusLookupError } from "./status.js";
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
  const loaded = await loadBoundConfig(parsed.config).catch(error => {
    writeError(error);
    return undefined;
  });
  if (!loaded) return 1;
  const { config, digest: configDigest } = loaded;
  const controller = createController(config);
  const request = requestFromConfig(config, parsed.ticketId);

  if (parsed.background) {
    const abortController = new AbortController();
    const interrupt = (): void => abortController.abort(new Error("operator interrupted background startup"));
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      const launchOptions: StartBackgroundOptions = {
        cliPath: fileURLToPath(import.meta.url),
        configPath: parsed.config,
        stateDirectory: config.paths.state,
        logsDirectory: config.paths.logs,
        cwd: process.cwd(),
        launchConfigDigest: configDigest,
        signal: abortController.signal,
      };
      const started = await controller.startBackground(request, launchOptions);
      // The run ID is the only synchronous result. Status can be polled while
      // the detached child performs credential, ticket, and workspace work.
      process.stdout.write(`${started.runId}\n`);
      return 0;
    } catch (error) {
      writeError(error);
      return 1;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }

  const abortController = new AbortController();
  const interrupt = (): void => abortController.abort(new Error("operator interrupted the run"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await controller.run(request, abortController.signal);
    process.stdout.write(`${result.prUrl ?? ""}\n`);
    return 0;
  } catch (error) {
    writeError(error);
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function runReservedCommand(parsed: ParsedReservedArguments): Promise<number> {
  const abortController = new AbortController();
  const interrupt = (): void => abortController.abort(new Error("operator interrupted the run"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const loaded = await loadBoundConfig(parsed.config);
    if (loaded.digest !== parsed.reservedConfigDigest) throw new Error("reserved launch configuration changed before child bootstrap");
    const controller = createController(loaded.config);
    await controller.runReserved(requestFromConfig(loaded.config, parsed.ticketId), parsed.reservedRunId, parsed.reservedConfigDigest, abortController.signal);
    return 0;
  } catch (error) {
    // Always consult the original state directory. This is a no-op after the
    // controller already persisted a terminal result, and covers config/state
    // path changes or failures before the reserved state is claimed.
    await recordBootstrapFailure(parsed.reservedRunId, error, abortController.signal.aborted);
    // This is captured by the background stderr descriptor. The controller
    // has already attempted to persist the terminal state.
    writeError(error);
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function recordBootstrapFailure(runId: string, error: unknown, interrupted: boolean): Promise<void> {
  const directory = process.env["SQUIRE_STATE_DIRECTORY"];
  if (!directory) return;
  try {
    const states = new JsonRunStateStore(directory);
    const state = await states.read(runId);
    if (!state || state.status !== "running") return;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000) || "background controller bootstrap failed";
    const terminal = {
      ...state,
      version: state.version + 1,
      status: interrupted ? "interrupted" as const : "failed" as const,
      lifecycle: interrupted ? "interrupted" as const : "failed" as const,
      launchState: "failed" as const,
      ...(state.preparationState === "pending" ? { preparationState: "failed" as const } : {}),
      endedAt: new Date().toISOString(),
      lastError: message,
      updatedAt: new Date().toISOString(),
    };
    await states.save(terminal);
    await states.release(state.ticketId, state.runId);
  } catch (persistenceError) {
    const message = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
    process.stderr.write(`Squire state persistence warning: ${message}\n`);
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

function createController(config: PersonalMvpConfig): PersonalMvpController {
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
    states: new JsonRunStateStore(config.paths.state),
    onPersistenceError: error => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Squire state persistence warning: ${message}\n`);
    },
  });
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

async function loadBoundConfig(file: string): Promise<{ readonly config: PersonalMvpConfig; readonly digest: string }> {
  const before = await configDigest(file);
  const config = await loadPersonalMvpConfig(file);
  const after = await configDigest(file);
  if (before !== after) throw new Error("configuration changed while it was being loaded");
  return { config, digest: after };
}

async function configDigest(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function writeError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Squire stopped: ${message}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
