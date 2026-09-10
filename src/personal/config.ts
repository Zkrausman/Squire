import { readFile } from "node:fs/promises";
import path from "node:path";
import { PERSONAL_PHASES, type PersonalPhase } from "./types.js";
import type { PhaseProfile } from "./pi-phase-runner.js";

export interface PersonalMvpConfig {
  readonly repository: {
    readonly slug: string;
    readonly path: string;
    readonly sourceRef: string;
    readonly baseBranch: string;
  };
  readonly paths: {
    readonly state: string;
    readonly bridges: string;
    readonly staging: string;
  };
  readonly linear: {
    readonly apiKeyEnv: string;
    readonly endpoint?: string;
  };
  readonly github: {
    readonly tokenCommand: readonly string[];
  };
  readonly sandbox: {
    readonly template?: string;
    readonly roleUser: string;
    readonly piExecutable: string;
    readonly piAgentDirectory: string;
    readonly piAuthFile?: string;
  };
  readonly profiles: Readonly<Record<PersonalPhase, PhaseProfile>>;
  readonly testCommands: readonly string[];
}

export async function loadPersonalMvpConfig(file: string): Promise<PersonalMvpConfig> {
  const absolute = path.resolve(file);
  const raw: unknown = JSON.parse(await readFile(absolute, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("configuration must be an object");
  const value = raw as Record<string, unknown>;
  const repository = object(value["repository"], "repository");
  const paths = object(value["paths"], "paths");
  const linear = object(value["linear"], "linear");
  const github = object(value["github"], "github");
  const sandbox = object(value["sandbox"], "sandbox");
  const profilesValue = object(value["profiles"], "profiles");
  const base = path.dirname(absolute);

  const profiles = {} as Record<PersonalPhase, PhaseProfile>;
  for (const phase of PERSONAL_PHASES) {
    const profile = object(profilesValue[phase], `profiles.${phase}`);
    const thinking = text(profile["thinking"], `profiles.${phase}.thinking`);
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) throw new Error(`invalid profiles.${phase}.thinking`);
    profiles[phase] = {
      provider: text(profile["provider"], `profiles.${phase}.provider`),
      model: text(profile["model"], `profiles.${phase}.model`),
      thinking: thinking as PhaseProfile["thinking"],
    };
  }

  const testCommands = value["testCommands"];
  if (!Array.isArray(testCommands) || testCommands.length === 0 || testCommands.some(command => typeof command !== "string" || command.length === 0)) throw new Error("testCommands must be a non-empty string array");
  const tokenCommand = github["tokenCommand"];
  if (!Array.isArray(tokenCommand) || tokenCommand.length === 0 || tokenCommand.length > 32 || tokenCommand.some(argument => typeof argument !== "string" || argument.length === 0 || argument.length > 2_000)) throw new Error("github.tokenCommand must be a non-empty string array");
  const endpoint = linear["endpoint"];
  if (endpoint !== undefined && typeof endpoint !== "string") throw new Error("linear.endpoint must be a string");
  const template = sandbox["template"];
  if (template !== undefined && typeof template !== "string") throw new Error("sandbox.template must be a string");
  const piAuthFile = sandbox["piAuthFile"];
  if (piAuthFile !== undefined && typeof piAuthFile !== "string") throw new Error("sandbox.piAuthFile must be a string");

  return {
    repository: {
      slug: text(repository["slug"], "repository.slug"),
      path: resolve(base, text(repository["path"], "repository.path")),
      sourceRef: text(repository["sourceRef"], "repository.sourceRef"),
      baseBranch: text(repository["baseBranch"], "repository.baseBranch"),
    },
    paths: {
      state: resolve(base, text(paths["state"], "paths.state")),
      bridges: resolve(base, text(paths["bridges"], "paths.bridges")),
      staging: resolve(base, text(paths["staging"], "paths.staging")),
    },
    linear: {
      apiKeyEnv: text(linear["apiKeyEnv"], "linear.apiKeyEnv"),
      ...(endpoint ? { endpoint } : {}),
    },
    github: { tokenCommand: tokenCommand as string[] },
    sandbox: {
      roleUser: text(sandbox["roleUser"], "sandbox.roleUser"),
      piExecutable: text(sandbox["piExecutable"], "sandbox.piExecutable"),
      piAgentDirectory: text(sandbox["piAgentDirectory"], "sandbox.piAgentDirectory"),
      ...(template ? { template } : {}),
      ...(piAuthFile ? { piAuthFile: resolve(base, piAuthFile) } : {}),
    },
    profiles,
    testCommands: testCommands as string[],
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function resolve(base: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}
