import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProcessLaunch } from "../src/pi/pi-process.js";
import { RealPiProcessFactory } from "./support/real-pi-process.js";

const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

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

test("real Pi process inherits the controller PATH needed by env-based child shebangs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-pi-path-"));
  const bin = path.join(root, "bin");
  const launcher = path.join(bin, "aidev-node-probe");
  const childScript = path.join(root, "probe");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const quotedNodePath = process.execPath.replaceAll("'", "'\\''");
  await writeFile(launcher, `#!/bin/sh\nexec '${quotedNodePath}' "$@"\n`, { mode: 0o700 });
  await writeFile(childScript, "#!/usr/bin/env aidev-node-probe\nprocess.stdout.write(\"PATH_PROBE_OK\\n\");\n", { mode: 0o700 });
  await chmod(launcher, 0o700);
  await chmod(childScript, 0o700);
  const previousPath = process.env["PATH"];
  process.env["PATH"] = `${bin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const real = await new RealPiProcessFactory().spawn({ command: childScript, args: [], cwd: root, env: {} });
    await real.waitForExit(5_000);
    assert.equal(real.exitCode, 0);
    assert.match(real.output.join(""), /PATH_PROBE_OK/u);
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi process preserves startup stderr, exit, environment, and timing diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-pi-startup-"));
  const emptyPath = path.join(root, "empty-path");
  const childScript = path.join(root, "probe");
  await mkdir(emptyPath, { recursive: true, mode: 0o700 });
  await writeFile(childScript, "#!/usr/bin/env aidev-missing-node\nprocess.stdout.write(\"UNREACHABLE\\n\");\n", { mode: 0o700 });
  await chmod(childScript, 0o700);
  try {
    const real = await new RealPiProcessFactory().spawn({ command: childScript, args: [], cwd: root, env: { PATH: emptyPath } });
    await real.waitForExit(5_000);
    assert.equal(real.exitCode, 127);
    assert.match(real.errors.join(""), /aidev-missing-node|No such file/u);
    const diagnostic = real.diagnostic("real Pi startup failure");
    assert.match(diagnostic, /rawExit=127/u);
    assert.match(diagnostic, /env=.*PATH/u);
    assert.match(diagnostic, /elapsedMs=\d+/u);
    assert.match(diagnostic, /stderr=.*aidev-missing-node|stderr=.*No such file/u);
    assert.match(diagnostic, /observedErrors=.*aidev-missing-node|observedErrors=.*No such file/u);
    assert.throws(() => real.stdin.write("handshake\n"), /rawExit=127|aidev-missing-node|No such file/u);

    const missing = await new RealPiProcessFactory().spawn({ command: path.join(root, "missing-command"), args: [], cwd: root, env: {} });
    await new Promise<void>(resolve => {
      if (missing.childError) resolve();
      else missing.child.once("error", () => resolve());
    });
    assert.throws(() => missing.stdin.write("handshake\n"), /ENOENT|spawn/u);
    assert.match(missing.diagnostic("real Pi executable startup failure"), /observedErrors=.*ENOENT|observedErrors=.*spawn/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
