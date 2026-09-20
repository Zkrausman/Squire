import { PhaseExecutionError, classifyExecutionFailure } from "./execution-failure.js";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { persistWindowsPhaseInput } from "./windows-launch.js";
import { PhaseInputTransport, guardPayload, launchProtected, transportBinding, checkTransportCommand, PHASE_GUARD } from "./phase-input-transport.js";
import { supervisorEnvironment } from "./plan-supervisor-runner.js";
import type { CommandPort } from "./command.js";
import { composeSystemPrompt, validateLaunchMaterial, type LaunchMaterial } from "./launch-material.js";
import { validatePhaseProfile } from "./model-policy.js";
import { validateExecutablePlan } from "./prompt-policy.js";
import { digestArtifact, validateRequirements, validateDesign, type RequirementsArtifact, type DesignArtifact, type PlanChildEvidence, type PlanProgress } from "./plan-artifacts.js";
import { validatePhaseResultShape } from "./phase-result.js";
import type { PhaseInput, PlanPhaseResult } from "./types.js";

export interface PlanSupervisorOptions {
  readonly stagingRoot: string;
  readonly testCommands: readonly string[];
  readonly roleUser?: string;
  readonly piExecutable?: string;
  readonly piAgentDirectory?: string;
  readonly sbxExecutable?: string;
  readonly timeoutMs?: number;
  readonly launchMaterial: LaunchMaterial;
}

/** No state, ticket, publisher, model-selection, or agent-launch authority is injected. */
export async function supervisePlan(input: PhaseInput, options: PlanSupervisorOptions, commands: CommandPort, signal: AbortSignal, progress: (event: PlanProgress) => Promise<void>): Promise<PlanPhaseResult> {
  const material = validateLaunchMaterial(options.launchMaterial);
  validateExecutablePlan(material.config.promptPolicy!.plan);
  if (input.phase !== "plan" || material.config.promptPolicy!.plan.length !== 2) throw new Error("supervisor requires selected Plan children");
  const profile = validatePhaseProfile(input.profile);
  const supervisorId = randomUUID();
  const root = `/run/squire-plan-${supervisorId}`;
  const local = path.join(options.stagingRoot, input.runId, "plan", String(input.attempt), supervisorId);
  if (process.platform !== "win32") await mkdir(local, { recursive: true, mode: 0o700 });
  const writeStaged = async (file: string, bytes: string) => {
    if (process.platform === "win32") persistWindowsPhaseInput(file, bytes);
    else await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  };
  const sbx = options.sbxExecutable ?? "sbx";
  const transport = new PhaseInputTransport(options.stagingRoot);
  checkTransportCommand(commands, { command: sbx, args: [PHASE_GUARD], env: supervisorEnvironment(), stdin: Buffer.from(JSON.stringify({ input, options })) });
  await transport.preflight();
  const deadline = Date.now() + (options.timeoutMs ?? 3600000);
  const exec = (script: string, cancellation?: AbortSignal) => commands.run({ command: sbx, args: ["exec", "-u", "root", input.sandbox, "sh", "-lc", script], env: supervisorEnvironment(), sanitized: true, timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024 }, cancellation);
  const publish = async (destination: string, data: string) => {
    const request = { command: sbx, args: ["exec", "-i", "-u", "root", input.sandbox, "node", "-e", "const fs=require('node:fs');const b=[];process.stdin.on('data',c=>b.push(c));process.stdin.on('end',()=>{fs.mkdirSync(require('node:path').dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],Buffer.concat(b),{flag:'wx',mode:0o444});});", destination], stdin: Buffer.from(data), env: supervisorEnvironment(), sanitized: true, timeoutMs: 30000 };
    checkTransportCommand(commands, request);
    await commands.run(request, signal);
  };
  const check = async () => {
    const result = await exec("git -c safe.directory=/ticket/workspace -C /ticket/workspace rev-parse HEAD; git -c safe.directory=/ticket/workspace -C /ticket/workspace status --porcelain --untracked-files=all");
    if (result.stdout.trim() !== input.expectedHead) throw new Error("Plan repository HEAD/cleanliness mismatch");
  };
  const children: PlanChildEvidence[] = [];
  let requirements: RequirementsArtifact | undefined;
  let design: DesignArtifact | undefined;
  let diagnostic: string | undefined;
  let executionError: unknown;
  try {
    await exec(`set -eu; mkdir -m 755 ${sh(root)}; mkdir -m 700 ${sh(root + "/control")}; mkdir -m 755 ${sh(root + "/artifacts")}`, signal);
    for (const subphase of material.config.promptPolicy!.plan) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) throw new PhaseExecutionError("timeout", "Plan deadline exceeded");
      await check();
      await progress({ runId: input.runId, attempt: input.attempt, subphase });
      signal.throwIfAborted();
      const sessionId = randomUUID();
      const sessionFile = `/ticket/sessions/plan/${input.attempt}/${subphase}.jsonl`;
      const prompt = composeSystemPrompt(material, "plan", subphase);
      const base = { subphase, sessionId, sessionFile, profile, inputHead: input.expectedHead, launchDigest: material.digest, promptDigest: createHash("sha256").update(prompt).digest("hex") };
      try {
        const home = `/ticket/runtime/home/plan/${input.attempt}/${subphase}`;
        const temporary = `/ticket/runtime/tmp/plan/${input.attempt}/${subphase}`;
        const control = `${root}/control/${subphase}`;
        await exec(`set -eu; mkdir -m 700 ${sh(control)}; mkdir -p ${sh(path.posix.dirname(sessionFile))} ${sh(home)} ${sh(temporary)}; chown -R ${sh(options.roleUser ?? "1000:1000")} ${sh(path.posix.dirname(sessionFile))} ${sh(home)} ${sh(temporary)}`, signal);
        const copy = async (name: string, value: unknown, destination: string) => {
          await writeStaged(path.join(local, name), JSON.stringify(value));
          await publish(destination, JSON.stringify(value));
        };
        const data = JSON.stringify({ ...input, subphase, sessionId, sessionFile, testCommands: options.testCommands, launchDigest: material.digest, systemPromptDigest: base.promptDigest, ...(requirements ? { requirements: { content: requirements, digest: digestArtifact(requirements) } } : {}) });
        const role = (options.roleUser ?? "1000:1000").split(":").map(Number);
        if (role.length !== 2 || role.some(n => !Number.isInteger(n) || n <= 0)) throw new Error("supervised Plan requires a non-root numeric uid:gid");
        const config = { control, cwd: "/ticket/workspace", uid: role[0]!, gid: role[1]!, deadline, executable: options.piExecutable ?? "pi", env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, TMPDIR: temporary, PI_CODING_AGENT_DIR: options.piAgentDirectory ?? "/ticket/runtime/pi-agent", PI_OFFLINE: "1", PI_TELEMETRY: "0" }, args: ["--print", "--mode", "text", "--session", sessionFile, "--provider", profile.provider, "--model", profile.model, "--thinking", profile.thinking, "--tools", "read,grep,find,ls", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve"] };
        const binding = transportBinding(input, subphase);
        const payload = guardPayload(binding, config, prompt, data);
        const output = await launchProtected(commands, transport, binding, payload, sbx, input.sandbox, supervisorEnvironment(), Math.max(1, deadline - Date.now()) + 10000, signal);
        const raw = output.stdout;
        signal.throwIfAborted();
        let artifact: unknown;
        try {
        try { artifact = JSON.parse(raw); } catch { throw new Error("Plan child wrote malformed artifact JSON"); }
        if (subphase === "requirements") { validateRequirements(artifact, input.expectedHead); requirements = artifact; }
        else { validateDesign(artifact, input.expectedHead, digestArtifact(requirements)); design = artifact; }
        } catch (error) { throw new PhaseExecutionError("protocol", String(error), { cause: error }); }
        await check();
        const artifactPath = `${root}/artifacts/${subphase}.json`;
        await copy(`${subphase}.json`, artifact, artifactPath);
        children.push({ ...base, outcome: "passed", diagnostic: null, artifact: { path: artifactPath, digest: digestArtifact(artifact), content: artifact as RequirementsArtifact | DesignArtifact } });
      } catch (error) {
        // Independent post-exit Git inspection applies even to malformed JSON,
        // failed launches and cancelled transport, without an aborted signal.
        let message = error instanceof Error ? error.message : String(error);
        try { await check(); } catch (gitError) { message += `; ${String(gitError)}`; }
        children.push({ ...base, outcome: "failed", diagnostic: message.slice(0, 8000), artifact: null });
        throw new PhaseExecutionError(classifyExecutionFailure(error, signal), message, { cause: error });
      }
      if (requirements?.readiness === "needs_clarification") break;
    }
  } catch (error) { executionError = error; diagnostic = (error instanceof Error ? error.message : String(error)).slice(0, 6000); }
  if (signal.aborted || Date.now() >= deadline) diagnostic ??= "Plan interrupted or deadline exceeded";
  if ((executionError instanceof PhaseExecutionError && executionError.classification === "infrastructure") || (input.escalationDigest && diagnostic)) throw executionError ?? new PhaseExecutionError(signal.aborted ? "cancelled" : "timeout", diagnostic ?? "Plan transport failure");
  const outcome = diagnostic ? "failed" : requirements?.readiness === "needs_clarification" ? "needs_clarification" : design ? "ready" : "failed";
  const result: PlanPhaseResult = {
    runId: input.runId, phase: "plan", attempt: input.attempt, sessionId: supervisorId,
    // Compatibility slot identifies the deterministic lifecycle, NOT a model session.
    sessionFile: `/ticket/sessions/plan/${input.attempt}.jsonl`, inputHead: input.expectedHead, outputHead: input.expectedHead, profile,
    status: outcome === "ready" ? "passed" : "failed",
    summary: diagnostic ?? (outcome === "needs_clarification" ? `Plan needs clarification: ${requirements!.openQuestions.join("; ")}`.slice(0, 8000) : "Requirements and Implementation Design validated"),
    details: { steps: design?.steps ?? ["Resolve Plan blockers before Implement."], supervision: { version: 1, supervisorId, outcome, launchDigest: material.digest, children } },
  };
  validatePhaseResultShape(result, "plan");
  const journal = path.join(local, "result.json");
  await writeStaged(journal, `${JSON.stringify(result)}\n`);
  // The compatibility session slot is a supervisor journal, not a Pi session.
  // A stopped attempt may have only the host aggregate, like a failed Pi launch.
  if (result.status === "passed") {
    await publish(result.sessionFile, `${JSON.stringify(result)}\n`);
  }
  return result;
}
function sh(value: string): string { if (value.includes("\0")) throw new Error("NUL shell value"); return `'${value.replaceAll("'", `'"'"'`)}'`; }

export { PHASE_GUARD as REMOTE_GUARD } from "./phase-input-transport.js";
