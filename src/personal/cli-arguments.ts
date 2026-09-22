import os from "node:os";
import path from "node:path";

const TICKET_PATTERN = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
export const RUN_PATTERN = /^[a-z][a-z0-9]+-[a-z0-9][a-z0-9-]{7,127}$/u;

export const CLI_USAGE = "Usage: squire run <LINEAR-TICKET-ID> [--background] [--config <file>]\n       squire status <TICKET-ID-or-RUN-ID> [--config <file>]\n       squire watch <TICKET-ID-or-RUN-ID> [--config <file>]\n       squire telemetry <RUN-ID> [--json] [--config <file>]\n       squire install-skills\n";

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

export interface ParsedWatchArguments {
  readonly command: "watch";
  readonly selector: string;
  readonly config: string;
}

export interface ParsedTelemetryArguments {
  readonly command: "telemetry";
  readonly selector: string;
  readonly config: string;
  readonly json: boolean;
}

export interface ParsedInstallSkillsArguments {
  readonly command: "install-skills";
  /** Deliberately absent; this optional type member keeps the parser result shape readable without resolving config. */
  readonly config?: never;
}

export type ParsedArguments = ParsedRunArguments | ParsedStatusArguments | ParsedWatchArguments | ParsedTelemetryArguments | ParsedInstallSkillsArguments;

/** Parse only the public grammar without importing the runtime/controller graph. */
export function parseArguments(argv: readonly string[]): ParsedArguments | undefined {
  const command = argv[0];
  if (command === "install-skills") return argv.length === 1 ? { command } : undefined;
  if (command !== "run" && command !== "status" && command !== "watch" && command !== "telemetry") return undefined;
  let positional: string | undefined;
  let explicit: string | undefined;
  let background = false;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      if (explicit !== undefined || typeof argv[index + 1] !== "string" || argv[index + 1]!.trim().length === 0) return undefined;
      explicit = argv[index + 1]!;
      index += 1;
      continue;
    }
    if (argument === "--json" && command === "telemetry") { if (json) return undefined; json = true; continue; }
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
    return { command, ticketId: positional, config: resolveCliConfigPath(explicit), background };
  }
  if (command === "telemetry") {
    if (!RUN_PATTERN.test(positional)) return undefined;
    return { command, selector: positional, config: resolveCliConfigPath(explicit), json };
  }
  if (!TICKET_PATTERN.test(positional) && !RUN_PATTERN.test(positional)) return undefined;
  return { command, selector: positional, config: resolveCliConfigPath(explicit) };
}

/** Resolve CLI-only config selection without loading configuration validation or integrations. */
function resolveCliConfigPath(explicit?: string): string {
  const selected = nonempty(explicit) ?? nonempty(process.env["SQUIRE_CONFIG"]);
  if (selected) return resolveHostPath(process.cwd(), selected, process.platform);
  const directory = defaultSquireDirectory();
  return process.platform === "win32"
    ? path.win32.join(directory, "config.json")
    : path.posix.join(directory, "config.json");
}

function defaultSquireDirectory(): string {
  if (process.platform === "win32") {
    const userProfile = nonempty(process.env["USERPROFILE"])
      ?? (nonempty(process.env["HOMEDRIVE"]) && nonempty(process.env["HOMEPATH"])
        ? `${process.env["HOMEDRIVE"]}${process.env["HOMEPATH"]}`
        : undefined)
      ?? os.homedir();
    return path.win32.normalize(path.win32.join(userProfile, ".squire"));
  }
  const home = nonempty(process.env["HOME"]) ?? os.homedir();
  const xdg = nonempty(process.env["XDG_CONFIG_HOME"]);
  const configHome = xdg === undefined
    ? path.posix.join(home, ".config")
    : path.posix.isAbsolute(xdg) ? path.posix.normalize(xdg) : path.posix.resolve(process.cwd(), xdg);
  return path.posix.normalize(path.posix.join(configHome, "squire"));
}

function resolveHostPath(base: string, value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.win32.resolve(base, value);
  if (path.posix.isAbsolute(value) || path.posix.isAbsolute(base)) return path.posix.resolve(base, value);
  return path.resolve(base, value);
}

function nonempty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
