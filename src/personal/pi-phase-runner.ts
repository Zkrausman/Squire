import { performance } from "node:perf_hooks";
import { createReportEvidence, decodeReport, type ReportEvidencePort } from "./report-evidence.js";
import { InvalidPhaseHandoff, CorrectionExecutionFailure, correctionSchema, REPORT_CORRECTION_CORE, type ReportCapture, type ReportCorrectionInput } from "./report-correction.js";
import { PhaseExecutionError } from "./execution-failure.js";
import { PlanSupervisorRunner } from "./plan-supervisor-runner.js";
import { validateExecutablePlan } from "./prompt-policy.js";
import type { PlanProgress } from "./plan-artifacts.js";
import { createHash, randomUUID } from "node:crypto";
import { composeSystemPrompt, validateLaunchMaterial, type LaunchMaterial } from "./launch-material.js";
import { PhaseInputTransport, guardPayload, launchProtected, transportBinding } from "./phase-input-transport.js";
import { supervisorEnvironment } from "./plan-supervisor-runner.js";
import path from "node:path";
import { CommandExecutionError, type CommandPort } from "./command.js";
import { parsePhaseResult } from "./phase-payload.js";
import { validatePhaseProfile, type PhaseProfile } from "./model-policy.js";
import type { PhaseInput, PhasePort, PhaseResult } from "./types.js";

export type { PhaseProfile } from "./model-policy.js";

export interface SandboxPiPhaseRunnerOptions {
  readonly commands: CommandPort;
  readonly stagingRoot: string;
  readonly testCommands: readonly string[];
  readonly roleUser?: string;
  readonly piExecutable?: string;
  readonly piAgentDirectory?: string;
  readonly sbxExecutable?: string;
  readonly timeoutMs?: number;
  readonly launchMaterial?: LaunchMaterial;
}

export class SandboxPiPhaseRunner implements PhasePort {
  readonly reportEvidence: ReportEvidencePort;
  readonly #captures = new WeakMap<PhaseResult, ReportCapture>();
  #correctionPrepared = false;
  readonly #supervisor: PlanSupervisorRunner | undefined;
  readonly #commands: CommandPort;
  readonly #stagingRoot: string;
  readonly #testCommands: readonly string[];
  readonly #roleUser: string;
  readonly #pi: string;
  readonly #agentDirectory: string;
  readonly #sbx: string;
  readonly #timeoutMs: number;
  readonly #material: LaunchMaterial | undefined;

  constructor(options: SandboxPiPhaseRunnerOptions) {
    this.#material = options.launchMaterial === undefined ? undefined : validateLaunchMaterial(options.launchMaterial);
    if (this.#material) validateExecutablePlan(this.#material.config.promptPolicy!.plan);
    const { commands: _commands, ...supervisorOptions } = options;
    this.#supervisor = this.#material?.config.promptPolicy!.plan.length ? new PlanSupervisorRunner({ ...supervisorOptions, launchMaterial: this.#material }, this) : undefined;
    this.#commands = options.commands;
    this.#stagingRoot = path.resolve(options.stagingRoot);
    this.reportEvidence = createReportEvidence(path.join(this.#stagingRoot, "report-evidence"));
    this.#testCommands = Object.freeze([...options.testCommands]);
    this.#roleUser = options.roleUser ?? "1000:1000";
    this.#pi = options.piExecutable ?? "pi";
    this.#agentDirectory = options.piAgentDirectory ?? "/ticket/runtime/pi-agent";
    this.#sbx = options.sbxExecutable ?? "sbx";
    this.#timeoutMs = options.timeoutMs ?? 60 * 60 * 1_000;
  }

  async run(input: PhaseInput, signal?: AbortSignal, onProgress?: (progress: PlanProgress) => Promise<void>): Promise<PhaseResult> {
    if (input.phase === "plan" && this.#supervisor) return this.#supervisor.run(input, signal, onProgress);
    // Validate the controller-bound profile before creating any staging or
    // sandbox artifacts. A malformed profile must not partially launch a
    // phase with an ambiguous model identity.
    const deadline = input.deadline ?? performance.now() + this.#timeoutMs;
    const profile = validatePhaseProfile(input.profile, `${input.phase} input profile`);
    const sessionId = input.reportSession?.sessionId ?? randomUUID();
    const phaseDirectory = `/ticket/sessions/${input.phase}`;
    const sessionFile = `${phaseDirectory}/${input.attempt}.jsonl`;
    const prompt = composeSystemPrompt(this.#material, input.phase);
    const data = JSON.stringify({ ...input, sessionId, sessionFile, testCommands: this.#testCommands, launchDigest: this.#material?.digest, systemPromptDigest: createHash("sha256").update(prompt).digest("hex") });
    const home = `/ticket/runtime/home/${input.phase}`;
    const temporary = `/ticket/runtime/tmp/${input.phase}`;
    const control = `/run/squire-control-${randomUUID()}`;
    const prepare = `set -eu; mkdir -m 700 ${sh(control)}; mkdir -p ${sh(phaseDirectory)} ${sh(home)} ${sh(temporary)} ${sh(this.#agentDirectory)}; chown -R ${sh(this.#roleUser)} ${sh(phaseDirectory)} ${sh(home)} ${sh(temporary)} ${sh(this.#agentDirectory)}`;
    const prepareLaunch = () => this.#commands.run({ command: this.#sbx, args: ["exec", "-u", "root", input.sandbox, "sh", "-lc", prepare], env: supervisorEnvironment(), sanitized: true, timeoutMs: remaining(deadline) }, signal).then(() => {});
    const tools = input.phase === "implement"
      ? "read,grep,find,ls,bash,edit,write"
      : input.phase === "plan" || input.phase === "retro"
        ? "read,grep,find,ls"
        : "read,grep,find,ls,bash";
    const args = [
      "--print",
      "--mode", "text",
      "--session", sessionFile,
      "--provider", profile.provider,
      "--model", profile.model,
      "--thinking", profile.thinking,
      "--tools", tools,
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-approve",
    ];
    const role = this.#role();
    const binding = transportBinding(input);
    const payload = guardPayload(binding, { control, cwd: "/ticket/workspace", ...role, deadline: Date.now() + remaining(deadline), executable: this.#pi,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, TMPDIR: temporary, PI_CODING_AGENT_DIR: this.#agentDirectory, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, args }, prompt, data);
    const output = await launchProtected(this.#commands, new PhaseInputTransport(this.#stagingRoot), binding, payload, this.#sbx, input.sandbox, supervisorEnvironment(), remaining(deadline), signal, prepareLaunch).catch(async error => {
      if (error instanceof CommandExecutionError && error.stdoutBytes) throw new CorrectionExecutionFailure(await this.#capture(error.stdoutBytes, sessionId, sessionFile), error);
      throw error;
    });

    const capture = await this.#capture(output.stdoutBytes, sessionId, sessionFile);
    try {
      const result = parsePhaseResult(decodeReport(output.stdoutBytes!), input, sessionId, sessionFile, profile);
      this.#captures.set(result, capture);
      return result;
    } catch (error) { throw new InvalidPhaseHandoff(capture, String(error)); }
  }
  #role(): { uid: number; gid: number } {
    const role = this.#roleUser.split(":").map(Number);
    if (role.length !== 2 || role.some(n => !Number.isInteger(n) || n <= 0)) throw new PhaseExecutionError("infrastructure", "phase_transport requires non-root numeric uid:gid");
    return { uid: role[0]!, gid: role[1]! };
  }
  reportCapture(result: PhaseResult): ReportCapture | undefined { return this.#captures.get(result); }
  async prepareReportCorrection(): Promise<void> {
    if (this.#commands.byteOutput !== true || this.#commands.byteInput !== true) throw new PhaseExecutionError("infrastructure", "Report evidence requires byte-capable command transport; use NodeCommandRunner, not decoded stdout adapters");
    await this.reportEvidence.preflight?.();
    this.#correctionPrepared = true;
  }
  async #capture(bytes: Buffer | undefined, sessionId: string, sessionFile: string): Promise<ReportCapture> {
    if (!Buffer.isBuffer(bytes)) throw new PhaseExecutionError("infrastructure", "Report evidence requires exact stdout bytes; configure byte-capable command transport (NodeCommandRunner)");
    return Object.freeze({ raw: bytes.toString("utf8"), sessionId, sessionFile, timestamp: new Date().toISOString(), evidence: await this.reportEvidence.write(bytes) });
  }

  async correctReport(request: ReportCorrectionInput, signal?: AbortSignal): Promise<ReportCapture> {
    signal?.throwIfAborted();
    remaining(request.deadline);
    if (!this.#correctionPrepared) await this.prepareReportCorrection();
    this.#correctionPrepared = false;
    const sessionId = request.producerId;
    if (!/^[a-f0-9-]{36}$/u.test(sessionId)) throw new Error("invalid correction producer identity");
    const root = `/run/squire-report-${sessionId}`;
    // Fresh root-owned context, not the implementation home/session. No
    // extensions/context files or tools. Pi may lock/refresh only its separate
    // auth copy in the private runtime directory; no implementation resources
    // or writable workspace artifacts are supplied to the model.
    const control = `/run/squire-control-${randomUUID()}`;
    const prepare = `set -eu; mkdir -m 700 ${sh(control)}; mkdir -m 755 ${sh(root)}; mkdir -m 700 ${sh(root + "/agent")} ${sh(root + "/tmp")}; cp ${sh(this.#agentDirectory + "/auth.json")} ${sh(root + "/agent/auth.json")}; chown -R ${sh(this.#roleUser)} ${sh(root + "/agent")} ${sh(root + "/tmp")}; chmod 600 ${sh(root + "/agent/auth.json")}`;
    const profile = validatePhaseProfile(request.input.profile);
    const prompt = REPORT_CORRECTION_CORE;
    const data = JSON.stringify({ schema: correctionSchema(request.input, request.original), diagnostic: request.diagnostic, diagnostics: request.diagnostics,
      trusted: { runId: request.input.runId, phase: request.input.phase, attempt: request.input.attempt, inputHead: request.input.expectedHead, originalTicketBaseSha: request.input.originalTicketBaseSha, profile, sessionId: request.original.sessionId, sessionFile: request.original.sessionFile },
      original: request.original, latestReference: request.latest.evidence, correctionAttempt: request.correctionAttempt });
    const prepareLaunch = () => this.#commands.run({ command: this.#sbx, args: ["exec", "-u", "root", request.input.sandbox, "sh", "-lc", prepare], env: supervisorEnvironment(), sanitized: true, timeoutMs: remaining(request.deadline) }, signal).then(() => {});
    const binding = transportBinding(request.input, null, request.producerId);
    const payload = guardPayload(binding, { control, cwd: root, ...this.#role(), deadline: Date.now() + remaining(request.deadline), executable: this.#pi,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: root, TMPDIR: `${root}/tmp`, PI_CODING_AGENT_DIR: `${root}/agent`, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      args: ["--print", "--mode", "text", "--no-session", "--provider", profile.provider, "--model", profile.model, "--thinking", profile.thinking,
        "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve"] }, prompt, data);
    const output = await launchProtected(this.#commands, new PhaseInputTransport(this.#stagingRoot), binding, payload, this.#sbx, request.input.sandbox, supervisorEnvironment(), remaining(request.deadline), signal, prepareLaunch).catch(async error => {
      if (error instanceof CommandExecutionError) throw new CorrectionExecutionFailure(await this.#capture(error.stdoutBytes, sessionId, `${root}/no-session`), error);
      throw error;
    });
    return this.#capture(output.stdoutBytes, sessionId, `${root}/no-session`);
  }
}

function sh(value: string): string {
  if (value.includes("\0")) throw new Error("shell value contains NUL");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function remaining(deadline: number): number {
  const ms = Math.floor(deadline - performance.now());
  if (!Number.isFinite(ms) || ms <= 0) throw new PhaseExecutionError("timeout", "original phase deadline exhausted");
  return ms;
}
