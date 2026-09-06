import path from "node:path";
import type { ContractReference, Role, SessionRegistration } from "../control/domain.js";
import { PLAN_ALLOWED_BUILTIN_TOOLS, PLAN_ALLOWED_WIKI_TOOLS, PLAN_TOOL_NAME } from "../plan/domain.js";
import type { ProcessLaunch } from "./pi-process.js";
import { normalizeRoleConfig, type PiRoleConfig } from "./pi-configuration.js";

export type { PiRoleConfig } from "./pi-configuration.js";

export interface PlanLaunchContext {
  readonly runId: string;
  readonly handoffId: string;
  readonly attempt: number;
  readonly targetSessionId: string;
  readonly inputHead: string;
  readonly inputArtifact: ContractReference;
  readonly ticketIdentifier: string;
  readonly completedAt: string;
  readonly allowedValidationCommandIds: readonly string[];
  readonly requiredValidationCommandIds: readonly string[];
  readonly ticketRoot?: string;
}

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
  /** Controller-bound context for the read-only Plan submission extension. */
  planContext?: PlanLaunchContext;
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

  if (options.role === "plan") {
    // AIDEV-223 is not merged at this base: this is a Pi tool allowlist, not
    // an OS sandbox. No shell, edit, write, or privileged Git tool is exposed.
    args.push("--offline", "--tools", [...PLAN_ALLOWED_BUILTIN_TOOLS, ...PLAN_ALLOWED_WIKI_TOOLS, PLAN_TOOL_NAME].join(","));
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
  if (options.role === "plan" && options.planContext) {
    const plan = options.planContext;
    env["SQUIRE_TICKET_ROOT"] = plan.ticketRoot ?? "/ticket";
    env["SQUIRE_PLAN_RUN_ID"] = plan.runId;
    env["SQUIRE_PLAN_HANDOFF_ID"] = plan.handoffId;
    env["SQUIRE_PLAN_ATTEMPT"] = String(plan.attempt);
    env["SQUIRE_PLAN_SESSION_ID"] = plan.targetSessionId;
    env["SQUIRE_PLAN_INPUT_HEAD"] = plan.inputHead;
    env["SQUIRE_PLAN_INPUT_PATH"] = plan.inputArtifact.path;
    env["SQUIRE_PLAN_INPUT_SHA256"] = plan.inputArtifact.sha256;
    env["SQUIRE_PLAN_TICKET_IDENTIFIER"] = plan.ticketIdentifier;
    env["SQUIRE_PLAN_COMPLETED_AT"] = plan.completedAt;
    env["SQUIRE_PLAN_ALLOWED_VALIDATION_COMMAND_IDS"] = JSON.stringify(plan.allowedValidationCommandIds);
    env["SQUIRE_PLAN_REQUIRED_VALIDATION_COMMAND_IDS"] = JSON.stringify(plan.requiredValidationCommandIds);
  }
  return { command: options.piBinary, args, cwd: workspace, env };
}

export function assertSafeResumeArgs(args: readonly string[], expectedFile: string): void {
  for (const forbidden of ["--continue", "--resume", "--fork", "--clone"]) if (args.includes(forbidden)) throw new Error(`forbidden session option: ${forbidden}`);
  const at = args.indexOf("--session");
  if (at < 0 || args[at + 1] !== expectedFile || args.filter(a => a === "--session").length !== 1) throw new Error("resume must use exactly the registered session file");
}
