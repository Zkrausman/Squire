import path from "node:path";
import type { Role, SessionRegistration } from "../control/domain.js";
import type { ProcessLaunch } from "./pi-process.js";

export interface PiRoleConfig { provider: string; model: string; instructionsPath: string; timeoutSeconds?: number }
export interface PiCommandOptions { piBinary: string; instructions: string; workspace?: string; sessionRoot?: string; role: Role; config: PiRoleConfig; registration?: SessionRegistration }

export function buildPiCommand(options: PiCommandOptions): ProcessLaunch {
  const workspace = options.workspace ?? "/ticket/workspace";
  const roleDir = path.posix.join(options.sessionRoot ?? "/ticket/sessions", options.role);
  const args = ["--mode", "rpc", "--provider", options.config.provider, "--model", options.config.model, "--append-system-prompt", options.instructions, "--name", `Squire ${options.role}`];
  if (options.registration) args.push("--session", options.registration.sessionFile);
  else args.push("--session-dir", roleDir);
  return { command: options.piBinary, args, cwd: workspace, env: { PI_SKIP_VERSION_CHECK: "1" } };
}

export function assertSafeResumeArgs(args: readonly string[], expectedFile: string): void {
  for (const forbidden of ["--continue", "--resume", "--fork", "--clone"]) if (args.includes(forbidden)) throw new Error(`forbidden session option: ${forbidden}`);
  const at = args.indexOf("--session");
  if (at < 0 || args[at + 1] !== expectedFile || args.filter(a => a === "--session").length !== 1) throw new Error("resume must use exactly the registered session file");
}
