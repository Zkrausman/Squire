#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { PersonalMvpController } from "./controller.js";
import { NodeCommandRunner } from "./command.js";
import { loadPersonalMvpConfig, resolveConfigPath } from "./config.js";
import { DockerSandboxWorkspace } from "./docker-sandbox.js";
import { CommandGitHubTokenProvider, GitHubPublisher } from "./github-publisher.js";
import { JsonRunStateStore } from "./json-run-state.js";
import { LinearClient } from "./linear-client.js";
import { SandboxPiPhaseRunner } from "./pi-phase-runner.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed) {
    process.stderr.write("Usage: squire run <LINEAR-TICKET-ID> [--config <file>]\n");
    return 2;
  }
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new Error("operator interrupted the run"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const config = await loadPersonalMvpConfig(parsed.config);
    const apiKey = process.env[config.linear.apiKeyEnv];
    if (!apiKey) throw new Error(`missing Linear credential environment variable: ${config.linear.apiKeyEnv}`);
    const commands = new NodeCommandRunner();
    const workflow = new PersonalMvpController({
      modelPolicy: config.modelPolicy,
      tickets: new LinearClient({ apiKey, ...(config.linear.endpoint ? { endpoint: config.linear.endpoint } : {}) }),
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
    });
    const result = await workflow.run({
      ticketId: parsed.ticketId,
      repository: config.repository.slug,
      repositoryPath: config.repository.path,
      sourceRef: config.repository.sourceRef,
      baseBranch: config.repository.baseBranch,
    }, controller.signal);
    process.stdout.write(`${result.prUrl ?? ""}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Squire stopped: ${message}\n`);
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

export function parseArguments(argv: readonly string[]): { ticketId: string; config: string } | undefined {
  if (argv[0] !== "run" || typeof argv[1] !== "string") return undefined;
  let explicit: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] !== "--config" || typeof argv[index + 1] !== "string" || argv[index + 1]!.trim().length === 0 || index + 2 !== argv.length) return undefined;
    explicit = argv[index + 1]!;
    index += 1;
  }
  return { ticketId: argv[1], config: resolveConfigPath(explicit) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
