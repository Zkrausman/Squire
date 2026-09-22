#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLI_USAGE } from "./cli-arguments.js";
import { isSupportedNodeVersion, unsupportedRuntimeMessage } from "./runtime-version.js";
import type { ParsedTelemetryArguments } from "./cli-arguments.js";

export { parseArguments } from "./cli-arguments.js";
export type {
  ParsedArguments,
  ParsedRunArguments,
  ParsedStatusArguments,
  ParsedTelemetryArguments,
  ParsedWatchArguments,
} from "./cli-arguments.js";

const VERSION_FLAGS = new Set(["--version", "-V"]);
type RuntimeOverrides = { nodeVersion?: string; cliPath?: string };

/**
 * Keep the executable entrypoint dependency-free until the public command is
 * known. In particular, version output must not resolve the controller graph.
 */
export async function main(argv = process.argv.slice(2), runtime: RuntimeOverrides = {}): Promise<number> {
  // An injected runtime is an internal test seam. The production executable,
  // and supported-runtime test calls, dispatch version and its bounded grammar
  // errors before the runtime graph. An explicitly unsupported runtime is
  // stopped before argv inspection so the runtime guard remains fail-closed.
  const nodeVersion = runtime.nodeVersion ?? process.versions.node;
  const supportedRuntime = isSupportedNodeVersion(nodeVersion);
  if (runtime.nodeVersion === undefined || supportedRuntime) {
    if (isExactVersionArguments(argv)) {
      process.stdout.write(`${packageVersion()}\n`);
      return 0;
    }
    if (containsVersionFlag(argv)) {
      process.stderr.write(CLI_USAGE);
      return 2;
    }
  }
  if (!supportedRuntime) {
    process.stderr.write(`${unsupportedRuntimeMessage(nodeVersion)}\n`);
    return 1;
  }
  const implementation = await import("./cli-main.js");
  return implementation.main(argv, runtime);
}

/** Preserve the imported CLI helper without making it part of the bootstrap graph. */
export async function telemetryCommand(parsed: ParsedTelemetryArguments): Promise<number> {
  const implementation = await import("./cli-main.js");
  return implementation.telemetryCommand(parsed);
}

function isExactVersionArguments(argv: readonly string[]): boolean {
  return argv.length === 1 && VERSION_FLAGS.has(argv[0] ?? "");
}

function containsVersionFlag(argv: readonly string[]): boolean {
  return argv.some(argument => VERSION_FLAGS.has(argument));
}

function packageVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const packagePath = path.join(directory, "package.json");
    try {
      const metadata: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        const version = (metadata as { version?: unknown }).version;
        if (typeof version === "string" && version.length > 0) return version;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("package.json with a version was not found");
    directory = parent;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
