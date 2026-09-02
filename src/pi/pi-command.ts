import path from "node:path";
import type { Role, SessionRegistration } from "../control/domain.js";
import type { ProcessLaunch } from "./pi-process.js";
import { normalizeRoleConfig, type PiRoleConfig } from "./pi-configuration.js";

export type { PiRoleConfig } from "./pi-configuration.js";

export interface PiCommandOptions {
  piBinary: string;
  instructions: string;
  workspace?: string;
  sessionRoot?: string;
  role: Role;
  config: PiRoleConfig;
  registration?: SessionRegistration;
  /** Run-scoped agent directory produced by the trusted materializer. */
  agentDir?: string;
  /** Run-scoped HOME containing no host/personal state. */
  homeDir?: string;
  /** Run-scoped WIKI_HOME containing no host/personal state. */
  wikiHomeDir?: string;
  /** Ordered [wiki extension, Squire footer extension] trusted paths. */
  trustedExtensionPaths?: readonly string[];
}

export function buildPiCommand(options: PiCommandOptions): ProcessLaunch {
  const workspace = options.workspace ?? "/ticket/workspace";
  const roleDir = path.posix.join(options.sessionRoot ?? "/ticket/sessions", options.role);
  const config = normalizeRoleConfig(options.role, options.config);
  const args = [
    "--mode", "rpc",
    "--provider", config.provider,
    "--model", config.model,
    "--thinking", config.thinking,
    "--append-system-prompt", options.instructions,
    "--name", `Squire ${options.role}`,
  ];
  if (options.registration) args.push("--session", options.registration.sessionFile);
  else args.push("--session-dir", roleDir);

  if (options.agentDir !== undefined && (!options.homeDir || !options.wikiHomeDir)) {
    throw new Error("trusted Pi launch requires run-scoped HOME and WIKI_HOME");
  }
  if ((options.homeDir === undefined) !== (options.wikiHomeDir === undefined)) {
    throw new Error("Pi HOME and WIKI_HOME must be supplied together");
  }

  if (options.trustedExtensionPaths?.length) {
    // Explicit extensions are additive even with --no-extensions. Disable every
    // discovered project resource so a repository cannot replace the trusted
    // footer or inject a different wiki model through local Pi resources.
    args.push("--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve");
    for (const extension of options.trustedExtensionPaths) args.push("--extension", extension);
  }
  const env: Record<string, string> = { PI_SKIP_VERSION_CHECK: "1" };
  if (options.agentDir !== undefined) env["PI_CODING_AGENT_DIR"] = options.agentDir;
  if (options.homeDir !== undefined && options.wikiHomeDir !== undefined) {
    env["HOME"] = options.homeDir;
    env["WIKI_HOME"] = options.wikiHomeDir;
  }
  return { command: options.piBinary, args, cwd: workspace, env };
}

export function assertSafeResumeArgs(args: readonly string[], expectedFile: string): void {
  for (const forbidden of ["--continue", "--resume", "--fork", "--clone"]) if (args.includes(forbidden)) throw new Error(`forbidden session option: ${forbidden}`);
  const at = args.indexOf("--session");
  if (at < 0 || args[at + 1] !== expectedFile || args.filter(a => a === "--session").length !== 1) throw new Error("resume must use exactly the registered session file");
}
