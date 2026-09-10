import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandPort } from "./command.js";
import { validatePhaseResultShape } from "./phase-result.js";
import type { PersonalPhase, PhaseInput, PhasePort, PhaseResult } from "./types.js";

export interface PhaseProfile {
  readonly provider: string;
  readonly model: string;
  readonly thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface SandboxPiPhaseRunnerOptions {
  readonly commands: CommandPort;
  readonly stagingRoot: string;
  readonly profiles: Readonly<Record<PersonalPhase, PhaseProfile>>;
  readonly testCommands: readonly string[];
  readonly roleUser?: string;
  readonly piExecutable?: string;
  readonly piAgentDirectory?: string;
  readonly sbxExecutable?: string;
  readonly timeoutMs?: number;
}

export class SandboxPiPhaseRunner implements PhasePort {
  readonly #commands: CommandPort;
  readonly #stagingRoot: string;
  readonly #profiles: Readonly<Record<PersonalPhase, PhaseProfile>>;
  readonly #testCommands: readonly string[];
  readonly #roleUser: string;
  readonly #pi: string;
  readonly #agentDirectory: string;
  readonly #sbx: string;
  readonly #timeoutMs: number;

  constructor(options: SandboxPiPhaseRunnerOptions) {
    this.#commands = options.commands;
    this.#stagingRoot = path.resolve(options.stagingRoot);
    this.#profiles = options.profiles;
    this.#testCommands = options.testCommands;
    this.#roleUser = options.roleUser ?? "1000:1000";
    this.#pi = options.piExecutable ?? "pi";
    this.#agentDirectory = options.piAgentDirectory ?? "/ticket/runtime/pi-agent";
    this.#sbx = options.sbxExecutable ?? "sbx";
    this.#timeoutMs = options.timeoutMs ?? 60 * 60 * 1_000;
  }

  async run(input: PhaseInput, signal?: AbortSignal): Promise<PhaseResult> {
    const sessionId = randomUUID();
    const phaseDirectory = `/ticket/sessions/${input.phase}`;
    const sessionFile = `${phaseDirectory}/${input.attempt}.jsonl`;
    const inputPath = `/ticket/artifacts/inputs/${input.phase}-${input.attempt}.json`;
    const localDirectory = path.join(this.#stagingRoot, input.runId, "phase-inputs");
    const localInput = path.join(localDirectory, `${input.phase}-${input.attempt}.json`);
    await mkdir(localDirectory, { recursive: true, mode: 0o700 });
    await writeFile(localInput, `${JSON.stringify({ ...input, sessionId, sessionFile }, null, 2)}\n`, { mode: 0o600 });

    await this.#commands.run({ command: this.#sbx, args: ["cp", localInput, `${input.sandbox}:${inputPath}`] }, signal);
    const home = `/ticket/runtime/home/${input.phase}`;
    const temporary = `/ticket/runtime/tmp/${input.phase}`;
    const prepare = `set -eu; mkdir -p ${sh(phaseDirectory)} ${sh(home)} ${sh(temporary)} ${sh(this.#agentDirectory)}; chown -R ${sh(this.#roleUser)} ${sh(phaseDirectory)} ${sh(home)} ${sh(temporary)} ${sh(this.#agentDirectory)} /ticket/artifacts`;
    await this.#commands.run({ command: this.#sbx, args: ["exec", "-u", "root", input.sandbox, "sh", "-lc", prepare] }, signal);

    const profile = this.#profiles[input.phase];
    const tools = input.phase === "implement"
      ? "read,grep,find,ls,bash,edit,write"
      : input.phase === "plan" || input.phase === "retro"
        ? "read,grep,find,ls"
        : "read,grep,find,ls,bash";
    const prompt = buildPrompt(input.phase, inputPath, this.#testCommands);
    const environment = [
      "/usr/bin/env", "-i",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      `HOME=${home}`,
      `TMPDIR=${temporary}`,
      `PI_CODING_AGENT_DIR=${this.#agentDirectory}`,
      "PI_OFFLINE=1",
      "PI_TELEMETRY=0",
      this.#pi,
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
      "--approve",
      prompt,
    ];
    const output = await this.#commands.run({
      command: this.#sbx,
      args: ["exec", "-u", this.#roleUser, "-w", "/ticket/workspace", input.sandbox, ...environment],
      timeoutMs: this.#timeoutMs,
      maxOutputBytes: 2 * 1024 * 1024,
    }, signal);

    await rm(localInput, { force: true });
    return parsePhaseResult(output.stdout, input, sessionId, sessionFile);
  }
}

function buildPrompt(phase: PersonalPhase, inputPath: string, testCommands: readonly string[]): string {
  const responsibility: Record<PersonalPhase, string> = {
    plan: "Analyze the ticket and repository. Do not modify the repository. Produce an actionable implementation plan in summary/details and return passed.",
    implement: "Implement the plan or supplied remediation feedback. Run appropriate checks and commit all intended repository changes before returning passed.",
    review: "Independently inspect the current commit for correctness and scope. Do not modify it. Return passed or remediation_required with concrete findings.",
    test: `Independently run the configured validation commands and do not modify the commit. Commands: ${testCommands.join("; ")}. Return passed or remediation_required with failures.`,
    retro: "Reflect on the completed work and all prior phase results. Do not modify the repository. Return passed with concrete lessons and any proposed follow-ups; do not create tickets or mutate a wiki.",
  };
  return [
    `You are the independent Squire ${phase} phase.`,
    responsibility[phase],
    `Read your complete JSON input from ${inputPath}.`,
    "Return exactly one JSON object as your final response and no other text.",
    `Use details ${detailsShape(phase)}.`,
    '{"runId":"...","phase":"plan|implement|review|test|retro","attempt":1,"sessionId":"...","sessionFile":"...","inputHead":"40-hex","outputHead":"40-hex","status":"passed|remediation_required|failed","summary":"...","details":{}}',
    "Copy run/phase/attempt/session/inputHead identities exactly from the input. Set outputHead to `git rev-parse HEAD` after your work. Do not wrap JSON in markdown.",
  ].join("\n\n");
}

function detailsShape(phase: PersonalPhase): string {
  if (phase === "plan") return '{"steps":["ordered actionable step"]}';
  if (phase === "implement") return '{"changes":["implemented change"]}';
  if (phase === "review") return '{"findings":[]} (empty only when passed)';
  if (phase === "test") return '{"commands":[{"command":"npm test","exitCode":0,"summary":"passed"}]}';
  return '{"lessons":["concrete lesson"],"followUps":["optional proposed follow-up"]}';
}

function parsePhaseResult(raw: string, input: PhaseInput, sessionId: string, sessionFile: string): PhaseResult {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`${input.phase} wrote malformed result JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${input.phase} result is not an object`);
  validatePhaseResultShape(value, input.phase);
  const result = value as PhaseResult;
  if (result.runId !== input.runId || result.phase !== input.phase || result.attempt !== input.attempt || result.sessionId !== sessionId || result.sessionFile !== sessionFile) throw new Error(`${input.phase} result identity mismatch`);
  if (result.inputHead !== input.expectedHead) throw new Error(`${input.phase} result Git identity mismatch`);
  return result;
}

function sh(value: string): string {
  if (value.includes("\0")) throw new Error("shell value contains NUL");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
