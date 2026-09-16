import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { canonical, composeSystemPrompt, validateLaunchMaterial } from "./launch-material.js";
import { closed, validatePlanProgress, type PlanProgress } from "./plan-artifacts.js";
import { validatePhaseResultShape } from "./phase-result.js";
import { validateExecutablePlan } from "./prompt-policy.js";
import type { PlanSupervisorOptions } from "./plan-supervisor.js";
import type { PhaseInput, PhasePort, PhaseResult } from "./types.js";

const WINDOWS_OS_ENVIRONMENT = ["LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "USERPROFILE", "TEMP", "TMP"] as const;

/**
 * Build the supervisor's transport-only host environment. Windows native sbx
 * needs a few OS locations for settingskit, but no inherited credentials or
 * process overrides may cross this boundary. Keys are normalized because the
 * Windows environment is case-insensitive (and Node can expose its spelling).
 */
export function supervisorEnvironment(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const names = ["PATH", "HOME", ...(platform === "win32" ? WINDOWS_OS_ENVIRONMENT : [])];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const key = Object.keys(source).find(candidate => candidate.toUpperCase() === name);
    if (key && source[key] !== undefined) environment[name] = source[key];
  }
  if (environment["PATH"] === undefined) environment["PATH"] = platform === "win32" ? "C:\\Windows\\System32" : "/usr/local/bin:/usr/bin:/bin";
  return environment;
}

/** The controller sees one child process and one lifecycle/timeout boundary. */
export class PlanSupervisorRunner implements PhasePort {
  readonly #options: PlanSupervisorOptions;
  readonly #legacy: PhasePort;
  constructor(options: PlanSupervisorOptions, legacy: PhasePort) {
    const material = validateLaunchMaterial(options.launchMaterial);
    validateExecutablePlan(material.config.promptPolicy!.plan);
    this.#options = { ...options, launchMaterial: material };
    this.#legacy = legacy;
  }
  async run(input: PhaseInput, signal?: AbortSignal, onProgress?: (event: PlanProgress) => Promise<void>): Promise<PhaseResult> {
    if (input.phase !== "plan" || !this.#options.launchMaterial.config.promptPolicy!.plan.length) return this.#legacy.run(input, signal);
    signal?.throwIfAborted();
    return new Promise<PhaseResult>((resolve, reject) => {
      // Deliberate allowlist: no Linear/GitHub/provider secrets or state directory
      // environment. Provider credentials remain the sandbox's existing bridge.
      const child = fork(new URL("./plan-supervisor-process.js", import.meta.url), [], { env: supervisorEnvironment(), execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let result: PhaseResult | undefined;
      let failure: Error | undefined;
      let cancelled = false;
      let received = 0;
      let events = Promise.resolve();
      let reap: NodeJS.Timeout | undefined;
      const cancel = (reason: Error) => {
        failure ??= reason;
        if (cancelled) return;
        cancelled = true;
        if (child.connected) child.send({ type: "cancel" });
        // Only kill our immediate supervisor, never its sbx/Pi children. An
        // unobserved cleanup is a hard failure, not proof of remote termination.
        reap = setTimeout(() => { failure = new Error("Plan supervisor cleanup/exit unobserved"); child.kill("SIGKILL"); }, 90000);
      };
      const interrupt = () => cancel(new Error("Plan interrupted"));
      signal?.addEventListener("abort", interrupt, { once: true });
      const deadline = setTimeout(() => cancel(new Error("Plan deadline exceeded")), this.#options.timeoutMs ?? 3600000);
      child.on("message", (message: unknown) => {
        events = events.then(async () => {
          if (Buffer.byteLength(JSON.stringify(message)) > 2 * 1024 * 1024) throw new Error("oversized supervisor message");
          const type = (message as { type?: unknown })?.type;
          if (type === "progress") {
            const v = closed(message, ["type", "progress"], "supervisor progress");
            validatePlanProgress(v["progress"]);
            const p = v["progress"];
            if (result || cancelled || p.runId !== input.runId || p.attempt !== input.attempt || p.subphase !== ["requirements", "implementation-design"][received++]) throw new Error("stale or unordered Plan progress");
            await onProgress?.(p);
            if (child.connected && !cancelled) child.send({ type: "ack" });
          } else if (type === "result") {
            const v = closed(message, ["type", "result"], "supervisor result");
            if (result) throw new Error("duplicate supervisor result");
            validatePhaseResultShape(v["result"], "plan");
            const r = v["result"];
            if (r.phase !== "plan" || !r.details.supervision || r.runId !== input.runId || r.attempt !== input.attempt || r.inputHead !== input.expectedHead || r.outputHead !== input.expectedHead || canonical(r.profile) !== canonical(input.profile) || r.details.supervision.launchDigest !== this.#options.launchMaterial.digest) throw new Error("supervisor result binding mismatch");
            for (const c of r.details.supervision.children) {
              const prompt = composeSystemPrompt(this.#options.launchMaterial, "plan", c.subphase);
              if (c.promptDigest !== createHash("sha256").update(prompt).digest("hex")) throw new Error("supervisor captured prompt mismatch");
            }
            if (r.details.supervision.children.length > received) throw new Error("missing supervisor progress");
            result = r;
          } else {
            const v = closed(message, ["type", "message"], "supervisor error");
            if (type !== "error" || typeof v["message"] !== "string" || v["message"].length > 8000) throw new Error("invalid supervisor message");
            throw new Error(v["message"]);
          }
        }).catch(error => cancel(error instanceof Error ? error : new Error(String(error))));
      });
      child.once("error", error => cancel(error));
      child.once("exit", (code, exitSignal) => {
        if (code !== 0 || exitSignal) failure ??= new Error("Plan supervisor exited unsuccessfully");
        void events.finally(() => {
          clearTimeout(deadline); clearTimeout(reap); signal?.removeEventListener("abort", interrupt);
          if (failure || !result) reject(failure ?? new Error("Plan supervisor exited without aggregate"));
          else resolve(result);
        });
      });
      child.send({ type: "start", input, options: this.#options });
      if (signal?.aborted) interrupt();
    });
  }
}
