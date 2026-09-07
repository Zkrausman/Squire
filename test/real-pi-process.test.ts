import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import type { ProcessLaunch } from "../src/pi/pi-process.js";
import { RealPiProcessFactory } from "./support/real-pi-process.js";

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

function scriptSpec(command: string, cwd: string, env: Record<string, string> = {}): ProcessLaunch {
  return { command, args: [], cwd, env };
}

test("real Pi process reports a causal closed-stdin EPIPE without an uncaught exception", async () => {
  const factory = new RealPiProcessFactory();
  const spec: ProcessLaunch = {
    command: process.execPath,
    args: ["-e", "setTimeout(() => process.stdin.destroy(), 25); setTimeout(() => process.exit(0), 250);"],
    cwd: process.cwd(),
    env: {},
  };
  const real = await factory.spawn(spec);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => { uncaught.push(error); };
  process.once("uncaughtException", onUncaught);
  let synchronousWriteError: unknown;
  const writer = setInterval(() => {
    try { real.stdin.write("late RPC bytes\n"); }
    catch (error) { synchronousWriteError = error; clearInterval(writer); }
  }, 1);
  try {
    const deadline = Date.now() + 5_000;
    while (!real.stdinError && Date.now() < deadline) await delay(5);
    assert.ok(real.stdinError, "the child must close stdin before its scheduled exit");
    const stdinError = real.stdinError as NodeJS.ErrnoException;
    assert.equal(stdinError.code, "EPIPE");
    assert.match(real.errors.join(""), /stdin: write EPIPE/u);
  } finally {
    clearInterval(writer);
    if (real.exitCode === null) real.kill("SIGKILL");
    await real.waitForExit(5_000);
    process.removeListener("uncaughtException", onUncaught);
  }
  assert.deepEqual(uncaught, [], "closed-child stdin errors must be observed by the support process, not uncaught");
  if (synchronousWriteError) assert.match(String(synchronousWriteError), /closed|destroyed|EPIPE/iu);
});

test("real Pi child uses the exact controller Node and an allowlisted environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-pi-allowlist-"));
  const hostileBin = path.join(root, "hostile-bin");
  const hook = path.join(root, "node-options-hook.cjs");
  const probe = path.join(root, "allowlist-probe.mjs");
  const marker = path.join(root, "node-options-hook-ran");
  await mkdir(hostileBin, { recursive: true, mode: 0o700 });
  await writeFile(path.join(hostileBin, "node"), "#!/bin/sh\nprintf 'MALICIOUS_NODE_SELECTED\\n'\n", { mode: 0o700 });
  await writeFile(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");\n`, { mode: 0o600 });
  await writeFile(probe, `
    import { spawnSync } from "node:child_process";
    const nested = spawnSync("node", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" });
    process.stdout.write(JSON.stringify({
      nestedStatus: nested.status,
      nestedPath: nested.stdout.trim(),
      path: process.env.PATH,
      home: process.env.HOME ?? null,
      openAiKey: process.env.OPENAI_API_KEY ?? null,
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      ambientPi: process.env.PI_AMBIENT_BAD ?? null,
    }));
  `, { mode: 0o600 });
  const secret = "review9-ambient-secret";
  const factory = new RealPiProcessFactory({
    PATH: hostileBin,
    HOME: path.join(root, "host-home"),
    OPENAI_API_KEY: secret,
    NODE_OPTIONS: `--require=${hook}`,
    PI_AMBIENT_BAD: "ambient-pi-must-not-cross",
  });
  try {
    const real = await factory.spawn(scriptSpec(probe, root, {
      PATH: hostileBin,
      OPENAI_API_KEY: "override-secret-must-not-cross",
      NODE_OPTIONS: `--require=${hook}`,
      PI_AMBIENT_BAD: "override-pi-must-not-cross",
    }));
    await real.waitForExit(5_000);
    assert.equal(real.exitCode, 0);
    assert.equal(real.spawnCommand, process.execPath);
    assert.equal(real.spawnArgs[0], probe);
    const result = JSON.parse(real.output) as Record<string, string | number | null>;
    assert.equal(result["nestedStatus"], 0);
    assert.equal(result["nestedPath"], process.execPath);
    assert.match(String(result["path"]), new RegExp(`${path.dirname(process.execPath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
    assert.doesNotMatch(String(result["path"]), new RegExp(hostileBin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.equal(result["home"], null);
    assert.equal(result["openAiKey"], null);
    assert.equal(result["nodeOptions"], null);
    assert.equal(result["ambientPi"], null);
    assert.equal(existsSync(marker), false, "ambient NODE_OPTIONS must not execute in the child");
    assert.equal(real.environment["OPENAI_API_KEY"], undefined);
    assert.equal(real.environment["HOME"], undefined);
    assert.equal(real.terminalState, "exited");

    const emptyPathReal = await factory.spawn(scriptSpec(probe, root, { PATH: "" }));
    await emptyPathReal.waitForExit(5_000);
    assert.equal(emptyPathReal.exitCode, 0, "empty caller PATH must not disable the exact runtime PATH");
    assert.equal(JSON.parse(emptyPathReal.output)["nestedPath"], process.execPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi diagnostics bound and redact large secret-bearing stderr", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-pi-stderr-"));
  const probe = path.join(root, "stderr-probe.mjs");
  const secret = "stderr-secret-sentinel";
  await writeFile(probe, `process.stderr.write("x".repeat(120000)); process.stderr.write(${JSON.stringify(`OPENAI_API_KEY=${secret}\n`)}); process.exit(7);\n`, { mode: 0o600 });
  try {
    const real = await new RealPiProcessFactory().spawn(scriptSpec(probe, root));
    await real.waitForExit(5_000);
    assert.equal(real.exitCode, 7);
    assert.ok(Buffer.byteLength(real.stderrOutput, "utf8") <= 8_192);
    const diagnostic = real.diagnostic("bounded startup diagnostic");
    assert.ok(Buffer.byteLength(diagnostic, "utf8") <= 16_384);
    assert.equal(diagnostic.includes(secret), false);
    assert.match(diagnostic, /<redacted>/u);
    assert.equal(real.errors.length, 0, "stderr must not be duplicated into process errors");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi redacts fragmented plaintext, base64, hex, and URL secrets from every error view", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-pi-redaction-"));
  const probe = path.join(root, "redaction-probe.mjs");
  const ambientSecrets = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`HOST_SECRET_${index}`, `host secret/${index}+987654321==`])) as Record<string, string>;
  const secret = ambientSecrets["HOST_SECRET_99"]!;
  const forms = [secret, Buffer.from(secret, "utf8").toString("base64"), Buffer.from(secret, "utf8").toString("hex"), encodeURIComponent(secret)];
  await writeFile(probe, `const forms = ${JSON.stringify(forms)}; for (const value of forms) for (const character of value) process.stderr.write(character); process.exit(7);\n`, { mode: 0o600 });
  const factory = new RealPiProcessFactory(ambientSecrets);
  try {
    const real = await factory.spawn(scriptSpec(probe, root, { HOST_SECRET_99: secret }));
    await real.waitForExit(5_000);
    const diagnostic = real.diagnostic("secret diagnostic");
    const rendered = `${real.stderrOutput}\n${diagnostic}`;
    for (const form of forms) assert.equal(rendered.includes(form), false, `secret form leaked: ${form}`);
    assert.match(rendered, /<redacted>/u);

    let thrown: unknown;
    try { real.stdin.write(secret); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof Error);
    const surfaces = [thrown.message, JSON.stringify(thrown), inspect(thrown, { depth: 6, showHidden: true }), Object.keys(thrown).join("\\n")].join("\\n");
    for (const form of forms) assert.equal(surfaces.includes(form), false, `causal error leaked: ${form}`);
    assert.equal("process" in thrown, false);
    assert.equal("launch" in thrown, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi diagnostic accumulator reports a valid UTF-8 byte bound under fragmented large streams", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-pi-utf8-bound-"));
  const probe = path.join(root, "utf8-probe.mjs");
  await writeFile(probe, "process.stderr.write('€'.repeat(100000), () => process.exit(7));\n", { mode: 0o600 });
  try {
    const real = await new RealPiProcessFactory().spawn(scriptSpec(probe, root));
    await real.waitForExit(5_000);
    assert.ok(Buffer.byteLength(real.stderrOutput, "utf8") <= 8_192);
    assert.match(real.stderrOutput, /truncated/u);
    assert.ok(real.diagnostic("UTF-8 bound").length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi ENOENT settles exactly once at close without inventing an exit code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-pi-enoent-"));
  const factory = new RealPiProcessFactory();
  try {
    const real = await factory.spawn(scriptSpec(path.join(root, "missing-command"), root));
    let exitEvents = 0;
    real.on("exit", () => { exitEvents += 1; });
    const startedAt = Date.now();
    await real.waitForExit(1_000);
    await real.waitForExit(1_000);
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(real.terminalState, "startup-error");
    assert.equal(real.exitCode, null);
    assert.equal(exitEvents, 1);
    assert.match(real.diagnostic("ENOENT startup diagnostic"), /terminalState=startup-error/u);
    assert.match(real.diagnostic("ENOENT startup diagnostic"), /ENOENT|spawn/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi child success remains deterministic under concurrent launches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-pi-concurrent-"));
  const probe = path.join(root, "success-probe.mjs");
  await writeFile(probe, "process.stdout.write('CONCURRENT_PI_OK');\n", { mode: 0o600 });
  const factory = new RealPiProcessFactory();
  try {
    const processes = await Promise.all(Array.from({ length: 16 }, () => factory.spawn(scriptSpec(probe, root))));
    await Promise.all(processes.map(process => process.waitForExit(5_000)));
    assert.equal(processes.every(process => process.exitCode === 0 && process.terminalState === "exited" && process.output === "CONCURRENT_PI_OK"), true);
  } finally {
    for (const process of factory.processes) if (process.exitCode === null) process.kill("SIGKILL");
    await Promise.all(factory.processes.map(process => process.waitForExit(5_000).catch(() => undefined)));
    await rm(root, { recursive: true, force: true });
  }
});