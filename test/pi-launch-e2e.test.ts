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
import { run, runtime } from "./support/fixtures.js";

const PI_CLI = "/ticket/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const WIKI_ROOT = "/ticket/runtime/node_modules/@zosmaai/pi-llm-wiki";
const WIKI_EXTENSION = `${WIKI_ROOT}/extensions/llm-wiki/index.ts`;
const WIKI_MODEL = "openai-codex/gpt-5.6-luna";

class ChildPiProcess extends EventEmitter implements PiProcess {
  readonly identity = `child-${randomUUID()}`;
  readonly stdin: PiProcess["stdin"];
  readonly stdout: PiProcess["stdout"];
  readonly stderr: PiProcess["stderr"];
  readonly output: string[] = [];
  readonly errors: string[] = [];
  exitCode: number | null = null;

  constructor(readonly child: ChildProcess) {
    super();
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Pi child did not expose piped stdio");
    this.stdin = { write: data => child.stdin!.write(data) };
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    child.stdout.on("data", chunk => this.output.push(chunk.toString()));
    child.stderr.on("data", chunk => this.errors.push(chunk.toString()));
    child.stdin.on("error", error => this.errors.push(`stdin: ${error.message}`));
    child.once("error", error => this.errors.push(`child: ${error.message}`));
    child.once("exit", (code, signal) => {
      this.exitCode = code ?? (signal === "SIGTERM" ? 143 : 1);
      this.emit("exit", code, signal);
    });
  }

  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this {
    return super.on(event, listener);
  }

  kill(signal: "SIGTERM" | "SIGKILL"): boolean {
    return this.child.kill(signal);
  }

  async waitForExit(timeoutMs: number): Promise<void> {
    if (this.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("exit", onExit);
        reject(new Error("Pi child exit timeout"));
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.once("exit", onExit);
    });
  }
}

class ChildPiProcessFactory implements PiProcessFactory {
  readonly launches: ProcessLaunch[] = [];
  readonly processes: ChildPiProcess[] = [];

  async spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (spawned: PiProcess) => void): Promise<ChildPiProcess> {
    if (signal?.aborted) throw new Error("spawn aborted");
    const child = spawnChild(spec.command, spec.args, {
      cwd: spec.cwd,
      env: cleanPiEnvironment({ ...spec.env, PI_OFFLINE: "1" }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const spawned = new ChildPiProcess(child);
    this.launches.push(spec);
    this.processes.push(spawned);
    onSpawn?.(spawned);
    return spawned;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cleanPiEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(globalThis.process.env).filter(([key]) => !key.startsWith("PI_"))),
    ...overrides,
  };
}

async function runRealTuiFooterProbe(options: {
  workspace: string;
  agentDir: string;
  homeDir: string;
  wikiHomeDir: string;
  footerPath: string;
  probePath: string;
}): Promise<{ output: string; stderr: string }> {
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
  const child = spawnChild("script", ["-qefc", ttyCommand, "/dev/null"], {
    cwd: options.workspace,
    env: cleanPiEnvironment({
      HOME: options.homeDir,
      WIKI_HOME: options.wikiHomeDir,
      PI_CODING_AGENT_DIR: options.agentDir,
      PI_OFFLINE: "1",
      TERM: "xterm-256color",
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  let sentExit = false;
  const ready = new Promise<{ output: string; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("real Pi TUI footer probe timed out"));
    }, 10_000);
    child.stdout?.on("data", chunk => {
      output += chunk.toString();
      if (!sentExit && output.includes("🧠 — · openai-codex/gpt-5.6-luna")) {
        sentExit = true;
        child.stdin?.write("\u0004");
      }
    });
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`real Pi TUI footer probe exited with ${code ?? "unknown"}`));
      else resolve({ output, stderr });
    });
  });
  try { return await ready; }
  catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    throw error;
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
      workspace,
      sessionRoot,
      materializer,
      wiki: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      commandTimeoutMs: 10_000,
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
  try {
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
    const launched = await runner.launch("run_example01", "implement");
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
    const visibleTui = tui.output.replace(/\x1B\[[0-?]*[\x20-\x2F]*[@-~]/gu, "").replace(/\r/gu, "");
    // This compact line is only rendered when the trusted footer sees the
    // healthy status emitted by the real wiki extension.
    assert.match(visibleTui, /🧠 — · openai-codex\/gpt-5\.6-luna/u);
    assert.equal(tui.stderr, "");
    assert.doesNotMatch(`${visibleTui}\n${tui.stderr}`, /extension_error|failed to load extension|cannot find module|syntaxerror/iu);
  } finally {
    process ??= factory.processes[0];
    if (process && process.exitCode === null) process.kill("SIGTERM");
    if (process) await process.waitForExit(5_000);
    await rm(root, { recursive: true, force: true });
  }
});
