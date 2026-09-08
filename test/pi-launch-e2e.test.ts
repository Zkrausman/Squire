import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_PI_ROLE_PROFILES, type PiRoleConfig } from "../src/pi/pi-configuration.js";
import { PiAgentDirectoryMaterializer } from "../src/pi/pi-agent-directory.js";
import type { PiProcess, PiProcessFactory, ProcessLaunch } from "../src/pi/pi-process.js";
import { PiRunner } from "../src/pi/pi-runner.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import {
  BoundedRedactionAccumulator,
  BoundedRedactor,
  buildPiChildEnvironment,
  PI_CHILD_OUTPUT_LIMIT_BYTES,
  PI_CHILD_STDERR_LIMIT_BYTES,
  preparePiChildLaunch,
  sanitizeError,
  sanitizeLaunch,
} from "./support/pi-child-support.js";
import { acquireActualPiResource, type ActualPiResourceLease } from "./support/actual-pi-resource.js";
import { run, runtime, testWorkspaceReadiness } from "./support/fixtures.js";

const PI_CLI = "/ticket/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const WIKI_ROOT = "/ticket/runtime/node_modules/@zosmaai/pi-llm-wiki";
const WIKI_EXTENSION = `${WIKI_ROOT}/extensions/llm-wiki/index.ts`;
const WIKI_MODEL = "openai-codex/gpt-5.6-luna";
const PERSONAL_TUI_FOOTER = /^gpt-5\.6-luna · high · 🧠 — · gpt-5\.6-luna · Ready · Full Access · Context \S+\/\S+ · Session est\. \$\d+\.\d{3}$/u;

class ChildPiProcess extends EventEmitter implements PiProcess {
  readonly identity = `child-${randomUUID()}`;
  readonly stdin: PiProcess["stdin"];
  readonly stdout: PiProcess["stdout"];
  readonly stderr: PiProcess["stderr"];
  readonly errors: string[] = [];
  private readonly stdoutTail: BoundedRedactionAccumulator;
  private readonly stderrTail: BoundedRedactionAccumulator;
  private readonly redactor: BoundedRedactor;
  exitCode: number | null = null;
  #exitObserved = false;

  constructor(readonly child: ChildProcess, redactor: BoundedRedactor) {
    super();
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Pi child did not expose piped stdio");
    this.redactor = redactor;
    this.stdoutTail = new BoundedRedactionAccumulator(PI_CHILD_OUTPUT_LIMIT_BYTES, redactor);
    this.stderrTail = new BoundedRedactionAccumulator(PI_CHILD_STDERR_LIMIT_BYTES, redactor);
    this.stdin = { write: data => child.stdin!.write(data) };
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    child.stdout.on("data", chunk => this.stdoutTail.append(chunk));
    child.stderr.on("data", chunk => this.stderrTail.append(chunk));
    child.stdin.on("error", error => this.errors.push(`stdin: ${sanitizeError(error, this.redactor).message}`));
    child.once("error", error => this.errors.push(`child: ${sanitizeError(error, this.redactor).message}`));
    child.once("exit", (code, signal) => {
      this.#exitObserved = true;
      this.exitCode = code ?? (signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 1);
      this.emit("exit", code, signal);
    });
    child.once("close", () => {
      this.stdoutTail.finalize();
      this.stderrTail.finalize();
    });
  }

  get output(): string[] { return [this.stdoutTail.snapshot()]; }

  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this {
    return super.on(event, listener);
  }

  kill(signal: "SIGTERM" | "SIGKILL"): boolean {
    return this.child.kill(signal);
  }

  async waitForExit(timeoutMs: number): Promise<void> {
    if (this.#exitObserved || this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onExit = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(escalationTimer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.off("exit", onExit);
        clearTimeout(escalationTimer);
        reject(new Error("Pi child exit timeout"));
      }, timeoutMs);
      const escalationTimer = setTimeout(() => {
        if (!settled && !this.#exitObserved && this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      }, Math.max(1, Math.floor(timeoutMs * 0.8)));
      this.once("exit", onExit);
      if (this.#exitObserved || this.child.exitCode !== null || this.child.signalCode !== null) onExit();
    });
  }
}

async function reapChild(process: ChildPiProcess): Promise<void> {
  if (process.exitCode === null) process.kill("SIGTERM");
  try {
    await process.waitForExit(4_000);
  } catch (firstError) {
    if (process.exitCode === null) process.kill("SIGKILL");
    try {
      await process.waitForExit(1_000);
    } catch (lastError) {
      throw new AggregateError([firstError, lastError], "Pi child did not reach observed exit within the fixed cleanup budget");
    }
  }
}

class ChildPiProcessFactory implements PiProcessFactory {
  readonly launches: ProcessLaunch[] = [];
  readonly processes: ChildPiProcess[] = [];

  async spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (spawned: PiProcess) => void): Promise<ChildPiProcess> {
    if (signal?.aborted) throw new Error("spawn aborted");
    const prepared = preparePiChildLaunch(spec);
    const child = spawnChild(prepared.command, [...prepared.args], {
      cwd: spec.cwd,
      env: prepared.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const redactor = new BoundedRedactor(process.env, spec.env);
    const spawned = new ChildPiProcess(child, redactor);
    this.launches.push(sanitizeLaunch(spec, prepared.environment, redactor));
    this.processes.push(spawned);
    onSpawn?.(spawned);
    return spawned;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function terminalFrame(output: string, rows = 40, columns = 240): string[] {
  const screen = Array.from({ length: rows }, () => Array.from({ length: columns }, () => " "));
  let row = 0;
  let column = 0;
  let savedRow = 0;
  let savedColumn = 0;
  const clampRow = (value: number): number => Math.max(0, Math.min(rows - 1, value));
  const clampColumn = (value: number): number => Math.max(0, Math.min(columns - 1, value));
  const parameter = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value?.replace(/^[?<>]/u, ""));
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const clearRow = (rowIndex: number, from = 0, to = columns): void => {
    for (let index = Math.max(0, from); index < Math.min(columns, to); index += 1) screen[rowIndex]![index] = " ";
  };
  const clearScreen = (): void => {
    for (const line of screen) line.fill(" ");
  };
  for (let index = 0; index < output.length;) {
    if (output[index] !== "\u001b") {
      const character = output[index]!;
      if (character === "\r") column = 0;
      else if (character === "\n") row = clampRow(row + 1);
      else if (character === "\b") column = clampColumn(column - 1);
      else if (character === "\t") column = clampColumn(column + 3);
      else if (character >= " ") {
        screen[row]![clampColumn(column)] = character;
        column = clampColumn(column + 1);
      }
      index += 1;
      continue;
    }
    if (output[index + 1] === "]" || output[index + 1] === "_") {
      let end = index + 2;
      while (end < output.length && output[end] !== "\u0007" && !(output[end] === "\u001b" && output[end + 1] === "\\")) end += 1;
      index = output[end] === "\u0007" ? end + 1 : output[end] === "\u001b" ? end + 2 : end;
      continue;
    }
    if (output[index + 1] !== "[") {
      index = Math.min(output.length, index + 2);
      continue;
    }
    let end = index + 2;
    while (end < output.length && (output.charCodeAt(end) < 0x40 || output.charCodeAt(end) > 0x7e)) end += 1;
    if (end >= output.length) break;
    const final = output[end]!;
    const body = output.slice(index + 2, end);
    const params = body.split(";");
    const count = parameter(params[0], 1);
    switch (final) {
      case "A": row = clampRow(row - count); break;
      case "B": row = clampRow(row + count); break;
      case "C": column = clampColumn(column + count); break;
      case "D": column = clampColumn(column - count); break;
      case "E": row = clampRow(row + count); column = 0; break;
      case "F": row = clampRow(row - count); column = 0; break;
      case "G": column = clampColumn(count - 1); break;
      case "d": row = clampRow(count - 1); break;
      case "H":
      case "f": row = clampRow(parameter(params[0], 1) - 1); column = clampColumn(parameter(params[1], 1) - 1); break;
      case "J": clearScreen(); break;
      case "K": clearRow(row); break;
      case "P": clearRow(row, column, column + count); break;
      case "X": clearRow(row, column, column + count); break;
      case "@": {
        const amount = Math.min(count, columns - column);
        const line = screen[row]!;
        line.splice(column, amount, ...Array.from({ length: amount }, () => " "));
        break;
      }
      case "s": savedRow = row; savedColumn = column; break;
      case "u": if (!body.startsWith("<")) { row = savedRow; column = savedColumn; } break;
      default: break;
    }
    index = end + 1;
  }
  return screen.map(line => line.join("").trimEnd());
}

function stripTerminalSequences(value: string): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    if (value[index] !== "\u001b") {
      output += value[index];
      index += 1;
      continue;
    }
    if (value[index + 1] === "]" || value[index + 1] === "_") {
      let end = index + 2;
      while (end < value.length && value[end] !== "\u0007" && !(value[end] === "\u001b" && value[end + 1] === "\\")) end += 1;
      index = value[end] === "\u0007" ? end + 1 : value[end] === "\u001b" ? end + 2 : end;
    } else if (value[index + 1] === "[") {
      let end = index + 2;
      while (end < value.length && (value.charCodeAt(end) < 0x40 || value.charCodeAt(end) > 0x7e)) end += 1;
      index = end < value.length ? end + 1 : end;
    } else {
      index = Math.min(value.length, index + 2);
    }
  }
  return output;
}

async function runRealTuiFooterProbe(options: {
  workspace: string;
  agentDir: string;
  homeDir: string;
  wikiHomeDir: string;
  footerPath: string;
  probePath: string;
}): Promise<{ output: string; stderr: string; frame: string[] }> {
  const command = [
    process.execPath,
    PI_CLI,
    "--provider", "openai-codex",
    "--model", "gpt-5.6-luna",
    "--thinking", "high",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    // Observe the real wiki extension's subsequent status calls; this probe
    // never supplies a wiki status itself.
    "--extension", options.probePath,
    "--extension", WIKI_EXTENSION,
    "--extension", options.footerPath,
  ].map(shellQuote).join(" ");
  const ttyCommand = `stty cols 240 rows 40; ${command}`;
  const child = spawnChild("/usr/bin/script", ["-qefc", ttyCommand, "/dev/null"], {
    cwd: options.workspace,
    env: buildPiChildEnvironment({
      HOME: options.homeDir,
      WIKI_HOME: options.wikiHomeDir,
      PI_CODING_AGENT_DIR: options.agentDir,
      PI_OFFLINE: "1",
      TERM: "xterm-256color",
    }),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const redactor = new BoundedRedactor(process.env, {
    HOME: options.homeDir,
    WIKI_HOME: options.wikiHomeDir,
  });
  const outputTail = new BoundedRedactionAccumulator(PI_CHILD_OUTPUT_LIMIT_BYTES, redactor);
  let output = "";
  const stderrTail = new BoundedRedactionAccumulator(PI_CHILD_STDERR_LIMIT_BYTES, redactor);
  let sentExit = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let stableFrame: string[] | undefined;
  const ready = new Promise<{ output: string; stderr: string; frame: string[] }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("real Pi TUI footer probe timed out"));
    }, 30_000);
    const scheduleExitAfterStableFrame = (): void => {
      if (sentExit) return;
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      const frame = terminalFrame(output);
      if (!frame.some(line => PERSONAL_TUI_FOOTER.test(line))) return;
      settleTimer = setTimeout(() => {
        settleTimer = undefined;
        if (sentExit) return;
        stableFrame = terminalFrame(output);
        if (!stableFrame.some(line => PERSONAL_TUI_FOOTER.test(line))) return;
        sentExit = true;
        child.stdin?.write("\u0004");
      }, 150);
    };
    child.stdout?.on("data", chunk => {
      outputTail.append(chunk);
      output = outputTail.snapshot();
      scheduleExitAfterStableFrame();
    });
    child.stderr?.on("data", chunk => { stderrTail.append(chunk); });
    child.once("error", error => {
      clearTimeout(timer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      reject(sanitizeError(error, redactor));
    });
    child.once("exit", code => {
      clearTimeout(timer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (code !== 0) reject(sanitizeError(new Error(`real Pi TUI footer probe exited with ${code ?? "unknown"}`), redactor));
      else {
        output = outputTail.snapshot();
        resolve({ output, stderr: stderrTail.snapshot(), frame: stableFrame ?? terminalFrame(output) });
      }
    });
  });
  try { return await ready; }
  catch (error) {
    try { await stopOwnedTuiProcess(child); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "real Pi TUI footer probe cleanup failed"); }
    throw error;
  }
}

function signalOwnedTuiProcess(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): boolean {
  // The process-group signal is issued only through the exact ChildProcess
  // descriptor created above, while it is still live and still names the
  // trusted /usr/bin/script launcher. Never discover or kill a parentless PID.
  if (child.pid === undefined || child.spawnfile !== "/usr/bin/script" || child.exitCode !== null || child.signalCode !== null) return false;
  try { process.kill(-child.pid, signal); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForOwnedTuiExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onClose);
      if (error) reject(error); else resolve();
    };
    const onExit = (): void => finish();
    const onClose = (): void => finish();
    const timer = setTimeout(() => finish(new Error("real Pi TUI child exit timeout")), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

async function stopOwnedTuiProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalOwnedTuiProcess(child, "SIGTERM");
  try { await waitForOwnedTuiExit(child, 4_000); }
  catch (firstError) {
    signalOwnedTuiProcess(child, "SIGKILL");
    try { await waitForOwnedTuiExit(child, 1_000); }
    catch (lastError) { throw new AggregateError([firstError, lastError], "real Pi TUI child did not reach observed exit within the fixed cleanup budget"); }
  }
}

test("fresh Squire implement launch loads /ticket llm-wiki before the trusted footer with run-local resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-launch-e2e-"));
  const workspace = path.join(root, "workspace");
  const runtimeRoot = path.join(root, "runtime");
  const sessionRoot = path.join(root, "sessions");
  const hostHome = path.join(root, "host-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(hostHome, { recursive: true });
  const hostPiSettings = JSON.stringify({ sentinel: "HOST_PI_RESOURCE_228" });
  const hostWikiSettings = JSON.stringify({ sentinel: "HOST_WIKI_RESOURCE_228" });
  await mkdir(path.join(hostHome, ".pi"), { recursive: true });
  await mkdir(path.join(hostHome, ".llm-wiki"), { recursive: true });
  await writeFile(path.join(hostHome, ".pi", "settings.json"), `${hostPiSettings}\n`);
  await writeFile(path.join(hostHome, ".llm-wiki", "config.json"), `${hostWikiSettings}\n`);

  const resolvedRuntime = structuredClone({
    ...runtime,
    pi: { ...runtime.pi, executable: PI_CLI },
    llmWiki: { ...runtime.llmWiki, root: WIKI_ROOT },
  });
  const store = new InMemoryWorkflowStore();
  await store.create(run());
  const materializer = new PiAgentDirectoryMaterializer({
    runtimeRoot,
    workspace,
    homeDirectory: hostHome,
    wikiInstallation: { root: WIKI_ROOT, installationId: resolvedRuntime.llmWiki.installationId, version: resolvedRuntime.llmWiki.version },
    runLifecycleAuthority: store,
  });
  const roles = Object.fromEntries(Object.entries(DEFAULT_PI_ROLE_PROFILES).map(([role, profile]) => [
    role,
    { ...profile, instructionsPath: `/ticket/control/roles/${role}.md`, timeoutSeconds: 30 },
  ])) as Record<keyof typeof DEFAULT_PI_ROLE_PROFILES, PiRoleConfig>;
  const factory = new ChildPiProcessFactory();
  const runner = new PiRunner(
    factory,
    { resolve: async () => structuredClone(resolvedRuntime) },
    store,
    {
      roles,
      workspaceReadiness: testWorkspaceReadiness,
      workspace,
      sessionRoot,
      materializer,
      wiki: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      commandTimeoutMs: 30_000,
    },
    async () => undefined,
    async () => "trusted implement instructions",
    { now: () => Date.now(), sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("sleep aborted")); }, { once: true });
    }) },
  );

  const probePath = path.join(root, "trusted-footer-probe.mjs");
  await writeFile(probePath, `export default function (pi) {
  pi.on("session_start", (_event, context) => {
    const original = context.ui.setStatus.bind(context.ui);
    let sawWiki = false;
    let sawModel = false;
    context.ui.setStatus = (key, value) => {
      if (key === "llm-wiki" && /^🧠 LLM Wiki \\(\\d+ tools, observe \\+ recall active\\)$/u.test(value)) sawWiki = true;
      if (key === "llm-wiki-model" && value === "🧠 wiki model: openai-codex/gpt-5.6-luna") sawModel = true;
      original(key, value);
      if (sawWiki && sawModel) {
        context.ui.notify("SQUIRE_WIKI_RUNTIME_OK", "info");
        context.ui.notify("SQUIRE_FOOTER_PROBE_OK", "info");
      }
    };
    context.ui.notify("SQUIRE_FOOTER_PROBE_OK", "info");
  });
}
`, { mode: 0o600 });

  let process: ChildPiProcess | undefined;
  let actualPiResource: ActualPiResourceLease | undefined;
  try {
    actualPiResource = await acquireActualPiResource();
    const materialized = await materializer.materialize({
      runId: "run_example01",
      runtime: resolvedRuntime,
      wikiProfile: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      workspace,
    });
    // Seed the run-local vault before extension startup. This keeps the real
    // wiki extension on its deterministic project-vault path in both RPC and
    // TUI modes; the probe still observes its native status calls below.
    await mkdir(path.join(materialized.wikiHomeDir, ".llm-wiki"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(materialized.wikiHomeDir, ".llm-wiki", "config.json"), JSON.stringify({
      knowledge_format: "okf-0.2",
      name: "Squire e2e wiki",
      topic: "Squire e2e wiki",
      mode: "project",
      version: "1.0",
    }) + "\n", { mode: 0o600 });
    let launched: Awaited<ReturnType<typeof runner.launch>>;
    try {
      launched = await runner.launch("run_example01", "implement");
    } catch (error) {
      const child = factory.processes[0];
      if (!child) throw error;
      throw new AggregateError([error, new Error(`actual Pi child startup diagnostics: errors=${JSON.stringify(child.errors)}; output=${JSON.stringify(child.output)}`)], "actual Pi launch failed with child startup diagnostics");
    }
    process = factory.processes[0];
    const launch = factory.launches[0]!;
    const extensionArguments = launch.args.flatMap((value, index) => value === "--extension" ? [launch.args[index + 1]!] : []);
    assert.deepEqual(extensionArguments, [WIKI_EXTENSION, materialized.footerExtensionPath]);
    assert.ok(launch.args.indexOf(WIKI_EXTENSION) < launch.args.indexOf(materialized.footerExtensionPath));
    assert.equal(launch.args.includes("--no-extensions"), true);
    assert.equal(launch.env["PI_CODING_AGENT_DIR"], materialized.agentDir);
    assert.equal(launch.env["HOME"], materialized.homeDir);
    assert.equal(launch.env["WIKI_HOME"], materialized.wikiHomeDir);
    assert.equal(launch.cwd, workspace);
    assert.equal(launched.state.model?.provider, "openai-codex");
    assert.equal(launched.state.model?.id, "gpt-5.6-luna");
    assert.equal(launched.state.thinkingLevel, "max");
    assert.equal(path.relative(sessionRoot, launched.state.sessionFile).startsWith(`implement${path.sep}`), true);

    const settings = JSON.parse(await readFile(materialized.settingsPath, "utf8")) as {
      packages?: unknown;
      "llm-wiki"?: { taskModel?: unknown };
      defaultThinkingLevel?: unknown;
      modelThinkingLevels?: Record<string, unknown>;
    };
    assert.deepEqual(settings["packages"], [WIKI_ROOT]);
    assert.deepEqual(settings["llm-wiki"]?.taskModel, { provider: "openai-codex", id: "gpt-5.6-luna" });
    assert.equal(settings["defaultThinkingLevel"], "high");
    assert.equal(settings["modelThinkingLevels"]?.[WIKI_MODEL], "high");
    assert.match(process?.output.join("") ?? "", /"statusKey":"llm-wiki"/u);
    assert.doesNotMatch(`${process?.output.join("") ?? ""}\n${process?.errors.join("") ?? ""}`, /HOST_PI_RESOURCE_228|HOST_WIKI_RESOURCE_228/u);
    assert.equal(await readFile(path.join(hostHome, ".pi", "settings.json"), "utf8"), `${hostPiSettings}\n`);
    assert.equal(await readFile(path.join(hostHome, ".llm-wiki", "config.json"), "utf8"), `${hostWikiSettings}\n`);
    await assert.rejects(lstat(path.join(workspace, ".pi")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(workspace, ".llm-wiki")), { code: "ENOENT" });

    // The RPC child is checked for loader diagnostics rather than merely
    // assuming that a successful get_state means its extensions loaded.
    const rpcOutput = process?.output.join("") ?? "";
    assert.doesNotMatch(rpcOutput, /"type":"extension_error"/u);
    assert.equal(process?.errors.join(""), "");

    // Reap the RPC child before starting the second real-Pi TUI probe. Keeping
    // both actual Pi children alive lets concurrent test workers contend for
    // the same bounded CI process/IO budget and makes the handshake scheduler-
    // dependent. This is test-support cleanup only: each genuine handshake
    // remains bounded and fail-closed.
    if (process) await reapChild(process);
    assert.notEqual(process?.exitCode, null, "RPC child must be reaped before the TUI probe");

    // The real @zosmaai/pi-llm-wiki extension emitted both status keys during
    // RPC session_start above; the TUI repeats that native path and the probe
    // observes those calls without synthesizing a wiki status.
    // A real TUI, allocated by `script`, installs the same generated footer
    // through Pi's actual ExtensionAPI. The probe only observes status calls
    // from the real wiki extension; the compact line can therefore appear
    // only if the trusted footer loaded, registered setFooter, and rendered
    // the status map.
    const tui = await runRealTuiFooterProbe({
      workspace,
      agentDir: materialized.agentDir,
      homeDir: materialized.homeDir,
      wikiHomeDir: materialized.wikiHomeDir,
      footerPath: materialized.footerExtensionPath,
      probePath,
    });
    const visibleTui = stripTerminalSequences(tui.output).replace(/\r/gu, "");
    // The stable terminal frame must contain the complete ordered personal
    // line, not merely a wiki fragment left beside Pi's stock footer.
    const stableFrameText = tui.frame.join("\n");
    const footerRows = tui.frame.filter(line => PERSONAL_TUI_FOOTER.test(line));
    assert.equal(footerRows.length, 1, `expected one personal footer row, got:\n${stableFrameText}`);
    assert.match(footerRows[0]!, PERSONAL_TUI_FOOTER);
    assert.match(stableFrameText, /🧠 — · gpt-5\.6-luna/u);
    // Pi's stock footer is a cwd row followed by a token/context stats row;
    // neither may survive in the stable frame after setFooter replacement.
    assert.doesNotMatch(stableFrameText, /\/workspace|(?:\d+\.\d+%|\?\/)\S+ \(auto\)|gpt-5\.6-luna • high|[↑↓]/u);
    // Keep the native-status and loader-error checks over the complete PTY
    // transcript as well; no diagnostic output is hidden by frame parsing.
    assert.equal(tui.stderr, "");
    assert.doesNotMatch(`${visibleTui}\n${tui.stderr}`, /extension_error|failed to load extension|cannot find module|syntaxerror/iu);
  } finally {
    process ??= factory.processes[0];
    try {
      if (process) await reapChild(process);
    } finally {
      try {
        if (actualPiResource) await actualPiResource.release();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
